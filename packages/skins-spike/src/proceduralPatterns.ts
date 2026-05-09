import { type Renderer, Texture } from "pixi.js";
import type { PatternBundle } from "./renderers/patternMesh.js";

// Procedural pattern shapes. Each generator emits THREE single-channel
// textures (no colors):
//
//   - height:     surface elevation per pixel
//   - regionId:   integer region index 1..7 (the visible palette range);
//                 NEVER 0 — palette[0] is reserved as the card's substrate
//                 colour, only revealed by wear. Encoded so the shader can
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
  // Encode 1..7 as 36..255 in even steps. Decode in shader as
  // int(round(r * 7.0)). Region 0 is reserved for wear/substrate; this
  // helper accepts 0 for callers that explicitly want the substrate
  // colour, but generators should only use 1..7 for visible regions.
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

// Map a hash value [0,1) to a region 1..7. ~55% of values map to
// region 1 (the muted card background) and ~45% to regions 2..7
// (vibrant accents). Biasing toward 1 keeps the dominant area of
// patterns like voronoi predictably muted, so glyph legibility holds
// across colorways and accent cells pop visually.
function regionFromHash(h: number): number {
  if (h < 0.55) return 1;
  return 2 + Math.floor(((h - 0.55) / 0.45) * 6);
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
        const region = regionFromHash(hash2(bestId, bestId * 13, seed + 99));
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
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const u = (x / N) * period;
        const v = (y / N) * period;
        const n = tileFbm(u, v, period, seed, 4);
        let m = 0.5 + 0.5 * Math.sin((u + v) * 1.4 + n * 6.28);
        m = Math.max(0, Math.min(1, (m - 0.5) * 1.4 + 0.5));
        const region = regionFromHash(m);
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
    // Background fill — region 1 = card body colour (muted, set by
    // the spec's cardBackground rather than the colorway). Most of
    // the truchet card paints with this; the arcs (regions 4 and 6)
    // are the colorway-driven accents.
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        setRegion(regionId, x, y, 1);
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
            if (e < 0.6) setRegion(regionId, ox + px, oy + py, 6);
            else if (e < 1.6) setRegion(regionId, ox + px, oy + py, 4);
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
    // Floor: region 1 = card body. Walls are colorway-driven accents
    // (regions 6/7).
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        setRegion(regionId, x, y, 1);
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
              setRegion(regionId, px, py, j === 0 ? 7 : 6);
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
              setRegion(regionId, px, py, j === 0 ? 7 : 6);
              setHeight(height, px, py, 1);
              setFinishMask(finishMask, px, py, j === 0 ? 0.85 : 0.5);
            }
          }
        }
      }
    }
  });
}

// Crackle: voronoi-like cells with thin dark borders (cracks) and
// brighter cell interiors. Reads as cracked porcelain or stained glass.
function crackleBundle(seed: number): PatternBundle {
  return makeBundle((height, regionId, finishMask) => {
    const cells = 5;
    const cellSize = N / cells;
    const wrap = (n: number) => ((n % cells) + cells) % cells;
    const seedAt = (cx: number, cy: number) => {
      const wx = wrap(cx);
      const wy = wrap(cy);
      const jx = hash2(wx, wy, seed);
      const jy = hash2(wx + 17, wy + 31, seed ^ 0xfeedface);
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
        const edge = Math.sqrt(secondBest) - Math.sqrt(best);
        // Crack width: pixels with edge < 1.2 are cracks (dark).
        if (edge < 1.2) {
          setRegion(regionId, x, y, 1); // crack uses dark palette slot
          setHeight(height, x, y, 0);
          setFinishMask(finishMask, x, y, 0);
        } else {
          // Cell interior — bright varied region. 2..7 range.
          const region = 2 + Math.floor(hash2(bestId, bestId * 17, seed + 33) * 6);
          setRegion(regionId, x, y, region);
          const interior = Math.min(1, (edge - 1.2) / (cellSize * 0.5));
          setHeight(height, x, y, 0.4 + 0.6 * interior);
          setFinishMask(finishMask, x, y, 0.5 + 0.5 * interior);
        }
      }
    }
  });
}

