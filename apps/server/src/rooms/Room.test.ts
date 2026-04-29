import type { ServerMessage } from "@durak/protocol";
import { describe, expect, it } from "vitest";
import { Room, RoomFullError, type SeatIndex, synthesizeTimeoutAction } from "./Room.js";

describe("Room: seat/token management", () => {
  it("seats two players in order and issues distinct tokens", () => {
    const room = new Room();
    const a = room.addPlayer("alice");
    const b = room.addPlayer("bob");
    expect(a.seat).toBe(0);
    expect(b.seat).toBe(1);
    expect(a.token).not.toBe(b.token);
    expect(a.token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("rejects a third player", () => {
    const room = new Room();
    room.addPlayer("alice");
    room.addPlayer("bob");
    expect(() => room.addPlayer("carol")).toThrow(RoomFullError);
  });

  it("frees the seat on removePlayer and lets a new player take it", () => {
    const room = new Room();
    const a = room.addPlayer("alice");
    room.addPlayer("bob");
    expect(room.removePlayer(a.token)).toBe(true);
    const c = room.addPlayer("carol");
    expect(c.seat).toBe(0);
  });

  it("removePlayer returns false for an unknown token", () => {
    const room = new Room();
    room.addPlayer("alice");
    expect(room.removePlayer("not-a-real-token")).toBe(false);
  });

  it("seatForToken resolves a seated token and returns undefined otherwise", () => {
    const room = new Room();
    const a = room.addPlayer("alice");
    const b = room.addPlayer("bob");
    expect(room.seatForToken(a.token)).toBe(0);
    expect(room.seatForToken(b.token)).toBe(1);
    expect(room.seatForToken("nope")).toBeUndefined();
  });

  it("issues globally unique tokens across many joins", () => {
    const tokens = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const room = new Room();
      tokens.add(room.addPlayer("p1").token);
      tokens.add(room.addPlayer("p2").token);
    }
    expect(tokens.size).toBe(400);
  });

  it("attach/detach client tracks per-seat handles", () => {
    const room = new Room();
    const a = room.addPlayer("alice");
    const sent: string[] = [];
    const handle = {
      send: (payload: string) => sent.push(payload),
      close: () => {},
    };
    room.attachClient(a.seat, handle);
    expect(room.clientForSeat(a.seat)).toBe(handle);
    room.detachClient(a.seat);
    expect(room.clientForSeat(a.seat)).toBeUndefined();
  });

  it("removePlayer also clears any attached client for the seat", () => {
    const room = new Room();
    const a = room.addPlayer("alice");
    room.attachClient(a.seat, { send: () => {}, close: () => {} });
    room.removePlayer(a.token);
    expect(room.clientForSeat(a.seat)).toBeUndefined();
  });
});

interface FakeClient {
  sent: ServerMessage[];
  handle: { send: (s: string) => void; close: () => void };
}

function fakeClient(): FakeClient {
  const sent: ServerMessage[] = [];
  return {
    sent,
    handle: {
      send: (payload: string) => {
        sent.push(JSON.parse(payload) as ServerMessage);
      },
      close: () => {},
    },
  };
}

interface FakeClock {
  fire: () => boolean;
  setFn: (cb: () => void, ms: number) => unknown;
  clearFn: (handle: unknown) => void;
}

function fakeClock(): FakeClock {
  const pending = new Map<number, { cb: () => void; ms: number }>();
  let nextId = 1;
  return {
    fire(): boolean {
      const entries = [...pending.entries()];
      if (entries.length === 0) return false;
      const [id, entry] = entries[entries.length - 1] ?? [undefined, undefined];
      if (id === undefined || entry === undefined) return false;
      pending.delete(id);
      entry.cb();
      return true;
    },
    setFn(cb: () => void, ms: number): unknown {
      const id = nextId++;
      pending.set(id, { cb, ms });
      return id;
    },
    clearFn(handle: unknown): void {
      pending.delete(handle as number);
    },
  };
}

function setupRoom(seed: number): {
  room: Room;
  a: FakeClient;
  b: FakeClient;
  clock: FakeClock;
} {
  const clock = fakeClock();
  const room = new Room({
    turnTimeoutMs: 1000,
    setTimeoutFn: clock.setFn,
    clearTimeoutFn: clock.clearFn,
  });
  const aJoin = room.addPlayer("alice");
  const bJoin = room.addPlayer("bob");
  const a = fakeClient();
  const b = fakeClient();
  room.attachClient(aJoin.seat, a.handle);
  room.attachClient(bJoin.seat, b.handle);
  room.start(seed);
  return { room, a, b, clock };
}

describe("Room: game loop", () => {
  it("start() emits a Snapshot and Events to each connected client", () => {
    const { a, b } = setupRoom(42);
    expect(a.sent.length).toBe(2);
    expect(b.sent.length).toBe(2);
    expect(a.sent[0]?.type).toBe("Snapshot");
    expect(a.sent[1]?.type).toBe("Events");
    expect(b.sent[0]?.type).toBe("Snapshot");
    expect(b.sent[1]?.type).toBe("Events");
  });

  it("seat 0 and seat 1 each see only their own hand", () => {
    const { a, b } = setupRoom(42);
    const snapA = a.sent[0];
    const snapB = b.sent[0];
    if (snapA?.type !== "Snapshot" || snapB?.type !== "Snapshot") {
      throw new Error("expected initial Snapshot messages");
    }
    expect(snapA.snapshot.you.seat).toBe(0);
    expect(snapB.snapshot.you.seat).toBe(1);
    expect(snapA.snapshot.you.hand).not.toEqual(snapB.snapshot.you.hand);
  });

  it("rejects a second start()", () => {
    const { room } = setupRoom(42);
    expect(() => room.start(99)).toThrow();
  });

  it("rejects start() before both seats are filled", () => {
    const room = new Room();
    room.addPlayer("alice");
    expect(() => room.start(1)).toThrow();
  });

  it("applyAction returns GAME_NOT_STARTED before start()", () => {
    const room = new Room();
    room.addPlayer("alice");
    room.addPlayer("bob");
    const result = room.applyAction(0, { type: "TAKE_PILE", by: 0 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("GAME_NOT_STARTED");
  });

  it("rejects START_GAME from a client with FORBIDDEN_ACTION", () => {
    const { room } = setupRoom(42);
    const result = room.applyAction(0, { type: "START_GAME" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("FORBIDDEN_ACTION");
  });

  it("applyAction overrides client-supplied 'by' with the bound seat", () => {
    const { room, a } = setupRoom(42);
    const state = room.currentState();
    if (!state || state.phase !== "in-round") throw new Error("expected in-round state");
    const attacker = state.attacker as SeatIndex;
    const attackerHand = state.hands[attacker];
    if (!attackerHand) throw new Error("expected attacker hand");
    const card = attackerHand[0];
    if (!card) throw new Error("expected card");
    const intruder = (attacker === 0 ? 1 : 0) as SeatIndex;
    const result = room.applyAction(intruder, { type: "ATTACK", by: attacker, card });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("NOT_ATTACKER");
    void a;
  });

  it("an illegal action does not advance state and is not broadcast", () => {
    const { room, a, b } = setupRoom(42);
    const before = room.currentState();
    const aBefore = a.sent.length;
    const bBefore = b.sent.length;
    const result = room.applyAction(0, { type: "TAKE_PILE", by: 0 });
    expect(result.ok).toBe(false);
    expect(room.currentState()).toBe(before);
    expect(a.sent.length).toBe(aBefore);
    expect(b.sent.length).toBe(bBefore);
  });

  it("a legal action broadcasts Snapshot and Events to both seats", () => {
    const { room, a, b } = setupRoom(42);
    const state = room.currentState();
    if (!state || state.phase !== "in-round") throw new Error("expected in-round state");
    const attacker = state.attacker as SeatIndex;
    const card = state.hands[attacker]?.[0];
    if (!card) throw new Error("expected card");
    const aBefore = a.sent.length;
    const bBefore = b.sent.length;
    const result = room.applyAction(attacker, { type: "ATTACK", by: attacker, card });
    expect(result.ok).toBe(true);
    expect(a.sent.length).toBe(aBefore + 2);
    expect(b.sent.length).toBe(bBefore + 2);
    expect(a.sent[a.sent.length - 2]?.type).toBe("Snapshot");
    expect(a.sent[a.sent.length - 1]?.type).toBe("Events");
  });

  it("turn timeout while a pair is undefended triggers TAKE_PILE", () => {
    const { room, clock } = setupRoom(42);
    const state = room.currentState();
    if (!state || state.phase !== "in-round") throw new Error("expected in-round state");
    const attacker = state.attacker as SeatIndex;
    const card = state.hands[attacker]?.[0];
    if (!card) throw new Error("expected card");
    const r1 = room.applyAction(attacker, { type: "ATTACK", by: attacker, card });
    expect(r1.ok).toBe(true);
    const beforeTake = room.currentState();
    if (!beforeTake || beforeTake.phase !== "in-round") {
      throw new Error("expected in-round before timeout");
    }
    const defender = beforeTake.defender;
    expect(beforeTake.table.length).toBe(1);
    expect(clock.fire()).toBe(true);
    const afterTake = room.currentState();
    if (!afterTake || afterTake.phase !== "in-round") {
      throw new Error("expected in-round after timeout");
    }
    expect(afterTake.table.length).toBe(0);
    expect(afterTake.hands[defender]?.length ?? 0).toBe(
      (beforeTake.hands[defender]?.length ?? 0) + 1,
    );
  });

  it("synthesizeTimeoutAction returns null if there's nothing on the table", () => {
    const { room } = setupRoom(42);
    const state = room.currentState();
    if (!state) throw new Error("expected state");
    expect(synthesizeTimeoutAction(state)).toBeNull();
  });

  it("synthesizeTimeoutAction picks END_ROUND when all attacks are defended", () => {
    const { room } = setupRoom(42);
    const start = room.currentState();
    if (!start || start.phase !== "in-round") throw new Error("expected in-round");
    const attacker = start.attacker as SeatIndex;
    const defender = start.defender as SeatIndex;
    const attackerHand = start.hands[attacker] ?? [];
    const defenderHand = start.hands[defender] ?? [];
    let attackResult = null;
    let defendResult = null;
    for (const aCard of attackerHand) {
      const tryAttack = room.applyAction(attacker, { type: "ATTACK", by: attacker, card: aCard });
      if (!tryAttack.ok) continue;
      const stateAfter = room.currentState();
      if (!stateAfter || stateAfter.phase !== "in-round") continue;
      for (const dCard of defenderHand) {
        const tryDefend = room.applyAction(defender, {
          type: "DEFEND",
          by: defender,
          card: dCard,
          target: 0,
        });
        if (tryDefend.ok) {
          defendResult = tryDefend;
          attackResult = tryAttack;
          break;
        }
      }
      if (defendResult) break;
    }
    if (!attackResult || !defendResult) {
      return;
    }
    const after = room.currentState();
    if (!after || after.phase !== "in-round") throw new Error("expected in-round");
    const synth = synthesizeTimeoutAction(after);
    expect(synth?.type).toBe("END_ROUND");
  });
});
