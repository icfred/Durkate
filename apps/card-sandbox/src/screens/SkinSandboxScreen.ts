import type { Card } from "@durak/engine";
import { decode, rollCode, type SkinAssets, SkinnedCard } from "@durak/skins-spike";
import { spacing } from "@durak/ui";
import { Container, type Ticker, type TickerCallback } from "pixi.js";
import { CARD_H, CARD_W, CardView } from "../cards/CardView.js";
import { HelpCard } from "./HelpCard.js";
import type { Screen } from "./types.js";

const SEED = 0xc0ffee;

// Display scale — bumps the rendered card size from the 60×88 base used by
// the Durak game (where cards live in a tighter HUD) to something more
// presentational. Layout uses the scaled width/height so neighbours stay
// outside the rendered footprint.
const DISPLAY_SCALE = 1.2;
const CELL_W = CARD_W * DISPLAY_SCALE;
const CELL_H = CARD_H * DISPLAY_SCALE;
const CELL_GAP = spacing.md;
// Ripple parameters. `FOCUS_BOOST` is the scale multiplier the focused
// card lerps toward; surrounding cards lerp toward 1. `OFFSET_PEAK` is
// the radial push (in pixels) experienced by the immediate neighbour and
// falls off with Gaussian distance.
const FOCUS_BOOST = 1.35;
const OFFSET_PEAK = 18;
const FALLOFF_SIGMA = 1.6;
const LERP = 0.22;

const SAMPLE_SUITS = ["spades", "hearts", "diamonds", "clubs"] as const;
const SAMPLE_RANKS = [6, 7, 8, 9, 10, 11, 12, 13, 14] as const;

function sampleCard(i: number): Card {
  const suit = SAMPLE_SUITS[i % SAMPLE_SUITS.length] ?? "spades";
  const rank = SAMPLE_RANKS[Math.floor(i / SAMPLE_SUITS.length) % SAMPLE_RANKS.length] ?? 6;
  return { suit, rank };
}

interface SkinTile {
  code: string;
  view: SkinnedCard;
  baseView: CardView;
}

interface CardSlot {
  // Either a skinned card (with a rolled code) or the special help tile.
  view: SkinnedCard | HelpCard;
  // Closure that toggles the focus border. For SkinnedCard this drills into
  // the wrapped CardView; for HelpCard it's a direct call.
  setFocus: (focused: boolean) => void;
  isHelp: boolean;
  code: string | null;
  // Grid coordinates. Used for ripple-distance computation and for arrow
  // navigation on a per-row basis (so ArrowUp/Down moves whole rows even
  // when the bottom row is incomplete).
  row: number;
  col: number;
  // Centre-of-cell base / current position. Each view has pivot at its
  // own centre so scale expands symmetrically; world position therefore
  // tracks the cell centre rather than the top-left corner.
  baseX: number;
  baseY: number;
  curX: number;
  curY: number;
  curScale: number;
}

export interface SkinSandboxScreenOptions {
  assets: SkinAssets;
  ticker: Ticker;
  /** Hook for the host to spawn the explainer modal when the help card fires. */
  onShowHelp(): void;
  /** Hook for click-to-tuner navigation. */
  onOpenTuner(code: string): void;
}

export class SkinSandboxScreen extends Container implements Screen {
  private readonly ticker: Ticker;
  private readonly assets: SkinAssets;
  private readonly grid: Container;
  // Persistent pool of rolled skin tiles. Survives resizes so the user
  // doesn't see the deck reshuffle when the grid rebuilds — the tiles
  // are simply re-slotted, with extras hidden when the new layout has
  // fewer cells.
  private readonly tiles: SkinTile[] = [];
  private helpTile: HelpCard | null = null;
  private readonly slots: CardSlot[] = [];
  private readonly tickCallback: TickerCallback<unknown>;
  private readonly onShowHelp: () => void;
  private readonly onOpenTuner: (code: string) => void;
  private rngState = SEED;
  private viewWidth = 0;
  private viewHeight = 0;
  private cols = 0;
  private rows = 0;
  // Index into `slots` of the currently-focused (hovered or arrow-nav'd)
  // tile. -1 means "no focus, lerp every cell back to base". Mouse leave
  // and Esc both clear focus this way.
  private focusedIndex = -1;
  private detachKey: (() => void) | null = null;

  constructor(options: SkinSandboxScreenOptions) {
    super();
    this.ticker = options.ticker;
    this.assets = options.assets;
    this.onShowHelp = options.onShowHelp;
    this.onOpenTuner = options.onOpenTuner;

    this.grid = new Container();
    this.addChild(this.grid);

    this.tickCallback = () => this.onTick();
    this.ticker.add(this.tickCallback);

    this.attachKeyboard();
  }

