import {
  Button,
  color,
  FocusManager,
  mountTextInputOverlay,
  Panel,
  spacing,
  type TextInputOverlayHandle,
  typography,
} from "@durak/ui";
import { Container, Graphics, Text } from "pixi.js";
import { attachButtonHover, attachFocusNavSfx, withClickSound } from "../audio/index.js";
import type { Mode, RoomCreationState, RoomMembership } from "../store.js";
import { attachBackNav } from "./backNav.js";
import type { Screen } from "./types.js";

const PANEL_W = 540;
const PANEL_H_BASE = 540;
const PANEL_H_PER_EXTRA_SHARE = 0;
const CONFIG_CELL_H = 36;
const DIVIDER_PAD = spacing.md;
const FIELD_W = 240;
const FIELD_H = 48;
const COPY_BUTTON_H = 36;
const BACK_BUTTON_W = 140;
const BACK_BUTTON_H = 40;
const RETRY_BUTTON_W = 160;
const RETRY_BUTTON_H = 40;
const ROOM_CODE_MAX = 8;

export type LobbyStatus = "waiting" | "starting" | "ready";

export interface LobbyScreenOptions {
  mode: Mode;
  roomCode: string;
  /** Total seats in the room (humans + bots). Defaults to 2 for back-compat. */
  playerCount?: number;
  /** Bot seats. Defaults to 0 for friend, 1 for bot. */
  botCount?: number;
  /** One share URL per join token. Empty when no shares are needed. */
  shareUrls?: string[];
  /** Legacy single-share URL fallback when `shareUrls` is omitted. */
  shareUrl?: string;
  initialRoom: RoomMembership | null;
  subscribe?: (listener: (room: RoomMembership | null) => void) => () => void;
  initialCreation?: RoomCreationState;
  subscribeCreation?: (listener: (state: RoomCreationState) => void) => () => void;
  onRetry?: () => void;
  onBack?: () => void;
  onJoin(code: string): void;
  /**
   * Host-side "start now" — sends a `StartGame` WS message and lets the
   * server fill any unfilled human slots with bots and begin. Provide
   * for FFA lobby-hold rooms; omit for friend / bot rooms which auto-
   * start when seats fill.
   */
  onStart?(): void;
  /**
   * Host-side per-bot difficulty cycle. Wired to the `SetBotDifficulty`
   * WS action via the store. Omit (or no-op) for non-host clients.
   */
  onCycleBotDifficulty?(seat: number): void;
  /**
   * Best-of-N rounds for this room. Drives the ROUNDS cycle button
   * label. Omit (or 1) on legacy single-round flows.
   */
  rounds?: number;
  /**
   * Host-side cycle: bumps `playerCount` and re-creates the room.
   * `dir` is +1 (next/up) or -1 (previous/down). Click activations
   * call with +1; arrow keys pass the direction.
   */
  onCyclePlayers?(dir: 1 | -1): void;
  /** Host-side cycle: bumps `rounds` and re-creates the room. */
  onCycleRounds?(dir: 1 | -1): void;
  /**
   * Restore focus to a specific control on construction. Used when
   * the lobby is rebuilt after a PLAYERS / ROUNDS cycle so the user
   * stays on the control they just adjusted.
   */
  initialFocus?: "players" | "rounds";
  copyToClipboard?(text: string): Promise<void> | void;
}

function humansExpected(mode: Mode, playerCount: number, botCount: number): number {
  if (mode === "bot") return 1;
  return Math.max(1, playerCount - botCount);
}

function humansJoined(room: RoomMembership | null): number {
  const seats = room?.seats ?? [];
  return seats.filter((s) => s.name !== null).length;
}

function deriveStatus(
  mode: Mode,
  expected: number,
  room: RoomMembership | null,
  holdsForStart: boolean,
): LobbyStatus {
  if (holdsForStart) return "ready";
  if (mode === "bot") return "starting";
  return humansJoined(room) >= expected ? "starting" : "waiting";
}

