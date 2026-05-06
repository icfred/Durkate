export interface SpecRanges {
  patternScale: readonly [number, number];
  hue: readonly [number, number];
  saturation: readonly [number, number];
  brightness: readonly [number, number];
}

export interface PatternRender {
  tileSize: number;
  overlayAlpha: number;
}

export interface FoilTunables {
  /**
   * Stamp opacity for silver / gold / bronze metallic finishes. At 1.0
   * the foil fully replaces the pattern in glossy regions; lower values
   * let the pattern bleed through.
   */
  metalStrength: number;
  /** Same idea for the holographic rainbow finish. */
  holographicStrength: number;
  /**
   * Size of one pixel-art cell in card-local units. The shader's pixel grid
   * is computed as (cardWidth / cellSize, cardHeight / cellSize). Lower =
   * finer / less chunky. 4 matches the in-game card glyph size.
   */
  cellSize: number;
  /**
   * 0..1. Widens the foil-coverage gloss gate — at 0 finishes only stamp
   * on the very brightest finishMask peaks; at 1 they cover much more of
   * the pattern. Lets cards with sparse finishMask (P7 brick, etc.) still
   * get a meaningful foil presence without the generator changing.
   */
  coverageBias: number;
  /**
   * 0..1. Pattern-relief depth. 0 = fully flat (pure 2D ink, like an
   * unlit print). 0.1 ≈ a hint of relief on matte cards. 1.0 = full
   * Lambert + Fresnel + specular for premium foils. SkinnedCard sets a
   * sensible default per finish; this scales the result globally.
   */
  depth: number;
}

export interface Tunables {
  cardWidth: number;
  cardHeight: number;
  pattern: PatternRender;
  spec: SpecRanges;
  foil: FoilTunables;
  /**
   * Surface condition. 0 = factory-new (mint), 1 = battle-scarred. Both
   * pattern and foil shaders desaturate and add scuff noise as wear
   * climbs; the foil also chips its own alpha so high-wear cards show
   * gaps where the finish has rubbed off.
   */
  wear: number;
}

export const defaultTunables: Tunables = {
  cardWidth: 96,
  cardHeight: 144,
  pattern: { tileSize: 24, overlayAlpha: 1.0 },
  spec: {
    patternScale: [0.6, 2.2],
    hue: [-1, 1],
    saturation: [0.5, 1.5],
    brightness: [0.75, 1.25],
  },
  foil: {
    metalStrength: 0.95,
    holographicStrength: 0.95,
    cellSize: 4,
    coverageBias: 0.5,
    depth: 1.0,
  },
  wear: 0,
};