  layout(viewWidth: number, viewHeight: number): void {
    this.viewWidth = viewWidth;
    this.viewHeight = viewHeight;
    this.relayout();
  }

  dispose(): void {
    this.ticker.remove(this.tickCallback);
    this.detachKey?.();
    this.detachKey = null;
  }

  private relayout(): void {
    if (this.viewWidth <= 0 || this.viewHeight <= 0) return;
    const margin = spacing.lg;
    const innerW = Math.max(CELL_W, this.viewWidth - margin * 2);
    const innerH = Math.max(CELL_H, this.viewHeight - margin * 2);
    const cols = Math.max(1, Math.floor((innerW + CELL_GAP) / (CELL_W + CELL_GAP)));
    const rows = Math.max(1, Math.floor((innerH + CELL_GAP) / (CELL_H + CELL_GAP)));
    const total = cols * rows;
    const helpRow = Math.floor(rows / 2);
    const helpCol = Math.floor(cols / 2);
    const helpIndex = helpRow * cols + helpCol;
    this.cols = cols;
    this.rows = rows;

    // Make sure we have enough rolled skin tiles for every non-help cell.
    const skinNeeded = total - 1;
    while (this.tiles.length < skinNeeded) {
      const idx = this.tiles.length;
      const code = rollCode(this.nextRand);
      const baseView = new CardView(sampleCard(idx));
      const view = new SkinnedCard({
        base: baseView,
        baseWidth: CARD_W,
        baseHeight: CARD_H,
        assets: this.assets,
      });
      view.applySkin(decode(code), { pattern: true, tint: true, finish: true });
      view.eventMode = "static";
      view.cursor = "pointer";
      // Pivot at centre so scale expands symmetrically — without this
      // the focused card grew down + right out of its cell and crowded
      // its neighbours on those edges.
      view.pivot.set(CARD_W / 2, CARD_H / 2);
      view.on("pointertap", () => this.onOpenTuner(code));
      this.tiles.push({ code, view, baseView });
    }
    if (!this.helpTile) {
      this.helpTile = new HelpCard();
      this.helpTile.pivot.set(CARD_W / 2, CARD_H / 2);
      this.helpTile.onActivate = () => this.onShowHelp();
    }

    // Detach everything from the grid; we'll re-add only the visible
    // slots so leftover tiles don't paint at stale positions.
    this.grid.removeChildren();
    this.slots.length = 0;
    let skinCursor = 0;
    for (let i = 0; i < total; i++) {
      const row = Math.floor(i / cols);
      const col = i % cols;
      // Centre-of-cell coords. View.position is the world coord of the
      // pivot, which is the card centre.
      const baseX = col * (CELL_W + CELL_GAP) + CELL_W / 2;
      const baseY = row * (CELL_H + CELL_GAP) + CELL_H / 2;
      if (i === helpIndex) {
        const help = this.helpTile;
        if (!help) continue;
        this.grid.addChild(help);
        this.slots.push({
          view: help,
          setFocus: (f) => help.setFocus(f),
          isHelp: true,
          code: null,
          row,
          col,
          baseX,
          baseY,
          curX: baseX,
          curY: baseY,
          curScale: DISPLAY_SCALE,
        });
        help.x = baseX;
        help.y = baseY;
        help.scale.set(DISPLAY_SCALE);
        this.attachHover(this.slots.length - 1);
        continue;
      }
      const tile = this.tiles[skinCursor++];
      if (!tile) continue;
      this.grid.addChild(tile.view);
      this.slots.push({
        view: tile.view,
        setFocus: (f) => tile.baseView.setFocus(f),
        isHelp: false,
        code: tile.code,
        row,
        col,
        baseX,
        baseY,
        curX: baseX,
        curY: baseY,
        curScale: DISPLAY_SCALE,
      });
      tile.view.x = baseX;
      tile.view.y = baseY;
      tile.view.scale.set(DISPLAY_SCALE);
      this.attachHover(this.slots.length - 1);
    }

    // Centre the grid in the viewport. Width includes per-cell width +
    // gaps; baseX/baseY are cell centres so the leftmost column starts
    // at baseX_first - CELL_W/2 = 0 in grid-local coordinates.
    const gridW = cols * CELL_W + (cols - 1) * CELL_GAP;
    const gridH = rows * CELL_H + (rows - 1) * CELL_GAP;
    this.grid.x = Math.round((this.viewWidth - gridW) / 2);
    this.grid.y = Math.round((this.viewHeight - gridH) / 2);

    // Reset focus when the grid shape changes — the previous focused
    // index may now point at a different cell.
    this.focusedIndex = -1;
  }

