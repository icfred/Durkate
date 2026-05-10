import type { Card } from "@durak/engine";
import {
  CARD_BACKGROUNDS,
  COLORWAYS,
  decode,
  defaultTunables,
  type Finish,
  PATTERN_NAMES,
  rollCode,
  type SkinAssets,
  SkinnedCard,
  type SkinSpec,
  type Tunables,
} from "@durak/skins-spike";
import {
  Button,
  Cycle,
  color,
  dealCard,
  FocusManager,
  flipReveal,
  LABEL_ROW_HEIGHT,
  LabelRow,
  NumberStepper,
  Panel,
  playCard,
  SectionHeader,
  Stack,
  spacing,
  ToggleChip,
  type TweenHandle,
  typography,
} from "@durak/ui";
import {
  Container,
  type FederatedPointerEvent,
  type FederatedWheelEvent,
  Graphics,
  Text,
  type Ticker,
  type TickerCallback,
} from "pixi.js";
import { CARD_H, CARD_W, CardView } from "../cards/CardView.js";
import type { Screen } from "./types.js";

// ─── Tuning constants ──────────────────────────────────────────────────────

const TILT_MAX_RAD = 0.22;
const TILT_FORESHORTEN = 0.1;
const TILT_LERP = 0.18;

const PANEL_WIDTH = 380;
const PANEL_PAD = spacing.lg;
const ROW_WIDTH = PANEL_WIDTH - PANEL_PAD * 2;
const CONTROL_WIDTH = 140;

// Preview rendered at 6× the 60×88 base so the card occupies a generous
// chunk of the available area beside the panel (~360×528 at scale 6).
// Bigger feels more like a showcase than an editor; smaller and it
// reads as a thumbnail.
const PREVIEW_SCALE = 6;
const PREVIEW_CARD: Card = { suit: "spades", rank: 14 };

const FINISHES: readonly Finish[] = ["matte", "silver", "gold", "bronze", "holographic"];
const COLORWAY_LABELS: readonly string[] = COLORWAYS.map((c) => c.name.toUpperCase());
const CARD_BG_LABELS: readonly string[] = CARD_BACKGROUNDS.map((b) => b.name.toUpperCase());
// Use the human-readable pattern names from the spike package
// (voronoi, fbm, truchet, …) instead of bare "P0".."PN".
const PATTERN_LABELS: readonly string[] = PATTERN_NAMES.map((n) => n.toUpperCase());

interface TunerAxes {
  pattern: boolean;
  tint: boolean;
  finish: boolean;
}

export interface SkinTunerScreenOptions {
  assets: SkinAssets;
  ticker: Ticker;
  /**
   * The Pixi canvas element. Optional — kept for future overlays; the
   * panel itself is now Pixi-native and doesn't need a canvas reference.
   */
  canvas?: HTMLCanvasElement;
  /** Optional starting code (e.g. via `?code=…`). */
  initialCode?: string;
  /** Wire the in-tuner BACK button to host-driven navigation. */
  onBack?(): void;
}

// Each form control registers a `pull` closure with the screen so a
// programmatic state change (rolling a new code, resetting tunables)
// can refresh the displayed value without firing onChange.
type Pull = () => void;

export class SkinTunerScreen extends Container implements Screen {
  private readonly ticker: Ticker;
  private readonly assets: SkinAssets;
  private readonly card: SkinnedCard;
  // Front face — clean cream surface with the rank/suit corner glyph,
  // no skin overlay. Stacked behind the back so toggling visibility
  // mid-flip reveals it. Mirrors the back's transform every frame so
  // tilt + animation move both views identically.
  private readonly cardFront: CardView;
  private readonly preview: Container;
  private readonly panel: Panel;
  private readonly panelInner: Container;
  private readonly codeText: Text;
  private readonly backBtn: Button | null;
  private readonly tickCallback: TickerCallback<unknown>;
  private readonly scrollMask: Graphics;
  private readonly pulls: Pull[] = [];
  private spec: SkinSpec = decode("000000000000");
  private tunables: Tunables = cloneTunables(defaultTunables);
  private skinsActive = true;
  // Per-axis sub-toggles. Active only when SKIN is enabled — the chips
  // visually mute and stop accepting clicks when SKIN is off, so the
  // user doesn't see "skin on + pattern off = blank" surprises.
  private axes: TunerAxes = { pattern: true, tint: true, finish: true };
  private readonly axisChips: { key: keyof TunerAxes; chip: ToggleChip }[] = [];
  private code = "000000000000";
  private rngState = Math.floor(Math.random() * 0xffffffff) >>> 0 || 1;
  private contentHeight = 0;
  private maskHeight = 0;
  // Form-mode focus controller. Every Cycle / Stepper / ToggleChip
  // gets registered in document order so ArrowUp/Down navigate between
  // fields and ArrowLeft/Right step the focused control. The host's
  // onBack is wired through `onEscape` so Esc returns to the grid.
  private readonly focus: FocusManager;

