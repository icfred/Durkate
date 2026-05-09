export interface Focusable {
  setFocus(focused: boolean): void;
  activate(): void;
  /**
   * Optional left/right arrow handler for form-style navigation. When
   * the manager is in `form` arrow mode, ArrowLeft / ArrowRight call
   * `step(-1)` / `step(+1)` on the focused node instead of advancing
   * focus to the next sibling. Cycle and NumberStepper implement this.
   */
  step?(direction: -1 | 1): void;
}

export type ArrowMode = "linear" | "form";

export interface FocusManagerOptions {
  onEscape?: () => void;
  target?: Window | HTMLElement;
  /**
   * Arrow-key behaviour. `linear` (default) — Up/Right go next,
   * Down/Left go prev (matches button menus). `form` — Up/Down navigate
   * between fields, Left/Right call `step(direction)` on the focused
   * field (matches a settings panel of cycles + steppers).
   */
  arrowMode?: ArrowMode;
}

export type FocusEventListener = () => void;

export class FocusManager {
  private nodes: Focusable[] = [];
  private index = -1;
  private readonly target: Window | HTMLElement;
  private readonly onEscape: (() => void) | undefined;
  private readonly arrowMode: ArrowMode;
  private readonly onKeyDown: (event: KeyboardEvent) => void;
  private readonly moveListeners = new Set<FocusEventListener>();
  private readonly activateListeners = new Set<FocusEventListener>();
  private readonly escapeListeners = new Set<FocusEventListener>();
  private attached = false;
  private suspended = false;

  constructor(options: FocusManagerOptions = {}) {
    this.target = options.target ?? window;
    this.onEscape = options.onEscape;
    this.arrowMode = options.arrowMode ?? "linear";
    this.onKeyDown = (event) => this.handleKeyDown(event);
  }

  attach(): void {
    if (this.attached) return;
    this.target.addEventListener("keydown", this.onKeyDown as EventListener);
    this.attached = true;
  }

  detach(): void {
    if (!this.attached) return;
    this.target.removeEventListener("keydown", this.onKeyDown as EventListener);
    this.attached = false;
  }

  suspend(): void {
    this.suspended = true;
  }

  resume(): void {
    this.suspended = false;
  }

  register(node: Focusable): void {
    if (this.nodes.includes(node)) return;
    this.nodes.push(node);
    if (this.index === -1) {
      this.focusAt(0);
    }
  }

  unregister(node: Focusable): void {
    const at = this.nodes.indexOf(node);
    if (at === -1) return;
    this.nodes.splice(at, 1);
    node.setFocus(false);
    if (this.nodes.length === 0) {
      this.index = -1;
      return;
    }
    if (at <= this.index) {
      this.focusAt(Math.max(0, this.index - 1));
    }
  }

  clear(): void {
    for (const node of this.nodes) node.setFocus(false);
    this.nodes = [];
    this.index = -1;
  }

  focusNext(): void {
    if (this.nodes.length === 0) return;
    this.focusAt((this.index + 1) % this.nodes.length);
  }

  focusPrev(): void {
    if (this.nodes.length === 0) return;
    this.focusAt((this.index - 1 + this.nodes.length) % this.nodes.length);
  }

  /**
   * Focus a previously-registered node by reference. Returns true on
   * success, false if the node isn't registered. Used by callers that
   * need to restore selection across re-renders (e.g. keeping the same
   * hand card focused after a snapshot update).
   */
  focus(node: Focusable): boolean {
    const at = this.nodes.indexOf(node);
    if (at < 0) return false;
    this.focusAt(at);
    return true;
  }

  subscribeMove(listener: FocusEventListener): () => void {
    this.moveListeners.add(listener);
    return () => {
      this.moveListeners.delete(listener);
    };
  }

  subscribeActivate(listener: FocusEventListener): () => void {
    this.activateListeners.add(listener);
    return () => {
      this.activateListeners.delete(listener);
    };
  }

  subscribeEscape(listener: FocusEventListener): () => void {
    this.escapeListeners.add(listener);
    return () => {
      this.escapeListeners.delete(listener);
    };
  }

  private focusAt(next: number): void {
    if (this.index === next) {
      this.nodes[next]?.setFocus(true);
      return;
    }
    const prev = this.index;
    this.nodes[this.index]?.setFocus(false);
    this.index = next;
    this.nodes[next]?.setFocus(true);
    if (prev !== -1) {
      for (const listener of this.moveListeners) listener();
    }
  }

  private handleKeyDown(event: KeyboardEvent): void {
    if (this.suspended) return;
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        this.focusNext();
        return;
      case "ArrowUp":
        event.preventDefault();
        this.focusPrev();
        return;
      case "ArrowRight":
        event.preventDefault();
        if (this.arrowMode === "form") this.stepFocused(1);
        else this.focusNext();
        return;
      case "ArrowLeft":
        event.preventDefault();
        if (this.arrowMode === "form") this.stepFocused(-1);
        else this.focusPrev();
        return;
      case "Tab":
        event.preventDefault();
        if (event.shiftKey) this.focusPrev();
        else this.focusNext();
        return;
      case "Enter":
      case " ":
        if (this.index >= 0) {
          event.preventDefault();
          for (const listener of this.activateListeners) listener();
          this.nodes[this.index]?.activate();
        }
        return;
      case "Escape":
        if (this.onEscape || this.escapeListeners.size > 0) {
          event.preventDefault();
          for (const listener of this.escapeListeners) listener();
          this.onEscape?.();
        }
        return;
    }
  }

  private stepFocused(direction: -1 | 1): void {
    const node = this.nodes[this.index];
    // Fall back to linear nav if the focused node has no step handler —
    // this keeps mixed panels (e.g. a Button next to a Cycle) usable.
    if (node?.step) node.step(direction);
    else if (direction === 1) this.focusNext();
    else this.focusPrev();
  }
}
