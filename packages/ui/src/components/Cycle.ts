import { Container, type FederatedPointerEvent, Graphics, Text } from "pixi.js";
import type { Focusable } from "../focus/FocusManager.js";
import { color, radius, stroke, typography } from "../tokens.js";

const DEFAULT_WIDTH = 140;
const DEFAULT_HEIGHT = 18;

export interface CycleOptions<T> {
  /** The full set of values the cycle rotates through. Order matters. */
  values: readonly T[];
  /** Initial value. Must appear in `values`. */
  value: T;
  /** Fires after a click / arrow / setValue advances. */
  onChange(value: T): void;
  /** Display formatter. Defaults to `String(v).toUpperCase()`. */
  format?(value: T): string;
  /** When true, append a `(N/M)` position indicator after the value. */
  showIndex?: boolean;
  /** Override width. Default {@link DEFAULT_WIDTH}. */
  width?: number;
  /** Override height. Default {@link DEFAULT_HEIGHT}. */
  height?: number;
}

/**
 * `< VALUE >` picker. Click the left half to step backward, right half
 * forward. ArrowLeft / ArrowRight do the same when focused. Wraps around
 * the value list both ways.
 */
export class Cycle<T> extends Container implements Focusable {
  private readonly bg: Graphics;
  private readonly valueText: Text;
  private readonly values: readonly T[];
  private readonly w: number;
  private readonly h: number;
  private readonly format: (value: T) => string;
  private readonly showIndex: boolean;
  private readonly onChange: (value: T) => void;
  private current: T;
  private hovered = false;
  private focused = false;

  constructor(options: CycleOptions<T>) {
    super();
    this.values = options.values;
    this.current = options.value;
    this.onChange = options.onChange;
    this.format = options.format ?? ((v) => String(v).toUpperCase());
    this.showIndex = options.showIndex ?? false;
    this.w = options.width ?? DEFAULT_WIDTH;
    this.h = options.height ?? DEFAULT_HEIGHT;

    this.bg = new Graphics();
    this.addChild(this.bg);
    this.valueText = new Text({
      text: "",
      style: {
        fontFamily: typography.family,
        fontSize: typography.size.xs,
        fontWeight: typography.weight.bold,
        fill: color.text,
        letterSpacing: typography.letterSpacing.wide,
      },
    });
    this.addChild(this.valueText);

    this.eventMode = "static";
    this.cursor = "pointer";
    this.on("pointerover", () => {
      this.hovered = true;
      this.redraw();
    });
    this.on("pointerout", () => {
      this.hovered = false;
      this.redraw();
    });
    this.on("pointertap", (e: FederatedPointerEvent) => {
      const local = this.toLocal(e.global);
      const dir = local.x < this.w / 2 ? -1 : 1;
      this.advance(dir);
    });

    this.redraw();
  }

  setFocus(focused: boolean): void {
    if (this.focused === focused) return;
    this.focused = focused;
    this.redraw();
  }

  /** Activate by keyboard — advances forward. */
  activate(): void {
    this.advance(1);
  }

  /** Step value programmatically. Fires `onChange` unless `silent`. */
  setValue(value: T, silent = false): void {
    this.current = value;
    this.redraw();
    if (!silent) this.onChange(value);
  }

  /** ArrowLeft / ArrowRight forwarder. Caller wires its own keymap. */
  step(direction: -1 | 1): void {
    this.advance(direction);
  }

  private advance(direction: number): void {
    const idx = this.values.indexOf(this.current);
    const next = (idx + direction + this.values.length) % this.values.length;
    const value = this.values[next];
    if (value === undefined) return;
    this.current = value;
    this.redraw();
    this.onChange(value);
  }

  private redraw(): void {
    const ringed = this.hovered || this.focused;
    const fill = ringed ? color.surfaceFocus : color.surface;
    const border = ringed ? color.borderFocus : color.border;
    this.bg
      .clear()
      .roundRect(0, 0, this.w, this.h, radius.sm)
      .fill({ color: fill })
      .stroke({ color: border, width: stroke.base, alignment: 0 });
    let label = this.format(this.current);
    if (this.showIndex) {
      const idx = this.values.indexOf(this.current);
      label = `${label}  ${idx + 1}/${this.values.length}`;
    }
    this.valueText.text = `< ${label} >`;
    this.valueText.x = Math.round((this.w - this.valueText.width) / 2);
    this.valueText.y = Math.round((this.h - this.valueText.height) / 2);
  }
}
