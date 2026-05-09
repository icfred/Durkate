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

describe("MainMenuScreen", () => {
  it("renders a single PLAY button and the title", () => {
    const screen = new MainMenuScreen({ onStart: vi.fn() });
    const labels = collectText(screen);
    expect(labels).toContain("DURAK");
    expect(labels).toContain("PLAY");
    // No setup-config controls should be visible — those moved to the lobby.
    expect(labels.some((l) => l.startsWith("PLAYERS:"))).toBe(false);
    expect(labels.some((l) => l.startsWith("ROUNDS:"))).toBe(false);
    screen.dispose();
  });

  it("invokes onStart with default config when PLAY is pressed", () => {
    const seen: GameSetupConfig[] = [];
    const screen = new MainMenuScreen({ onStart: (cfg) => seen.push(cfg) });
    findButton(screen, "PLAY")?.activate();
    expect(seen).toEqual([{ playerCount: 2, botCount: 1, difficulty: "medium", rounds: 3 }]);
    screen.dispose();
  });
});
