// @vitest-environment happy-dom
import { Button } from "@durak/ui";
import { Container, Text } from "pixi.js";
import { describe, expect, it, vi } from "vitest";
import "../test-setup/canvas-mock.js";
import { type GameSetupConfig, MainMenuScreen } from "./MainMenuScreen.js";

function collectText(container: Container, out: string[] = []): string[] {
  for (const child of container.children) {
    if (!child.visible) continue;
    if (child instanceof Text) out.push(child.text);
    if (child instanceof Container) collectText(child, out);
  }
  return out;
}

function findButton(container: Container, label: string): Button | null {
  for (const child of container.children) {
    if (child instanceof Button) {
      const hasLabel = child.children.some((c) => c instanceof Text && (c as Text).text === label);
      if (hasLabel) return child;
    }
    if (child instanceof Container) {
      const inner = findButton(child as Container, label);
      if (inner) return inner;
    }
  }
  return null;
}

describe("MainMenuScreen root view", () => {
  it("shows a single PLAY entry point", () => {
    const screen = new MainMenuScreen({ onStart: vi.fn() });
    const labels = collectText(screen);
    expect(labels).toContain("PLAY");
    expect(labels).not.toContain("PLAY VS BOT");
    expect(labels).not.toContain("PLAY FFA");
    screen.dispose();
  });

  it("flips to the game-setup view on PLAY activation", () => {
    const screen = new MainMenuScreen({ onStart: vi.fn() });
    expect(screen.testView()).toBe("root");
    const play = findButton(screen, "PLAY");
    if (!play) throw new Error("PLAY button not found");
    play.activate();
    expect(screen.testView()).toBe("game-setup");
    const labels = collectText(screen);
    expect(labels.some((l) => l.startsWith("PLAYERS:"))).toBe(true);
    expect(labels.some((l) => l.startsWith("BOTS:"))).toBe(true);
    expect(labels.some((l) => l.startsWith("DIFFICULTY:"))).toBe(true);
    expect(labels.some((l) => l.startsWith("ROUNDS:"))).toBe(true);
    expect(labels).toContain("START");
    expect(labels).toContain("BACK");
    screen.dispose();
  });
});

describe("MainMenuScreen game-setup", () => {
  function openSetup(onStart: (cfg: GameSetupConfig) => void) {
    const screen = new MainMenuScreen({ onStart });
    findButton(screen, "PLAY")?.activate();
    return screen;
  }

  it("invokes onStart with the current config when START is pressed", () => {
    const seen: GameSetupConfig[] = [];
    const screen = openSetup((cfg) => seen.push(cfg));
    findButton(screen, "START")?.activate();
    expect(seen).toEqual([{ playerCount: 2, botCount: 1, difficulty: "medium", rounds: 3 }]);
    screen.dispose();
  });

  it("cycles player count through 2..6 and clamps bot count", () => {
    const screen = openSetup(vi.fn());
    expect(screen.testGameSetupConfig().playerCount).toBe(2);
    findButton(screen, "PLAYERS: 2")?.activate();
    expect(screen.testGameSetupConfig().playerCount).toBe(3);
    findButton(screen, "PLAYERS: 3")?.activate();
    expect(screen.testGameSetupConfig().playerCount).toBe(4);
    screen.dispose();
  });

  it("cycles rounds through 1, 3, 5, 7, 9", () => {
    const screen = openSetup(vi.fn());
    const initial = screen.testGameSetupConfig().rounds;
    expect(initial).toBe(3);
    findButton(screen, "ROUNDS: BEST OF 3")?.activate();
    expect(screen.testGameSetupConfig().rounds).toBe(5);
    findButton(screen, "ROUNDS: BEST OF 5")?.activate();
    expect(screen.testGameSetupConfig().rounds).toBe(7);
    screen.dispose();
  });

  it("BACK returns to the root view", () => {
    const screen = openSetup(vi.fn());
    findButton(screen, "BACK")?.activate();
    expect(screen.testView()).toBe("root");
    const labels = collectText(screen);
    expect(labels).toContain("PLAY");
    screen.dispose();
  });
});
