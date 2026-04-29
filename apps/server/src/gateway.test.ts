import type { AddressInfo } from "node:net";
import { bot } from "@durak/engine";
import type {
  ErrorMessage,
  EventsMessage,
  RoomStateMessage,
  ServerMessage,
  SnapshotMessage,
} from "@durak/protocol";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { type BuildAppOptions, type BuiltApp, buildApp } from "./app.js";

let built: BuiltApp | null = null;

afterEach(async () => {
  if (built) {
    await built.app.close();
    built = null;
  }
});

async function start(
  options: BuildAppOptions = {},
): Promise<{ wsUrl: (path: string) => string; built: BuiltApp }> {
  built = await buildApp({
    rateLimit: { capacity: 1000, refillIntervalMs: 1000 },
    ...options,
  });
  await built.app.listen({ port: 0, host: "127.0.0.1" });
  const addr = built.app.server.address() as AddressInfo;
  const wsUrl = (path: string) => `ws://127.0.0.1:${addr.port}${path}`;
  return { wsUrl, built };
}

class MessageQueue {
  private queue: ServerMessage[] = [];
  private waiters: Array<(msg: ServerMessage) => void> = [];
  private closed = false;

  constructor(client: WebSocket) {
    client.on("message", (data: WebSocket.RawData) => {
      const msg = JSON.parse(data.toString()) as ServerMessage;
      const waiter = this.waiters.shift();
      if (waiter) waiter(msg);
      else this.queue.push(msg);
    });
    client.on("close", () => {
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

function nextOpen(client: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    client.once("open", () => resolve());
    client.once("error", (err) => reject(err));
  });
}

function nextClose(client: WebSocket, timeoutMs = 1000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("ws close timeout")), timeoutMs);
    client.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });
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

describe("gateway /ws/:roomId: rejection paths", () => {
  it("rejects connection to an unknown room", async () => {
    const { wsUrl } = await start();
    const c = new WebSocket(wsUrl("/ws/does-not-exist?token=anything"));
    const closed = nextClose(c);
    const q = new MessageQueue(c);
    const msg = await findUntil(q, isError);
    expect(msg.code).toBe("ROOM_NOT_FOUND");
    await closed;
  });

  it("rejects connection with a forged token", async () => {
    const { wsUrl, built } = await start();
    const room = built.registry.create();
    room.addPlayer("alice");
    const c = new WebSocket(wsUrl(`/ws/${room.id}?token=not-a-real-token`));
    const closed = nextClose(c);
    const q = new MessageQueue(c);
    const msg = await findUntil(q, isError);
    expect(msg.code).toBe("BAD_TOKEN");
    await closed;
  });

  it("malformed JSON yields Error and closes the socket", async () => {
    const { wsUrl, built } = await start();
    const room = built.registry.create();
    const a = room.addPlayer("alice");
    const c = new WebSocket(wsUrl(`/ws/${room.id}?token=${a.token}`));
    const q = new MessageQueue(c);
    await nextOpen(c);
    await findUntil(q, isRoomState);
    const closed = nextClose(c);
    c.send("not json at all");
    const err = await findUntil(q, isError);
    expect(err.code).toBe("BAD_MESSAGE");
    await closed;
  });

  it("Zod-invalid message yields Error and closes the socket", async () => {
    const { wsUrl, built } = await start();
    const room = built.registry.create();
    const a = room.addPlayer("alice");
    const c = new WebSocket(wsUrl(`/ws/${room.id}?token=${a.token}`));
    const q = new MessageQueue(c);
    await nextOpen(c);
    await findUntil(q, isRoomState);
    const closed = nextClose(c);
    c.send(JSON.stringify({ type: "JoinRoom", roomId: 5 }));
    const err = await findUntil(q, isError);
    expect(err.code).toBe("BAD_MESSAGE");
    await closed;
  });
});

