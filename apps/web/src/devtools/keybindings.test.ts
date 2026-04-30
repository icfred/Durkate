import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appStore } from "../store.js";
import { bindDevtoolsShortcut } from "./keybindings.js";

describe("bindDevtoolsShortcut", () => {
  let cleanup: () => void = () => {};

  beforeEach(() => {
    appStore.getState().showMenu();
    appStore.getState().setDevtoolsOpen(false);
  });

  afterEach(() => {
    cleanup();
    appStore.getState().setDevtoolsOpen(false);
  });

  it("toggles devtools.open on Ctrl+Shift+D", () => {
    cleanup = bindDevtoolsShortcut({ store: appStore });
    expect(appStore.getState().devtools.open).toBe(false);

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "D", ctrlKey: true, shiftKey: true }));
    expect(appStore.getState().devtools.open).toBe(true);

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "D", ctrlKey: true, shiftKey: true }));
    expect(appStore.getState().devtools.open).toBe(false);
  });

  it("ignores plain D without modifiers", () => {
    cleanup = bindDevtoolsShortcut({ store: appStore });
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "d" }));
    expect(appStore.getState().devtools.open).toBe(false);
  });

  it("closes the panel on Escape when open", () => {
    appStore.getState().setDevtoolsOpen(true);
    cleanup = bindDevtoolsShortcut({ store: appStore });
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(appStore.getState().devtools.open).toBe(false);
  });

  it("Escape is a no-op when the panel is closed", () => {
    cleanup = bindDevtoolsShortcut({ store: appStore });
    const before = appStore.getState().devtools.open;
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(appStore.getState().devtools.open).toBe(before);
  });

  it("teardown removes the listener", () => {
    cleanup = bindDevtoolsShortcut({ store: appStore });
    cleanup();
    cleanup = () => {};
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "D", ctrlKey: true, shiftKey: true }));
    expect(appStore.getState().devtools.open).toBe(false);
  });

  it("works against an injected target", () => {
    const target = new EventTarget();
    cleanup = bindDevtoolsShortcut({ store: appStore, target });
    target.dispatchEvent(new KeyboardEvent("keydown", { key: "D", ctrlKey: true, shiftKey: true }));
    expect(appStore.getState().devtools.open).toBe(true);
  });
});

describe("setAnimSpeed clamping", () => {
  beforeEach(() => {
    appStore.getState().setAnimSpeed(1);
  });

  it("clamps below 0 to 0", () => {
    appStore.getState().setAnimSpeed(-5);
    expect(appStore.getState().devtools.animSpeed).toBe(0);
  });

  it("clamps above 2 to 2", () => {
    appStore.getState().setAnimSpeed(5);
    expect(appStore.getState().devtools.animSpeed).toBe(2);
  });

  it("accepts values inside [0, 2]", () => {
    appStore.getState().setAnimSpeed(0.5);
    expect(appStore.getState().devtools.animSpeed).toBe(0.5);
    appStore.getState().setAnimSpeed(1.75);
    expect(appStore.getState().devtools.animSpeed).toBe(1.75);
  });

  it("falls back to default for non-finite values", () => {
    appStore.getState().setAnimSpeed(Number.NaN);
    expect(appStore.getState().devtools.animSpeed).toBe(1);
  });
});

// Ensure Vitest's spies do not leak between specs.
afterEach(() => {
  vi.restoreAllMocks();
});