function headlineFor(mode: Mode, status: LobbyStatus, expected: number): string {
  if (status === "ready") return "READY — START OR INVITE FRIENDS";
  if (status === "starting") {
    return mode === "bot" ? "STARTING VS BOT" : "STARTING";
  }
  if (expected > 2) return "WAITING FOR PLAYERS";
  return "WAITING FOR OPPONENT";
}

export class LobbyScreen extends Container implements Screen {
  private readonly focus = new FocusManager();
  private readonly panel: Panel;
  private readonly mode: Mode;
  private readonly playerCount: number;
  private readonly botCount: number;
  private readonly humansExpected: number;
  private readonly shareUrls: string[];
  private readonly status: Text;
  private readonly joinedLabel: Text | null;
  private readonly copyToClipboard: (text: string) => Promise<void> | void;
  private readonly readyContent: Container;
  private readonly creationOverlay: Container;
  private readonly creationText: Text;
  private readonly retryButton: Button | null;
  private readonly field: Container | null;
  private readonly fieldText: Text | null;
  private readonly fieldHint: Text | null;
  private readonly fieldLocalX: number;
  private readonly fieldLocalY: number;
  private readonly onJoin: (code: string) => void;
  private readonly holdsForStart: boolean;
  private readonly roster: Container;
  private readonly onCycleBotDifficulty: ((seat: number) => void) | undefined;
  private rosterRows: Container[] = [];
  private readonly playersControl: Container | null;
  private readonly roundsControl: Container | null;
  // Track the live Button instance so `update()` can refresh the
  // ROUNDS label when the first RoomState arrives (the initial render
  // happens before `state.room.match` is populated).
  private roundsButton: Button | null = null;
  // Tag for the currently-focused cycle control. Set by the patched
  // `setFocus` on PLAYERS / ROUNDS buttons; consumed by the capture-
  // phase keydown handler so arrow-key presses adjust the value
  // instead of moving focus to a neighbour.
  private focusedCycleControl: "players" | "rounds" | null = null;
  private readonly arrowKeyHandler: (event: KeyboardEvent) => void;
  private readonly cycleHandlers: {
    players?: (dir: 1 | -1) => void;
    rounds?: (dir: 1 | -1) => void;
  } = {};
  private overlay: TextInputOverlayHandle | null = null;
  private inputValue = "";
  private currentStatus: LobbyStatus;
  private creation: RoomCreationState;
  private readonly unsubscribeRoom: (() => void) | null;
  private readonly unsubscribeCreation: (() => void) | null;
  private readonly detachFocusNavSfx: () => void;
  private readonly detachBackNav: (() => void) | null;
  private readonly panelH: number;

