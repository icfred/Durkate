import type { Card } from "@durak/engine";
import { color, type Focusable, typography } from "@durak/ui";
import { Container, Graphics, Text, type TextStyleFontWeight } from "pixi.js";

/**
 * Optional override for the rank+suit typography. SkinnedCard sets this
 * from the spec's glyphStyle field; raw CardView usage falls back to
 * the JetBrains Mono default.
 */
export interface GlyphLook {
  fontFamily: string;
  fontWeight: TextStyleFontWeight;
  letterSpacing: number;
}

export const CARD_W = 60;
export const CARD_H = 88;
const ILLEGAL_ALPHA = 0.45;

export const SUIT_GLYPH = {
  spades: "♠",
  hearts: "♥",
  diamonds: "♦",
  clubs: "♣",
} as const;

export const RANK_GLYPH: Record<number, string> = {
  6: "6",
  7: "7",
  8: "8",
  9: "9",
  10: "10",
  11: "J",
  12: "Q",
  13: "K",
  14: "A",
};

export function isRedSuit(suit: Card["suit"]): boolean {
  return suit === "hearts" || suit === "diamonds";
}

export function cardLabel(card: Card): string {
  return `${RANK_GLYPH[card.rank] ?? String(card.rank)}${SUIT_GLYPH[card.suit]}`;
}

export function cardKey(card: Card): string {
  return `${card.suit}-${card.rank}`;
}

export type LegalState = "neutral" | "legal" | "illegal";

export class CardView extends Container implements Focusable {
  // The card is split into three stacked sub-containers:
  //   - `skinLayer` (filtered): bg fill only. SkinnedCard attaches its
  //     pattern overlay and shader filters here. Cosmetic effects shimmer
  //     across this layer.
  //   - `borderLayer` (never filtered): the rounded-rect outline. Stays a
  //     solid, predictable contour regardless of skin — without it the
  //     edges of foil / chrome / holographic cards bled the shimmer
  //     across the rim.
  //   - `glyphLayer` (never filtered): rank and suit text, on top.
  // External wrappers reach the skin target via `skinLayer` (public).
  readonly skinLayer: Container;
  private readonly borderLayer: Graphics;
  private readonly glyphLayer: Container;
  private readonly bg: Graphics;
  // The corner glyph (rank + suit, top-left) and a small plate behind
  // it. The centre suit glyph that used to live here has been removed:
  // on busy patterns the big centre glyph competed with the artwork
  // and the corner plate is enough to anchor the rank/suit reading.
  private readonly cornerPlate: Graphics;
  private readonly cornerText: Text;
  private focused = false;
  private legalState: LegalState = "neutral";
  readonly card: Card | null;
  readonly faceDown: boolean;
  onActivate: (() => void) | undefined;

  constructor(card: Card | null, faceDown = false) {
    super();
    this.card = card;
    this.faceDown = faceDown;

    this.skinLayer = new Container();
    this.skinLayer.label = "card-skin-layer";
    this.addChild(this.skinLayer);

    this.bg = new Graphics();
    this.skinLayer.addChild(this.bg);

    this.borderLayer = new Graphics();
    this.borderLayer.label = "card-border-layer";
    this.addChild(this.borderLayer);

    this.glyphLayer = new Container();
    this.glyphLayer.label = "card-glyph-layer";
    this.addChild(this.glyphLayer);

    const fill =
      card && !faceDown ? (isRedSuit(card.suit) ? color.danger : color.text) : color.text;
    // Dark stroke gives the glyphs a hard contour so they read against any
    // backdrop (foil / holographic / chrome). `join: "round"` is essential —
    // the default miter joins produce sharp spikes at acute angles (the
    // apex of "A" was the obvious offender).
    const stroke = {
      color: color.bg,
      width: 2,
      alignment: 0.5,
      join: "round" as const,
      miterLimit: 2,
    };
    this.cornerText = new Text({
      text: card && !faceDown ? cardLabel(card) : "",
      style: {
        fontFamily: typography.family,
        fontSize: typography.size.md,
        fontWeight: typography.weight.bold,
        fill,
        stroke,
        letterSpacing: typography.letterSpacing.tight,
      },
    });
    // Bump text resolution so glyphs stay sharp when the SkinnedCard is
    // displayed at preview scale (4x in the tuner). Resolution 3 keeps
    // memory reasonable while crisp at typical preview / in-game scales.
    this.cornerText.resolution = 3;
    // Corner plate sits BEHIND the rank+suit so it draws first.
    this.cornerPlate = new Graphics();
    this.glyphLayer.addChild(this.cornerPlate);
    this.glyphLayer.addChild(this.cornerText);

    this.redraw();
  }

  /**
   * Replace the corner glyph's typography. Re-rasterizes the text in
   * the new font, sized to fit the same plate region.
   */
  setGlyphLook(look: GlyphLook): void {
    if (!this.card || this.faceDown) return;
    this.cornerText.style.fontFamily = look.fontFamily;
    this.cornerText.style.fontWeight = look.fontWeight;
    this.cornerText.style.letterSpacing = look.letterSpacing;
    this.redraw();
  }

  setFocus(focused: boolean): void {
    if (this.focused === focused) return;
    this.focused = focused;
    this.redraw();
  }

  setLegalState(state: LegalState): void {
    if (this.legalState === state) return;
    this.legalState = state;
    this.alpha = state === "illegal" ? ILLEGAL_ALPHA : 1;
    this.redraw();
  }

  activate(): void {
    this.onActivate?.();
  }

  private redraw(): void {
    const isFace = this.card !== null && !this.faceDown;
    const surface = this.faceDown ? color.surfaceFocus : color.bgRaised;
    let border: number = color.border;
    let borderWidth = 2;
    if (this.focused) {
      border = color.borderFocus;
      borderWidth = 3;
    } else if (this.legalState === "legal") {
      border = color.accent;
      borderWidth = 2;
    }
    // skinLayer: just the fill so cosmetic shaders have a solid surface to
    // operate on. No stroke here — the border lives on its own un-filtered
    // layer above.
    this.bg.clear().roundRect(0, 0, CARD_W, CARD_H, 4).fill({ color: surface });
    // borderLayer: stroke only, drawn on the same path. Sits above the
    // skinLayer so it is never reached by SkinnedCard's filters and reads as
    // a clean contour even on holographic / chrome cards.
    this.borderLayer
      .clear()
      .roundRect(0, 0, CARD_W, CARD_H, 4)
      .stroke({ color: border, width: borderWidth, alignment: 0 });
    this.cornerPlate.clear();
    if (isFace) {
      this.cornerText.x = 6;
      this.cornerText.y = 4;
      // Plate sized just larger than the cornerText, with a tighter
      // bottom padding because most fonts have descender space the
      // text bbox already accounts for. Reading on every redraw so
      // setGlyphLook (which can change the rendered metrics) keeps
      // the plate fitted.
      const padX = 3;
      const padTop = 2;
      const padBottom = 1;
      const plateW = Math.ceil(this.cornerText.width) + padX * 2;
      const plateH = Math.ceil(this.cornerText.height) + padTop + padBottom;
      this.cornerPlate
        .roundRect(this.cornerText.x - padX, this.cornerText.y - padTop, plateW, plateH, 2)
        .fill({ color: color.bg, alpha: 0.6 });
    }
  }
}
