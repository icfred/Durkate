import type { Card } from "@durak/engine";
import { type Axes, decode, rollCode, type SkinAssets, SkinnedCard } from "@durak/skins-spike";
import { Button, color, FocusManager, spacing, stroke, typography } from "@durak/ui";
import { Container, Graphics, Text, type Ticker, type TickerCallback } from "pixi.js";
import { CARD_H, CARD_W, CardView } from "../../cards/CardView.js";
import type { Screen } from "../../screens/types.js";

const COUNT_OPTIONS: readonly number[] = [36, 72, 144];
const SEED = 0xc0ffee;

const SAMPLE_SUITS = ["spades", "hearts", "diamonds", "clubs"] as const;
const SAMPLE_RANKS = [6, 7, 8, 9, 10, 11, 12, 13, 14] as const;

function sampleCard(i: number): Card {
  const suit = SAMPLE_SUITS[i % SAMPLE_SUITS.length] ?? "spades";
  const rank = SAMPLE_RANKS[Math.floor(i / SAMPLE_SUITS.length) % SAMPLE_RANKS.length] ?? 6;
  return { suit, rank };
}

interface AxisToggleOptions {
  label: string;
  initial: boolean;
  onChange(active: boolean): void;
}

class AxisToggle extends Container {
  private readonly bg: Graphics;
  private readonly text: Text;
  private active: boolean;
  private hovered = false;
  private readonly w: number;
  private readonly h = 32;
  private readonly onChange: (active: boolean) => void;

  constructor(options: AxisToggleOptions) {
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
    this.w = Math.max(80, Math.ceil(this.text.width) + spacing.md * 2);
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
    const border = this.active ? color.borderFocus : this.hovered ? color.border : color.border;
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

  get chipHeight(): number {
    return this.h;
  }
}

export interface SkinSandboxScreenOptions {
  assets: SkinAssets;
  ticker: Ticker;
}

export class SkinSandboxScreen extends Container implements Screen {
  private readonly ticker: Ticker;
  private readonly assets: SkinAssets;
  private readonly grid: Container;
  private readonly toolbar: Container;
  private readonly fpsLabel: Text;
  private readonly cards: SkinnedCard[] = [];
  private readonly codes: string[] = [];
  private readonly axes: Axes = { pattern: true, tint: true, finish: true, motion: true };
  private readonly focus = new FocusManager();
  private readonly tickCallback: TickerCallback<unknown>;
  private cardCount = 36;
  private rngState = SEED;
  private fpsFrames = 0;
  private fpsAccumMs = 0;
  private viewWidth = 0;
  private skinsActive = true;

  constructor(options: SkinSandboxScreenOptions) {
    super();
    this.ticker = options.ticker;
    this.assets = options.assets;

    this.toolbar = new Container();
    this.addChild(this.toolbar);

    this.grid = new Container();
    this.addChild(this.grid);

    this.fpsLabel = new Text({
      text: "FPS --  CARDS --",
      style: {
        fontFamily: typography.family,
        fontSize: typography.size.sm,
        fontWeight: typography.weight.bold,
        fill: color.accent,
        letterSpacing: typography.letterSpacing.wide,
      },
    });

    this.buildToolbar();
    this.rerollAll();
    this.layoutGrid();

    this.tickCallback = (t) => this.onTick(t);
    this.ticker.add(this.tickCallback);

    this.focus.attach();
  }

  layout(viewWidth: number, _viewHeight: number): void {
    this.viewWidth = viewWidth;
    this.toolbar.x = spacing.lg;
    this.toolbar.y = spacing.md;
    this.fpsLabel.x = viewWidth - this.fpsLabel.width - spacing.lg;
    this.fpsLabel.y = spacing.md + 8;
    this.layoutGrid();
  }

  dispose(): void {
    this.ticker.remove(this.tickCallback);
    this.focus.detach();
    this.focus.clear();
  }

