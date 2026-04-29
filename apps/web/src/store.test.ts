import type { Event } from "@durak/engine";
import type { Snapshot } from "@durak/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appStore, EVENT_BUFFER_SIZE, generateRoomCode, parseHashRoom } from "./store.js";

describe("appStore", () => {
  beforeEach(() => {
    appStore.getState().showMenu();
    appStore.getState().setConnectionStatus("idle", { attempts: 0 });
    appStore.getState().setSender(null);
  });

  it("starts in the menu phase with no room or mode", () => {
    const state = appStore.getState();
    expect(state.phase).toBe("menu");
    expect(state.roomCode).toBeUndefined();
    expect(state.mode).toBeUndefined();
  });

  it("starts with an idle connection", () => {
    expect(appStore.getState().connection).toEqual({ status: "idle", attempts: 0 });
  });

  it("transitions menu -> lobby with mode and room code", () => {
    appStore.getState().showLobby({ mode: "bot", roomCode: "ABCD" });
    const state = appStore.getState();
    expect(state.phase).toBe("lobby");
    expect(state.mode).toBe("bot");
    expect(state.roomCode).toBe("ABCD");
  });

  it("clears mode and room code when returning to the menu", () => {
    appStore.getState().showLobby({ mode: "friend", roomCode: "WXYZ" });
    appStore.getState().showMenu();
    const state = appStore.getState();
    expect(state.phase).toBe("menu");
    expect(state.mode).toBeUndefined();
    expect(state.roomCode).toBeUndefined();
  });

  it("setSnapshot replaces the snapshot field", () => {
    const snapshot = makeSnapshot();
    appStore.getState().setSnapshot(snapshot);
    expect(appStore.getState().snapshot).toBe(snapshot);
    appStore.getState().setSnapshot(null);
    expect(appStore.getState().snapshot).toBeNull();
  });

  it("appendEvents keeps a ring buffer of the last EVENT_BUFFER_SIZE events", () => {
    const overflow = 5;
    const total = EVENT_BUFFER_SIZE + overflow;
    const events: Event[] = Array.from({ length: total }, (_, i) => ({
      type: "GAME_STARTED",
      trump: { suit: "hearts", rank: 6 + (i % 9) } as Event extends { trump: infer T } ? T : never,
      attacker: 0,
    }));
    appStore.getState().appendEvents(events.slice(0, EVENT_BUFFER_SIZE));
    appStore.getState().appendEvents(events.slice(EVENT_BUFFER_SIZE));
    const stored = appStore.getState().events;
    expect(stored.length).toBe(EVENT_BUFFER_SIZE);
    expect(stored[0]).toBe(events[overflow]);
    expect(stored[stored.length - 1]).toBe(events[total - 1]);
  });

  it("appendEvents bumps eventsTotal monotonically across overflow", () => {
    const event: Event = { type: "GAME_STARTED", trump: { suit: "hearts", rank: 6 }, attacker: 0 };
    expect(appStore.getState().eventsTotal).toBe(0);
    appStore.getState().appendEvents([event, event]);
    expect(appStore.getState().eventsTotal).toBe(2);
    appStore.getState().appendEvents(Array.from({ length: EVENT_BUFFER_SIZE + 3 }, () => event));
    expect(appStore.getState().eventsTotal).toBe(2 + EVENT_BUFFER_SIZE + 3);
    expect(appStore.getState().events.length).toBe(EVENT_BUFFER_SIZE);
  });

  it("showMenu resets eventsTotal to 0", () => {
    const event: Event = { type: "GAME_STARTED", trump: { suit: "hearts", rank: 6 }, attacker: 0 };
    appStore.getState().appendEvents([event]);
    expect(appStore.getState().eventsTotal).toBe(1);
    appStore.getState().showMenu();
    expect(appStore.getState().eventsTotal).toBe(0);
  });

  it("setConnectionStatus stores attempts and tracks the optional error", () => {
    appStore.getState().setConnectionStatus("error", { attempts: 3, error: "boom" });
    expect(appStore.getState().connection).toEqual({
      status: "error",
      attempts: 3,
      error: "boom",
    });
    appStore.getState().setConnectionStatus("open", { attempts: 0 });
    expect(appStore.getState().connection).toEqual({ status: "open", attempts: 0 });
  });

  it("transitions to gameover with the supplied data", () => {
    appStore.getState().showGameOver({ youSeat: 0, durak: 1 });
    const state = appStore.getState();
    expect(state.phase).toBe("gameover");
    expect(state.gameover).toEqual({ youSeat: 0, durak: 1 });
  });

  it("clears gameover data when returning to the menu", () => {
    appStore.getState().showGameOver({ youSeat: 0, durak: null });
    appStore.getState().showMenu();
    const state = appStore.getState();
    expect(state.phase).toBe("menu");
    expect(state.gameover).toBeUndefined();
  });
});

