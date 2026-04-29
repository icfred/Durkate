import { describe, expect, it } from "vitest";
import { TokenBucket } from "./rate-limit.js";

describe("TokenBucket", () => {
  it("allows up to capacity bursts then drops further attempts", () => {
    const now = 0;
    const bucket = new TokenBucket({
      capacity: 5,
      refillIntervalMs: 1000,
      now: () => now,
    });
    let allowed = 0;
    for (let i = 0; i < 10; i++) {
      if (bucket.tryConsume()) allowed += 1;
    }
    expect(allowed).toBe(5);
  });

  it("refills proportionally over time", () => {
    let now = 0;
    const bucket = new TokenBucket({
      capacity: 10,
      refillIntervalMs: 1000,
      now: () => now,
    });
    for (let i = 0; i < 10; i++) bucket.tryConsume();
    expect(bucket.tryConsume()).toBe(false);
    now = 500;
    let recovered = 0;
    while (bucket.tryConsume()) recovered += 1;
    expect(recovered).toBe(5);
  });

  it("does not refill past capacity even after a long quiet period", () => {
    let now = 0;
    const bucket = new TokenBucket({
      capacity: 4,
      refillIntervalMs: 100,
      now: () => now,
    });
    bucket.tryConsume();
    now = 1_000_000;
    let recovered = 0;
    while (bucket.tryConsume()) recovered += 1;
    expect(recovered).toBe(4);
  });

  it("rejects non-positive options", () => {
    expect(() => new TokenBucket({ capacity: 0, refillIntervalMs: 1000 })).toThrow(RangeError);
    expect(() => new TokenBucket({ capacity: 1, refillIntervalMs: 0 })).toThrow(RangeError);
  });
});
