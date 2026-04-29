import { describe, expect, it } from "vitest";
import { createRng } from "./rng";
import { initialState } from "./state";

describe("initialState", () => {
  it("returns a pre-deal state with a seeded rng snapshot", () => {
    const s = initialState({ seed: 42 });
    expect(s.phase).toBe("pre-deal");
    expect(s.playerCount).toBe(2);
    expect(s.rng).toEqual(createRng(42).state);
  });

  it("defaults playerCount to 2", () => {
    expect(initialState({ seed: 1 }).playerCount).toBe(2);
  });

  it("accepts an explicit playerCount", () => {
    expect(initialState({ seed: 1, playerCount: 3 }).playerCount).toBe(3);
  });

  it("rejects playerCount below 2 or non-integer", () => {
    expect(() => initialState({ seed: 1, playerCount: 1 })).toThrow(RangeError);
    expect(() => initialState({ seed: 1, playerCount: 2.5 })).toThrow(RangeError);
  });

  it("is JSON-serializable (no functions, no class instances)", () => {
    const s = initialState({ seed: 7 });
    const round = JSON.parse(JSON.stringify(s));
    expect(round).toEqual(s);
  });
});
