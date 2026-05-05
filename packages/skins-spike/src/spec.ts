import { fnv1a, mulberry32 } from "./rng.js";
import { defaultTunables, type SpecRanges } from "./tunables.js";

export type Finish = "matte" | "foil" | "chrome" | "holographic";

export const PATTERN_VARIANTS = 8;

export interface SkinSpec {
  pattern: { offsetX: number; offsetY: number; scale: number; index: number };
  tint: { hue: number; saturation: number; brightness: number };
  finish: Finish;
}

const FINISHES: readonly Finish[] = ["matte", "foil", "chrome", "holographic"];

export function decode(code: string, ranges: SpecRanges = defaultTunables.spec): SkinSpec {
  const rand = mulberry32(fnv1a(code));
  const offsetX = rand();
  const offsetY = rand();
  const scale = lerp(ranges.patternScale, rand());
  const index = Math.floor(rand() * PATTERN_VARIANTS);
  const hue = lerp(ranges.hue, rand());
  const saturation = lerp(ranges.saturation, rand());
  const brightness = lerp(ranges.brightness, rand());
  const finish = pick(FINISHES, rand());
  return {
    pattern: { offsetX, offsetY, scale, index },
    tint: { hue, saturation, brightness },
    finish,
  };
}

function lerp(range: readonly [number, number], t: number): number {
  return range[0] + (range[1] - range[0]) * t;
}

function pick<T>(values: readonly T[], r: number): T {
  const idx = Math.min(values.length - 1, Math.floor(r * values.length));
  const value = values[idx];
  if (value === undefined) throw new Error("pick: empty values");
  return value;
}
