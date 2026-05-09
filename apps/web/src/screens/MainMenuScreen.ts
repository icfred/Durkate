import type { BotDifficulty } from "@durak/protocol";
import { Button, color, FocusManager, Panel, spacing, typography } from "@durak/ui";
import { Container, Text } from "pixi.js";
import { attachButtonHover, attachFocusNavSfx, withClickSound } from "../audio/index.js";
import type { Mode } from "../store.js";
import type { Screen } from "./types.js";

const PANEL_W = 480;
const PANEL_H = 320;

export type FfaPlayerCount = 2 | 3 | 4 | 5 | 6;

export interface FfaConfig {
  playerCount: FfaPlayerCount;
  botCount: number;
  difficulty: BotDifficulty;
}

export interface GameSetupConfig {
  playerCount: FfaPlayerCount;
  botCount: number;
  difficulty: BotDifficulty;
  rounds: number;
}

export interface MainMenuScreenOptions {
  /**
   * Single entry — drops the user straight into the lobby with sane
   * defaults (2 players, 1 bot, BO3 medium). Player count, rounds,
   * and per-bot difficulty are adjusted in the lobby itself.
   */
  onStart(config: GameSetupConfig): void;
}

const DEFAULT_CONFIG: GameSetupConfig = {
  playerCount: 2,
  botCount: 1,
  difficulty: "medium",
  rounds: 3,
};

export class MainMenuScreen extends Container implements Screen {
  private readonly panel: Panel;
  private readonly focus: FocusManager;
  private readonly detachFocusNavSfx: () => void;
  private readonly title: Text;
  private readonly hint: Text;
  private readonly playButton: Button;

  constructor(options: MainMenuScreenOptions) {
    super();

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
      text: "ENTER TO PLAY",
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

    const buttonW = 260;
    const buttonH = 56;
    const stackY = this.title.y + this.title.height + spacing.xl + spacing.lg;
    this.playButton = new Button({
      label: "PLAY",
      width: buttonW,
      height: buttonH,
      onActivate: withClickSound(() => options.onStart({ ...DEFAULT_CONFIG })),
    });
    attachButtonHover(this.playButton);
    this.playButton.x = Math.round((PANEL_W - buttonW) / 2);
    this.playButton.y = stackY;
    this.panel.addChild(this.playButton);
    this.focus.register(this.playButton);
    this.focus.attach();
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
}

export type { Mode };
