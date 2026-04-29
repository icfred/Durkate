import {
  type Axes,
  CARD_HEIGHT,
  CARD_WIDTH,
  decode,
  defaultTunables,
  type Finish,
  type Motion,
  PATTERN_VARIANTS,
  rollCode,
  type SkinAssets,
  SkinCard,
  type SkinSpec,
  type Tunables,
} from "@durak/skins-spike";
import { Button, color, Panel, spacing, stroke, typography } from "@durak/ui";
import { Container, Graphics, Text, type Ticker, type TickerCallback } from "pixi.js";
import type { Screen } from "../../screens/types.js";
import { Cycle, Slider } from "./controls.js";

const PANEL_WIDTH = 380;
const PREVIEW_SCALE = 4;
const FINISHES: readonly Finish[] = ["matte", "foil", "chrome", "holographic"];
const MOTIONS: readonly Motion[] = ["none", "shimmer", "pulse", "drift"];

interface SectionLayoutOpts {
  panel: Container;
  y: { value: number };
  label: string;
}

function sectionHeader({ panel, y, label }: SectionLayoutOpts): void {
  const t = new Text({
    text: label,
    style: {
      fontFamily: typography.family,
      fontSize: typography.size.sm,
      fontWeight: typography.weight.bold,
      fill: color.accent,
      letterSpacing: typography.letterSpacing.stamp,
    },
  });
  t.x = spacing.lg;
  t.y = y.value;
  panel.addChild(t);
  y.value += t.height + spacing.sm;
}

export interface SkinTunerScreenOptions {
  assets: SkinAssets;
  ticker: Ticker;
}

export class SkinTunerScreen extends Container implements Screen {
  private readonly ticker: Ticker;
  private readonly assets: SkinAssets;
  private readonly card: SkinCard;
  private readonly preview: Container;
  private readonly panel: Panel;
  private readonly panelInner: Container;
  private readonly codeText: Text;
  private readonly tickCallback: TickerCallback<unknown>;
  private spec: SkinSpec = decode("000000000000");
  private axes: Axes = { pattern: true, tint: true, finish: true, motion: true };
  private tunables: Tunables = cloneTunables(defaultTunables);
  private code = "000000000000";
  private rngState = 0xc0ffee;

  constructor(options: SkinTunerScreenOptions) {
    super();
    this.ticker = options.ticker;
    this.assets = options.assets;

    this.panel = new Panel({ width: PANEL_WIDTH, height: 980 });
    this.addChild(this.panel);
    this.panelInner = new Container();
    this.panel.addChild(this.panelInner);

    this.preview = new Container();
    this.addChild(this.preview);

    this.card = new SkinCard(this.assets);
    this.card.scale.set(PREVIEW_SCALE);
    this.preview.addChild(this.card);

    this.codeText = new Text({
      text: this.code,
      style: {
        fontFamily: typography.family,
        fontSize: typography.size.lg,
        fontWeight: typography.weight.bold,
        fill: color.text,
        letterSpacing: typography.letterSpacing.wide,
      },
    });

    this.buildPanel();
    this.applyAll();

    this.tickCallback = (t) => this.onTick(t);
    this.ticker.add(this.tickCallback);

    this.spec = decode(this.code);
    this.applyAll();
  }

  layout(viewWidth: number, viewHeight: number): void {
    this.panel.x = spacing.md;
    this.panel.y = spacing.md;
    const previewW = CARD_WIDTH * PREVIEW_SCALE;
    const previewH = CARD_HEIGHT * PREVIEW_SCALE;
    const availableX = viewWidth - PANEL_WIDTH - spacing.md * 2;
    this.preview.x = Math.round(spacing.md + PANEL_WIDTH + (availableX - previewW) / 2);
    this.preview.y = Math.round((viewHeight - previewH) / 2);
  }

  dispose(): void {
    this.ticker.remove(this.tickCallback);
  }

