import type { Event } from "@durak/engine";
import type { Snapshot } from "@durak/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appStore,
  buildShareUrl,
  EVENT_BUFFER_SIZE,
  parseHashJoin,
  parseHashRoom,
} from "./store.js";

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
    trumpSuit: "hearts",
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

  it("extracts the room code preserving case (server ids are base64url)", () => {
    expect(parseHashRoom("#room=Ab12Xy")).toBe("Ab12Xy");
  });

  it("accepts base64url characters _ and -", () => {
    expect(parseHashRoom("#room=abc_-DEF")).toBe("abc_-DEF");
  });

  it("ignores other parameters preceding room=", () => {
    expect(parseHashRoom("#sandbox=foo&room=ABCD")).toBe("ABCD");
  });
});

describe("parseHashJoin", () => {
  it("returns null when only room is present", () => {
    expect(parseHashJoin("#room=ABCD")).toBeNull();
  });

  it("returns null when only token is present", () => {
    expect(parseHashJoin("#t=xyz")).toBeNull();
  });

  it("extracts both fields when both are present", () => {
    expect(parseHashJoin("#room=ABC&t=xyz")).toEqual({
      roomCode: "ABC",
      token: "xyz",
      tokens: ["xyz"],
    });
  });

  it("works with base64url room and token", () => {
    expect(parseHashJoin("#room=A_b-9&t=tok_-1")).toEqual({
      roomCode: "A_b-9",
      token: "tok_-1",
      tokens: ["tok_-1"],
    });
  });

  it("splits a comma-separated token list and surfaces the first as `token`", () => {
    expect(parseHashJoin("#room=ABC&t=tok1,tok2,tok3")).toEqual({
      roomCode: "ABC",
      token: "tok1",
      tokens: ["tok1", "tok2", "tok3"],
    });
  });

  it("captures playerCount and botCount when the share URL carries them", () => {
    expect(parseHashJoin("#room=ABC&t=xyz&pc=4&bc=1")).toEqual({
      roomCode: "ABC",
      token: "xyz",
      tokens: ["xyz"],
      playerCount: 4,
      botCount: 1,
    });
  });
});

describe("buildShareUrl", () => {
  it("encodes both roomCode and token into the hash", () => {
    expect(buildShareUrl("https://durak.example", "ABCD", "xyz")).toBe(
      "https://durak.example/#room=ABCD&t=xyz",
    );
  });

  it("URL-encodes characters that need it", () => {
    expect(buildShareUrl("https://durak.example", "A B", "x/y")).toBe(
      "https://durak.example/#room=A%20B&t=x%2Fy",
    );
  });
});

describe("appStore room creation", () => {
  beforeEach(() => {
    appStore.getState().showMenu();
  });

  it("beginRoomCreation enters lobby with creating state and clears prior creds", () => {
    appStore.getState().beginRoomCreation({ mode: "bot" });
    const state = appStore.getState();
    expect(state.phase).toBe("lobby");
    expect(state.mode).toBe("bot");
    expect(state.roomCode).toBeUndefined();
    expect(state.currentToken).toBeNull();
    expect(state.shareToken).toBeNull();
    expect(state.roomCreation).toEqual({ status: "creating" });
  });

  it("beginRoomCreation stores bot difficulty for bot rooms", () => {
    appStore.getState().beginRoomCreation({ mode: "bot", difficulty: "hard" });
    expect(appStore.getState().botDifficulty).toBe("hard");
  });

  it("beginRoomCreation does not record difficulty for friend rooms", () => {
    appStore.getState().beginRoomCreation({ mode: "friend", difficulty: "hard" });
    expect(appStore.getState().botDifficulty).toBeUndefined();
  });

  it("roomCreated populates roomCode, token, and ready state", () => {
    appStore.getState().beginRoomCreation({ mode: "friend" });
    appStore.getState().roomCreated({
      roomId: "abc-123",
      hostToken: "host-tok",
      shareToken: "join-tok",
    });
    const state = appStore.getState();
    expect(state.roomCode).toBe("abc-123");
    expect(state.currentToken).toBe("host-tok");
    expect(state.shareToken).toBe("join-tok");
    expect(state.roomCreation).toEqual({ status: "ready" });
  });

  it("roomCreationFailed records the error", () => {
    appStore.getState().beginRoomCreation({ mode: "bot" });
    appStore.getState().roomCreationFailed("network down");
    expect(appStore.getState().roomCreation).toEqual({ status: "error", error: "network down" });
  });

  it("enterLobbyAsJoiner sets ready state with token", () => {
    appStore.getState().enterLobbyAsJoiner({ roomCode: "abc", token: "join-tok" });
    const state = appStore.getState();
    expect(state.phase).toBe("lobby");
    expect(state.mode).toBe("friend");
    expect(state.roomCode).toBe("abc");
    expect(state.currentToken).toBe("join-tok");
    expect(state.roomCreation).toEqual({ status: "ready" });
  });

  it("showMenu clears all room-creation state", () => {
    appStore.getState().beginRoomCreation({ mode: "bot" });
    appStore.getState().roomCreated({ roomId: "x", hostToken: "y" });
    appStore.getState().showMenu();
    const state = appStore.getState();
    expect(state.currentToken).toBeNull();
    expect(state.shareToken).toBeNull();
    expect(state.roomCreation).toEqual({ status: "idle" });
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
