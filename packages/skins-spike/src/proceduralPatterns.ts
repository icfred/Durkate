import { type Renderer, Texture } from "pixi.js";

// Procedural pattern tiles. Each generator paints a TILE_PX × TILE_PX RGBA
// buffer pixel-by-pixel from a deterministic seed, uploaded once via a
// canvas → Texture.from(). Patterns are designed to seam at all four edges
// so TilingSprite repetition reads as a continuous surface, not a stamp.
//
// Why canvas + ImageData rather than Graphics.rect().fill()? With ~1000
// single-pixel rect fills per tile, Pixi's Graphics tessellator drops most
// of the rects (verified empirically — output texture came back almost
// blank). ImageData gives us pixel-perfect control with no rasterizer in
// the middle, which is what procedural pixel art actually wants.

export const PROC_TILE_PX = 48;
const N = PROC_TILE_PX;

type Palette = readonly number[];

const PALETTES: Record<string, Palette> = {
  ocean: [0x0b1d2a, 0x1a4c6e, 0x2d8aa8, 0x6cd4ff, 0xffd166],
  copper: [0x1a0f08, 0x6e3a1c, 0xb86a32, 0xeaa75e, 0xfff1d0],
  forest: [0x0f1a14, 0x2a4a2e, 0x5b8c3e, 0xa3c46b, 0xe8e0a8],
  cyber: [0x07021a, 0x2a0a4a, 0x6b1aa8, 0xff37c8, 0x42f5b8],
};

// ---- Pixel helpers --------------------------------------------------------

function setPixel(data: Uint8ClampedArray, x: number, y: number, color: number, alpha = 255): void {
  const i = (y * N + x) * 4;
  data[i] = (color >> 16) & 0xff;
  data[i + 1] = (color >> 8) & 0xff;
  data[i + 2] = color & 0xff;
  data[i + 3] = alpha;
}

function scaleColor(color: number, k: number): number {
  const r = Math.max(0, Math.min(255, Math.round(((color >> 16) & 0xff) * k)));
  const g = Math.max(0, Math.min(255, Math.round(((color >> 8) & 0xff) * k)));
  const b = Math.max(0, Math.min(255, Math.round((color & 0xff) * k)));
  return (r << 16) | (g << 8) | b;
}

function paletteAt(palette: Palette, t: number): number {
  const idx = Math.max(0, Math.min(palette.length - 1, Math.floor(t * palette.length)));
  return palette[idx] ?? 0xffffff;
}

// Integer hash, returns [0, 1).
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

// Tileable value noise: hash grid coordinates wrap by `period`.
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

function makeTexture(painter: (data: Uint8ClampedArray) => void): Texture {
  const canvas = document.createElement("canvas");
  canvas.width = N;
  canvas.height = N;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("proceduralPatterns: 2d canvas context unavailable");
  const img = ctx.createImageData(N, N);
  painter(img.data);
  ctx.putImageData(img, 0, 0);
  return Texture.from(canvas);
}

// ---- Generators -----------------------------------------------------------

function voronoiTexture(seed: number, palette: Palette): Texture {
  return makeTexture((data) => {
    const cells = 6; // 6×6 = 36 cells across the tile
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
        // Edge: sqrt(d2) - sqrt(d1). Small near borders, large at centers.
        const edge = Math.sqrt(secondBest) - Math.sqrt(best);
        // Pick a color from the palette per cell id, with a per-id slight
        // brightness jitter so neighboring cells of the same palette index
        // still read as separate.
        const tCol = hash2(bestId, bestId * 13, seed + 99);
        const baseColor = paletteAt(palette, tCol);
        // Fake bevel: bright cell interior, dark outline along the border,
        // and a thin highlight band 1 pixel inside the border.
        let color: number;
        if (edge < 0.7) {
          // Outline.
          color = scaleColor(baseColor, 0.25);
        } else if (edge < 1.6) {
          // Highlight band.
          color = scaleColor(baseColor, 1.15);
        } else {
          // Cell body — slightly darken the deeper toward center for shading.
          const k = 0.85 + 0.15 * Math.min(1, edge / 4);
          color = scaleColor(baseColor, k);
        }
        setPixel(data, x, y, color);
      }
    }
  });
}

function fbmMarbleTexture(seed: number, palette: Palette): Texture {
  return makeTexture((data) => {
    const period = 4;
    const bands = palette.length;
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const u = (x / N) * period;
        const v = (y / N) * period;
        const n = tileFbm(u, v, period, seed, 4);
        // Marble: turbulent sin warp on top of fbm so contour lines bend.
        let m = 0.5 + 0.5 * Math.sin((u + v) * 1.4 + n * 6.28);
        // Boost contrast.
        m = Math.max(0, Math.min(1, (m - 0.5) * 1.4 + 0.5));
        const band = Math.floor(m * bands) / bands;
        setPixel(data, x, y, paletteAt(palette, band));
      }
    }
  });
}

