import type { BotDifficulty } from "@durak/protocol";
import { Button, color, FocusManager, Panel, spacing, typography } from "@durak/ui";
import { Container, Text } from "pixi.js";
import { easeOutQuad } from "../anim/easings.js";
import { fadeTo } from "../anim/pixi.js";
import type { TweenHandle } from "../anim/tween.js";
import { attachButtonHover, attachFocusNavSfx, withClickSound } from "../audio/index.js";
import type { Mode } from "../store.js";
import type { Screen } from "./types.js";

const PANEL_W = 480;
// Two heights so the difficulty view (4 buttons + back) doesn't overflow the
// root view's height. layout() centers using the current value.
const PANEL_H_ROOT = 360;
const PANEL_H_BOT_DIFFICULTY = 460;
const FADE_IN_MS = 220;

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
  private panelH = PANEL_H_ROOT;
  private viewW = 0;
  private viewH = 0;
  private transitioning: TweenHandle | null = null;
  private readonly onWindowKeyDown: (event: KeyboardEvent) => void;

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

    // Backspace / Escape navigates back to root from a sub-view.
    this.onWindowKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Backspace" && event.key !== "Escape") return;
      if (this.view === "root") return;
      // Don't fire while the user is typing in an input overlay.
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      event.preventDefault();
      this.transitionTo("root");
    };
    window.addEventListener("keydown", this.onWindowKeyDown);

    // Initial render — synchronous, no transition.
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
    window.removeEventListener("keydown", this.onWindowKeyDown);
    this.transitioning?.cancel();
    this.transitioning = null;
    this.detachFocusNavSfx();
    this.focus.detach();
    this.focus.clear();
  }

  private transitionTo(target: View): void {
    if (this.view === target) return;
    // Cancel any in-flight transition; new view takes over immediately.
    this.transitioning?.cancel();

    // Tear down old buttons synchronously. Logical view + DOM update happen
    // in one tick so tests and any synchronous reader see the new state right
    // away. The animation is a visual layer on top — the new buttons start at
    // alpha 0 and fade in.
    for (const b of this.buttons) {
      this.panel.removeChild(b);
      b.destroy();
    }
    this.buttons = [];

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
      this.setPanelHeight(PANEL_H_BOT_DIFFICULTY);
      this.buildBotDifficultyButtons();
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

  private refreshFocus(): void {
    for (const button of this.buttons) this.focus.register(button);
    this.focus.attach();
  }

  // Test seam: which view is currently rendered.
  testView(): View {
    return this.view;
  }

  // Test seam: trigger a view transition without animation timing concerns.
  testTransitionTo(target: View): void {
    this.transitionTo(target);
  }
}

// Local helper: run anims in parallel, fire onComplete once when all finish
// (or immediately if there are none). Mirrors the parallel() compose primitive
// but lets us avoid wrapping every animation list in an extra closure.
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
