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
const PANEL_H_BASE = 520;
const PANEL_H_PER_EXTRA_SHARE = 70;
const FIELD_W = 240;
const FIELD_H = 48;
const COPY_BUTTON_W = 140;
const COPY_BUTTON_H = 36;
const BACK_BUTTON_W = 140;
const BACK_BUTTON_H = 36;
const RETRY_BUTTON_W = 160;
const RETRY_BUTTON_H = 40;
const ROOM_CODE_MAX = 8;
const SHARE_URL_MAX_CHARS = 56;

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
  private readonly roomCode: string;
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
    this.mode = options.mode;
    this.roomCode = options.roomCode;
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
        fontSize: typography.size.md,
        fontWeight: typography.weight.bold,
        fill: color.accent,
        letterSpacing: typography.letterSpacing.wide,
      },
    });
    this.status.y = heading.y + heading.height + spacing.md;
    this.layoutStatus();
    this.readyContent.addChild(this.status);

    if (this.mode !== "bot" && this.humansExpected > 1) {
      this.joinedLabel = new Text({
        text: this.joinedLabelText(options.initialRoom),
        style: {
          fontFamily: typography.family,
          fontSize: typography.size.sm,
          fill: color.textMuted,
          letterSpacing: typography.letterSpacing.wide,
        },
      });
      this.joinedLabel.y = this.status.y + this.status.height + spacing.xs;
      this.layoutJoinedLabel();
      this.readyContent.addChild(this.joinedLabel);
    } else {
      this.joinedLabel = null;
    }

    const codeBaseY =
      (this.joinedLabel
        ? this.joinedLabel.y + this.joinedLabel.height
        : this.status.y + this.status.height) + spacing.lg;

    const roomLabel = new Text({
      text: "ROOM",
      style: {
        fontFamily: typography.family,
        fontSize: typography.size.xs,
        fill: color.textMuted,
        letterSpacing: typography.letterSpacing.wide,
      },
    });
    roomLabel.x = Math.round((PANEL_W - roomLabel.width) / 2);
    roomLabel.y = codeBaseY;
    this.readyContent.addChild(roomLabel);

    const roomCodeText = new Text({
      text: this.roomCode,
      style: {
        fontFamily: typography.family,
        fontSize: typography.size.xl,
        fontWeight: typography.weight.bold,
        fill: color.accent,
        letterSpacing: typography.letterSpacing.stamp,
      },
    });
    roomCodeText.x = Math.round((PANEL_W - roomCodeText.width) / 2);
    roomCodeText.y = roomLabel.y + roomLabel.height + spacing.xs;
    this.readyContent.addChild(roomCodeText);

    let nextY = roomCodeText.y + roomCodeText.height + spacing.md;

    if (this.shareUrls.length > 0) {
      // One share label + one share URL + one copy button — no per-token
      // duplication. The first URL is always a valid invite (room code +
      // any seat token reserves a seat); using the first one keeps the
      // UI flat and reads as "the room link". Empty seats default to
      // bots, and a friend joining via this link takes a bot's seat
      // (server-side lobby-hold swap).
      const url = this.shareUrls[0] as string;
      const shareLabel = new Text({
        text: "INVITE LINK",
        style: {
          fontFamily: typography.family,
          fontSize: typography.size.xs,
          fill: color.textMuted,
          letterSpacing: typography.letterSpacing.wide,
        },
      });
      shareLabel.x = Math.round((PANEL_W - shareLabel.width) / 2);
      shareLabel.y = nextY;
      this.readyContent.addChild(shareLabel);

      const shareUrlText = new Text({
        text: truncateForDisplay(url, SHARE_URL_MAX_CHARS),
        style: {
          fontFamily: typography.family,
          fontSize: typography.size.sm,
          fill: color.text,
          letterSpacing: typography.letterSpacing.tight,
        },
      });
      shareUrlText.x = Math.round((PANEL_W - shareUrlText.width) / 2);
      shareUrlText.y = shareLabel.y + shareLabel.height + spacing.xs;
      this.readyContent.addChild(shareUrlText);

      const copyButton = new Button({
        label: "COPY LINK",
        width: COPY_BUTTON_W,
        height: COPY_BUTTON_H,
        onActivate: withClickSound(() => this.handleCopy(url)),
      });
      attachButtonHover(copyButton);
      copyButton.x = Math.round((PANEL_W - copyButton.width) / 2);
      copyButton.y = shareUrlText.y + shareUrlText.height + spacing.sm;
      this.readyContent.addChild(copyButton);
      this.focus.register(copyButton);

      nextY = copyButton.y + copyButton.height + spacing.md;
    }

    if (this.mode === "friend") {
      const joinLabel = new Text({
        text: "JOIN ANOTHER ROOM",
        style: {
          fontFamily: typography.family,
          fontSize: typography.size.xs,
          fill: color.textMuted,
          letterSpacing: typography.letterSpacing.wide,
        },
      });
      joinLabel.x = Math.round((PANEL_W - joinLabel.width) / 2);
      joinLabel.y = nextY + spacing.lg;
      this.readyContent.addChild(joinLabel);

      this.fieldLocalX = Math.round((PANEL_W - FIELD_W) / 2);
      this.fieldLocalY = joinLabel.y + joinLabel.height + spacing.sm;

      const field = new Container();
      field.x = this.fieldLocalX;
      field.y = this.fieldLocalY;
      this.readyContent.addChild(field);

      const fieldBg = new Graphics();
      fieldBg
        .roundRect(0, 0, FIELD_W, FIELD_H, 2)
        .fill({ color: color.bgSunken })
        .stroke({ color: color.borderFocus, width: 2, alignment: 0 });
      field.addChild(fieldBg);

      const fieldText = new Text({
        text: "",
        style: {
          fontFamily: typography.family,
          fontSize: typography.size.lg,
          fontWeight: typography.weight.bold,
          fill: color.text,
          letterSpacing: typography.letterSpacing.stamp,
        },
      });
      const fieldHint = new Text({
        text: "TYPE CODE  -  ENTER",
        style: {
          fontFamily: typography.family,
          fontSize: typography.size.xs,
          fill: color.textMuted,
          letterSpacing: typography.letterSpacing.wide,
        },
      });
      field.addChild(fieldText);
      field.addChild(fieldHint);
      this.field = field;
      this.fieldText = fieldText;
      this.fieldHint = fieldHint;
      this.layoutFieldText();
      nextY = this.fieldLocalY + FIELD_H;
    } else {
      this.field = null;
      this.fieldText = null;
      this.fieldHint = null;
      this.fieldLocalX = 0;
      this.fieldLocalY = 0;
    }

    if (options.onStart) {
      const onStart = options.onStart;
      const startButton = new Button({
        label: "START NOW",
        width: 200,
        height: 44,
        onActivate: withClickSound(() => onStart()),
      });
      attachButtonHover(startButton);
      startButton.x = Math.round((PANEL_W - 200) / 2);
      startButton.y = nextY + spacing.lg;
      this.readyContent.addChild(startButton);
      this.focus.register(startButton);
      nextY = startButton.y + 44;
    }

    if (options.onBack) {
      const onBack = options.onBack;
      const backButton = new Button({
        label: "BACK",
        width: BACK_BUTTON_W,
        height: BACK_BUTTON_H,
        onActivate: withClickSound(() => onBack()),
      });
      attachButtonHover(backButton);
      backButton.x = Math.round((PANEL_W - BACK_BUTTON_W) / 2);
      backButton.y = nextY + spacing.lg;
      this.readyContent.addChild(backButton);
      this.focus.register(backButton);
      nextY = backButton.y + BACK_BUTTON_H;
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

function defaultCopyToClipboard(text: string): Promise<void> | void {
  if (typeof navigator !== "undefined" && navigator.clipboard) {
    return navigator.clipboard.writeText(text);
  }
}

function truncateForDisplay(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.max(0, max - 1);
  return `${text.slice(0, head)}…`;
}
