import { bot, type State } from "@durak/engine";
import type { ServerMessage } from "@durak/protocol";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { activeActorSeat, Room } from "./Room.js";

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

function inRound(state: State | null) {
  if (state === null || state.phase !== "in-round") {
    throw new Error(`expected in-round state, got ${state?.phase ?? "null"}`);
  }
  return state;
}

function playToCompletion(seed: number, opts: { iterationCap?: number } = {}): Room {
  const room = new Room({
    mode: "bot",
    botIterationCap: opts.iterationCap ?? 200,
  });
  room.addPlayer("human");
  room.start(seed);
  let safety = 0;
  while (room.currentState()?.phase === "in-round" && safety < 4000) {
    const state = inRound(room.currentState());
    if (activeActorSeat(state) !== 0) {
      throw new Error("bot driver should have flushed before yielding to human");
    }
    const action = bot.choose(state);
    const result = room.applyAction(0, action);
    if (!result.ok) throw new Error(`human action rejected: ${result.reason}`);
    safety++;
  }
  return room;
}

describe("Room: bot mode setup", () => {
  it("reserves seat 1 for the bot and exposes mode", () => {
    const room = new Room({ mode: "bot" });
    expect(room.mode).toBe("bot");
    expect(room.publicSeats()).toEqual([{ name: null }, { name: "Bot" }]);
  });

  it("places the human at seat 0 and reports both seats filled", () => {
    const room = new Room({ mode: "bot" });
    const human = room.addPlayer("alice");
    expect(human.seat).toBe(0);
    expect(room.bothSeatsFilled()).toBe(true);
  });

  it("rejects a second human in a bot room", () => {
    const room = new Room({ mode: "bot" });
    room.addPlayer("alice");
    expect(() => room.addPlayer("evil")).toThrow();
  });

  it("attachedSeatCount counts the bot as permanently attached", () => {
    const room = new Room({ mode: "bot" });
    expect(room.attachedSeatCount()).toBe(1);
    const human = room.addPlayer("alice");
    expect(room.attachedSeatCount()).toBe(1);
    room.attachClient(human.seat, { send: () => {}, close: () => {} });
    expect(room.attachedSeatCount()).toBe(2);
  });

  it("removePlayer cannot dislodge the bot from its seat", () => {
    const room = new Room({ mode: "bot" });
    const seats = room.publicSeats();
    expect(seats[1]?.name).toBe("Bot");
    expect(room.removePlayer("not-the-bot-token")).toBe(false);
    expect(room.publicSeats()[1]?.name).toBe("Bot");
  });

  it("defaults to mode 'human' when no mode is given", () => {
    const room = new Room();
    expect(room.mode).toBe("human");
    expect(room.publicSeats()).toEqual([{ name: null }, { name: null }]);
  });
});

describe("Room: bot driver", () => {
  it("starts the game and yields to the human as the active actor", () => {
    const room = new Room({ mode: "bot" });
    const human = room.addPlayer("alice");
    const client = fakeClient();
    room.attachClient(human.seat, client.handle);
    room.start(2026);
    const state = inRound(room.currentState());
    expect(activeActorSeat(state)).toBe(0);
    // The human always sees a snapshot+events pair plus zero or more bot
    // follow-up snapshot+events pairs (one per bot decision).
    expect(client.sent[0]?.type).toBe("Snapshot");
    expect(client.sent[1]?.type).toBe("Events");
    expect(client.sent.length % 2).toBe(0);
  });

  it("rejects an action submitted with the bot seat", () => {
    const room = new Room({ mode: "bot" });
    room.addPlayer("alice");
    room.start(2026);
    const result = room.applyAction(1, { type: "TAKE_PILE", by: 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("FORBIDDEN_ACTION");
  });

  it("plays a full 1v1 vs-bot game from a known seed to game-over", () => {
    const room = playToCompletion(2026);
    expect(room.currentState()?.phase).toBe("game-over");
  });

  it("delivers a GAME_OVER event to the human client when the game ends", () => {
    const room = new Room({ mode: "bot", botIterationCap: 200 });
    const human = room.addPlayer("alice");
    const client = fakeClient();
    room.attachClient(human.seat, client.handle);
    room.start(2026);
    let safety = 0;
    while (room.currentState()?.phase === "in-round" && safety < 4000) {
      const state = inRound(room.currentState());
      const action = bot.choose(state);
      const result = room.applyAction(0, action);
      if (!result.ok) throw new Error(`human action rejected: ${result.reason}`);
      safety++;
    }
    expect(room.currentState()?.phase).toBe("game-over");

    const gameOverEvents = client.sent.flatMap((msg) =>
      msg.type === "Events" ? msg.events.filter((e) => e.type === "GAME_OVER") : [],
    );
    expect(gameOverEvents).toHaveLength(1);
  });

  it("is byte-deterministic across runs for the same seed", () => {
    const a = playToCompletion(2026);
    const b = playToCompletion(2026);
    expect(JSON.stringify(a.currentState())).toBe(JSON.stringify(b.currentState()));
  });

  it("the human's snapshots only ever expose the human's own hand", () => {
    const room = new Room({ mode: "bot" });
    const human = room.addPlayer("alice");
    const client = fakeClient();
    room.attachClient(human.seat, client.handle);
    room.start(2026);
    let safety = 0;
    while (room.currentState()?.phase === "in-round" && safety < 4000) {
      const state = inRound(room.currentState());
      const action = bot.choose(state);
      room.applyAction(0, action);
      safety++;
    }
    const snapshots = client.sent.filter((m) => m.type === "Snapshot");
    expect(snapshots.length).toBeGreaterThan(0);
    for (const msg of snapshots) {
      if (msg.type !== "Snapshot") continue;
      expect(msg.snapshot.you.seat).toBe(0);
      expect(msg.snapshot.seat).toBe(0);
      // Snapshot type already excludes opponent hand and talon contents at
      // the type level; checking keys here defends against any future
      // accidental widening.
      const keys = Object.keys(msg.snapshot);
      expect(keys).not.toContain("hands");
      expect(keys).not.toContain("talon");
      expect(keys).not.toContain("rng");
    }
  });

  it("emits an Error and stops driving when the iteration cap is exceeded", () => {
    // Force the cap to 0 so the loop trips immediately on the bot's first
    // turn (the second seat is the bot, which often acts at start time).
    const room = new Room({ mode: "bot", botIterationCap: 0 });
    const human = room.addPlayer("alice");
    const client = fakeClient();
    room.attachClient(human.seat, client.handle);
    room.start(2026);
    const errors = client.sent.filter((m) => m.type === "Error");
    if (activeActorSeat(inRound(room.currentState())) === 1) {
      expect(errors.some((e) => e.type === "Error" && e.code === "BOT_LOOP_CAP")).toBe(true);
    }
  });
});

describe("Room: vs-bot completes for a wide range of seeds (property)", () => {
  it("any seed reaches game-over with the bot driver in finite steps", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 20000 }), (seed) => {
        const room = playToCompletion(seed);
        expect(room.currentState()?.phase).toBe("game-over");
      }),
      { numRuns: 50 },
    );
  });
});
