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
  foilStrength: number;
  chromeStrength: number;
  holographicStrength: number;
  /**
   * Size of one pixel-art cell in card-local units. The shader's pixel grid
   * is computed as (cardWidth / cellSize, cardHeight / cellSize). Lower =
   * finer / less chunky. 4 matches the in-game card glyph size.
   */
  cellSize: number;
}

export interface MotionTunables {
  shimmerSpeed: number;
  shimmerWidth: number;
  pulseSpeed: number;
  pulseAmount: number;
  driftSpeed: number;
}

export interface Tunables {
  cardWidth: number;
  cardHeight: number;
  pattern: PatternRender;
  spec: SpecRanges;
  foil: FoilTunables;
  motion: MotionTunables;
}

export const defaultTunables: Tunables = {
  cardWidth: 96,
  cardHeight: 144,
  pattern: { tileSize: 24, overlayAlpha: 0.55 },
  spec: {
    patternScale: [0.6, 2.2],
    hue: [-1, 1],
    saturation: [0.5, 1.5],
    brightness: [0.75, 1.25],
  },
  foil: {
    foilStrength: 0.45,
    chromeStrength: 0.6,
    holographicStrength: 0.75,
    cellSize: 4,
  },
  motion: {
    shimmerSpeed: 0.4,
    shimmerWidth: 0.08,
    pulseSpeed: 2.5,
    pulseAmount: 0.25,
    driftSpeed: 0.08,
  },
};
