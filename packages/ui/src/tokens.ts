// Soviet Dusk palette + motion tokens, ported from
// .claude/skills/durak-design/colors_and_type.css. The CSS file is the
// canonical spec; if values diverge, that file wins.

export const color = {
  // Surface ramp (--bg-0..4) — dark, slightly warm. No pure black.
  bgDeep: 0x14110e, // --bg-0  letterbox, modal scrim base
  bg: 0x1a1714, // --bg-1  default screen background
  bgRaised: 0x221e1a, // --bg-2  panels, cards
  bgHover: 0x2a2723, // --bg-3  hover state for raised surfaces
  bgSunken: 0x14110e, // alias of --bg-0 for sunken inputs

  // Compatibility aliases for screens that pre-date the port.
  surface: 0x221e1a, // = bgRaised
  surfaceFocus: 0x2a2723, // = bgHover

  // Borders
  border: 0x3a3530, // --bg-4  hairlines, inactive borders
  borderFocus: 0x8a3a2e, // = accent  keyboard focus ring

  // Ink (foreground text) — paper-cream warm.
  text: 0xc9b890, // --ink-1
  textMuted: 0xa89968, // --ink-2
  textDim: 0x6e6155, // --ink-3
  textPlaceholder: 0x4a4138, // --ink-4
  textInverse: 0x1a1714, // for ink rendered on cream card faces

  // Accents — used surgically.
  accent: 0x8a3a2e, // --accent  brick-red: trump, focus, wordmark accent, errors
  accentBright: 0xb04a3a, // --accent-bright
  accentDim: 0x5a2820, // --accent-dim
  accentHot: 0xb04a3a, // alias of accentBright for compatibility
  danger: 0x8a3a2e, // collapsed onto accent in this palette
  stamp: 0x8a3a2e, // collapsed onto accent in this palette

  ok: 0x5a6b4a, // --ok    olive: ready, confirm
  warn: 0xa89968, // --warn  matches ink-2

  // Suits — fixed, never themed.
  suitRed: 0x8a3a2e,
  suitBlack: 0x1a1714,

  // Card stock (the face/back of a card on the table).
  cardFace: 0xd4c8a8,
  cardEdge: 0x8a7a5a,
  cardBack: 0x4a3528,
  cardBackPattern: 0x2a1f18,

  // Felt / table.
  feltDefault: 0x2d3528,
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
  card: 2, // the only radius the spec endorses; identical to sm
} as const;

export const stroke = {
  thin: 1,
  base: 2,
  thick: 3,
} as const;

export const typography = {
  // Default family used by call sites that don't yet distinguish display
  // vs body. Currently JetBrains Mono because that is what is loaded at
  // boot (apps/web/src/main.ts). Switching the wordmark to display and
  // body labels to mono is a follow-up screen-refactor ticket.
  family: '"JetBrains Mono", "Courier New", monospace',
  families: {
    display: '"Press Start 2P", ui-monospace, monospace',
    body: '"VT323", ui-monospace, "Courier New", monospace',
    utility: '"JetBrains Mono", ui-monospace, monospace',
  },
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
  // cubic-bezier(0.2, 0.8, 0.2, 1) approximated: fast-in / light-out.
  snap: (t: number): number => 1 - (1 - t) * (1 - t) * (1 - t),
  pop: (t: number): number => t * t * (3 - 2 * t),
  linear: (t: number): number => t,
} as const;

export const duration = {
  // Spec ceiling is 250ms. Anything slower feels websitey.
  instant: 0, // focus jump teleports
  snap: 80, // hover, button press
  quick: 120, // menu wipe, screen shake
  card: 200, // card flip, slide
  default: 250, // outer limit

  // Compatibility aliases.
  fast: 120,
  base: 200,
  slow: 250,
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
