import { Container, Graphics, Text } from "pixi.js";
import type { Focusable } from "../focus/FocusManager.js";
import { color, radius, spacing, stroke, typography } from "../tokens.js";

const DEFAULT_HEIGHT = 24;

export interface ToggleChipOptions {
  label: string;
  active: boolean;
  onChange(active: boolean): void;
  /** Override width. Defaults to label width + padding. */
  width?: number;
  /** Override height. Defaults to {@link DEFAULT_HEIGHT}. */
  height?: number;
}

/**
 * On/off pill. Compact, label-only. Use to gate a section or to bundle
 * a small set of mutually-independent flags inline (e.g. axis selectors).
 * For form-level boolean fields prefer a {@link Cycle} of "ON" / "OFF",
 * which lines up with the rest of a settings stack.
 */
export class ToggleChip extends Container implements Focusable {
  private readonly bg: Graphics;
  private readonly text: Text;
  private active: boolean;
  private hovered = false;
  private focused = false;
  private readonly w: number;
  private readonly h: number;
  private readonly onChange: (active: boolean) => void;

  constructor(options: ToggleChipOptions) {
    super();
    this.active = options.active;
    this.onChange = options.onChange;
    this.h = options.height ?? DEFAULT_HEIGHT;
    this.text = new Text({
      text: options.label,
      style: {
        fontFamily: typography.family,
        fontSize: typography.size.xs,
        fontWeight: typography.weight.bold,
        fill: color.text,
        letterSpacing: typography.letterSpacing.wide,
      },
    });
    this.w = options.width ?? Math.max(72, Math.ceil(this.text.width) + spacing.md * 2);

    this.bg = new Graphics();
    this.addChild(this.bg);
    this.addChild(this.text);

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
    this.on("pointertap", () => this.activate());
    this.redraw();
  }

  setFocus(focused: boolean): void {
    if (this.focused === focused) return;
    this.focused = focused;
    this.redraw();
  }

  activate(): void {
    this.active = !this.active;
    this.redraw();
    this.onChange(this.active);
  }

  /** Focusable.step — left or right arrow flips the toggle either way. */
  step(_direction: -1 | 1): void {
    this.activate();
  }

  setActive(active: boolean): void {
    if (this.active === active) return;
    this.active = active;
    this.redraw();
  }

  private redraw(): void {
    const ringed = this.focused || this.hovered || this.active;
    const fill = this.active ? color.surfaceFocus : color.bgSunken;
    const border = ringed ? color.borderFocus : color.border;
    this.bg
      .clear()
      .roundRect(0, 0, this.w, this.h, radius.sm)
      .fill({ color: fill })
      .stroke({ color: border, width: stroke.base, alignment: 0 });
    this.text.x = Math.round((this.w - this.text.width) / 2);
    this.text.y = Math.round((this.h - this.text.height) / 2);
  }
}
