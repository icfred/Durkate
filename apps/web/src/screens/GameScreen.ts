import { type Action, beats, type Card, type Event, type TablePair } from "@durak/engine";
import type { DisconnectState, PendingCloseState, SeatIndex, Snapshot } from "@durak/protocol";
import {
  type Anim,
  color,
  easeOutBack,
  FocusManager,
  fadeTo,
  moveTo,
  parallel,
  spacing,
  type TweenHandle,
  typography,
} from "@durak/ui";
import { Container, Graphics, Text, Ticker } from "pixi.js";
import { attachFocusNavSfx, playSfx } from "../audio/index.js";
import { CARD_H, CARD_W, CardView, cardKey, SUIT_GLYPH } from "../cards/CardView.js";
import type { ConnectionStatus } from "../net/wsClient.js";
import { appStore, type RoomMembership, type ServerError } from "../store.js";
import type { Screen } from "./types.js";

const HAND_GAP = 6;
const SECTION_PADDING = spacing.lg;
const OPPONENT_STACK_OFFSET_X = 4;
const OPPONENT_STACK_OFFSET_Y = 3;

// Selected-card pop. Legal cards lift well clear of the row; illegal
// cards still respond so the user knows what's selected, just enough
// less to keep the legal/illegal cue obvious.
const FOCUS_SCALE_LEGAL = 1.18;
const FOCUS_SCALE_ILLEGAL = 1.06;
const FOCUS_LIFT_PX = 12;
const FOCUS_LERP = 0.22;

const ERROR_TOAST_MS = 3000;
const TURN_PULSE_PERIOD_MS = 1200;
const THINKING_PULSE_PERIOD_MS = 900;

// Map engine RejectReason codes (and a few server-only codes) to friendly
// player-facing flavour. The raw codes leak through as both `code` and
// `message` from the server, so we render via this map instead. Unknown
// codes fall back to the message text the server provided.
const REJECT_REASON_TEXT: Record<string, string> = {
  WRONG_PHASE: "Can't do that right now",
  INVALID_SEAT: "That seat isn't yours",
  NOT_ATTACKER: "Wait — it's not your attack",
  NOT_DEFENDER: "You aren't defending this round",
  DEFENDER_CANNOT_ATTACK: "Defenders defend, not attack — beat the cards or take the pile",
  DEFENDER_CANNOT_PASS: "You're the defender — beat or take, no pass",
  ELIMINATED_CANNOT_PASS: "You're already out for this round",
  CARD_NOT_IN_HAND: "That card isn't in your hand any more",
  TABLE_NOT_EMPTY: "Table's still in play — wait for the round to close",
  TABLE_EMPTY: "Throw-ins need an attack on the table to match",
  RANK_NOT_ON_TABLE: "Throw-ins must match a rank already on the table",
  ATTACK_LIMIT_REACHED: "Attack limit reached — six cards is the bout cap",
  DEFENDER_OVERWHELMED: "Defender's hand can't take another attack — pile is full",
  INVALID_TARGET: "That attack isn't on the table any more",
  TARGET_ALREADY_DEFENDED: "Already beaten — pick a different target",
  DOES_NOT_BEAT: "That card can't beat the attack",
  ATTACKS_UNDEFENDED: "Defend the open attacks first, or take the pile",
  TIMEOUT_NOT_ACTIVE_SEAT: "Not your move",
  GAME_NOT_STARTED: "Round hasn't started yet",
  FORBIDDEN_ACTION: "Action not allowed in this state",
  BAD_MESSAGE: "Server didn't understand the message",
  BOT_LOOP_CAP: "Bot ran out of moves — please wait",
  BOT_ILLEGAL_ACTION: "Bot made an invalid play",
};

function formatRejectReason(code: string, fallback: string): string {
  return REJECT_REASON_TEXT[code] ?? fallback;
}

// Turn timer bar geometry. `TURN_BUDGET_MS` is the assumed full-turn
// budget used as the denominator when drawing the bar fraction — the
// worker hands us absolute deadlines, not remaining time, so we estimate
// the full extent from the prod default. If the worker is configured to
// a different value the bar just starts at a non-100% fill, never wraps.
const TURN_BAR_W = 200;
const TURN_BAR_H = 4;
const TURN_BUDGET_MS = 30000;

const FADE_IN_MS = 80;
const PLAY_MOVE_MS = 220;
const TAKE_MOVE_MS = 280;
const ROUND_END_MOVE_MS = 280;
const TALON_PER_CARD_MS = 200;
const TALON_STAGGER_MS = 50;
const DEAL_PER_CARD_MS = 220;
const DEAL_STAGGER_MS = 35;

class OpponentSlot extends Container {
  readonly seat: SeatIndex;
  readonly cardStack: Container;
  readonly nameText: Text;
  private readonly countText: Text;
  private readonly turnPulse: Graphics;
  private readonly thinkingText: Text;
  private readonly disconnectText: Text;
  private readonly eliminatedOverlay: Graphics;
  private readonly eliminatedLabel: Text;
  private turnPulseAlpha = 0;

  constructor(seat: SeatIndex) {
    super();
    this.seat = seat;
    this.label = `opponent-slot-${seat}`;

    this.turnPulse = new Graphics();
    this.turnPulse.alpha = 0;
    this.addChild(this.turnPulse);

    this.cardStack = new Container();
    this.addChild(this.cardStack);

    this.nameText = new Text({
      text: `Player ${seat + 1}`,
      style: {
        fontFamily: typography.family,
        fontSize: typography.size.xs,
        fontWeight: typography.weight.bold,
        fill: color.text,
        letterSpacing: typography.letterSpacing.wide,
      },
    });
    this.addChild(this.nameText);

    this.countText = new Text({
      text: "× 0",
      style: {
        fontFamily: typography.family,
        fontSize: typography.size.xs,
        fill: color.textMuted,
        letterSpacing: typography.letterSpacing.wide,
      },
    });
    this.addChild(this.countText);

    this.thinkingText = new Text({
      text: "thinking…",
      style: {
        fontFamily: typography.family,
        fontSize: typography.size.xs,
        fontWeight: typography.weight.bold,
        fill: color.textMuted,
        letterSpacing: typography.letterSpacing.wide,
      },
    });
    this.thinkingText.label = `thinking-${seat}`;
    this.thinkingText.visible = false;
    this.addChild(this.thinkingText);

    this.disconnectText = new Text({
      text: "",
      style: {
        fontFamily: typography.family,
        fontSize: typography.size.xs,
        fontWeight: typography.weight.bold,
        fill: color.danger,
        letterSpacing: typography.letterSpacing.wide,
      },
    });
    this.disconnectText.label = `disconnect-${seat}`;
    this.disconnectText.visible = false;
    this.addChild(this.disconnectText);

    this.eliminatedOverlay = new Graphics();
    this.eliminatedOverlay.visible = false;
    this.addChild(this.eliminatedOverlay);

    this.eliminatedLabel = new Text({
      text: "OUT",
      style: {
        fontFamily: typography.family,
        fontSize: typography.size.sm,
        fontWeight: typography.weight.bold,
        fill: color.textMuted,
        letterSpacing: typography.letterSpacing.stamp,
      },
    });
    this.eliminatedLabel.label = `eliminated-${seat}`;
    this.eliminatedLabel.visible = false;
    this.addChild(this.eliminatedLabel);
  }

