// Shared back-navigation helper. Each screen that supports backwards
// navigation calls `attachBackNav` once and stores the returned detach fn,
// then calls it from `dispose()`. Backspace and Escape both fire the
// `onBack` callback. The handler is suppressed while a TextInputOverlay
// (or any HTML <input>/<textarea>) holds focus so backspace still deletes
// characters in text fields.

export interface BackNavOptions {
  onBack: () => void;
  /** Optional gate. When provided and returns false, the keystroke is ignored. */
  shouldHandle?: () => boolean;
}

export function attachBackNav(options: BackNavOptions): () => void {
  const handler = (event: KeyboardEvent): void => {
    if (event.key !== "Backspace" && event.key !== "Escape") return;
    if (options.shouldHandle && !options.shouldHandle()) return;
    const target = event.target as HTMLElement | null;
    if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
    event.preventDefault();
    options.onBack();
  };
  window.addEventListener("keydown", handler);
  return () => window.removeEventListener("keydown", handler);
}
