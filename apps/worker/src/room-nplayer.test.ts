import { env, runInDurableObject, SELF } from "cloudflare:test";
import { bot, type State } from "@durak/engine";
import type {
  CreateRoomResponse,
  EventsMessage,
  RoomStateMessage,
  ServerMessage,
  SnapshotMessage,
} from "@durak/protocol";
import { describe, expect, it } from "vitest";
import type { PersistedDeadlines } from "./alarms.js";
import type { Room } from "./room.js";

let ipCounter = 0;
function freshIp(): string {
  ipCounter += 1;
  return `10.52.${(ipCounter >> 8) & 0xff}.${ipCounter & 0xff}`;
}

async function postRooms(body: unknown): Promise<Response> {
  return SELF.fetch("https://example.com/rooms", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "CF-Connecting-IP": freshIp(),
    },
    body: JSON.stringify(body),
  });
}

async function openWs(roomId: string, token: string): Promise<WebSocket> {
  const res = await SELF.fetch(`https://example.com/ws/${roomId}?token=${token}`, {
    headers: { Upgrade: "websocket" },
  });
  if (res.status !== 101 || !res.webSocket) {
    throw new Error(`expected ws upgrade, got ${res.status}: ${await res.text()}`);
  }
  res.webSocket.accept();
  return res.webSocket;
}

class MessageQueue {
  private queue: ServerMessage[] = [];
  private waiters: Array<(msg: ServerMessage) => void> = [];