  constructor(options: LobbyScreenOptions) {
    super();
    // Capture-phase arrow handler: runs before FocusManager's window
    // keydown listener, intercepts ←/→ when one of the cycle buttons
    // is focused, and dispatches a value bump. Without this the arrow
    // keys would just move focus to a sibling button.
    this.arrowKeyHandler = (event) => this.handleArrowKey(event);
    this.mode = options.mode;
    void options.roomCode;
    this.playerCount = options.playerCount ?? 2;
    this.botCount = options.botCount ?? (options.mode === "bot" ? 1 : 0);
    this.humansExpected = humansExpected(this.mode, this.playerCount, this.botCount);
    this.shareUrls =
      options.shareUrls ?? (options.shareUrl && this.mode !== "bot" ? [options.shareUrl] : []);
    this.onJoin = options.onJoin;
    this.holdsForStart = options.onStart !== undefined;
    this.copyToClipboard = options.copyToClipboard ?? defaultCopyToClipboard;
    this.currentStatus = deriveStatus(
      this.mode,
      this.humansExpected,
      options.initialRoom,
      this.holdsForStart,
    );
    this.creation = options.initialCreation ?? { status: "ready" };

    // The lobby always shows at most one invite link now — no per-seat
    // share-url stacking. PANEL_H_PER_EXTRA_SHARE is retained as 0 to
    // keep the constant near the other layout tokens for future use.
    void PANEL_H_PER_EXTRA_SHARE;
    // FFA lobby hold: the START NOW button needs an extra ~70px of
    // panel height beyond the share-url block so it doesn't overflow
    // into the back button.
    const startBlock = options.onStart ? 70 : 0;
    this.panelH = PANEL_H_BASE + startBlock;

    this.panel = new Panel({ width: PANEL_W, height: this.panelH });
    this.addChild(this.panel);

    const heading = new Text({
      text: "LOBBY",
      style: {
        fontFamily: typography.family,
        fontSize: typography.size.xl,
        fontWeight: typography.weight.bold,
        fill: color.text,
        letterSpacing: typography.letterSpacing.stamp,
      },
    });
    heading.x = Math.round((PANEL_W - heading.width) / 2);
    heading.y = spacing.lg;
    this.panel.addChild(heading);

    this.readyContent = new Container();
    this.panel.addChild(this.readyContent);

    this.status = new Text({
      text: headlineFor(this.mode, this.currentStatus, this.humansExpected),
      style: {
        fontFamily: typography.family,
        fontSize: typography.size.sm,
        fill: color.textMuted,
        letterSpacing: typography.letterSpacing.wide,
      },
    });
    this.status.y = heading.y + heading.height + spacing.xs;
    this.layoutStatus();
    this.readyContent.addChild(this.status);

    let nextY = this.status.y + this.status.height + spacing.lg;
    this.addDivider(nextY);
    nextY += DIVIDER_PAD;

    // Config row: PLAYERS and ROUNDS cycle controls. Stacked vertically
    // so each gets the full panel width, since the user steers them with
    // ←/→ to bump the value. Click also cycles forward (Enter on a
    // focused button via FocusManager).
    if (options.onCyclePlayers || options.onCycleRounds || options.rounds !== undefined) {
      const rounds = options.rounds ?? 1;
      const cellW = PANEL_W - spacing.lg * 2;

      const playersCb = options.onCyclePlayers;
      const playersOpts: Parameters<typeof this.makeConfigCell>[0] = {
        label: `PLAYERS: ${this.playerCount}`,
        x: spacing.lg,
        y: nextY,
        w: cellW,
      };
      if (playersCb) {
        playersOpts.onActivate = () => playersCb(1);
        playersOpts.cycleKind = "players";
      }
      this.playersControl = this.makeConfigCell(playersOpts);
      this.readyContent.addChild(this.playersControl);
      if (playersCb) this.cycleHandlers.players = playersCb;
      nextY += CONFIG_CELL_H + spacing.sm;

      const roundsCb = options.onCycleRounds;
      const roundsOpts: Parameters<typeof this.makeConfigCell>[0] = {
        label: roundsLabel(rounds),
        x: spacing.lg,
        y: nextY,
        w: cellW,
      };
      if (roundsCb) {
        roundsOpts.onActivate = () => roundsCb(1);
        roundsOpts.cycleKind = "rounds";
      }
      this.roundsControl = this.makeConfigCell(roundsOpts);
      this.readyContent.addChild(this.roundsControl);
      this.roundsButton = findChildButton(this.roundsControl);
      if (roundsCb) this.cycleHandlers.rounds = roundsCb;
      nextY += CONFIG_CELL_H + spacing.lg;

      this.addDivider(nextY);
      nextY += DIVIDER_PAD;
    } else {
      this.playersControl = null;
      this.roundsControl = null;
    }

    this.joinedLabel = null;

    // Per-seat roster. Built lazily on every room update so the host
    // can flip a bot's difficulty (or a friend can join via the invite
    // link) and the rows reflect the new state without rebuilding the
    // whole panel.
    this.roster = new Container();
    this.roster.label = "lobby-roster";
    this.roster.y = nextY;
    this.readyContent.addChild(this.roster);
    this.onCycleBotDifficulty = options.onCycleBotDifficulty;
    const initialRosterH = this.renderRoster(options.initialRoom);

    nextY = this.roster.y + initialRosterH + spacing.lg;
    this.addDivider(nextY);
    nextY += DIVIDER_PAD;

    // COPY LINK — single centered button. The URL itself isn't shown:
    // the button copies it on click and that's the only operation the
    // host needs. Saves a row + reads more in line with the rest of
    // the in-game language.
    if (this.shareUrls.length > 0) {
      const url = this.shareUrls[0] as string;
      const copyButton = new Button({
        label: "COPY INVITE LINK",
        width: 220,
        height: COPY_BUTTON_H,
        onActivate: withClickSound(() => this.handleCopy(url)),
      });
      attachButtonHover(copyButton);
      copyButton.x = Math.round((PANEL_W - 220) / 2);
      copyButton.y = nextY;
      this.readyContent.addChild(copyButton);
      this.focus.register(copyButton);
      nextY = copyButton.y + copyButton.height + spacing.lg;
    }

    // The manual JOIN-by-code field is gone — joining a room is via
    // the invite URL, not by typing the code. These fields stay nulled
    // so existing instance code that still references them keeps working.
    this.field = null;
    this.fieldText = null;
    this.fieldHint = null;
    this.fieldLocalX = 0;
    this.fieldLocalY = 0;

    this.addDivider(nextY);
    nextY += DIVIDER_PAD;

    // Action row: BACK and START NOW side by side. START NOW is the
    // primary action (wider, accent-bordered); BACK is secondary.
    const actionGap = spacing.md;
    const startW = 200;
    const backW = BACK_BUTTON_W;
    const actionTotalW = (options.onStart ? startW + actionGap : 0) + (options.onBack ? backW : 0);
    let actionX = Math.round((PANEL_W - actionTotalW) / 2);
    if (options.onBack) {
      const onBack = options.onBack;
      const backButton = new Button({
        label: "BACK",
        width: backW,
        height: BACK_BUTTON_H,
        onActivate: withClickSound(() => onBack()),
      });
      attachButtonHover(backButton);
      backButton.x = actionX;
      backButton.y = nextY;
      this.readyContent.addChild(backButton);
      this.focus.register(backButton);
      actionX += backW + actionGap;
    }
    if (options.onStart) {
      const onStart = options.onStart;
      const startButton = new Button({
        label: "START",
        width: startW,
        height: BACK_BUTTON_H,
        onActivate: withClickSound(() => onStart()),
      });
      attachButtonHover(startButton);
      startButton.x = actionX;
      startButton.y = nextY;
      this.readyContent.addChild(startButton);
      this.focus.register(startButton);
    }

    void nextY;

    this.creationOverlay = new Container();
    this.creationOverlay.visible = false;
    this.panel.addChild(this.creationOverlay);

    this.creationText = new Text({
      text: "",
      style: {
        fontFamily: typography.family,
        fontSize: typography.size.md,
        fontWeight: typography.weight.bold,
        fill: color.text,
        letterSpacing: typography.letterSpacing.wide,
      },
    });
    this.creationOverlay.addChild(this.creationText);

    if (options.onRetry) {
      const onRetry = options.onRetry;
      this.retryButton = new Button({
        label: "RETRY",
        width: RETRY_BUTTON_W,
        height: RETRY_BUTTON_H,
        onActivate: withClickSound(() => onRetry()),
      });
      attachButtonHover(this.retryButton);
      this.retryButton.visible = false;
      this.creationOverlay.addChild(this.retryButton);
    } else {
      this.retryButton = null;
    }

    this.applyCreationState();

    this.focus.attach();
    this.detachFocusNavSfx = attachFocusNavSfx(this.focus);

    this.unsubscribeRoom = options.subscribe
      ? options.subscribe((room) => this.update(room))
      : null;
    this.unsubscribeCreation = options.subscribeCreation
      ? options.subscribeCreation((state) => this.updateCreation(state))
      : null;

    this.detachBackNav = options.onBack ? attachBackNav({ onBack: options.onBack }) : null;

    if (this.cycleHandlers.players || this.cycleHandlers.rounds) {
      window.addEventListener("keydown", this.arrowKeyHandler, { capture: true });
    }

    // Apply initial-focus hint AFTER FocusManager.attach so the
    // override beats the auto-first-register focus.
    if (options.initialFocus === "rounds" && this.roundsButton) {
      this.focus.focus(this.roundsButton);
    }
  }