describe("appStore.requestRematch", () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    appStore.getState().setSender(null);
    appStore.getState().setConnectionStatus("idle", { attempts: 0 });
  });

  afterEach(() => {
    warn.mockRestore();
    appStore.getState().setSender(null);
    appStore.getState().setConnectionStatus("idle", { attempts: 0 });
  });

  it("forwards a RequestRematch through the registered sender when open", () => {
    const sent: unknown[] = [];
    appStore.getState().setSender((msg) => sent.push(msg));
    appStore.getState().setConnectionStatus("open", { attempts: 0 });
    appStore.getState().requestRematch();
    expect(sent).toEqual([{ type: "RequestRematch" }]);
  });

  it("drops with a warn when the connection is not open", () => {
    const sent: unknown[] = [];
    appStore.getState().setSender((msg) => sent.push(msg));
    appStore.getState().setConnectionStatus("connecting", { attempts: 0 });
    appStore.getState().requestRematch();
    expect(sent).toEqual([]);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("drops with a warn when no sender is registered", () => {
    appStore.getState().setConnectionStatus("open", { attempts: 0 });
    appStore.getState().requestRematch();
    expect(warn).toHaveBeenCalledOnce();
  });
});

describe("appStore.submitAction", () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    appStore.getState().setSender(null);
    appStore.getState().setConnectionStatus("idle", { attempts: 0 });
  });

  afterEach(() => {
    warn.mockRestore();
    appStore.getState().setSender(null);
    appStore.getState().setConnectionStatus("idle", { attempts: 0 });
  });

  it("forwards through the registered sender when the connection is open", () => {
    const sent: unknown[] = [];
    appStore.getState().setSender((msg) => sent.push(msg));
    appStore.getState().setConnectionStatus("open", { attempts: 0 });
    appStore.getState().submitAction({ type: "START_GAME" });
    expect(sent).toEqual([{ type: "SubmitAction", action: { type: "START_GAME" } }]);
  });

  it("drops with a warn when the connection is not open", () => {
    const sent: unknown[] = [];
    appStore.getState().setSender((msg) => sent.push(msg));
    appStore.getState().setConnectionStatus("connecting", { attempts: 0 });
    appStore.getState().submitAction({ type: "START_GAME" });
    expect(sent).toEqual([]);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("drops with a warn when no sender is registered", () => {
    appStore.getState().setConnectionStatus("open", { attempts: 0 });
    appStore.getState().submitAction({ type: "START_GAME" });
    expect(warn).toHaveBeenCalledOnce();
  });
});

function makeSnapshot(): Snapshot {
  return {
    phase: "in-round",
    playerCount: 2,
    handCounts: [6, 6],
    talonCount: 22,
    trump: { suit: "hearts", rank: 6 },
    table: [],
    attacker: 0,
    defender: 1,
    discard: [],
    seat: 0,
    you: { seat: 0, hand: [] },
  };
}

describe("parseHashRoom", () => {
  it("returns null for an empty hash", () => {
    expect(parseHashRoom("")).toBeNull();
  });

  it("returns null when no room param is present", () => {
    expect(parseHashRoom("#other=ABCD")).toBeNull();
  });

  it("extracts the room code and uppercases it", () => {
    expect(parseHashRoom("#room=abcd")).toBe("ABCD");
  });

  it("preserves longer alphanumeric codes", () => {
    expect(parseHashRoom("#room=Ab12Xy")).toBe("AB12XY");
  });
});

describe("generateRoomCode", () => {
  it("returns a 4-character code from the alphabet", () => {
    const code = generateRoomCode(() => 0);
    expect(code).toHaveLength(4);
    expect(code).toMatch(/^[A-Z0-9]+$/);
  });

  it("uses the supplied random source", () => {
    const code = generateRoomCode(() => 0);
    expect(code).toBe("AAAA");
  });
});

function setLocalStorage(value: object | undefined): void {
  if (value === undefined) {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  } else {
    (globalThis as { localStorage?: unknown }).localStorage = value;
  }
}

describe("audio mute", () => {
  let store: Map<string, string>;

  beforeEach(() => {
    store = new Map();
    setLocalStorage({
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
    });
    appStore.getState().setMuted(false);
  });

  afterEach(() => {
    setLocalStorage(undefined);
  });

  it("toggleMute flips the muted flag", () => {
    expect(appStore.getState().audio.muted).toBe(false);
    appStore.getState().toggleMute();
    expect(appStore.getState().audio.muted).toBe(true);
    appStore.getState().toggleMute();
    expect(appStore.getState().audio.muted).toBe(false);
  });

  it("persists mute state to localStorage on toggle", () => {
    appStore.getState().toggleMute();
    expect(store.get("durak.audio.muted")).toBe("1");
    appStore.getState().toggleMute();
    expect(store.get("durak.audio.muted")).toBe("0");
  });

  it("hydrates muted from localStorage on store init", async () => {
    store.set("durak.audio.muted", "1");
    vi.resetModules();
    const fresh = await import("./store.js");
    expect(fresh.appStore.getState().audio.muted).toBe(true);
  });
});
