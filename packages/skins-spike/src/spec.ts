import { CARD_BACKGROUND_COUNT } from "./cardBackgrounds.js";
import { COLORWAY_COUNT } from "./colorway.js";
import { fnv1a, mulberry32 } from "./rng.js";
import { defaultTunables, type SpecRanges } from "./tunables.js";

export type Finish = "matte" | "silver" | "gold" | "bronze" | "holographic";

export const PATTERN_VARIANTS = 8;

export interface SkinSpec {
  pattern: { offsetX: number; offsetY: number; scale: number; index: number };
  /** Index into SkinAssets.cardBackgrounds. The dominant card body colour. */
  cardBackground: number;
  /** Index into SkinAssets.colorways. Picks the palette for accent regions. */
  colorway: number;
  tint: { hue: number; saturation: number; brightness: number };
  finish: Finish;
}

const FINISHES: readonly Finish[] = ["matte", "silver", "gold", "bronze", "holographic"];

export function decode(code: string, ranges: SpecRanges = defaultTunables.spec): SkinSpec {
  const rand = mulberry32(fnv1a(code));
  const offsetX = rand();
  const offsetY = rand();
  const scale = lerp(ranges.patternScale, rand());
  const index = Math.floor(rand() * PATTERN_VARIANTS);
  const cardBackground = Math.floor(rand() * CARD_BACKGROUND_COUNT);
  const colorway = Math.floor(rand() * COLORWAY_COUNT);
  const hue = lerp(ranges.hue, rand());
  const saturation = lerp(ranges.saturation, rand());
  const brightness = lerp(ranges.brightness, rand());
  const finish = pick(FINISHES, rand());
  return {
    pattern: { offsetX, offsetY, scale, index },
    cardBackground,
    colorway,
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