  layout(viewWidth: number, viewHeight: number): void {
    this.panel.x = Math.round((viewWidth - PANEL_W) / 2);
    this.panel.y = Math.round((viewHeight - this.panelH) / 2);
    this.remountOverlay();
  }

  dispose(): void {
    this.unsubscribeRoom?.();
    this.unsubscribeCreation?.();
    this.detachBackNav?.();
    this.detachFocusNavSfx();
    this.overlay?.unmount();
    this.overlay = null;
    this.focus.detach();
    this.focus.clear();
    window.removeEventListener("keydown", this.arrowKeyHandler, { capture: true });
  }

  private handleArrowKey(event: KeyboardEvent): void {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    const target = this.focusedCycleControl;
    if (!target) return;
    const handler = this.cycleHandlers[target];
    if (!handler) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    handler(event.key === "ArrowRight" ? 1 : -1);
  }

  private update(room: RoomMembership | null): void {
    const next = deriveStatus(this.mode, this.humansExpected, room, this.holdsForStart);
    let dirty = false;
    if (next !== this.currentStatus) {
      this.currentStatus = next;
      this.status.text = headlineFor(this.mode, this.currentStatus, this.humansExpected);
      dirty = true;
    }
    if (this.joinedLabel) {
      const text = this.joinedLabelText(room);
      if (this.joinedLabel.text !== text) {
        this.joinedLabel.text = text;
        dirty = true;
      }
    }
    if (dirty) {
      this.layoutStatus();
      this.layoutJoinedLabel();
    }
    this.renderRoster(room);
    if (this.roundsButton) {
      const totalRounds = room?.match?.totalRounds ?? 1;
      this.roundsButton.setLabel(roundsLabel(totalRounds));
    }
  }

