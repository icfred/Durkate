import type { Action, Event } from "@durak/engine";
import type { Container } from "pixi.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as audio from "../audio/index.js";
import { appStore } from "../store.js";
import { GameScreen } from "./GameScreen.js";
import { loadFixture } from "./sandboxFixtures.js";

vi.mock("../audio/index.js", () => ({
  playSfx: vi.fn().mockReturnValue(true),
}));

const playSfxMock = vi.mocked(audio.playSfx);

function findByLabel(container: Container, label: string): Container | undefined {
  return container.children.find((c) => (c as Container).label === label) as Container | undefined;
}

const press = (key: string): KeyboardEvent =>
  new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });

describe("GameScreen", () => {
  it("shows a waiting placeholder when snapshot is null", () => {
    const screen = new GameScreen({ snapshot: null, submitAction: vi.fn() });
    screen.layout(800, 600);

    expect(findByLabel(screen, "opponent-hand")?.visible).toBe(false);
    expect(findByLabel(screen, "table")?.visible).toBe(false);
    expect(findByLabel(screen, "talon")?.visible).toBe(false);
    expect(findByLabel(screen, "discard")?.visible).toBe(false);
    expect(findByLabel(screen, "my-hand")?.visible).toBe(false);

    screen.dispose();
  });

  it("renders all sections from a fresh-deal snapshot", () => {
    const snapshot = loadFixture("fresh");
    const screen = new GameScreen({ snapshot, submitAction: vi.fn() });
    screen.layout(800, 600);

    const opponent = findByLabel(screen, "opponent-hand");
    const table = findByLabel(screen, "table");
    const talon = findByLabel(screen, "talon");
    const discard = findByLabel(screen, "discard");
    const myHand = findByLabel(screen, "my-hand");

    expect(opponent?.children.length).toBe(snapshot.handCounts[1]);
    expect(table?.children.length).toBe(0);
    expect((talon?.children.length ?? 0) > 0).toBe(true);
    expect((discard?.children.length ?? 0) > 0).toBe(true);
    expect(myHand?.children.length).toBe(snapshot.you.hand.length);

    screen.dispose();
  });

  it("submits a legal ATTACK on Enter from a fresh-deal snapshot", () => {
    const snapshot = loadFixture("fresh");
    const submitAction = vi.fn<(action: Action) => void>();
    const screen = new GameScreen({ snapshot, submitAction });
    screen.layout(800, 600);

    window.dispatchEvent(press("Enter"));

    expect(submitAction).toHaveBeenCalledTimes(1);
    const action = submitAction.mock.calls[0]?.[0];
    expect(action?.type).toBe("ATTACK");
    if (action?.type === "ATTACK") {
      expect(action.by).toBe(snapshot.seat);
      expect(action.card).toEqual(snapshot.you.hand[0]);
    }

    screen.dispose();
  });

  it("ArrowRight changes which card is played on Enter", () => {
    const snapshot = loadFixture("fresh");
    const submitAction = vi.fn<(action: Action) => void>();
    const screen = new GameScreen({ snapshot, submitAction });
    screen.layout(800, 600);

    window.dispatchEvent(press("ArrowRight"));
    window.dispatchEvent(press("Enter"));

    const action = submitAction.mock.calls[0]?.[0];
    expect(action?.type).toBe("ATTACK");
    if (action?.type === "ATTACK") {
      expect(action.card).toEqual(snapshot.you.hand[1]);
    }

    screen.dispose();
  });

  it("T submits TAKE_PILE for the seat", () => {
    const snapshot = loadFixture("takepile");
    const submitAction = vi.fn<(action: Action) => void>();
    const screen = new GameScreen({ snapshot, submitAction });
    screen.layout(800, 600);

    window.dispatchEvent(press("T"));

    expect(submitAction).toHaveBeenCalledWith({ type: "TAKE_PILE", by: snapshot.seat });

    screen.dispose();
  });

  it("E submits END_ROUND for the seat", () => {
    const snapshot = loadFixture("midround");
    const submitAction = vi.fn<(action: Action) => void>();
    const screen = new GameScreen({ snapshot, submitAction });
    screen.layout(800, 600);

    window.dispatchEvent(press("E"));

    expect(submitAction).toHaveBeenCalledWith({ type: "END_ROUND", by: snapshot.seat });

    screen.dispose();
  });

  it("re-renders when subscribe pushes a new snapshot", () => {
    const listeners: ((s: import("@durak/protocol").Snapshot | null) => void)[] = [];
    const screen = new GameScreen({
      snapshot: null,
      submitAction: vi.fn(),
      subscribe: (cb) => {
        listeners.push(cb);
        return () => {
          const idx = listeners.indexOf(cb);
          if (idx >= 0) listeners.splice(idx, 1);
        };
      },
    });
    screen.layout(800, 600);

    const fresh = loadFixture("fresh");
    for (const listener of listeners) listener(fresh);

    expect(findByLabel(screen, "my-hand")?.children.length).toBe(fresh.you.hand.length);

    screen.dispose();
  });
});