  // Tilt state.
  private dragging = false;
  private currentTiltX = 0;
  private currentTiltY = 0;
  private targetTiltX = 0;
  private targetTiltY = 0;
  // Active animation tween, kept so a second click cancels the first
  // instead of stacking. Cleared by the tween's own onComplete.
  private activeAnim: TweenHandle | null = null;
  private readonly windowPointerUp: () => void;
  private readonly windowKeyDown: (event: KeyboardEvent) => void;

  constructor(options: SkinTunerScreenOptions) {
    super();
    this.ticker = options.ticker;
    this.assets = options.assets;

    if (options.initialCode && /^[0-9a-fA-F]{12}$/.test(options.initialCode)) {
      this.code = options.initialCode;
      this.spec = decode(this.code);
    }

    this.panel = new Panel({ width: PANEL_WIDTH, height: 980 });
    this.addChild(this.panel);
    this.panelInner = new Container();
    this.panel.addChild(this.panelInner);

    this.scrollMask = new Graphics();
    this.panel.addChild(this.scrollMask);
    this.panelInner.mask = this.scrollMask;
    this.panel.eventMode = "static";
    this.panel.on("wheel", (e: FederatedWheelEvent) => this.handleWheel(e));

    this.preview = new Container();
    this.addChild(this.preview);
    // Two stacked card views: the back (skinned, no glyph — this is what
    // the tuner is for) and the front (face-up, no skin). Each frame the
    // front mirrors the back's transform so the visible-flip illusion is
    // seamless when visibility toggles at the flip midpoint.
    this.card = new SkinnedCard({
      base: new CardView(PREVIEW_CARD, true),
      baseWidth: CARD_W,
      baseHeight: CARD_H,
      assets: this.assets,
    });
    this.card.scale.set(PREVIEW_SCALE);
    this.card.pivot.set(CARD_W / 2, CARD_H / 2);
    this.preview.addChild(this.card);

    this.cardFront = new CardView(PREVIEW_CARD, false);
    this.cardFront.scale.set(PREVIEW_SCALE);
    this.cardFront.pivot.set(CARD_W / 2, CARD_H / 2);
    this.cardFront.visible = false;
    this.preview.addChild(this.cardFront);

    this.card.eventMode = "static";
    this.card.cursor = "grab";
    this.card.on("pointerdown", () => this.startDrag());
    // Single click (no drag) snaps the tilt back to flat — quicker
    // than double-click for the common "I'm done leaning, reset" flow.
    // Drag releases don't fire pointertap, so this only triggers on
    // taps without movement.
    this.card.on("pointertap", () => this.resetTilt());
    this.eventMode = "static";
    this.on("globalpointermove", (e: FederatedPointerEvent) => {
      if (this.dragging) this.updateTiltTarget(e);
    });
    this.on("pointerup", () => this.endDrag());
    this.on("pointerupoutside", () => this.endDrag());
    this.windowPointerUp = () => this.endDrag();
    window.addEventListener("pointerup", this.windowPointerUp);

    // R rolls a fresh code regardless of which form field has focus.
    // Skip when the user is typing in a real input or has a modifier
    // held so it doesn't fight with browser shortcuts.
    this.windowKeyDown = (event) => {
      if (event.key.toLowerCase() !== "r") return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target;
      if (target instanceof HTMLElement && /input|textarea/i.test(target.tagName)) return;
      event.preventDefault();
      this.rollNewCode();
    };
    window.addEventListener("keydown", this.windowKeyDown);

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

    // BACK lives outside the scrolling panel so it stays reachable
    // from any scroll position. Conditional because the screen is also
    // mounted directly via deep-link in tests / standalone harnesses
    // where there's no host nav.
    if (options.onBack) {
      this.backBtn = new Button({
        label: "← BACK",
        width: 100,
        height: 32,
        onActivate: options.onBack,
      });
      this.addChild(this.backBtn);
    } else {
      this.backBtn = null;
    }

    const focusOptions: ConstructorParameters<typeof FocusManager>[0] = {
      arrowMode: "form",
    };
    if (options.onBack) focusOptions.onEscape = options.onBack;
    this.focus = new FocusManager(focusOptions);

    this.buildPanel();
    this.focus.attach();
    this.applyAll();

    this.tickCallback = (t) => this.onTick(t);
    this.ticker.add(this.tickCallback);
  }