  setName(name: string): void {
    if (this.nameText.text !== name) this.nameText.text = name;
  }

  setHandCount(count: number): void {
    this.cardStack.removeChildren();
    const visibleCount = Math.min(count, 6);
    for (let i = 0; i < visibleCount; i += 1) {
      const card = new CardView(null, true);
      card.x = i * OPPONENT_STACK_OFFSET_X;
      card.y = i * OPPONENT_STACK_OFFSET_Y;
      this.cardStack.addChild(card);
    }
    this.countText.text = `× ${count}`;
  }

  setTurnActive(active: boolean): void {
    this.turnPulseAlpha = active ? 1 : 0;
    this.turnPulse.alpha = active ? 0.45 : 0;
  }

  setThinking(active: boolean): void {
    this.thinkingText.visible = active;
  }

  setDisconnect(state: DisconnectState | null, now: number): void {
    if (!state) {
      this.disconnectText.visible = false;
      return;
    }
    const remaining = Math.max(0, Math.ceil((state.forfeitAt - now) / 1000));
    this.disconnectText.text = `DISC ${remaining}s`;
    this.disconnectText.visible = true;
  }

  setEliminated(eliminated: boolean): void {
    this.eliminatedOverlay.visible = eliminated;
    this.eliminatedLabel.visible = eliminated;
  }

  layoutChildren(): void {
    const stackW = CARD_W + 5 * OPPONENT_STACK_OFFSET_X;
    const stackH = CARD_H + 5 * OPPONENT_STACK_OFFSET_Y;

    this.cardStack.x = Math.round(-stackW / 2);
    this.cardStack.y = Math.round(-stackH / 2);

    this.nameText.x = Math.round(-this.nameText.width / 2);
    this.nameText.y = Math.round(stackH / 2) + spacing.xs;

    this.countText.x = Math.round(-this.countText.width / 2);
    this.countText.y = this.nameText.y + this.nameText.height + 2;

    this.thinkingText.x = Math.round(-this.thinkingText.width / 2);
    this.thinkingText.y = this.countText.y + this.countText.height + 2;

    this.disconnectText.x = Math.round(-this.disconnectText.width / 2);
    this.disconnectText.y = Math.round(-stackH / 2) - this.disconnectText.height - 2;

    const padX = spacing.sm;
    const padY = spacing.xs;
    this.turnPulse
      .clear()
      .roundRect(
        Math.round(-stackW / 2) - padX,
        Math.round(-stackH / 2) - padY,
        stackW + padX * 2,
        stackH + padY * 2,
        6,
      )
      .fill({ color: color.accent });

    this.eliminatedOverlay
      .clear()
      .roundRect(
        Math.round(-stackW / 2) - padX,
        Math.round(-stackH / 2) - padY,
        stackW + padX * 2,
        stackH + padY * 2,
        6,
      )
      .fill({ color: color.bg, alpha: 0.65 });
    this.eliminatedLabel.x = Math.round(-this.eliminatedLabel.width / 2);
    this.eliminatedLabel.y = Math.round(-this.eliminatedLabel.height / 2);
  }

  applyTurnPulse(alpha: number): void {
    if (this.turnPulseAlpha > 0) {
      this.turnPulse.alpha = alpha;
    }
  }

  applyThinkingPulse(alpha: number): void {
    if (this.thinkingText.visible) this.thinkingText.alpha = alpha;
  }

  /** World-space center of the card stack. */
  stackWorldCenter(): { x: number; y: number } {
    return { x: this.x, y: this.y };
  }
}

/**
 * Focus-driven grow + lift on a single hand card. Lerps scale and
 * vertical lift toward a focused/unfocused target every tick. Top-left
 * pivot keeps the card's layout origin stable so existing deal/play/take
 * animations (which set absolute positions) don't have to know about
 * the effect — we apply the offset by adjusting the position around
 * `basePos` instead of changing the pivot.
 */
class HandCardEffects {
  private readonly view: CardView;
  private readonly basePos: { x: number; y: number };
  private readonly legal: boolean;
  private targetScale = 1;
  private currentScale = 1;
  private targetLift = 0;
  private currentLift = 0;

  constructor(view: CardView, basePos: { x: number; y: number }, legal: boolean) {
    this.view = view;
    this.basePos = basePos;
    this.legal = legal;
  }

  setFocused(focused: boolean): void {
    if (focused) {
      this.targetScale = this.legal ? FOCUS_SCALE_LEGAL : FOCUS_SCALE_ILLEGAL;
      this.targetLift = FOCUS_LIFT_PX * (this.legal ? 1 : 0.4);
    } else {
      this.targetScale = 1;
      this.targetLift = 0;
    }
  }

  tick(): void {
    const ds = this.targetScale - this.currentScale;
    const dl = this.targetLift - this.currentLift;
    if (Math.abs(ds) < 1e-4 && Math.abs(dl) < 1e-4) return;
    this.currentScale += ds * FOCUS_LERP;
    this.currentLift += dl * FOCUS_LERP;
    this.view.scale.set(this.currentScale);
    const growW = CARD_W * (this.currentScale - 1);
    const growH = CARD_H * (this.currentScale - 1);
    this.view.x = this.basePos.x - growW * 0.5;
    this.view.y = this.basePos.y - growH - this.currentLift;
  }
}

interface SlotPosition {
  xFrac: number;
  yFrac: number;
}

function radialOpponentPositions(playerCount: number): SlotPosition[] {
  switch (playerCount) {
    case 2:
      return [{ xFrac: 0.5, yFrac: 0.18 }];
    case 3:
      return [
        { xFrac: 0.7, yFrac: 0.22 },
        { xFrac: 0.3, yFrac: 0.22 },
      ];
    case 4:
      return [
        { xFrac: 0.85, yFrac: 0.5 },
        { xFrac: 0.5, yFrac: 0.18 },
        { xFrac: 0.15, yFrac: 0.5 },
      ];
    case 5:
      return [
        { xFrac: 0.85, yFrac: 0.6 },
        { xFrac: 0.75, yFrac: 0.22 },
        { xFrac: 0.25, yFrac: 0.22 },
        { xFrac: 0.15, yFrac: 0.6 },
      ];
    case 6:
      return [
        { xFrac: 0.88, yFrac: 0.62 },
        { xFrac: 0.78, yFrac: 0.25 },
        { xFrac: 0.5, yFrac: 0.16 },
        { xFrac: 0.22, yFrac: 0.25 },
        { xFrac: 0.12, yFrac: 0.62 },
      ];
    default:
      return [];
  }
}