describe("GameScreen SFX wiring", () => {
  let emit: ((events: Event[]) => void) | null = null;

  beforeEach(() => {
    playSfxMock.mockClear();
    emit = null;
  });

  afterEach(() => {
    playSfxMock.mockClear();
  });

  function makeScreen(snapshot = loadFixture("fresh")): GameScreen {
    return new GameScreen({
      snapshot,
      submitAction: vi.fn(),
      subscribeEvents: (listener) => {
        emit = listener;
        return () => {
          emit = null;
        };
      },
    });
  }

  it("plays playCard sfx on CARD_PLAYED", () => {
    const screen = makeScreen();
    emit?.([
      {
        type: "CARD_PLAYED",
        by: 0,
        role: "ATTACK",
        card: { suit: "spades", rank: 7 },
      },
    ]);

    expect(playSfxMock).toHaveBeenCalledTimes(1);
    expect(playSfxMock).toHaveBeenCalledWith("playCard");

    screen.dispose();
  });

  it("plays takePile sfx on PILE_TAKEN", () => {
    const screen = makeScreen();
    emit?.([
      {
        type: "PILE_TAKEN",
        by: 1,
        cards: [{ suit: "clubs", rank: 6 }],
        attacker: 0,
        defender: 1,
      },
    ]);

    expect(playSfxMock).toHaveBeenCalledTimes(1);
    expect(playSfxMock).toHaveBeenCalledWith("takePile");

    screen.dispose();
  });

  it("plays win sfx on GAME_OVER when durak is the opponent", () => {
    const snapshot = loadFixture("fresh"); // you.seat === 0
    const screen = makeScreen(snapshot);
    emit?.([{ type: "GAME_OVER", durak: 1 }]);

    expect(playSfxMock).toHaveBeenCalledTimes(1);
    expect(playSfxMock).toHaveBeenCalledWith("win");

    screen.dispose();
  });

  it("plays lose sfx on GAME_OVER when you are the durak", () => {
    const snapshot = loadFixture("fresh"); // you.seat === 0
    const screen = makeScreen(snapshot);
    emit?.([{ type: "GAME_OVER", durak: 0 }]);

    expect(playSfxMock).toHaveBeenCalledTimes(1);
    expect(playSfxMock).toHaveBeenCalledWith("lose");

    screen.dispose();
  });

  it("plays no chime on GAME_OVER draw", () => {
    const screen = makeScreen();
    emit?.([{ type: "GAME_OVER", durak: null }]);

    expect(playSfxMock).not.toHaveBeenCalled();

    screen.dispose();
  });

  it("does not re-trigger sounds for already-handled events", () => {
    const screen = makeScreen();
    const cardPlayed: Event = {
      type: "CARD_PLAYED",
      by: 0,
      role: "ATTACK",
      card: { suit: "spades", rank: 7 },
    };
    emit?.([cardPlayed]);
    emit?.([
      {
        type: "PILE_TAKEN",
        by: 1,
        cards: [{ suit: "clubs", rank: 6 }],
        attacker: 0,
        defender: 1,
      },
    ]);

    expect(playSfxMock).toHaveBeenCalledTimes(2);
    expect(playSfxMock).toHaveBeenNthCalledWith(1, "playCard");
    expect(playSfxMock).toHaveBeenNthCalledWith(2, "takePile");

    screen.dispose();
  });

  it("handles a batch of events in order", () => {
    const screen = makeScreen();
    emit?.([
      {
        type: "CARD_PLAYED",
        by: 0,
        role: "ATTACK",
        card: { suit: "spades", rank: 7 },
      },
      {
        type: "CARD_PLAYED",
        by: 1,
        role: "DEFEND",
        card: { suit: "spades", rank: 8 },
        target: 0,
      },
      {
        type: "PILE_TAKEN",
        by: 1,
        cards: [
          { suit: "spades", rank: 7 },
          { suit: "spades", rank: 8 },
        ],
        attacker: 0,
        defender: 1,
      },
    ]);

    expect(playSfxMock.mock.calls.map((c) => c[0])).toEqual(["playCard", "playCard", "takePile"]);

    screen.dispose();
  });

  it("integrates with appStore.appendEvents through main.ts-style wiring", () => {
    appStore.getState().showMenu();
    const snapshot = loadFixture("fresh");
    const screen = new GameScreen({
      snapshot,
      submitAction: vi.fn(),
      subscribeEvents: (listener) =>
        appStore.subscribe((next, prev) => {
          const delta = next.eventsTotal - prev.eventsTotal;
          if (delta <= 0) return;
          listener(next.events.slice(-delta));
        }),
    });

    appStore.getState().appendEvents([
      {
        type: "CARD_PLAYED",
        by: 0,
        role: "ATTACK",
        card: { suit: "spades", rank: 7 },
      },
    ]);

    expect(playSfxMock).toHaveBeenCalledTimes(1);
    expect(playSfxMock).toHaveBeenCalledWith("playCard");

    appStore.getState().appendEvents([
      {
        type: "PILE_TAKEN",
        by: 1,
        cards: [{ suit: "spades", rank: 7 }],
        attacker: 0,
        defender: 1,
      },
    ]);

    expect(playSfxMock).toHaveBeenCalledTimes(2);
    expect(playSfxMock).toHaveBeenNthCalledWith(2, "takePile");

    screen.dispose();
    appStore.getState().showMenu();
  });

  it("calls playSfx regardless of muted state - muting is enforced inside playSfx", () => {
    appStore.getState().setMuted(true);
    const screen = makeScreen();
    emit?.([
      {
        type: "CARD_PLAYED",
        by: 0,
        role: "ATTACK",
        card: { suit: "spades", rank: 7 },
      },
    ]);

    expect(playSfxMock).toHaveBeenCalledTimes(1);
    expect(playSfxMock).toHaveBeenCalledWith("playCard");

    appStore.getState().setMuted(false);
    screen.dispose();
  });
});
