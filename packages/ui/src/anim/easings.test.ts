import { describe, expect, it } from "vitest";
import {
  easeInOutCubic,
  easeInQuad,
  easeOutBack,
  easeOutQuad,
  easings,
  linear,
} from "./easings.js";

describe("easings", () => {
  const cases = [
    ["linear", linear],
    ["easeOutQuad", easeOutQuad],
    ["easeInQuad", easeInQuad],
    ["easeInOutCubic", easeInOutCubic],
    ["easeOutBack", easeOutBack],
  ] as const;

  for (const [name, fn] of cases) {
    it(`${name} hits 0 at t=0 and 1 at t=1`, () => {
      expect(fn(0)).toBeCloseTo(0, 6);
      expect(fn(1)).toBeCloseTo(1, 6);
    });
  }

  it("linear is the identity", () => {
    expect(linear(0.25)).toBe(0.25);
    expect(linear(0.5)).toBe(0.5);
  });

  it("easeOutQuad and easeInQuad mirror around the diagonal", () => {
    for (const t of [0.1, 0.3, 0.7, 0.9]) {
      expect(easeOutQuad(t) + easeInQuad(1 - t)).toBeCloseTo(1, 6);
    }
  });

  it("easeInOutCubic is symmetric around 0.5", () => {
    for (const t of [0.1, 0.25, 0.4]) {
      expect(easeInOutCubic(t) + easeInOutCubic(1 - t)).toBeCloseTo(1, 6);
    }
    expect(easeInOutCubic(0.5)).toBeCloseTo(0.5, 6);
  });

  it("easeOutBack overshoots above 1 before settling", () => {
    const peak = Math.max(easeOutBack(0.6), easeOutBack(0.7), easeOutBack(0.8));
    expect(peak).toBeGreaterThan(1);
  });

  it("easings record exposes every named easing", () => {
    expect(Object.keys(easings).sort()).toEqual(
      ["easeInOutCubic", "easeInQuad", "easeOutBack", "easeOutQuad", "linear"].sort(),
    );
  });
});
