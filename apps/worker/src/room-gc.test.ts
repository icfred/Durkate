import { env, runInDurableObject, SELF } from "cloudflare:test";
import { bot, type State } from "@durak/engine";
import type { CreateRoomResponse, ServerMessage } from "@durak/protocol";
import { describe, expect, it } from "vitest";
import type { PersistedDeadlines } from "./alarms.js";
import type { Room } from "./room.js";

let ipCounter = 0;
function freshIp(): string {
  ipCounter += 1;
  return `10.45.${(ipCounter >> 8) & 0xff}.${ipCounter & 0xff}`;
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
    throw new Error(`expected ws upgrade, got ${res.status}`);
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

async function findUntil(
  q: MessageQueue,
  predicate: (m: ServerMessage) => boolean,
  attempts = 8,
): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    const msg = await q.next();
    if (predicate(msg)) return;
  }
  throw new Error("did not find expected message");
}

async function settle(): Promise<void> {
  // Yield enough times for hibernation-API close events to be delivered.
  for (let i = 0; i < 5; i++) await new Promise<void>((r) => setTimeout(r, 10));
}

async function readDeadlines(stub: DurableObjectStub<Room>): Promise<PersistedDeadlines> {
  let out: PersistedDeadlines = {};
  await runInDurableObject(stub, async (room: Room) => {
    out = room.testDeadlines();
  });
  return out;
}

async function readStorageSize(stub: DurableObjectStub<Room>): Promise<number> {
  let size = 0;
  await runInDurableObject(stub, async (_r, state) => {
    const all = await state.storage.list();
    size = all.size;
  });
  return size;
}

async function readScheduledAlarm(stub: DurableObjectStub<Room>): Promise<number | null> {
  let at: number | null = null;
  await runInDurableObject(stub, async (_r, state) => {
    at = await state.storage.getAlarm();
  });
  return at;
}

