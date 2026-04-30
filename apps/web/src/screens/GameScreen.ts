import { type Action, beats, type Card, type Event, type TablePair } from "@durak/engine";
import type { DisconnectState, SeatIndex, Snapshot } from "@durak/protocol";
import { color, type Focusable, FocusManager, spacing, typography } from "@durak/ui";
import { Container, Graphics, Text, Ticker } from "pixi.js";
import {
  type Anim,
  easeOutBack,
  fadeTo,
  moveTo,
  parallel,
  type TweenHandle,
} from "../anim/index.js";
import { attachFocusNavSfx, playSfx } from "../audio/index.js";
import { appStore, type RoomMembership, type ServerError } from "../store.js";
import type { Screen } from "./types.js";

const CARD_W = 60;
const CARD_H = 88;
const HAND_GAP = 6;
const SECTION_PADDING = spacing.lg;

const ERROR_TOAST_MS = 3000;
const TURN_PULSE_PERIOD_MS = 1200;
const ILLEGAL_ALPHA = 0.45;

const FADE_IN_MS = 80;
const PLAY_MOVE_MS = 220;
const TAKE_MOVE_MS = 280;
const ROUND_END_MOVE_MS = 280;
const TALON_PER_CARD_MS = 200;
const TALON_STAGGER_MS = 50;
const DEAL_PER_CARD_MS = 220;
const DEAL_STAGGER_MS = 35;

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
  private readonly animLayer: Container;
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
  private readonly activeAnims: TweenHandle[] = [];
  private readonly animSpeed: () => number;
  private snapshot: Snapshot | null;
  private prevSnapshot: Snapshot | null = null;
  private viewWidth = 0;
  private viewHeight = 0;
  private turnPulseElapsed = 0;
  private turnPulseActive = false;
  private errorVisibleMs = 0;

  constructor(options: GameScreenOptions) {
    super();
    this.snapshot = options.snapshot;
    this.submitAction = options.submitAction;
    this.animSpeed = () => appStore.getState().devtools.animSpeed;

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
    this.animLayer = new Container();

    this.opponentRow.label = "opponent-hand";
    this.tableRow.label = "table";
    this.leftStack.label = "talon";
    this.rightStack.label = "discard";
    this.myHandRow.label = "my-hand";
    this.animLayer.label = "anim-layer";

    this.addChild(this.opponentRow);
    this.addChild(this.tableRow);
    this.addChild(this.leftStack);
    this.addChild(this.rightStack);
    this.addChild(this.myHandRow);
    this.addChild(this.animLayer);

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
    this.cancelAnims();
    this.focus.detach();
    this.focus.clear();
  }

  update(snapshot: Snapshot | null): void {
    this.cancelAnims();
    this.prevSnapshot = this.snapshot;
    this.snapshot = snapshot;
    this.render();
    this.layoutSections();
  }

  private cancelAnims(): void {
    for (const handle of this.activeAnims) handle.cancel();
    this.activeAnims.length = 0;
    this.animLayer.removeChildren();
  }

  private handleEvents(events: Event[]): void {
    for (const event of events) {
      this.playEventSfx(event);
      this.animateEvent(event);
    }
  }

  private playEventSfx(event: Event): void {
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

  private animateEvent(event: Event): void {
    if (this.animSpeed() === 0) return;
    switch (event.type) {
      case "CARD_PLAYED":
        this.animateCardPlayed(event);
        return;
      case "PILE_TAKEN":
        this.animatePileTaken(event);
        return;
      case "ROUND_ENDED":
        this.animateRoundEnded(event);
        return;
      case "TALON_DRAWN":
        this.animateTalonDrawn(event);
        return;
      case "GAME_STARTED":
        this.animateGameStarted();
        return;
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

  private animateCardPlayed(event: Extract<Event, { type: "CARD_PLAYED" }>): void {
    const snapshot = this.snapshot;
    if (!snapshot) return;
    const view = this.findTableCardView(event.card);
    if (!view) return;

    const targetX = view.x;
    const targetY = view.y;
    const sourceWorld = this.handRowWorldCenter(event.by);
    const sourceX = sourceWorld.x - this.tableRow.x;
    const sourceY = sourceWorld.y - this.tableRow.y;

    view.x = sourceX;
    view.y = sourceY;
    view.alpha = 0;

    const handle = parallel([
      this.tweenAnim((onComplete) =>
        fadeTo(view, 1, FADE_IN_MS, undefined, this.tweenOpts(onComplete)),
      ),
      this.tweenAnim((onComplete) =>
        moveTo(view, targetX, targetY, PLAY_MOVE_MS, easeOutBack, this.tweenOpts(onComplete)),
      ),
    ]);
    this.activeAnims.push(handle);
  }

  private animatePileTaken(event: Extract<Event, { type: "PILE_TAKEN" }>): void {
    const prev = this.prevSnapshot;
    if (!prev || prev.table.length === 0) return;

    const dest = this.handRowWorldCenter(event.by);
    const ghosts = this.spawnTableGhosts(prev);
    const animsList: Anim[] = ghosts.map((g) => this.takeGhostAnim(g, dest));

    if (animsList.length === 0) return;
    const handle = parallel(animsList, () => {
      for (const g of ghosts) this.animLayer.removeChild(g);
    });
    this.activeAnims.push(handle);
  }

  private animateRoundEnded(_event: Extract<Event, { type: "ROUND_ENDED" }>): void {
    const prev = this.prevSnapshot;
    if (!prev || prev.table.length === 0) return;

    const dest = this.discardWorldPos();
    const ghosts = this.spawnTableGhosts(prev);
    const animsList: Anim[] = ghosts.map((g) => this.discardGhostAnim(g, dest));

    if (animsList.length === 0) return;
    const handle = parallel(animsList, () => {
      for (const g of ghosts) this.animLayer.removeChild(g);
    });
    this.activeAnims.push(handle);
  }

  private animateTalonDrawn(event: Extract<Event, { type: "TALON_DRAWN" }>): void {
    const snapshot = this.snapshot;
    if (!snapshot) return;
    const drawn = event.cards;
    if (drawn.length === 0) return;

    const sourceWorld = this.talonWorldPos();
    const isYou = event.by === snapshot.you.seat;
    const row = isYou ? this.myHandRow : this.opponentRow;
    const sourceX = sourceWorld.x - row.x;
    const sourceY = sourceWorld.y - row.y;

    const targets: { view: Container; finalX: number; finalY: number }[] = [];

    if (isYou) {
      for (const card of drawn) {
        const v = this.findHandCardView(card);
        if (!v) continue;
        targets.push({ view: v, finalX: v.x, finalY: v.y });
      }
    } else {
      const childCount = row.children.length;
      const startIdx = Math.max(0, childCount - drawn.length);
      for (let i = startIdx; i < childCount; i += 1) {
        const v = row.children[i] as Container | undefined;
        if (!v) continue;
        targets.push({ view: v, finalX: v.x, finalY: v.y });
      }
    }

    if (targets.length === 0) return;

    for (const t of targets) {
      t.view.x = sourceX;
      t.view.y = sourceY;
    }

    const animsList: Anim[] = targets.map(
      (t, i): Anim =>
        (onComplete) =>
          moveTo(
            t.view,
            t.finalX,
            t.finalY,
            TALON_PER_CARD_MS + i * TALON_STAGGER_MS,
            easeOutBack,
            this.tweenOpts(onComplete),
          ),
    );

    const handle = parallel(animsList);
    this.activeAnims.push(handle);
  }

  private animateGameStarted(): void {
    const snapshot = this.snapshot;
    if (!snapshot) return;

    const sourceWorld = this.talonWorldPos();
    const targets: { view: Container; row: Container; finalX: number; finalY: number }[] = [];

    for (const child of this.myHandRow.children) {
      const v = child as Container;
      targets.push({ view: v, row: this.myHandRow, finalX: v.x, finalY: v.y });
    }
    for (const child of this.opponentRow.children) {
      const v = child as Container;
      targets.push({ view: v, row: this.opponentRow, finalX: v.x, finalY: v.y });
    }

    if (targets.length === 0) return;

    for (const t of targets) {
      t.view.x = sourceWorld.x - t.row.x;
      t.view.y = sourceWorld.y - t.row.y;
    }

    const animsList: Anim[] = targets.map(
      (t, i): Anim =>
        (onComplete) =>
          moveTo(
            t.view,
            t.finalX,
            t.finalY,
            DEAL_PER_CARD_MS + i * DEAL_STAGGER_MS,
            easeOutBack,
            this.tweenOpts(onComplete),
          ),
    );

    const handle = parallel(animsList);
    this.activeAnims.push(handle);
  }

  private spawnTableGhosts(snapshot: Snapshot): Container[] {
    const pairColumnWidth = CARD_W + HAND_GAP;
    const ghosts: Container[] = [];
    snapshot.table.forEach((pair: TablePair, i: number) => {
      const a = new CardView(pair.attack);
      a.x = this.tableRow.x + i * pairColumnWidth;
      a.y = this.tableRow.y;
      this.animLayer.addChild(a);
      ghosts.push(a);
      if (pair.defense) {
        const d = new CardView(pair.defense);
        d.x = this.tableRow.x + i * pairColumnWidth + Math.round(CARD_W * 0.25);
        d.y = this.tableRow.y + Math.round(CARD_H * 0.4);
        this.animLayer.addChild(d);
        ghosts.push(d);
      }
    });
    return ghosts;
  }

  private takeGhostAnim(view: Container, dest: { x: number; y: number }): Anim {
    return (onComplete) =>
      parallel(
        [
          this.tweenAnim((cb) =>
            moveTo(view, dest.x, dest.y, TAKE_MOVE_MS, easeOutBack, this.tweenOpts(cb)),
          ),
          this.tweenAnim((cb) => fadeTo(view, 0, TAKE_MOVE_MS, undefined, this.tweenOpts(cb))),
        ],
        onComplete,
      );
  }

  private discardGhostAnim(view: Container, dest: { x: number; y: number }): Anim {
    return (onComplete) =>
      parallel(
        [
          this.tweenAnim((cb) =>
            moveTo(view, dest.x, dest.y, ROUND_END_MOVE_MS, easeOutBack, this.tweenOpts(cb)),
          ),
          this.tweenAnim((cb) => fadeTo(view, 0, ROUND_END_MOVE_MS, undefined, this.tweenOpts(cb))),
        ],
        onComplete,
      );
  }

  private findTableCardView(card: Card): CardView | undefined {
    for (const child of this.tableRow.children) {
      const v = child as CardView;
      if (v.card && cardKey(v.card) === cardKey(card)) return v;
    }
    return undefined;
  }

  private findHandCardView(card: Card): CardView | undefined {
    for (const child of this.myHandRow.children) {
      const v = child as CardView;
      if (v.card && cardKey(v.card) === cardKey(card)) return v;
    }
    return undefined;
  }

  private handRowWorldCenter(seat: SeatIndex): { x: number; y: number } {
    const isYou = this.snapshot ? seat === this.snapshot.you.seat : true;
    const row = isYou ? this.myHandRow : this.opponentRow;
    return {
      x: row.x + Math.round(row.width / 2 - CARD_W / 2),
      y: row.y,
    };
  }

  private talonWorldPos(): { x: number; y: number } {
    return { x: this.leftStack.x, y: this.leftStack.y };
  }

  private discardWorldPos(): { x: number; y: number } {
    return { x: this.rightStack.x, y: this.rightStack.y };
  }

  private tweenOpts(onComplete: () => void) {
    return {
      ticker: this.ticker,
      speed: this.animSpeed,
      onComplete,
    };
  }

  private tweenAnim(factory: (onComplete: () => void) => TweenHandle): Anim {
    return (onComplete) => factory(onComplete);
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
