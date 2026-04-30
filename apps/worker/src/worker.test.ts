import { env, runInDurableObject, SELF } from "cloudflare:test";
import { bot, type State } from "@durak/engine";
import type {
  CreateRoomResponse,
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
