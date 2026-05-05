import { Graphics, Rectangle, type Renderer, type Texture } from "pixi.js";

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
  return {
    cardSurface: makeCardSurface(renderer),
    cardDecoration: makeCardDecoration(renderer),
    patterns: Array.from({ length: PATTERN_COUNT }, (_, i) => makePatternTile(renderer, i)),
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
// rectangles on a coarse cell grid (PATTERN_TILE = 24, cell = PIXEL = 3),
// so the result reads as discrete pixels rather than smooth strokes.
// No circles, no diagonals, no antialiased lines.
const PIXEL = 3;
function px(g: Graphics, cx: number, cy: number, color: number): void {
  g.rect(cx * PIXEL, cy * PIXEL, PIXEL, PIXEL).fill({ color });
}

function makePatternTile(renderer: Renderer, index: number): Texture {
  const g = new Graphics();
  g.rect(0, 0, PATTERN_TILE, PATTERN_TILE).fill({ color: 0x000000, alpha: 0 });
  const ink = 0xffffff;
  // Tile is an 8x8 cell grid (24 / 3). Coordinates below are cell indices.
  switch (index) {
    case 0: {
      // Centered 2x2 dot.
      px(g, 3, 3, ink);
      px(g, 4, 3, ink);
      px(g, 3, 4, ink);
      px(g, 4, 4, ink);
      break;
    }
    case 1: {
      // Stair-step diagonals (manual Bresenham, one pixel per cell).
      for (let i = 0; i < 8; i++) px(g, i, 7 - i, ink);
      for (let i = 0; i < 8; i++) px(g, (i + 4) % 8, 7 - i, ink);
      break;
    }
    case 2: {
      // Corner L: top row + left column.
      for (let i = 0; i < 8; i++) px(g, i, 0, ink);
      for (let i = 0; i < 8; i++) px(g, 0, i, ink);
      break;
    }
    case 3: {
      // Plus sign at center.
      px(g, 3, 2, ink);
      px(g, 4, 2, ink);
      px(g, 3, 5, ink);
      px(g, 4, 5, ink);
      px(g, 2, 3, ink);
      px(g, 2, 4, ink);
      px(g, 5, 3, ink);
      px(g, 5, 4, ink);
      px(g, 3, 3, ink);
      px(g, 4, 3, ink);
      px(g, 3, 4, ink);
      px(g, 4, 4, ink);
      break;
    }
    case 4: {
      // Hollow diamond outline (8-cell diamond).
      const d: [number, number][] = [
        [3, 1],
        [4, 1],
        [2, 2],
        [5, 2],
        [1, 3],
        [6, 3],
        [1, 4],
        [6, 4],
        [2, 5],
        [5, 5],
        [3, 6],
        [4, 6],
      ];
      for (const [x, y] of d) px(g, x, y, ink);
      break;
    }
    case 5: {
      // Stepped wave: two rows of dashes offset.
      for (let i = 0; i < 8; i += 2) px(g, i, 3, ink);
      for (let i = 1; i < 8; i += 2) px(g, i, 4, ink);
      break;
    }
    case 6: {
      // Center 2x2 + four corner 2x2s (scattered dots).
      const blocks: [number, number][] = [
        [3, 3],
        [0, 0],
        [6, 0],
        [0, 6],
        [6, 6],
      ];
      for (const [bx, by] of blocks) {
        px(g, bx, by, ink);
        px(g, bx + 1, by, ink);
        px(g, bx, by + 1, ink);
        px(g, bx + 1, by + 1, ink);
      }
      break;
    }
    default: {
      // X: two diagonals.
      for (let i = 0; i < 8; i++) {
        px(g, i, i, ink);
        px(g, i, 7 - i, ink);
      }
      break;
    }
  }
  return renderer.generateTexture({
    target: g,
    frame: new Rectangle(0, 0, PATTERN_TILE, PATTERN_TILE),
  });
}
