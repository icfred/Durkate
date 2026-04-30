import { env, runInDurableObject, SELF } from "cloudflare:test";
import { bot, type State } from "@durak/engine";
import type {
  CreateRoomResponse,
  DisconnectState,
  ErrorMessage,
  EventsMessage,
  RoomStateMessage,
  ServerMessage,
  SnapshotMessage,
} from "@durak/protocol";
import { describe, expect, it } from "vitest";
import type { Room } from "./room.js";

let ipCounter = 0;
function freshIp(): string {
  ipCounter += 1;
  return `10.0.${(ipCounter >> 8) & 0xff}.${ipCounter & 0xff}`;
}

async function postRooms(
  body: unknown,
  init: { headers?: Record<string, string> } = {},
): Promise<Response> {
  return SELF.fetch("https://example.com/rooms", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "CF-Connecting-IP": freshIp(),
      ...init.headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function openWs(roomId: string, token: string, origin?: string): Promise<WebSocket> {
  const headers: Record<string, string> = { Upgrade: "websocket" };
  if (origin) headers.Origin = origin;
  const res = await SELF.fetch(`https://example.com/ws/${roomId}?token=${token}`, { headers });
  if (res.status !== 101 || !res.webSocket) {
    throw new Error(`expected ws upgrade, got ${res.status}: ${await res.text()}`);
  }
  res.webSocket.accept();
  return res.webSocket;
}

class MessageQueue {
  private queue: ServerMessage[] = [];
  private waiters: Array<(msg: ServerMessage) => void> = [];
  private closed = false;

  constructor(ws: WebSocket) {
    ws.addEventListener("message", (event) => {
      const data = typeof event.data === "string" ? event.data : "";
      if (!data) return;
      const msg = JSON.parse(data) as ServerMessage;
      const waiter = this.waiters.shift();
      if (waiter) waiter(msg);
      else this.queue.push(msg);
    });
    ws.addEventListener("close", () => {
      this.closed = true;
    });
  }

  next(timeoutMs = 2000): Promise<ServerMessage> {
    return new Promise((resolve, reject) => {
      const buffered = this.queue.shift();
      if (buffered) {
        resolve(buffered);
        return;
      }
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== onMessage);
        reject(new Error("ws message timeout"));
      }, timeoutMs);
      const onMessage = (msg: ServerMessage) => {
        clearTimeout(timer);
        resolve(msg);
      };
      this.waiters.push(onMessage);
    });
  }

  drain(): ServerMessage[] {
    const drained = this.queue;
    this.queue = [];
    return drained;
  }

  isClosed(): boolean {
    return this.closed;
  }
}

async function findUntil<T extends ServerMessage>(
  q: MessageQueue,
  predicate: (msg: ServerMessage) => msg is T,
  attempts = 8,
): Promise<T> {
  for (let i = 0; i < attempts; i++) {
    const msg = await q.next();
    if (predicate(msg)) return msg;
  }
  throw new Error("did not find expected message");
}

const isRoomState = (m: ServerMessage): m is RoomStateMessage => m.type === "RoomState";
const isSnapshot = (m: ServerMessage): m is SnapshotMessage => m.type === "Snapshot";
const isEvents = (m: ServerMessage): m is EventsMessage => m.type === "Events";
const isError = (m: ServerMessage): m is ErrorMessage => m.type === "Error";

