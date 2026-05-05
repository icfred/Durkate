import { type Renderer, Texture } from "pixi.js";
import type { PatternBundle } from "./renderers/patternMesh.js";

// Procedural pattern shapes. Each generator emits THREE single-channel
// textures (no colors):
//
//   - height:     surface elevation per pixel
//   - regionId:   integer region index 0..7, encoded so the shader can
//                 recover via int(round(r * 7)). Sampled with NEAREST.
//   - finishMask: stencil for the metallic/holographic stamping
//
// Colors come from a Colorway picked at runtime (see colorway.ts) — the
// pattern shader does the palette lookup per-pixel using regionId. This
// means one shape × N colorways × M finishes = N*M visual results from
// a single set of textures.

export const PROC_TILE_PX = 48;
const N = PROC_TILE_PX;

// ---- Pixel helpers --------------------------------------------------------

function setHeight(buf: Uint8Array, x: number, y: number, h: number): void {
  buf[y * N + x] = Math.max(0, Math.min(255, Math.round(h * 255)));
}

function setFinishMask(buf: Uint8Array, x: number, y: number, m: number): void {
  buf[y * N + x] = Math.max(0, Math.min(255, Math.round(m * 255)));
}

function setRegion(buf: Uint8Array, x: number, y: number, region: number): void {
  // Encode 0..7 as 0..255 in even steps. Decode in shader as
  // int(round(r * 7.0)).
  const clamped = Math.max(0, Math.min(7, region | 0));
  buf[y * N + x] = Math.round((clamped / 7) * 255);
}

function hash2(x: number, y: number, seed: number): number {
  let h = seed | 0;
  h = Math.imul(h ^ (x | 0), 0x85ebca6b);
  h = Math.imul(h ^ (y | 0), 0xc2b2ae35);
  h ^= h >>> 16;
  return ((h >>> 0) % 100000) / 100000;
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

function tileValueNoise(x: number, y: number, period: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const wrap = (n: number) => ((n % period) + period) % period;
  const x0 = wrap(xi);
  const y0 = wrap(yi);
  const x1 = wrap(xi + 1);
  const y1 = wrap(yi + 1);
  const a = hash2(x0, y0, seed);
  const b = hash2(x1, y0, seed);
  const c = hash2(x0, y1, seed);
  const d = hash2(x1, y1, seed);
  const u = smooth(xf);
  const v = smooth(yf);
  return a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + d * u * v;
}

function tileFbm(x: number, y: number, basePeriod: number, seed: number, octaves = 4): number {
  let total = 0;
  let amp = 0.5;
  let freq = 1;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    total += tileValueNoise(x * freq, y * freq, basePeriod * freq, seed + i * 911) * amp;
    norm += amp;
    freq *= 2;
    amp *= 0.5;
  }
  return total / norm;
}

// ---- Texture upload -------------------------------------------------------

function uploadGrayscale(buf: Uint8Array): Texture {
  const canvas = document.createElement("canvas");
  canvas.width = N;
  canvas.height = N;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("proceduralPatterns: 2d canvas context unavailable");
  const img = ctx.createImageData(N, N);
  for (let i = 0; i < N * N; i++) {
    const v = buf[i] ?? 0;
    img.data[i * 4] = v;
    img.data[i * 4 + 1] = v;
    img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const tex = Texture.from(canvas);
  tex.source.scaleMode = "nearest";
  return tex;
}

function makeBundle(
  paint: (height: Uint8Array, regionId: Uint8Array, finishMask: Uint8Array) => void,
): PatternBundle {
  const heightBuf = new Uint8Array(N * N);
  const regionBuf = new Uint8Array(N * N);
  const finishMaskBuf = new Uint8Array(N * N);
  paint(heightBuf, regionBuf, finishMaskBuf);
  return {
    height: uploadGrayscale(heightBuf),
    regionId: uploadGrayscale(regionBuf),
    finishMask: uploadGrayscale(finishMaskBuf),
  };
}

// ---- Shape generators -----------------------------------------------------

function voronoiBundle(seed: number): PatternBundle {
  return makeBundle((height, regionId, finishMask) => {
    const cells = 6;
    const cellSize = N / cells;
    const wrap = (n: number) => ((n % cells) + cells) % cells;
    const seedAt = (cx: number, cy: number) => {
      const wx = wrap(cx);
      const wy = wrap(cy);
      const jx = hash2(wx, wy, seed);
      const jy = hash2(wx + 17, wy + 31, seed ^ 0xdeadbeef);
      return {
        x: (cx + jx) * cellSize,
        y: (cy + jy) * cellSize,
        id: wx * 31 + wy * 7,
      };
    };
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        let best = Number.POSITIVE_INFINITY;
        let secondBest = Number.POSITIVE_INFINITY;
        let bestId = 0;
        const cx = Math.floor(x / cellSize);
        const cy = Math.floor(y / cellSize);
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const s = seedAt(cx + dx, cy + dy);
            const ddx = s.x - x;
            const ddy = s.y - y;
            const d = ddx * ddx + ddy * ddy;
            if (d < best) {
              secondBest = best;
              best = d;
              bestId = s.id;
            } else if (d < secondBest) {
              secondBest = d;
            }
          }
        }
        const region = Math.floor(hash2(bestId, bestId * 13, seed + 99) * 8);
        setRegion(regionId, x, y, region);
        const edge = Math.sqrt(secondBest) - Math.sqrt(best);
        const h = Math.min(1, edge / (cellSize * 0.6));
        setHeight(height, x, y, h);
        const cellGloss = 0.4 + 0.6 * hash2(bestId, bestId * 7, seed + 211);
        setFinishMask(finishMask, x, y, h * cellGloss);
      }
    }
  });
}

