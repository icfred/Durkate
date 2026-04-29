import type { Container } from "pixi.js";
import type { Screen } from "./screens/types.js";
import type { AppState } from "./store.js";
import { appStore } from "./store.js";

export interface ScreenRouterOptions {
  stage: Container;
  build(state: AppState): Screen;
}

export class ScreenRouter {
  private readonly stage: Container;
  private readonly build: (state: AppState) => Screen;
  private current: Screen | null = null;
  private currentKey = "";
  private viewWidth = 0;
  private viewHeight = 0;
  private unsubscribe: (() => void) | null = null;

  constructor(options: ScreenRouterOptions) {
    this.stage = options.stage;
    this.build = options.build;
  }

  start(): void {
    this.render(appStore.getState());
    this.unsubscribe = appStore.subscribe((state) => this.render(state));
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.tearDown();
  }

  setView(width: number, height: number): void {
    this.viewWidth = width;
    this.viewHeight = height;
    this.current?.layout(width, height);
  }

  private render(state: AppState): void {
    const key = `${state.phase}|${state.mode ?? ""}|${state.roomCode ?? ""}`;
    if (key === this.currentKey && this.current) return;
    this.tearDown();
    const screen = this.build(state);
    screen.layout(this.viewWidth, this.viewHeight);
    this.stage.addChild(screen);
    this.current = screen;
    this.currentKey = key;
  }

  private tearDown(): void {
    if (!this.current) return;
    this.current.dispose();
    this.stage.removeChild(this.current);
    this.current.destroy({ children: true });
    this.current = null;
  }
}
