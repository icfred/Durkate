import { Graphics, Rectangle, type Renderer, type Texture } from "pixi.js";
import { generateProceduralPatterns } from "./proceduralPatterns.js";
import type { PatternBundle } from "./renderers/patternMesh.js";
import { generateScratchMap } from "./scratchMap.js";

export const CARD_WIDTH = 96;
export const CARD_HEIGHT = 144;
export const PATTERN_COUNT = 8;
export const PATTERN_TILE = 24;

export interface SkinAssets {
  cardSurface: Texture;
  cardDecoration: Texture;
  patterns: PatternBundle[];
  /**
   * Single-channel wear-threshold map shared across all cards. Each pixel
   * holds a wear threshold (0–1) — at runtime, pixels with threshold ≤
   * uWear show wear (revealed in the shader). See scratchMap.ts.
   */
  scratchMap: Texture;
}

export function createSkinAssets(_renderer: Renderer): SkinAssets {
  const patterns = generateProceduralPatterns(_renderer);
  return {
    cardSurface: makeCardSurface(_renderer),
    cardDecoration: makeCardDecoration(_renderer),
    patterns,
    scratchMap: generateScratchMap(0xa11ce5),
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