export interface GameScreenOptions {
  snapshot: Snapshot | null;
  submitAction: (action: Action) => void;
  subscribe?: (listener: (snapshot: Snapshot | null) => void) => () => void;
  subscribeEvents?: (listener: (events: Event[]) => void) => () => void;
  subscribeError?: (listener: (error: ServerError | null) => void) => () => void;
  initialRoom?: RoomMembership | null;
  subscribeRoom?: (listener: (room: RoomMembership | null) => void) => () => void;
  /**
   * Connection status. When the wsClient is mid-reconnect (status !==
   * "open"), the GameScreen renders a RECONNECTING badge and suspends
   * keyboard activation so user inputs aren't silently dropped.
   */
  initialConnectionStatus?: ConnectionStatus;
  subscribeConnection?: (listener: (status: ConnectionStatus) => void) => () => void;
  setError?: (code: string, message: string) => void;
  ticker?: Ticker;
  now?: () => number;
}

export class GameScreen extends Container implements Screen {
  private readonly focus = new FocusManager();
  private readonly waiting: Text;
  private readonly turnLabel: Text;
  private readonly turnTimerBar: Graphics;
  private lastTimerTickSecond: number | null = null;
  private readonly forcedActionText: Text;
  private readonly keyHint: Text;
  private readonly errorBanner: Container;
  private readonly errorBannerBg: Graphics;
  private readonly errorBannerText: Text;
  private readonly disconnectBanner: Container;
  private readonly disconnectBannerBg: Graphics;
  private readonly disconnectBannerText: Text;
  private readonly closeBanner: Container;
  private readonly closeBannerBg: Graphics;
  private readonly closeBannerText: Text;
  private readonly opponentLayer: Container;
  private readonly tableRow: Container;
  private readonly leftStack: Container;
  private readonly rightStack: Container;
  private readonly myHandRow: Container;
  private readonly spectatorBanner: Container;
  private readonly spectatorBannerBg: Graphics;
  private readonly spectatorBannerText: Text;
  private readonly animLayer: Container;
  private readonly submitAction: (action: Action) => void;
  private readonly extraKeysHandler: (event: KeyboardEvent) => void;
  private readonly subscribeUnsub: (() => void) | null;
  private readonly subscribeEventsUnsub: (() => void) | null;
  private readonly subscribeErrorUnsub: (() => void) | null;
  private readonly detachFocusNavSfx: () => void;
  private readonly subscribeRoomUnsub: (() => void) | null;
  private readonly subscribeConnectionUnsub: (() => void) | null;
  private readonly setError: (code: string, message: string) => void;
  private connectionStatus: ConnectionStatus;
  private reconnectingBanner: Container | null = null;
  private reconnectingBannerTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly now: () => number;
  private room: RoomMembership | null = null;
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
  private thinkingPulseElapsed = 0;
  private errorVisibleMs = 0;
  private opponentSlots = new Map<SeatIndex, OpponentSlot>();
  private readonly handEffects = new Set<HandCardEffects>();
  // Last focused hand card, by `cardKey`. Restored after every re-render
  // so a bot or opponent's move doesn't yank the selection back to the
  // first legal card.
  private focusedCardKey: string | null = null;

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

    // Turn timer progress bar. Sits just below the turn label and drains
    // smoothly as the deadline approaches. Drops to a danger fill in the
    // last 5 seconds and triggers a per-second `timerTick` SFX cue so the
    // pressure registers without the player needing to read a number.
    this.turnTimerBar = new Graphics();
    this.turnTimerBar.label = "turn-timer";
    this.turnTimerBar.visible = false;
    this.addChild(this.turnTimerBar);

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

    // Forced-action affordance. When the player has no legal card play
    // (no defense, no throw-in) the only legal action is a single keybind
    // — Take Pile, End Round, or Pass. Rendered as bold accent-coloured
    // text above the keyhint, no panel chrome — it has to read as part
    // of the in-match HUD vocabulary, not a modal.
    this.forcedActionText = new Text({
      text: "",
      style: {
        fontFamily: typography.family,
        fontSize: typography.size.md,
        fontWeight: typography.weight.bold,
        fill: color.accent,
        letterSpacing: typography.letterSpacing.wide,
      },
    });
    this.forcedActionText.label = "forced-action-text";
    this.forcedActionText.visible = false;
    this.addChild(this.forcedActionText);

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

    this.closeBanner = new Container();
    this.closeBanner.label = "close-banner";
    this.closeBanner.visible = false;
    this.closeBannerBg = new Graphics();
    this.closeBannerText = new Text({
      text: "",
      style: {
        fontFamily: typography.family,
        fontSize: typography.size.sm,
        fontWeight: typography.weight.bold,
        fill: color.text,
        letterSpacing: typography.letterSpacing.wide,
      },
    });
    this.closeBannerText.label = "close-banner-text";
    this.closeBanner.addChild(this.closeBannerBg);
    this.closeBanner.addChild(this.closeBannerText);
    this.addChild(this.closeBanner);

    this.opponentLayer = new Container();
    this.tableRow = new Container();
    this.leftStack = new Container();
    this.rightStack = new Container();
    this.myHandRow = new Container();
    this.animLayer = new Container();

    this.opponentLayer.label = "opponent-layer";
    this.tableRow.label = "table";
    this.leftStack.label = "talon";
    this.rightStack.label = "discard";
    this.myHandRow.label = "my-hand";
    this.animLayer.label = "anim-layer";

    this.addChild(this.opponentLayer);
    this.addChild(this.tableRow);
    this.addChild(this.leftStack);
    this.addChild(this.rightStack);
    this.addChild(this.myHandRow);
    this.addChild(this.animLayer);

    this.spectatorBanner = new Container();
    this.spectatorBanner.label = "spectator-banner";
    this.spectatorBanner.visible = false;
    this.spectatorBannerBg = new Graphics();
    this.spectatorBannerText = new Text({
      text: "YOU'RE OUT — SPECTATING",
      style: {
        fontFamily: typography.family,
        fontSize: typography.size.md,
        fontWeight: typography.weight.bold,
        fill: color.textMuted,
        letterSpacing: typography.letterSpacing.stamp,
      },
    });
    this.spectatorBanner.addChild(this.spectatorBannerBg);
    this.spectatorBanner.addChild(this.spectatorBannerText);
    this.addChild(this.spectatorBanner);

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
    this.room = options.initialRoom ?? appStore.getState().room;
    this.subscribeRoomUnsub = subscribeRoom((room) => this.handleRoom(room));

