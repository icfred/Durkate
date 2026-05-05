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
  private readonly bg: Graphics;
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
    this.bg = new Graphics();
    this.addChild(this.bg);

    const fill =
      card && !faceDown ? (isRedSuit(card.suit) ? color.danger : color.text) : color.text;
    this.cornerText = new Text({
      text: card && !faceDown ? cardLabel(card) : "",
      style: {
        fontFamily: typography.family,
        fontSize: typography.size.sm,
        fontWeight: typography.weight.bold,
        fill,
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
      },
    });
    this.addChild(this.cornerText);
    this.addChild(this.centerText);

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
    this.bg
      .clear()
      .roundRect(0, 0, CARD_W, CARD_H, 4)
      .fill({ color: surface })
      .stroke({ color: border, width: borderWidth, alignment: 0 });
    if (isFace) {
      this.cornerText.x = 6;
      this.cornerText.y = 4;
      this.centerText.x = Math.round((CARD_W - this.centerText.width) / 2);
      this.centerText.y = Math.round((CARD_H - this.centerText.height) / 2);
    }
  }
}
