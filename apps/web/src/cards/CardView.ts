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
  // The corner glyph (rank + suit, top-left). Plate idea was tried twice
  // and dropped both times — never sized cleanly across fonts. Instead
  // the glyph carries its own contrast: high-contrast fill (true red or
  // true black) inside an off-white outline. The outline colour is the
  // workhorse — it pops against the dark card body of every colorway.
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

    // Per-suit fill + outline pairing for legibility on dark card bodies:
    //   - Red suits: bright pinkish-red (0xee3a4e) fill, pure-black
    //     outline. The pinkish hue is distinct from the warm copper /
    //     ember / amber patterns where the older 0xc83a3a brick-red
    //     blended in. Pure black outline (vs near-black) bumps the
    //     contrast another notch.
    //   - Black suits: near-black fill, off-white outline. Unchanged.
    const isRed = card != null && !faceDown && isRedSuit(card.suit);
    const fill = card && !faceDown ? (isRed ? 0xee3a4e : 0x141414) : color.text;
    const strokeColor = isRed ? 0x000000 : 0xf3eddc;
    // `join: "round"` to avoid miter spikes on the apex of glyphs like "A".
    const stroke = {
      color: strokeColor,
      width: 3,
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
    this.glyphLayer.addChild(this.cornerText);

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
    if (isFace) {
      this.cornerText.x = 6;
      this.cornerText.y = 4;
    }
  }
}
