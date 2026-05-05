import { Graphics, Rectangle, type Renderer, type Texture } from "pixi.js";
import { generateProceduralPatterns } from "./proceduralPatterns.js";
import type { PatternBundle } from "./renderers/patternMesh.js";

export const CARD_WIDTH = 96;
export const CARD_HEIGHT = 144;
export const PATTERN_COUNT = 8;
export const PATTERN_TILE = 24;

export interface SkinAssets {
  cardSurface: Texture;
  cardDecoration: Texture;
  /**
   * One PatternBundle per pattern slot. Each bundle ships three textures:
   * `color` (palette per cell, no baked lighting), `height` (used by the
   * shader for per-pixel normal), and `gloss` (specular highlight strength).
   * The pattern shader composes all three at draw time so lighting can
   * animate with motion mode and highlights catch on metallic pixels only.
   */
  patterns: PatternBundle[];
}

export function createSkinAssets(_renderer: Renderer): SkinAssets {
  // Phase 2: every pattern slot is a procedural bundle. Bitmap motifs are
  // gone — they didn't carry height/gloss data and would have rendered as
  // flat unlit overlays under the new pattern shader. Eight recipes give
  // a varied set of jewel/marble/circuit/labyrinth looks per palette.
  const patterns = generateProceduralPatterns(_renderer);
  return {
    cardSurface: makeCardSurface(_renderer),
    cardDecoration: makeCardDecoration(_renderer),
    patterns,
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