  private buildPanel(): void {
    const sliderWidth = PANEL_WIDTH - spacing.lg * 2;
    const cycleWidth = PANEL_WIDTH - spacing.lg * 2;
    const y = { value: spacing.md };
    const panel = this.panelInner;

    const title = new Text({
      text: "SKIN TUNER",
      style: {
        fontFamily: typography.family,
        fontSize: typography.size.lg,
        fontWeight: typography.weight.bold,
        fill: color.text,
        letterSpacing: typography.letterSpacing.stamp,
      },
    });
    title.x = spacing.lg;
    title.y = y.value;
    panel.addChild(title);
    y.value += title.height + spacing.xs;

    this.codeText.x = spacing.lg;
    this.codeText.y = y.value;
    panel.addChild(this.codeText);
    y.value += this.codeText.height + spacing.sm;

    const rollBtn = new Button({
      label: "ROLL RANDOM CODE",
      width: cycleWidth,
      height: 30,
      onActivate: () => this.rollNewCode(),
    });
    rollBtn.x = spacing.lg;
    rollBtn.y = y.value;
    panel.addChild(rollBtn);
    y.value += 30 + spacing.sm;

    const resetBtn = new Button({
      label: "RESET TUNABLES",
      width: cycleWidth,
      height: 26,
      onActivate: () => this.resetTunables(),
    });
    resetBtn.x = spacing.lg;
    resetBtn.y = y.value;
    panel.addChild(resetBtn);
    y.value += 26 + spacing.md;

    sectionHeader({ panel, y, label: "AXES" });
    const axisRow = new Container();
    axisRow.x = spacing.lg;
    axisRow.y = y.value;
    panel.addChild(axisRow);
    let xOff = 0;
    const axisKeys: ReadonlyArray<keyof Axes> = ["pattern", "tint", "finish", "motion"];
    for (const key of axisKeys) {
      const chip = new AxisChip({
        label: String(key).toUpperCase(),
        initial: this.axes[key],
        onChange: (active) => {
          this.axes[key] = active;
          this.applyAll();
        },
      });
      chip.x = xOff;
      axisRow.addChild(chip);
      xOff += chip.chipWidth + spacing.xs;
    }
    y.value += 28 + spacing.md;

    sectionHeader({ panel, y, label: "PATTERN" });
    const patternIndexLabels = Array.from({ length: PATTERN_VARIANTS }, (_, i) => `P${i}`);
    const patternIndexCycle = new Cycle({
      label: "PATTERN",
      width: cycleWidth,
      options: patternIndexLabels,
      initial: patternIndexLabels[this.spec.pattern.index] ?? "P0",
      onChange: (v) => {
        const idx = patternIndexLabels.indexOf(v);
        this.spec = { ...this.spec, pattern: { ...this.spec.pattern, index: idx } };
        this.applyAll();
      },
    });
    patternIndexCycle.x = spacing.lg;
    patternIndexCycle.y = y.value;
    panel.addChild(patternIndexCycle);
    y.value += Cycle.height();

    y.value += this.addSlider(panel, y.value, sliderWidth, {
      label: "OFFSET X",
      min: 0,
      max: 1,
      initial: this.spec.pattern.offsetX,
      onChange: (v) => {
        this.spec = { ...this.spec, pattern: { ...this.spec.pattern, offsetX: v } };
        this.applyAll();
      },
    });
    y.value += this.addSlider(panel, y.value, sliderWidth, {
      label: "OFFSET Y",
      min: 0,
      max: 1,
      initial: this.spec.pattern.offsetY,
      onChange: (v) => {
        this.spec = { ...this.spec, pattern: { ...this.spec.pattern, offsetY: v } };
        this.applyAll();
      },
    });
    y.value += this.addSlider(panel, y.value, sliderWidth, {
      label: "SCALE",
      min: 0.5,
      max: 3,
      initial: this.spec.pattern.scale,
      onChange: (v) => {
        this.spec = { ...this.spec, pattern: { ...this.spec.pattern, scale: v } };
        this.applyAll();
      },
    });
    y.value += this.addSlider(panel, y.value, sliderWidth, {
      label: "ALPHA",
      min: 0,
      max: 1,
      initial: this.tunables.pattern.overlayAlpha,
      onChange: (v) => {
        this.tunables = {
          ...this.tunables,
          pattern: { ...this.tunables.pattern, overlayAlpha: v },
        };
        this.card.setTunables(this.tunables);
      },
    });
    y.value += spacing.md;

    sectionHeader({ panel, y, label: "TINT" });
    y.value += this.addSlider(panel, y.value, sliderWidth, {
      label: "HUE",
      min: -180,
      max: 180,
      initial: this.spec.tint.hue * 180,
      step: 1,
      format: (v) => `${Math.round(v)}°`,
      onChange: (v) => {
        this.spec = { ...this.spec, tint: { ...this.spec.tint, hue: v / 180 } };
        this.applyAll();
      },
    });
    y.value += this.addSlider(panel, y.value, sliderWidth, {
      label: "SATURATION",
      min: 0,
      max: 2,
      initial: this.spec.tint.saturation,
      onChange: (v) => {
        this.spec = { ...this.spec, tint: { ...this.spec.tint, saturation: v } };
        this.applyAll();
      },
    });
    y.value += this.addSlider(panel, y.value, sliderWidth, {
      label: "BRIGHTNESS",
      min: 0,
      max: 2,
      initial: this.spec.tint.brightness,
      onChange: (v) => {
        this.spec = { ...this.spec, tint: { ...this.spec.tint, brightness: v } };
        this.applyAll();
      },
    });
    y.value += spacing.md;

    sectionHeader({ panel, y, label: "FINISH" });
    const finishCycle = new Cycle<Finish>({
      label: "FINISH",
      width: cycleWidth,
      options: FINISHES,
      initial: this.spec.finish,
      onChange: (v) => {
        this.spec = { ...this.spec, finish: v };
        this.applyAll();
      },
    });
    finishCycle.x = spacing.lg;
    finishCycle.y = y.value;
    panel.addChild(finishCycle);
    y.value += Cycle.height();

    y.value += this.addSlider(panel, y.value, sliderWidth, {
      label: "FOIL STRENGTH",
      min: 0,
      max: 1,
      initial: this.tunables.foil.foilStrength,
      onChange: (v) => {
        this.tunables = {
          ...this.tunables,
          foil: { ...this.tunables.foil, foilStrength: v },
        };
        this.card.setTunables(this.tunables);
      },
    });
    y.value += this.addSlider(panel, y.value, sliderWidth, {
      label: "CHROME STRENGTH",
      min: 0,
      max: 1,
      initial: this.tunables.foil.chromeStrength,
      onChange: (v) => {
        this.tunables = {
          ...this.tunables,
          foil: { ...this.tunables.foil, chromeStrength: v },
        };
        this.card.setTunables(this.tunables);
      },
    });
    y.value += this.addSlider(panel, y.value, sliderWidth, {
      label: "HOLO STRENGTH",
      min: 0,
      max: 1,
      initial: this.tunables.foil.holographicStrength,
      onChange: (v) => {
        this.tunables = {
          ...this.tunables,
          foil: { ...this.tunables.foil, holographicStrength: v },
        };
        this.card.setTunables(this.tunables);
      },
    });
    y.value += spacing.md;

    sectionHeader({ panel, y, label: "MOTION" });
    const motionCycle = new Cycle<Motion>({
      label: "MOTION",
      width: cycleWidth,
      options: MOTIONS,
      initial: this.spec.motion,
      onChange: (v) => {
        this.spec = { ...this.spec, motion: v };
        this.applyAll();
      },
    });
    motionCycle.x = spacing.lg;
    motionCycle.y = y.value;
    panel.addChild(motionCycle);
    y.value += Cycle.height();

    y.value += this.addSlider(panel, y.value, sliderWidth, {
      label: "SHIMMER SPEED",
      min: 0,
      max: 2,
      initial: this.tunables.motion.shimmerSpeed,
      onChange: (v) => {
        this.tunables = {
          ...this.tunables,
          motion: { ...this.tunables.motion, shimmerSpeed: v },
        };
        this.card.setTunables(this.tunables);
      },
    });
    y.value += this.addSlider(panel, y.value, sliderWidth, {
      label: "PULSE SPEED",
      min: 0,
      max: 5,
      initial: this.tunables.motion.pulseSpeed,
      onChange: (v) => {
        this.tunables = {
          ...this.tunables,
          motion: { ...this.tunables.motion, pulseSpeed: v },
        };
        this.card.setTunables(this.tunables);
      },
    });
    y.value += this.addSlider(panel, y.value, sliderWidth, {
      label: "DRIFT SPEED",
      min: 0,
      max: 0.5,
      initial: this.tunables.motion.driftSpeed,
      onChange: (v) => {
        this.tunables = {
          ...this.tunables,
          motion: { ...this.tunables.motion, driftSpeed: v },
        };
        this.card.setTunables(this.tunables);
      },
    });

    this.panel.resize(PANEL_WIDTH, y.value + spacing.md);
  }