function fbmMarbleBundle(seed: number): PatternBundle {
  return makeBundle((height, regionId, finishMask) => {
    const period = 4;
    const bands = 8;
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const u = (x / N) * period;
        const v = (y / N) * period;
        const n = tileFbm(u, v, period, seed, 4);
        let m = 0.5 + 0.5 * Math.sin((u + v) * 1.4 + n * 6.28);
        m = Math.max(0, Math.min(1, (m - 0.5) * 1.4 + 0.5));
        const region = Math.min(bands - 1, Math.floor(m * bands));
        setRegion(regionId, x, y, region);
        setHeight(height, x, y, n);
        setFinishMask(finishMask, x, y, m * m);
      }
    }
  });
}

function truchetBundle(seed: number): PatternBundle {
  return makeBundle((height, regionId, finishMask) => {
    const cells = 4;
    const cellSize = N / cells;
    // Background fill — region 0, no relief, no finish.
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        setRegion(regionId, x, y, 0);
        setHeight(height, x, y, 0);
        setFinishMask(finishMask, x, y, 0);
      }
    }
    for (let cy = 0; cy < cells; cy++) {
      for (let cx = 0; cx < cells; cx++) {
        const orient = hash2(cx, cy, seed) > 0.5 ? 0 : 1;
        const ox = cx * cellSize;
        const oy = cy * cellSize;
        const r = cellSize / 2;
        for (let py = 0; py < cellSize; py++) {
          for (let px = 0; px < cellSize; px++) {
            const ax = orient === 0 ? 0 : cellSize;
            const ay = 0;
            const bx2 = orient === 0 ? cellSize : 0;
            const by2 = cellSize;
            const d1 = Math.hypot(px - ax, py - ay);
            const d2 = Math.hypot(px - bx2, py - by2);
            const e = Math.min(Math.abs(d1 - r), Math.abs(d2 - r));
            // Region: 5 (highlight ring) on the arc band, 3 (mid) for the
            // wider halo, 0 (background) elsewhere.
            if (e < 0.6) setRegion(regionId, ox + px, oy + py, 5);
            else if (e < 1.6) setRegion(regionId, ox + px, oy + py, 3);
            const ridge = Math.exp(-(e * e) / 2.5);
            setHeight(height, ox + px, oy + py, ridge);
            setFinishMask(finishMask, ox + px, oy + py, ridge);
          }
        }
      }
    }
  });
}

function mazeBundle(seed: number): PatternBundle {
  return makeBundle((height, regionId, finishMask) => {
    const cells = 8;
    const cellSize = N / cells;
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        setRegion(regionId, x, y, 0); // floor
        setHeight(height, x, y, 0);
        setFinishMask(finishMask, x, y, 0);
      }
    }
    const knockNorth: boolean[] = [];
    for (let cy = 0; cy < cells; cy++) {
      for (let cx = 0; cx < cells; cx++) {
        knockNorth[cy * cells + cx] = hash2(cx, cy, seed) > 0.5;
      }
    }
    const t = Math.max(2, Math.floor(cellSize / 5));
    for (let cy = 0; cy < cells; cy++) {
      for (let cx = 0; cx < cells; cx++) {
        const idx = cy * cells + cx;
        const south = (cy + 1) % cells;
        const drawSouth = !knockNorth[south * cells + cx];
        const drawEast = knockNorth[idx];
        const x0 = cx * cellSize;
        const y0 = cy * cellSize;
        if (drawSouth) {
          for (let i = 0; i < cellSize; i++) {
            for (let j = 0; j < t; j++) {
              const px = x0 + i;
              const py = y0 + cellSize - 1 - j;
              // Region 7 for the wall top edge (uses palette[7]),
              // region 5 for the wall body.
              setRegion(regionId, px, py, j === 0 ? 7 : 5);
              setHeight(height, px, py, 1);
              setFinishMask(finishMask, px, py, j === 0 ? 0.85 : 0.5);
            }
          }
        }
        if (drawEast) {
          for (let i = 0; i < cellSize; i++) {
            for (let j = 0; j < t; j++) {
              const px = x0 + cellSize - 1 - j;
              const py = y0 + i;
              setRegion(regionId, px, py, j === 0 ? 7 : 5);
              setHeight(height, px, py, 1);
              setFinishMask(finishMask, px, py, j === 0 ? 0.85 : 0.5);
            }
          }
        }
      }
    }
  });
}

// ---- Public API -----------------------------------------------------------

interface ProceduralRecipe {
  name: string;
  seed: number;
  generator: (seed: number) => PatternBundle;
}

const RECIPES: readonly ProceduralRecipe[] = [
  { name: "voronoi-a", seed: 0xa17c, generator: voronoiBundle },
  { name: "fbm-a", seed: 0xb29d, generator: fbmMarbleBundle },
  { name: "truchet-a", seed: 0xc34e, generator: truchetBundle },
  { name: "maze-a", seed: 0xd45f, generator: mazeBundle },
  { name: "voronoi-b", seed: 0x217a, generator: voronoiBundle },
  { name: "fbm-b", seed: 0x32b8, generator: fbmMarbleBundle },
  { name: "truchet-b", seed: 0x43c1, generator: truchetBundle },
  { name: "maze-b", seed: 0x54d9, generator: mazeBundle },
];

export function generateProceduralPatterns(_renderer: Renderer): PatternBundle[] {
  return RECIPES.map((r) => r.generator(r.seed));
}