describe("gateway /ws/:roomId: game loop integration", () => {
  it("auto-starts the game when both clients connect and broadcasts a Snapshot to each", async () => {
    const { wsUrl, built } = await start();
    const room = built.registry.create();
    const a = room.addPlayer("alice");
    const b = room.addPlayer("bob");

    const ca = new WebSocket(wsUrl(`/ws/${room.id}?token=${a.token}`));
    const qa = new MessageQueue(ca);
    await nextOpen(ca);
    const stateA1 = await findUntil(qa, isRoomState);
    expect(stateA1.you).toBe(0);

    const cb = new WebSocket(wsUrl(`/ws/${room.id}?token=${b.token}`));
    const qb = new MessageQueue(cb);
    await nextOpen(cb);

    const snapA = await findUntil(qa, isSnapshot);
    const snapB = await findUntil(qb, isSnapshot);
    const eventsA = await findUntil(qa, isEvents);
    const eventsB = await findUntil(qb, isEvents);

    expect(snapA.snapshot.seat).toBe(0);
    expect(snapA.snapshot.you.seat).toBe(0);
    expect(snapA.snapshot.you.hand.length).toBe(6);
    expect(snapB.snapshot.seat).toBe(1);
    expect(snapB.snapshot.you.seat).toBe(1);
    expect(snapB.snapshot.you.hand.length).toBe(6);
    expect(snapA.snapshot.you.hand).not.toEqual(snapB.snapshot.you.hand);
    expect(snapA.snapshot.trump).toEqual(snapB.snapshot.trump);

    expect(eventsA.events.some((e) => e.type === "GAME_STARTED")).toBe(true);
    expect(eventsB.events.some((e) => e.type === "GAME_STARTED")).toBe(true);

    ca.close();
    cb.close();
    await Promise.all([nextClose(ca), nextClose(cb)]);
  });

  it("a legal action broadcasts a Snapshot+Events to both seats; an illegal action errors only the offender", async () => {
    const { wsUrl, built } = await start();
    const room = built.registry.create();
    const a = room.addPlayer("alice");
    const b = room.addPlayer("bob");

    const ca = new WebSocket(wsUrl(`/ws/${room.id}?token=${a.token}`));
    const qa = new MessageQueue(ca);
    await nextOpen(ca);
    await findUntil(qa, isRoomState);

    const cb = new WebSocket(wsUrl(`/ws/${room.id}?token=${b.token}`));
    const qb = new MessageQueue(cb);
    await nextOpen(cb);

    const initialA = await findUntil(qa, isSnapshot);
    const initialB = await findUntil(qb, isSnapshot);
    await findUntil(qa, isEvents);
    await findUntil(qb, isEvents);

    const attackerSeat = initialA.snapshot.attacker;
    const attackerSnap = attackerSeat === 0 ? initialA : initialB;
    const attackerSocket = attackerSeat === 0 ? ca : cb;
    const defenderSocket = attackerSeat === 0 ? cb : ca;
    const qAttacker = attackerSeat === 0 ? qa : qb;
    const qDefender = attackerSeat === 0 ? qb : qa;
    const attackerCard = attackerSnap.snapshot.you.hand[0];
    if (!attackerCard) throw new Error("expected card");

    attackerSocket.send(
      JSON.stringify({
        type: "SubmitAction",
        action: { type: "ATTACK", by: attackerSeat, card: attackerCard },
      }),
    );
    const snapAfterA = await findUntil(qAttacker, isSnapshot);
    const snapAfterB = await findUntil(qDefender, isSnapshot);
    const eventsAfterA = await findUntil(qAttacker, isEvents);
    const eventsAfterB = await findUntil(qDefender, isEvents);
    expect(snapAfterA.snapshot.table.length).toBe(1);
    expect(snapAfterB.snapshot.table.length).toBe(1);
    expect(eventsAfterA.events[0]?.type).toBe("CARD_PLAYED");
    expect(eventsAfterB.events[0]?.type).toBe("CARD_PLAYED");

    defenderSocket.send(
      JSON.stringify({
        type: "SubmitAction",
        action: {
          type: "ATTACK",
          by: attackerSeat === 0 ? 1 : 0,
          card: attackerCard,
        },
      }),
    );
    const err = await findUntil(qDefender, isError);
    expect(err.code).not.toBe("");
    expect(err.code).not.toBe("ROOM_NOT_FOUND");

    await new Promise((r) => setTimeout(r, 50));
    expect(qAttacker.drain().some(isError)).toBe(false);
    expect(qDefender.drain().some(isError)).toBe(false);

    ca.close();
    cb.close();
    await Promise.all([nextClose(ca), nextClose(cb)]);
  });

  it("rate-limits action floods on a connection", async () => {
    built = await buildApp({ rateLimit: { capacity: 2, refillIntervalMs: 60_000 } });
    await built.app.listen({ port: 0, host: "127.0.0.1" });
    const addr = built.app.server.address() as AddressInfo;
    const wsUrl = (path: string) => `ws://127.0.0.1:${addr.port}${path}`;
    const room = built.registry.create();
    const a = room.addPlayer("alice");
    const b = room.addPlayer("bob");

    const ca = new WebSocket(wsUrl(`/ws/${room.id}?token=${a.token}`));
    const qa = new MessageQueue(ca);
    await nextOpen(ca);
    await findUntil(qa, isRoomState);

    const cb = new WebSocket(wsUrl(`/ws/${room.id}?token=${b.token}`));
    const qb = new MessageQueue(cb);
    await nextOpen(cb);
    await findUntil(qa, isSnapshot);
    await findUntil(qb, isSnapshot);
    await findUntil(qa, isEvents);
    await findUntil(qb, isEvents);

    for (let i = 0; i < 20; i++) {
      ca.send(JSON.stringify({ type: "SubmitAction", action: { type: "TAKE_PILE", by: 0 } }));
    }
    await new Promise((r) => setTimeout(r, 100));
    const errors = qa.drain().filter(isError);
    expect(errors.length).toBeLessThanOrEqual(2);

    ca.close();
    cb.close();
    await Promise.all([nextClose(ca), nextClose(cb)]);
  });

  it("rejects ws upgrade from a disallowed origin when the allowlist is set", async () => {
    const { wsUrl, built } = await start({ allowedOrigins: ["https://app.example.com"] });
    const room = built.registry.create();
    const a = room.addPlayer("alice");

    const c = new WebSocket(wsUrl(`/ws/${room.id}?token=${a.token}`), {
      headers: { Origin: "https://evil.example.com" },
    });
    const closed = nextClose(c);
    const errored = new Promise<Error>((resolve) => c.once("error", resolve));
    const err = await errored;
    expect(err.message).toMatch(/403/);
    await closed;
  });

  it("accepts ws upgrade from an allowed origin when the allowlist is set", async () => {
    const { wsUrl, built } = await start({ allowedOrigins: ["https://app.example.com"] });
    const room = built.registry.create();
    const a = room.addPlayer("alice");

    const c = new WebSocket(wsUrl(`/ws/${room.id}?token=${a.token}`), {
      headers: { Origin: "https://app.example.com" },
    });
    const q = new MessageQueue(c);
    await nextOpen(c);
    const state = (await q.next()) as RoomStateMessage;
    expect(state.type).toBe("RoomState");

    c.close();
    await nextClose(c);
  });

  it("vs-bot mode: human plays a full game, sees only their own hand, never blocks on the bot", async () => {
    const { wsUrl, built } = await start();
    const room = built.registry.create({ mode: "bot", botIterationCap: 1000 });
    const human = room.addPlayer("alice");

    const ws = new WebSocket(wsUrl(`/ws/${room.id}?token=${human.token}`));
    const q = new MessageQueue(ws);
    await nextOpen(ws);
    await findUntil(q, isRoomState);

    // The first Snapshot is the post-START_GAME state. After that, depending
    // on whether the bot opens the first attack, the human may receive zero
    // or more bot follow-up Snapshot+Events pairs before it's their turn.
    const initialSnap = await findUntil(q, isSnapshot);
    expect(initialSnap.snapshot.seat).toBe(0);
    expect(initialSnap.snapshot.you.seat).toBe(0);
    expect(initialSnap.snapshot.you.hand.length).toBe(6);

    // Drain whatever Events/Snapshots the bot driver produced before the
    // human gets to act.
    let safety = 0;
    while (room.currentState()?.phase === "in-round" && safety < 4000) {
      const state = room.currentState();
      if (!state || state.phase !== "in-round") break;
      // The bot driver runs synchronously inside applyAction/start, so by
      // the time the room yields control the active actor is the human.
      if (state.attacker !== 0 && state.table.length === 0) {
        // Defensive: shouldn't happen because bot driver flushed.
        throw new Error("bot turn leaked through to the human");
      }
      const action = bot.choose(state);
      ws.send(JSON.stringify({ type: "SubmitAction", action }));
      // Wait until the room transitions out of in-round, or the active
      // actor is the human again. We don't poll messages here — we wait
      // for the state machine to settle.
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      safety++;
    }

    expect(room.currentState()?.phase).toBe("game-over");

    // All snapshots delivered to the human only ever expose seat 0's hand.
    const drained = q.drain();
    const allMessages = [initialSnap, ...drained];
    for (const m of allMessages) {
      if (m.type !== "Snapshot") continue;
      expect(m.snapshot.seat).toBe(0);
      expect(m.snapshot.you.seat).toBe(0);
      // Snapshot type-level guards (in @durak/protocol/snapshot.ts) already
      // forbid `hands`/`talon`/`rng` fields. Re-check here so an accidental
      // structural widening on the wire would still fail this test.
      const keys = Object.keys(m.snapshot);
      expect(keys).not.toContain("hands");
      expect(keys).not.toContain("talon");
      expect(keys).not.toContain("rng");
    }

    ws.close();
    await nextClose(ws);
  });

  it("gateway.send delivers a per-seat message to the connected client", async () => {
    const { wsUrl, built } = await start();
    const room = built.registry.create();
    const a = room.addPlayer("alice");
    const c = new WebSocket(wsUrl(`/ws/${room.id}?token=${a.token}`));
    const q = new MessageQueue(c);
    await nextOpen(c);
    await findUntil(q, isRoomState);

    built.gateway.send(room.id, 0, {
      type: "Error",
      code: "TEST",
      message: "hello",
    });
    const err = await findUntil(q, isError);
    expect(err.code).toBe("TEST");
    expect(err.message).toBe("hello");

    c.close();
    await nextClose(c);
  });
});
