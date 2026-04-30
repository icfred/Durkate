import type { BotDifficulty } from "@durak/protocol";
import { Button, color, FocusManager, Panel, spacing, typography } from "@durak/ui";
import { Container, Text } from "pixi.js";
import { attachButtonHover, attachFocusNavSfx, withClickSound } from "../audio/index.js";
import type { Mode } from "../store.js";
import type { Screen } from "./types.js";

const PANEL_W = 480;
const PANEL_H = 360;

export interface MainMenuScreenOptions {
  onPlayBot(difficulty: BotDifficulty): void;
  onPlayFriend(): void;
}

type View = "root" | "bot-difficulty";

export class MainMenuScreen extends Container implements Screen {
  private readonly options: MainMenuScreenOptions;
  private readonly panel: Panel;
  private focus: FocusManager;
  private detachFocusNavSfx: () => void;
  private readonly title: Text;
  private readonly hint: Text;
  private buttons: Button[] = [];
  private view: View = "root";

  constructor(options: MainMenuScreenOptions) {
    super();
    this.options = options;

    this.panel = new Panel({ width: PANEL_W, height: PANEL_H });
    this.addChild(this.panel);

    this.title = new Text({
      text: "DURAK",
      style: {
        fontFamily: typography.family,
        fontSize: typography.size.xxl,
        fontWeight: typography.weight.bold,
        fill: color.text,
        letterSpacing: typography.letterSpacing.stamp,
      },
    });
    this.title.x = Math.round((PANEL_W - this.title.width) / 2);
    this.title.y = spacing.xl;
    this.panel.addChild(this.title);

    this.hint = new Text({
      text: "ARROWS / TAB MOVE  -  ENTER ACTIVATES",
      style: {
        fontFamily: typography.family,
        fontSize: typography.size.xs,
        fill: color.textMuted,
        letterSpacing: typography.letterSpacing.wide,
      },
    });
    this.hint.x = Math.round((PANEL_W - this.hint.width) / 2);
    this.hint.y = this.title.y + this.title.height + spacing.sm;
    this.panel.addChild(this.hint);

    this.focus = new FocusManager();
    this.detachFocusNavSfx = attachFocusNavSfx(this.focus);
    this.renderRoot();
  }

  layout(viewWidth: number, viewHeight: number): void {
    this.panel.x = Math.round((viewWidth - PANEL_W) / 2);
    this.panel.y = Math.round((viewHeight - PANEL_H) / 2);
  }

  dispose(): void {
    this.detachFocusNavSfx();
    this.focus.detach();
    this.focus.clear();
  }

  private renderRoot(): void {
    this.view = "root";
    this.resetButtons();
    const buttonW = 260;
    const buttonH = 56;
    const stackY = this.title.y + this.title.height + spacing.xl + spacing.lg;

    const playBot = new Button({
      label: "PLAY VS BOT",
      width: buttonW,
      height: buttonH,
      onActivate: withClickSound(() => this.renderBotDifficulty()),
    });
    attachButtonHover(playBot);
    playBot.x = Math.round((PANEL_W - buttonW) / 2);
    playBot.y = stackY;
    this.panel.addChild(playBot);
    this.buttons.push(playBot);

    const playFriend = new Button({
      label: "PLAY VS FRIEND",
      width: buttonW,
      height: buttonH,
      onActivate: withClickSound(() => this.options.onPlayFriend()),
    });
    attachButtonHover(playFriend);
    playFriend.x = Math.round((PANEL_W - buttonW) / 2);
    playFriend.y = stackY + buttonH + spacing.md;
    this.panel.addChild(playFriend);
    this.buttons.push(playFriend);

    this.refreshFocus();
  }

  private renderBotDifficulty(): void {
    this.view = "bot-difficulty";
    this.resetButtons();
    const buttonW = 260;
    const buttonH = 48;
    const stackY = this.title.y + this.title.height + spacing.xl + spacing.lg;

    const difficulties: { label: string; value: BotDifficulty }[] = [
      { label: "EASY", value: "easy" },
      { label: "MEDIUM", value: "medium" },
      { label: "HARD", value: "hard" },
    ];
    difficulties.forEach((d, idx) => {
      const button = new Button({
        label: d.label,
        width: buttonW,
        height: buttonH,
        onActivate: withClickSound(() => this.options.onPlayBot(d.value)),
      });
      attachButtonHover(button);
      button.x = Math.round((PANEL_W - buttonW) / 2);
      button.y = stackY + idx * (buttonH + spacing.sm);
      this.panel.addChild(button);
      this.buttons.push(button);
    });

    const back = new Button({
      label: "BACK",
      width: buttonW,
      height: buttonH,
      onActivate: withClickSound(() => this.renderRoot()),
    });
    attachButtonHover(back);
    back.x = Math.round((PANEL_W - buttonW) / 2);
    back.y = stackY + difficulties.length * (buttonH + spacing.sm) + spacing.md;
    this.panel.addChild(back);
    this.buttons.push(back);

    this.refreshFocus();
  }

  private resetButtons(): void {
    for (const button of this.buttons) {
      this.panel.removeChild(button);
      button.destroy();
    }
    this.buttons = [];
    this.detachFocusNavSfx();
    this.focus.detach();
    this.focus.clear();
    this.focus = new FocusManager();
    this.detachFocusNavSfx = attachFocusNavSfx(this.focus);
  }

  private refreshFocus(): void {
    for (const button of this.buttons) this.focus.register(button);
    this.focus.attach();
  }

  // Test seam: which view is currently rendered.
  testView(): View {
    return this.view;
  }
}

export type { Mode };
