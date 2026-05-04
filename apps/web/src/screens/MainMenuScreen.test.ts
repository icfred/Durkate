// @vitest-environment happy-dom
import type { BotDifficulty } from "@durak/protocol";
import { Button } from "@durak/ui";
import { Container, Text } from "pixi.js";
import { describe, expect, it, vi } from "vitest";
import "../test-setup/canvas-mock.js";
import { MainMenuScreen } from "./MainMenuScreen.js";

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
  it("shows the play-vs-bot and play-vs-friend entry points", () => {
    const screen = new MainMenuScreen({
      onPlayBot: vi.fn(),
      onPlayFriend: vi.fn(),
      onPlayFfa: vi.fn(),
    });
    const labels = collectText(screen);
    expect(labels).toContain("PLAY VS BOT");
    expect(labels).toContain("PLAY VS FRIEND");
    screen.dispose();
  });

  it("calls onPlayFriend when the friend button activates", () => {
    const onPlayFriend = vi.fn();
    const screen = new MainMenuScreen({
      onPlayBot: vi.fn(),
      onPlayFriend,
      onPlayFfa: vi.fn(),
    });
    const button = findButton(screen, "PLAY VS FRIEND");
    expect(button).toBeTruthy();
    if (!button) throw new Error("button not found");
    button.activate();
    expect(onPlayFriend).toHaveBeenCalledTimes(1);
    screen.dispose();
  });

  it("flips to the difficulty view on PLAY VS BOT activation", () => {
    const screen = new MainMenuScreen({
      onPlayBot: vi.fn(),
      onPlayFriend: vi.fn(),
      onPlayFfa: vi.fn(),
    });
    expect(screen.testView()).toBe("root");
    const button = findButton(screen, "PLAY VS BOT");
    if (!button) throw new Error("button not found");
    button.activate();
    expect(screen.testView()).toBe("bot-difficulty");
    const labels = collectText(screen);
    expect(labels).toContain("EASY");
    expect(labels).toContain("MEDIUM");
    expect(labels).toContain("HARD");
    expect(labels).toContain("BACK");
    screen.dispose();
  });
});

describe("MainMenuScreen FFA configurator", () => {
  it("opens the FFA configurator with cycling player / bot / difficulty rows", () => {
    const screen = new MainMenuScreen({
      onPlayBot: vi.fn(),
      onPlayFriend: vi.fn(),
      onPlayFfa: vi.fn(),
    });
    const playFfa = findButton(screen, "PLAY FFA");
    if (!playFfa) throw new Error("PLAY FFA not found");
    playFfa.activate();
    expect(screen.testView()).toBe("ffa-config");
    const labels = collectText(screen);
    expect(labels.some((l) => l.startsWith("PLAYERS:"))).toBe(true);
    expect(labels.some((l) => l.startsWith("BOTS:"))).toBe(true);
    expect(labels.some((l) => l.startsWith("DIFFICULTY:"))).toBe(true);
    expect(labels).toContain("START");
    expect(labels).toContain("BACK");
    screen.dispose();
  });

  it("clamps the bot count when the player count drops below the bot count", () => {
    const screen = new MainMenuScreen({
      onPlayBot: vi.fn(),
      onPlayFriend: vi.fn(),
      onPlayFfa: vi.fn(),
    });
    const playFfa = findButton(screen, "PLAY FFA");
    if (!playFfa) throw new Error("PLAY FFA not found");
    playFfa.activate();
    expect(screen.testFfaConfig()).toEqual({ playerCount: 4, botCount: 3, difficulty: "medium" });

    // PLAYERS cycles 4 → 5 → 6 → 2 (drops below current bot count of 3, clamps to 1)
    const players = findButton(screen, "PLAYERS: 4");
    if (!players) throw new Error("PLAYERS row not found");
    players.activate();
    players.activate();
    players.activate();
    expect(screen.testFfaConfig().playerCount).toBe(2);
    expect(screen.testFfaConfig().botCount).toBe(1);
    screen.dispose();
  });

  it("invokes onPlayFfa with the configured values on START", () => {
    const seen: { playerCount: number; botCount: number; difficulty: string }[] = [];
    const screen = new MainMenuScreen({
      onPlayBot: vi.fn(),
      onPlayFriend: vi.fn(),
      onPlayFfa: (config) => seen.push(config),
    });
    findButton(screen, "PLAY FFA")?.activate();
    findButton(screen, "START")?.activate();
    expect(seen).toEqual([{ playerCount: 4, botCount: 3, difficulty: "medium" }]);
    screen.dispose();
  });

  it("BACK from FFA returns to root", () => {
    const screen = new MainMenuScreen({
      onPlayBot: vi.fn(),
      onPlayFriend: vi.fn(),
      onPlayFfa: vi.fn(),
    });
    findButton(screen, "PLAY FFA")?.activate();
    findButton(screen, "BACK")?.activate();
    expect(screen.testView()).toBe("root");
    screen.dispose();
  });
});

describe("MainMenuScreen difficulty view", () => {
  function openDifficultyView(onPlayBot: (d: BotDifficulty) => void) {
    const screen = new MainMenuScreen({ onPlayBot, onPlayFriend: vi.fn(), onPlayFfa: vi.fn() });
    const playBot = findButton(screen, "PLAY VS BOT");
    if (!playBot) throw new Error("PLAY VS BOT button not found");
    playBot.activate();
    return screen;
  }

  it("invokes onPlayBot with the chosen difficulty", () => {
    const seen: BotDifficulty[] = [];
    const screen = openDifficultyView((d) => seen.push(d));
    const easy = findButton(screen, "EASY");
    if (!easy) throw new Error("EASY not found");
    easy.activate();
    const hard = findButton(screen, "HARD");
    if (!hard) throw new Error("HARD not found");
    hard.activate();
    expect(seen).toEqual(["easy", "hard"]);
    screen.dispose();
  });

  it("BACK returns to the root view", () => {
    const screen = openDifficultyView(vi.fn());
    const back = findButton(screen, "BACK");
    if (!back) throw new Error("BACK not found");
    back.activate();
    expect(screen.testView()).toBe("root");
    const labels = collectText(screen);
    expect(labels).toContain("PLAY VS BOT");
    expect(labels).not.toContain("EASY");
    screen.dispose();
  });
});
