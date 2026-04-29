import type { FocusManager } from "../focus/FocusManager.js";

export interface TextInputOverlayRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TextInputOverlayOptions {
  targetRect: TextInputOverlayRect;
  value?: string;
  onChange?: (value: string) => void;
  onSubmit?: (value: string) => void;
  onCancel?: () => void;
  focus?: Pick<FocusManager, "suspend" | "resume">;
}

export interface TextInputOverlayHandle {
  unmount(): void;
}

export function mountTextInputOverlay(options: TextInputOverlayOptions): TextInputOverlayHandle {
  const { targetRect, value = "", onChange, onSubmit, onCancel, focus } = options;

  const input = document.createElement("input");
  input.type = "text";
  input.value = value;
  const style = input.style;
  style.position = "absolute";
  style.left = `${targetRect.x}px`;
  style.top = `${targetRect.y}px`;
  style.width = `${targetRect.width}px`;
  style.height = `${targetRect.height}px`;
  style.margin = "0";
  style.padding = "0";
  style.border = "0";
  style.outline = "none";
  style.background = "transparent";
  style.color = "transparent";
  style.caretColor = "transparent";
  style.font = "inherit";

  const handleInput = (): void => {
    onChange?.(input.value);
  };

  const handleKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Enter") {
      event.preventDefault();
      onSubmit?.(input.value);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      onCancel?.();
    }
  };

  input.addEventListener("input", handleInput);
  input.addEventListener("keydown", handleKeyDown);

  document.body.appendChild(input);
  focus?.suspend();
  input.focus();

  let unmounted = false;
  return {
    unmount(): void {
      if (unmounted) return;
      unmounted = true;
      input.removeEventListener("input", handleInput);
      input.removeEventListener("keydown", handleKeyDown);
      input.remove();
      focus?.resume();
    },
  };
}
