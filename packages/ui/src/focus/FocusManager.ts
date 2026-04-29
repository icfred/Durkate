export interface Focusable {
  setFocus(focused: boolean): void;
  activate(): void;
}

export interface FocusManagerOptions {
  onEscape?: () => void;
  target?: Window | HTMLElement;
}

export class FocusManager {
  private nodes: Focusable[] = [];
  private index = -1;
  private readonly target: Window | HTMLElement;
  private readonly onEscape: (() => void) | undefined;
  private readonly onKeyDown: (event: KeyboardEvent) => void;
  private attached = false;

  constructor(options: FocusManagerOptions = {}) {
    this.target = options.target ?? window;
    this.onEscape = options.onEscape;
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

  private focusAt(next: number): void {
    if (this.index === next) {
      this.nodes[next]?.setFocus(true);
      return;
    }
    this.nodes[this.index]?.setFocus(false);
    this.index = next;
    this.nodes[next]?.setFocus(true);
  }

  private handleKeyDown(event: KeyboardEvent): void {
    switch (event.key) {
      case "ArrowDown":
      case "ArrowRight":
        event.preventDefault();
        this.focusNext();
        return;
      case "ArrowUp":
      case "ArrowLeft":
        event.preventDefault();
        this.focusPrev();
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
          this.nodes[this.index]?.activate();
        }
        return;
      case "Escape":
        if (this.onEscape) {
          event.preventDefault();
          this.onEscape();
        }
        return;
    }
  }
}
