// @vitest-environment happy-dom
import { Container, Text } from "pixi.js";
import { describe, expect, it, vi } from "vitest";
import "../test-setup/canvas-mock.js";
import type { RoomMembership } from "../store.js";
import { LobbyScreen } from "./LobbyScreen.js";

function collectText(container: Container, out: string[] = []): string[] {
  for (const child of container.children) {
    if (child instanceof Text) out.push(child.text);
    if (child instanceof Container) collectText(child, out);
  }
  return out;
}

function makeRoom(occupants: (string | null)[], you: number | null = 0): RoomMembership {
  return {
    seats: occupants.map((name) => ({ name })),
    you,
  };
}

describe("LobbyScreen friend mode", () => {
  it('shows "WAITING FOR OPPONENT" until both seats are filled', () => {
    const screen = new LobbyScreen({
      mode: "friend",
      roomCode: "ABCD",
      shareUrl: "https://durak/#room=ABCD",
      initialRoom: makeRoom(["alice", null]),
      onJoin: vi.fn(),
    });
    expect(collectText(screen)).toContain("WAITING FOR OPPONENT");
    screen.dispose();
  });

  it('flips to "STARTING" when the second seat fills', () => {
    const listeners: ((room: RoomMembership | null) => void)[] = [];
    const screen = new LobbyScreen({
      mode: "friend",
      roomCode: "ABCD",
      shareUrl: "https://durak/#room=ABCD",
      initialRoom: makeRoom(["alice", null]),
      subscribe: (cb) => {
        listeners.push(cb);
        return () => {
          const idx = listeners.indexOf(cb);
          if (idx >= 0) listeners.splice(idx, 1);
        };
      },
      onJoin: vi.fn(),
    });
    expect(collectText(screen)).toContain("WAITING FOR OPPONENT");
    for (const cb of listeners) cb(makeRoom(["alice", "bob"], 0));
    expect(collectText(screen)).toContain("STARTING");
    screen.dispose();
  });

  it("renders the room code and share URL", () => {
    const screen = new LobbyScreen({
      mode: "friend",
      roomCode: "WXYZ",
      shareUrl: "https://durak/#room=WXYZ",
      initialRoom: null,
      onJoin: vi.fn(),
    });
    const labels = collectText(screen);
    expect(labels).toContain("WXYZ");
    expect(labels).toContain("https://durak/#room=WXYZ");
    expect(labels).toContain("COPY LINK");
    screen.dispose();
  });

  it("invokes copyToClipboard with the share URL on COPY LINK activation", async () => {
    const copy = vi.fn().mockResolvedValue(undefined);
    const screen = new LobbyScreen({
      mode: "friend",
      roomCode: "ABCD",
      shareUrl: "https://durak/#room=ABCD",
      initialRoom: null,
      onJoin: vi.fn(),
      copyToClipboard: copy,
    });
    const copyButton = screen.children[0]?.children.find(
      (child): child is Container =>
        child instanceof Container && collectText(child as Container).includes("COPY LINK"),
    );
    if (!copyButton) throw new Error("copy button not found");
    (copyButton as unknown as { activate(): void }).activate();
    expect(copy).toHaveBeenCalledWith("https://durak/#room=ABCD");
    screen.dispose();
  });
});

describe("LobbyScreen bot mode", () => {
  it('renders "STARTING VS BOT" and omits the share/join section', () => {
    const screen = new LobbyScreen({
      mode: "bot",
      roomCode: "ABCD",
      shareUrl: "https://durak/#room=ABCD",
      initialRoom: null,
      onJoin: vi.fn(),
    });
    const labels = collectText(screen);
    expect(labels).toContain("STARTING VS BOT");
    expect(labels).not.toContain("SHARE");
    expect(labels).not.toContain("COPY LINK");
    expect(labels).not.toContain("JOIN ANOTHER ROOM");
    screen.dispose();
  });
});
