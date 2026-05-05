// @vitest-environment happy-dom
import { Container, Text } from "pixi.js";
import { describe, expect, it, vi } from "vitest";
import "../test-setup/canvas-mock.js";
import type { RoomMembership } from "../store.js";
import { LobbyScreen } from "./LobbyScreen.js";

function collectText(container: Container, out: string[] = []): string[] {
  for (const child of container.children) {
    if (!child.visible) continue;
    if (child instanceof Text) out.push(child.text);
    if (child instanceof Container) collectText(child, out);
  }
  return out;
}

function findContainerWithText(container: Container, label: string): Container | null {
  if (container.children.some((c) => c instanceof Text && (c as Text).text === label)) {
    return container;
  }
  for (const child of container.children) {
    if (child instanceof Container) {
      const inner = findContainerWithText(child as Container, label);
      if (inner) return inner;
    }
  }
  return null;
}

function makeRoom(occupants: (string | null)[], you: number | null = 0): RoomMembership {
  return {
    seats: occupants.map((name) => ({ name })),
    you,
    rematchRequested: [],
    disconnect: null,
    disconnects: [],
    thinkingSeats: [],
    eliminated: [],
    pendingClose: null,
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
    const copyButton = findContainerWithText(screen, "COPY LINK");
    if (!copyButton) throw new Error("copy button not found");
    (copyButton as unknown as { activate(): void }).activate();
    expect(copy).toHaveBeenCalledWith("https://durak/#room=ABCD");
    screen.dispose();
  });
});

describe("LobbyScreen creation overlay", () => {
  it('shows "CREATING ROOM..." and hides the room code while creating', () => {
    const screen = new LobbyScreen({
      mode: "bot",
      roomCode: "",
      shareUrl: "",
      initialRoom: null,
      initialCreation: { status: "creating" },
      onJoin: vi.fn(),
    });
    expect(collectText(screen)).toContain("CREATING ROOM...");
    expect(collectText(screen)).not.toContain("STARTING VS BOT");
    screen.dispose();
  });

  it('shows error and a "RETRY" button when creation fails', () => {
    const screen = new LobbyScreen({
      mode: "bot",
      roomCode: "",
      shareUrl: "",
      initialRoom: null,
      initialCreation: { status: "error", error: "boom" },
      onJoin: vi.fn(),
      onRetry: vi.fn(),
    });
    const labels = collectText(screen);
    expect(labels.join("|")).toContain("COULD NOT CREATE ROOM");
    expect(labels.join("|")).toContain("boom");
    expect(labels).toContain("RETRY");
    screen.dispose();
  });

  it("transitions creating -> ready via subscribeCreation", () => {
    const listeners: ((s: { status: string; error?: string }) => void)[] = [];
    const screen = new LobbyScreen({
      mode: "bot",
      roomCode: "",
      shareUrl: "",
      initialRoom: null,
      initialCreation: { status: "creating" },
      subscribeCreation: (cb) => {
        listeners.push(cb as (s: { status: string }) => void);
        return () => undefined;
      },
      onJoin: vi.fn(),
    });
    expect(collectText(screen)).toContain("CREATING ROOM...");
    for (const cb of listeners) cb({ status: "ready" });
    expect(collectText(screen)).toContain("STARTING VS BOT");
    screen.dispose();
  });

  it("invokes onRetry when the RETRY button activates", () => {
    const onRetry = vi.fn();
    const screen = new LobbyScreen({
      mode: "bot",
      roomCode: "",
      shareUrl: "",
      initialRoom: null,
      initialCreation: { status: "error", error: "boom" },
      onJoin: vi.fn(),
      onRetry,
    });
    const retryButton = findContainerWithText(screen, "RETRY");
    if (!retryButton) throw new Error("retry button not found");
    (retryButton as unknown as { activate(): void }).activate();
    expect(onRetry).toHaveBeenCalledOnce();
    screen.dispose();
  });
});

describe("LobbyScreen N-aware FFA", () => {
  it("shows X / Y joined when the room expects multiple humans", () => {
    const screen = new LobbyScreen({
      mode: "ffa",
      roomCode: "ABCD",
      playerCount: 4,
      botCount: 1,
      shareUrls: ["https://x/#1", "https://x/#2"],
      initialRoom: makeRoom(["host", null, null]),
      onJoin: vi.fn(),
    });
    expect(collectText(screen)).toContain("1 / 3 JOINED");
    screen.dispose();
  });

  it("renders one COPY LINK button per join token", () => {
    const screen = new LobbyScreen({
      mode: "ffa",
      roomCode: "ABCD",
      playerCount: 4,
      botCount: 1,
      shareUrls: ["https://x/#1", "https://x/#2"],
      initialRoom: makeRoom(["host", null, null]),
      onJoin: vi.fn(),
    });
    const labels = collectText(screen);
    expect(labels).toContain("COPY LINK 1");
    expect(labels).toContain("COPY LINK 2");
    screen.dispose();
  });

  it("solo-vs-bots FFA hides the share section entirely", () => {
    const screen = new LobbyScreen({
      mode: "ffa",
      roomCode: "ABCD",
      playerCount: 4,
      botCount: 3,
      shareUrls: [],
      initialRoom: null,
      onJoin: vi.fn(),
    });
    const labels = collectText(screen);
    expect(labels).not.toContain("SHARE");
    expect(labels).not.toContain("COPY LINK");
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
