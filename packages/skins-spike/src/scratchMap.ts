import { Texture } from "pixi.js";
import { mulberry32 } from "./rng.js";

// Procedural scratch map: a single-channel texture where each pixel holds
// a wear "threshold" (0 = always worn, 1 = never worn). The pattern and
// foil shaders sample this map at the current uWear and reveal the
// per-pixel wear when wear ≥ threshold.
//
// Wear progression should feel smooth — incrementing the FLOAT slider
// from 0.3 to 0.9 should reveal a steady cascade of new damage, not a
// single jump. We achieve this with three threshold sources combined
// via per-pixel min:
//
//   1. Continuous fbm-noise grit. Spans the full [0.30, 0.98] range
//      uniformly so every wear value reveals roughly evenly-distributed
//      new dust speckles. This carries the "background degradation"
//      that fills the gap between discrete events.
//   2. Spatial edge ramp. Corners and edges get the lowest thresholds
//      (wear first) for realistic edge fraying.
//   3. Discrete events: smudges, long curved scratches, short scuffs,
//      diagonal swipes, point chips. Each event has its own threshold
//      so it appears at a specific wear level — drama on top of the
//      smooth background grit.

export const SCRATCH_W = 96;
export const SCRATCH_H = 144;

export function generateScratchMap(seed: number): Texture {
  const buf = new Uint8Array(SCRATCH_W * SCRATCH_H);
  buf.fill(255);

  const rng = mulberry32(seed);

  // Layer 1: edge ramp. Corners worst, edges next, interior safest.
  const cornerScale = 14;
  const edgeScale = 6;
  for (let y = 0; y < SCRATCH_H; y++) {
    for (let x = 0; x < SCRATCH_W; x++) {
      const dx = Math.min(x, SCRATCH_W - 1 - x);
      const dy = Math.min(y, SCRATCH_H - 1 - y);
      const minD = Math.min(dx, dy);
      const maxD = Math.max(dx, dy);
      const cornerProx = Math.max(0, 1 - maxD / cornerScale);
      const edgeProx = Math.max(0, 1 - minD / edgeScale);
      const wear = Math.max(edgeProx * 0.55, cornerProx * 0.92);
      const threshold = Math.max(0.03, 1 - wear * 0.95);
      const i = y * SCRATCH_W + x;
      buf[i] = Math.min(buf[i] ?? 255, Math.round(threshold * 255));
    }
  }

  // Layer 2: continuous fbm-noise grit. Spreads thresholds uniformly
  // across [0.30, 0.98] so wear feels like a real surface degrading
  // rather than a few discrete elements popping in. Multi-octave noise
  // gives texture variation at multiple scales.
  const fbmSeed = (seed ^ 0x533d_5234) >>> 0;
  const noiseRng = mulberry32(fbmSeed);
  // Bake a small 32x48 noise table and bilinear-sample for smooth
  // multi-scale variation.
  const noiseW = 32;
  const noiseH = 48;
  const noiseTable: number[] = [];
  for (let i = 0; i < noiseW * noiseH; i++) noiseTable.push(noiseRng());
  for (let y = 0; y < SCRATCH_H; y++) {
    for (let x = 0; x < SCRATCH_W; x++) {
      const u = (x / SCRATCH_W) * noiseW;
      const v = (y / SCRATCH_H) * noiseH;
      const value = sampleFbm(noiseTable, noiseW, noiseH, u, v);
      // Map fbm [0..1] to threshold [0.30..0.98]. Lower thresholds
      // mean the pixel "wears in" earlier as the float climbs.
      const threshold = 0.3 + value * 0.68;
      const i = y * SCRATCH_W + x;
      const t255 = Math.round(threshold * 255);
      if (t255 < (buf[i] ?? 255)) buf[i] = t255;
    }
  }

  // Layer 3: smudges. Soft regional dirty patches.
  for (let i = 0; i < 10; i++) {
    const cx = Math.floor(rng() * SCRATCH_W);
    const cy = Math.floor(rng() * SCRATCH_H);
    const radius = 6 + Math.floor(rng() * 16);
    const threshold = 0.45 + rng() * 0.45;
    drawSmudge(buf, cx, cy, radius, threshold);
  }

  // Layer 4: long curved scratches. Threshold spans 0.10..0.85 so the
  // first few appear quite early (light wear) and the rest fill in as
  // wear rises.
  for (let i = 0; i < 38; i++) {
    const x0 = rng() * SCRATCH_W;
    const y0 = rng() * SCRATCH_H;
    const angle = rng() * Math.PI * 2;
    const length = 8 + Math.floor(rng() * 42);
    const curl = (rng() - 0.5) * 0.05;
    const width = rng() < 0.65 ? 1 : 2;
    const threshold = 0.1 + rng() * 0.75;
    drawScratch(buf, x0, y0, angle, length, curl, width, threshold);
  }

  // Layer 5: short scuff scratches. Lots of these for granular variety.
  for (let i = 0; i < 110; i++) {
    const x0 = rng() * SCRATCH_W;
    const y0 = rng() * SCRATCH_H;
    const angle = rng() * Math.PI * 2;
    const length = 2 + Math.floor(rng() * 6);
    const threshold = 0.2 + rng() * 0.7;
    drawScratch(buf, x0, y0, angle, length, 0, 1, threshold);
  }

  // Layer 6: diagonal swipes. Long thin one-pixel scuffs at consistent
  // angles, like the card was dragged across a surface a few times.
  for (let i = 0; i < 14; i++) {
    const angle = (rng() - 0.5) * 0.4 + Math.PI * 0.25; // around +45° ± 22°
    const x0 = rng() * SCRATCH_W;
    const y0 = rng() * SCRATCH_H;
    const length = 30 + Math.floor(rng() * 50);
    const threshold = 0.4 + rng() * 0.45;
    drawScratch(buf, x0, y0, angle, length, 0, 1, threshold);
  }

  // Layer 7: point chips. Heavy density.
  for (let i = 0; i < 280; i++) {
    const x = Math.floor(rng() * SCRATCH_W);
    const y = Math.floor(rng() * SCRATCH_H);
    const threshold = 0.15 + rng() * 0.8;
    const idx = y * SCRATCH_W + x;
    const t255 = Math.round(threshold * 255);
    if (t255 < (buf[idx] ?? 255)) buf[idx] = t255;
  }

  return uploadGrayscale(buf, SCRATCH_W, SCRATCH_H);
}

