import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createRng, rngFromState } from "./rng";

describe("createRng", () => {
  it("produces the same u32 sequence for the same seed", () => {
    const a = createRng(42);
    const b = createRng(42);
    const seqA = Array.from({ length: 100 }, () => a.next());
    const seqB = Array.from({ length: 100 }, () => b.next());
    expect(seqA).toEqual(seqB);
  });

  it("produces different sequences for different seeds", () => {
    const a = createRng(1);
    const b = createRng(2);
    const seqA = Array.from({ length: 16 }, () => a.next());
    const seqB = Array.from({ length: 16 }, () => b.next());
    expect(seqA).not.toEqual(seqB);
  });

  it("returns u32 values in [0, 2^32)", () => {
    const rng = createRng(123);
    for (let i = 0; i < 1000; i++) {
      const n = rng.next();
      expect(Number.isInteger(n)).toBe(true);
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThan(0x1_0000_0000);
    }
  });

  it("nextFloat returns values in [0, 1)", () => {
    const rng = createRng(7);
    for (let i = 0; i < 1000; i++) {
      const f = rng.nextFloat();
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThan(1);
    }
  });

  it("nextInt returns values in [0, max)", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1000 }), fc.integer(), (max, seed) => {
        const rng = createRng(seed);
        for (let i = 0; i < 200; i++) {
          const n = rng.nextInt(max);
          expect(Number.isInteger(n)).toBe(true);
          expect(n).toBeGreaterThanOrEqual(0);
          expect(n).toBeLessThan(max);
        }
      }),
      { numRuns: 50 },
    );
  });

  it("nextInt(1) is always 0", () => {
    const rng = createRng(99);
    for (let i = 0; i < 50; i++) {
      expect(rng.nextInt(1)).toBe(0);
    }
  });

  it("nextInt rejects non-positive or non-integer max", () => {
    const rng = createRng(0);
    expect(() => rng.nextInt(0)).toThrow(RangeError);
    expect(() => rng.nextInt(-1)).toThrow(RangeError);
    expect(() => rng.nextInt(1.5)).toThrow(RangeError);
  });

  it("createRng rejects non-integer seeds", () => {
    expect(() => createRng(1.2)).toThrow(TypeError);
    expect(() => createRng(Number.NaN)).toThrow(TypeError);
  });

  it("state is a 4-tuple of u32 values", () => {
    const rng = createRng(2026);
    expect(rng.state).toHaveLength(4);
    for (const word of rng.state) {
      expect(Number.isInteger(word)).toBe(true);
      expect(word).toBeGreaterThanOrEqual(0);
      expect(word).toBeLessThan(0x1_0000_0000);
    }
  });

  it("state snapshots are independent of subsequent advances", () => {
    const rng = createRng(2026);
    const snap = rng.state;
    const before = [snap[0], snap[1], snap[2], snap[3]];
    rng.next();
    rng.next();
    rng.next();
    expect([snap[0], snap[1], snap[2], snap[3]]).toEqual(before);
  });
});

describe("rngFromState", () => {
  it("resumes the exact sequence after serialization round-trip", () => {
    const rng = createRng(2026);
    for (let i = 0; i < 50; i++) {
      rng.next();
    }
    const snapshot = rng.state;
    const expected = Array.from({ length: 50 }, () => rng.next());

    const resumed = rngFromState(snapshot);
    const actual = Array.from({ length: 50 }, () => resumed.next());

    expect(actual).toEqual(expected);
  });

  it("survives JSON serialization", () => {
    const rng = createRng(2026);
    for (let i = 0; i < 10; i++) {
      rng.next();
    }
    const json = JSON.stringify(rng.state);
    const expected = Array.from({ length: 20 }, () => rng.next());

    const restored = rngFromState(JSON.parse(json));
    const actual = Array.from({ length: 20 }, () => restored.next());

    expect(actual).toEqual(expected);
  });
});

describe("Rng.clone", () => {
  it("produces an independent generator with the same future sequence", () => {
    const a = createRng(11);
    a.next();
    a.next();
    const b = a.clone();
    const seqA = Array.from({ length: 30 }, () => a.next());
    const seqB = Array.from({ length: 30 }, () => b.next());
    expect(seqA).toEqual(seqB);
  });

  it("does not advance the source when the clone is advanced", () => {
    const a = createRng(11);
    const b = a.clone();
    for (let i = 0; i < 10; i++) {
      b.next();
    }
    const stateA = a.state;
    const fresh = createRng(11).state;
    expect([stateA[0], stateA[1], stateA[2], stateA[3]]).toEqual([
      fresh[0],
      fresh[1],
      fresh[2],
      fresh[3],
    ]);
  });
});
