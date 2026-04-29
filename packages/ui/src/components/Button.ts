import { Container, Graphics, Text } from "pixi.js";
import type { Focusable } from "../focus/FocusManager.js";
import { color, radius, spacing, stroke, typography } from "../tokens.js";

export interface ButtonOptions {
  label: string;
  width?: number;
  height?: number;
  onActivate?: () => void;
}

export class Button extends Container implements Focusable {
  private readonly bg: Graphics;
  private readonly text: Text;
  private w: number;
  private h: number;
  private focused = false;
  private hovered = false;
  private pressed = false;
  private onActivate: (() => void) | undefined;

  constructor(options: ButtonOptions) {
    super();
    this.onActivate = options.onActivate;
    this.text = new Text({
      text: options.label,
      style: {
        fontFamily: typography.family,
        fontSize: typography.size.md,
        fontWeight: typography.weight.bold,
        fill: color.text,
        letterSpacing: typography.letterSpacing.wide,
      },
    });
    this.w = options.width ?? Math.max(160, Math.ceil(this.text.width) + spacing.lg * 2);
    this.h = options.height ?? this.text.height + spacing.md * 2;

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
      this.pressed = false;
      this.redraw();
    });
    this.on("pointerdown", () => {
      this.pressed = true;
      this.redraw();
    });
    this.on("pointerup", () => {
      const wasPressed = this.pressed;
      this.pressed = false;
      this.redraw();
      if (wasPressed) this.activate();
    });
    this.on("pointerupoutside", () => {
      this.pressed = false;
      this.redraw();
    });

    this.redraw();
  }

  setFocus(focused: boolean): void {
    if (this.focused === focused) return;
    this.focused = focused;
    this.redraw();
  }

  activate(): void {
    this.onActivate?.();
  }

  setLabel(text: string): void {
    this.text.text = text;
    this.redraw();
  }

  private redraw(): void {
    const active = this.focused || this.hovered;
    const fill = this.pressed || active ? color.surfaceFocus : color.surface;
    const border = active ? color.borderFocus : color.border;
    const borderWidth = active ? stroke.thick : stroke.base;

    this.bg
      .clear()
      .roundRect(0, 0, this.w, this.h, radius.sm)
      .fill({ color: fill })
      .stroke({ color: border, width: borderWidth, alignment: 0 });

    this.text.x = Math.round((this.w - this.text.width) / 2);
    this.text.y = Math.round((this.h - this.text.height) / 2) + (this.pressed ? 1 : 0);
  }
}
