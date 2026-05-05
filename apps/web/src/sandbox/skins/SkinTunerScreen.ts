import type { Card } from "@durak/engine";
import {
  type Axes,
  decode,
  defaultTunables,
  type Finish,
  type Motion,
  PATTERN_VARIANTS,
  rollCode,
  type SkinAssets,
  SkinnedCard,
  type SkinSpec,
  type Tunables,
} from "@durak/skins-spike";
import { Button, color, Panel, spacing, stroke, typography } from "@durak/ui";
import {
  Container,
  type FederatedPointerEvent,
  type FederatedWheelEvent,
  Graphics,
  Text,
  type Ticker,
  type TickerCallback,
} from "pixi.js";
import { CARD_H, CARD_W, CardView } from "../../cards/CardView.js";
import type { Screen } from "../../screens/types.js";
import { Cycle, NumberRow } from "./controls.js";

// Maximum tilt angle (radians) when the pointer is at the far corner of the
// preview area while dragging. ~5-6° reads as a subtle 3D lean. Pixi skew
// is a shear, not a real rotation, so larger values quickly distort the
// card into an obvious parallelogram instead of a tilted rectangle.
const TILT_MAX_RAD = 0.1;
// How strongly skew also foreshortens the corresponding axis. Multiplying
// by current skew angle gives a fake-perspective "leaning side gets
// smaller" feel.
const TILT_FORESHORTEN = 0.1;
// Lerp coefficient for the tilt → 0 spring-back. Higher = snappier.
const TILT_LERP = 0.18;

const PANEL_WIDTH = 380;
const PREVIEW_SCALE = 4;
const FINISHES: readonly Finish[] = ["matte", "foil", "chrome", "holographic"];
const MOTIONS: readonly Motion[] = ["none", "shimmer", "pulse", "drift"];
const CYCLE_WIDTH = 140;

const PREVIEW_CARD: Card = { suit: "spades", rank: 14 };

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
  y.value += t.height + spacing.xs;
}

export interface SkinTunerScreenOptions {
  assets: SkinAssets;
  ticker: Ticker;
  /**
   * The Pixi canvas element. NumberRow inputs are HTML elements positioned
   * via canvas.getBoundingClientRect, so the canvas reference is required
   * for them to render. Optional so jsdom unit tests can construct the
   * screen without a real canvas (inputs stay invisible in that case).
   */
  canvas?: HTMLCanvasElement;
}

export class SkinTunerScreen extends Container implements Screen {
  private readonly ticker: Ticker;
  private readonly assets: SkinAssets;
  private readonly card: SkinnedCard;
  private readonly preview: Container;
  private readonly panel: Panel;
  private readonly panelInner: Container;
  private readonly codeText: Text;
  private readonly tickCallback: TickerCallback<unknown>;
  private readonly canvas: HTMLCanvasElement | undefined;
  private spec: SkinSpec = decode("000000000000");
  private axes: Axes = { pattern: true, tint: true, finish: true, motion: true };
  private tunables: Tunables = cloneTunables(defaultTunables);
  private skinsActive = true;
  private code = "000000000000";
  private rngState = 0xc0ffee;
  private readonly scrollMask: Graphics;
  private contentHeight = 0;
  private maskHeight = 0;

  // Tilt state — only active while the user is dragging on the card. When
  // released, target snaps to 0 and `current` lerps toward it each tick,
  // giving a spring-back to flat.
  private dragging = false;
  private currentTiltX = 0;
  private currentTiltY = 0;
  private targetTiltX = 0;
  private targetTiltY = 0;
  private readonly windowPointerUp: () => void;

  // NumberRow children get their HTML input positions synced on layout/
  // scroll. valueSyncs let roll/reset re-read values from spec/tunables.
  private readonly numberRows: NumberRow[] = [];
  private readonly valueSyncs: Array<() => void> = [];
  private readonly cycleSyncs: Array<() => void> = [];

