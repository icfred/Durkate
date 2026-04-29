import { Graphics, type Renderer, type Texture } from "pixi.js";

export const CARD_WIDTH = 96;
export const CARD_HEIGHT = 144;
export const PATTERN_COUNT = 8;

export interface SkinAssets {
  baseCard: Texture;
  patterns: Texture[];
}

export function createSkinAssets(renderer: Renderer): SkinAssets {
  return {
    baseCard: makeBaseCard(renderer),
    patterns: Array.from({ length: PATTERN_COUNT }, (_, i) => makePattern(renderer, i)),
  };
}

function makeBaseCard(renderer: Renderer): Texture {
  const g = new Graphics();
  g.roundRect(0, 0, CARD_WIDTH, CARD_HEIGHT, 4).fill({ color: 0xe6e0d4 });
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
    .fill({ color: 0xb8a98a, alpha: 0.55 });
  g.circle(cx, cy, 4).fill({ color: 0xe6e0d4 });
  return renderer.generateTexture(g);
}

function makePattern(renderer: Renderer, index: number): Texture {
  const g = new Graphics();
  g.rect(0, 0, CARD_WIDTH, CARD_HEIGHT).fill({ color: 0x000000, alpha: 0 });
  const ink = 0xffffff;
  switch (index) {
    case 0:
      drawDots(g, ink, 8, 2);
      break;
    case 1:
      drawDiagonalLines(g, ink, 6, 1);
      break;
    case 2:
      drawGrid(g, ink, 10, 1);
      break;
    case 3:
      drawCrosses(g, ink, 12);
      break;
    case 4:
      drawDiamonds(g, ink, 14);
      break;
    case 5:
      drawWaves(g, ink, 8);
      break;
    case 6:
      drawHexLike(g, ink, 12);
      break;
    default:
      drawHatch(g, ink, 4, 1);
      break;
  }
  return renderer.generateTexture(g);
}

function drawDots(g: Graphics, color: number, step: number, r: number): void {
  for (let y = step / 2; y < CARD_HEIGHT; y += step) {
    for (let x = step / 2; x < CARD_WIDTH; x += step) {
      g.circle(x, y, r).fill({ color });
    }
  }
}

function drawDiagonalLines(g: Graphics, color: number, step: number, w: number): void {
  for (let off = -CARD_HEIGHT; off < CARD_WIDTH + CARD_HEIGHT; off += step) {
    g.moveTo(off, 0)
      .lineTo(off + CARD_HEIGHT, CARD_HEIGHT)
      .stroke({ color, width: w });
  }
}

function drawGrid(g: Graphics, color: number, step: number, w: number): void {
  for (let x = 0; x <= CARD_WIDTH; x += step) {
    g.moveTo(x, 0).lineTo(x, CARD_HEIGHT).stroke({ color, width: w });
  }
  for (let y = 0; y <= CARD_HEIGHT; y += step) {
    g.moveTo(0, y).lineTo(CARD_WIDTH, y).stroke({ color, width: w });
  }
}

function drawCrosses(g: Graphics, color: number, step: number): void {
  for (let y = step / 2; y < CARD_HEIGHT; y += step) {
    for (let x = step / 2; x < CARD_WIDTH; x += step) {
      g.moveTo(x - 3, y)
        .lineTo(x + 3, y)
        .stroke({ color, width: 1 });
      g.moveTo(x, y - 3)
        .lineTo(x, y + 3)
        .stroke({ color, width: 1 });
    }
  }
}

function drawDiamonds(g: Graphics, color: number, step: number): void {
  for (let y = step / 2; y < CARD_HEIGHT + step; y += step) {
    for (let x = step / 2; x < CARD_WIDTH + step; x += step) {
      const ox = (Math.floor(y / step) % 2) * (step / 2);
      g.moveTo(x + ox, y - 3)
        .lineTo(x + ox + 3, y)
        .lineTo(x + ox, y + 3)
        .lineTo(x + ox - 3, y)
        .closePath()
        .stroke({ color, width: 1 });
    }
  }
}

function drawWaves(g: Graphics, color: number, step: number): void {
  for (let y = step; y < CARD_HEIGHT; y += step) {
    g.moveTo(0, y);
    for (let x = 0; x <= CARD_WIDTH; x += 4) {
      const wy = y + Math.sin(x * 0.4) * 2;
      g.lineTo(x, wy);
    }
    g.stroke({ color, width: 1 });
  }
}

function drawHexLike(g: Graphics, color: number, step: number): void {
  for (let y = step; y < CARD_HEIGHT + step; y += step) {
    const row = Math.floor(y / step);
    const xOff = (row % 2) * (step / 2);
    for (let x = step / 2; x < CARD_WIDTH + step; x += step) {
      g.circle(x + xOff, y, 2).stroke({ color, width: 1 });
    }
  }
}

function drawHatch(g: Graphics, color: number, step: number, w: number): void {
  for (let off = -CARD_HEIGHT; off < CARD_WIDTH + CARD_HEIGHT; off += step) {
    g.moveTo(off, 0)
      .lineTo(off + CARD_HEIGHT, CARD_HEIGHT)
      .stroke({ color, width: w });
    g.moveTo(off + CARD_HEIGHT, 0)
      .lineTo(off, CARD_HEIGHT)
      .stroke({ color, width: w });
  }
}
