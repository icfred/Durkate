import { Button, color, FocusManager, Panel, spacing, typography } from "@durak/ui";
import { Container, Text } from "pixi.js";
import type { Mode } from "../store.js";
import type { Screen } from "./types.js";

const PANEL_W = 480;
const PANEL_H = 360;

export interface MainMenuScreenOptions {
  onPlay(mode: Mode): void;
}

export class MainMenuScreen extends Container implements Screen {
  private readonly focus = new FocusManager();
  private readonly panel: Panel;

  constructor(options: MainMenuScreenOptions) {
    super();

    this.panel = new Panel({ width: PANEL_W, height: PANEL_H });
    this.addChild(this.panel);

    const title = new Text({
      text: "DURAK",
      style: {
        fontFamily: typography.family,
        fontSize: typography.size.xxl,
        fontWeight: typography.weight.bold,
        fill: color.text,
        letterSpacing: typography.letterSpacing.stamp,
      },
    });
    title.x = Math.round((PANEL_W - title.width) / 2);
    title.y = spacing.xl;
    this.panel.addChild(title);

    const hint = new Text({
      text: "ARROWS / TAB MOVE  -  ENTER ACTIVATES",
      style: {
        fontFamily: typography.family,
        fontSize: typography.size.xs,
        fill: color.textMuted,
        letterSpacing: typography.letterSpacing.wide,
      },
    });
    hint.x = Math.round((PANEL_W - hint.width) / 2);
    hint.y = title.y + title.height + spacing.sm;
    this.panel.addChild(hint);

    const buttonW = 260;
    const buttonH = 56;
    const stackY = title.y + title.height + spacing.xl + spacing.lg;

    const playBot = new Button({
      label: "PLAY VS BOT",
      width: buttonW,
      height: buttonH,
      onActivate: () => options.onPlay("bot"),
    });
    playBot.x = Math.round((PANEL_W - buttonW) / 2);
    playBot.y = stackY;
    this.panel.addChild(playBot);

    const playFriend = new Button({
      label: "PLAY VS FRIEND",
      width: buttonW,
      height: buttonH,
      onActivate: () => options.onPlay("friend"),
    });
    playFriend.x = Math.round((PANEL_W - buttonW) / 2);
    playFriend.y = stackY + buttonH + spacing.md;
    this.panel.addChild(playFriend);

    this.focus.register(playBot);
    this.focus.register(playFriend);
    this.focus.attach();
  }

  layout(viewWidth: number, viewHeight: number): void {
    this.panel.x = Math.round((viewWidth - PANEL_W) / 2);
    this.panel.y = Math.round((viewHeight - PANEL_H) / 2);
  }

  dispose(): void {
    this.focus.detach();
    this.focus.clear();
  }
}
