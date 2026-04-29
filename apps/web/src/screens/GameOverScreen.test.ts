// @vitest-environment happy-dom
import { Container, Text } from "pixi.js";
import { describe, expect, it, vi } from "vitest";
import "../test-setup/canvas-mock.js";
import { gameOverFixture } from "../fixtures/gameOverFixtures.js";
import { classifyOutcome, GameOverScreen } from "./GameOverScreen.js";

function collectText(container: Container, out: string[] = []): string[] {
  for (const child of container.children) {
    if (child instanceof Text) out.push(child.text);
    if (child instanceof Container) collectText(child, out);
  }
  return out;
}

describe("classifyOutcome", () => {
  it("returns victory when the durak is another seat", () => {
    expect(classifyOutcome({ youSeat: 0, durak: 1 })).toBe("victory");
  });
  it("returns defeat when the durak is your seat", () => {
    expect(classifyOutcome({ youSeat: 0, durak: 0 })).toBe("defeat");
  });
  it("returns draw when no durak", () => {
    expect(classifyOutcome({ youSeat: 0, durak: null })).toBe("draw");
  });
});

describe("GameOverScreen", () => {
  it("renders VICTORY for a won fixture with both buttons", () => {
    const screen = new GameOverScreen({
      data: gameOverFixture("won"),
      onRematch: vi.fn(),
      onMainMenu: vi.fn(),
    });
    const labels = collectText(screen);
    expect(screen.outcome).toBe("victory");
    expect(labels).toContain("VICTORY");
    expect(labels).toContain("REMATCH");
    expect(labels).toContain("MAIN MENU");
    screen.dispose();
  });

  it("renders DURAK for a lost fixture", () => {
    const screen = new GameOverScreen({
      data: gameOverFixture("lost"),
      onRematch: vi.fn(),
      onMainMenu: vi.fn(),
    });
    const labels = collectText(screen);
    expect(screen.outcome).toBe("defeat");
    expect(labels).toContain("DURAK");
    expect(labels).toContain("REMATCH");
    expect(labels).toContain("MAIN MENU");
    screen.dispose();
  });

  it("renders DRAW for a draw fixture", () => {
    const screen = new GameOverScreen({
      data: gameOverFixture("draw"),
      onRematch: vi.fn(),
      onMainMenu: vi.fn(),
    });
    const labels = collectText(screen);
    expect(screen.outcome).toBe("draw");
    expect(labels).toContain("DRAW");
    expect(labels).toContain("REMATCH");
    expect(labels).toContain("MAIN MENU");
    screen.dispose();
  });
});
