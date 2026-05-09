import { Container, type FederatedPointerEvent, Graphics, Text } from "pixi.js";
import type { Focusable } from "../focus/FocusManager.js";
import { color, radius, stroke, typography } from "../tokens.js";

const DEFAULT_WIDTH = 80;
const DEFAULT_HEIGHT = 18;
const REPEAT_INITIAL_MS = 380;
const REPEAT_INTERVAL_MS = 60;

export interface NumberStepperOptions {
  /** Initial value. */
  value: number;
  /** Inclusive lower bound. Defaults to `-Infinity`. */
  min?: number;
  /** Inclusive upper bound. Defaults to `+Infinity`. */
  max?: number;
  /** Step amount per click / key press. Defaults to 1. */
  step?: number;
  /** Display formatter. Defaults to `value.toFixed(2)`. */
  format?(value: number): string;
  /** Fires after every step / setValue (unless `silent`). */
  onChange(value: number): void;
  /** Override width. Default {@link DEFAULT_WIDTH}. */
  width?: number;
  /** Override height. Default {@link DEFAULT_HEIGHT}. */
  height?: number;
}

/**
 * Pixi-native numeric stepper. Click the left half to decrement, right
 * half to increment; hold to repeat. ArrowDown / ArrowUp do the same when
 * focused. No HTML overlay — keeps the panel mask-clipping clean and the
 * visual style consistent with the rest of the form.
 */
export class NumberStepper extends Container implements Focusable {
  private readonly bg: Graphics;
  private readonly valueText: Text;
  private readonly hintText: Text;
  private readonly w: number;
  private readonly h: number;
  private readonly min: number;
  private readonly max: number;
  private readonly step: number;
  private readonly format: (value: number) => string;
  private readonly onChange: (value: number) => void;
  private value: number;
  private hovered = false;
  private focused = false;
  private repeatTimer: ReturnType<typeof setTimeout> | null = null;
  private repeatInterval: ReturnType<typeof setInterval> | null = null;

  constructor(options: NumberStepperOptions) {
    super();
    this.value = options.value;
    this.min = options.min ?? Number.NEGATIVE_INFINITY;
    this.max = options.max ?? Number.POSITIVE_INFINITY;
    this.step = options.step ?? 1;
    this.format = options.format ?? ((v) => v.toFixed(2));
    this.onChange = options.onChange;
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
    // Tiny "− +" hint text on the right edge so the user reads the
    // direction of clicks without having to discover by trial.
    this.hintText = new Text({
      text: "− +",
      style: {
        fontFamily: typography.family,
        fontSize: typography.size.xs,
        fill: color.textMuted,
        letterSpacing: typography.letterSpacing.tight,
      },
    });
    this.addChild(this.hintText);

    this.eventMode = "static";
    this.cursor = "pointer";
    this.on("pointerover", () => {
      this.hovered = true;
      this.redraw();
    });
    this.on("pointerout", () => {
      this.hovered = false;
      this.cancelRepeat();
      this.redraw();
    });
    this.on("pointerdown", (e: FederatedPointerEvent) => this.beginPress(e));
    this.on("pointerup", () => this.cancelRepeat());
    this.on("pointerupoutside", () => this.cancelRepeat());

    this.redraw();
  }

  setFocus(focused: boolean): void {
    if (this.focused === focused) return;
    this.focused = focused;
    this.redraw();
  }

  /** Keyboard activate — increments by one step. */
  activate(): void {
    this.applyStep(1);
  }

  /** ArrowUp / ArrowDown forwarder. Caller wires its own keymap. */
  stepBy(direction: -1 | 1): void {
    this.applyStep(direction);
  }

  /** Programmatic update. `silent` skips `onChange`. */
  setValue(value: number, silent = false): void {
    const clamped = Math.max(this.min, Math.min(this.max, value));
    if (clamped === this.value) {
      if (!silent) this.redraw();
      return;
    }
    this.value = clamped;
    this.redraw();
    if (!silent) this.onChange(this.value);
  }

  override destroy(...args: Parameters<Container["destroy"]>): void {
    this.cancelRepeat();
    super.destroy(...args);
  }

  private beginPress(e: FederatedPointerEvent): void {
    const local = this.toLocal(e.global);
    const dir: 1 | -1 = local.x < this.w / 2 ? -1 : 1;
    this.applyStep(dir);
    // Hold-to-repeat: an initial pause prevents accidental double-stepping
    // on a quick tap, then the interval fires until release.
    this.repeatTimer = setTimeout(() => {
      this.repeatInterval = setInterval(() => this.applyStep(dir), REPEAT_INTERVAL_MS);
    }, REPEAT_INITIAL_MS);
  }

  private cancelRepeat(): void {
    if (this.repeatTimer !== null) {
      clearTimeout(this.repeatTimer);
      this.repeatTimer = null;
    }
    if (this.repeatInterval !== null) {
      clearInterval(this.repeatInterval);
      this.repeatInterval = null;
    }
  }

  private applyStep(direction: 1 | -1): void {
    const next = Math.max(this.min, Math.min(this.max, this.value + direction * this.step));
    if (next === this.value) return;
    this.value = next;
    this.redraw();
    this.onChange(this.value);
  }

  private redraw(): void {
    const ringed = this.hovered || this.focused;
    const fill = ringed ? color.surfaceFocus : color.bgSunken;
    const border = ringed ? color.borderFocus : color.border;
    this.bg
      .clear()
      .roundRect(0, 0, this.w, this.h, radius.sm)
      .fill({ color: fill })
      .stroke({ color: border, width: stroke.base, alignment: 0 });
    this.valueText.text = this.format(this.value);
    this.valueText.x = 6;
    this.valueText.y = Math.round((this.h - this.valueText.height) / 2);
    this.hintText.x = this.w - this.hintText.width - 6;
    this.hintText.y = Math.round((this.h - this.hintText.height) / 2);
  }
}
