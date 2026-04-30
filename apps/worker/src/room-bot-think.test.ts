import { env, runInDurableObject, SELF } from "cloudflare:test";
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
  return `10.99.${(ipCounter >> 8) & 0xff}.${ipCounter & 0xff}`;
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

async function findUntil<T extends ServerMessage>(
  q: MessageQueue,
  predicate: (m: ServerMessage) => m is T,
  attempts = 12,
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

async function readDeadlines(stub: DurableObjectStub<Room>): Promise<PersistedDeadlines> {
  let out: PersistedDeadlines = {};
  await runInDurableObject(stub, async (room: Room) => {
    out = room.testDeadlines();
  });
  return out;
}

describe("Room bot pacing", () => {
  it("schedules a bot-think alarm and broadcasts thinkingSeats once a bot is active", async () => {
    const created = await postRooms({ mode: "bot" });
    const body = (await created.json()) as CreateRoomResponse;
    const stub = env.ROOMS.get(env.ROOMS.idFromName(body.roomId));
    await runInDurableObject(stub, async (room: Room) => {
      room.testSetThinkBounds({ min: 200, max: 800 });
    });

    const ws = await openWs(body.roomId, body.hostToken);
    const q = new MessageQueue(ws);
    await findUntil(q, isRoomState);
    const initialSnap = await findUntil(q, isSnapshot);
    // Start of game; if the bot opens, an alarm should already be armed.
    // If the human opens, no bot-think alarm yet — submit a TAKE_PILE-equivalent
    // legal opener so the bot becomes active.
    const humanSeat = initialSnap.snapshot.seat;

    if (initialSnap.snapshot.attacker !== humanSeat) {
      // Bot opens: bot-think should already be armed.
      const deadlines = await readDeadlines(stub);
      expect(deadlines["bot-think"]).toBeGreaterThan(Date.now());
      ws.close();
      return;
    }

    // Human opens. Send the cheapest card in hand as ATTACK to flip the
    // active seat to the bot.
    const card = initialSnap.snapshot.you.hand[0];
    if (!card) throw new Error("expected at least one card in opener hand");
    ws.send(
      JSON.stringify({
        type: "SubmitAction",
        action: { type: "ATTACK", by: humanSeat, card },
      }),
    );
    // Wait for the resulting Snapshot+Events from the human's move.
    await findUntil(q, isSnapshot);
    await findUntil(q, isEvents);

    // The bot is now defender. A bot-think alarm should be armed and the
    // surviving RoomState should mention thinkingSeats: [1].
    const roomMsg = await findUntil(q, isRoomState);
    expect(roomMsg.thinkingSeats).toEqual([1]);
    const deadlines = await readDeadlines(stub);
    expect(deadlines["bot-think"]).toBeGreaterThan(Date.now());

    // Fire the alarm: the bot moves and either makes another move or hands
    // back to the human. After firing, the broadcast clears thinkingSeats
    // (assuming the bot finished its turn).
    let fired: string[] = [];
    await runInDurableObject(stub, async (room: Room) => {
      fired = await room.testFireAlarm(Date.now() + 5_000);
    });
    expect(fired).toContain("bot-think");

    // The bot's move emits a Snapshot+Events to the human.
    await findUntil(q, isSnapshot);
    await findUntil(q, isEvents);

    ws.close();
  }, 15_000);

  it("clears thinkingSeats when the bot's turn ends", async () => {
    const created = await postRooms({ mode: "bot" });
    const body = (await created.json()) as CreateRoomResponse;
    const stub = env.ROOMS.get(env.ROOMS.idFromName(body.roomId));
    await runInDurableObject(stub, async (room: Room) => {
      room.testSetThinkBounds({ min: 50, max: 200 });
    });

    const ws = await openWs(body.roomId, body.hostToken);
    const q = new MessageQueue(ws);
    await findUntil(q, isRoomState);
    const snap = await findUntil(q, isSnapshot);

    if (snap.snapshot.attacker === snap.snapshot.seat) {
      const card = snap.snapshot.you.hand[0];
      if (!card) throw new Error("no card");
      ws.send(
        JSON.stringify({
          type: "SubmitAction",
          action: { type: "ATTACK", by: snap.snapshot.seat, card },
        }),
      );
      await findUntil(q, isSnapshot);
      await findUntil(q, isEvents);
    }

    // Wait for the bot-think RoomState (server confirms it scheduled).
    const before = await findUntil(q, isRoomState);
    expect(before.thinkingSeats?.length ?? 0).toBeGreaterThan(0);

    // Fire the alarm and assert the bot's move flushes thinkingSeats. The
    // alarm handler explicitly broadcasts a fresh RoomState before the move
    // runs, then armBotTurnIfNeeded re-broadcasts only if a new alarm is
    // scheduled — so a "clearing" RoomState is always observable.
    await runInDurableObject(stub, async (room: Room) => {
      await room.testFireAlarm(Date.now() + 5_000);
    });
    const cleared = await findUntil(q, isRoomState);
    expect(cleared.thinkingSeats ?? []).toEqual([]);

    ws.close();
  }, 15_000);
});
