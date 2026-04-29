import { afterEach, describe, expect, it, vi } from "vitest";
import { FocusManager } from "../focus/FocusManager.js";
import { mountTextInputOverlay } from "./TextInputOverlay.js";

const rect = { x: 10, y: 20, width: 200, height: 32 };

const press = (input: HTMLInputElement, key: string): KeyboardEvent => {
  const ev = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  input.dispatchEvent(ev);
  return ev;
};

const findInput = (): HTMLInputElement => {
  const node = document.body.querySelector("input");
  if (!node) throw new Error("expected an input in the document");
  return node;
};

describe("mountTextInputOverlay", () => {
  afterEach(() => {
    for (const node of Array.from(document.body.querySelectorAll("input"))) {
      node.remove();
    }
  });

  it("appends an input to document.body and removes it on unmount", () => {
    const handle = mountTextInputOverlay({ targetRect: rect });
    expect(document.body.querySelectorAll("input")).toHaveLength(1);

    handle.unmount();
    expect(document.body.querySelectorAll("input")).toHaveLength(0);
  });

  it("positions the input over the target rect", () => {
    mountTextInputOverlay({ targetRect: rect });
    const input = findInput();
    expect(input.style.position).toBe("absolute");
    expect(input.style.left).toBe("10px");
    expect(input.style.top).toBe("20px");
    expect(input.style.width).toBe("200px");
    expect(input.style.height).toBe("32px");
  });

  it("seeds the input with the provided value", () => {
    mountTextInputOverlay({ targetRect: rect, value: "hello" });
    expect(findInput().value).toBe("hello");
  });

  it("routes typing through onChange", () => {
    const onChange = vi.fn();
    mountTextInputOverlay({ targetRect: rect, onChange });
    const input = findInput();
    input.value = "ab";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(onChange).toHaveBeenCalledWith("ab");
  });

  it("routes Enter to onSubmit with the current value", () => {
    const onSubmit = vi.fn();
    mountTextInputOverlay({ targetRect: rect, value: "seed", onSubmit });
    const input = findInput();
    input.value = "ROOM42";
    const ev = press(input, "Enter");
    expect(onSubmit).toHaveBeenCalledWith("ROOM42");
    expect(ev.defaultPrevented).toBe(true);
  });

  it("routes Escape to onCancel", () => {
    const onCancel = vi.fn();
    mountTextInputOverlay({ targetRect: rect, onCancel });
    const ev = press(findInput(), "Escape");
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(ev.defaultPrevented).toBe(true);
  });

  it("suspends the focus manager on mount and resumes on unmount", () => {
    const focus = new FocusManager();
    const suspendSpy = vi.spyOn(focus, "suspend");
    const resumeSpy = vi.spyOn(focus, "resume");

    const handle = mountTextInputOverlay({ targetRect: rect, focus });
    expect(suspendSpy).toHaveBeenCalledTimes(1);
    expect(resumeSpy).not.toHaveBeenCalled();

    handle.unmount();
    expect(resumeSpy).toHaveBeenCalledTimes(1);
  });

  it("does not require a focus handle", () => {
    const handle = mountTextInputOverlay({ targetRect: rect });
    expect(() => handle.unmount()).not.toThrow();
  });

  it("unmount is idempotent", () => {
    const focus = new FocusManager();
    const resumeSpy = vi.spyOn(focus, "resume");
    const handle = mountTextInputOverlay({ targetRect: rect, focus });

    handle.unmount();
    handle.unmount();
    expect(resumeSpy).toHaveBeenCalledTimes(1);
    expect(document.body.querySelectorAll("input")).toHaveLength(0);
  });

  it("blocks FocusManager key routing while mounted", () => {
    const focus = new FocusManager();
    focus.attach();
    const node = { setFocus: vi.fn(), activate: vi.fn() };
    focus.register(node);
    node.setFocus.mockClear();

    const handle = mountTextInputOverlay({ targetRect: rect, focus });
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
    expect(node.activate).not.toHaveBeenCalled();

    handle.unmount();
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
    expect(node.activate).toHaveBeenCalledTimes(1);
    focus.detach();
  });
});
