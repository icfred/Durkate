import type { BotDifficulty } from "@durak/protocol";
import { Button, color, FocusManager, Panel, spacing, typography } from "@durak/ui";
import { Container, Text } from "pixi.js";
import { easeOutQuad } from "../anim/easings.js";
import { fadeTo } from "../anim/pixi.js";
import type { TweenHandle } from "../anim/tween.js";
import { attachButtonHover, attachFocusNavSfx, withClickSound } from "../audio/index.js";
import type { Mode } from "../store.js";
import { attachBackNav } from "./backNav.js";
import type { Screen } from "./types.js";

const PANEL_W = 480;
const PANEL_H_ROOT = 320;
const PANEL_H_GAME_SETUP = 580;
const FADE_IN_MS = 220;

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
   * Single entry point: user picks player count / bots / difficulty /
   * rounds in the setup view, then START. Replaces the old per-mode
   * buttons. The wire layer turns this into a `mode` for the worker
   * (bot for 2-player single-bot rooms, friend for 1v1 humans, ffa
   * for the rest).
   */
  onStart(config: GameSetupConfig): void;
  /**
   * Back-compat shim. The old MainMenu surfaced separate `onPlayBot` /
   * `onPlayFriend` / `onPlayFfa` callbacks; tests still reference the
   * `bot-difficulty` / `ffa-config` views. Tests that exercise the old
   * shapes pass these in; production callers wire only `onStart`.
   */
  onPlayBot?: (difficulty: BotDifficulty) => void;
  onPlayFriend?: () => void;
  onPlayFfa?: (config: FfaConfig) => void;
}

type View = "root" | "game-setup";

const PLAYER_COUNTS: readonly FfaPlayerCount[] = [2, 3, 4, 5, 6];
const DIFFICULTIES: readonly BotDifficulty[] = ["easy", "medium", "hard"];
const ROUNDS_OPTIONS: readonly number[] = [1, 3, 5, 7, 9];

export class MainMenuScreen extends Container implements Screen {
  private readonly options: MainMenuScreenOptions;
  private readonly panel: Panel;
  private focus: FocusManager;
  private detachFocusNavSfx: () => void;
  private readonly title: Text;
  private readonly hint: Text;
  private buttons: Button[] = [];
  private view: View = "root";
  private panelH = PANEL_H_ROOT;
  private viewW = 0;
  private viewH = 0;
  private transitioning: TweenHandle | null = null;
  private readonly detachBackNav: () => void;
  private playerCount: FfaPlayerCount = 2;
  private botCount = 1;
  private difficulty: BotDifficulty = "medium";
  private rounds = 3;
  private playersButton: Button | null = null;
  private botsButton: Button | null = null;
  private difficultyButton: Button | null = null;
  private roundsButton: Button | null = null;

  constructor(options: MainMenuScreenOptions) {
    super();
    this.options = options;

    this.panel = new Panel({ width: PANEL_W, height: PANEL_H_ROOT });
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
      text: "ARROWS / TAB MOVE  -  ENTER ACTIVATES  -  BACKSPACE BACK",
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

    this.detachBackNav = attachBackNav({
      onBack: () => this.transitionTo("root"),
      shouldHandle: () => this.view !== "root",
    });

    this.buildRootButtons();
    this.refreshFocus();
  }

  layout(viewWidth: number, viewHeight: number): void {
    this.viewW = viewWidth;
    this.viewH = viewHeight;
    this.panel.x = Math.round((viewWidth - PANEL_W) / 2);
    this.panel.y = Math.round((viewHeight - this.panelH) / 2);
  }

  private setPanelHeight(h: number): void {
    if (this.panelH === h) return;
    this.panelH = h;
    this.panel.resize(PANEL_W, h);
    if (this.viewW > 0 && this.viewH > 0) {
      this.layout(this.viewW, this.viewH);
    }
  }

  dispose(): void {
    this.detachBackNav();
    this.transitioning?.cancel();
    this.transitioning = null;
    this.detachFocusNavSfx();
    this.focus.detach();
    this.focus.clear();
  }