  private addSlider(
    panel: Container,
    yPos: number,
    width: number,
    opts: {
      label: string;
      min: number;
      max: number;
      initial: number;
      step?: number;
      format?(v: number): string;
      onChange(v: number): void;
    },
  ): number {
    const slider = new Slider({
      label: opts.label,
      width,
      min: opts.min,
      max: opts.max,
      initial: opts.initial,
      ...(opts.step !== undefined ? { step: opts.step } : {}),
      ...(opts.format !== undefined ? { format: opts.format } : {}),
      onChange: opts.onChange,
    });
    slider.x = spacing.lg;
    slider.y = yPos;
    panel.addChild(slider);
    return Slider.height();
  }

  private rollNewCode(): void {
    this.code = rollCode(this.nextRand);
    this.spec = decode(this.code);
    this.codeText.text = this.code;
    this.applyAll();
  }

  private resetTunables(): void {
    this.tunables = cloneTunables(defaultTunables);
    this.card.setTunables(this.tunables);
  }

  private applyAll(): void {
    this.card.setTunables(this.tunables);
    this.card.apply(this.spec, this.axes);
  }

  private onTick(_ticker: Ticker): void {
    if (!this.axes.motion || !this.axes.finish) return;
    const t = performance.now() / 1000;
    this.card.tick(t);
  }