  layout(viewWidth: number, viewHeight: number): void {
    // BACK pinned to the top-left when present; the panel slides down to
    // make room so the title still reads cleanly.
    const topInset = this.backBtn ? this.backBtn.height + spacing.sm : 0;
    if (this.backBtn) {
      this.backBtn.x = spacing.md;
      this.backBtn.y = spacing.md;
    }
    this.panel.x = spacing.md;
    this.panel.y = spacing.md + topInset;
    const panelH = Math.max(200, viewHeight - spacing.md * 2 - topInset);
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
  }

  dispose(): void {
    this.ticker.remove(this.tickCallback);
    window.removeEventListener("pointerup", this.windowPointerUp);
    window.removeEventListener("keydown", this.windowKeyDown);
    this.focus.detach();
    this.focus.clear();
  }

  // ─── Scroll ─────────────────────────────────────────────────────────

  private handleWheel(e: FederatedWheelEvent): void {
    if (this.contentHeight <= this.maskHeight) return;
    const minY = this.maskHeight - this.contentHeight;
    const next = this.panelInner.y - e.deltaY;
    this.panelInner.y = Math.max(minY, Math.min(0, next));
    const native = e.nativeEvent;
    if (native instanceof Event) native.preventDefault();
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
    // Tilt target stays where the pointer left it; the user can park
    // the card at an angle to study the lighting. Double-click resets.
  }

