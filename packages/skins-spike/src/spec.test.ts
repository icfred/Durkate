import { describe, expect, it } from "vitest";
import { isValidCode, rollCode } from "./code.js";
import { mulberry32 } from "./rng.js";
import { decode } from "./spec.js";

describe("rollCode", () => {
  it("produces valid 12-char hex strings", () => {
    const rand = mulberry32(42);
    for (let i = 0; i < 100; i += 1) {
      const code = rollCode(rand);
      expect(isValidCode(code)).toBe(true);
    }
  });

  it("is deterministic from seed", () => {
    const a = rollCode(mulberry32(1));
    const b = rollCode(mulberry32(1));
    expect(a).toBe(b);
  });
});

describe("decode", () => {
  it("is deterministic", () => {
    const a = decode("a1b2c3d4e5f6");
    const b = decode("a1b2c3d4e5f6");
    expect(a).toEqual(b);
  });

  it("produces different specs for different codes", () => {
    const a = decode("000000000000");
    const b = decode("ffffffffffff");
    expect(a).not.toEqual(b);
  });

  it("emits values in expected ranges", () => {
    const spec = decode("0123456789ab");
    expect(spec.pattern.offsetX).toBeGreaterThanOrEqual(0);
    expect(spec.pattern.offsetX).toBeLessThan(1);
    expect(spec.pattern.scale).toBeGreaterThanOrEqual(0.6);
    expect(spec.pattern.scale).toBeLessThan(2.21);
    expect(spec.tint.hue).toBeGreaterThanOrEqual(-1);
    expect(spec.tint.hue).toBeLessThan(1);
    expect(["matte", "silver", "gold", "bronze", "holographic"]).toContain(spec.finish);
  });
});