function truchetTexture(seed: number, palette: Palette): Texture {
  return makeTexture((data) => {
    const cells = 4; // 4×4 = 16 truchet cells per tile
    const cellSize = N / cells;
    const bg = paletteAt(palette, 0.0);
    const mid = paletteAt(palette, 0.5);
    const fg = paletteAt(palette, 0.85);
    const accent = paletteAt(palette, 1.0);
    // Background fill.
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) setPixel(data, x, y, bg);
    }
    for (let cy = 0; cy < cells; cy++) {
      for (let cx = 0; cx < cells; cx++) {
        const orient = hash2(cx, cy, seed) > 0.5 ? 0 : 1;
        const ox = cx * cellSize;
        const oy = cy * cellSize;
        const r = cellSize / 2;
        for (let py = 0; py < cellSize; py++) {
          for (let px = 0; px < cellSize; px++) {
            // Two anchor corners depending on orientation.
            const ax = orient === 0 ? 0 : cellSize;
            const ay = 0;
            const bx2 = orient === 0 ? cellSize : 0;
            const by2 = cellSize;
            const d1 = Math.hypot(px - ax, py - ay);
            const d2 = Math.hypot(px - bx2, py - by2);
            const e1 = Math.abs(d1 - r);
            const e2 = Math.abs(d2 - r);
            const e = Math.min(e1, e2);
            let color = bg;
            if (e < 0.6) color = accent;
            else if (e < 1.6) color = fg;
            else if (e < 3.0) color = mid;
            setPixel(data, ox + px, oy + py, color);
          }
        }
      }
    }
  });
}

function mazeTexture(seed: number, palette: Palette): Texture {
  return makeTexture((data) => {
    const cells = 8; // 8×8 maze cells
    const cellSize = N / cells;
    const bg = paletteAt(palette, 0.0);
    const wallA = paletteAt(palette, 0.7);
    const wallB = paletteAt(palette, 0.95);
    const dot = paletteAt(palette, 0.55);
    // Background.
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) setPixel(data, x, y, bg);
    }
    // Binary-tree carving: each cell knocks either north or east.
    const knockNorth: boolean[] = [];
    for (let cy = 0; cy < cells; cy++) {
      for (let cx = 0; cx < cells; cx++) {
        knockNorth[cy * cells + cx] = hash2(cx, cy, seed) > 0.5;
      }
    }
    for (let cy = 0; cy < cells; cy++) {
      for (let cx = 0; cx < cells; cx++) {
        const idx = cy * cells + cx;
        const south = (cy + 1) % cells;
        const drawSouth = !knockNorth[south * cells + cx];
        const drawEast = knockNorth[idx];
        const x0 = cx * cellSize;
        const y0 = cy * cellSize;
        // Wall thickness scales with cellSize, with a 1-px highlight on the
        // side that faces "inside" the cell.
        const t = Math.max(1, Math.floor(cellSize / 6));
        if (drawSouth) {
          for (let i = 0; i < cellSize; i++) {
            for (let j = 0; j < t; j++) {
              setPixel(data, x0 + i, y0 + cellSize - 1 - j, j === 0 ? wallB : wallA);
            }
          }
        }
        if (drawEast) {
          for (let i = 0; i < cellSize; i++) {
            for (let j = 0; j < t; j++) {
              setPixel(data, x0 + cellSize - 1 - j, y0 + i, j === 0 ? wallB : wallA);
            }
          }
        }
        // Center accent dot.
        const dx = x0 + Math.floor(cellSize / 2);
        const dy = y0 + Math.floor(cellSize / 2);
        setPixel(data, dx, dy, dot);
      }
    }
  });
}

// ---- Public API -----------------------------------------------------------

interface ProceduralRecipe {
  name: string;
  seed: number;
  generator: (seed: number, palette: Palette) => Texture;
  palette: Palette;
}

const RECIPES: readonly ProceduralRecipe[] = [
  { name: "voronoi-ocean", seed: 0xa17c, generator: voronoiTexture, palette: PALETTES.ocean ?? [] },
  { name: "fbm-copper", seed: 0xb29d, generator: fbmMarbleTexture, palette: PALETTES.copper ?? [] },
  {
    name: "truchet-cyber",
    seed: 0xc34e,
    generator: truchetTexture,
    palette: PALETTES.cyber ?? [],
  },
  { name: "maze-forest", seed: 0xd45f, generator: mazeTexture, palette: PALETTES.forest ?? [] },
];

export function generateProceduralPatterns(_renderer: Renderer): Texture[] {
  return RECIPES.map((r) => r.generator(r.seed, r.palette));
}
