import { type Action, beats, type Card, type Event, type TablePair } from "@durak/engine";
import type { DisconnectState, SeatIndex, Snapshot } from "@durak/protocol";
import { color, type Focusable, FocusManager, spacing, typography } from "@durak/ui";
import { Container, Graphics, Text, Ticker } from "pixi.js";
import { attachFocusNavSfx, playSfx } from "../audio/index.js";
import { appStore, type RoomMembership, type ServerError } from "../store.js";
import type { Screen } from "./types.js";

const CARD_W = 60;
const CARD_H = 88;
const HAND_GAP = 6;
const SECTION_PADDING = spacing.lg;

const FLASH_DURATION_MS = 180;
const ERROR_TOAST_MS = 3000;
const TURN_PULSE_PERIOD_MS = 1200;
const ILLEGAL_ALPHA = 0.45;

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

function cardKey(card: Card): string {
  return `${card.suit}-${card.rank}`;
}

class CardView extends Container implements Focusable {
  private readonly bg: Graphics;
  private readonly cornerText: Text;
  private readonly centerText: Text;
  private focused = false;
  private legalState: "neutral" | "legal" | "illegal" = "neutral";
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

  setLegalState(state: "neutral" | "legal" | "illegal"): void {
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

interface FlashState {
  view: CardView;
  pivotX: number;
  pivotY: number;
  elapsed: number;
}

export interface GameScreenOptions {
  snapshot: Snapshot | null;
  submitAction: (action: Action) => void;
  subscribe?: (listener: (snapshot: Snapshot | null) => void) => () => void;
  subscribeEvents?: (listener: (events: Event[]) => void) => () => void;
  /** Test seam: subscribe to lastError changes. Defaults to appStore. */
  subscribeError?: (listener: (error: ServerError | null) => void) => () => void;
  /** Initial room membership (carries the disconnect banner state). */
  initialRoom?: RoomMembership | null;
  /** Test seam: subscribe to room-membership changes. Defaults to appStore. */
  subscribeRoom?: (listener: (room: RoomMembership | null) => void) => () => void;
  /** Test seam: replaces Ticker.shared. */
  ticker?: Ticker;
  /** Test seam: replaces Date.now() for the disconnect countdown. */
  now?: () => number;
}

export class GameScreen extends Container implements Screen {
  private readonly focus = new FocusManager();
  private readonly waiting: Text;
  private readonly turnLabel: Text;
  private readonly keyHint: Text;
  private readonly errorBanner: Container;
  private readonly errorBannerBg: Graphics;
  private readonly errorBannerText: Text;
  private readonly disconnectBanner: Container;
  private readonly disconnectBannerBg: Graphics;
  private readonly disconnectBannerText: Text;
  private readonly opponentRow: Container;
  private readonly tableRow: Container;
  private readonly leftStack: Container;
  private readonly rightStack: Container;
  private readonly myHandRow: Container;
  private readonly submitAction: (action: Action) => void;
  private readonly extraKeysHandler: (event: KeyboardEvent) => void;
  private readonly subscribeUnsub: (() => void) | null;
  private readonly subscribeEventsUnsub: (() => void) | null;
  private readonly subscribeErrorUnsub: (() => void) | null;
  private readonly detachFocusNavSfx: () => void;
  private readonly subscribeRoomUnsub: (() => void) | null;
  private readonly now: () => number;
  private disconnect: DisconnectState | null = null;
  private readonly ticker: Ticker;
  private readonly tickCallback: () => void;
  private readonly flashes: FlashState[] = [];
  private snapshot: Snapshot | null;
  private prevTableKeys: Set<string>;
  private isInitialRender = true;
  private viewWidth = 0;
  private viewHeight = 0;
  private turnPulseElapsed = 0;
  private turnPulseActive = false;
  private errorVisibleMs = 0;

  constructor(options: GameScreenOptions) {
    super();
    this.snapshot = options.snapshot;
    this.submitAction = options.submitAction;
    this.prevTableKeys = new Set();

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

    this.turnLabel = new Text({
      text: "",
      style: {
        fontFamily: typography.family,
        fontSize: typography.size.md,
        fontWeight: typography.weight.bold,
        fill: color.accent,
        letterSpacing: typography.letterSpacing.wide,
      },
    });
    this.turnLabel.label = "turn-label";
    this.turnLabel.visible = false;
    this.addChild(this.turnLabel);

    this.keyHint = new Text({
      text: "",
      style: {
        fontFamily: typography.family,
        fontSize: typography.size.xs,
        fill: color.textMuted,
        letterSpacing: typography.letterSpacing.wide,
      },
    });
    this.keyHint.label = "key-hint";
    this.keyHint.visible = false;
    this.addChild(this.keyHint);

    this.errorBanner = new Container();
    this.errorBanner.label = "error-banner";
    this.errorBanner.visible = false;
    this.errorBannerBg = new Graphics();
    this.errorBannerText = new Text({
      text: "",
      style: {
        fontFamily: typography.family,
        fontSize: typography.size.sm,
        fontWeight: typography.weight.bold,
        fill: color.text,
        letterSpacing: typography.letterSpacing.wide,
      },
    });
    this.errorBanner.addChild(this.errorBannerBg);
    this.errorBanner.addChild(this.errorBannerText);
    this.addChild(this.errorBanner);

    this.disconnectBanner = new Container();
    this.disconnectBanner.label = "disconnect-banner";
    this.disconnectBanner.visible = false;
    this.disconnectBannerBg = new Graphics();
    this.disconnectBannerText = new Text({
      text: "",
      style: {
        fontFamily: typography.family,
        fontSize: typography.size.sm,
        fontWeight: typography.weight.bold,
        fill: color.text,
        letterSpacing: typography.letterSpacing.wide,
      },
    });
    this.disconnectBanner.addChild(this.disconnectBannerBg);
    this.disconnectBanner.addChild(this.disconnectBannerText);
    this.addChild(this.disconnectBanner);

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

    const subscribeError =
      options.subscribeError ??
      ((listener) =>
        appStore.subscribe((next, prev) => {
          if (next.lastError !== prev.lastError) listener(next.lastError);
        }));
    this.subscribeErrorUnsub = subscribeError((error) => this.handleError(error));

    const subscribeRoom =
      options.subscribeRoom ??
      ((listener) =>
        appStore.subscribe((next, prev) => {
          if (next.room !== prev.room) listener(next.room);
        }));
    const initialRoom = options.initialRoom ?? appStore.getState().room;
    this.disconnect = initialRoom?.disconnect ?? null;
    this.subscribeRoomUnsub = subscribeRoom((room) => this.handleRoom(room));

    this.now = options.now ?? (() => Date.now());

    this.ticker = options.ticker ?? Ticker.shared;
    this.tickCallback = () => this.onTick(this.ticker.deltaMS);
    this.ticker.add(this.tickCallback);

    this.focus.attach();
    this.detachFocusNavSfx = attachFocusNavSfx(this.focus);
    this.render();
    this.renderDisconnectBanner();
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
    this.subscribeErrorUnsub?.();
    this.detachFocusNavSfx();
    this.subscribeRoomUnsub?.();
    this.ticker.remove(this.tickCallback);
    this.flashes.length = 0;
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
      case "GAME_STARTED":
        playSfx("dealStart");
        return;
      case "TALON_DRAWN":
        playSfx("talonDraw");
        return;
      case "ROUND_ENDED":
        playSfx("roundEnd");
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

  private handleRoom(room: RoomMembership | null): void {
    this.disconnect = room?.disconnect ?? null;
    this.renderDisconnectBanner();
    this.layoutSections();
  }

  private renderDisconnectBanner(): void {
    if (!this.disconnect) {
      this.disconnectBanner.visible = false;
      return;
    }
    const remaining = Math.max(0, Math.ceil((this.disconnect.forfeitAt - this.now()) / 1000));
    this.disconnectBannerText.text = `Opponent disconnected — forfeit in ${remaining}s`;
    const padX = spacing.md;
    const padY = spacing.sm;
    const w = Math.round(this.disconnectBannerText.width + padX * 2);
    const h = Math.round(this.disconnectBannerText.height + padY * 2);
    this.disconnectBannerBg
      .clear()
      .roundRect(0, 0, w, h, 4)
      .fill({ color: color.bgRaised })
      .stroke({ color: color.danger, width: 2, alignment: 0 });
    this.disconnectBannerText.x = padX;
    this.disconnectBannerText.y = padY;
    this.disconnectBanner.visible = true;
  }

  private handleError(error: ServerError | null): void {
    if (!error) {
      this.errorBanner.visible = false;
      this.errorVisibleMs = 0;
      return;
    }
    this.errorBannerText.text = `${error.code}: ${error.message}`;
    this.drawErrorBanner();
    this.errorBanner.visible = true;
    this.errorVisibleMs = 0;
    this.layoutSections();
    playSfx("actionError");
  }

  private drawErrorBanner(): void {
    const padX = spacing.md;
    const padY = spacing.sm;
    const w = Math.round(this.errorBannerText.width + padX * 2);
    const h = Math.round(this.errorBannerText.height + padY * 2);
    this.errorBannerBg
      .clear()
      .roundRect(0, 0, w, h, 4)
      .fill({ color: color.bgRaised })
      .stroke({ color: color.accent, width: 2, alignment: 0 });
    this.errorBannerText.x = padX;
    this.errorBannerText.y = padY;
  }

  private onTick(deltaMs: number): void {
    if (this.turnPulseActive) {
      this.turnPulseElapsed = (this.turnPulseElapsed + deltaMs) % TURN_PULSE_PERIOD_MS;
      const phase = (this.turnPulseElapsed / TURN_PULSE_PERIOD_MS) * Math.PI * 2;
      this.turnLabel.alpha = 0.7 + 0.3 * (0.5 + 0.5 * Math.cos(phase));
    }

    if (this.flashes.length > 0) {
      for (let i = this.flashes.length - 1; i >= 0; i -= 1) {
        const flash = this.flashes[i];
        if (!flash) continue;
        flash.elapsed += deltaMs;
        const t = Math.min(1, flash.elapsed / FLASH_DURATION_MS);
        const eased = 1 - (1 - t) * (1 - t) * (1 - t);
        const scale = 0.85 + 0.15 * eased;
        flash.view.scale.set(scale);
        flash.view.alpha = eased;
        if (t >= 1) {
          flash.view.scale.set(1);
          flash.view.alpha = 1;
          this.flashes.splice(i, 1);
        }
      }
    }

    if (this.errorBanner.visible) {
      this.errorVisibleMs += deltaMs;
      if (this.errorVisibleMs >= ERROR_TOAST_MS) {
        this.errorBanner.visible = false;
        this.errorVisibleMs = 0;
        appStore.getState().clearError();
      }
    }

    if (this.disconnect !== null) {
      this.renderDisconnectBanner();
    }
  }

  private render(): void {
    this.opponentRow.removeChildren();
    this.tableRow.removeChildren();
    this.leftStack.removeChildren();
    this.rightStack.removeChildren();
    this.myHandRow.removeChildren();
    this.flashes.length = 0;
    this.focus.clear();

    const snapshot = this.snapshot;
    if (!snapshot) {
      this.waiting.visible = true;
      this.opponentRow.visible = false;
      this.tableRow.visible = false;
      this.leftStack.visible = false;
      this.rightStack.visible = false;
      this.myHandRow.visible = false;
      this.turnLabel.visible = false;
      this.keyHint.visible = false;
      this.turnPulseActive = false;
      this.prevTableKeys = new Set();
      this.isInitialRender = true;
      return;
    }

    this.waiting.visible = false;
    this.opponentRow.visible = true;
    this.tableRow.visible = true;
    this.leftStack.visible = true;
    this.rightStack.visible = true;
    this.myHandRow.visible = true;
    this.turnLabel.visible = true;
    this.keyHint.visible = true;

    this.renderOpponentHand(snapshot);
    this.renderTable(snapshot);
    this.renderTalonAndTrump(snapshot);
    this.renderDiscard(snapshot);
    this.renderMyHand(snapshot);
    this.renderTurnLabel(snapshot);
    this.renderKeyHint(snapshot);

    this.prevTableKeys = collectTableKeys(snapshot.table);
    this.isInitialRender = false;
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
      this.maybeFlash(attackView, pair.attack);
      if (pair.defense) {
        const defenseView = new CardView(pair.defense);
        defenseView.x = i * pairColumnWidth + Math.round(CARD_W * 0.25);
        defenseView.y = Math.round(CARD_H * 0.4);
        this.tableRow.addChild(defenseView);
        this.maybeFlash(defenseView, pair.defense);
      }
    });
  }

  private maybeFlash(view: CardView, card: Card): void {
    if (this.isInitialRender) return;
    if (this.prevTableKeys.has(cardKey(card))) return;
    const pivotX = CARD_W / 2;
    const pivotY = CARD_H / 2;
    view.pivot.set(pivotX, pivotY);
    view.x += pivotX;
    view.y += pivotY;
    view.scale.set(0.85);
    view.alpha = 0;
    this.flashes.push({ view, pivotX, pivotY, elapsed: 0 });
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
      const isLegal = legalPlay(snapshot, card) !== null;
      view.setLegalState(isLegal ? "legal" : "illegal");
      this.myHandRow.addChild(view);
      this.focus.register(view);
    });
  }

  private renderTurnLabel(snapshot: Snapshot): void {
    const text = turnLabelFor(snapshot);
    this.turnLabel.text = text;
    const isMyTurn = text.startsWith("Your turn");
    this.turnPulseActive = isMyTurn;
    this.turnPulseElapsed = 0;
    this.turnLabel.alpha = 1;
  }

  private renderKeyHint(snapshot: Snapshot): void {
    this.keyHint.text = keyHintFor(snapshot);
  }

  private layoutSections(): void {
    this.waiting.x = Math.round((this.viewWidth - this.waiting.width) / 2);
    this.waiting.y = Math.round((this.viewHeight - this.waiting.height) / 2);

    if (!this.snapshot) return;

    const opW = this.opponentRow.width;
    this.opponentRow.x = Math.round((this.viewWidth - opW) / 2);
    this.opponentRow.y = SECTION_PADDING;

    this.turnLabel.x = Math.round((this.viewWidth - this.turnLabel.width) / 2);
    this.turnLabel.y = Math.round(
      this.viewHeight / 2 - CARD_H / 2 - this.turnLabel.height - spacing.sm,
    );

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

    this.keyHint.x = Math.round((this.viewWidth - this.keyHint.width) / 2);
    this.keyHint.y = this.myHandRow.y - this.keyHint.height - spacing.sm;

    if (this.errorBanner.visible) {
      const bw = this.errorBanner.width;
      this.errorBanner.x = Math.round((this.viewWidth - bw) / 2);
      this.errorBanner.y = this.keyHint.y - this.errorBanner.height - spacing.sm;
    }

    if (this.disconnectBanner.visible) {
      const dw = this.disconnectBanner.width;
      this.disconnectBanner.x = Math.round((this.viewWidth - dw) / 2);
      this.disconnectBanner.y = this.opponentRow.y + this.opponentRow.height + spacing.md;
    }
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

function collectTableKeys(table: TablePair[]): Set<string> {
  const keys = new Set<string>();
  for (const pair of table) {
    keys.add(cardKey(pair.attack));
    if (pair.defense) keys.add(cardKey(pair.defense));
  }
  return keys;
}

function ranksOnTable(table: TablePair[]): Set<number> {
  const ranks = new Set<number>();
  for (const pair of table) {
    ranks.add(pair.attack.rank);
    if (pair.defense) ranks.add(pair.defense.rank);
  }
  return ranks;
}

function hasLegalThrowIn(snapshot: Snapshot): boolean {
  const ranks = ranksOnTable(snapshot.table);
  return snapshot.you.hand.some((card) => ranks.has(card.rank));
}

function hasLegalDefense(snapshot: Snapshot): boolean {
  const target = snapshot.table.find((p) => !p.defense);
  if (!target) return false;
  return snapshot.you.hand.some((card) => beats(card, target.attack, snapshot.trumpSuit));
}

function turnLabelFor(snapshot: Snapshot): string {
  const { seat, attacker, defender, table } = snapshot;
  if (seat === defender) {
    const hasUnbeaten = table.some((p) => !p.defense);
    if (hasUnbeaten) return "Your turn — defend";
    return "Opponent's turn";
  }
  if (seat === attacker) {
    if (table.length === 0) return "Your turn — attack";
    return "Your turn — throw in or pass";
  }
  return "Opponent's turn";
}

function keyHintFor(snapshot: Snapshot): string {
  const { seat, attacker, defender, table } = snapshot;
  const muteHint = "M: mute";
  if (seat === attacker) {
    if (table.length === 0) {
      return `Arrow keys: select  •  Enter: attack  •  ${muteHint}`;
    }
    if (hasLegalThrowIn(snapshot)) {
      return `Arrow keys: select  •  Enter: throw in  •  E: end round  •  ${muteHint}`;
    }
    return `E: end round  •  ${muteHint}`;
  }
  if (seat === defender) {
    if (hasLegalDefense(snapshot)) {
      return `Arrow keys: select  •  Enter: defend  •  T: take pile  •  ${muteHint}`;
    }
    if (table.some((p) => !p.defense)) {
      return `T: take pile  •  ${muteHint}`;
    }
    return muteHint;
  }
  return muteHint;
}

function legalPlay(snapshot: Snapshot, card: Card): Action | null {
  const { seat, attacker, defender, table } = snapshot;
  if (seat === defender) {
    const targetIndex = table.findIndex((p) => !p.defense);
    if (targetIndex < 0) return null;
    const target = table[targetIndex];
    if (!target) return null;
    if (!beats(card, target.attack, snapshot.trumpSuit)) return null;
    return { type: "DEFEND", by: seat, card, target: targetIndex };
  }
  if (seat === attacker) {
    if (table.length === 0) {
      return { type: "ATTACK", by: seat, card };
    }
    // Throw-in: attacker may add a card whose rank already appears on the
    // table. Server enforces full rule set (max throw-ins, defender hand
    // size cap); this is a UX gate.
    const ranks = ranksOnTable(table);
    if (ranks.has(card.rank)) {
      return { type: "THROW_IN", by: seat, card };
    }
  }
  return null;
}

export { keyHintFor, legalPlay, turnLabelFor };