    // Connection state. When status flips off "open" the reconnecting
    // banner shows + FocusManager is suspended so Enter / arrow inputs
    // can't fire SFX or dispatch actions that would silently drop.
    this.setError = options.setError ?? ((c, m) => appStore.getState().setError(c, m));
    this.connectionStatus =
      options.initialConnectionStatus ?? appStore.getState().connection.status;
    const subscribeConnection =
      options.subscribeConnection ??
      ((listener) =>
        appStore.subscribe((next, prev) => {
          if (next.connection.status !== prev.connection.status) {
            listener(next.connection.status);
          }
        }));
    this.subscribeConnectionUnsub = subscribeConnection((status) =>
      this.handleConnectionStatus(status),
    );

    this.now = options.now ?? (() => Date.now());

    this.ticker = options.ticker ?? Ticker.shared;
    this.tickCallback = () => this.onTick(this.ticker.deltaMS);
    this.ticker.add(this.tickCallback);

    this.focus.attach();
    this.detachFocusNavSfx = attachFocusNavSfx(this.focus);
    this.render();
    this.renderDisconnectBanner();
    // Sync the focus suspension to whatever status we booted with.
    // If the screen is constructed mid-reconnect (e.g. on a hot reload),
    // start in the suspended state so Enter doesn't fire spurious actions.
    this.applyConnectionStatus();
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
    this.subscribeConnectionUnsub?.();
    this.detachFocusNavSfx();
    this.subscribeRoomUnsub?.();
    this.cancelReconnectingBannerTimer();
    this.ticker.remove(this.tickCallback);
    this.cancelAnims();
    this.focus.detach();
    this.focus.clear();
  }

  private handleConnectionStatus(status: ConnectionStatus): void {
    if (this.connectionStatus === status) return;
    this.connectionStatus = status;
    this.applyConnectionStatus();
  }

  private applyConnectionStatus(): void {
    // Only suspend when the connection is actively dropped or
    // mid-recovery. "idle" (controller not started) and "open" both
    // accept input. Suspend covers closed / connecting / error where
    // the sender would silently drop and Enter would fire SFX.
    const offline =
      this.connectionStatus === "closed" ||
      this.connectionStatus === "connecting" ||
      this.connectionStatus === "error";
    if (offline) {
      this.focus.suspend();
      // Only surface the badge if the disconnect persists past 500ms.
      // Wrangler-dev / prod-DO hibernation churn through closed →
      // connecting → open in under that, and a banner flash on every
      // transient drop reads as broken even though everything's fine.
      // Hard `error` (max retries) shows immediately.
      if (this.connectionStatus === "error") {
        this.cancelReconnectingBannerTimer();
        this.showReconnectingBanner();
      } else if (this.reconnectingBanner === null && this.reconnectingBannerTimer === null) {
        this.reconnectingBannerTimer = setTimeout(() => {
          this.reconnectingBannerTimer = null;
          if (this.connectionStatus !== "open" && this.connectionStatus !== "idle") {
            this.showReconnectingBanner();
          }
        }, 500);
      }
    } else {
      this.cancelReconnectingBannerTimer();
      this.focus.resume();
      this.hideReconnectingBanner();
    }
  }

  private cancelReconnectingBannerTimer(): void {
    if (this.reconnectingBannerTimer === null) return;
    clearTimeout(this.reconnectingBannerTimer);
    this.reconnectingBannerTimer = null;
  }

  private showReconnectingBanner(): void {
    if (this.reconnectingBanner !== null) return;
    const banner = new Container();
    banner.label = "reconnecting-banner";
    const bg = new Graphics();
    const text = new Text({
      text: "RECONNECTING…",
      style: {
        fontFamily: typography.family,
        fontSize: typography.size.sm,
        fontWeight: typography.weight.bold,
        fill: color.text,
        letterSpacing: typography.letterSpacing.wide,
      },
    });
    const padX = spacing.md;
    const padY = spacing.xs;
    const w = Math.round(text.width + padX * 2);
    const h = Math.round(text.height + padY * 2);
    bg.roundRect(0, 0, w, h, 4)
      .fill({ color: color.bgRaised })
      .stroke({ color: color.accent, width: 2, alignment: 0 });
    text.x = padX;
    text.y = padY;
    banner.addChild(bg);
    banner.addChild(text);
    banner.x = Math.round((this.viewWidth - w) / 2);
    banner.y = SECTION_PADDING;
    this.addChild(banner);
    this.reconnectingBanner = banner;
  }

  private hideReconnectingBanner(): void {
    if (this.reconnectingBanner === null) return;
    this.removeChild(this.reconnectingBanner);
    this.reconnectingBanner.destroy({ children: true });
    this.reconnectingBanner = null;
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
    this.room = room;
    this.refreshOpponentSlotState();
    this.renderDisconnectBanner();
    this.renderCloseBanner();
    this.renderKeyHintIfReady();
    this.layoutSections();
  }

  private renderKeyHintIfReady(): void {
    if (this.snapshot)
      this.keyHint.text = keyHintFor(this.snapshot, this.room?.pendingClose ?? null);
  }

  private renderCloseBanner(): void {
    const pending = this.room?.pendingClose ?? null;
    if (!pending) {
      this.closeBanner.visible = false;
      return;
    }
    const remainingMs = Math.max(0, pending.closesAt - this.now());
    const remaining = (remainingMs / 1000).toFixed(1);
    const verb = pending.kind === "END_ROUND" ? "Round closing" : "Pile collected";
    this.closeBannerText.text = `${verb} in ${remaining}s…`;
    const padX = spacing.md;
    const padY = spacing.sm;
    const w = Math.round(this.closeBannerText.width + padX * 2);
    const h = Math.round(this.closeBannerText.height + padY * 2);
    this.closeBannerBg
      .clear()
      .roundRect(0, 0, w, h, 4)
      .fill({ color: color.bgRaised })
      .stroke({ color: color.accent, width: 2, alignment: 0 });
    this.closeBannerText.x = padX;
    this.closeBannerText.y = padY;
    this.closeBanner.visible = true;
  }

  private renderDisconnectBanner(): void {
    const earliest = this.room?.disconnects?.[0] ?? this.room?.disconnect ?? null;
    if (!earliest) {
      this.disconnectBanner.visible = false;
      return;
    }
    const remaining = Math.max(0, Math.ceil((earliest.forfeitAt - this.now()) / 1000));
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
    this.errorBannerText.text = formatRejectReason(error.code, error.message);
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
    for (const fx of this.handEffects) fx.tick();
    this.refreshTurnTimer();
    if (this.turnPulseActive) {
      this.turnPulseElapsed = (this.turnPulseElapsed + deltaMs) % TURN_PULSE_PERIOD_MS;
      const phase = (this.turnPulseElapsed / TURN_PULSE_PERIOD_MS) * Math.PI * 2;
      this.turnLabel.alpha = 0.7 + 0.3 * (0.5 + 0.5 * Math.cos(phase));
    }

    const speed = this.animSpeed();
    if (speed > 0) {
      this.thinkingPulseElapsed =
        (this.thinkingPulseElapsed + deltaMs * speed) % THINKING_PULSE_PERIOD_MS;
      const phase = (this.thinkingPulseElapsed / THINKING_PULSE_PERIOD_MS) * Math.PI * 2;
      const thinkingAlpha = 0.4 + 0.6 * (0.5 + 0.5 * Math.cos(phase));
      const turnPulseAlpha = 0.25 + 0.3 * (0.5 + 0.5 * Math.cos(phase));
      for (const slot of this.opponentSlots.values()) {
        slot.applyThinkingPulse(thinkingAlpha);
        slot.applyTurnPulse(turnPulseAlpha);
      }
    } else {
      for (const slot of this.opponentSlots.values()) {
        slot.applyThinkingPulse(1);
        slot.applyTurnPulse(0.45);
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

    if ((this.room?.disconnects?.length ?? 0) > 0 || this.room?.disconnect) {
      this.renderDisconnectBanner();
    }
    if (this.room?.pendingClose) {
      this.renderCloseBanner();
      this.layoutSections();
    }
  }

  private render(): void {
    this.tableRow.removeChildren();
    this.leftStack.removeChildren();
    this.rightStack.removeChildren();
    this.myHandRow.removeChildren();
    this.focus.clear();
    this.handEffects.clear();

    const snapshot = this.snapshot;
    if (!snapshot) {
      this.disposeOpponentSlots();
      this.waiting.visible = true;
      this.opponentLayer.visible = false;
      this.tableRow.visible = false;
      this.leftStack.visible = false;
      this.rightStack.visible = false;
      this.myHandRow.visible = false;
      this.spectatorBanner.visible = false;
      this.turnLabel.visible = false;
      this.keyHint.visible = false;
      this.forcedActionText.visible = false;
      this.turnTimerBar.visible = false;
      this.turnPulseActive = false;
      return;
    }

    this.waiting.visible = false;
    this.opponentLayer.visible = true;
    this.tableRow.visible = true;
    this.leftStack.visible = true;
    this.rightStack.visible = true;
    this.turnLabel.visible = true;
    this.keyHint.visible = true;

    this.renderOpponentSlots(snapshot);
    this.renderTable(snapshot);
    this.renderTalonAndTrump(snapshot);
    this.renderDiscard(snapshot);
    this.renderSelfRow(snapshot);
    this.renderTurnLabel(snapshot);
    this.renderKeyHint(snapshot);
  }

  private isSpectating(snapshot: Snapshot): boolean {
    return snapshot.you.hand.length === 0 && snapshot.phase === "in-round";
  }

  private renderSelfRow(snapshot: Snapshot): void {
    if (this.isSpectating(snapshot)) {
      this.myHandRow.visible = false;
      this.spectatorBanner.visible = true;
      this.layoutSpectatorBanner();
      return;
    }
    this.spectatorBanner.visible = false;
    this.myHandRow.visible = true;
    this.renderMyHand(snapshot);
  }

  private layoutSpectatorBanner(): void {
    const padX = spacing.lg;
    const padY = spacing.md;
    const w = Math.round(this.spectatorBannerText.width + padX * 2);
    const h = Math.round(this.spectatorBannerText.height + padY * 2);
    this.spectatorBannerBg
      .clear()
      .roundRect(0, 0, w, h, 6)
      .fill({ color: color.bgRaised })
      .stroke({ color: color.borderFocus, width: 2, alignment: 0 });
    this.spectatorBannerText.x = padX;
    this.spectatorBannerText.y = padY;
  }

  private disposeOpponentSlots(): void {
    for (const slot of this.opponentSlots.values()) {
      this.opponentLayer.removeChild(slot);
      slot.destroy({ children: true });
    }
    this.opponentSlots.clear();
  }

  private renderOpponentSlots(snapshot: Snapshot): void {
    const seats: SeatIndex[] = [];
    for (let i = 1; i < snapshot.playerCount; i += 1) {
      seats.push(((snapshot.you.seat + i) % snapshot.playerCount) as SeatIndex);
    }

    const wanted = new Set<SeatIndex>(seats);
    for (const [seat, slot] of this.opponentSlots) {
      if (!wanted.has(seat)) {
        this.opponentLayer.removeChild(slot);
        slot.destroy({ children: true });
        this.opponentSlots.delete(seat);
      }
    }

    seats.forEach((seat, idx) => {
      let slot = this.opponentSlots.get(seat);
      if (!slot) {
        slot = new OpponentSlot(seat);
        this.opponentSlots.set(seat, slot);
        this.opponentLayer.addChild(slot);
      }
      const seatName = this.room?.seats[seat]?.name?.trim();
      slot.setName(seatName && seatName.length > 0 ? seatName : `Player ${seat + 1}`);
      const count = snapshot.handCounts[seat] ?? 0;
      slot.setHandCount(count);
      const isFirst = idx === 0;
      slot.cardStack.label = isFirst ? "opponent-hand" : `opponent-hand-${seat}`;
      slot.layoutChildren();
      const isActor = seat === snapshot.attacker || seat === snapshot.defender;
      slot.setTurnActive(isActor);
    });
    this.layoutOpponentSlots(snapshot);
    this.refreshOpponentSlotState();
  }

  // Reposition every opponent slot to its radial coordinate. Split out from
  // `renderOpponentSlots` so resizes and other layout passes (which don't
  // re-render slot contents) can re-pin slots after `viewWidth/Height`
  // change. Called from both `renderOpponentSlots` and `layoutSections` —
  // without the latter, the very first render runs with `viewWidth=0` (the
  // GameScreen constructor calls `render()` before `layout()` is invoked
  // by the router) and slots stick to the top-left until the next snapshot.
  private layoutOpponentSlots(snapshot: Snapshot): void {
    const positions = radialOpponentPositions(snapshot.playerCount);
    const seats: SeatIndex[] = [];
    for (let i = 1; i < snapshot.playerCount; i += 1) {
      seats.push(((snapshot.you.seat + i) % snapshot.playerCount) as SeatIndex);
    }
    seats.forEach((seat, idx) => {
      const slot = this.opponentSlots.get(seat);
      const pos = positions[idx];
      if (!slot || !pos) return;
      slot.x = Math.round(this.viewWidth * pos.xFrac);
      slot.y = Math.round(this.viewHeight * pos.yFrac);
    });
  }

  private refreshOpponentSlotState(): void {
    const room = this.room;
    const eliminated = new Set<SeatIndex>(room?.eliminated ?? []);
    const thinking = new Set<SeatIndex>(room?.thinkingSeats ?? []);
    const disconnects = new Map<SeatIndex, DisconnectState>();
    for (const d of room?.disconnects ?? []) disconnects.set(d.seat, d);
    if (disconnects.size === 0 && room?.disconnect) {
      disconnects.set(room.disconnect.seat, room.disconnect);
    }
    const now = this.now();
    for (const [seat, slot] of this.opponentSlots) {
      slot.setEliminated(eliminated.has(seat));
      slot.setThinking(thinking.has(seat));
      slot.setDisconnect(disconnects.get(seat) ?? null, now);
    }
  }

  private renderTable(snapshot: Snapshot): void {
    const startX = tableStartX(snapshot.table.length);
    const pairColumnWidth = CARD_W + HAND_GAP;
    // Add every attack first, then every defense, so each defense renders
    // above all attacks. The defense card is offset right by 25% of CARD_W
    // and overlaps the next pair's attack by ~9px — interleaving attack/
    // defense per pair would cause the next attack to clip the previous
    // pair's defense in that overlap.
    snapshot.table.forEach((pair: TablePair, i: number) => {
      const attackView = new CardView(pair.attack);
      attackView.x = startX + i * pairColumnWidth;
      attackView.y = 0;
      this.tableRow.addChild(attackView);
    });
    snapshot.table.forEach((pair: TablePair, i: number) => {
      if (!pair.defense) return;
      const defenseView = new CardView(pair.defense);
      defenseView.x = startX + i * pairColumnWidth + Math.round(CARD_W * 0.25);
      defenseView.y = Math.round(CARD_H * 0.4);
      this.tableRow.addChild(defenseView);
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
    const previousFocus = this.focusedCardKey;
    let restoreTarget: CardView | null = null;
    let firstLegal: CardView | null = null;
    hand.forEach((card, i) => {
      const view = new CardView(card);
      const baseX = i * (CARD_W + HAND_GAP);
      const baseY = 0;
      view.x = baseX;
      view.y = baseY;
      view.onActivate = () => this.tryPlayCard(card);
      const isLegal = legalPlay(snapshot, card) !== null;
      view.setLegalState(isLegal ? "legal" : "illegal");
      view.setTrump(card.suit === snapshot.trumpSuit);
      this.myHandRow.addChild(view);
      // Only legal cards are focusable. Arrow keys skip illegal ones
      // entirely so the player can't "select" a card they can't play.
      // Illegal cards still render (dimmed via `setLegalState`) so the
      // hand reads as a whole.
      const key = cardKey(card);
      if (isLegal) {
        this.focus.register(view);
        if (!firstLegal) firstLegal = view;
        if (previousFocus !== null && key === previousFocus) restoreTarget = view;
      }

      const fx = new HandCardEffects(view, { x: baseX, y: baseY }, isLegal);
      this.handEffects.add(fx);
      // FocusManager dispatches via cardView.setFocus. We patch the
      // instance method (shadowing the prototype) so the manager's
      // existing keyboard-driven focus changes also drive the grow/lift
      // animation without any other plumbing.
      const originalSetFocus = view.setFocus.bind(view);
      view.setFocus = (focused: boolean) => {
        originalSetFocus(focused);
        fx.setFocused(focused);
        if (focused) this.focusedCardKey = key;
      };
    });
    // Restore selection: prefer the previously-focused card; fall back to
    // the first legal one. `register` auto-focuses the first node, so we
    // override here when we have a better target.
    if (restoreTarget !== null && restoreTarget !== firstLegal) {
      this.focus.focus(restoreTarget);
    }
    // If nothing legal exists, drop the remembered key so the next render
    // doesn't try to restore something stale.
    if (firstLegal === null) this.focusedCardKey = null;
  }

  private refreshTurnTimer(): void {
    const deadline = this.room?.turnDeadline ?? null;
    // The pendingClose banner already owns the visible countdown during
    // its window; suppress this timer to avoid two duelling clocks.
    if (deadline === null || this.room?.pendingClose || !this.snapshot) {
      this.turnTimerBar.visible = false;
      this.lastTimerTickSecond = null;
      return;
    }
    const remainingMs = deadline - this.now();
    if (remainingMs <= 0) {
      this.turnTimerBar.visible = false;
      this.lastTimerTickSecond = null;
      return;
    }
    // Estimate the full turn budget from the deadline. Worker config sets
    // TURN_TIMEOUT_MS=30000 in prod; we use it only as a denominator for
    // the bar fraction so a slightly different value just changes the
    // starting fill, never the drain feel.
    const totalMs = TURN_BUDGET_MS;
    const frac = Math.max(0, Math.min(1, remainingMs / totalMs));
    const isLowTime = remainingMs < 5000;
    this.turnTimerBar.clear();
    // Background track — full width, dimmed.
    this.turnTimerBar.roundRect(0, 0, TURN_BAR_W, TURN_BAR_H, 1).fill({ color: color.bgRaised });
    // Fill — drains right-to-left as time passes.
    const fillW = Math.max(0, Math.round(TURN_BAR_W * frac));
    if (fillW > 0) {
      this.turnTimerBar
        .roundRect(0, 0, fillW, TURN_BAR_H, 1)
        .fill({ color: isLowTime ? color.danger : color.accent });
    }
    this.turnTimerBar.visible = true;
    this.layoutTurnTimer();

    // Per-second tick SFX in the last 5s. Track the integer second so we
    // fire once per crossing rather than every frame.
    if (isLowTime) {
      const secondsLeft = Math.ceil(remainingMs / 1000);
      if (this.lastTimerTickSecond !== secondsLeft) {
        if (this.lastTimerTickSecond !== null) playSfx("timerTick");
        this.lastTimerTickSecond = secondsLeft;
      }
    } else {
      this.lastTimerTickSecond = null;
    }
  }

  private layoutTurnTimer(): void {
    if (!this.turnTimerBar.visible) return;
    // Sit centered above the turn label, not below. Below-the-label
    // placed the bar between the label and the table card row, where
    // it z-fought the card stack on tight viewports. Anchoring above
    // the label keeps the bar well clear of the table while still
    // reading as a header for the same "your turn" cluster.
    this.turnTimerBar.x = Math.round((this.viewWidth - TURN_BAR_W) / 2);
    this.turnTimerBar.y = this.turnLabel.y - TURN_BAR_H - spacing.xs;
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
    this.keyHint.text = keyHintFor(snapshot, this.room?.pendingClose ?? null);
    this.renderForcedAction(snapshot);
  }

  // Surface the only legal action when the player has no card play
  // (Take Pile / End Round / Pass). Rendered as bold accent-colored
  // text that sits above the keyhint — same visual vocabulary as the
  // turn label, no panel chrome. The hint text below picks up the
  // same keybind so the keyboard cue is reinforced rather than
  // duplicated.
  private renderForcedAction(snapshot: Snapshot): void {
    const forced = forcedActionFor(snapshot, this.room?.pendingClose ?? null);
    if (!forced) {
      this.forcedActionText.visible = false;
      return;
    }
    this.forcedActionText.text = `${forced.label}  [${forced.key}]`;
    this.forcedActionText.visible = true;
    this.layoutForcedAction();
  }

  private layoutForcedAction(): void {
    if (!this.forcedActionText.visible) return;
    this.forcedActionText.x = Math.round((this.viewWidth - this.forcedActionText.width) / 2);
    // Anchor the affordance directly above the keyhint so the player's
    // eye walks: hand → keyhint → forced action. Keeps the in-bout
    // table area clean and never collides with cards.
    this.forcedActionText.y = this.keyHint.y - this.forcedActionText.height - spacing.sm;
  }

  private layoutSections(): void {
    this.waiting.x = Math.round((this.viewWidth - this.waiting.width) / 2);
    this.waiting.y = Math.round((this.viewHeight - this.waiting.height) / 2);

    if (!this.snapshot) return;

    this.layoutOpponentSlots(this.snapshot);

    this.turnLabel.x = Math.round((this.viewWidth - this.turnLabel.width) / 2);
    this.turnLabel.y = Math.round(
      this.viewHeight / 2 - CARD_H / 2 - this.turnLabel.height - spacing.sm,
    );
    this.layoutTurnTimer();

    // Anchor the table at the screen's horizontal centre and lay out cards
    // symmetrically inside the row (see tableStartX). This keeps every card's
    // on-screen position stable as the table grows or shrinks during play —
    // adding a card no longer shifts the cards already on the table.
    this.tableRow.x = Math.round(this.viewWidth / 2);
    this.tableRow.y = Math.round(this.viewHeight / 2 - CARD_H / 2);

    this.leftStack.x = SECTION_PADDING;
    this.leftStack.y = Math.round(this.viewHeight / 2 - CARD_H / 2);

    this.rightStack.x = this.viewWidth - SECTION_PADDING - CARD_W;
    this.rightStack.y = Math.round(this.viewHeight / 2 - CARD_H / 2);

    // Compute hand width from card count, not from `myHandRow.width`. The
    // bounding box inflates when the focused card is mid-scale (HandCardEffects
    // lerp), so reading `.width` causes the row to shift left/right between
    // frames as room state arrives during the focus-grow animation.
    const handCount = this.snapshot.you.hand.length;
    const handW = handCount > 0 ? handCount * CARD_W + (handCount - 1) * HAND_GAP : 0;
    this.myHandRow.x = Math.round((this.viewWidth - handW) / 2);
    this.myHandRow.y = this.viewHeight - SECTION_PADDING - CARD_H;

    if (this.spectatorBanner.visible) {
      const bw = this.spectatorBanner.width;
      const bh = this.spectatorBanner.height;
      this.spectatorBanner.x = Math.round((this.viewWidth - bw) / 2);
      this.spectatorBanner.y = this.viewHeight - SECTION_PADDING - bh;
    }

    this.keyHint.x = Math.round((this.viewWidth - this.keyHint.width) / 2);
    // Reserve clearance above the hand so the focused-card lift/scale doesn't
    // crash into the hint text. Lift = FOCUS_LIFT_PX; scale grows the card
    // upward by CARD_H * (FOCUS_SCALE_LEGAL - 1) — round up plus a small pad.
    const handTopClearance = this.spectatorBanner.visible
      ? spacing.sm
      : Math.ceil(FOCUS_LIFT_PX + CARD_H * (FOCUS_SCALE_LEGAL - 1)) + spacing.sm;
    this.keyHint.y =
      (this.spectatorBanner.visible ? this.spectatorBanner.y : this.myHandRow.y) -
      this.keyHint.height -
      handTopClearance;
    this.layoutForcedAction();

    if (this.errorBanner.visible) {
      const bw = this.errorBanner.width;
      this.errorBanner.x = Math.round((this.viewWidth - bw) / 2);
      this.errorBanner.y = this.keyHint.y - this.errorBanner.height - spacing.sm;
    }

    if (this.disconnectBanner.visible) {
      const dw = this.disconnectBanner.width;
      this.disconnectBanner.x = Math.round((this.viewWidth - dw) / 2);
      this.disconnectBanner.y = SECTION_PADDING;
    }

    if (this.closeBanner.visible) {
      const cw = this.closeBanner.width;
      this.closeBanner.x = Math.round((this.viewWidth - cw) / 2);
      // Sit just below the disconnect banner if both are showing, else
      // pin to the top edge.
      this.closeBanner.y = this.disconnectBanner.visible
        ? this.disconnectBanner.y + this.disconnectBanner.height + spacing.xs
        : SECTION_PADDING;
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
    const targets: {
      view: Container;
      finalX: number;
      finalY: number;
      rowX: number;
      rowY: number;
    }[] = [];

    if (isYou) {
      const rowX = this.myHandRow.x;
      const rowY = this.myHandRow.y;
      for (const card of drawn) {
        const v = this.findHandCardView(card);
        if (!v) continue;
        targets.push({ view: v, finalX: v.x, finalY: v.y, rowX, rowY });
      }
    } else {
      const slot = this.opponentSlots.get(event.by);
      if (!slot) return;
      const stack = slot.cardStack;
      const childCount = stack.children.length;
      const startIdx = Math.max(0, childCount - drawn.length);
      const stackOriginX = slot.x + stack.x;
      const stackOriginY = slot.y + stack.y;
      for (let i = startIdx; i < childCount; i += 1) {
        const v = stack.children[i] as Container | undefined;
        if (!v) continue;
        targets.push({
          view: v,
          finalX: v.x,
          finalY: v.y,
          rowX: stackOriginX,
          rowY: stackOriginY,
        });
      }
    }

    if (targets.length === 0) return;

    for (const t of targets) {
      t.view.x = sourceWorld.x - t.rowX;
      t.view.y = sourceWorld.y - t.rowY;
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
    const targets: {
      view: Container;
      rowX: number;
      rowY: number;
      finalX: number;
      finalY: number;
    }[] = [];

    const myRowX = this.myHandRow.x;
    const myRowY = this.myHandRow.y;
    for (const child of this.myHandRow.children) {
      const v = child as Container;
      targets.push({ view: v, rowX: myRowX, rowY: myRowY, finalX: v.x, finalY: v.y });
    }
    for (const slot of this.opponentSlots.values()) {
      const stack = slot.cardStack;
      const stackOriginX = slot.x + stack.x;
      const stackOriginY = slot.y + stack.y;
      for (const child of stack.children) {
        const v = child as Container;
        targets.push({
          view: v,
          rowX: stackOriginX,
          rowY: stackOriginY,
          finalX: v.x,
          finalY: v.y,
        });
      }
    }

    if (targets.length === 0) return;

    for (const t of targets) {
      t.view.x = sourceWorld.x - t.rowX;
      t.view.y = sourceWorld.y - t.rowY;
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
    const startX = tableStartX(snapshot.table.length);
    const pairColumnWidth = CARD_W + HAND_GAP;
    const ghosts: Container[] = [];
    snapshot.table.forEach((pair: TablePair, i: number) => {
      const a = new CardView(pair.attack);
      a.x = this.tableRow.x + startX + i * pairColumnWidth;
      a.y = this.tableRow.y;
      this.animLayer.addChild(a);
      ghosts.push(a);
      if (pair.defense) {
        const d = new CardView(pair.defense);
        d.x = this.tableRow.x + startX + i * pairColumnWidth + Math.round(CARD_W * 0.25);
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
    if (this.snapshot && seat === this.snapshot.you.seat) {
      return {
        x: this.myHandRow.x + Math.round(this.myHandRow.width / 2 - CARD_W / 2),
        y: this.myHandRow.y,
      };
    }
    const slot = this.opponentSlots.get(seat);
    if (slot) return slot.stackWorldCenter();
    return {
      x: this.myHandRow.x + Math.round(this.myHandRow.width / 2 - CARD_W / 2),
      y: this.myHandRow.y,
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
    if (this.isSpectating(this.snapshot)) return;
    const key = event.key.toLowerCase();
    const pending = this.room?.pendingClose ?? null;
    if (pending && (key === "p" || key === " ")) {
      // P (or Space) to opt out of the throw-in window.
      event.preventDefault();
      if (this.snapshot.seat !== this.snapshot.defender) {
        this.submitAction({ type: "PASS", by: this.snapshot.seat });
      }
      return;
    }
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
    if (this.isSpectating(snapshot)) return;
    const action = legalPlay(snapshot, card);
    if (!action) {
      // The card was legal when it got focus but a snapshot arrived
      // between then and Enter — give the player a visible reason
      // their input went nowhere instead of just an SFX-and-silence.
      this.setError("MOVE_NO_LONGER_LEGAL", "That move is no longer legal.");
      return;
    }
    this.submitAction(action);
  }
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
  if (table.length === 0) {
    return seat === attacker ? "Your turn — attack" : "Opponent's turn";
  }
  // Any non-defender can throw in once a round is in progress.
  if (hasLegalThrowIn(snapshot)) return "Your turn — throw in or pass";
  if (seat === attacker) return "Your turn — throw in or pass";
  return "Opponent's turn";
}

// When the local player has no legal card play, return the single
// keybind action they can take so the HUD can surface it prominently.
// Returns null when card plays exist (the player has a real choice) or
// when there's no action to surface (waiting on someone else).
function forcedActionFor(
  snapshot: Snapshot,
  pendingClose: PendingCloseState | null = null,
): { label: string; key: string } | null {
  const { seat, attacker, defender, table } = snapshot;
  if (pendingClose && seat !== defender) {
    if (hasLegalThrowIn(snapshot)) return null;
    return { label: "PASS", key: "P" };
  }
  if (seat === defender) {
    if (hasLegalDefense(snapshot)) return null;
    if (table.some((p) => !p.defense)) return { label: "TAKE PILE", key: "T" };
    return null;
  }
  if (seat === attacker) {
    if (table.length === 0) return null;
    if (hasLegalThrowIn(snapshot)) return null;
    // END ROUND is only legal once every attack on the table is
    // defended — the engine rejects it otherwise. Without this guard
    // the banner shows "END ROUND" while the defender is still
    // working through undefended attacks, which both reads as
    // premature and would error if the player actually pressed E.
    if (table.some((p) => !p.defense)) return null;
    return { label: "END ROUND", key: "E" };
  }
  return null;
}

function keyHintFor(snapshot: Snapshot, pendingClose: PendingCloseState | null = null): string {
  const { seat, attacker, defender, table } = snapshot;
  const muteHint = "M: mute";
  // During the pending-close window every non-defender can throw in
  // (matching rank) or pass. The window collapses when every active
  // non-defender has passed; the round resolution is already queued.
  if (pendingClose && seat !== defender) {
    if (hasLegalThrowIn(snapshot)) {
      return `Arrow keys: select  •  Enter: throw in  •  P: pass  •  ${muteHint}`;
    }
    return `P: pass  •  ${muteHint}`;
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
  if (seat === attacker && table.length === 0) {
    return `Arrow keys: select  •  Enter: attack  •  ${muteHint}`;
  }
  if (table.length > 0 && hasLegalThrowIn(snapshot)) {
    // Only the attacker can call END_ROUND; other non-defenders can only
    // throw in or wait.
    if (seat === attacker) {
      return `Arrow keys: select  •  Enter: throw in  •  E: end round  •  ${muteHint}`;
    }
    return `Arrow keys: select  •  Enter: throw in  •  ${muteHint}`;
  }
  if (seat === attacker) {
    return `E: end round  •  ${muteHint}`;
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
  if (seat === attacker && table.length === 0) {
    return { type: "ATTACK", by: seat, card };
  }
  // THROW_IN is open to any non-defender (including non-attacker seats in FFA)
  // as long as the card's rank is already on the table. Engine enforces the
  // hand-cap constraint server-side.
  if (table.length > 0) {
    const ranks = ranksOnTable(table);
    if (ranks.has(card.rank)) {
      return { type: "THROW_IN", by: seat, card };
    }
  }
  return null;
}

// X offset (relative to a screen-centered tableRow pivot) of the leftmost
// pair so the row of pairs is symmetric around 0. CARD_W is the pair-column
// width baseline; defense cards sit at a small offset within the column.
function tableStartX(pairCount: number): number {
  if (pairCount <= 0) return 0;
  const pairColumnWidth = CARD_W + HAND_GAP;
  const totalW = pairCount * pairColumnWidth - HAND_GAP;
  return -Math.round(totalW / 2);
}

export { keyHintFor, legalPlay, turnLabelFor };
