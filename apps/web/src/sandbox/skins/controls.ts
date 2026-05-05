import { color, spacing, stroke, typography } from "@durak/ui";
import { Container, type FederatedPointerEvent, Graphics, Text } from "pixi.js";

const ROW_HEIGHT = 24;
const INPUT_WIDTH = 64;
const INPUT_HEIGHT = 18;

// ─── NumberRow ────────────────────────────────────────────────────────────
//
// A label + numeric input pair on one row. The input is a real
// <input type="number"> overlaid via getBoundingClientRect on the canvas;
// it carries its own rendering (caret, spinner, focus) so we don't have
// to reinvent text editing inside Pixi. Sliders are gone — for parameter
// tuning, typed values are unambiguous and faster than drag-to-search.

export interface NumberRowOptions {
  label: string;
  width: number;
  initial: number;
  min?: number;
  max?: number;
  step?: number;
  format?(v: number): string;
  onChange(v: number): void;
}

export class NumberRow extends Container {
  private readonly labelText: Text;
  private readonly box: Graphics;
  private readonly htmlInput: HTMLInputElement;
  private readonly format: (v: number) => string;
  private readonly onChangeCb: (v: number) => void;
  private currentValue: number;
  private domDestroyed = false;

  constructor(opts: NumberRowOptions) {
    super();
    this.format = opts.format ?? ((v) => v.toFixed(2));
    this.onChangeCb = opts.onChange;
    this.currentValue = opts.initial;

    this.labelText = new Text({
      text: opts.label,
      style: {
        fontFamily: typography.family,
        fontSize: typography.size.xs,
        fontWeight: typography.weight.bold,
        fill: color.textMuted,
        letterSpacing: typography.letterSpacing.wide,
      },
    });
    this.labelText.x = 0;
    this.labelText.y = Math.round((ROW_HEIGHT - this.labelText.height) / 2);
    this.addChild(this.labelText);

    this.box = new Graphics();
    this.box.x = opts.width - INPUT_WIDTH;
    this.box.y = Math.round((ROW_HEIGHT - INPUT_HEIGHT) / 2);
    this.box
      .roundRect(0, 0, INPUT_WIDTH, INPUT_HEIGHT, 2)
      .fill({ color: color.bgSunken })
      .stroke({ color: color.border, width: 1, alignment: 0 });
    this.addChild(this.box);

    this.htmlInput = document.createElement("input");
    this.htmlInput.type = "number";
    this.htmlInput.value = this.format(opts.initial);
    if (opts.min !== undefined) this.htmlInput.min = String(opts.min);
    if (opts.max !== undefined) this.htmlInput.max = String(opts.max);
    if (opts.step !== undefined) this.htmlInput.step = String(opts.step);
    Object.assign(this.htmlInput.style, {
      position: "absolute",
      fontFamily: '"JetBrains Mono", monospace',
      fontSize: "11px",
      fontWeight: "700",
      color: "#f3eddc",
      background: "transparent",
      border: "none",
      outline: "none",
      padding: "0 6px",
      textAlign: "right",
      display: "none",
      zIndex: "100",
      boxSizing: "border-box",
    } satisfies Partial<CSSStyleDeclaration>);
    document.body.appendChild(this.htmlInput);

    const apply = (): void => {
      const v = Number.parseFloat(this.htmlInput.value);
      if (!Number.isFinite(v)) return;
      this.currentValue = v;
      this.onChangeCb(v);
    };
    this.htmlInput.addEventListener("input", apply);
    this.htmlInput.addEventListener("change", apply);
  }

  /**
   * Sync the HTML input's page coords from the box's Pixi global position.
   * Pass the canvas (so we can convert global → page) and the visible
   * panel mask range (in page coords) so rows scrolled out of view hide
   * their input rather than floating in the wrong place.
   */
  syncDom(canvas: HTMLCanvasElement, clipTop: number, clipBottom: number): void {
    if (this.domDestroyed) return;
    const tl = this.box.toGlobal({ x: 0, y: 0 });
    const rect = canvas.getBoundingClientRect();
    const pageX = rect.left + tl.x;
    const pageY = rect.top + tl.y;
    if (pageY + INPUT_HEIGHT < clipTop || pageY > clipBottom) {
      this.htmlInput.style.display = "none";
      return;
    }
    Object.assign(this.htmlInput.style, {
      display: "block",
      left: `${pageX}px`,
      top: `${pageY}px`,
      width: `${INPUT_WIDTH}px`,
      height: `${INPUT_HEIGHT}px`,
    } satisfies Partial<CSSStyleDeclaration>);
  }

  /** Update displayed value without firing onChange (avoids editing loops). */
  setValue(v: number): void {
    if (document.activeElement === this.htmlInput) return;
    this.currentValue = v;
    this.htmlInput.value = this.format(v);
  }

  getValue(): number {
    return this.currentValue;
  }

  destroyDom(): void {
    if (this.domDestroyed) return;
    this.domDestroyed = true;
    this.htmlInput.remove();
  }

  static height(): number {
    return ROW_HEIGHT;
  }
}

// ─── Cycle ─────────────────────────────────────────────────────────────────
//
// Cycle is a label-less < value > picker. The previous internal label was
// redundant with the section header. The screen places its own row label
// next to the cycle, matching the NumberRow layout.

export interface CycleOptions<T extends string> {
  width: number;
  options: readonly T[];
  initial: T;
  onChange(value: T): void;
}

export class Cycle<T extends string> extends Container {
  private readonly bg: Graphics;
  private readonly valueText: Text;
  private readonly options: readonly T[];
  private readonly w: number;
  private readonly h = INPUT_HEIGHT;
  private readonly onChange: (value: T) => void;
  private current: T;
  private hovered = false;

  constructor(options: CycleOptions<T>) {
    super();
    this.options = options.options;
    this.current = options.initial;
    this.onChange = options.onChange;
    this.w = options.width;

    this.bg = new Graphics();
    this.addChild(this.bg);

    this.valueText = new Text({
      text: options.initial.toUpperCase(),
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
      const half = this.w / 2;
      const dir = local.x < half ? -1 : 1;
      this.advance(dir);
    });

    this.redraw();
  }

  set(value: T): void {
    if (value === this.current) return;
    this.current = value;
    this.redraw();
  }

  setSilently(value: T): void {
    this.current = value;
    this.redraw();
  }

  private advance(dir: number): void {
    const idx = this.options.indexOf(this.current);
    const next = (idx + dir + this.options.length) % this.options.length;
    const value = this.options[next];
    if (!value) return;
    this.current = value;
    this.redraw();
    this.onChange(value);
  }

  private redraw(): void {
    const fill = this.hovered ? color.surfaceFocus : color.surface;
    const border = this.hovered ? color.borderFocus : color.border;
    this.bg
      .clear()
      .roundRect(0, 0, this.w, this.h, 2)
      .fill({ color: fill })
      .stroke({ color: border, width: stroke.base, alignment: 0 });
    this.valueText.text = `< ${this.current.toUpperCase()} >`;
    this.valueText.x = Math.round((this.w - this.valueText.width) / 2);
    this.valueText.y = Math.round((this.h - this.valueText.height) / 2);
  }

  static height(): number {
    return ROW_HEIGHT;
  }
}

// Suppress used-import warning for spacing in case future rows reference it.
void spacing;
