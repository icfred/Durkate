import type { Action } from "@durak/engine";
import type { Container } from "pixi.js";
import { describe, expect, it, vi } from "vitest";
import { GameScreen } from "./GameScreen.js";
import { loadFixture } from "./sandboxFixtures.js";

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