  private resetTilt(): void {
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
    const root = new Stack({ direction: "vertical", gap: spacing.sm });
    root.x = PANEL_PAD;
    root.y = spacing.md;
    this.panelInner.addChild(root);

    // Header — title + 12-char code.
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
    root.add(title);
    root.add(this.codeText);

    // Two paired action buttons (ROLL / RESET). Half the row each so
    // they're visually parallel and the eye doesn't read them as a
    // mini-list of options. Sized exactly to ROW_WIDTH so they line up
    // with the section content below.
    const actionGap = spacing.xs;
    const actionWidth = Math.floor((ROW_WIDTH - actionGap) / 2);
    const actions = new Stack({ direction: "horizontal", gap: actionGap });
    actions.add(
      new Button({
        label: "ROLL CODE",
        width: actionWidth,
        height: 28,
        onActivate: () => this.rollNewCode(),
      }),
    );
    actions.add(
      new Button({
        label: "RESET",
        width: actionWidth,
        height: 28,
        onActivate: () => this.resetTunables(),
      }),
    );
    root.add(actions);

    // SKIN — master toggle plus three sub-axis toggles. Sub-toggles
    // visually mute and stop accepting clicks when SKIN is off so the
    // user understands the dependency without a hidden "skin on +
    // pattern off = blank" surprise.
    root.add(new SectionHeader("SKIN"));
    const skinToggle = new ToggleChip({
      label: "SKIN",
      active: this.skinsActive,
      onChange: (active) => {
        this.skinsActive = active;
        this.refreshAxisChips();
        this.applyAll();
      },
      width: 100,
    });
    root.add(
      new LabelRow({
        label: "ENABLED",
        control: skinToggle,
        width: ROW_WIDTH,
        height: LABEL_ROW_HEIGHT,
      }),
    );
    this.focus.register(skinToggle);

    const axisRow = new Stack({ direction: "horizontal", gap: spacing.xs });
    const axisKeys: ReadonlyArray<keyof TunerAxes> = ["pattern", "tint", "finish"];
    for (const key of axisKeys) {
      const chip = new ToggleChip({
        label: key.toUpperCase(),
        active: this.axes[key],
        onChange: (active) => {
          this.axes[key] = active;
          this.applyAll();
        },
      });
      this.axisChips.push({ key, chip });
      axisRow.add(chip);
      this.focus.register(chip);
    }
    root.add(
      new LabelRow({
        label: "AXES",
        // Inline group as the row's control. LabelRow right-aligns the
        // whole stack so the AXES label still lines up with the field
        // labels above and below.
        control: axisRow,
        width: ROW_WIDTH,
        height: LABEL_ROW_HEIGHT + spacing.xs,
      }),
    );
    this.refreshAxisChips();

    // PATTERN
    root.add(new SectionHeader("PATTERN"));
    root.add(
      this.section()
        .add(
          this.cycleRow("INDEX", PATTERN_LABELS, {
            read: () => PATTERN_LABELS[this.spec.pattern.index] ?? "P0",
            write: (label) => {
              const idx = Math.max(0, PATTERN_LABELS.indexOf(label));
              this.spec = { ...this.spec, pattern: { ...this.spec.pattern, index: idx } };
              this.applyAll();
            },
          }),
        )
        .add(
          this.numberRow("OFFSET X", {
            min: 0,
            max: 1,
            step: 0.01,
            read: () => this.spec.pattern.offsetX,
            write: (v) => {
              this.spec = { ...this.spec, pattern: { ...this.spec.pattern, offsetX: v } };
              this.applyAll();
            },
          }),
        )
        .add(
          this.numberRow("OFFSET Y", {
            min: 0,
            max: 1,
            step: 0.01,
            read: () => this.spec.pattern.offsetY,
            write: (v) => {
              this.spec = { ...this.spec, pattern: { ...this.spec.pattern, offsetY: v } };
              this.applyAll();
            },
          }),
        )
        .add(
          this.numberRow("SCALE", {
            min: 0.5,
            max: 3,
            step: 0.05,
            read: () => this.spec.pattern.scale,
            write: (v) => {
              this.spec = { ...this.spec, pattern: { ...this.spec.pattern, scale: v } };
              this.applyAll();
            },
          }),
        )
        .add(
          this.numberRow("ALPHA", {
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
          }),
        )
        .add(
          this.numberRow("TILE SIZE", {
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
          }),
        ),
    );

    // BACKGROUND
    root.add(new SectionHeader("BACKGROUND"));
    root.add(
      this.section().add(
        this.cycleRow("BODY", CARD_BG_LABELS, {
          read: () => CARD_BG_LABELS[this.spec.cardBackground] ?? CARD_BG_LABELS[0] ?? "NOIR",
          write: (label) => {
            const idx = Math.max(0, CARD_BG_LABELS.indexOf(label));
            this.spec = { ...this.spec, cardBackground: idx };
            this.applyAll();
          },
        }),
      ),
    );

    // COLORWAY
    root.add(new SectionHeader("COLORWAY"));
    root.add(
      this.section().add(
        this.cycleRow("PALETTE", COLORWAY_LABELS, {
          read: () => COLORWAY_LABELS[this.spec.colorway] ?? COLORWAY_LABELS[0] ?? "OCEAN",
          write: (label) => {
            const idx = Math.max(0, COLORWAY_LABELS.indexOf(label));
            this.spec = { ...this.spec, colorway: idx };
            this.applyAll();
          },
        }),
      ),
    );

    // TINT
    root.add(new SectionHeader("TINT"));
    root.add(
      this.section()
        .add(
          this.numberRow("HUE", {
            min: -180,
            max: 180,
            step: 1,
            format: (v) => `${Math.round(v)}`,
            read: () => this.spec.tint.hue * 180,
            write: (v) => {
              this.spec = { ...this.spec, tint: { ...this.spec.tint, hue: v / 180 } };
              this.applyAll();
            },
          }),
        )
        .add(
          this.numberRow("SATURATION", {
            min: 0,
            max: 2,
            step: 0.01,
            read: () => this.spec.tint.saturation,
            write: (v) => {
              this.spec = { ...this.spec, tint: { ...this.spec.tint, saturation: v } };
              this.applyAll();
            },
          }),
        )
        .add(
          this.numberRow("BRIGHTNESS", {
            min: 0,
            max: 2,
            step: 0.01,
            read: () => this.spec.tint.brightness,
            write: (v) => {
              this.spec = { ...this.spec, tint: { ...this.spec.tint, brightness: v } };
              this.applyAll();
            },
          }),
        ),
    );

    // FINISH
    root.add(new SectionHeader("FINISH"));
    root.add(
      this.section()
        .add(
          this.cycleRow<Finish>("KIND", FINISHES, {
            read: () => this.spec.finish,
            write: (v) => {
              this.spec = { ...this.spec, finish: v };
              this.applyAll();
            },
          }),
        )
        .add(
          this.numberRow("METAL STR", {
            min: 0,
            max: 1,
            step: 0.01,
            read: () => this.tunables.foil.metalStrength,
            write: (v) => {
              this.tunables = {
                ...this.tunables,
                foil: { ...this.tunables.foil, metalStrength: v },
              };
              this.card.setTunables(this.tunables);
            },
          }),
        )
        .add(
          this.numberRow("HOLO STR", {
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
          }),
        )
        .add(
          this.numberRow("PIXEL CELL", {
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
          }),
        )
        .add(
          this.numberRow("COVERAGE", {
            min: 0,
            max: 1,
            step: 0.01,
            read: () => this.tunables.foil.coverageBias,
            write: (v) => {
              this.tunables = {
                ...this.tunables,
                foil: { ...this.tunables.foil, coverageBias: v },
              };
              this.card.setTunables(this.tunables);
            },
          }),
        )
        .add(
          this.numberRow("DEPTH", {
            min: 0,
            max: 1.5,
            step: 0.01,
            read: () => this.tunables.foil.depth,
            write: (v) => {
              this.tunables = {
                ...this.tunables,
                foil: { ...this.tunables.foil, depth: v },
              };
              this.card.setTunables(this.tunables);
            },
          }),
        ),
    );

    // WEAR
    root.add(new SectionHeader("WEAR"));
    root.add(
      this.section().add(
        this.numberRow("FLOAT", {
          min: 0,
          max: 1,
          step: 0.01,
          read: () => this.tunables.wear,
          write: (v) => {
            this.tunables = { ...this.tunables, wear: v };
            this.card.setTunables(this.tunables);
          },
        }),
      ),
    );

    // ANIMATIONS — preview-card gesture buttons. Three primitives in
    // a horizontal stack: FLIP (3D-feel reveal), PLAY (off-screen
    // entrance with slam landing), DEAL (gentler arc from top-left).
    root.add(new SectionHeader("ANIMATIONS"));
    const animGap = spacing.xs;
    const animBtnWidth = Math.floor((ROW_WIDTH - animGap * 2) / 3);
    const animActions = new Stack({ direction: "horizontal", gap: animGap });
    animActions.add(
      new Button({
        label: "FLIP",
        width: animBtnWidth,
        height: 28,
        onActivate: () => this.runFlip(),
      }),
    );
    animActions.add(
      new Button({
        label: "PLAY",
        width: animBtnWidth,
        height: 28,
        onActivate: () => this.runPlay(),
      }),
    );
    animActions.add(
      new Button({
        label: "DEAL",
        width: animBtnWidth,
        height: 28,
        onActivate: () => this.runDeal(),
      }),
    );
    root.add(animActions);

    // Stack height grows lazily as children are added; once the build
    // completes its `height` reflects the full content extent. Add a
    // bottom margin so the last row isn't flush with the panel edge.
    this.contentHeight = root.y + root.height + spacing.md;
  }

