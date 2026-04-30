import { createRng, type InRoundState, initialState, step } from "@durak/engine";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  computeThinkDelay,
  countLegalActions,
  DIFFICULTY_SCALE,
  readThinkBoundsFromEnv,
  THINK_MAX_MS,
  THINK_MIN_MS,
} from "./bot-pacing.js";

function dealtState(seed: number): InRoundState {
  const init = initialState({ seed });
  const result = step(init, { type: "START_GAME" });
  if (!result.ok) throw new Error(`START_GAME failed: ${result.reason}`);
  if (result.state.phase !== "in-round") throw new Error("expected in-round");
  return result.state;
}

describe("computeThinkDelay bounds", () => {
  it("stays inside [min, max] * difficulty scale across many seeds and difficulties", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 20_000 }),
        fc.constantFrom("easy", "medium", "hard" as const),
        (seed, difficulty) => {
          const state = dealtState(seed);
          const seat = state.attacker;
          const ms = computeThinkDelay({ state, seat, difficulty });
          const lo = THINK_MIN_MS * DIFFICULTY_SCALE[difficulty];
          const hi = THINK_MAX_MS * DIFFICULTY_SCALE[difficulty];
          // Round-tolerant check: the function rounds, so a 0.5 spread is
          // possible at the boundaries.
          expect(ms).toBeGreaterThanOrEqual(Math.floor(lo));
          expect(ms).toBeLessThanOrEqual(Math.ceil(hi));
        },
      ),
      { numRuns: 200 },
    );
  });

  it("respects custom bounds", () => {
    const state = dealtState(2026);
    const ms = computeThinkDelay({
      state,
      seat: state.attacker,
      difficulty: "medium",
      bounds: { min: 100, max: 200 },
    });
    expect(ms).toBeGreaterThanOrEqual(100);
    expect(ms).toBeLessThanOrEqual(200);
  });

  it("collapses to 0 when bounds are 0", () => {
    const state = dealtState(2026);
    expect(
      computeThinkDelay({
        state,
        seat: state.attacker,
        difficulty: "hard",
        bounds: { min: 0, max: 0 },
      }),
    ).toBe(0);
  });
});

describe("computeThinkDelay determinism", () => {
  it("returns the same value for the same state + seat + difficulty", () => {
    const state = dealtState(42);
    const a = computeThinkDelay({ state, seat: state.attacker, difficulty: "medium" });
    const b = computeThinkDelay({ state, seat: state.attacker, difficulty: "medium" });
    expect(a).toBe(b);
  });

  it("does not mutate state.rng", () => {
    const state = dealtState(7);
    const before = [...state.rng] as const;
    computeThinkDelay({ state, seat: state.attacker, difficulty: "easy" });
    expect(state.rng).toEqual(before);
  });

  it("scales with difficulty (easy < medium < hard) for matched seeds", () => {
    // Picks the median delay across many seeds — the per-seed jitter can
    // permute neighboring difficulties, but the medians are well-separated.
    const seeds = Array.from({ length: 64 }, (_, i) => i + 1);
    const median = (xs: number[]): number => {
      const s = [...xs].sort((a, b) => a - b);
      return s[Math.floor(s.length / 2)] ?? 0;
    };
    const easy = median(
      seeds.map((seed) => {
        const st = dealtState(seed);
        return computeThinkDelay({ state: st, seat: st.attacker, difficulty: "easy" });
      }),
    );
    const medium = median(
      seeds.map((seed) => {
        const st = dealtState(seed);
        return computeThinkDelay({ state: st, seat: st.attacker, difficulty: "medium" });
      }),
    );
    const hard = median(
      seeds.map((seed) => {
        const st = dealtState(seed);
        return computeThinkDelay({ state: st, seat: st.attacker, difficulty: "hard" });
      }),
    );
    expect(easy).toBeLessThan(medium);
    expect(medium).toBeLessThan(hard);
  });
});

describe("countLegalActions", () => {
  it("counts hand size for an opening attack", () => {
    const state = dealtState(2026);
    const opener = countLegalActions(state, state.attacker);
    expect(opener).toBe(state.hands[state.attacker]?.length ?? 0);
  });

  it("returns 1 for the inactive seat (no real choice)", () => {
    const state = dealtState(2026);
    const inactive = state.attacker === 0 ? 1 : 0;
    expect(countLegalActions(state, inactive)).toBe(1);
  });

  it("counts 1 + defends when defender faces an undefended attack", () => {
    const state: InRoundState = {
      phase: "in-round",
      playerCount: 2,
      rng: createRng(1).state,
      hands: [
        [],
        [
          { suit: "spades", rank: 9 },
          { suit: "spades", rank: 11 },
          { suit: "hearts", rank: 6 },
        ],
      ],
      talon: [],
      trumpSuit: "hearts",
      trumpCard: null,
      table: [{ attack: { suit: "spades", rank: 8 } }],
      attacker: 0,
      defender: 1,
      discard: [],
    };
    // 9♠, 11♠, 6♥ all beat 8♠ (the trump beats anything non-trump). +1 for TAKE_PILE = 4.
    expect(countLegalActions(state, 1)).toBe(4);
  });
});

describe("readThinkBoundsFromEnv", () => {
  it("returns defaults when env is empty", () => {
    expect(readThinkBoundsFromEnv({})).toEqual({ min: THINK_MIN_MS, max: THINK_MAX_MS });
  });

  it("parses overrides", () => {
    expect(readThinkBoundsFromEnv({ BOT_THINK_MIN_MS: "100", BOT_THINK_MAX_MS: "200" })).toEqual({
      min: 100,
      max: 200,
    });
  });

  it("swaps min and max if the env order is inverted", () => {
    expect(readThinkBoundsFromEnv({ BOT_THINK_MIN_MS: "500", BOT_THINK_MAX_MS: "200" })).toEqual({
      min: 200,
      max: 500,
    });
  });

  it("ignores invalid values and falls back to defaults", () => {
    expect(readThinkBoundsFromEnv({ BOT_THINK_MIN_MS: "nope", BOT_THINK_MAX_MS: "" })).toEqual({
      min: THINK_MIN_MS,
      max: THINK_MAX_MS,
    });
  });

  it("treats 0/0 as a valid disable signal", () => {
    expect(readThinkBoundsFromEnv({ BOT_THINK_MIN_MS: "0", BOT_THINK_MAX_MS: "0" })).toEqual({
      min: 0,
      max: 0,
    });
  });
});
