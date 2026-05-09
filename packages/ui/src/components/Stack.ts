import { Container } from "pixi.js";
import { spacing } from "../tokens.js";

export type StackDirection = "vertical" | "horizontal";

export interface StackOptions {
  /** Layout axis. `vertical` stacks top-to-bottom, `horizontal` left-to-right. */
  direction: StackDirection;
  /** Gap between children. Defaults to `spacing.xs`. */
  gap?: number;
}

/**
 * Auto-layout container that places its children in a single column or row
 * with consistent spacing. Each `add()` immediately positions the child at
 * the next slot — call sites stop having to track running `y +=` cursors.
 *
 * Children are positioned at construction time based on their then-current
 * size; if a child resizes later, call `relayout()` to reflow.
 */
export class Stack extends Container {
  private readonly direction: StackDirection;
  private readonly gap: number;
  private readonly items: Container[] = [];

  constructor(options: StackOptions) {
    super();
    this.direction = options.direction;
    this.gap = options.gap ?? spacing.xs;
  }

  /** Append a child and position it at the next slot. Returns the stack. */
  add(child: Container): this {
    this.items.push(child);
    this.addChild(child);
    this.placeAt(this.items.length - 1);
    return this;
  }

  /** Re-flow every child from scratch — useful after a child resized. */
  relayout(): void {
    for (let i = 0; i < this.items.length; i++) this.placeAt(i);
  }

  private placeAt(index: number): void {
    const item = this.items[index];
    if (!item) return;
    if (index === 0) {
      item.x = 0;
      item.y = 0;
      return;
    }
    const prev = this.items[index - 1];
    if (!prev) return;
    if (this.direction === "vertical") {
      item.x = 0;
      item.y = prev.y + prev.height + this.gap;
    } else {
      item.x = prev.x + prev.width + this.gap;
      item.y = 0;
    }
  }
}