  private buildToolbar(): void {
    const reroll = new Button({
      label: "REROLL ALL",
      width: 160,
      height: 36,
      onActivate: () => {
        this.rerollAll();
      },
    });
    reroll.x = 0;
    reroll.y = 0;
    this.toolbar.addChild(reroll);
    this.focus.register(reroll);

    const countButtons: Button[] = COUNT_OPTIONS.map((n, i) => {
      const btn = new Button({
        label: `${n}`,
        width: 56,
        height: 36,
        onActivate: () => {
          this.setCardCount(n);
          countButtons.forEach((b, j) => {
            b.setLabel(j === i ? `[${COUNT_OPTIONS[j]}]` : `${COUNT_OPTIONS[j]}`);
          });
        },
      });
      btn.x = 180 + i * 60;
      btn.y = 0;
      this.toolbar.addChild(btn);
      this.focus.register(btn);
      if (n === this.cardCount) btn.setLabel(`[${n}]`);
      return btn;
    });

    const noSkinBtn = new Button({
      label: this.skinsActive ? "NO-SKIN PRESET" : "[NO-SKIN PRESET]",
      width: 200,
      height: 36,
      onActivate: () => {
        this.skinsActive = !this.skinsActive;
        noSkinBtn.setLabel(this.skinsActive ? "NO-SKIN PRESET" : "[NO-SKIN PRESET]");
        this.applyAll();
      },
    });
    noSkinBtn.x = 180 + COUNT_OPTIONS.length * 60 + 20;
    noSkinBtn.y = 0;
    this.toolbar.addChild(noSkinBtn);
    this.focus.register(noSkinBtn);

    const axisRow = new Container();
    axisRow.y = 44;
    this.toolbar.addChild(axisRow);

    const axisKeys: ReadonlyArray<keyof Axes> = ["pattern", "tint", "finish", "motion"];
    let xOff = 0;
    for (const key of axisKeys) {
      const toggle = new AxisToggle({
        label: String(key).toUpperCase(),
        initial: this.axes[key],
        onChange: (active) => {
          this.axes[key] = active;
          this.applyAll();
        },
      });
      toggle.x = xOff;
      axisRow.addChild(toggle);
      xOff += toggle.chipWidth + spacing.sm;
    }

    this.addChild(this.fpsLabel);
  }

  private rerollAll(): void {
    this.codes.length = 0;
    for (let i = 0; i < this.cardCount; i += 1) {
      this.codes.push(rollCode(this.nextRand));
    }
    this.ensureCards();
    this.applyAll();
  }

  private setCardCount(count: number): void {
    if (count === this.cardCount) return;
    this.cardCount = count;
    while (this.codes.length < count) this.codes.push(rollCode(this.nextRand));
    this.codes.length = count;
    this.ensureCards();
    this.applyAll();
    this.layoutGrid();
  }

  private ensureCards(): void {
    while (this.cards.length < this.codes.length) {
      const idx = this.cards.length;
      const base = new CardView(sampleCard(idx));
      const card = new SkinnedCard({
        base,
        baseWidth: CARD_W,
        baseHeight: CARD_H,
        assets: this.assets,
      });
      this.cards.push(card);
      this.grid.addChild(card);
    }
    while (this.cards.length > this.codes.length) {
      const card = this.cards.pop();
      if (!card) break;
      this.grid.removeChild(card);
      card.destroy({ children: true });
    }
  }

  private applyAll(): void {
    for (let i = 0; i < this.cards.length; i += 1) {
      const code = this.codes[i];
      const card = this.cards[i];
      if (!code || !card) continue;
      card.applySkin(this.skinsActive ? decode(code) : null, this.axes);
    }
    this.fpsLabel.text = `FPS --  CARDS ${this.cards.length}`;
  }

  private layoutGrid(): void {
    if (this.viewWidth === 0) return;
    const gap = spacing.md;
    const left = spacing.lg;
    const top = spacing.md + 44 + 32 + spacing.lg;
    const usableWidth = this.viewWidth - left * 2;
    const cols = Math.max(1, Math.floor((usableWidth + gap) / (CARD_W + gap)));
    this.grid.x = left;
    this.grid.y = top;
    for (let i = 0; i < this.cards.length; i += 1) {
      const card = this.cards[i];
      if (!card) continue;
      const col = i % cols;
      const row = Math.floor(i / cols);
      card.x = col * (CARD_W + gap);
      card.y = row * (CARD_H + gap);
    }
  }

  private onTick(ticker: Ticker): void {
    this.fpsFrames += 1;
    this.fpsAccumMs += ticker.deltaMS;
    if (this.fpsAccumMs >= 500) {
      const fps = Math.round((this.fpsFrames * 1000) / this.fpsAccumMs);
      this.fpsLabel.text = `FPS ${fps}  CARDS ${this.cards.length}`;
      this.fpsFrames = 0;
      this.fpsAccumMs = 0;
      this.layoutFps();
    }
    if (this.skinsActive && this.axes.motion && this.axes.finish) {
      const t = performance.now() / 1000;
      for (const card of this.cards) card.tick(t);
    }
  }

  private layoutFps(): void {
    if (this.viewWidth === 0) return;
    this.fpsLabel.x = this.viewWidth - this.fpsLabel.width - spacing.lg;
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
