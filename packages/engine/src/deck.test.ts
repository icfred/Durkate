import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { buildDeck, type Card } from "./cards";
import { shuffle } from "./deck";
import { createRng } from "./rng";

const cardKey = (c: Card) => `${c.suit}-${c.rank}`;

describe("shuffle", () => {
  it("preserves all cards (permutation)", () => {
    const deck = buildDeck();
    const out = shuffle(deck, createRng(1));
    expect(out).toHaveLength(deck.length);
    expect(new Set(out.map(cardKey))).toEqual(new Set(deck.map(cardKey)));
  });

  it("does not mutate the input array", () => {
    const deck = buildDeck();
    const before = deck.map(cardKey);
    shuffle(deck, createRng(1));
    expect(deck.map(cardKey)).toEqual(before);
  });

  it("same seed yields same shuffled deck order", () => {
    const a = shuffle(buildDeck(), createRng(2026));
    const b = shuffle(buildDeck(), createRng(2026));
    expect(a.map(cardKey)).toEqual(b.map(cardKey));
  });

  it("different seeds yield different orders", () => {
    const a = shuffle(buildDeck(), createRng(1));
    const b = shuffle(buildDeck(), createRng(2));
    expect(a.map(cardKey)).not.toEqual(b.map(cardKey));
  });

  it("handles empty and single-element arrays", () => {
    expect(shuffle([], createRng(1))).toEqual([]);
    expect(shuffle(["only"], createRng(1))).toEqual(["only"]);
  });

  it("is a permutation for any seed (property)", () => {
    fc.assert(
      fc.property(fc.integer(), (seed) => {
        const deck = buildDeck();
        const out = shuffle(deck, createRng(seed));
        expect(out).toHaveLength(deck.length);
        expect(new Set(out.map(cardKey))).toEqual(new Set(deck.map(cardKey)));
      }),
      { numRuns: 50 },
    );
  });

  it("is deterministic across seeds (property)", () => {
    fc.assert(
      fc.property(fc.integer(), (seed) => {
        const a = shuffle(buildDeck(), createRng(seed));
        const b = shuffle(buildDeck(), createRng(seed));
        expect(a.map(cardKey)).toEqual(b.map(cardKey));
      }),
      { numRuns: 50 },
    );
  });
});
