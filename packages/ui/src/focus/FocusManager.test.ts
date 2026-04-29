import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Focusable, FocusManager } from "./FocusManager.js";

class FakeNode implements Focusable {
  setFocus = vi.fn();
  activate = vi.fn();
}

const press = (key: string, init: KeyboardEventInit = {}): KeyboardEvent =>
  new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });

describe("FocusManager", () => {
  let mgr: FocusManager;

  beforeEach(() => {
    mgr = new FocusManager();
    mgr.attach();
  });

  afterEach(() => {
    mgr.detach();
  });

  it("auto-focuses the first registered node", () => {
    const a = new FakeNode();
    mgr.register(a);
    expect(a.setFocus).toHaveBeenCalledWith(true);
  });

  it("does not steal focus when registering subsequent nodes", () => {
    const a = new FakeNode();
    const b = new FakeNode();
    mgr.register(a);
    a.setFocus.mockClear();
    mgr.register(b);
    expect(b.setFocus).not.toHaveBeenCalledWith(true);
    expect(a.setFocus).not.toHaveBeenCalledWith(false);
  });

  it("ignores duplicate registrations", () => {
    const a = new FakeNode();
    mgr.register(a);
    mgr.register(a);
    mgr.focusNext();
    expect(a.setFocus).toHaveBeenCalledWith(true);
    expect(a.setFocus).not.toHaveBeenCalledWith(false);
  });

  it("ArrowDown / ArrowRight / Tab move focus forward and wrap", () => {
    const a = new FakeNode();
    const b = new FakeNode();
    const c = new FakeNode();
    mgr.register(a);
    mgr.register(b);
    mgr.register(c);
    a.setFocus.mockClear();
    b.setFocus.mockClear();
    c.setFocus.mockClear();

    window.dispatchEvent(press("ArrowDown"));
    expect(b.setFocus).toHaveBeenLastCalledWith(true);
    expect(a.setFocus).toHaveBeenLastCalledWith(false);

    window.dispatchEvent(press("ArrowRight"));
    expect(c.setFocus).toHaveBeenLastCalledWith(true);

    window.dispatchEvent(press("Tab"));
    expect(a.setFocus).toHaveBeenLastCalledWith(true);
  });

  it("ArrowUp / ArrowLeft / Shift+Tab move focus backward and wrap", () => {
    const a = new FakeNode();
    const b = new FakeNode();
    mgr.register(a);
    mgr.register(b);
    a.setFocus.mockClear();
    b.setFocus.mockClear();

    window.dispatchEvent(press("ArrowUp"));
    expect(b.setFocus).toHaveBeenLastCalledWith(true);

    window.dispatchEvent(press("Tab", { shiftKey: true }));
    expect(a.setFocus).toHaveBeenLastCalledWith(true);

    window.dispatchEvent(press("ArrowLeft"));
    expect(b.setFocus).toHaveBeenLastCalledWith(true);
  });

  it("Enter and Space activate the focused node", () => {
    const a = new FakeNode();
    const b = new FakeNode();
    mgr.register(a);
    mgr.register(b);
    mgr.focusNext();

    window.dispatchEvent(press("Enter"));
    expect(b.activate).toHaveBeenCalledTimes(1);
    expect(a.activate).not.toHaveBeenCalled();

    window.dispatchEvent(press(" "));
    expect(b.activate).toHaveBeenCalledTimes(2);
  });

  it("Enter does nothing when no node is registered", () => {
    expect(() => window.dispatchEvent(press("Enter"))).not.toThrow();
  });

  it("Escape fires onEscape only when configured", () => {
    const onEscape = vi.fn();
    const a = new FakeNode();
    mgr.detach();
    const escMgr = new FocusManager({ onEscape });
    escMgr.attach();
    escMgr.register(a);

    window.dispatchEvent(press("Escape"));
    expect(onEscape).toHaveBeenCalledTimes(1);
    escMgr.detach();
  });

  it("preventDefault is called on handled keys", () => {
    const a = new FakeNode();
    mgr.register(a);
    const ev = press("Tab");
    window.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
  });

  it("ignores unhandled keys", () => {
    const a = new FakeNode();
    mgr.register(a);
    const ev = press("x");
    window.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
  });

  it("unregister of focused node moves focus to the previous sibling", () => {
    const a = new FakeNode();
    const b = new FakeNode();
    const c = new FakeNode();
    mgr.register(a);
    mgr.register(b);
    mgr.register(c);
    mgr.focusNext();
    mgr.focusNext();
    a.setFocus.mockClear();
    b.setFocus.mockClear();
    c.setFocus.mockClear();

    mgr.unregister(c);
    expect(c.setFocus).toHaveBeenCalledWith(false);
    expect(b.setFocus).toHaveBeenLastCalledWith(true);
  });

  it("unregister of an earlier sibling keeps the focused node focused", () => {
    const a = new FakeNode();
    const b = new FakeNode();
    const c = new FakeNode();
    mgr.register(a);
    mgr.register(b);
    mgr.register(c);
    mgr.focusNext();
    mgr.focusNext();
    a.setFocus.mockClear();
    b.setFocus.mockClear();
    c.setFocus.mockClear();

    mgr.unregister(a);
    window.dispatchEvent(press("Enter"));
    expect(c.activate).toHaveBeenCalledTimes(1);
  });

  it("unregister of a later sibling does not change the focused index", () => {
    const a = new FakeNode();
    const b = new FakeNode();
    const c = new FakeNode();
    mgr.register(a);
    mgr.register(b);
    mgr.register(c);
    a.setFocus.mockClear();
    b.setFocus.mockClear();
    c.setFocus.mockClear();

    mgr.unregister(c);
    window.dispatchEvent(press("Enter"));
    expect(a.activate).toHaveBeenCalledTimes(1);
  });

  it("unregister of the only node clears focus", () => {
    const a = new FakeNode();
    mgr.register(a);
    a.setFocus.mockClear();
    mgr.unregister(a);
    expect(a.setFocus).toHaveBeenCalledWith(false);

    window.dispatchEvent(press("Enter"));
    expect(a.activate).not.toHaveBeenCalled();
  });

  it("clear unfocuses every node", () => {
    const a = new FakeNode();
    const b = new FakeNode();
    mgr.register(a);
    mgr.register(b);
    a.setFocus.mockClear();
    b.setFocus.mockClear();

    mgr.clear();
    expect(a.setFocus).toHaveBeenCalledWith(false);
    expect(b.setFocus).toHaveBeenCalledWith(false);
  });

  it("detach stops responding to keys", () => {
    const a = new FakeNode();
    mgr.register(a);
    a.setFocus.mockClear();
    mgr.detach();

    window.dispatchEvent(press("ArrowDown"));
    expect(a.setFocus).not.toHaveBeenCalled();
  });

  it("attach is idempotent", () => {
    const a = new FakeNode();
    mgr.register(a);
    mgr.attach();
    mgr.attach();
    a.activate.mockClear();

    window.dispatchEvent(press("Enter"));
    expect(a.activate).toHaveBeenCalledTimes(1);
  });

  it("suspend stops Tab and Enter routing without preventDefault", () => {
    const a = new FakeNode();
    const b = new FakeNode();
    mgr.register(a);
    mgr.register(b);
    a.setFocus.mockClear();
    b.setFocus.mockClear();

    mgr.suspend();

    const tab = press("Tab");
    window.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(false);
    expect(b.setFocus).not.toHaveBeenCalledWith(true);

    const enter = press("Enter");
    window.dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(false);
    expect(a.activate).not.toHaveBeenCalled();
  });

  it("resume restores key routing", () => {
    const a = new FakeNode();
    const b = new FakeNode();
    mgr.register(a);
    mgr.register(b);
    mgr.suspend();
    mgr.resume();
    a.setFocus.mockClear();
    b.setFocus.mockClear();

    window.dispatchEvent(press("Tab"));
    expect(b.setFocus).toHaveBeenLastCalledWith(true);

    window.dispatchEvent(press("Enter"));
    expect(b.activate).toHaveBeenCalledTimes(1);
  });

  it("suspend and resume are idempotent", () => {
    const a = new FakeNode();
    mgr.register(a);
    a.activate.mockClear();

    mgr.suspend();
    mgr.suspend();
    window.dispatchEvent(press("Enter"));
    expect(a.activate).not.toHaveBeenCalled();

    mgr.resume();
    mgr.resume();
    window.dispatchEvent(press("Enter"));
    expect(a.activate).toHaveBeenCalledTimes(1);
  });
});