  private transitionTo(target: View): void {
    if (this.view === target) return;
    this.transitioning?.cancel();

    for (const b of this.buttons) {
      this.panel.removeChild(b);
      b.destroy();
    }
    this.buttons = [];
    this.playersButton = null;
    this.botsButton = null;
    this.difficultyButton = null;
    this.roundsButton = null;

    this.detachFocusNavSfx();
    this.focus.detach();
    this.focus.clear();
    this.focus = new FocusManager();
    this.detachFocusNavSfx = attachFocusNavSfx(this.focus);

    this.view = target;
    if (target === "root") {
      this.setPanelHeight(PANEL_H_ROOT);
      this.buildRootButtons();
    } else {
      this.setPanelHeight(PANEL_H_GAME_SETUP);
      this.buildGameSetupButtons();
    }
    for (const b of this.buttons) b.alpha = 0;
    this.refreshFocus();

    const fadeInAnims = this.buttons.map(
      (b) => (done: () => void) => fadeTo(b, 1, FADE_IN_MS, easeOutQuad, { onComplete: done }),
    );
    this.transitioning = parallelOnce(fadeInAnims, () => {
      this.transitioning = null;
    });
  }

  private buildRootButtons(): void {
    const buttonW = 260;
    const buttonH = 56;
    const stackY = this.title.y + this.title.height + spacing.xl + spacing.lg;

    const play = new Button({
      label: "PLAY",
      width: buttonW,
      height: buttonH,
      onActivate: withClickSound(() => this.transitionTo("game-setup")),
    });
    attachButtonHover(play);
    play.x = Math.round((PANEL_W - buttonW) / 2);
    play.y = stackY;
    this.panel.addChild(play);
    this.buttons.push(play);
  }

  private buildGameSetupButtons(): void {
    const buttonW = 320;
    const buttonH = 48;
    const stackY = this.title.y + this.title.height + spacing.xl + spacing.lg;

    this.playersButton = new Button({
      label: this.playersLabel(),
      width: buttonW,
      height: buttonH,
      onActivate: withClickSound(() => this.cyclePlayerCount()),
    });
    attachButtonHover(this.playersButton);
    this.playersButton.x = Math.round((PANEL_W - buttonW) / 2);
    this.playersButton.y = stackY;
    this.panel.addChild(this.playersButton);
    this.buttons.push(this.playersButton);

    this.botsButton = new Button({
      label: this.botsLabel(),
      width: buttonW,
      height: buttonH,
      onActivate: withClickSound(() => this.cycleBotCount()),
    });
    attachButtonHover(this.botsButton);
    this.botsButton.x = Math.round((PANEL_W - buttonW) / 2);
    this.botsButton.y = stackY + (buttonH + spacing.sm);
    this.panel.addChild(this.botsButton);
    this.buttons.push(this.botsButton);

    this.difficultyButton = new Button({
      label: this.difficultyLabel(),
      width: buttonW,
      height: buttonH,
      onActivate: withClickSound(() => this.cycleDifficulty()),
    });
    attachButtonHover(this.difficultyButton);
    this.difficultyButton.x = Math.round((PANEL_W - buttonW) / 2);
    this.difficultyButton.y = stackY + (buttonH + spacing.sm) * 2;
    this.panel.addChild(this.difficultyButton);
    this.buttons.push(this.difficultyButton);

    this.roundsButton = new Button({
      label: this.roundsLabel(),
      width: buttonW,
      height: buttonH,
      onActivate: withClickSound(() => this.cycleRounds()),
    });
    attachButtonHover(this.roundsButton);
    this.roundsButton.x = Math.round((PANEL_W - buttonW) / 2);
    this.roundsButton.y = stackY + (buttonH + spacing.sm) * 3;
    this.panel.addChild(this.roundsButton);
    this.buttons.push(this.roundsButton);

    const start = new Button({
      label: "START",
      width: buttonW,
      height: buttonH,
      onActivate: withClickSound(() =>
        this.options.onStart({
          playerCount: this.playerCount,
          botCount: this.botCount,
          difficulty: this.difficulty,
          rounds: this.rounds,
        }),
      ),
    });
    attachButtonHover(start);
    start.x = Math.round((PANEL_W - buttonW) / 2);
    start.y = stackY + (buttonH + spacing.sm) * 4 + spacing.md;
    this.panel.addChild(start);
    this.buttons.push(start);

    const back = new Button({
      label: "BACK",
      width: buttonW,
      height: buttonH,
      onActivate: withClickSound(() => this.transitionTo("root")),
    });
    attachButtonHover(back);
    back.x = Math.round((PANEL_W - buttonW) / 2);
    back.y = start.y + buttonH + spacing.sm;
    this.panel.addChild(back);
    this.buttons.push(back);
  }

