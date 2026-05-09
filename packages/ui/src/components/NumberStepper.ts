import { Container, type FederatedPointerEvent, Graphics, Text } from "pixi.js";
import type { Focusable } from "../focus/FocusManager.js";
import { color, radius, stroke, typography } from "../tokens.js";

const DEFAULT_WIDTH = 80;
const DEFAULT_HEIGHT = 18;
const REPEAT_INITIAL_MS = 380;
const REPEAT_INTERVAL_MS = 60;
// Pointer must travel beyond this many pixels before a press is treated as
// a drag-to-scrub instead of a click. Below the threshold we still fall
// through to the increment/decrement step on `pointerup`.
const DRAG_THRESHOLD_PX = 4;
// Pixels of horizontal travel per discrete step. Smaller = faster scrub.
const DRAG_PIXELS_PER_STEP = 4;

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
  private readonly stepSize: number;
  private readonly format: (value: number) => string;
  private readonly onChange: (value: number) => void;
  private value: number;
  private hovered = false;
  private focused = false;
  private repeatTimer: ReturnType<typeof setTimeout> | null = null;
  private repeatInterval: ReturnType<typeof setInterval> | null = null;
  // Drag-to-scrub state. While a press is held we accumulate horizontal
  // pointer movement; once it crosses DRAG_THRESHOLD_PX the press becomes
  // a drag, click-on-release is suppressed, and value steps come from
  // movement instead of the hold-repeat timer.
  private pressDirection: 1 | -1 | 0 = 0;
  private pressStartX = 0;
  private pressStartValue = 0;
  private pressMoved = false;
  private readonly windowMove: (event: PointerEvent) => void;
  private readonly windowUp: () => void;

  constructor(options: NumberStepperOptions) {
    super();
    this.value = options.value;
    this.min = options.min ?? Number.NEGATIVE_INFINITY;
    this.max = options.max ?? Number.POSITIVE_INFINITY;
    this.stepSize = options.step ?? 1;
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
    this.cursor = "ew-resize";
    this.on("pointerover", () => {
      this.hovered = true;
      this.redraw();
    });
    this.on("pointerout", () => {
      this.hovered = false;
      this.redraw();
    });
    this.on("pointerdown", (e: FederatedPointerEvent) => this.beginPress(e));

    // Drag tracking is bound at the window level so the pointer can leave
    // the stepper's hit area mid-drag without losing the gesture. They're
    // installed lazily on each press and torn down on release.
    this.windowMove = (event) => this.handleDragMove(event);
    this.windowUp = () => this.endPress();

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

  /** Focusable.step — left/right arrow handler used by FocusManager form mode. */
  step(direction: -1 | 1): void {
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
    window.removeEventListener("pointermove", this.windowMove);
    window.removeEventListener("pointerup", this.windowUp);
    window.removeEventListener("pointercancel", this.windowUp);
    super.destroy(...args);
  }

  private beginPress(e: FederatedPointerEvent): void {
    const local = this.toLocal(e.global);
    const dir: 1 | -1 = local.x < this.w / 2 ? -1 : 1;
    this.pressDirection = dir;
    this.pressStartX = e.global.x;
    this.pressStartValue = this.value;
    this.pressMoved = false;
    // Hold-to-repeat is armed but only fires if the press becomes a drag
    // never crosses the drag threshold. The actual click-step happens on
    // release once we know whether the user dragged or tapped.
    this.repeatTimer = setTimeout(() => {
      if (!this.pressMoved) {
        this.repeatInterval = setInterval(() => this.applyStep(dir), REPEAT_INTERVAL_MS);
      }
    }, REPEAT_INITIAL_MS);
    window.addEventListener("pointermove", this.windowMove);
    window.addEventListener("pointerup", this.windowUp);
    window.addEventListener("pointercancel", this.windowUp);
  }

  private handleDragMove(event: PointerEvent): void {
    if (this.pressDirection === 0) return;
    const dx = event.clientX - this.pressStartX;
    if (!this.pressMoved && Math.abs(dx) >= DRAG_THRESHOLD_PX) {
      this.pressMoved = true;
      // Once a drag begins, cancel the hold-repeat so it doesn't double up
      // with movement-driven stepping.
      this.cancelRepeat();
    }
    if (!this.pressMoved) return;
    const stepsTravelled = Math.trunc(dx / DRAG_PIXELS_PER_STEP);
    const next = this.pressStartValue + stepsTravelled * this.stepSize;
    this.setValue(next);
  }

  private endPress(): void {
    window.removeEventListener("pointermove", this.windowMove);
    window.removeEventListener("pointerup", this.windowUp);
    window.removeEventListener("pointercancel", this.windowUp);
    const wasDrag = this.pressMoved;
    const dir = this.pressDirection;
    this.cancelRepeat();
    this.pressDirection = 0;
    this.pressMoved = false;
    // Tap-without-drag: fire the increment/decrement step once. Drag
    // releases already settled on a value, no follow-up step needed.
    if (!wasDrag && dir !== 0) this.applyStep(dir);
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
    const next = Math.max(this.min, Math.min(this.max, this.value + direction * this.stepSize));
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
