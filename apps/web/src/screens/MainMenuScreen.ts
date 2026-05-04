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
const PANEL_H_ROOT = 420;
const PANEL_H_BOT_DIFFICULTY = 460;
const PANEL_H_FFA_CONFIG = 520;
const FADE_IN_MS = 220;

export type FfaPlayerCount = 2 | 3 | 4 | 5 | 6;

export interface FfaConfig {
  playerCount: FfaPlayerCount;
  botCount: number;
  difficulty: BotDifficulty;
}

export interface MainMenuScreenOptions {
  onPlayBot(difficulty: BotDifficulty): void;
  onPlayFriend(): void;
  onPlayFfa(config: FfaConfig): void;
}

type View = "root" | "bot-difficulty" | "ffa-config";

const FFA_PLAYER_COUNTS: readonly FfaPlayerCount[] = [2, 3, 4, 5, 6];
const FFA_DIFFICULTIES: readonly BotDifficulty[] = ["easy", "medium", "hard"];

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
  private ffaPlayerCount: FfaPlayerCount = 4;
  private ffaBotCount = 3;
  private ffaDifficulty: BotDifficulty = "medium";
  private ffaPlayersButton: Button | null = null;
  private ffaBotsButton: Button | null = null;
  private ffaDifficultyButton: Button | null = null;

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
    this.ffaPlayersButton = null;
    this.ffaBotsButton = null;
    this.ffaDifficultyButton = null;

    this.detachFocusNavSfx();
    this.focus.detach();
    this.focus.clear();
    this.focus = new FocusManager();
    this.detachFocusNavSfx = attachFocusNavSfx(this.focus);

    this.view = target;
    if (target === "root") {
      this.setPanelHeight(PANEL_H_ROOT);
      this.buildRootButtons();
    } else if (target === "bot-difficulty") {
      this.setPanelHeight(PANEL_H_BOT_DIFFICULTY);
      this.buildBotDifficultyButtons();
    } else {
      this.setPanelHeight(PANEL_H_FFA_CONFIG);
      this.buildFfaConfigButtons();
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

    const playBot = new Button({
      label: "PLAY VS BOT",
      width: buttonW,
      height: buttonH,
      onActivate: withClickSound(() => this.transitionTo("bot-difficulty")),
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

    const playFfa = new Button({
      label: "PLAY FFA",
      width: buttonW,
      height: buttonH,
      onActivate: withClickSound(() => this.transitionTo("ffa-config")),
    });
    attachButtonHover(playFfa);
    playFfa.x = Math.round((PANEL_W - buttonW) / 2);
    playFfa.y = stackY + (buttonH + spacing.md) * 2;
    this.panel.addChild(playFfa);
    this.buttons.push(playFfa);
  }

  private buildBotDifficultyButtons(): void {
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
      onActivate: withClickSound(() => this.transitionTo("root")),
    });
    attachButtonHover(back);
    back.x = Math.round((PANEL_W - buttonW) / 2);
    back.y = stackY + difficulties.length * (buttonH + spacing.sm) + spacing.md;
    this.panel.addChild(back);
    this.buttons.push(back);
  }

  private buildFfaConfigButtons(): void {
    const buttonW = 320;
    const buttonH = 48;
    const stackY = this.title.y + this.title.height + spacing.xl + spacing.lg;

    this.ffaPlayersButton = new Button({
      label: this.ffaPlayersLabel(),
      width: buttonW,
      height: buttonH,
      onActivate: withClickSound(() => this.cycleFfaPlayerCount()),
    });
    attachButtonHover(this.ffaPlayersButton);
    this.ffaPlayersButton.x = Math.round((PANEL_W - buttonW) / 2);
    this.ffaPlayersButton.y = stackY;
    this.panel.addChild(this.ffaPlayersButton);
    this.buttons.push(this.ffaPlayersButton);

    this.ffaBotsButton = new Button({
      label: this.ffaBotsLabel(),
      width: buttonW,
      height: buttonH,
      onActivate: withClickSound(() => this.cycleFfaBotCount()),
    });
    attachButtonHover(this.ffaBotsButton);
    this.ffaBotsButton.x = Math.round((PANEL_W - buttonW) / 2);
    this.ffaBotsButton.y = stackY + (buttonH + spacing.sm);
    this.panel.addChild(this.ffaBotsButton);
    this.buttons.push(this.ffaBotsButton);

    this.ffaDifficultyButton = new Button({
      label: this.ffaDifficultyLabel(),
      width: buttonW,
      height: buttonH,
      onActivate: withClickSound(() => this.cycleFfaDifficulty()),
    });
    attachButtonHover(this.ffaDifficultyButton);
    this.ffaDifficultyButton.x = Math.round((PANEL_W - buttonW) / 2);
    this.ffaDifficultyButton.y = stackY + (buttonH + spacing.sm) * 2;
    this.panel.addChild(this.ffaDifficultyButton);
    this.buttons.push(this.ffaDifficultyButton);

    const start = new Button({
      label: "START",
      width: buttonW,
      height: buttonH,
      onActivate: withClickSound(() =>
        this.options.onPlayFfa({
          playerCount: this.ffaPlayerCount,
          botCount: this.ffaBotCount,
          difficulty: this.ffaDifficulty,
        }),
      ),
    });
    attachButtonHover(start);
    start.x = Math.round((PANEL_W - buttonW) / 2);
    start.y = stackY + (buttonH + spacing.sm) * 3 + spacing.md;
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

  private cycleFfaPlayerCount(): void {
    const idx = FFA_PLAYER_COUNTS.indexOf(this.ffaPlayerCount);
    const next = FFA_PLAYER_COUNTS[(idx + 1) % FFA_PLAYER_COUNTS.length] as FfaPlayerCount;
    this.ffaPlayerCount = next;
    if (this.ffaBotCount > next - 1) this.ffaBotCount = next - 1;
    this.refreshFfaLabels();
  }

  private cycleFfaBotCount(): void {
    const cap = this.ffaPlayerCount - 1;
    this.ffaBotCount = (this.ffaBotCount + 1) % (cap + 1);
    this.refreshFfaLabels();
  }

  private cycleFfaDifficulty(): void {
    const idx = FFA_DIFFICULTIES.indexOf(this.ffaDifficulty);
    this.ffaDifficulty = FFA_DIFFICULTIES[(idx + 1) % FFA_DIFFICULTIES.length] as BotDifficulty;
    this.refreshFfaLabels();
  }

  private refreshFfaLabels(): void {
    this.ffaPlayersButton?.setLabel(this.ffaPlayersLabel());
    this.ffaBotsButton?.setLabel(this.ffaBotsLabel());
    this.ffaDifficultyButton?.setLabel(this.ffaDifficultyLabel());
  }

  private ffaPlayersLabel(): string {
    return `PLAYERS: ${this.ffaPlayerCount}`;
  }

  private ffaBotsLabel(): string {
    return `BOTS: ${this.ffaBotCount}`;
  }

  private ffaDifficultyLabel(): string {
    return `DIFFICULTY: ${this.ffaDifficulty.toUpperCase()}`;
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

  testFfaConfig(): FfaConfig {
    return {
      playerCount: this.ffaPlayerCount,
      botCount: this.ffaBotCount,
      difficulty: this.ffaDifficulty,
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
