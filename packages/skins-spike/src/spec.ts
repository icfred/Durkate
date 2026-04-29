import { fnv1a, mulberry32 } from "./rng.js";

export type Finish = "matte" | "foil" | "chrome" | "holographic";
export type Motion = "none" | "shimmer" | "pulse" | "drift";

export const PATTERN_VARIANTS = 8;

export interface SkinSpec {
  pattern: { offsetX: number; offsetY: number; scale: number; index: number };
  tint: { hue: number; saturation: number; brightness: number };
  finish: Finish;
  motion: Motion;
}

const FINISHES: readonly Finish[] = ["matte", "foil", "chrome", "holographic"];
const MOTIONS: readonly Motion[] = ["none", "shimmer", "pulse", "drift"];

export function decode(code: string): SkinSpec {
  const rand = mulberry32(fnv1a(code));
  const offsetX = rand();
  const offsetY = rand();
  const scale = 0.6 + rand() * 1.6;
  const index = Math.floor(rand() * PATTERN_VARIANTS);
  const hue = (rand() - 0.5) * 2;
  const saturation = 0.5 + rand();
  const brightness = 0.75 + rand() * 0.5;
  const finish = pick(FINISHES, rand());
  const motion = pick(MOTIONS, rand());
  return {
    pattern: { offsetX, offsetY, scale, index },
    tint: { hue, saturation, brightness },
    finish,
    motion,
  };
}

function pick<T>(values: readonly T[], r: number): T {
  const idx = Math.min(values.length - 1, Math.floor(r * values.length));
  const value = values[idx];
  if (value === undefined) throw new Error("pick: empty values");
  return value;
}