  private attachHover(index: number): void {
    const view = this.slots[index]?.view;
    if (!view) return;
    view.removeAllListeners("pointerenter");
    view.removeAllListeners("pointerleave");
    view.on("pointerenter", () => {
      this.setFocusedIndex(index);
    });
    view.on("pointerleave", () => {
      if (this.focusedIndex === index) this.setFocusedIndex(-1);
    });
  }

  private setFocusedIndex(next: number): void {
    if (this.focusedIndex === next) return;
    this.focusedIndex = next;
  }

  private attachKeyboard(): void {
    const handler = (event: KeyboardEvent): void => {
      const key = event.key;
      if (key === "Escape") {
        if (this.focusedIndex !== -1) {
          event.preventDefault();
          this.setFocusedIndex(-1);
        }
        return;
      }
      if (
        key !== "ArrowUp" &&
        key !== "ArrowDown" &&
        key !== "ArrowLeft" &&
        key !== "ArrowRight" &&
        key !== "Enter" &&
        key !== " "
      ) {
        return;
      }
      event.preventDefault();
      if (key === "Enter" || key === " ") {
        this.activateFocused();
        return;
      }
      this.moveFocus(key);
    };
    window.addEventListener("keydown", handler);
    this.detachKey = () => window.removeEventListener("keydown", handler);
  }

  private moveFocus(key: "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight"): void {
    if (this.slots.length === 0 || this.cols === 0) return;
    let idx = this.focusedIndex;
    if (idx === -1) {
      // Cold start — drop into the centre tile (the help card) so the
      // first arrow press is predictable. The user said the "?" "always
      // spawns in the middle", so anchoring focus there matches.
      const helpRow = Math.floor(this.rows / 2);
      const helpCol = Math.floor(this.cols / 2);
      idx = helpRow * this.cols + helpCol;
    } else {
      const row = Math.floor(idx / this.cols);
      const col = idx % this.cols;
      let nextRow = row;
      let nextCol = col;
      if (key === "ArrowLeft") nextCol = Math.max(0, col - 1);
      if (key === "ArrowRight") nextCol = Math.min(this.cols - 1, col + 1);
      if (key === "ArrowUp") nextRow = Math.max(0, row - 1);
      if (key === "ArrowDown") nextRow = Math.min(this.rows - 1, row + 1);
      idx = nextRow * this.cols + nextCol;
    }
    if (idx >= this.slots.length) idx = this.slots.length - 1;
    this.setFocusedIndex(idx);
  }

  private activateFocused(): void {
    const slot = this.slots[this.focusedIndex];
    if (!slot) return;
    if (slot.isHelp) {
      this.onShowHelp();
      return;
    }
    if (slot.code) this.onOpenTuner(slot.code);
  }

  private onTick(): void {
    if (this.slots.length === 0) return;
    const focused = this.slots[this.focusedIndex];
    for (let i = 0; i < this.slots.length; i++) {
      const slot = this.slots[i];
      if (!slot) continue;
      let targetScale = DISPLAY_SCALE;
      let targetX = slot.baseX;
      let targetY = slot.baseY;
      if (focused) {
        if (focused === slot) {
          targetScale = DISPLAY_SCALE * FOCUS_BOOST;
        } else {
          const dx = slot.col - focused.col;
          const dy = slot.row - focused.row;
          const d2 = dx * dx + dy * dy;
          const falloff = Math.exp(-d2 / (2 * FALLOFF_SIGMA * FALLOFF_SIGMA));
          const dist = Math.sqrt(d2);
          if (dist > 0) {
            const push = OFFSET_PEAK * falloff;
            targetX += (dx / dist) * push;
            targetY += (dy / dist) * push;
          }
        }
      }
      slot.curX += (targetX - slot.curX) * LERP;
      slot.curY += (targetY - slot.curY) * LERP;
      slot.curScale += (targetScale - slot.curScale) * LERP;
      slot.view.x = slot.curX;
      slot.view.y = slot.curY;
      slot.view.scale.set(slot.curScale);
      // Keep the focused tile rendered above its neighbours so the boost
      // doesn't get clipped by adjacent cards' bounds.
      if (focused === slot) this.grid.setChildIndex(slot.view, this.grid.children.length - 1);
      // Translate ripple state into the help-card / skinned-card focus
      // border treatment so the visual cue isn't purely positional.
      slot.setFocus(focused === slot);
    }
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
