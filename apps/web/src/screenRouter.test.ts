import { Container, Ticker } from "pixi.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScreenRouter } from "./screenRouter.js";
import { appStore } from "./store.js";

class StubScreen extends Container {
  readonly disposed = vi.fn();
  layoutCalls = 0;

  layout(_w: number, _h: number): void {
    this.layoutCalls += 1;
  }

  dispose(): void {
    this.disposed();
  }
}

function makeClock(): { now: () => number; advance: (ms: number) => void } {
  let t = 0;
  return {
    now: () => t,
    advance(ms) {
      t += ms;
    },
  };
}

function resetStore(): void {
  appStore.setState({
    phase: "menu",
    mode: undefined,
    roomCode: undefined,
    currentToken: null,
    shareToken: null,
    snapshot: null,
    events: [],
    eventsTotal: 0,
    room: null,
    gameover: undefined,
    devtools: { open: false, autoplay: false, animSpeed: 1 },
  });
}

describe("ScreenRouter", () => {
  beforeEach(() => {
    resetStore();
  });

  afterEach(() => {
    resetStore();
  });

  it("first mount skips animation", () => {
    const stage = new Container();
    const built: StubScreen[] = [];
    const router = new ScreenRouter({
      stage,
      build: () => {
        const s = new StubScreen();
        built.push(s);
        return s;
      },
      ticker: new Ticker(),
      now: () => 0,
      speed: () => 1,
    });
    router.setView(800, 600);
    router.start();

    expect(built).toHaveLength(1);
    const first = built[0];
    if (!first) throw new Error("expected screen");
    expect(stage.children).toContain(first);
    expect(first.alpha).toBe(1);
    expect(first.y).toBe(0);
    expect(first.disposed).not.toHaveBeenCalled();

    router.stop();
  });

  it("animates on phase change and disposes the old screen only after completion", () => {
    const stage = new Container();
    const ticker = new Ticker();
    const clock = makeClock();
    const built: StubScreen[] = [];
    const router = new ScreenRouter({
      stage,
      build: () => {
        const s = new StubScreen();
        built.push(s);
        return s;
      },
      ticker,
      now: clock.now,
      speed: () => 1,
    });
    router.setView(800, 600);
    router.start();

    appStore.getState().showLobby({ mode: "bot", roomCode: "ROOM" });

    expect(built).toHaveLength(2);
    const oldScreen = built[0];
    const newScreen = built[1];
    if (!oldScreen || !newScreen) throw new Error("expected screens");

    expect(stage.children).toContain(oldScreen);
    expect(stage.children).toContain(newScreen);
    expect(oldScreen.disposed).not.toHaveBeenCalled();

    clock.advance(120);
    ticker.update();
    expect(oldScreen.disposed).not.toHaveBeenCalled();
    expect(stage.children).toContain(oldScreen);

    clock.advance(500);
    ticker.update();
    clock.advance(500);
    ticker.update();

    expect(oldScreen.disposed).toHaveBeenCalledTimes(1);
    expect(stage.children).not.toContain(oldScreen);
    expect(stage.children).toContain(newScreen);
    expect(newScreen.alpha).toBe(1);
    expect(newScreen.x).toBe(0);
    expect(newScreen.y).toBe(0);

    router.stop();
  });

  it("animSpeed=0 swaps instantly without running a tween", () => {
    const stage = new Container();
    const ticker = new Ticker();
    const clock = makeClock();
    const built: StubScreen[] = [];
    appStore.setState({ devtools: { open: false, autoplay: false, animSpeed: 0 } });

    const router = new ScreenRouter({
      stage,
      build: () => {
        const s = new StubScreen();
        built.push(s);
        return s;
      },
      ticker,
      now: clock.now,
    });
    router.setView(800, 600);
    router.start();

    appStore.getState().showLobby({ mode: "bot", roomCode: "ROOM" });

    expect(built).toHaveLength(2);
    const oldScreen = built[0];
    const newScreen = built[1];
    if (!oldScreen || !newScreen) throw new Error("expected screens");
    expect(oldScreen.disposed).toHaveBeenCalledTimes(1);
    expect(stage.children).not.toContain(oldScreen);
    expect(stage.children).toContain(newScreen);

    router.stop();
  });

  it("snaps an in-flight transition to its end before starting a new one", () => {
    const stage = new Container();
    const ticker = new Ticker();
    const clock = makeClock();
    const built: StubScreen[] = [];
    const router = new ScreenRouter({
      stage,
      build: () => {
        const s = new StubScreen();
        built.push(s);
        return s;
      },
      ticker,
      now: clock.now,
      speed: () => 1,
    });
    router.setView(800, 600);
    router.start();

    appStore.getState().showLobby({ mode: "bot", roomCode: "ROOM" });
    clock.advance(60);
    ticker.update();

    appStore.setState({ phase: "game" });

    const menu = built[0];
    const lobby = built[1];
    const game = built[2];
    if (!menu || !lobby || !game) throw new Error("expected three screens");

    expect(menu.disposed).toHaveBeenCalledTimes(1);
    expect(stage.children).not.toContain(menu);
    expect(stage.children).toContain(lobby);
    expect(stage.children).toContain(game);
    expect(lobby.disposed).not.toHaveBeenCalled();

    clock.advance(2000);
    ticker.update();
    ticker.update();

    expect(lobby.disposed).toHaveBeenCalledTimes(1);
    expect(stage.children).toContain(game);
    expect(game.alpha).toBe(1);

    router.stop();
  });

  it("stop() cancels mid-transition and tears down both screens", () => {
    const stage = new Container();
    const ticker = new Ticker();
    const clock = makeClock();
    const built: StubScreen[] = [];
    const router = new ScreenRouter({
      stage,
      build: () => {
        const s = new StubScreen();
        built.push(s);
        return s;
      },
      ticker,
      now: clock.now,
      speed: () => 1,
    });
    router.setView(800, 600);
    router.start();

    appStore.getState().showLobby({ mode: "bot", roomCode: "ROOM" });
    clock.advance(50);
    ticker.update();

    router.stop();

    const menu = built[0];
    const lobby = built[1];
    if (!menu || !lobby) throw new Error("expected screens");
    expect(menu.disposed).toHaveBeenCalledTimes(1);
    expect(lobby.disposed).toHaveBeenCalledTimes(1);
    expect(stage.children).toHaveLength(0);
  });
});