  private cancelAnim(): void {
    if (this.activeAnim) {
      this.activeAnim.cancel();
      this.activeAnim = null;
    }
  }

  private runFlip(): void {
    this.cancelAnim();
    this.activeAnim = flipReveal({
      target: this.card,
      ticker: this.ticker,
      onMidpoint: () => this.swapFace(),
      onComplete: () => {
        this.activeAnim = null;
      },
    });
  }

  private runPlay(): void {
    this.cancelAnim();
    this.activeAnim = playCard({
      target: this.card,
      ticker: this.ticker,
      onComplete: () => {
        this.activeAnim = null;
      },
    });
  }

  private runDeal(): void {
    this.cancelAnim();
    this.activeAnim = dealCard({
      target: this.card,
      ticker: this.ticker,
      onComplete: () => {
        this.activeAnim = null;
      },
    });
  }

  private swapFace(): void {
    // Toggle which side of the card is visible. Called from the flip
    // midpoint so the swap happens while the card is edge-on and the
    // user can't see it.
    const showingFront = this.cardFront.visible;
    this.cardFront.visible = !showingFront;
    this.card.visible = showingFront;
  }

  private section(): Stack {
    return new Stack({ direction: "vertical", gap: 0 });
  }

  private cycleRow<T>(
    label: string,
    values: readonly T[],
    binding: { read(): T; write(value: T): void },
  ): LabelRow {
    const cycle = new Cycle({
      values,
      value: binding.read(),
      onChange: binding.write,
      width: CONTROL_WIDTH,
      // Position indicator helps when the values aren't self-numbered
      // (FINISH, BODY, PALETTE), and is harmless when they are (PATTERN
      // labels are P0..PN, the N/M echo just confirms the bound).
      showIndex: true,
    });
    this.pulls.push(() => cycle.setValue(binding.read(), true));
    this.focus.register(cycle);
    return new LabelRow({ label, control: cycle, width: ROW_WIDTH, height: LABEL_ROW_HEIGHT });
  }