  constructor(ws: WebSocket) {
    ws.addEventListener("message", (event) => {
      const data = typeof event.data === "string" ? event.data : "";
      if (!data) return;
      const msg = JSON.parse(data) as ServerMessage;
      const waiter = this.waiters.shift();
      if (waiter) waiter(msg);
      else this.queue.push(msg);
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
}

async function findUntil<T extends ServerMessage>(
  q: MessageQueue,
  predicate: (msg: ServerMessage) => msg is T,
  attempts = 30,
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

type RoomStub = ReturnType<typeof env.ROOMS.get>;

async function readEngineState(stub: RoomStub): Promise<State | null> {
  let out: State | null = null;
  await runInDurableObject(stub, async (room: Room) => {
    out = room.testCurrentState();
  });
  return out;
}

async function readDeadlines(stub: RoomStub): Promise<PersistedDeadlines> {
  let out: PersistedDeadlines = {};
  await runInDurableObject(stub, async (room: Room) => {
    out = room.testDeadlines();
  });
  return out;
}

describe("POST /rooms (N-player shape)", () => {
  it("creates a 4-player room with 3 bots: no invite token, 3 bot seats", async () => {
    // playerCount === 1 host + botCount === 3 bots: no human-claimable seats
    // and no lobbyHold, so the inviteToken is omitted (joinTokens empty).
    const res = await postRooms({ playerCount: 4, botCount: 3 });
    expect(res.status).toBe(201);
    const body = (await res.json()) as CreateRoomResponse & { joinTokens?: string[] };
    expect(body.roomId.length).toBeGreaterThan(0);
    expect(body.hostToken.length).toBeGreaterThan(0);
    expect(body.joinTokens ?? []).toEqual([]);
    expect(body.joinToken).toBeUndefined();

    const stub = env.ROOMS.get(env.ROOMS.idFromName(body.roomId));
    let pc = 0;
    let botSeats: number[] = [];
    await runInDurableObject(stub, async (room: Room) => {
      pc = room.testPlayerCount();
      botSeats = room.testBotSeats();
    });
    expect(pc).toBe(4);
    expect(botSeats).toEqual([1, 2, 3]);
  });

  it("creates a 6-player room with 2 bots: single invite token, 2 bot seats", async () => {
    // 1 host + 2 bots = 3 humans expected. The shared inviteToken
    // replaces the per-seat token-as-link scheme; each successive joiner
    // claims the next free seat.
    const res = await postRooms({ playerCount: 6, botCount: 2 });
    expect(res.status).toBe(201);
    const body = (await res.json()) as CreateRoomResponse & { joinTokens?: string[] };
    const tokens = body.joinTokens ?? [];
    expect(tokens.length).toBe(1);
    expect(typeof body.joinToken).toBe("string");
    expect(body.joinToken).toBe(tokens[0]);

    const stub = env.ROOMS.get(env.ROOMS.idFromName(body.roomId));
    let pc = 0;
    let botSeats: number[] = [];
    await runInDurableObject(stub, async (room: Room) => {
      pc = room.testPlayerCount();
      botSeats = room.testBotSeats();
    });
    expect(pc).toBe(6);
    expect(botSeats).toEqual([4, 5]);
  });

  it("legacy mode:human still works: playerCount=2, botCount=0", async () => {
    const res = await postRooms({ mode: "human" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as CreateRoomResponse;
    expect(body.joinToken).toBeDefined();

    const stub = env.ROOMS.get(env.ROOMS.idFromName(body.roomId));
    let pc = 0;
    let botSeats: number[] = [];
    await runInDurableObject(stub, async (room: Room) => {
      pc = room.testPlayerCount();
      botSeats = room.testBotSeats();
    });
    expect(pc).toBe(2);
    expect(botSeats).toEqual([]);
  });

  it("legacy mode:bot still works: playerCount=2, botCount=1", async () => {
    // 1 host + 1 bot, no lobbyHold → no human-claimable seats → no
    // inviteToken in the response.
    const res = await postRooms({ mode: "bot" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as CreateRoomResponse;
    expect(body.joinToken).toBeUndefined();

    const stub = env.ROOMS.get(env.ROOMS.idFromName(body.roomId));
    let pc = 0;
    let botSeats: number[] = [];
    await runInDurableObject(stub, async (room: Room) => {
      pc = room.testPlayerCount();
      botSeats = room.testBotSeats();
    });
    expect(pc).toBe(2);
    expect(botSeats).toEqual([1]);
  });

  it("rejects botCount equal to playerCount (no humans)", async () => {
    const res = await postRooms({ playerCount: 3, botCount: 3 });
    expect(res.status).toBe(400);
  });

  it("rejects playerCount > 6", async () => {
    const res = await postRooms({ playerCount: 7, botCount: 1 });
    expect(res.status).toBe(400);
  });
});

describe("Multi-bot driver", () => {
  it("plays a 1-human + 3-bot game to game-over", async () => {
    const res = await postRooms({ playerCount: 4, botCount: 3 });
    const body = (await res.json()) as CreateRoomResponse;
    const stub = env.ROOMS.get(env.ROOMS.idFromName(body.roomId));

    const ws = await openWs(body.roomId, body.hostToken);
    const q = new MessageQueue(ws);
    await findUntil(q, isRoomState);
    await findUntil(q, isSnapshot);

    let safety = 0;
    while (safety < 4000) {
      const state = await readEngineState(stub);
      if (!state || state.phase !== "in-round") break;
      // Only act when it's the human's turn.
      const action = bot.choose(state);
      if (action.type === "START_GAME" || action.by !== 0) {
        // Server-side bot drives this seat; let the alarm chain run.
        await new Promise<void>((r) => setTimeout(r, 5));
        safety++;
        continue;
      }
      ws.send(JSON.stringify({ type: "SubmitAction", action }));
      await new Promise<void>((r) => setTimeout(r, 5));
      safety++;
    }
    const final = await readEngineState(stub);
    expect(final?.phase).toBe("game-over");
    ws.close();
  }, 30_000);
});

describe("Spectator semantics", () => {
  it("eliminated seat receives FORBIDDEN_ACTION on submit; broadcasts continue", async () => {
    // 3-player human-only room, then synthesize seat 1 elimination via the
    // test seam. The host (seat 0) sends an attack — works. Eliminated seat 1
    // sends a same-phase action — rejected with FORBIDDEN_ACTION.
    const res = await postRooms({ playerCount: 3, botCount: 0 });
    const body = (await res.json()) as CreateRoomResponse & { joinTokens?: string[] };
    const invite = body.joinToken;
    if (!invite) throw new Error("missing invite token");
    const stub = env.ROOMS.get(env.ROOMS.idFromName(body.roomId));

    const a = await openWs(body.roomId, body.hostToken);
    const qa = new MessageQueue(a);
    await findUntil(qa, isRoomState);
    const b = await openWs(body.roomId, invite);
    const qb = new MessageQueue(b);
    const c = await openWs(body.roomId, invite);
    const qc = new MessageQueue(c);

    await findUntil(qa, isSnapshot);
    await findUntil(qb, isSnapshot);
    await findUntil(qc, isSnapshot);
    await findUntil(qa, isEvents);
    await findUntil(qb, isEvents);
    await findUntil(qc, isEvents);

    // Eliminate seat 1 server-side.
    await runInDurableObject(stub, async (room: Room) => {
      room.testEliminateSeat(1);
    });

    // Seat 1 attempts an action — must be rejected with FORBIDDEN_ACTION.
    const before = await readEngineState(stub);
    if (!before || before.phase !== "in-round") throw new Error("expected in-round");
    // Pick any card from seat 0's hand to fabricate a SubmitAction; the
    // worker overrides `by` so the seat 1 sender gets the rejection.
    const seat0Hand = before.hands[0] ?? [];
    const card = seat0Hand[0];
    if (!card) throw new Error("expected seat 0 card");
    b.send(
      JSON.stringify({
        type: "SubmitAction",
        action: { type: "ATTACK", by: 1, card },
      }),
    );
    let sawError = false;
    for (let i = 0; i < 10; i++) {
      const msg = await qb.next();
      if (msg.type === "Error") {
        expect(msg.code).toBe("FORBIDDEN_ACTION");
        sawError = true;
        break;
      }
    }
    expect(sawError).toBe(true);

    a.close();
    b.close();
    c.close();
  }, 15_000);
});

describe("Multi-disconnect forfeit", () => {
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

  it("tracks two simultaneous disconnects in a 4-player game; first deadline ends the game", async () => {
    const res = await postRooms({ playerCount: 4, botCount: 0 });
    const body = (await res.json()) as CreateRoomResponse & { joinTokens?: string[] };
    const invite = body.joinToken;
    if (!invite) throw new Error("missing invite token");
    const stub = env.ROOMS.get(env.ROOMS.idFromName(body.roomId));

    const wA = await openWs(body.roomId, body.hostToken);
    const qA = new MessageQueue(wA);
    await findUntil(qA, isRoomState);
    const wB = await openWs(body.roomId, invite);
    const qB = new MessageQueue(wB);
    const wC = await openWs(body.roomId, invite);
    const qC = new MessageQueue(wC);
    const wD = await openWs(body.roomId, invite);
    const qD = new MessageQueue(wD);

    await findUntil(qA, isSnapshot);
    await findUntil(qB, isSnapshot);
    await findUntil(qC, isSnapshot);
    await findUntil(qD, isSnapshot);
    await findUntil(qA, isEvents);
    await findUntil(qB, isEvents);
    await findUntil(qC, isEvents);
    await findUntil(qD, isEvents);

    wB.close();
    wC.close();

    // Both disconnects should be tracked.
    await waitFor(async () => {
      let count = 0;
      await runInDurableObject(stub, async (room: Room) => {
        count = room.testDisconnects().length;
      });
      return count >= 2 ? count : null;
    });

    let disconnects: { seat: number; forfeitAt: number }[] = [];
    await runInDurableObject(stub, async (room: Room) => {
      disconnects = room.testDisconnects();
    });
    const seats = disconnects.map((d) => d.seat).sort((a, b) => a - b);
    expect(seats).toEqual([1, 2]);

    // Forfeit alarm armed at the earliest forfeitAt.
    const deadlines = await readDeadlines(stub);
    const earliest = Math.min(...disconnects.map((d) => d.forfeitAt));
    expect(deadlines.forfeit).toBe(earliest);

    // Fire the forfeit alarm. The first-ordered disconnect (seat 1, since
    // it closed first and ties break by seat) becomes durak.
    let fired: string[] = [];
    await runInDurableObject(stub, async (room: Room) => {
      fired = await room.testFireAlarm(Date.now() + 60_000);
    });
    expect(fired).toContain("forfeit");

    const final = await readEngineState(stub);
    expect(final?.phase).toBe("game-over");
    if (final?.phase !== "game-over") throw new Error("expected game-over");
    expect([1, 2]).toContain(final.durak);

    wA.close();
    wD.close();
  }, 20_000);
});

describe("All-bots autoplay 2x speedup", () => {
  it("flags allBotsActive once every non-eliminated seat is a bot", async () => {
    const res = await postRooms({ playerCount: 3, botCount: 2 });
    const body = (await res.json()) as CreateRoomResponse;
    const stub = env.ROOMS.get(env.ROOMS.idFromName(body.roomId));

    const ws = await openWs(body.roomId, body.hostToken);
    const q = new MessageQueue(ws);
    await findUntil(q, isRoomState);
    await findUntil(q, isSnapshot);

    let active = false;
    await runInDurableObject(stub, async (room: Room) => {
      active = room.testAllBotsActive();
    });
    expect(active).toBe(false);

    await runInDurableObject(stub, async (room: Room) => {
      room.testEliminateSeat(0);
      active = room.testAllBotsActive();
    });
    expect(active).toBe(true);

    ws.close();
  });

  // Direct end-to-end measurement of the alarm schedule depends on the
  // engine's attacker-pick landing on a bot at game start (otherwise the bot
  // driver has no active bot to schedule for, even after the human is
  // eliminated). The unit-level `allBotsActive` flag above plus the one-line
  // ternary in `armBotTurnIfNeeded` cover the speedup behavior; an
  // integration test that grinds the human to game-elimination naturally is
  // covered by the existing 1H+3B `Multi-bot driver` flow.
});

describe("Best-of-N match", () => {
  it("default totalRounds=1 omits the match block in RoomState", async () => {
    const res = await postRooms({ playerCount: 2, botCount: 1 });
    const body = (await res.json()) as CreateRoomResponse;
    const ws = await openWs(body.roomId, body.hostToken);
    const q = new MessageQueue(ws);
    const rs = await findUntil(q, isRoomState);
    // null/undefined either way is fine — the test is "no multi-round
    // payload leaks for legacy single-game rooms".
    expect(rs.match ?? null).toBeNull();
    ws.close();
  });

  it("multi-round room broadcasts match state and advances on StartGame", async () => {
    const res = await postRooms({ playerCount: 2, botCount: 1, rounds: 3 });
    const body = (await res.json()) as CreateRoomResponse;
    const stub = env.ROOMS.get(env.ROOMS.idFromName(body.roomId));
    const ws = await openWs(body.roomId, body.hostToken);
    const q = new MessageQueue(ws);

    const initial = await findUntil(q, isRoomState);
    expect(initial.match).toMatchObject({
      currentRound: 1,
      totalRounds: 3,
      scores: [0, 0],
      matchOver: false,
    });

    // Simulate round-1 finishing as a host loss via a direct seam:
    // synthesize a game-over with seat 0 as durak. The match logic
    // doesn't care how the round ended, only the durak field.
    await runInDurableObject(stub, async (room: Room) => {
      room.testForceGameOver(0);
    });

    // Score should record seat-0 as durak (playerCount=2 pts); round
    // counter still 1 (advance is on StartGame, not on round end).
    let postRoundMatch: {
      currentRound: number;
      totalRounds: number;
      scores: number[];
      matchOver: boolean;
    } | null = null;
    await runInDurableObject(stub, async (room: Room) => {
      postRoundMatch = room.testMatchState();
    });
    expect(postRoundMatch).toMatchObject({
      currentRound: 1,
      totalRounds: 3,
      scores: [2, 0],
      matchOver: false,
    });

    // Host advances to round 2.
    ws.send(JSON.stringify({ type: "StartGame" }));
    let advanced = false;
    for (let i = 0; i < 30 && !advanced; i++) {
      await new Promise<void>((r) => setTimeout(r, 10));
      await runInDurableObject(stub, async (room: Room) => {
        const m = room.testMatchState();
        if (m && m.currentRound === 2) advanced = true;
      });
    }
    expect(advanced).toBe(true);

    ws.close();
  });

  it("flips matchOver after the final round ends", async () => {
    const res = await postRooms({ playerCount: 2, botCount: 1, rounds: 2 });
    const body = (await res.json()) as CreateRoomResponse;
    const stub = env.ROOMS.get(env.ROOMS.idFromName(body.roomId));
    const ws = await openWs(body.roomId, body.hostToken);
    const q = new MessageQueue(ws);
    await findUntil(q, isRoomState);

    // Round 1: host loses.
    await runInDurableObject(stub, async (room: Room) => {
      room.testForceGameOver(0);
    });
    ws.send(JSON.stringify({ type: "StartGame" }));
    // Wait for round 2 to start.
    let advanced = false;
    for (let i = 0; i < 30 && !advanced; i++) {
      await new Promise<void>((r) => setTimeout(r, 10));
      await runInDurableObject(stub, async (room: Room) => {
        const m = room.testMatchState();
        if (m && m.currentRound === 2) advanced = true;
      });
    }
    expect(advanced).toBe(true);

    // Round 2: bot loses. Match should now be over (BO2 cap reached).
    await runInDurableObject(stub, async (room: Room) => {
      room.testForceGameOver(1);
    });
    let final: { matchOver: boolean; scores: number[] } | null = null;
    await runInDurableObject(stub, async (room: Room) => {
      final = room.testMatchState();
    });
    // Round 1: seat 0 durak (2 pts, seat 1 = 0 pts).
    // Round 2: seat 1 durak (2 pts, seat 0 += 0 = 2 pts).
    expect(final).toMatchObject({ matchOver: true, scores: [2, 2] });

    ws.close();
  });
});
