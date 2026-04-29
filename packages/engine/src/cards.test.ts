import { describe, expect, it } from "vitest";
import { buildDeck, type Card, RANKS, SUITS } from "./cards";

describe("buildDeck", () => {
  it("returns 36 cards (4 suits x 9 ranks)", () => {
    const deck = buildDeck();
    expect(deck).toHaveLength(36);
  });

  it("contains every (suit, rank) pair exactly once", () => {
    const deck = buildDeck();
    const seen = new Set<string>();
    for (const card of deck) {
      seen.add(`${card.suit}-${card.rank}`);
    }
    expect(seen.size).toBe(36);
    for (const suit of SUITS) {
      for (const rank of RANKS) {
        expect(seen.has(`${suit}-${rank}`)).toBe(true);
      }
    }
  });

  it("uses ranks 6 through 14 (Ace high)", () => {
    expect([...RANKS]).toEqual([6, 7, 8, 9, 10, 11, 12, 13, 14]);
  });

  it("returns a fresh array on each call (no shared mutation)", () => {
    const a = buildDeck();
    const b = buildDeck();
    expect(a).not.toBe(b);
    a.length = 0;
    expect(b).toHaveLength(36);
  });

  it("produces structurally-equal cards on repeat builds", () => {
    const a = buildDeck();
    const b = buildDeck();
    const key = (c: Card) => `${c.suit}-${c.rank}`;
    expect(a.map(key)).toEqual(b.map(key));
  });
});
