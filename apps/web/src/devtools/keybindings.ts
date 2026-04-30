import type { StoreApi } from "zustand/vanilla";
import type { AppState } from "../store.js";

export interface DevtoolsKeybindingOptions {
  store: StoreApi<AppState>;
  /** Test seam: defaults to `window`. */
  target?: EventTarget;
}

/**
 * Binds Ctrl+Shift+D as a global toggle for the dev panel and Escape as a
 * close-when-open shortcut. Returns a teardown that detaches the listener.
 *
 * The Ctrl+Shift+D combo is unconditional — it even fires while a text
 * input is focused, on purpose, so the panel is always reachable. Escape
 * is gated on the panel being open and skips text inputs so it does not
 * collide with overlay dismissals elsewhere.
 */
export function bindDevtoolsShortcut(options: DevtoolsKeybindingOptions): () => void {
  const target = options.target ?? (typeof window === "undefined" ? null : window);
  if (!target) return () => {};
  const store = options.store;

  const handler = (raw: Event): void => {
    const event = raw as KeyboardEvent;
    if (event.key === "D" || event.key === "d") {
      if (event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey) {
        event.preventDefault();
        store.getState().toggleDevtools();
        return;
      }
    }
    if (event.key === "Escape" && store.getState().devtools.open) {
      const t = event.target;
      if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) return;
      event.preventDefault();
      store.getState().setDevtoolsOpen(false);
    }
  };

  target.addEventListener("keydown", handler);
  return () => target.removeEventListener("keydown", handler);
}