describe("worker GET /health", () => {
  it("returns ok", async () => {
    const res = await SELF.fetch("https://example.com/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe("worker POST /rooms", () => {
  it("creates a bot room and returns hostToken without joinToken", async () => {
    const res = await postRooms({ mode: "bot" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as CreateRoomResponse;
    expect(typeof body.roomId).toBe("string");
    expect(body.roomId.length).toBeGreaterThan(0);
    expect(typeof body.hostToken).toBe("string");
    expect(body.joinToken).toBeUndefined();
  });

  it("creates a human room and returns both hostToken and joinToken", async () => {
    const res = await postRooms({ mode: "human" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as CreateRoomResponse;
    expect(typeof body.joinToken).toBe("string");
    expect(body.joinToken).not.toBe(body.hostToken);
  });

  it("rejects unknown modes with 400", async () => {
    const res = await postRooms({ mode: "spectator" });
    expect(res.status).toBe(400);
  });

  it("rejects invalid JSON with 400", async () => {
    const res = await postRooms("not json");
    expect(res.status).toBe(400);
  });

  it("threads bot difficulty into the durable object", async () => {
    const res = await postRooms({ mode: "bot", difficulty: "hard" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as CreateRoomResponse;
    const stub = env.ROOMS.get(env.ROOMS.idFromName(body.roomId));
    let difficulty: string | null = null;
    await runInDurableObject(stub, async (room: Room) => {
      difficulty = room.testBotDifficulty();
    });
    expect(difficulty).toBe("hard");
  });

  it("defaults bot difficulty to medium when omitted", async () => {
    const res = await postRooms({ mode: "bot" });
    const body = (await res.json()) as CreateRoomResponse;
    const stub = env.ROOMS.get(env.ROOMS.idFromName(body.roomId));
    let difficulty: string | null = null;
    await runInDurableObject(stub, async (room: Room) => {
      difficulty = room.testBotDifficulty();
    });
    expect(difficulty).toBe("medium");
  });

  it("rejects unknown difficulty with 400", async () => {
    const res = await postRooms({ mode: "bot", difficulty: "extreme" });
    expect(res.status).toBe(400);
  });
});

describe("worker /ws upgrade", () => {
  it("rejects request with no token (401)", async () => {
    const res = await SELF.fetch("https://example.com/ws/does-not-exist", {
      headers: { Upgrade: "websocket" },
    });
    expect(res.status).toBe(401);
  });

  it("rejects forged token (403)", async () => {
    const created = await postRooms({ mode: "human" });
    const body = (await created.json()) as CreateRoomResponse;
    const res = await SELF.fetch(`https://example.com/ws/${body.roomId}?token=forged`, {
      headers: { Upgrade: "websocket" },
    });
    expect(res.status).toBe(403);
  });

  it("rejects non-upgrade requests with 426", async () => {
    const created = await postRooms({ mode: "human" });
    const body = (await created.json()) as CreateRoomResponse;
    const res = await SELF.fetch(`https://example.com/ws/${body.roomId}?token=${body.hostToken}`);
    expect(res.status).toBe(426);
  });
});

describe("worker /rooms + ws integration: human mode", () => {
  it("two clients connect, game starts, both see Snapshot+Events", async () => {
    const created = await postRooms({ mode: "human" });
    const body = (await created.json()) as CreateRoomResponse;
    if (!body.joinToken) throw new Error("expected joinToken");

    const a = await openWs(body.roomId, body.hostToken);
    const qa = new MessageQueue(a);
    await findUntil(qa, isRoomState);

    const b = await openWs(body.roomId, body.joinToken);
    const qb = new MessageQueue(b);

    const snapA = await findUntil(qa, isSnapshot);
    const snapB = await findUntil(qb, isSnapshot);
    const eventsA = await findUntil(qa, isEvents);
    const eventsB = await findUntil(qb, isEvents);

    expect(snapA.snapshot.seat).toBe(0);
    expect(snapB.snapshot.seat).toBe(1);
    expect(snapA.snapshot.you.hand.length).toBe(6);
    expect(snapB.snapshot.you.hand.length).toBe(6);
    expect(snapA.snapshot.you.hand).not.toEqual(snapB.snapshot.you.hand);
    expect(eventsA.events.some((e) => e.type === "GAME_STARTED")).toBe(true);
    expect(eventsB.events.some((e) => e.type === "GAME_STARTED")).toBe(true);

    a.close();
    b.close();
  });

  it("an illegal action errors only the offender", async () => {
    const created = await postRooms({ mode: "human" });
    const body = (await created.json()) as CreateRoomResponse;
    if (!body.joinToken) throw new Error("expected joinToken");

    const a = await openWs(body.roomId, body.hostToken);
    const qa = new MessageQueue(a);
    await findUntil(qa, isRoomState);

    const b = await openWs(body.roomId, body.joinToken);
    const qb = new MessageQueue(b);

    const snapA = await findUntil(qa, isSnapshot);
    const snapB = await findUntil(qb, isSnapshot);
    await findUntil(qa, isEvents);
    await findUntil(qb, isEvents);

    const attackerSeat = snapA.snapshot.attacker;
    const defenderSnap = attackerSeat === 0 ? snapB : snapA;
    const defenderWs = attackerSeat === 0 ? b : a;
    const qDefender = attackerSeat === 0 ? qb : qa;
    const card = defenderSnap.snapshot.you.hand[0];
    if (!card) throw new Error("expected card");

    // Defender attempts to attack — never legal at table.length === 0 from
    // the defender seat.
    defenderWs.send(
      JSON.stringify({
        type: "SubmitAction",
        action: { type: "ATTACK", by: defenderSnap.snapshot.seat, card },
      }),
    );

    const err = await findUntil(qDefender, isError);
    expect(err.code).not.toBe("ROOM_NOT_FOUND");
    expect(err.code.length).toBeGreaterThan(0);

    a.close();
    b.close();
  });
});

describe("worker disconnect forfeit", () => {
  async function waitFor<T>(
    check: () => Promise<T | null | undefined>,
    attempts = 50,
    delayMs = 10,
  ): Promise<T> {
    for (let i = 0; i < attempts; i++) {
      const v = await check();
      if (v !== null && v !== undefined) return v;
      await new Promise<void>((r) => setTimeout(r, delayMs));
    }
    throw new Error("waitFor: timeout");
  }

  it("schedules forfeit on mid-game close, fires GAME_OVER with disconnected seat as durak", async () => {
    const created = await postRooms({ mode: "human" });
    const body = (await created.json()) as CreateRoomResponse;
    if (!body.joinToken) throw new Error("expected joinToken");

    const a = await openWs(body.roomId, body.hostToken);
    const qa = new MessageQueue(a);
    await findUntil(qa, isRoomState);

    const b = await openWs(body.roomId, body.joinToken);
    const qb = new MessageQueue(b);

    await findUntil(qa, isSnapshot);
    await findUntil(qb, isSnapshot);
    await findUntil(qa, isEvents);
    await findUntil(qb, isEvents);

    b.close();

    const stub = env.ROOMS.get(env.ROOMS.idFromName(body.roomId));
    // Wait for the close handler to register the disconnect.
    const disconnect = await waitFor<DisconnectState>(async () => {
      let out: DisconnectState | null = null;
      await runInDurableObject(stub, async (room: Room) => {
        out = room.testDisconnect();
      });
      return out;
    });
    expect(disconnect.seat).toBe(1);
    expect(disconnect.forfeitAt).toBeGreaterThan(Date.now());

    // Surviving seat should have received a RoomState with the disconnect.
    const roomStateAfterClose = await findUntil(qa, isRoomState);
    expect(roomStateAfterClose.disconnect?.seat).toBe(1);

    // Fire the forfeit deadline as if 60s have passed.
    let fired: string[] = [];
    await runInDurableObject(stub, async (room: Room) => {
      fired = await room.testFireAlarm(Date.now() + 60_000);
    });
    expect(fired).toContain("forfeit");

    // GAME_OVER event reaches the surviving seat with durak: 1.
    const events = await findUntil(qa, isEvents);
    const over = events.events.find((e) => e.type === "GAME_OVER");
    expect(over).toBeDefined();
    if (over?.type !== "GAME_OVER") throw new Error("expected GAME_OVER event");
    expect(over.durak).toBe(1);

    // Engine state moved to game-over.
    let finalState: State | null = null;
    await runInDurableObject(stub, async (room: Room) => {
      finalState = room.testCurrentState();
    });
    expect(finalState !== null && (finalState as State).phase).toBe("game-over");

    a.close();
  });

  it("reconnect with the same token within the window cancels the forfeit and resumes the game", async () => {
    const created = await postRooms({ mode: "human" });
    const body = (await created.json()) as CreateRoomResponse;
    if (!body.joinToken) throw new Error("expected joinToken");

    const a = await openWs(body.roomId, body.hostToken);
    const qa = new MessageQueue(a);
    await findUntil(qa, isRoomState);

    const b = await openWs(body.roomId, body.joinToken);
    const qb1 = new MessageQueue(b);

    await findUntil(qa, isSnapshot);
    await findUntil(qb1, isSnapshot);
    await findUntil(qa, isEvents);
    await findUntil(qb1, isEvents);

    b.close();

    const stub = env.ROOMS.get(env.ROOMS.idFromName(body.roomId));
    await waitFor<DisconnectState>(async () => {
      let out: DisconnectState | null = null;
      await runInDurableObject(stub, async (room: Room) => {
        out = room.testDisconnect();
      });
      return out;
    });

    // Reconnect on the same seat token.
    const b2 = await openWs(body.roomId, body.joinToken);
    const qb2 = new MessageQueue(b2);

    // Wait for the DO to clear the disconnect state. The reconnect handler
    // runs synchronously inside handleWsUpgrade before it returns, so
    // by the time the upgrade response lands the state should be cleared
    // — but allow a brief window for the persist().
    await waitFor<true>(async () => {
      let cleared = false;
      await runInDurableObject(stub, async (room: Room) => {
        cleared = room.testDisconnect() === null;
      });
      return cleared || null;
    });

    // Rejoining seat should receive a fresh Snapshot so the game resumes
    // immediately rather than waiting for the next event.
    const resumeSnap = await findUntil(qb2, isSnapshot);
    expect(resumeSnap.snapshot.seat).toBe(1);

    // No forfeit alarm should fire.
    let fired: string[] = [];
    await runInDurableObject(stub, async (room: Room) => {
      fired = await room.testFireAlarm(Date.now() + 60_000);
    });
    expect(fired).not.toContain("forfeit");

    // Engine state remains in-round.
    let stateAfter: State | null = null;
    await runInDurableObject(stub, async (room: Room) => {
      stateAfter = room.testCurrentState();
    });
    expect(stateAfter !== null && (stateAfter as State).phase).toBe("in-round");

    a.close();
    b2.close();
  });

  it("does not schedule a forfeit when no game is in-round", async () => {
    const created = await postRooms({ mode: "human" });
    const body = (await created.json()) as CreateRoomResponse;

    const a = await openWs(body.roomId, body.hostToken);
    const qa = new MessageQueue(a);
    await findUntil(qa, isRoomState);

    // Only host attached; engine never started. Closing now must not
    // arm a forfeit timer.
    a.close();

    const stub = env.ROOMS.get(env.ROOMS.idFromName(body.roomId));
    // Give the close handler a moment to run.
    await new Promise<void>((r) => setTimeout(r, 50));
    let disconnect: DisconnectState | null = null;
    await runInDurableObject(stub, async (room: Room) => {
      disconnect = room.testDisconnect();
    });
    expect(disconnect).toBeNull();
  });
});

describe("worker /rooms + ws integration: bot mode", () => {
  it("plays a full vs-bot game to game-over", async () => {
    const created = await postRooms({ mode: "bot" });
    const body = (await created.json()) as CreateRoomResponse;
    expect(body.joinToken).toBeUndefined();

    const ws = await openWs(body.roomId, body.hostToken);
    const q = new MessageQueue(ws);
    await findUntil(q, isRoomState);
    const initialSnap = await findUntil(q, isSnapshot);
    expect(initialSnap.snapshot.seat).toBe(0);

    const stub = env.ROOMS.get(env.ROOMS.idFromName(body.roomId));
    const readState = async (): Promise<State | null> => {
      let out: State | null = null;
      await runInDurableObject(stub, async (room: Room) => {
        out = room.testCurrentState();
      });
      return out;
    };

    let safety = 0;
    while (safety < 4000) {
      const state = await readState();
      if (!state || state.phase !== "in-round") break;
      const action = bot.choose(state);
      ws.send(JSON.stringify({ type: "SubmitAction", action }));
      // Yield so the DO message handler runs.
      await new Promise<void>((r) => setTimeout(r, 5));
      safety++;
    }

    const finalState = await readState();
    expect(finalState?.phase).toBe("game-over");

    // Every snapshot delivered to the human must only ever expose seat 0.
    const drained = q.drain();
    for (const m of drained) {
      if (m.type !== "Snapshot") continue;
      expect(m.snapshot.seat).toBe(0);
      const keys = Object.keys(m.snapshot);
      expect(keys).not.toContain("hands");
      expect(keys).not.toContain("talon");
      expect(keys).not.toContain("rng");
    }

    ws.close();
  }, 30_000);
});

type RoomStub = ReturnType<typeof env.ROOMS.get>;

async function readEngineState(stub: RoomStub): Promise<State | null> {
  let out: State | null = null;
  await runInDurableObject(stub, async (room: Room) => {
    out = room.testCurrentState();
  });
  return out;
}

async function playToGameOver(stub: RoomStub, sockets: Record<number, WebSocket>): Promise<void> {
  let safety = 0;
  while (safety < 4000) {
    const state = await readEngineState(stub);
    if (!state) throw new Error("missing engine state");
    if (state.phase === "game-over") return;
    if (state.phase !== "in-round") {
      await new Promise<void>((r) => setTimeout(r, 5));
      safety++;
      continue;
    }
    const action = bot.choose(state);
    if (action.type === "START_GAME") throw new Error("bot returned START_GAME");
    const ws = sockets[action.by];
    if (!ws) {
      // Server-side bot drives this seat; just wait for its turn.
      await new Promise<void>((r) => setTimeout(r, 10));
      safety++;
      continue;
    }
    ws.send(JSON.stringify({ type: "SubmitAction", action }));
    await new Promise<void>((r) => setTimeout(r, 5));
    safety++;
  }
  throw new Error("playToGameOver exceeded safety bound");
}

describe("worker rematch", () => {
  it("rematches a bot game on the human's first request", async () => {
    const created = await postRooms({ mode: "bot" });
    const body = (await created.json()) as CreateRoomResponse;
    const ws = await openWs(body.roomId, body.hostToken);
    const q = new MessageQueue(ws);
    await findUntil(q, isRoomState);
    await findUntil(q, isSnapshot);

    const stub = env.ROOMS.get(env.ROOMS.idFromName(body.roomId));
    await playToGameOver(stub, { 0: ws });
    expect((await readEngineState(stub))?.phase).toBe("game-over");

    q.drain();
    ws.send(JSON.stringify({ type: "RequestRematch" }));
    // Server fires immediately: a fresh in-round Snapshot followed by
    // Events including GAME_STARTED.
    const snap = await findUntil(q, isSnapshot);
    expect(snap.snapshot.phase).toBe("in-round");
    expect(snap.snapshot.you.hand.length).toBe(6);
    const events = await findUntil(q, isEvents);
    expect(events.events.some((e) => e.type === "GAME_STARTED")).toBe(true);

    const after = await readEngineState(stub);
    expect(after?.phase).toBe("in-round");

    ws.close();
  }, 30_000);

  it("plays bot mode through several rematches in a row", async () => {
    const created = await postRooms({ mode: "bot" });
    const body = (await created.json()) as CreateRoomResponse;
    const ws = await openWs(body.roomId, body.hostToken);
    const q = new MessageQueue(ws);
    await findUntil(q, isRoomState);
    await findUntil(q, isSnapshot);

    const stub = env.ROOMS.get(env.ROOMS.idFromName(body.roomId));
    for (let round = 0; round < 3; round++) {
      await playToGameOver(stub, { 0: ws });
      expect((await readEngineState(stub))?.phase).toBe("game-over");
      q.drain();
      ws.send(JSON.stringify({ type: "RequestRematch" }));
      await findUntil(q, isSnapshot);
      const events = await findUntil(q, isEvents);
      expect(events.events.some((e) => e.type === "GAME_STARTED")).toBe(true);
    }

    ws.close();
  }, 60_000);

  it("requires both seats to request rematch in human mode", async () => {
    const created = await postRooms({ mode: "human" });
    const body = (await created.json()) as CreateRoomResponse;
    if (!body.joinToken) throw new Error("expected joinToken");

    const a = await openWs(body.roomId, body.hostToken);
    const qa = new MessageQueue(a);
    await findUntil(qa, isRoomState);

    const b = await openWs(body.roomId, body.joinToken);
    const qb = new MessageQueue(b);

    await findUntil(qa, isSnapshot);
    await findUntil(qb, isSnapshot);
    await findUntil(qa, isEvents);
    await findUntil(qb, isEvents);

    const stub = env.ROOMS.get(env.ROOMS.idFromName(body.roomId));
    await playToGameOver(stub, { 0: a, 1: b });
    expect((await readEngineState(stub))?.phase).toBe("game-over");

    qa.drain();
    qb.drain();

    // Seat 0 alone is insufficient. Both clients receive a RoomState
    // with rematchRequested:[0]; engine stays in game-over.
    a.send(JSON.stringify({ type: "RequestRematch" }));
    const roomA = await findUntil(qa, isRoomState);
    const roomB = await findUntil(qb, isRoomState);
    expect(roomA.rematchRequested).toEqual([0]);
    expect(roomB.rematchRequested).toEqual([0]);
    expect((await readEngineState(stub))?.phase).toBe("game-over");

    // Seat 1 confirms — both seats see a fresh in-round Snapshot and
    // GAME_STARTED.
    b.send(JSON.stringify({ type: "RequestRematch" }));
    const snapA = await findUntil(qa, isSnapshot);
    const snapB = await findUntil(qb, isSnapshot);
    expect(snapA.snapshot.phase).toBe("in-round");
    expect(snapB.snapshot.phase).toBe("in-round");
    const eventsA = await findUntil(qa, isEvents);
    const eventsB = await findUntil(qb, isEvents);
    expect(eventsA.events.some((e) => e.type === "GAME_STARTED")).toBe(true);
    expect(eventsB.events.some((e) => e.type === "GAME_STARTED")).toBe(true);

    a.close();
    b.close();
  }, 30_000);

  it("rejects rematch when not in game-over phase", async () => {
    const created = await postRooms({ mode: "bot" });
    const body = (await created.json()) as CreateRoomResponse;
    const ws = await openWs(body.roomId, body.hostToken);
    const q = new MessageQueue(ws);
    await findUntil(q, isRoomState);
    await findUntil(q, isSnapshot);

    ws.send(JSON.stringify({ type: "RequestRematch" }));
    const err = await findUntil(q, isError);
    expect(err.code).toBe("REMATCH_NOT_AVAILABLE");

    ws.close();
  });
});
