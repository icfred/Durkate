import type { Card } from "@durak/engine";
import { color, type Focusable, typography } from "@durak/ui";
import { Container, Graphics, Text } from "pixi.js";

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
  // Backing plates that sit under the corner and centre glyphs, drawn
  // by glyphLayer so they're never reached by SkinnedCard's pattern /
  // foil meshes. Provide a known-contrast backdrop for the rank and
  // suit so they stay readable on noisy patterns.
  private readonly cornerPlate: Graphics;
  private readonly centerPlate: Graphics;
  private readonly cornerText: Text;
  private readonly centerText: Text;
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
        fontSize: typography.size.sm,
        fontWeight: typography.weight.bold,
        fill,
        stroke,
        letterSpacing: typography.letterSpacing.tight,
      },
    });
    this.centerText = new Text({
      text: card && !faceDown ? SUIT_GLYPH[card.suit] : "",
      style: {
        fontFamily: typography.family,
        fontSize: typography.size.xl,
        fontWeight: typography.weight.bold,
        fill,
        stroke: { ...stroke, width: 3 },
      },
    });
    // Plates first so glyphs draw on top.
    this.cornerPlate = new Graphics();
    this.glyphLayer.addChild(this.cornerPlate);
    this.centerPlate = new Graphics();
    this.glyphLayer.addChild(this.centerPlate);
    this.glyphLayer.addChild(this.cornerText);
    this.glyphLayer.addChild(this.centerText);

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
    this.centerPlate.clear();
    if (isFace) {
      this.cornerText.x = 6;
      this.cornerText.y = 4;
      this.centerText.x = Math.round((CARD_W - this.centerText.width) / 2);
      this.centerText.y = Math.round((CARD_H - this.centerText.height) / 2);

      // Plates: dark, semi-transparent rounded rects sized just larger
      // than each glyph's bounding box. Alpha is low enough that the
      // pattern still bleeds through (so the plates feel inset rather
      // than slapped on), but the contrast is reliable.
      const plateColor = color.bg;
      const cornerPad = 2;
      this.cornerPlate
        .roundRect(
          this.cornerText.x - cornerPad,
          this.cornerText.y - cornerPad,
          this.cornerText.width + cornerPad * 2,
          this.cornerText.height + cornerPad * 1.5,
          2,
        )
        .fill({ color: plateColor, alpha: 0.55 });

      // Centre plate: a circle behind the suit glyph rather than a
      // rect, since the suit shape is round-ish and a circle reads
      // less like a label and more like a recessed seal.
      const cx = CARD_W / 2;
      const cy = CARD_H / 2;
      const radius = Math.max(this.centerText.width, this.centerText.height) * 0.65;
      this.centerPlate.circle(cx, cy, radius).fill({ color: plateColor, alpha: 0.5 });
    }
  }
}