// Smooth-sample a small noise table with two-octave fbm. Wraps so the
// scratch map can be tiled if we ever want to. Output range is [0, 1].
function sampleFbm(table: number[], w: number, h: number, u: number, v: number): number {
  let total = 0;
  let amp = 0.5;
  let freq = 1;
  let norm = 0;
  for (let i = 0; i < 3; i++) {
    total += sampleBilinear(table, w, h, u * freq, v * freq) * amp;
    norm += amp;
    freq *= 2;
    amp *= 0.5;
  }
  return total / norm;
}

function sampleBilinear(table: number[], w: number, h: number, u: number, v: number): number {
  const wrap = (n: number, m: number) => ((n % m) + m) % m;
  const x0 = Math.floor(u);
  const y0 = Math.floor(v);
  const x1 = x0 + 1;
  const y1 = y0 + 1;
  const tx = u - x0;
  const ty = v - y0;
  const ix0 = wrap(x0, w);
  const iy0 = wrap(y0, h);
  const ix1 = wrap(x1, w);
  const iy1 = wrap(y1, h);
  const a = table[iy0 * w + ix0] ?? 0;
  const b = table[iy0 * w + ix1] ?? 0;
  const c = table[iy1 * w + ix0] ?? 0;
  const d = table[iy1 * w + ix1] ?? 0;
  const sx = tx * tx * (3 - 2 * tx);
  const sy = ty * ty * (3 - 2 * ty);
  return a * (1 - sx) * (1 - sy) + b * sx * (1 - sy) + c * (1 - sx) * sy + d * sx * sy;
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
  tex.source.scaleMode = "linear";
  return tex;
}
