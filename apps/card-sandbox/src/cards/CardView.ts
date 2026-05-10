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
  // Bottom strip used as a trump indicator. Lives on its own layer (above
  // the skin, below the border) and is empty unless `setTrump(true)` is
  // called, so non-trump cards pay nothing for it.
  private readonly trumpStrip: Graphics;
  private focused = false;
  private legalState: LegalState = "neutral";
  private isTrump = false;
  // Body fill colour. Defaults to the standard card-stock surface (cream
  // when face-up, sunken-dark when face-down) but the sandbox tuner
  // overrides this via setSurface() so the front face matches whatever
  // BODY colourway the user selected.
  private surface: number;
  readonly card: Card | null;
  readonly faceDown: boolean;
  onActivate: (() => void) | undefined;

  constructor(card: Card | null, faceDown = false) {
    super();
    this.card = card;
    this.faceDown = faceDown;
    this.surface = faceDown ? color.surfaceFocus : color.bgRaised;

    this.skinLayer = new Container();
    this.skinLayer.label = "card-skin-layer";
    this.addChild(this.skinLayer);

    this.bg = new Graphics();
    this.skinLayer.addChild(this.bg);

    this.trumpStrip = new Graphics();
    this.trumpStrip.label = "card-trump-strip";
    this.addChild(this.trumpStrip);

    this.borderLayer = new Graphics();
    this.borderLayer.label = "card-border-layer";
    this.addChild(this.borderLayer);

    this.glyphLayer = new Container();
    this.glyphLayer.label = "card-glyph-layer";
    this.addChild(this.glyphLayer);

    // Per-suit fill, single near-black outline. Red suits get the muted
    // brick fill from the UI palette (color.danger); black suits get a
    // bone-white fill (0xf3eddc). Both share the same near-black stroke
    // — high contrast against either suit's fill, and reads cleanly on
    // the dark card body.
    const isRed = card != null && !faceDown && isRedSuit(card.suit);
    const fill = card && !faceDown ? (isRed ? color.danger : 0xf3eddc) : color.text;
    const strokeColor = 0x141414;
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

  // Mark this card as a trump. Adds a permanent bottom-edge accent strip
  // so the player can scan trumps at a glance — independent of focus/legal
  // state, which already use the brick-red border.
  setTrump(trump: boolean): void {
    if (this.isTrump === trump) return;
    this.isTrump = trump;
    this.redraw();
  }

  /** Override the card body fill. Used by the sandbox tuner to make
   *  the face card match the selected BODY colourway. */
  setSurface(surface: number): void {
    if (this.surface === surface) return;
    this.surface = surface;
    this.redraw();
  }

  activate(): void {
    this.onActivate?.();
  }

  private redraw(): void {
    const isFace = this.card !== null && !this.faceDown;
    const surface = this.surface;
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
    // trumpStrip: thin accent bar along the bottom edge, only drawn for
    // trump face-up cards. Sits above the skin so cosmetic filters don't
    // wash it out, and below the border so the focus ring still wins.
    this.trumpStrip.clear();
    if (this.isTrump && isFace) {
      const stripH = 5;
      this.trumpStrip
        .roundRect(2, CARD_H - stripH - 2, CARD_W - 4, stripH, 1)
        .fill({ color: color.warn });
    }
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
