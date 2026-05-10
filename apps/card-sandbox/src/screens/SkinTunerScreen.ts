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
  discardCard,
  FocusManager,
  flipReveal,
  LABEL_ROW_HEIGHT,
  LabelRow,
  NumberStepper,
  Panel,
  playCard,
  SectionHeader,
  Stack,
  shakeCard,
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
import { buildCardName, type CardName, GRADE_COLOR } from "./cardName.js";
import type { Screen } from "./types.js";

// ─── Tuning constants ──────────────────────────────────────────────────────

const TILT_MAX_RAD = 0.22;
const TILT_FORESHORTEN = 0.1;
const TILT_LERP = 0.18;
const DRAG_TAP_THRESHOLD_PX = 5;
// Auto-revert: after this many ms post-animation, if the front face is
// showing, flip back to the skinned back. Keeps the tuner anchored on
// the skin (which is the thing being tuned) regardless of which anim
// the user just played.
const REVERT_DELAY_MS = 1600;

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
  // Generated CS:GO-style verbose name + colour-coded grade pill. Both
  // are recomputed on every applyAll (whenever spec / tunables change)
  // and are rendered inside the scroll panel under the title.
  private nameText!: Text;
  private gradeText!: Text;
  // Hover tooltip for the name. Lives on the screen container (outside
  // the scroll mask) so it can paint above the panel without being
  // clipped.
  private tooltip: Container | null = null;
  private readonly backBtn: Button | null;
  private readonly tickCallback: TickerCallback<unknown>;
  private readonly scrollMask: Graphics;
  private readonly pulls: Pull[] = [];
  private spec: SkinSpec = decode("000000000000");
  private tunables: Tunables = cloneTunables(defaultTunables);
  // Skin is always applied — the master toggle was dropped because the
  // per-axis sub-toggles below give the same per-layer isolation.
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
  private dragMoved = false;
  private dragStartX = 0;
  private dragStartY = 0;
  private currentTiltX = 0;
  private currentTiltY = 0;
  private targetTiltX = 0;
  private targetTiltY = 0;
  // Active animation tween, kept so a second click cancels the first
  // instead of stacking. Cleared by the tween's own onComplete.
  private activeAnim: TweenHandle | null = null;
  // Speed multiplier for animation playback. 1 = real-time, 2 = double
  // speed, 0.25 = quarter speed. Driven by the SPEED stepper below.
  private animSpeed = 1;
  // Auto-revert timer — flips the front back to the skinned face after
  // a short delay so the user always lands on the skin tuner's primary
  // surface regardless of which animation just ran.
  private revertTimer: ReturnType<typeof setTimeout> | null = null;
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
    this.card.on("pointerdown", (e: FederatedPointerEvent) => this.startDrag(e));
    this.eventMode = "static";
    this.on("globalpointermove", (e: FederatedPointerEvent) => {
      if (this.dragging) this.handleDragMove(e);
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
    if (this.revertTimer) {
      clearTimeout(this.revertTimer);
      this.revertTimer = null;
    }
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

  private startDrag(e: FederatedPointerEvent): void {
    this.dragging = true;
    this.dragMoved = false;
    this.dragStartX = e.global.x;
    this.dragStartY = e.global.y;
    this.card.cursor = "grabbing";
  }

  private handleDragMove(e: FederatedPointerEvent): void {
    if (!this.dragMoved) {
      const dx = e.global.x - this.dragStartX;
      const dy = e.global.y - this.dragStartY;
      // Above this threshold the press is treated as a drag (tilt the
      // card); below it endDrag treats the gesture as a click and
      // resets to flat. `pointertap` fires inconsistently when the
      // card is also a globalpointermove target, so we manage the
      // drag-vs-tap split ourselves.
      if (dx * dx + dy * dy > DRAG_TAP_THRESHOLD_PX * DRAG_TAP_THRESHOLD_PX) {
        this.dragMoved = true;
      }
    }
    if (this.dragMoved) this.updateTiltTarget(e);
  }

  private endDrag(): void {
    if (!this.dragging) return;
    this.dragging = false;
    this.card.cursor = "grab";
    if (!this.dragMoved) this.resetTilt();
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

    // Header — title, generated name, grade pill, 12-char code.
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
    // Name + grade build the verbose CS:GO-style descriptor and
    // colour-coded grade pill. Name wraps to the panel inner width so
    // long descriptors don't overflow.
    this.nameText = new Text({
      text: "",
      style: {
        fontFamily: typography.family,
        fontSize: typography.size.sm,
        fontWeight: typography.weight.bold,
        fill: color.text,
        letterSpacing: typography.letterSpacing.tight,
        wordWrap: true,
        wordWrapWidth: ROW_WIDTH,
      },
    });
    this.nameText.eventMode = "static";
    this.nameText.cursor = "help";
    this.nameText.on("pointerover", () => this.showNameTooltip());
    this.nameText.on("pointerout", () => this.hideNameTooltip());
    root.add(this.nameText);

    this.gradeText = new Text({
      text: "",
      style: {
        fontFamily: typography.family,
        fontSize: typography.size.sm,
        fontWeight: typography.weight.bold,
        fill: color.textMuted,
        letterSpacing: typography.letterSpacing.stamp,
      },
    });
    root.add(this.gradeText);

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

    // AXES — three sub-toggles for the individual layers. Always
    // active; the master "ENABLE SKIN" toggle was dropped since the
    // axes alone give the same per-layer control without the confusing
    // "all on, but it gates everything else" surprise.
    root.add(new SectionHeader("AXES"));
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
        label: "LAYERS",
        control: axisRow,
        width: ROW_WIDTH,
        height: LABEL_ROW_HEIGHT + spacing.xs,
      }),
    );

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
          // Single STRENGTH stepper that targets whichever finish layer
          // applies — metal for silver/gold/bronze, holographic for the
          // holo finish, no-op for matte. Consolidates the previous
          // METAL STR + HOLO STR pair, which were mutually exclusive
          // anyway (a card can't be both metal and holo at once).
          this.numberRow("STRENGTH", {
            min: 0,
            max: 1,
            step: 0.01,
            read: () => this.readFinishStrength(),
            write: (v) => this.writeFinishStrength(v),
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

    // ANIMATIONS — preview-card gestures. Two rows of buttons plus a
    // speed multiplier so the user can slow-mo for inspection or
    // accelerate for rapid iteration.
    root.add(new SectionHeader("ANIMATIONS"));
    const animGap = spacing.xs;
    const animBtnWidth = Math.floor((ROW_WIDTH - animGap * 2) / 3);
    const animRow1 = new Stack({ direction: "horizontal", gap: animGap });
    animRow1.add(this.buildAnimButton("FLIP", animBtnWidth, () => this.runFlip()));
    animRow1.add(this.buildAnimButton("PLAY", animBtnWidth, () => this.runPlay()));
    animRow1.add(this.buildAnimButton("DEAL", animBtnWidth, () => this.runDeal()));
    root.add(animRow1);
    const animRow2 = new Stack({ direction: "horizontal", gap: animGap });
    animRow2.add(this.buildAnimButton("DISCARD", animBtnWidth, () => this.runDiscard()));
    animRow2.add(this.buildAnimButton("SHAKE", animBtnWidth, () => this.runShake()));
    root.add(animRow2);

    const speedStepper = new NumberStepper({
      value: this.animSpeed,
      min: 0.25,
      max: 4,
      step: 0.25,
      format: (v) => `${v.toFixed(2)}×`,
      onChange: (v) => {
        this.animSpeed = v;
      },
      width: CONTROL_WIDTH,
    });
    this.focus.register(speedStepper);
    root.add(
      new LabelRow({
        label: "SPEED",
        control: speedStepper,
        width: ROW_WIDTH,
        height: LABEL_ROW_HEIGHT,
      }),
    );

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
    // Also drop any pending revert-to-back timer; the new animation
    // will reschedule one when it finishes if needed.
    if (this.revertTimer) {
      clearTimeout(this.revertTimer);
      this.revertTimer = null;
    }
  }

  private buildAnimButton(label: string, width: number, onActivate: () => void): Button {
    return new Button({ label, width, height: 28, onActivate });
  }

  private animDuration(baseMs: number): number {
    // Larger animSpeed shortens the duration. Min clamp guards against
    // accidentally producing zero-duration tweens.
    return Math.max(60, Math.round(baseMs / this.animSpeed));
  }

  private runFlip(): void {
    this.cancelAnim();
    this.activeAnim = flipReveal({
      target: this.card,
      ticker: this.ticker,
      durationMs: this.animDuration(600),
      onMidpoint: () => this.swapFace(),
      onComplete: () => this.finishAnim(),
    });
  }

  private runPlay(): void {
    this.cancelAnim();
    this.activeAnim = playCard({
      target: this.card,
      ticker: this.ticker,
      durationMs: this.animDuration(900),
      onComplete: () => this.finishAnim(),
    });
  }

  private runDeal(): void {
    this.cancelAnim();
    // DEAL starts face-down (the back) so the flip mid-flight reveals
    // the face on landing. Force visibility before the tween runs in
    // case a previous flip left the front showing.
    this.card.visible = true;
    this.cardFront.visible = false;
    this.activeAnim = dealCard({
      target: this.card,
      ticker: this.ticker,
      durationMs: this.animDuration(900),
      onMidpoint: () => this.swapFace(),
      onComplete: () => this.finishAnim(),
    });
  }

  private runDiscard(): void {
    this.cancelAnim();
    this.activeAnim = discardCard({
      target: this.card,
      ticker: this.ticker,
      durationMs: this.animDuration(600),
      onComplete: () => this.finishAnim(),
    });
  }

  private runShake(): void {
    this.cancelAnim();
    this.activeAnim = shakeCard({
      target: this.card,
      ticker: this.ticker,
      durationMs: this.animDuration(420),
      onComplete: () => this.finishAnim(),
    });
  }

  private finishAnim(): void {
    this.activeAnim = null;
    this.scheduleRevertToBack();
  }

  private scheduleRevertToBack(): void {
    if (this.revertTimer) clearTimeout(this.revertTimer);
    this.revertTimer = setTimeout(() => {
      this.revertTimer = null;
      // Only revert if we're parked on the front face. If the user
      // clicked PLAY / DISCARD / SHAKE while on the back, no flip is
      // needed.
      if (this.cardFront.visible) this.runFlip();
    }, REVERT_DELAY_MS);
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
    this.card.applySkin(this.spec, this.axes);
    // Front face (revealed by FLIP / DEAL) tracks the current BODY
    // colourway so the front looks like the same card stock as the
    // back, not a generic cream rectangle.
    const bodyColor =
      CARD_BACKGROUNDS[this.spec.cardBackground]?.color ?? CARD_BACKGROUNDS[0]?.color ?? 0xefebd9;
    this.cardFront.setSurface(bodyColor);
    // Pull every control's displayed value back from the current spec /
    // tunables. Most pulls are no-ops (value unchanged → no redraw),
    // but cross-field dependencies (e.g. STRENGTH reads from a
    // different tunable depending on FINISH) need this to stay in sync.
    for (const pull of this.pulls) pull();
    this.refreshName();
  }

  private readFinishStrength(): number {
    const finish = this.spec.finish;
    if (finish === "holographic") return this.tunables.foil.holographicStrength;
    if (finish === "matte") return 0;
    return this.tunables.foil.metalStrength;
  }

  private writeFinishStrength(v: number): void {
    const finish = this.spec.finish;
    if (finish === "matte") return;
    if (finish === "holographic") {
      this.tunables = {
        ...this.tunables,
        foil: { ...this.tunables.foil, holographicStrength: v },
      };
    } else {
      this.tunables = {
        ...this.tunables,
        foil: { ...this.tunables.foil, metalStrength: v },
      };
    }
    this.card.setTunables(this.tunables);
    this.refreshName();
  }

  private currentName: CardName | null = null;

  private refreshName(): void {
    // nameText/gradeText are created in buildPanel; refreshName is
    // called from applyAll which fires before buildPanel during the
    // first construction. Bail until the texts exist.
    if (!this.nameText || !this.gradeText) return;
    const name = buildCardName(this.spec, this.tunables);
    this.currentName = name;
    this.nameText.text = name.full;
    this.gradeText.text = `GRADE  ${name.grade}  (${name.totalRarity})`;
    this.gradeText.style.fill = GRADE_COLOR[name.grade];
    if (this.tooltip) this.refreshTooltipBody();
  }

  private showNameTooltip(): void {
    if (this.tooltip) return;
    const name = this.currentName ?? buildCardName(this.spec, this.tunables);
    const tooltip = new Container();
    tooltip.eventMode = "none";
    const bg = new Graphics();
    tooltip.addChild(bg);
    const body = new Text({
      text: this.tooltipBodyFor(name),
      style: {
        fontFamily: typography.family,
        fontSize: typography.size.xs,
        fill: color.text,
        letterSpacing: typography.letterSpacing.tight,
        lineHeight: 16,
      },
    });
    body.x = spacing.sm;
    body.y = spacing.sm;
    body.label = "tooltip-body";
    tooltip.addChild(body);
    const w = Math.ceil(body.width) + spacing.sm * 2;
    const h = Math.ceil(body.height) + spacing.sm * 2;
    bg.roundRect(0, 0, w, h, 4)
      .fill({ color: color.bgDeep, alpha: 0.95 })
      .stroke({ color: color.border, width: 1, alignment: 0 });
    // Position tooltip just to the right of the panel so it doesn't
    // get clipped by the scroll mask. Centred vertically on the name.
    const namePos = this.nameText.getGlobalPosition();
    tooltip.x = Math.round(this.panel.x + PANEL_WIDTH + spacing.sm);
    tooltip.y = Math.round(namePos.y);
    this.addChild(tooltip);
    this.tooltip = tooltip;
  }

  private hideNameTooltip(): void {
    if (!this.tooltip) return;
    this.removeChild(this.tooltip);
    this.tooltip.destroy({ children: true });
    this.tooltip = null;
  }

  private refreshTooltipBody(): void {
    if (!this.tooltip || !this.currentName) return;
    const body = this.tooltip.getChildByLabel?.("tooltip-body") as Text | null;
    if (!body) return;
    body.text = this.tooltipBodyFor(this.currentName);
  }

  private tooltipBodyFor(name: CardName): string {
    const lines: string[] = [];
    for (const c of name.components) {
      // Pad to keep columns roughly aligned in monospace. Label width
      // 9, value width 22, then word.
      const label = c.label.padEnd(9);
      const value = c.value.padEnd(22);
      lines.push(`${label} ${value} ${c.word}`);
    }
    lines.push("");
    lines.push(`RARITY    ${name.totalRarity}                      ${name.grade}`);
    return lines.join("\n");
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
    // Refresh skin shader uniforms every frame so the pattern / foil
    // lighting tracks ANY transform change — drag tilt, flipReveal,
    // playCard, dealCard, the lot. The cost is per-frame uniform
    // writes; cheap relative to the mesh draws.
    this.card.refreshTilt();
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
