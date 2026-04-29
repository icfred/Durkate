import type { Action, Event } from "@durak/engine";
import type { Snapshot } from "@durak/protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { appStore, EVENT_BUFFER_SIZE, generateRoomCode, parseHashRoom } from "./store.js";

describe("appStore", () => {
  beforeEach(() => {
    appStore.getState().showMenu();
  });

  it("starts in the menu phase with no room or mode", () => {
    const state = appStore.getState();
    expect(state.phase).toBe("menu");
    expect(state.roomCode).toBeUndefined();
    expect(state.mode).toBeUndefined();
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

  it("submitAction is replaceable via setSubmitAction", () => {
    const fn = vi.fn<(action: Action) => void>();
    appStore.getState().setSubmitAction(fn);
    const action: Action = { type: "TAKE_PILE", by: 0 };
    appStore.getState().submitAction(action);
    expect(fn).toHaveBeenCalledWith(action);
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