// Polka dots: regular grid of soft circles, each with a varied region.
function dotsBundle(seed: number): PatternBundle {
  return makeBundle((height, regionId, finishMask) => {
    const dots = 6;
    const cellSize = N / dots;
    const dotRadius = cellSize * 0.36;
    // Background: region 1 (card body colour). Dots are accents.
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        setRegion(regionId, x, y, 1);
        setHeight(height, x, y, 0);
        setFinishMask(finishMask, x, y, 0);
      }
    }
    for (let dy = 0; dy < dots; dy++) {
      for (let dx = 0; dx < dots; dx++) {
        const cx = (dx + 0.5) * cellSize;
        const cy = (dy + 0.5) * cellSize;
        // Each dot picks a region 3..7 from a hash, so neighbours don't
        // duplicate too predictably.
        const dotRegion = 3 + Math.floor(hash2(dx, dy, seed) * 5);
        for (let py = 0; py < cellSize; py++) {
          for (let px = 0; px < cellSize; px++) {
            const wx = dx * cellSize + px;
            const wy = dy * cellSize + py;
            const ddx = wx - cx;
            const ddy = wy - cy;
            const r = Math.hypot(ddx, ddy);
            if (r < dotRadius) {
              const t = 1 - r / dotRadius;
              setRegion(regionId, wx, wy, dotRegion);
              // Bell-shape height for raised dot.
              setHeight(height, wx, wy, smooth(t));
              setFinishMask(finishMask, wx, wy, t * t);
            }
          }
        }
      }
    }
  });
}

// Stripes: 4 alternating coloured diagonal stripes, with raised relief
// on alternating bands.
function stripesBundle(seed: number): PatternBundle {
  return makeBundle((height, regionId, finishMask) => {
    const stripes = 8; // number of stripes along the diagonal
    const palette = [3, 5, 4, 6, 2, 7, 3, 5]; // 8-stripe colour rotation
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const t = ((x + y) / N) * stripes;
        const stripeIdx = Math.floor(t) % stripes;
        const region = palette[stripeIdx] ?? 3;
        setRegion(regionId, x, y, region);
        // Soft height bump per stripe — cosine wave inside each stripe.
        const inStripe = t - Math.floor(t);
        const bump = Math.sin(inStripe * Math.PI);
        setHeight(height, x, y, bump * 0.7);
        // Even stripes are "metallic" (foil-stamped); odd are matte.
        setFinishMask(finishMask, x, y, stripeIdx % 2 === 0 ? bump * 0.8 : 0);
      }
    }
    // Suppress unused-arg warning for seed at lint time without
    // changing call shape.
    void seed;
  });
}

// Brick: horizontal courses of offset rectangles with mortar lines.
function brickBundle(seed: number): PatternBundle {
  return makeBundle((height, regionId, finishMask) => {
    const courses = 6; // rows of bricks
    const courseH = N / courses;
    const bricksPerRow = 4;
    const brickW = N / bricksPerRow;
    const mortar = 1.5; // px
    for (let y = 0; y < N; y++) {
      const courseIdx = Math.floor(y / courseH);
      const rowOffset = (courseIdx % 2) * (brickW / 2);
      for (let x = 0; x < N; x++) {
        const localY = y - courseIdx * courseH;
        const ox = x + rowOffset;
        const brickIdx = Math.floor(ox / brickW);
        const localX = ox - brickIdx * brickW;
        const onMortarV = localX < mortar || localX > brickW - mortar;
        const onMortarH = localY < mortar || localY > courseH - mortar;
        if (onMortarV || onMortarH) {
          // Mortar (region 1, dark filler)
          setRegion(regionId, x, y, 1);
          setHeight(height, x, y, 0);
          setFinishMask(finishMask, x, y, 0);
        } else {
          // Brick interior — varied region per brick
          const region = 2 + Math.floor(hash2(brickIdx, courseIdx, seed) * 6);
          setRegion(regionId, x, y, region);
          // Brick face slightly raised; subtle bevel toward edges
          const edgeX = Math.min(localX - mortar, brickW - mortar - localX);
          const edgeY = Math.min(localY - mortar, courseH - mortar - localY);
          const edge = Math.min(edgeX, edgeY);
          const bevel = Math.min(1, edge / 2);
          setHeight(height, x, y, 0.5 + 0.5 * bevel);
          // Brick faces are mostly smooth metal — finishMask 0.7..1.0
          // so the foil actually lands on them. Earlier 0.4*bevel
          // peaked below the gate threshold and the brick pattern
          // rendered with no foil at all.
          setFinishMask(finishMask, x, y, 0.7 + 0.3 * bevel);
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
  { name: "voronoi", seed: 0xa17c, generator: voronoiBundle },
  { name: "fbm", seed: 0xb29d, generator: fbmMarbleBundle },
  { name: "truchet", seed: 0xc34e, generator: truchetBundle },
  { name: "maze", seed: 0xd45f, generator: mazeBundle },
  { name: "crackle", seed: 0x217a, generator: crackleBundle },
  { name: "dots", seed: 0x32b8, generator: dotsBundle },
  { name: "stripes", seed: 0x43c1, generator: stripesBundle },
  { name: "brick", seed: 0x54d9, generator: brickBundle },
];

export function generateProceduralPatterns(_renderer: Renderer): PatternBundle[] {
  return RECIPES.map((r) => r.generator(r.seed));
}

/**
 * Human-readable pattern names in spec-index order. The tuner / sandbox
 * surfaces these instead of bare "P0".."PN" labels.
 */
export const PATTERN_NAMES: readonly string[] = RECIPES.map((r) => r.name);
