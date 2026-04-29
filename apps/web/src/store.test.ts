import { beforeEach, describe, expect, it } from "vitest";
import { appStore, generateRoomCode, parseHashRoom } from "./store.js";

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
});

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
