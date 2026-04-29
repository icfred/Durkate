import { color, spacing, stroke, typography } from "@durak/ui";
import { Container, type FederatedPointerEvent, Graphics, Text } from "pixi.js";

const ROW_HEIGHT = 36;

export interface SliderOptions {
  label: string;
  width: number;
  min: number;
  max: number;
  initial: number;
  step?: number;
  format?(value: number): string;
  onChange(value: number): void;
}

export class Slider extends Container {
  private readonly track: Graphics;
  private readonly handle: Graphics;
  private readonly labelText: Text;
  private readonly valueText: Text;
  private readonly trackWidth: number;
  private readonly trackY: number;
  private readonly trackX: number;
  private readonly min: number;
  private readonly max: number;
  private readonly step: number;
  private readonly format: (value: number) => string;
  private readonly onChange: (value: number) => void;
  private value: number;
  private dragging = false;

  constructor(options: SliderOptions) {
    super();
    this.min = options.min;
    this.max = options.max;
    this.value = options.initial;
    this.step = options.step ?? 0;
    this.format = options.format ?? ((v) => v.toFixed(2));
    this.onChange = options.onChange;

    this.labelText = new Text({
      text: options.label,
      style: {
        fontFamily: typography.family,
        fontSize: typography.size.xs,
        fontWeight: typography.weight.bold,
        fill: color.textMuted,
        letterSpacing: typography.letterSpacing.wide,
      },
    });
    this.labelText.x = 0;
    this.labelText.y = 0;
    this.addChild(this.labelText);

    this.valueText = new Text({
      text: this.format(this.value),
      style: {
        fontFamily: typography.family,
        fontSize: typography.size.xs,
        fill: color.text,
        letterSpacing: typography.letterSpacing.tight,
      },
    });
    this.addChild(this.valueText);

    const valueWidth = 56;
    this.trackX = 0;
    this.trackY = 18;
    this.trackWidth = options.width - valueWidth - spacing.sm;

    this.track = new Graphics();
    this.track.x = this.trackX;
    this.track.y = this.trackY;
    this.addChild(this.track);

    this.handle = new Graphics();
    this.handle.y = this.trackY;
    this.handle.eventMode = "static";
    this.handle.cursor = "ew-resize";
    this.addChild(this.handle);

    this.track.eventMode = "static";
    this.track.cursor = "ew-resize";
    this.track.on("pointerdown", (e) => this.startDragAt(e));

    this.handle.on("pointerdown", (e) => {
      e.stopPropagation();
      this.dragging = true;
      this.handle.cursor = "grabbing";
    });

    this.on("globalpointermove", (e) => {
      if (!this.dragging) return;
      this.applyFromPointer(e);
    });

    const release = (): void => {
      if (!this.dragging) return;
      this.dragging = false;
      this.handle.cursor = "ew-resize";
    };
    this.on("pointerup", release);
    this.on("pointerupoutside", release);

    this.valueText.x = this.trackX + this.trackWidth + spacing.sm;
    this.valueText.y = this.trackY - 6;

    this.redraw();
  }

  set(value: number): void {
    const clamped = this.snap(value);
    if (clamped === this.value) return;
    this.value = clamped;
    this.redraw();
  }

  setSilently(value: number): void {
    const clamped = this.snap(value);
    this.value = clamped;
    this.redraw();
  }

  private startDragAt(event: FederatedPointerEvent): void {
    this.dragging = true;
    this.handle.cursor = "grabbing";
    this.applyFromPointer(event);
  }

  private applyFromPointer(event: FederatedPointerEvent): void {
    const local = this.toLocal(event.global);
    const t = clamp01((local.x - this.trackX) / this.trackWidth);
    const newValue = this.snap(this.min + t * (this.max - this.min));
    if (newValue === this.value) {
      this.redraw();
      return;
    }
    this.value = newValue;
    this.redraw();
    this.onChange(newValue);
  }

  private snap(v: number): number {
    const clamped = Math.min(this.max, Math.max(this.min, v));
    if (this.step <= 0) return clamped;
    const steps = Math.round((clamped - this.min) / this.step);
    return this.min + steps * this.step;
  }

  private redraw(): void {
    const t = (this.value - this.min) / (this.max - this.min);
    const handleX = this.trackX + t * this.trackWidth;

    this.track
      .clear()
      .roundRect(0, 6, this.trackWidth, 4, 2)
      .fill({ color: color.bgSunken })
      .stroke({ color: color.border, width: 1, alignment: 0 });

    this.track.roundRect(0, 6, t * this.trackWidth, 4, 2).fill({ color: color.accent });

    this.handle
      .clear()
      .roundRect(handleX - 5, 2, 10, 12, 2)
      .fill({ color: color.surfaceFocus })
      .stroke({ color: color.borderFocus, width: stroke.base, alignment: 0 });
    this.handle.x = 0;

    this.valueText.text = this.format(this.value);
  }

  static height(): number {
    return ROW_HEIGHT;
  }
}

export interface CycleOptions<T extends string> {
  label: string;
  width: number;
  options: readonly T[];
  initial: T;
  onChange(value: T): void;
}

export class Cycle<T extends string> extends Container {
  private readonly bg: Graphics;
  private readonly labelText: Text;
  private readonly valueText: Text;
  private readonly options: readonly T[];
  private readonly w: number;
  private readonly h = 24;
  private readonly onChange: (value: T) => void;
  private current: T;
  private hovered = false;

  constructor(options: CycleOptions<T>) {
    super();
    this.options = options.options;
    this.current = options.initial;
    this.onChange = options.onChange;
    this.w = options.width;

    this.labelText = new Text({
      text: options.label,
      style: {
        fontFamily: typography.family,
        fontSize: typography.size.xs,
        fontWeight: typography.weight.bold,
        fill: color.textMuted,
        letterSpacing: typography.letterSpacing.wide,
      },
    });
    this.addChild(this.labelText);

    this.bg = new Graphics();
    this.bg.y = 14;
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
    this.valueText.y = 14 + Math.round((this.h - this.valueText.height) / 2);
  }

  static height(): number {
    return ROW_HEIGHT;
  }
}

function clamp01(v: number): number {
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}
