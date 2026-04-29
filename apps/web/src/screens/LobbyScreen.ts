import {
  color,
  FocusManager,
  mountTextInputOverlay,
  Panel,
  spacing,
  type TextInputOverlayHandle,
  typography,
} from "@durak/ui";
import { Container, Graphics, Text } from "pixi.js";
import type { Screen } from "./types.js";

const PANEL_W = 540;
const PANEL_H = 360;
const FIELD_W = 240;
const FIELD_H = 48;
const ROOM_CODE_MAX = 8;

export interface LobbyScreenOptions {
  roomCode: string;
  shareUrl: string;
  onJoin(code: string): void;
}

export class LobbyScreen extends Container implements Screen {
  private readonly focus = new FocusManager();
  private readonly panel: Panel;
  private readonly field: Container;
  private readonly fieldBg: Graphics;
  private readonly fieldText: Text;
  private readonly fieldHint: Text;
  private readonly fieldLocalX: number;
  private readonly fieldLocalY: number;
  private readonly onJoin: (code: string) => void;
  private overlay: TextInputOverlayHandle | null = null;
  private inputValue = "";

  constructor(options: LobbyScreenOptions) {
    super();
    this.onJoin = options.onJoin;

    this.panel = new Panel({ width: PANEL_W, height: PANEL_H });
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
    roomLabel.y = heading.y + heading.height + spacing.md;
    this.panel.addChild(roomLabel);

    const roomCode = new Text({
      text: options.roomCode,
      style: {
        fontFamily: typography.family,
        fontSize: typography.size.xl,
        fontWeight: typography.weight.bold,
        fill: color.accent,
        letterSpacing: typography.letterSpacing.stamp,
      },
    });
    roomCode.x = Math.round((PANEL_W - roomCode.width) / 2);
    roomCode.y = roomLabel.y + roomLabel.height + spacing.xs;
    this.panel.addChild(roomCode);

    const shareLabel = new Text({
      text: "SHARE",
      style: {
        fontFamily: typography.family,
        fontSize: typography.size.xs,
        fill: color.textMuted,
        letterSpacing: typography.letterSpacing.wide,
      },
    });
    shareLabel.x = Math.round((PANEL_W - shareLabel.width) / 2);
    shareLabel.y = roomCode.y + roomCode.height + spacing.md;
    this.panel.addChild(shareLabel);

    const shareUrl = new Text({
      text: options.shareUrl,
      style: {
        fontFamily: typography.family,
        fontSize: typography.size.sm,
        fill: color.text,
        letterSpacing: typography.letterSpacing.tight,
      },
    });
    shareUrl.x = Math.round((PANEL_W - shareUrl.width) / 2);
    shareUrl.y = shareLabel.y + shareLabel.height + spacing.xs;
    this.panel.addChild(shareUrl);

    const joinLabel = new Text({
      text: "JOIN A ROOM",
      style: {
        fontFamily: typography.family,
        fontSize: typography.size.xs,
        fill: color.textMuted,
        letterSpacing: typography.letterSpacing.wide,
      },
    });
    joinLabel.x = Math.round((PANEL_W - joinLabel.width) / 2);
    joinLabel.y = shareUrl.y + shareUrl.height + spacing.lg;
    this.panel.addChild(joinLabel);

    this.fieldLocalX = Math.round((PANEL_W - FIELD_W) / 2);
    this.fieldLocalY = joinLabel.y + joinLabel.height + spacing.sm;

    this.field = new Container();
    this.field.x = this.fieldLocalX;
    this.field.y = this.fieldLocalY;
    this.panel.addChild(this.field);

    this.fieldBg = new Graphics();
    this.fieldBg
      .roundRect(0, 0, FIELD_W, FIELD_H, 2)
      .fill({ color: color.bgSunken })
      .stroke({ color: color.borderFocus, width: 2, alignment: 0 });
    this.field.addChild(this.fieldBg);

    this.fieldText = new Text({
      text: "",
      style: {
        fontFamily: typography.family,
        fontSize: typography.size.lg,
        fontWeight: typography.weight.bold,
        fill: color.text,
        letterSpacing: typography.letterSpacing.stamp,
      },
    });
    this.fieldHint = new Text({
      text: "TYPE CODE  -  ENTER",
      style: {
        fontFamily: typography.family,
        fontSize: typography.size.xs,
        fill: color.textMuted,
        letterSpacing: typography.letterSpacing.wide,
      },
    });
    this.field.addChild(this.fieldText);
    this.field.addChild(this.fieldHint);
    this.layoutFieldText();

    this.focus.attach();
  }

  layout(viewWidth: number, viewHeight: number): void {
    this.panel.x = Math.round((viewWidth - PANEL_W) / 2);
    this.panel.y = Math.round((viewHeight - PANEL_H) / 2);
    this.remountOverlay();
  }

  dispose(): void {
    this.overlay?.unmount();
    this.overlay = null;
    this.focus.detach();
    this.focus.clear();
  }

  private remountOverlay(): void {
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

  private layoutFieldText(): void {
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