  private nextRand = (): number => {
    const s = (this.rngState + 0x6d2b79f5) >>> 0;
    this.rngState = s;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function cloneTunables(t: Tunables): Tunables {
  return {
    cardWidth: t.cardWidth,
    cardHeight: t.cardHeight,
    pattern: { ...t.pattern },
    spec: {
      patternScale: [...t.spec.patternScale] as [number, number],
      hue: [...t.spec.hue] as [number, number],
      saturation: [...t.spec.saturation] as [number, number],
      brightness: [...t.spec.brightness] as [number, number],
    },
    foil: { ...t.foil },
    motion: { ...t.motion },
  };
}

interface AxisChipOptions {
  label: string;
  initial: boolean;
  onChange(active: boolean): void;
}

class AxisChip extends Container {
  private readonly bg: Graphics;
  private readonly text: Text;
  private active: boolean;
  private hovered = false;
  private readonly w: number;
  private readonly h = 28;
  private readonly onChange: (active: boolean) => void;

  constructor(options: AxisChipOptions) {
    super();
    this.active = options.initial;
    this.onChange = options.onChange;
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
    this.w = Math.max(72, Math.ceil(this.text.width) + spacing.md * 2);
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
    this.on("pointertap", () => {
      this.active = !this.active;
      this.redraw();
      this.onChange(this.active);
    });
    this.redraw();
  }

  private redraw(): void {
    const fill = this.active ? color.surfaceFocus : color.bgSunken;
    const border = this.hovered || this.active ? color.borderFocus : color.border;
    this.bg
      .clear()
      .roundRect(0, 0, this.w, this.h, 2)
      .fill({ color: fill })
      .stroke({ color: border, width: stroke.base, alignment: 0 });
    this.text.x = Math.round((this.w - this.text.width) / 2);
    this.text.y = Math.round((this.h - this.text.height) / 2);
  }

  get chipWidth(): number {
    return this.w;
  }
}
