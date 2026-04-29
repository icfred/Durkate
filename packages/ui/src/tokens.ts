export const color = {
  bg: 0x14110f,
  bgRaised: 0x1d1916,
  bgSunken: 0x0c0a09,
  surface: 0x2a2420,
  surfaceFocus: 0x3a3128,
  border: 0x4a3f33,
  borderFocus: 0xc9a36a,
  text: 0xe8dccb,
  textMuted: 0x8a7d6a,
  textInverse: 0x14110f,
  accent: 0xc9a36a,
  accentHot: 0xe8c386,
  danger: 0x8b3a2b,
  stamp: 0xa83232,
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 40,
  xxl: 64,
} as const;

export const radius = {
  none: 0,
  sm: 2,
  md: 4,
} as const;

export const stroke = {
  thin: 1,
  base: 2,
  thick: 3,
} as const;

export const typography = {
  family: '"JetBrains Mono", "Courier New", monospace',
  size: {
    xs: 11,
    sm: 13,
    md: 15,
    lg: 20,
    xl: 28,
    xxl: 44,
  },
  weight: {
    regular: "400",
    bold: "700",
  },
  letterSpacing: {
    tight: 0,
    wide: 1,
    stamp: 2,
  },
} as const;

export const easing = {
  snap: (t: number): number => 1 - (1 - t) * (1 - t) * (1 - t),
  pop: (t: number): number => t * t * (3 - 2 * t),
  linear: (t: number): number => t,
} as const;

export const duration = {
  instant: 80,
  fast: 140,
  base: 220,
  slow: 360,
} as const;

export const tokens = {
  color,
  spacing,
  radius,
  stroke,
  typography,
  easing,
  duration,
} as const;

export type Tokens = typeof tokens;
