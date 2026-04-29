import type { Action, Card, Event, TablePair } from "@durak/engine";
import type { SeatIndex, Snapshot } from "@durak/protocol";
import { color, type Focusable, FocusManager, spacing, typography } from "@durak/ui";
import { Container, Graphics, Text } from "pixi.js";
import { playSfx } from "../audio/index.js";
import type { Screen } from "./types.js";

const CARD_W = 60;
const CARD_H = 88;
const HAND_GAP = 6;
const SECTION_PADDING = spacing.lg;

const SUIT_GLYPH = {
  spades: "♠",
  hearts: "♥",
  diamonds: "♦",
  clubs: "♣",
} as const;

const RANK_GLYPH: Record<number, string> = {
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

function isRedSuit(suit: Card["suit"]): boolean {
  return suit === "hearts" || suit === "diamonds";
}

function cardLabel(card: Card): string {
  return `${RANK_GLYPH[card.rank] ?? String(card.rank)}${SUIT_GLYPH[card.suit]}`;
}

class CardView extends Container implements Focusable {
  private readonly bg: Graphics;
  private readonly cornerText: Text;
  private readonly centerText: Text;
  private focused = false;
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

  activate(): void {
    this.onActivate?.();
  }

  private redraw(): void {
    const isFace = this.card !== null && !this.faceDown;
    const surface = this.faceDown ? color.surfaceFocus : color.bgRaised;
    const border = this.focused ? color.borderFocus : color.border;
    const borderWidth = this.focused ? 3 : 2;
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

export interface GameScreenOptions {
  snapshot: Snapshot | null;
  submitAction: (action: Action) => void;
  subscribe?: (listener: (snapshot: Snapshot | null) => void) => () => void;
  subscribeEvents?: (listener: (events: Event[]) => void) => () => void;
}

export class GameScreen extends Container implements Screen {
  private readonly focus = new FocusManager();
  private readonly waiting: Text;
  private readonly opponentRow: Container;
  private readonly tableRow: Container;
  private readonly leftStack: Container;
  private readonly rightStack: Container;
  private readonly myHandRow: Container;
  private readonly submitAction: (action: Action) => void;
  private readonly extraKeysHandler: (event: KeyboardEvent) => void;
  private readonly subscribeUnsub: (() => void) | null;
  private readonly subscribeEventsUnsub: (() => void) | null;
  private snapshot: Snapshot | null;
  private viewWidth = 0;
  private viewHeight = 0;

  constructor(options: GameScreenOptions) {
    super();
    this.snapshot = options.snapshot;
    this.submitAction = options.submitAction;

    this.waiting = new Text({
      text: "WAITING FOR GAME...",
      style: {
        fontFamily: typography.family,
        fontSize: typography.size.lg,
        fill: color.textMuted,
        letterSpacing: typography.letterSpacing.wide,
      },
    });
    this.addChild(this.waiting);

    this.opponentRow = new Container();
    this.tableRow = new Container();
    this.leftStack = new Container();
    this.rightStack = new Container();
    this.myHandRow = new Container();

    this.opponentRow.label = "opponent-hand";
    this.tableRow.label = "table";
    this.leftStack.label = "talon";
    this.rightStack.label = "discard";
    this.myHandRow.label = "my-hand";

    this.addChild(this.opponentRow);
    this.addChild(this.tableRow);
    this.addChild(this.leftStack);
    this.addChild(this.rightStack);
    this.addChild(this.myHandRow);

    this.extraKeysHandler = (event) => this.handleKeyDown(event);
    window.addEventListener("keydown", this.extraKeysHandler);

    this.subscribeUnsub = options.subscribe ? options.subscribe((s) => this.update(s)) : null;
    this.subscribeEventsUnsub = options.subscribeEvents
      ? options.subscribeEvents((events) => this.handleEvents(events))
      : null;

    this.focus.attach();
    this.render();
  }

  layout(viewWidth: number, viewHeight: number): void {
    this.viewWidth = viewWidth;
    this.viewHeight = viewHeight;
    this.layoutSections();
  }

  dispose(): void {
    window.removeEventListener("keydown", this.extraKeysHandler);
    this.subscribeUnsub?.();
    this.subscribeEventsUnsub?.();
    this.focus.detach();
    this.focus.clear();
  }

  update(snapshot: Snapshot | null): void {
    this.snapshot = snapshot;
    this.render();
    this.layoutSections();
  }

  private handleEvents(events: Event[]): void {
    for (const event of events) this.handleEvent(event);
  }

  private handleEvent(event: Event): void {
    switch (event.type) {
      case "CARD_PLAYED":
        playSfx("playCard");
        return;
      case "PILE_TAKEN":
        playSfx("takePile");
        return;
      case "GAME_OVER": {
        if (event.durak === null) return;
        const seat = this.snapshot?.you.seat;
        if (seat === undefined) return;
        playSfx(event.durak === seat ? "lose" : "win");
        return;
      }
      default:
        return;
    }
  }

  private render(): void {
    this.opponentRow.removeChildren();
    this.tableRow.removeChildren();
    this.leftStack.removeChildren();
    this.rightStack.removeChildren();
    this.myHandRow.removeChildren();
    this.focus.clear();

    const snapshot = this.snapshot;
    if (!snapshot) {
      this.waiting.visible = true;
      this.opponentRow.visible = false;
      this.tableRow.visible = false;
      this.leftStack.visible = false;
      this.rightStack.visible = false;
      this.myHandRow.visible = false;
      return;
    }

    this.waiting.visible = false;
    this.opponentRow.visible = true;
    this.tableRow.visible = true;
    this.leftStack.visible = true;
    this.rightStack.visible = true;
    this.myHandRow.visible = true;

    this.renderOpponentHand(snapshot);
    this.renderTable(snapshot);
    this.renderTalonAndTrump(snapshot);
    this.renderDiscard(snapshot);
    this.renderMyHand(snapshot);
  }

  private renderOpponentHand(snapshot: Snapshot): void {
    const opponent = nextSeat(snapshot.seat, snapshot.playerCount);
    const count = snapshot.handCounts[opponent] ?? 0;
    for (let i = 0; i < count; i += 1) {
      const card = new CardView(null, true);
      card.x = i * (CARD_W + HAND_GAP);
      this.opponentRow.addChild(card);
    }
  }

  private renderTable(snapshot: Snapshot): void {
    const pairColumnWidth = CARD_W + HAND_GAP;
    snapshot.table.forEach((pair: TablePair, i: number) => {
      const attackView = new CardView(pair.attack);
      attackView.x = i * pairColumnWidth;
      attackView.y = 0;
      this.tableRow.addChild(attackView);
      if (pair.defense) {
        const defenseView = new CardView(pair.defense);
        defenseView.x = i * pairColumnWidth + Math.round(CARD_W * 0.25);
        defenseView.y = Math.round(CARD_H * 0.4);
        this.tableRow.addChild(defenseView);
      }
    });
  }

  private renderTalonAndTrump(snapshot: Snapshot): void {
    const talonText = new Text({
      text: `TALON ${snapshot.talonCount}`,
      style: {
        fontFamily: typography.family,
        fontSize: typography.size.xs,
        fill: color.textMuted,
        letterSpacing: typography.letterSpacing.wide,
      },
    });
    this.leftStack.addChild(talonText);

    if (snapshot.talonCount > 0) {
      const stack = new CardView(null, true);
      stack.y = talonText.height + spacing.xs;
      this.leftStack.addChild(stack);
    }

    if (snapshot.trump !== null) {
      const trumpView = new CardView(snapshot.trump);
      trumpView.label = "trump-card";
      trumpView.x = snapshot.talonCount > 0 ? Math.round(CARD_W * 0.5) : 0;
      trumpView.y = talonText.height + spacing.xs + Math.round(CARD_H * 0.25);
      trumpView.rotation = Math.PI / 2;
      trumpView.x += CARD_H;
      this.leftStack.addChild(trumpView);
    } else {
      const badge = this.renderTrumpSuitBadge(snapshot.trumpSuit);
      badge.x = 0;
      badge.y = talonText.height + spacing.xs + Math.round(CARD_H * 0.25);
      this.leftStack.addChild(badge);
    }

    const trumpLabel = new Text({
      text: `TRUMP ${SUIT_GLYPH[snapshot.trumpSuit]}`,
      style: {
        fontFamily: typography.family,
        fontSize: typography.size.xs,
        fill: color.accent,
        letterSpacing: typography.letterSpacing.wide,
      },
    });
    trumpLabel.x = 0;
    trumpLabel.y = talonText.height + spacing.xs + CARD_H + spacing.lg;
    this.leftStack.addChild(trumpLabel);
  }

  private renderTrumpSuitBadge(suit: Snapshot["trumpSuit"]): Container {
    const badge = new Container();
    badge.label = "trump-badge";
    const bg = new Graphics();
    bg.roundRect(0, 0, CARD_H, CARD_W, 4)
      .fill({ color: color.bgRaised })
      .stroke({ color: color.accent, width: 2, alignment: 0 });
    badge.addChild(bg);
    const fill = suit === "hearts" || suit === "diamonds" ? color.danger : color.text;
    const glyph = new Text({
      text: SUIT_GLYPH[suit],
      style: {
        fontFamily: typography.family,
        fontSize: typography.size.xl,
        fontWeight: typography.weight.bold,
        fill,
      },
    });
    glyph.x = Math.round((CARD_H - glyph.width) / 2);
    glyph.y = Math.round((CARD_W - glyph.height) / 2);
    badge.addChild(glyph);
    return badge;
  }

  private renderDiscard(snapshot: Snapshot): void {
    const label = new Text({
      text: `DISCARD ${snapshot.discard.length}`,
      style: {
        fontFamily: typography.family,
        fontSize: typography.size.xs,
        fill: color.textMuted,
        letterSpacing: typography.letterSpacing.wide,
      },
    });
    this.rightStack.addChild(label);

    if (snapshot.discard.length > 0) {
      const back = new CardView(null, true);
      back.y = label.height + spacing.xs;
      this.rightStack.addChild(back);
    }
  }

  private renderMyHand(snapshot: Snapshot): void {
    const hand = snapshot.you.hand;
    hand.forEach((card, i) => {
      const view = new CardView(card);
      view.x = i * (CARD_W + HAND_GAP);
      view.onActivate = () => this.tryPlayCard(card);
      this.myHandRow.addChild(view);
      this.focus.register(view);
    });
  }

  private layoutSections(): void {
    this.waiting.x = Math.round((this.viewWidth - this.waiting.width) / 2);
    this.waiting.y = Math.round((this.viewHeight - this.waiting.height) / 2);

    if (!this.snapshot) return;

    const opW = this.opponentRow.width;
    this.opponentRow.x = Math.round((this.viewWidth - opW) / 2);
    this.opponentRow.y = SECTION_PADDING;

    const tableW = this.tableRow.width;
    this.tableRow.x = Math.round((this.viewWidth - tableW) / 2);
    this.tableRow.y = Math.round(this.viewHeight / 2 - CARD_H / 2);

    this.leftStack.x = SECTION_PADDING;
    this.leftStack.y = Math.round(this.viewHeight / 2 - CARD_H / 2);

    this.rightStack.x = this.viewWidth - SECTION_PADDING - CARD_W;
    this.rightStack.y = Math.round(this.viewHeight / 2 - CARD_H / 2);

    const handW = this.myHandRow.width;
    this.myHandRow.x = Math.round((this.viewWidth - handW) / 2);
    this.myHandRow.y = this.viewHeight - SECTION_PADDING - CARD_H;
  }

  private handleKeyDown(event: KeyboardEvent): void {
    if (!this.snapshot) return;
    const key = event.key.toLowerCase();
    if (key === "t") {
      event.preventDefault();
      this.submitAction({ type: "TAKE_PILE", by: this.snapshot.seat });
      return;
    }
    if (key === "e") {
      event.preventDefault();
      this.submitAction({ type: "END_ROUND", by: this.snapshot.seat });
    }
  }

  private tryPlayCard(card: Card): void {
    const snapshot = this.snapshot;
    if (!snapshot) return;
    const action = legalPlay(snapshot, card);
    if (!action) return;
    this.submitAction(action);
  }
}

function nextSeat(seat: SeatIndex, playerCount: number): SeatIndex {
  return (seat + 1) % playerCount;
}

function legalPlay(snapshot: Snapshot, card: Card): Action | null {
  const { seat, attacker, defender, table } = snapshot;
  if (seat === defender) {
    const targetIndex = table.findIndex((p) => !p.defense);
    if (targetIndex < 0) return null;
    return { type: "DEFEND", by: seat, card, target: targetIndex };
  }
  if (seat === attacker && table.length === 0) {
    return { type: "ATTACK", by: seat, card };
  }
  return null;
}