  constructor(options: SkinTunerScreenOptions) {
    super();
    this.ticker = options.ticker;
    this.assets = options.assets;
    this.canvas = options.canvas;

    this.panel = new Panel({ width: PANEL_WIDTH, height: 980 });
    this.addChild(this.panel);
    this.panelInner = new Container();
    this.panel.addChild(this.panelInner);

    // Scroll mask: clips panelInner to the panel's visible area so the
    // panel always fits the viewport. Wheel scrolls panelInner.y inside.
    this.scrollMask = new Graphics();
    this.panel.addChild(this.scrollMask);
    this.panelInner.mask = this.scrollMask;

    this.panel.eventMode = "static";
    this.panel.on("wheel", (e: FederatedWheelEvent) => this.handleWheel(e));

    this.preview = new Container();
    this.addChild(this.preview);

    // Pivot the card at its centre so skew/scale transforms tilt around
    // the middle rather than the top-left corner.
    this.card = new SkinnedCard({
      base: new CardView(PREVIEW_CARD),
      baseWidth: CARD_W,
      baseHeight: CARD_H,
      assets: this.assets,
    });
    this.card.scale.set(PREVIEW_SCALE);
    this.card.pivot.set(CARD_W / 2, CARD_H / 2);
    this.preview.addChild(this.card);

    // Tilt: only active while dragging on the card. globalpointermove
    // updates the target while dragging; the ticker lerps current→target
    // so releasing the pointer snaps the target to 0 and the card springs
    // back to flat over a few frames.
    this.card.eventMode = "static";
    this.card.cursor = "grab";
    this.card.on("pointerdown", () => this.startDrag());
    this.eventMode = "static";
    this.on("globalpointermove", (e: FederatedPointerEvent) => {
      if (this.dragging) this.updateTiltTarget(e);
    });
    this.on("pointerup", () => this.endDrag());
    this.on("pointerupoutside", () => this.endDrag());
    // Window pointerup catches cases where the cursor leaves the canvas
    // entirely while a drag is in progress.
    this.windowPointerUp = () => this.endDrag();
    window.addEventListener("pointerup", this.windowPointerUp);

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
    const panelH = Math.max(200, viewHeight - spacing.md * 2);
    this.panel.resize(PANEL_WIDTH, panelH);
    this.maskHeight = panelH;
    this.scrollMask.clear().rect(0, 0, PANEL_WIDTH, panelH).fill({ color: 0xffffff });
    const minY = Math.min(0, this.maskHeight - this.contentHeight);
    if (this.panelInner.y < minY) this.panelInner.y = minY;
    if (this.panelInner.y > 0) this.panelInner.y = 0;

    const previewW = CARD_W * PREVIEW_SCALE;
    const previewH = CARD_H * PREVIEW_SCALE;
    const availableX = viewWidth - PANEL_WIDTH - spacing.md * 2;
    this.preview.x = Math.round(
      spacing.md + PANEL_WIDTH + (availableX - previewW) / 2 + previewW / 2,
    );
    this.preview.y = Math.round((viewHeight - previewH) / 2 + previewH / 2);

    this.syncInputDoms();
  }

  dispose(): void {
    this.ticker.remove(this.tickCallback);
    window.removeEventListener("pointerup", this.windowPointerUp);
    for (const row of this.numberRows) row.destroyDom();
  }

  // ─── Input / scroll plumbing ────────────────────────────────────────

  private handleWheel(e: FederatedWheelEvent): void {
    if (this.contentHeight <= this.maskHeight) return;
    const minY = this.maskHeight - this.contentHeight;
    const next = this.panelInner.y - e.deltaY;
    this.panelInner.y = Math.max(minY, Math.min(0, next));
    const native = e.nativeEvent;
    if (native instanceof Event) native.preventDefault();
    this.syncInputDoms();
  }

  private syncInputDoms(): void {
    if (!this.canvas) return;
    const rect = this.canvas.getBoundingClientRect();
    const clipTop = rect.top + this.panel.y;
    const clipBottom = clipTop + this.maskHeight;
    for (const row of this.numberRows) {
      row.syncDom(this.canvas, clipTop, clipBottom);
    }
  }

  // ─── Tilt drag ──────────────────────────────────────────────────────

  private startDrag(): void {
    this.dragging = true;
    this.card.cursor = "grabbing";
  }

  private endDrag(): void {
    if (!this.dragging) return;
    this.dragging = false;
    this.card.cursor = "grab";
    this.targetTiltX = 0;
    this.targetTiltY = 0;
  }

  private updateTiltTarget(e: FederatedPointerEvent): void {
    const cardW = CARD_W * PREVIEW_SCALE;
    const cardH = CARD_H * PREVIEW_SCALE;
    const relX = (e.global.x - this.preview.x) / cardW;
    const relY = (e.global.y - this.preview.y) / cardH;
    const cx = clamp(relX, -1.5, 1.5);
    const cy = clamp(relY, -1.5, 1.5);
    this.targetTiltY = cx * TILT_MAX_RAD;
    this.targetTiltX = -cy * TILT_MAX_RAD;
  }

  // ─── Panel build ────────────────────────────────────────────────────