  // Render the seat roster: one row per seat with name + role tag. Bot
  // rows expose a difficulty cycle button when the host wired up the
  // callback. Returns the rendered height so the constructor can place
  // the next block (invite link / friend join field) below it.
  private renderRoster(room: RoomMembership | null): number {
    for (const row of this.rosterRows) {
      this.roster.removeChild(row);
      row.destroy({ children: true });
    }
    this.rosterRows = [];

    const seats = room?.seats ?? [];
    const youSeat = room?.you ?? null;
    const rowH = 28;
    const rowGap = 4;
    const seatLabelW = 60;
    const cycleBtnW = 80;
    const cycleBtnH = 22;
    const padX = spacing.md;

    for (let i = 0; i < this.playerCount; i += 1) {
      const seat = seats[i];
      const row = new Container();
      row.label = `lobby-seat-${i}`;
      row.y = i * (rowH + rowGap);

      const seatLabel = new Text({
        text: `SEAT ${i + 1}`,
        style: {
          fontFamily: typography.family,
          fontSize: typography.size.xs,
          fill: color.textMuted,
          letterSpacing: typography.letterSpacing.wide,
        },
      });
      seatLabel.x = padX;
      seatLabel.y = Math.round((rowH - seatLabel.height) / 2);
      row.addChild(seatLabel);

      const isLocalSeat = youSeat !== null && youSeat === i;
      const name = seat?.name ?? null;
      const isBot = seat?.kind === "bot";
      const displayName = isLocalSeat ? "YOU" : (name ?? "—");
      const nameText = new Text({
        text: displayName,
        style: {
          fontFamily: typography.family,
          fontSize: typography.size.sm,
          fontWeight: typography.weight.bold,
          fill: name === null && !isLocalSeat ? color.textDim : color.text,
          letterSpacing: typography.letterSpacing.tight,
        },
      });
      nameText.x = padX + seatLabelW;
      nameText.y = Math.round((rowH - nameText.height) / 2);
      row.addChild(nameText);

      // Right-aligned role tag. Bot rows additionally render a small
      // difficulty cycle button — host-only; the callback is undefined
      // for non-host seats and we hide the button in that case.
      const tagText = isBot
        ? `BOT • ${(seat?.difficulty ?? "medium").toUpperCase()}`
        : isLocalSeat
          ? ""
          : name !== null
            ? "HUMAN"
            : "EMPTY";
      const tag = new Text({
        text: tagText,
        style: {
          fontFamily: typography.family,
          fontSize: typography.size.xs,
          fill: color.textMuted,
          letterSpacing: typography.letterSpacing.wide,
        },
      });
      tag.y = Math.round((rowH - tag.height) / 2);
      row.addChild(tag);

      let rightEdge = PANEL_W - padX;
      if (isBot && this.onCycleBotDifficulty) {
        const cycle = new Button({
          label: "CYCLE",
          width: cycleBtnW,
          height: cycleBtnH,
          onActivate: withClickSound(() => this.onCycleBotDifficulty?.(i)),
        });
        attachButtonHover(cycle);
        cycle.x = rightEdge - cycleBtnW;
        cycle.y = Math.round((rowH - cycleBtnH) / 2);
        row.addChild(cycle);
        this.focus.register(cycle);
        rightEdge = cycle.x - spacing.sm;
      }
      tag.x = rightEdge - tag.width;

      this.roster.addChild(row);
      this.rosterRows.push(row);
    }

    return this.playerCount * rowH + Math.max(0, this.playerCount - 1) * rowGap;
  }

