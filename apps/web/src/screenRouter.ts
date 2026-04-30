import type { Container, Ticker } from "pixi.js";
import type { StoreApi } from "zustand/vanilla";
import type { TweenHandle } from "./anim/index.js";
import type { Screen } from "./screens/types.js";
import { type AppState, appStore, type Phase } from "./store.js";
import { runTransition } from "./transitions.js";

export interface ScreenRouterOptions {
  stage: Container;
  build(state: AppState): Screen;
  /** Defaults to the global `appStore`. Tests may inject a local store. */
  store?: StoreApi<AppState>;
  /** Pixi ticker that drives transition tweens. Defaults to `Ticker.shared`. */
  ticker?: Ticker;
  /** Time source for transitions; defaults to `performance.now`. */
  now?: () => number;
  /**
   * Speed multiplier for transition durations. Defaults to reading
   * `devtools.animSpeed` from the store. A value of `0` skips transitions.
   */
  speed?: () => number;
}

export class ScreenRouter {
  private readonly stage: Container;
  private readonly build: (state: AppState) => Screen;
  private readonly store: StoreApi<AppState>;
  private readonly ticker: Ticker | undefined;
  private readonly now: (() => number) | undefined;
  private readonly speed: () => number;
  private current: Screen | null = null;
  private currentKey = "";
  private currentPhase: Phase | null = null;
  private outgoing: Screen | null = null;
  private incoming: Screen | null = null;
  private transition: TweenHandle | null = null;
  private viewWidth = 0;
  private viewHeight = 0;
  private unsubscribe: (() => void) | null = null;

  constructor(options: ScreenRouterOptions) {
    this.stage = options.stage;
    this.build = options.build;
    this.store = options.store ?? appStore;
    this.ticker = options.ticker;
    this.now = options.now;
    this.speed = options.speed ?? (() => this.store.getState().devtools.animSpeed);
  }

  start(): void {
    this.render(this.store.getState());
    this.unsubscribe = this.store.subscribe((state) => this.render(state));
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.snapTransitionToEnd();
    this.tearDownCurrent();
  }

  setView(width: number, height: number): void {
    this.viewWidth = width;
    this.viewHeight = height;
    this.current?.layout(width, height);
    this.outgoing?.layout(width, height);
  }

  private render(state: AppState): void {
    const key = `${state.phase}|${state.mode ?? ""}|${state.roomCode ?? ""}`;
    if (key === this.currentKey && this.current) return;

    const prevPhase = this.currentPhase;
    const oldScreen = this.current;
    this.snapTransitionToEnd();

    const newScreen = this.build(state);
    newScreen.layout(this.viewWidth, this.viewHeight);

    const skipAnimation =
      oldScreen === null || prevPhase === null || prevPhase === state.phase || this.speed() === 0;

    if (skipAnimation) {
      if (oldScreen) {
        oldScreen.dispose();
        if (oldScreen.parent) oldScreen.parent.removeChild(oldScreen);
        oldScreen.destroy({ children: true });
      }
      this.stage.addChild(newScreen);
      this.current = newScreen;
      this.currentKey = key;
      this.currentPhase = state.phase;
      return;
    }

    this.stage.addChild(newScreen);
    this.outgoing = oldScreen;
    this.incoming = newScreen;
    this.current = newScreen;
    this.currentKey = key;
    this.currentPhase = state.phase;

    const transitionCtx = {
      stage: this.stage,
      outgoing: oldScreen,
      incoming: newScreen,
      viewWidth: this.viewWidth,
      viewHeight: this.viewHeight,
      ...(this.ticker ? { ticker: this.ticker } : {}),
      ...(this.now ? { now: this.now } : {}),
      speed: this.speed,
    };

    this.transition = runTransition(prevPhase, state.phase, transitionCtx, () => {
      this.transition = null;
      this.disposeOutgoing();
      if (this.incoming) {
        this.incoming.x = 0;
        this.incoming.y = 0;
        this.incoming.alpha = 1;
        this.incoming = null;
      }
    });
  }

  private snapTransitionToEnd(): void {
    if (this.transition === null) return;
    this.transition.cancel();
    this.transition = null;
    this.disposeOutgoing();
    if (this.incoming) {
      this.incoming.x = 0;
      this.incoming.y = 0;
      this.incoming.alpha = 1;
      this.incoming = null;
    }
  }

  private disposeOutgoing(): void {
    if (!this.outgoing) return;
    this.outgoing.dispose();
    if (this.outgoing.parent) this.outgoing.parent.removeChild(this.outgoing);
    this.outgoing.destroy({ children: true });
    this.outgoing = null;
  }

  private tearDownCurrent(): void {
    if (!this.current) return;
    this.current.dispose();
    if (this.current.parent) this.current.parent.removeChild(this.current);
    this.current.destroy({ children: true });
    this.current = null;
    this.currentKey = "";
    this.currentPhase = null;
  }
}
