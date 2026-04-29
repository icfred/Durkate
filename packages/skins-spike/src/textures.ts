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

function makePatternTile(renderer: Renderer, index: number): Texture {
  const g = new Graphics();
  g.rect(0, 0, PATTERN_TILE, PATTERN_TILE).fill({ color: 0x000000, alpha: 0 });
  const ink = 0xffffff;
  const t = PATTERN_TILE;
  switch (index) {
    case 0: {
      g.circle(t / 2, t / 2, 2).fill({ color: ink });
      break;
    }
    case 1: {
      g.moveTo(0, t).lineTo(t, 0).stroke({ color: ink, width: 1 });
      g.moveTo(-t, 0).lineTo(0, t).stroke({ color: ink, width: 1 });
      g.moveTo(t, t)
        .lineTo(t * 2, 0)
        .stroke({ color: ink, width: 1 });
      break;
    }
    case 2: {
      g.moveTo(0, 0).lineTo(t, 0).stroke({ color: ink, width: 1 });
      g.moveTo(0, 0).lineTo(0, t).stroke({ color: ink, width: 1 });
      break;
    }
    case 3: {
      const c = t / 2;
      g.moveTo(c - 3, c)
        .lineTo(c + 3, c)
        .stroke({ color: ink, width: 1 });
      g.moveTo(c, c - 3)
        .lineTo(c, c + 3)
        .stroke({ color: ink, width: 1 });
      break;
    }
    case 4: {
      const c = t / 2;
      g.moveTo(c, c - 4)
        .lineTo(c + 4, c)
        .lineTo(c, c + 4)
        .lineTo(c - 4, c)
        .closePath()
        .stroke({ color: ink, width: 1 });
      break;
    }
    case 5: {
      g.moveTo(0, t / 2);
      for (let x = 0; x <= t; x += 2) {
        const wy = t / 2 + Math.sin((x / t) * Math.PI * 2) * 3;
        g.lineTo(x, wy);
      }
      g.stroke({ color: ink, width: 1 });
      break;
    }
    case 6: {
      g.circle(t / 2, t / 2, 3).stroke({ color: ink, width: 1 });
      g.circle(0, 0, 3).stroke({ color: ink, width: 1 });
      g.circle(t, 0, 3).stroke({ color: ink, width: 1 });
      g.circle(0, t, 3).stroke({ color: ink, width: 1 });
      g.circle(t, t, 3).stroke({ color: ink, width: 1 });
      break;
    }
    default: {
      g.moveTo(0, 0).lineTo(t, t).stroke({ color: ink, width: 1 });
      g.moveTo(0, t).lineTo(t, 0).stroke({ color: ink, width: 1 });
      break;
    }
  }
  return renderer.generateTexture({
    target: g,
    frame: new Rectangle(0, 0, PATTERN_TILE, PATTERN_TILE),
  });
}