  private buildPanel(): void {
    const rowWidth = PANEL_WIDTH - spacing.lg * 2;
    const buttonWidth = rowWidth;
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
      width: buttonWidth,
      height: 28,
      onActivate: () => this.rollNewCode(),
    });
    rollBtn.x = spacing.lg;
    rollBtn.y = y.value;
    panel.addChild(rollBtn);
    y.value += 28 + spacing.xs;

    const noSkinBtn = new Button({
      label: this.skinsActive ? "NO-SKIN PRESET" : "[NO-SKIN PRESET]",
      width: buttonWidth,
      height: 24,
      onActivate: () => {
        this.skinsActive = !this.skinsActive;
        noSkinBtn.setLabel(this.skinsActive ? "NO-SKIN PRESET" : "[NO-SKIN PRESET]");
        this.applyAll();
      },
    });
    noSkinBtn.x = spacing.lg;
    noSkinBtn.y = y.value;
    panel.addChild(noSkinBtn);
    y.value += 24 + spacing.xs;

    const resetBtn = new Button({
      label: "RESET TUNABLES",
      width: buttonWidth,
      height: 24,
      onActivate: () => this.resetTunables(),
    });
    resetBtn.x = spacing.lg;
    resetBtn.y = y.value;
    panel.addChild(resetBtn);
    y.value += 24 + spacing.md;

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
    y.value += 24 + spacing.md;

    sectionHeader({ panel, y, label: "PATTERN" });
    const patternIndexLabels = Array.from({ length: PATTERN_VARIANTS }, (_, i) => `P${i}`);
    y.value += this.addCycle(panel, y.value, rowWidth, {
      label: "INDEX",
      options: patternIndexLabels,
      read: () => patternIndexLabels[this.spec.pattern.index] ?? "P0",
      write: (v) => {
        const idx = patternIndexLabels.indexOf(v);
        this.spec = { ...this.spec, pattern: { ...this.spec.pattern, index: idx } };
        this.applyAll();
      },
    });
    y.value += this.addNumber(panel, y.value, rowWidth, {
      label: "OFFSET X",
      min: 0,
      max: 1,
      step: 0.01,
      read: () => this.spec.pattern.offsetX,
      write: (v) => {
        this.spec = { ...this.spec, pattern: { ...this.spec.pattern, offsetX: v } };
        this.applyAll();
      },
    });
    y.value += this.addNumber(panel, y.value, rowWidth, {
      label: "OFFSET Y",
      min: 0,
      max: 1,
      step: 0.01,
      read: () => this.spec.pattern.offsetY,
      write: (v) => {
        this.spec = { ...this.spec, pattern: { ...this.spec.pattern, offsetY: v } };
        this.applyAll();
      },
    });
    y.value += this.addNumber(panel, y.value, rowWidth, {
      label: "SCALE",
      min: 0.5,
      max: 3,
      step: 0.05,
      read: () => this.spec.pattern.scale,
      write: (v) => {
        this.spec = { ...this.spec, pattern: { ...this.spec.pattern, scale: v } };
        this.applyAll();
      },
    });
    y.value += this.addNumber(panel, y.value, rowWidth, {
      label: "ALPHA",
      min: 0,
      max: 1,
      step: 0.01,
      read: () => this.tunables.pattern.overlayAlpha,
      write: (v) => {
        this.tunables = {
          ...this.tunables,
          pattern: { ...this.tunables.pattern, overlayAlpha: v },
        };
        this.card.setTunables(this.tunables);
      },
    });
    y.value += this.addNumber(panel, y.value, rowWidth, {
      label: "TILE SIZE",
      min: 8,
      max: 64,
      step: 1,
      format: (v) => `${Math.round(v)}`,
      read: () => this.tunables.pattern.tileSize,
      write: (v) => {
        this.tunables = {
          ...this.tunables,
          pattern: { ...this.tunables.pattern, tileSize: v },
        };
        this.card.setTunables(this.tunables);
      },
    });
    y.value += spacing.sm;

    sectionHeader({ panel, y, label: "TINT" });
    y.value += this.addNumber(panel, y.value, rowWidth, {
      label: "HUE",
      min: -180,
      max: 180,
      step: 1,
      format: (v) => `${Math.round(v)}`,
      read: () => this.spec.tint.hue * 180,
      write: (v) => {
        this.spec = { ...this.spec, tint: { ...this.spec.tint, hue: v / 180 } };
        this.applyAll();
      },
    });
    y.value += this.addNumber(panel, y.value, rowWidth, {
      label: "SATURATION",
      min: 0,
      max: 2,
      step: 0.01,
      read: () => this.spec.tint.saturation,
      write: (v) => {
        this.spec = { ...this.spec, tint: { ...this.spec.tint, saturation: v } };
        this.applyAll();
      },
    });
    y.value += this.addNumber(panel, y.value, rowWidth, {
      label: "BRIGHTNESS",
      min: 0,
      max: 2,
      step: 0.01,
      read: () => this.spec.tint.brightness,
      write: (v) => {
        this.spec = { ...this.spec, tint: { ...this.spec.tint, brightness: v } };
        this.applyAll();
      },
    });
    y.value += spacing.sm;

    sectionHeader({ panel, y, label: "FINISH" });
    y.value += this.addCycle<Finish>(panel, y.value, rowWidth, {
      label: "KIND",
      options: FINISHES,
      read: () => this.spec.finish,
      write: (v) => {
        this.spec = { ...this.spec, finish: v };
        this.applyAll();
      },
    });
    y.value += this.addNumber(panel, y.value, rowWidth, {
      label: "FOIL STR",
      min: 0,
      max: 1,
      step: 0.01,
      read: () => this.tunables.foil.foilStrength,
      write: (v) => {
        this.tunables = {
          ...this.tunables,
          foil: { ...this.tunables.foil, foilStrength: v },
        };
        this.card.setTunables(this.tunables);
      },
    });
    y.value += this.addNumber(panel, y.value, rowWidth, {
      label: "CHROME STR",
      min: 0,
      max: 1,
      step: 0.01,
      read: () => this.tunables.foil.chromeStrength,
      write: (v) => {
        this.tunables = {
          ...this.tunables,
          foil: { ...this.tunables.foil, chromeStrength: v },
        };
        this.card.setTunables(this.tunables);
      },
    });
    y.value += this.addNumber(panel, y.value, rowWidth, {
      label: "HOLO STR",
      min: 0,
      max: 1,
      step: 0.01,
      read: () => this.tunables.foil.holographicStrength,
      write: (v) => {
        this.tunables = {
          ...this.tunables,
          foil: { ...this.tunables.foil, holographicStrength: v },
        };
        this.card.setTunables(this.tunables);
      },
    });
    y.value += this.addNumber(panel, y.value, rowWidth, {
      label: "PIXEL CELL",
      min: 1,
      max: 8,
      step: 0.5,
      read: () => this.tunables.foil.cellSize,
      write: (v) => {
        this.tunables = {
          ...this.tunables,
          foil: { ...this.tunables.foil, cellSize: v },
        };
        this.card.setTunables(this.tunables);
      },
    });
    y.value += spacing.sm;

    sectionHeader({ panel, y, label: "MOTION" });
    y.value += this.addCycle<Motion>(panel, y.value, rowWidth, {
      label: "KIND",
      options: MOTIONS,
      read: () => this.spec.motion,
      write: (v) => {
        this.spec = { ...this.spec, motion: v };
        this.applyAll();
      },
    });
    y.value += this.addNumber(panel, y.value, rowWidth, {
      label: "SHIMMER SPD",
      min: 0,
      max: 2,
      step: 0.01,
      read: () => this.tunables.motion.shimmerSpeed,
      write: (v) => {
        this.tunables = {
          ...this.tunables,
          motion: { ...this.tunables.motion, shimmerSpeed: v },
        };
        this.card.setTunables(this.tunables);
      },
    });
    y.value += this.addNumber(panel, y.value, rowWidth, {
      label: "SHIMMER WIDTH",
      min: 0.01,
      max: 0.5,
      step: 0.01,
      read: () => this.tunables.motion.shimmerWidth,
      write: (v) => {
        this.tunables = {
          ...this.tunables,
          motion: { ...this.tunables.motion, shimmerWidth: v },
        };
        this.card.setTunables(this.tunables);
      },
    });
    y.value += this.addNumber(panel, y.value, rowWidth, {
      label: "PULSE SPD",
      min: 0,
      max: 5,
      step: 0.05,
      read: () => this.tunables.motion.pulseSpeed,
      write: (v) => {
        this.tunables = {
          ...this.tunables,
          motion: { ...this.tunables.motion, pulseSpeed: v },
        };
        this.card.setTunables(this.tunables);
      },
    });
    y.value += this.addNumber(panel, y.value, rowWidth, {
      label: "PULSE AMT",
      min: 0,
      max: 1,
      step: 0.01,
      read: () => this.tunables.motion.pulseAmount,
      write: (v) => {
        this.tunables = {
          ...this.tunables,
          motion: { ...this.tunables.motion, pulseAmount: v },
        };
        this.card.setTunables(this.tunables);
      },
    });
    y.value += this.addNumber(panel, y.value, rowWidth, {
      label: "DRIFT SPD",
      min: 0,
      max: 0.5,
      step: 0.005,
      read: () => this.tunables.motion.driftSpeed,
      write: (v) => {
        this.tunables = {
          ...this.tunables,
          motion: { ...this.tunables.motion, driftSpeed: v },
        };
        this.card.setTunables(this.tunables);
      },
    });

    this.contentHeight = y.value + spacing.md;
  }

  // ─── Row helpers ────────────────────────────────────────────────────

  private addNumber(
    panel: Container,
    yPos: number,
    width: number,
    opts: {
      label: string;
      min?: number;
      max?: number;
      step?: number;
      format?(v: number): string;
      read(): number;
      write(v: number): void;
    },
  ): number {
    const row = new NumberRow({
      label: opts.label,
      width,
      initial: opts.read(),
      ...(opts.min !== undefined ? { min: opts.min } : {}),
      ...(opts.max !== undefined ? { max: opts.max } : {}),
      ...(opts.step !== undefined ? { step: opts.step } : {}),
      ...(opts.format !== undefined ? { format: opts.format } : {}),
      onChange: opts.write,
    });
    row.x = spacing.lg;
    row.y = yPos;
    panel.addChild(row);
    this.numberRows.push(row);
    this.valueSyncs.push(() => row.setValue(opts.read()));
    return NumberRow.height();
  }

  private addCycle<T extends string>(
    panel: Container,
    yPos: number,
    width: number,
    opts: {
      label: string;
      options: readonly T[];
      read(): T;
      write(v: T): void;
    },
  ): number {
    const wrapper = new Container();
    wrapper.x = spacing.lg;
    wrapper.y = yPos;

    const labelText = new Text({
      text: opts.label,
      style: {
        fontFamily: typography.family,
        fontSize: typography.size.xs,
        fontWeight: typography.weight.bold,
        fill: color.textMuted,
        letterSpacing: typography.letterSpacing.wide,
      },
    });
    labelText.x = 0;
    labelText.y = Math.round((NumberRow.height() - labelText.height) / 2);
    wrapper.addChild(labelText);

    const cycle = new Cycle({
      width: CYCLE_WIDTH,
      options: opts.options,
      initial: opts.read(),
      onChange: opts.write,
    });
    cycle.x = width - CYCLE_WIDTH;
    cycle.y = Math.round((NumberRow.height() - 18) / 2);
    wrapper.addChild(cycle);

    panel.addChild(wrapper);
    this.cycleSyncs.push(() => cycle.setSilently(opts.read()));
    return NumberRow.height();
  }

  // ─── Apply / lifecycle ──────────────────────────────────────────────

  private rollNewCode(): void {
    this.code = rollCode(this.nextRand);
    this.spec = decode(this.code);
    this.codeText.text = this.code;
    this.applyAll();
    this.refreshControls();
  }

  private resetTunables(): void {
    this.tunables = cloneTunables(defaultTunables);
    this.card.setTunables(this.tunables);
    this.refreshControls();
  }

  private refreshControls(): void {
    for (const sync of this.valueSyncs) sync();
    for (const sync of this.cycleSyncs) sync();
  }

  private applyAll(): void {
    this.card.setTunables(this.tunables);
    this.card.applySkin(this.skinsActive ? this.spec : null, this.axes);
  }

  private onTick(_ticker: Ticker): void {
    // Lerp the card's actual tilt toward the target. While dragging, the
    // target tracks pointer position; on release the target snaps to 0
    // and the card springs back over a few frames.
    const dx = this.targetTiltX - this.currentTiltX;
    const dy = this.targetTiltY - this.currentTiltY;
    if (Math.abs(dx) > 1e-4 || Math.abs(dy) > 1e-4) {
      this.currentTiltX += dx * TILT_LERP;
      this.currentTiltY += dy * TILT_LERP;
      this.card.skew.set(this.currentTiltY, this.currentTiltX);
      this.card.scale.x = PREVIEW_SCALE * (1 - Math.abs(this.currentTiltY) * TILT_FORESHORTEN);
      this.card.scale.y = PREVIEW_SCALE * (1 - Math.abs(this.currentTiltX) * TILT_FORESHORTEN);
    }
    if (!this.skinsActive) return;
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

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
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
  private readonly h = 24;
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
