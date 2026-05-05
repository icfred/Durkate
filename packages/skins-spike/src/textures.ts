import { Graphics, Rectangle, type Renderer, type Texture } from "pixi.js";
import { generateProceduralPatterns } from "./proceduralPatterns.js";

export const CARD_WIDTH = 96;
export const CARD_HEIGHT = 144;
export const PATTERN_COUNT = 8;
export const PATTERN_TILE = 24;

export interface SkinAssets {
  cardSurface: Texture;
  cardDecoration: Texture;
  patterns: Texture[];
}

export function createSkinAssets(renderer: Renderer): SkinAssets {
  // Pattern slots: P0-P3 are procedural (voronoi, fbm marble, truchet arcs,
  // maze) — colored, organic, generated pixel-by-pixel from seeds. P4-P7
  // are simple bitmap motifs kept as a baseline for direct comparison.
  const procedural = generateProceduralPatterns(renderer);
  const bitmap = [0, 1, 5, 6].map((i) => makePatternTile(renderer, i));
  return {
    cardSurface: makeCardSurface(renderer),
    cardDecoration: makeCardDecoration(renderer),
    patterns: [...procedural, ...bitmap],
  };
}

function makeCardSurface(renderer: Renderer): Texture {
  const g = new Graphics();
  g.roundRect(0, 0, CARD_WIDTH, CARD_HEIGHT, 4).fill({ color: 0xe6e0d4 });
  return renderer.generateTexture(g);
}

function makeCardDecoration(renderer: Renderer): Texture {
  const g = new Graphics();
  g.rect(0, 0, CARD_WIDTH, CARD_HEIGHT).fill({ color: 0x000000, alpha: 0 });
  g.roundRect(0, 0, CARD_WIDTH, CARD_HEIGHT, 4).stroke({
    color: 0xcfc4ad,
    width: 2,
    alignment: 1,
  });
  g.roundRect(6, 6, CARD_WIDTH - 12, CARD_HEIGHT - 12, 3).stroke({
    color: 0xb8a98a,
    width: 1,
    alignment: 0,
  });
  const cx = CARD_WIDTH / 2;
  const cy = CARD_HEIGHT / 2;
  g.moveTo(cx, cy - 22)
    .lineTo(cx + 18, cy)
    .lineTo(cx, cy + 22)
    .lineTo(cx - 18, cy)
    .closePath()
    .fill({ color: 0x4a3f33, alpha: 0.85 });
  g.circle(cx, cy, 4).fill({ color: 0xe6e0d4, alpha: 0.95 });
  return renderer.generateTexture({
    target: g,
    frame: new Rectangle(0, 0, CARD_WIDTH, CARD_HEIGHT),
  });
}

// Pattern tiles are pixel-art. Every motif is built from integer-aligned
// rectangles on an 8x8 cell grid (PATTERN_TILE = 24, cell = PIXEL = 3px).
// Each tile is hand-designed to seam at all four edges so it reads as an
// infinite repeat rather than a tiled stamp.
const PIXEL = 3;
const TILE_CELLS = 8;

function px(g: Graphics, cx: number, cy: number, color: number): void {
  g.rect(cx * PIXEL, cy * PIXEL, PIXEL, PIXEL).fill({ color });
}

// Each pattern is an 8x8 ASCII bitmap. "#" = ink cell, anything else = empty.
// Multi-line template string preserves the visual layout for hand-editing
// (biome-format would otherwise collapse arrays of row strings to one line).
function drawBitmap(g: Graphics, art: string, color: number): void {
  const rows = art.split("\n").filter((r) => r.length > 0);
  for (let y = 0; y < TILE_CELLS; y++) {
    const row = rows[y] ?? "";
    for (let x = 0; x < TILE_CELLS; x++) {
      if (row[x] === "#") px(g, x, y, color);
    }
  }
}

// 0: Polka dots — 2x2 dots on a 4-cell stride.
const PAT_DOTS = `
##..##..
##..##..
........
........
##..##..
##..##..
........
........`;

// 1: Diagonal stripes — 1px wide, stride 4. Tiles seamlessly.
const PAT_STRIPES = `
#...#...
.#...#..
..#...#.
...#...#
#...#...
.#...#..
..#...#.
...#...#`;

// 2: Bricks — running bond. Mortar is the ink.
const PAT_BRICKS = `
....#...
....#...
....#...
########
#.......
#.......
#.......
########`;

// 3: Diamond grid — two diamonds per tile, offset for a denser feel.
const PAT_DIAMONDS = `
.#......
#.#.....
.#......
........
.....#..
....#.#.
.....#..
........`;

// 4: Houndstooth — classic 4x4 motif tiled 2x.
const PAT_HOUNDSTOOTH = `
##..##..
#...#...
...#...#
..##..##
##..##..
#...#...
...#...#
..##..##`;

// 5: Checkerboard — 2x2 cells.
const PAT_CHECKER = `
##..##..
##..##..
..##..##
..##..##
##..##..
##..##..
..##..##
..##..##`;

// 6: Confetti — eight scattered single-cell dots, no two adjacent.
const PAT_CONFETTI = `
#.......
...#....
......#.
..#.....
.....#..
.#......
....#...
.......#`;

// 7: Cross-hatch X — paired diagonals forming an X per tile.
const PAT_HATCH = `
#......#
.#....#.
..#..#..
...##...
...##...
..#..#..
.#....#.
#......#`;

const PATTERN_BITMAPS: readonly string[] = [
  PAT_DOTS,
  PAT_STRIPES,
  PAT_BRICKS,
  PAT_DIAMONDS,
  PAT_HOUNDSTOOTH,
  PAT_CHECKER,
  PAT_CONFETTI,
  PAT_HATCH,
];

function makePatternTile(renderer: Renderer, index: number): Texture {
  const g = new Graphics();
  g.rect(0, 0, PATTERN_TILE, PATTERN_TILE).fill({ color: 0x000000, alpha: 0 });
  const bitmap = PATTERN_BITMAPS[index] ?? PATTERN_BITMAPS[PATTERN_BITMAPS.length - 1];
  if (bitmap) drawBitmap(g, bitmap, 0xffffff);
  return renderer.generateTexture({
    target: g,
    frame: new Rectangle(0, 0, PATTERN_TILE, PATTERN_TILE),
  });
}
