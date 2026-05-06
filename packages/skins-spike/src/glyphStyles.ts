// Glyph styles: fontFamily + weight pairings used to render the
// rank+suit corner glyph. A spec field picks one of these so the same
// shape × colorway × finish can also vary by typography. Web-safe
// fallbacks at the end of each stack so we don't need to bundle extra
// font assets — system fonts keep the spike light.

export interface GlyphStyle {
  name: string;
  fontFamily: string;
  fontWeight: "400" | "600" | "700" | "800";
  /** Letter spacing in px. Tighter for serifs, wider for monospaced. */
  letterSpacing: number;
}

export const GLYPH_STYLES: readonly GlyphStyle[] = [
  {
    name: "mono",
    fontFamily: '"JetBrains Mono", monospace',
    fontWeight: "700",
    letterSpacing: 0,
  },
  {
    name: "serif",
    fontFamily: 'Georgia, "Times New Roman", serif',
    fontWeight: "700",
    letterSpacing: 0,
  },
  {
    name: "sans",
    fontFamily: '"Helvetica Neue", "Arial", system-ui, sans-serif',
    fontWeight: "800",
    letterSpacing: 0,
  },
  {
    name: "regal",
    fontFamily: '"Didot", "Bodoni MT", "Times New Roman", serif',
    fontWeight: "700",
    letterSpacing: 0,
  },
];

export const GLYPH_STYLE_COUNT = GLYPH_STYLES.length;
