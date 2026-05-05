import { Graphics, Rectangle, type Renderer, type Texture } from "pixi.js";

// Procedural pattern tiles. Each generator paints a TILE_PX × TILE_PX texture
// pixel-by-pixel using a deterministic seed; the resulting tile is fed into
// the same TilingSprite the bitmap patterns use. Patterns are designed to
// seam at all four edges so TilingSprite repetition reads as a continuous
// surface rather than a stamp.

export const PROC_TILE_PX = 32;
const N = PROC_TILE_PX;

// Small palette per pattern. Colors are picked saturated so they survive
// the 0.55 overlay-alpha blend over the cream card surface.
type Palette = readonly number[];

const PALETTES: Record<string, Palette> = {
  ocean: [0x0b1d2a, 0x1a4c6e, 0x2d8aa8, 0x6cd4ff, 0xffd166],
  copper: [0x2b1810, 0x6e3a1c, 0xb86a32, 0xeaa75e, 0xfff1d0],
  forest: [0x0f1a14, 0x2a4a2e, 0x5b8c3e, 0xa3c46b, 0xe8e0a8],
  cyber: [0x07021a, 0x2a0a4a, 0x6b1aa8, 0xff37c8, 0x42f5b8],
};

function paint(g: Graphics, x: number, y: number, color: number, alpha = 1): void {
  g.rect(x, y, 1, 1).fill({ color, alpha });
}

// Integer hash. Returns [0, 1).
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

// Tileable value noise on a torus: sample inside a unit cell, mirror at edges
// by wrapping the integer grid coordinate via modulo. Period equals `period`.
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

function paletteAt(palette: Palette, t: number): number {
  const idx = Math.max(0, Math.min(palette.length - 1, Math.floor(t * palette.length)));
  return palette[idx] ?? 0xffffff;
}

// ---- Generators ------------------------------------------------------------

function voronoiTile(seed: number, palette: Palette): Graphics {
  const g = new Graphics();
  // Seed positions on a 4×4 cell grid with jitter. Cell coordinates wrap so
  // points at the edge of the tile reach across the seam.
  const cells = 4;
  const cellSize = N / cells;
  const wrap = (n: number) => ((n % cells) + cells) % cells;
  const seedAt = (cx: number, cy: number): { x: number; y: number; id: number } => {
    const wx = wrap(cx);
    const wy = wrap(cy);
    const jx = hash2(wx, wy, seed);
    const jy = hash2(wx + 17, wy + 31, seed);
    return {
      x: (cx + jx) * cellSize,
      y: (cy + jy) * cellSize,
      id: wx * 13 + wy * 7,
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
          const dist = ddx * ddx + ddy * ddy;
          if (dist < best) {
            secondBest = best;
            best = dist;
            bestId = s.id;
          } else if (dist < secondBest) {
            secondBest = dist;
          }
        }
      }
      // Edge falloff: cells get darker toward their borders, like the
      // reference image's "shards with depth" feel.
      const edge = Math.sqrt(secondBest) - Math.sqrt(best);
      const depth = 1 - Math.exp(-edge * 0.6);
      // Cell color from palette by id, then darken near edges.
      const base = paletteAt(palette, hash2(bestId, bestId, seed + 99));
      const k = 0.35 + 0.65 * depth;
      const r = Math.round(((base >> 16) & 0xff) * k);
      const gC = Math.round(((base >> 8) & 0xff) * k);
      const b = Math.round((base & 0xff) * k);
      paint(g, x, y, (r << 16) | (gC << 8) | b);
    }
  }
  return g;
}

function fbmMarbleTile(seed: number, palette: Palette): Graphics {
  const g = new Graphics();
  const period = 4;
  const bands = palette.length;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const u = (x / N) * period;
      const v = (y / N) * period;
      let n = tileFbm(u, v, period, seed, 4);
      // Marble: turbulent sin warp on top of fbm.
      n = 0.5 + 0.5 * Math.sin((u + v) * 1.3 + n * 6.28);
      // Posterize to bands so it reads as quantized rather than smooth.
      const band = Math.floor(n * bands) / bands;
      paint(g, x, y, paletteAt(palette, band));
    }
  }
  return g;
}