  private numberRow(
    label: string,
    binding: {
      min?: number;
      max?: number;
      step?: number;
      format?: (v: number) => string;
      read(): number;
      write(value: number): void;
    },
  ): LabelRow {
    const stepperOptions: ConstructorParameters<typeof NumberStepper>[0] = {
      value: binding.read(),
      onChange: binding.write,
      width: CONTROL_WIDTH,
    };
    if (binding.min !== undefined) stepperOptions.min = binding.min;
    if (binding.max !== undefined) stepperOptions.max = binding.max;
    if (binding.step !== undefined) stepperOptions.step = binding.step;
    if (binding.format !== undefined) stepperOptions.format = binding.format;
    const stepper = new NumberStepper(stepperOptions);
    this.pulls.push(() => stepper.setValue(binding.read(), true));
    this.focus.register(stepper);
    return new LabelRow({ label, control: stepper, width: ROW_WIDTH, height: LABEL_ROW_HEIGHT });
  }

  // ─── State ──────────────────────────────────────────────────────────

  private rollNewCode(): void {
    this.code = rollCode(this.nextRand);
    this.spec = decode(this.code);
    this.codeText.text = this.code;

    const r = this.nextRand;
    this.tunables = {
      ...this.tunables,
      pattern: {
        ...this.tunables.pattern,
        overlayAlpha: 0.7 + r() * 0.3,
        tileSize: 16 + Math.round(r() * 32),
      },
      foil: {
        ...this.tunables.foil,
        metalStrength: 0.7 + r() * 0.3,
        holographicStrength: 0.7 + r() * 0.3,
        cellSize: 1 + Math.round(r() * 7),
        coverageBias: r(),
        depth: 0.6 + r() * 0.7,
      },
      wear: r(),
    };

    this.applyAll();
    for (const pull of this.pulls) pull();
  }

  private resetTunables(): void {
    this.tunables = cloneTunables(defaultTunables);
    this.card.setTunables(this.tunables);
    for (const pull of this.pulls) pull();
  }

  private applyAll(): void {
    this.card.setTunables(this.tunables);
    this.card.applySkin(this.skinsActive ? this.spec : null, this.axes);
  }

  private refreshAxisChips(): void {
    for (const { chip } of this.axisChips) chip.setDisabled(!this.skinsActive);
  }

  private onTick(_ticker: Ticker): void {
    // Tilt lerp only runs when the user isn't being driven by an
    // animation tween — animations write skew/scale directly each
    // frame and we don't want the lerp to fight them.
    if (this.activeAnim === null) {
      const dx = this.targetTiltX - this.currentTiltX;
      const dy = this.targetTiltY - this.currentTiltY;
      if (Math.abs(dx) > 1e-4 || Math.abs(dy) > 1e-4) {
        this.currentTiltX += dx * TILT_LERP;
        this.currentTiltY += dy * TILT_LERP;
        this.card.skew.set(this.currentTiltY, this.currentTiltX);
        this.card.scale.x = PREVIEW_SCALE * (1 - Math.abs(this.currentTiltY) * TILT_FORESHORTEN);
        this.card.scale.y = PREVIEW_SCALE * (1 - Math.abs(this.currentTiltX) * TILT_FORESHORTEN);
      }
    }
    // Mirror the back's transform onto the front so toggling visibility
    // mid-flip lands on a perfectly aligned face. Tilt drag, animations,
    // and resting state all flow through this single mirror step.
    this.cardFront.x = this.card.x;
    this.cardFront.y = this.card.y;
    this.cardFront.rotation = this.card.rotation;
    this.cardFront.scale.copyFrom(this.card.scale);
    this.cardFront.skew.copyFrom(this.card.skew);
    // Refresh skin shader uniforms every frame while skin is on so the
    // pattern / foil lighting tracks ANY transform change — drag tilt,
    // flipReveal, playCard, dealCard, the lot. The cost is per-frame
    // uniform writes; cheap relative to the mesh draws.
    if (this.skinsActive) this.card.refreshTilt();
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
    wear: t.wear,
  };
}
