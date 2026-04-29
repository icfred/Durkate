import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { Card } from "./cards";
import { type InRoundState, initialState } from "./state";
import { step } from "./step";

const cardKey = (c: Card) => `${c.suit}-${c.rank}`;

function deal(seed: number, playerCount = 2): InRoundState {
  const { state } = step(initialState({ seed, playerCount }), { type: "START_GAME" });
  if (state.phase !== "in-round") {
    throw new Error("expected in-round phase after START_GAME");
  }
  return state;
}

describe("step START_GAME", () => {
  it("deals 6 cards to each player", () => {
    const s = deal(2026, 2);
    expect(s.hands).toHaveLength(2);
    for (const hand of s.hands) {
      expect(hand).toHaveLength(6);
    }
  });

  it("sets the trump card and leaves talon size 36 - 6*N - 1", () => {
    const s = deal(2026, 2);
    expect(s.trump).toBeDefined();
    expect(s.talon).toHaveLength(36 - 6 * 2 - 1);
  });

  it("starts with empty table and discard", () => {
    const s = deal(2026, 2);
    expect(s.table).toEqual([]);
    expect(s.discard).toEqual([]);
  });

  it("picks the player with the lowest trump as attacker", () => {
    const s = deal(2026, 2);
    const trumps = s.hands.map((hand) =>
      hand.filter((c) => c.suit === s.trump.suit).map((c) => c.rank),
    );
    const lowestPerHand = trumps.map((ranks) =>
      ranks.length === 0 ? Number.POSITIVE_INFINITY : Math.min(...ranks),
    );
    const minRank = Math.min(...lowestPerHand);
    if (Number.isFinite(minRank)) {
      expect(lowestPerHand[s.attacker]).toBe(minRank);
    } else {
      expect(s.attacker).toBe(0);
    }
    expect(s.defender).toBe((s.attacker + 1) % s.playerCount);
  });

  it("emits a GAME_STARTED event with trump and attacker", () => {
    const init = initialState({ seed: 5, playerCount: 2 });
    const { state, events } = step(init, { type: "START_GAME" });
    if (state.phase !== "in-round") throw new Error();
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: "GAME_STARTED",
      trump: state.trump,
      attacker: state.attacker,
    });
  });

  it("advances the rng snapshot during the deal", () => {
    const init = initialState({ seed: 9 });
    const { state } = step(init, { type: "START_GAME" });
    expect(state.rng).not.toEqual(init.rng);
  });

  it("rejects START_GAME from a non-pre-deal phase", () => {
    const init = initialState({ seed: 1 });
    const { state } = step(init, { type: "START_GAME" });
    expect(() => step(state, { type: "START_GAME" })).toThrow();
  });

  it("rejects player counts that exceed deck capacity", () => {
    expect(() => deal(1, 6)).toThrow(RangeError);
  });

  it("produces a JSON-serializable state", () => {
    const s = deal(2026, 2);
    const round = JSON.parse(JSON.stringify(s));
    expect(round).toEqual(s);
  });

  it("conserves all 36 cards across hands, talon, and trump (property)", () => {
    fc.assert(
      fc.property(fc.integer(), (seed) => {
        const s = deal(seed, 2);
        const all = [...s.hands.flat(), ...s.talon, s.trump];
        expect(all).toHaveLength(36);
        expect(new Set(all.map(cardKey)).size).toBe(36);
      }),
      { numRuns: 100 },
    );
  });

  it("is deterministic for the same seed (property)", () => {
    fc.assert(
      fc.property(fc.integer(), (seed) => {
        const a = deal(seed, 2);
        const b = deal(seed, 2);
        expect(a).toEqual(b);
      }),
      { numRuns: 100 },
    );
  });
});
