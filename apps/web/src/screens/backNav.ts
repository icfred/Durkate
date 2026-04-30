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
    // When focus is in a text input, suppress Backspace (so it can delete
    // characters) but still honour Escape (it has no default behaviour
    // there). On an *empty* input, even Backspace navigates back —
    // otherwise the user is stuck if the input has stolen focus.
    if (event.key === "Backspace") {
      const target = event.target as HTMLElement | null;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
        if (target.value && target.value.length > 0) return;
      }
    }
    event.preventDefault();
    options.onBack();
  };
  window.addEventListener("keydown", handler);
  return () => window.removeEventListener("keydown", handler);
}