function truchetArcsTile(seed: number, palette: Palette): Graphics {
  const g = new Graphics();
  // 4 cells per side, each cell gets one of 2 quarter-arc orientations.
  // Drawn as concentric arcs of varying ink color so the curves carry
  // palette variety, not just on/off.
  const cells = 4;
  const cellSize = N / cells;
  const fg = paletteAt(palette, 0.85);
  const mid = paletteAt(palette, 0.5);
  const bg = paletteAt(palette, 0.15);
  // Background fill.
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      paint(g, x, y, bg);
    }
  }
  for (let cy = 0; cy < cells; cy++) {
    for (let cx = 0; cx < cells; cx++) {
      const orient = hash2(cx, cy, seed) > 0.5 ? 0 : 1;
      const ox = cx * cellSize;
      const oy = cy * cellSize;
      for (let y = 0; y < cellSize; y++) {
        for (let x = 0; x < cellSize; x++) {
          // Distance to the two corners that anchor the arcs.
          const ax = orient === 0 ? 0 : cellSize;
          const ay = 0;
          const bx = orient === 0 ? cellSize : 0;
          const by = cellSize;
          const d1 = Math.hypot(x - ax, y - ay);
          const d2 = Math.hypot(x - bx, y - by);
          const r1 = cellSize / 2;
          // Two concentric arc bands per corner: thick + thin.
          const onA = Math.abs(d1 - r1) < 1.4;
          const onB = Math.abs(d2 - r1) < 1.4;
          const innerA = Math.abs(d1 - r1) < 0.5;
          const innerB = Math.abs(d2 - r1) < 0.5;
          if (innerA || innerB) paint(g, ox + x, oy + y, fg);
          else if (onA || onB) paint(g, ox + x, oy + y, mid);
        }
      }
    }
  }
  return g;
}

function mazeTile(seed: number, palette: Palette): Graphics {
  const g = new Graphics();
  // Binary-tree maze: for each cell, carve north or east. Walls drawn as
  // single-pixel lines on a 2x grid. Tiles seamlessly because all bottom
  // and right wall slots wrap.
  const cells = 8;
  const cellSize = N / cells;
  const wallColor = paletteAt(palette, 0.85);
  const fillColor = paletteAt(palette, 0.1);
  const accent = paletteAt(palette, 0.55);
  // Background.
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      paint(g, x, y, fillColor);
    }
  }
  // Carve walls. For each cell decide: knock north OR east. Solid walls
  // are everywhere else.
  const knockNorth: boolean[] = [];
  for (let cy = 0; cy < cells; cy++) {
    for (let cx = 0; cx < cells; cx++) {
      knockNorth[cy * cells + cx] = hash2(cx, cy, seed) > 0.5;
    }
  }
  // Draw south wall of every cell unless that cell knocked north (i.e.
  // the cell to its south knocked north into this one). With wrap.
  for (let cy = 0; cy < cells; cy++) {
    for (let cx = 0; cx < cells; cx++) {
      const idx = cy * cells + cx;
      const south = (cy + 1) % cells;
      const southIdx = south * cells + cx;
      const drawSouth = !knockNorth[southIdx];
      const drawEast = knockNorth[idx];
      const x0 = cx * cellSize;
      const y0 = cy * cellSize;
      if (drawSouth) {
        for (let i = 0; i < cellSize; i++) {
          paint(g, x0 + i, y0 + cellSize - 1, wallColor);
        }
      }
      if (drawEast) {
        for (let i = 0; i < cellSize; i++) {
          paint(g, x0 + cellSize - 1, y0 + i, wallColor);
        }
      }
      // Accent dot at cell center for texture.
      paint(g, x0 + Math.floor(cellSize / 2), y0 + Math.floor(cellSize / 2), accent);
    }
  }
  return g;
}

// ---- Public API ------------------------------------------------------------

interface ProceduralRecipe {
  name: string;
  seed: number;
  generator: (seed: number, palette: Palette) => Graphics;
  palette: Palette;
}

const RECIPES: readonly ProceduralRecipe[] = [
  { name: "voronoi-ocean", seed: 0xa17c, generator: voronoiTile, palette: PALETTES.ocean ?? [] },
  { name: "fbm-copper", seed: 0xb29d, generator: fbmMarbleTile, palette: PALETTES.copper ?? [] },
  {
    name: "truchet-cyber",
    seed: 0xc34e,
    generator: truchetArcsTile,
    palette: PALETTES.cyber ?? [],
  },
  { name: "maze-forest", seed: 0xd45f, generator: mazeTile, palette: PALETTES.forest ?? [] },
];

export function generateProceduralPatterns(renderer: Renderer): Texture[] {
  return RECIPES.map((r) => {
    const g = r.generator(r.seed, r.palette);
    return renderer.generateTexture({
      target: g,
      frame: new Rectangle(0, 0, N, N),
    });
  });
}