describe("Room GC", () => {
  it("evicts an abandoned-on-create bot room when no client ever attaches", async () => {
    const created = await postRooms({ mode: "bot" });
    const body = (await created.json()) as CreateRoomResponse;
    const stub = env.ROOMS.get(env.ROOMS.idFromName(body.roomId));

    const deadlines = await readDeadlines(stub);
    expect(deadlines.abandoned).toBeGreaterThan(Date.now());
    expect(deadlines.idle).toBeUndefined();
    expect(deadlines["turn-timeout"]).toBeUndefined();
    expect(await readScheduledAlarm(stub)).toBe(deadlines.abandoned);

    let fired: string[] = [];
    await runInDurableObject(stub, async (room: Room) => {
      fired = await room.testFireAlarm(Date.now() + 10 * 60 * 1000);
    });
    expect(fired).toContain("abandoned");

    expect(await readStorageSize(stub)).toBe(0);
    expect(await readScheduledAlarm(stub)).toBeNull();
  });

  it("evicts an abandoned-on-create human room when no client ever attaches", async () => {
    const created = await postRooms({ mode: "human" });
    const body = (await created.json()) as CreateRoomResponse;
    const stub = env.ROOMS.get(env.ROOMS.idFromName(body.roomId));

    expect((await readDeadlines(stub)).abandoned).toBeGreaterThan(Date.now());

    let fired: string[] = [];
    await runInDurableObject(stub, async (room: Room) => {
      fired = await room.testFireAlarm(Date.now() + 10 * 60 * 1000);
    });
    expect(fired).toContain("abandoned");
    expect(await readStorageSize(stub)).toBe(0);
  });

  it("evicts a finished game after stale-finished window", async () => {
    const created = await postRooms({ mode: "bot" });
    const body = (await created.json()) as CreateRoomResponse;
    const stub = env.ROOMS.get(env.ROOMS.idFromName(body.roomId));

    const ws = await openWs(body.roomId, body.hostToken);
    const q = new MessageQueue(ws);
    await findUntil(q, (m) => m.type === "RoomState");
    await findUntil(q, (m) => m.type === "Snapshot");

    const readEngine = async (): Promise<State | null> => {
      let out: State | null = null;
      await runInDurableObject(stub, async (room: Room) => {
        out = room.testCurrentState();
      });
      return out;
    };

    let safety = 0;
    while (safety < 4000) {
      const state = await readEngine();
      if (!state || state.phase !== "in-round") break;
      const action = bot.choose(state);
      ws.send(JSON.stringify({ type: "SubmitAction", action }));
      await new Promise<void>((r) => setTimeout(r, 5));
      safety += 1;
    }

    const finalState = await readEngine();
    expect(finalState?.phase).toBe("game-over");

    const deadlines = await readDeadlines(stub);
    expect(deadlines.stale).toBeGreaterThan(Date.now());
    expect(deadlines.idle).toBeUndefined();
    expect(deadlines["turn-timeout"]).toBeUndefined();

    ws.close();
    await settle();

    let fired: string[] = [];
    await runInDurableObject(stub, async (room: Room) => {
      fired = await room.testFireAlarm(Date.now() + 15 * 60 * 1000);
    });
    expect(fired).toContain("stale");
    expect(await readStorageSize(stub)).toBe(0);
    expect(await readScheduledAlarm(stub)).toBeNull();
  }, 30_000);

  it("evicts a mid-game room after both seats close (idle 5 min)", async () => {
    const created = await postRooms({ mode: "human" });
    const body = (await created.json()) as CreateRoomResponse;
    if (!body.joinToken) throw new Error("expected joinToken");
    const stub = env.ROOMS.get(env.ROOMS.idFromName(body.roomId));

    const a = await openWs(body.roomId, body.hostToken);
    const qa = new MessageQueue(a);
    await findUntil(qa, (m) => m.type === "RoomState");
    const b = await openWs(body.roomId, body.joinToken);
    const qb = new MessageQueue(b);
    await findUntil(qa, (m) => m.type === "Snapshot");
    await findUntil(qb, (m) => m.type === "Snapshot");

    a.close();
    b.close();
    await settle();

    const deadlines = await readDeadlines(stub);
    expect(deadlines.idle).toBeGreaterThan(Date.now());
    expect(deadlines["turn-timeout"]).toBeUndefined();
    expect(deadlines.abandoned).toBeUndefined();

    let fired: string[] = [];
    await runInDurableObject(stub, async (room: Room) => {
      fired = await room.testFireAlarm(Date.now() + 10 * 60 * 1000);
    });
    expect(fired).toContain("idle");
    expect(await readStorageSize(stub)).toBe(0);
    expect(await readScheduledAlarm(stub)).toBeNull();
  });

  it("cancels idle eviction when a seat reconnects within the window", async () => {
    const created = await postRooms({ mode: "human" });
    const body = (await created.json()) as CreateRoomResponse;
    if (!body.joinToken) throw new Error("expected joinToken");
    const stub = env.ROOMS.get(env.ROOMS.idFromName(body.roomId));

    const a = await openWs(body.roomId, body.hostToken);
    const qa = new MessageQueue(a);
    await findUntil(qa, (m) => m.type === "RoomState");
    const b = await openWs(body.roomId, body.joinToken);
    const qb = new MessageQueue(b);
    await findUntil(qa, (m) => m.type === "Snapshot");
    await findUntil(qb, (m) => m.type === "Snapshot");

    a.close();
    b.close();
    await settle();

    expect((await readDeadlines(stub)).idle).toBeGreaterThan(Date.now());

    const a2 = await openWs(body.roomId, body.hostToken);
    const qa2 = new MessageQueue(a2);
    await findUntil(qa2, (m) => m.type === "RoomState");
    await settle();

    const deadlines = await readDeadlines(stub);
    expect(deadlines.idle).toBeUndefined();
    // The turn clock resumes for the returning seat.
    expect(deadlines["turn-timeout"]).toBeGreaterThan(Date.now());

    a2.close();
  });

  it("clears the alarm when the room is evicted (no alarm leak)", async () => {
    const created = await postRooms({ mode: "bot" });
    const body = (await created.json()) as CreateRoomResponse;
    const stub = env.ROOMS.get(env.ROOMS.idFromName(body.roomId));

    expect(await readScheduledAlarm(stub)).not.toBeNull();
    await runInDurableObject(stub, async (room: Room) => {
      await room.testFireAlarm(Date.now() + 10 * 60 * 1000);
    });
    expect(await readScheduledAlarm(stub)).toBeNull();
    expect(await readStorageSize(stub)).toBe(0);
  });
});
