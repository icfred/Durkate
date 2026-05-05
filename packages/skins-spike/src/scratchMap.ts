import { Texture } from "pixi.js";
import { mulberry32 } from "./rng.js";

// Procedural scratch map: a single-channel texture where each pixel holds
// a wear "threshold" (0 = always worn, 1 = never worn). The pattern and
// foil shaders sample this map at the current uWear and reveal the
// per-pixel wear when wear ≥ threshold.
//
// Composing the map procedurally means the wear pattern feels organic —
// it's not just a uniform noise overlay. Layers from softest threshold
// (visible at low wear) to hardest:
//
//   1. Edge ramp: corners and edges have low thresholds, so they wear
//      first as the float climbs. Matches how real cards degrade.
//   2. Soft smudges: a few large blob regions with mid thresholds.
//   3. Long curved scratches: hand-traced lines at random angles, varying
//      lengths/widths and per-scratch thresholds.
//   4. Short scratches: smaller scuffs at random angles.
//   5. Point chips: single-pixel hits scattered across the surface.
//
// Each layer takes the per-pixel min threshold against what's already in
// the buffer, so deeper-cut scratches override softer wear underneath.

export const SCRATCH_W = 96;
export const SCRATCH_H = 144;

export function generateScratchMap(seed: number): Texture {
  const buf = new Uint8Array(SCRATCH_W * SCRATCH_H);
  // Initialize all pixels to "never worn" — pristine card.
  buf.fill(255);

  // Layer 1: edge wear ramp. Distance from the nearest x/y edge sets a
  // soft falloff; corners (small edge distance in BOTH axes) get the
  // worst wear via the max() proximity term.
  const cornerScale = 12;
  const edgeScale = 5;
  for (let y = 0; y < SCRATCH_H; y++) {
    for (let x = 0; x < SCRATCH_W; x++) {
      const dx = Math.min(x, SCRATCH_W - 1 - x);
      const dy = Math.min(y, SCRATCH_H - 1 - y);
      const minD = Math.min(dx, dy);
      const maxD = Math.max(dx, dy);
      const cornerProx = Math.max(0, 1 - maxD / cornerScale);
      const edgeProx = Math.max(0, 1 - minD / edgeScale);
      const wear = Math.max(edgeProx * 0.5, cornerProx * 0.85);
      const threshold = Math.max(0.04, 1 - wear * 0.92);
      const i = y * SCRATCH_W + x;
      buf[i] = Math.min(buf[i] ?? 255, Math.round(threshold * 255));
    }
  }

  const rng = mulberry32(seed);

  // Layer 2: soft smudges. Big blurry regions, gentle radial falloff.
  for (let i = 0; i < 6; i++) {
    const cx = Math.floor(rng() * SCRATCH_W);
    const cy = Math.floor(rng() * SCRATCH_H);
    const radius = 6 + Math.floor(rng() * 14);
    const threshold = 0.55 + rng() * 0.4;
    drawSmudge(buf, cx, cy, radius, threshold);
  }

  // Layer 3: long curved scratches. Sample positions along a curved
  // path (sine-modulated angle) so they don't all look perfectly
  // straight. Variable width.
  for (let i = 0; i < 26; i++) {
    const x0 = rng() * SCRATCH_W;
    const y0 = rng() * SCRATCH_H;
    const angle = rng() * Math.PI * 2;
    const length = 8 + Math.floor(rng() * 38);
    const curl = (rng() - 0.5) * 0.04;
    const width = rng() < 0.7 ? 1 : 2;
    const threshold = 0.18 + rng() * 0.65;
    drawScratch(buf, x0, y0, angle, length, curl, width, threshold);
  }

  // Layer 4: short scuff scratches.
  for (let i = 0; i < 60; i++) {
    const x0 = rng() * SCRATCH_W;
    const y0 = rng() * SCRATCH_H;
    const angle = rng() * Math.PI * 2;
    const length = 2 + Math.floor(rng() * 5);
    const threshold = 0.3 + rng() * 0.55;
    drawScratch(buf, x0, y0, angle, length, 0, 1, threshold);
  }

  // Layer 5: point chips (single-pixel hits).
  for (let i = 0; i < 140; i++) {
    const x = Math.floor(rng() * SCRATCH_W);
    const y = Math.floor(rng() * SCRATCH_H);
    const threshold = 0.3 + rng() * 0.6;
    const idx = y * SCRATCH_W + x;
    const t255 = Math.round(threshold * 255);
    if (t255 < (buf[idx] ?? 255)) buf[idx] = t255;
  }

  return uploadGrayscale(buf, SCRATCH_W, SCRATCH_H);
}

function drawScratch(
  buf: Uint8Array,
  x0: number,
  y0: number,
  angle: number,
  length: number,
  curl: number,
  width: number,
  threshold: number,
): void {
  const t255 = Math.round(threshold * 255);
  let a = angle;
  let x = x0;
  let y = y0;
  for (let s = 0; s < length; s++) {
    a += curl;
    x += Math.cos(a);
    y += Math.sin(a);
    for (let wy = 0; wy < width; wy++) {
      for (let wx = 0; wx < width; wx++) {
        const px = Math.round(x + wx);
        const py = Math.round(y + wy);
        if (px < 0 || px >= SCRATCH_W || py < 0 || py >= SCRATCH_H) continue;
        const idx = py * SCRATCH_W + px;
        if (t255 < (buf[idx] ?? 255)) buf[idx] = t255;
      }
    }
  }
}

function drawSmudge(
  buf: Uint8Array,
  cx: number,
  cy: number,
  radius: number,
  threshold: number,
): void {
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > radius) continue;
      const x = cx + dx;
      const y = cy + dy;
      if (x < 0 || x >= SCRATCH_W || y < 0 || y >= SCRATCH_H) continue;
      // Falloff from center: edge of smudge has higher (later) threshold
      const falloff = 1 - dist / radius;
      const localThreshold = Math.min(0.99, threshold + (1 - falloff) * 0.2);
      const idx = y * SCRATCH_W + x;
      const t255 = Math.round(localThreshold * 255);
      if (t255 < (buf[idx] ?? 255)) buf[idx] = t255;
    }
  }
}

function uploadGrayscale(buf: Uint8Array, w: number, h: number): Texture {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("scratchMap: 2d canvas context unavailable");
  const img = ctx.createImageData(w, h);
  for (let i = 0; i < w * h; i++) {
    const v = buf[i] ?? 255;
    img.data[i * 4] = v;
    img.data[i * 4 + 1] = v;
    img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const tex = Texture.from(canvas);
  // Linear sampling so wear edges anti-alias when the texture is
  // sampled at fractional UVs across the card (the card is rendered at
  // a different resolution from the scratch map's native size).
  tex.source.scaleMode = "linear";
  return tex;
}