  private joinedLabelText(room: RoomMembership | null): string {
    return `${humansJoined(room)} / ${this.humansExpected} JOINED`;
  }

  private updateCreation(state: RoomCreationState): void {
    if (state.status === this.creation.status) {
      if (state.status !== "error") return;
    }
    this.creation = state;
    this.applyCreationState();
  }

  private applyCreationState(): void {
    const isReady = this.creation.status === "ready" || this.creation.status === "idle";
    this.readyContent.visible = isReady;
    this.creationOverlay.visible = !isReady;
    if (this.field) this.field.visible = isReady;
    if (this.creation.status === "creating") {
      this.creationText.text = "CREATING ROOM...";
    } else if (this.creation.status === "error") {
      this.creationText.text = `COULD NOT CREATE ROOM\n${this.creation.error}`;
    } else {
      this.creationText.text = "";
    }
    this.layoutCreationOverlay();
    if (this.retryButton) {
      this.retryButton.visible = this.creation.status === "error";
      if (this.creation.status === "error") this.focus.register(this.retryButton);
    }
    if (isReady) this.remountOverlay();
    else this.unmountInputOverlay();
  }

  private layoutCreationOverlay(): void {
    const text = this.creationText;
    text.x = Math.round((PANEL_W - text.width) / 2);
    text.y = Math.round(this.panelH * 0.4);
    if (this.retryButton) {
      this.retryButton.x = Math.round((PANEL_W - RETRY_BUTTON_W) / 2);
      this.retryButton.y = text.y + text.height + spacing.lg;
    }
  }

  private layoutStatus(): void {
    this.status.x = Math.round((PANEL_W - this.status.width) / 2);
  }

  // Thin horizontal hairline drawn into readyContent to delimit the
  // panel's sections (config, roster, invite, actions). Color matches
  // the inactive border token so it reads as a separator, not a stroke.
  private addDivider(y: number): void {
    const g = new Graphics();
    g.moveTo(spacing.lg, 0)
      .lineTo(PANEL_W - spacing.lg, 0)
      .stroke({
        color: color.border,
        width: 1,
        alignment: 0.5,
      });
    g.y = y;
    this.readyContent.addChild(g);
  }