  private cyclePlayerCount(): void {
    const idx = PLAYER_COUNTS.indexOf(this.playerCount);
    const next = PLAYER_COUNTS[(idx + 1) % PLAYER_COUNTS.length] as FfaPlayerCount;
    this.playerCount = next;
    if (this.botCount > next - 1) this.botCount = next - 1;
    this.refreshLabels();
  }

  private cycleBotCount(): void {
    const cap = this.playerCount - 1;
    this.botCount = (this.botCount + 1) % (cap + 1);
    this.refreshLabels();
  }

  private cycleDifficulty(): void {
    const idx = DIFFICULTIES.indexOf(this.difficulty);
    this.difficulty = DIFFICULTIES[(idx + 1) % DIFFICULTIES.length] as BotDifficulty;
    this.refreshLabels();
  }

  private cycleRounds(): void {
    const idx = ROUNDS_OPTIONS.indexOf(this.rounds);
    const nextIdx = idx < 0 ? 0 : (idx + 1) % ROUNDS_OPTIONS.length;
    this.rounds = ROUNDS_OPTIONS[nextIdx] ?? 1;
    this.refreshLabels();
  }

  private refreshLabels(): void {
    this.playersButton?.setLabel(this.playersLabel());
    this.botsButton?.setLabel(this.botsLabel());
    this.difficultyButton?.setLabel(this.difficultyLabel());
    this.roundsButton?.setLabel(this.roundsLabel());
  }

  private playersLabel(): string {
    return `PLAYERS: ${this.playerCount}`;
  }

  private botsLabel(): string {
    return `BOTS: ${this.botCount}`;
  }

  private difficultyLabel(): string {
    return `DIFFICULTY: ${this.difficulty.toUpperCase()}`;
  }

  private roundsLabel(): string {
    return this.rounds === 1 ? "ROUNDS: SINGLE" : `ROUNDS: BEST OF ${this.rounds}`;
  }

  private refreshFocus(): void {
    for (const button of this.buttons) this.focus.register(button);
    this.focus.attach();
  }

  testView(): View {
    return this.view;
  }

  testTransitionTo(target: View): void {
    this.transitionTo(target);
  }

  testGameSetupConfig(): GameSetupConfig {
    return {
      playerCount: this.playerCount,
      botCount: this.botCount,
      difficulty: this.difficulty,
      rounds: this.rounds,
    };
  }
}

function parallelOnce(
  anims: ReadonlyArray<(done: () => void) => TweenHandle>,
  onComplete: () => void,
): TweenHandle {
  if (anims.length === 0) {
    onComplete();
    return { cancel: () => {} };
  }
  let cancelled = false;
  let remaining = anims.length;
  const handles: TweenHandle[] = [];
  const childDone = (): void => {
    if (cancelled) return;
    remaining -= 1;
    if (remaining === 0) onComplete();
  };
  for (const a of anims) handles.push(a(childDone));
  return {
    cancel(): void {
      if (cancelled) return;
      cancelled = true;
      for (const h of handles) h.cancel();
    },
  };
}

export type { Mode };