  // A clickable config cell: bordered rect with centred label, used for
  // the PLAYERS / ROUNDS cycle controls. When `onActivate` is missing,
  // renders as a plain label (no border, no focus registration) so
  // joiner clients can still read the values. `cycleKind` opts the
  // button into the arrow-key cycle path: its setFocus is patched
  // _before_ FocusManager.register so the very first auto-focus on
  // construction tags `focusedCycleControl` correctly.
  private makeConfigCell(opts: {
    label: string;
    x: number;
    y: number;
    w: number;
    onActivate?: () => void;
    cycleKind?: "players" | "rounds";
  }): Container {
    const cell = new Container();
    cell.x = opts.x;
    cell.y = opts.y;
    if (opts.onActivate) {
      const button = new Button({
        label: opts.label,
        width: opts.w - spacing.sm,
        height: CONFIG_CELL_H,
        onActivate: withClickSound(opts.onActivate),
      });
      attachButtonHover(button);
      button.x = Math.round((opts.w - (opts.w - spacing.sm)) / 2);
      cell.addChild(button);
      if (opts.cycleKind) {
        const kind = opts.cycleKind;
        const original = button.setFocus.bind(button);
        button.setFocus = (focused: boolean) => {
          original(focused);
          if (focused) this.focusedCycleControl = kind;
          else if (this.focusedCycleControl === kind) this.focusedCycleControl = null;
        };
      }
      this.focus.register(button);
    } else {
      const text = new Text({
        text: opts.label,
        style: {
          fontFamily: typography.family,
          fontSize: typography.size.sm,
          fontWeight: typography.weight.bold,
          fill: color.text,
          letterSpacing: typography.letterSpacing.wide,
        },
      });
      text.x = Math.round((opts.w - text.width) / 2);
      text.y = Math.round((CONFIG_CELL_H - text.height) / 2);
      cell.addChild(text);
    }
    return cell;
  }

  private layoutJoinedLabel(): void {
    if (!this.joinedLabel) return;
    this.joinedLabel.x = Math.round((PANEL_W - this.joinedLabel.width) / 2);
  }

  private handleCopy(url: string): void {
    try {
      const result = this.copyToClipboard(url);
      if (result && typeof (result as Promise<void>).then === "function") {
        (result as Promise<void>).catch((err) => {
          console.warn("[lobby] copy failed", err);
        });
      }
    } catch (err) {
      console.warn("[lobby] copy failed", err);
    }
  }

  private remountOverlay(): void {
    if (!this.field || !this.fieldText) return;
    if (this.creation.status !== "ready" && this.creation.status !== "idle") return;
    this.overlay?.unmount();
    this.overlay = mountTextInputOverlay({
      targetRect: {
        x: this.panel.x + this.fieldLocalX,
        y: this.panel.y + this.fieldLocalY,
        width: FIELD_W,
        height: FIELD_H,
      },
      value: this.inputValue,
      focus: this.focus,
      onChange: (next: string) => {
        this.inputValue = next.toUpperCase().slice(0, ROOM_CODE_MAX);
        this.layoutFieldText();
      },
      onSubmit: (next: string) => {
        const trimmed = next.trim().toUpperCase().slice(0, ROOM_CODE_MAX);
        if (trimmed.length === 0) return;
        this.onJoin(trimmed);
      },
    });
  }

  private unmountInputOverlay(): void {
    this.overlay?.unmount();
    this.overlay = null;
  }

  private layoutFieldText(): void {
    if (!this.fieldText || !this.fieldHint) return;
    if (this.inputValue.length === 0) {
      this.fieldText.visible = false;
      this.fieldHint.visible = true;
      this.fieldHint.x = Math.round((FIELD_W - this.fieldHint.width) / 2);
      this.fieldHint.y = Math.round((FIELD_H - this.fieldHint.height) / 2);
      return;
    }
    this.fieldText.text = this.inputValue;
    this.fieldText.visible = true;
    this.fieldHint.visible = false;
    this.fieldText.x = Math.round((FIELD_W - this.fieldText.width) / 2);
    this.fieldText.y = Math.round((FIELD_H - this.fieldText.height) / 2);
  }
}

function roundsLabel(rounds: number): string {
  return rounds <= 1 ? "ROUNDS: SINGLE" : `ROUNDS: BEST OF ${rounds}`;
}

function findChildButton(c: Container): Button | null {
  for (const child of c.children) {
    if (child instanceof Button) return child;
  }
  return null;
}

function defaultCopyToClipboard(text: string): Promise<void> | void {
  if (typeof navigator !== "undefined" && navigator.clipboard) {
    return navigator.clipboard.writeText(text);
  }
}
