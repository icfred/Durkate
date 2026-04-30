import { color, spacing, stroke, typography } from "@durak/ui";
import { Container, Graphics, Text, type Ticker } from "pixi.js";
import {
  type Easing,
  easeInOutCubic,
  easeInQuad,
  easeOutBack,
  easeOutQuad,
  fadeTo,
  linear,
  moveTo,
  parallel,
  scaleTo,
  sequence,
  type TweenHandle,
} from "../../anim/index.js";
import type { Screen } from "../../screens/types.js";

const CELL_W = 220;
const CELL_H = 120;
const SQUARE = 28;
const TRACK_PAD = 24;

class Cell extends Container {
  readonly square: Graphics;
  readonly trackLeft: number;
  readonly trackRight: number;
  readonly midY: number;
  private active: TweenHandle | null = null;
  private cancelled = false;

  constructor(label: string) {
    super();
    const bg = new Graphics()
      .roundRect(0, 0, CELL_W, CELL_H, 4)
      .fill({ color: color.surface })
      .stroke({ color: color.border, width: stroke.thin, alignment: 0 });
    this.addChild(bg);

    const title = new Text({
      text: label,
      style: {
        fontFamily: typography.family,
        fontSize: typography.size.xs,
        fontWeight: typography.weight.bold,
        fill: color.textMuted,
        letterSpacing: typography.letterSpacing.wide,
      },
    });
    title.x = spacing.sm;
    title.y = spacing.sm;
    this.addChild(title);

    this.trackLeft = TRACK_PAD;
    this.trackRight = CELL_W - TRACK_PAD - SQUARE;
    this.midY = Math.round(CELL_H / 2 + 8 - SQUARE / 2);

    this.square = new Graphics()
      .rect(-SQUARE / 2, -SQUARE / 2, SQUARE, SQUARE)
      .fill({ color: color.accent })
      .stroke({ color: color.accentBright, width: stroke.thin, alignment: 0 });
    this.square.x = this.trackLeft + SQUARE / 2;
    this.square.y = this.midY + SQUARE / 2;
    this.addChild(this.square);
  }

  setActive(handle: TweenHandle | null): void {
    if (this.cancelled) {
      handle?.cancel();
      return;
    }
    this.active = handle;
  }

  dispose(): void {
    this.cancelled = true;
    this.active?.cancel();
    this.active = null;
  }
}

interface CellSpec {
  label: string;
  build(cell: Cell, ticker: Ticker): void;
}

function easingDemo(easing: Easing, label: string): CellSpec {
  return {
    label,
    build(cell, ticker) {
      const start = (): void => {
        cell.square.x = cell.trackLeft + SQUARE / 2;
        cell.setActive(
          moveTo(cell.square, cell.trackRight + SQUARE / 2, cell.square.y, 1200, easing, {
            ticker,
            onComplete: () => {
              cell.setActive(
                moveTo(cell.square, cell.trackLeft + SQUARE / 2, cell.square.y, 600, linear, {
                  ticker,
                  onComplete: start,
                }),
              );
            },
          }),
        );
      };
      start();
    },
  };
}

const PRIMITIVES: readonly CellSpec[] = [
  easingDemo(linear, "linear"),
  easingDemo(easeOutQuad, "easeOutQuad"),
  easingDemo(easeInQuad, "easeInQuad"),
  easingDemo(easeInOutCubic, "easeInOutCubic"),
  easingDemo(easeOutBack, "easeOutBack"),
  {
    label: "fadeTo",
    build(cell, ticker) {
      cell.square.x = Math.round(CELL_W / 2);
      const loop = (): void => {
        cell.setActive(
          fadeTo(cell.square, 0.1, 700, easeInOutCubic, {
            ticker,
            onComplete: () => {
              cell.setActive(
                fadeTo(cell.square, 1, 700, easeInOutCubic, { ticker, onComplete: loop }),
              );
            },
          }),
        );
      };
      loop();
    },
  },
  {
    label: "scaleTo",
    build(cell, ticker) {
      cell.square.x = Math.round(CELL_W / 2);
      const loop = (): void => {
        cell.setActive(
          scaleTo(cell.square, 1.6, 600, easeOutBack, {
            ticker,
            onComplete: () => {
              cell.setActive(
                scaleTo(cell.square, 1, 600, easeInOutCubic, { ticker, onComplete: loop }),
              );
            },
          }),
        );
      };
      loop();
    },
  },
  {
    label: "sequence",
    build(cell, ticker) {
      const loop = (): void => {
        cell.square.x = cell.trackLeft + SQUARE / 2;
        const baseY = cell.square.y;
        cell.setActive(
          sequence(
            [
              (done) =>
                moveTo(cell.square, cell.trackRight + SQUARE / 2, baseY, 500, easeOutQuad, {
                  ticker,
                  onComplete: done,
                }),
              (done) =>
                moveTo(cell.square, cell.trackLeft + SQUARE / 2, baseY, 500, easeInQuad, {
                  ticker,
                  onComplete: done,
                }),
            ],
            loop,
          ),
        );
      };
      loop();
    },
  },
  {
    label: "parallel",
    build(cell, ticker) {
      const baseY = cell.square.y;
      const loop = (): void => {
        cell.square.x = cell.trackLeft + SQUARE / 2;
        cell.square.alpha = 1;
        cell.setActive(
          parallel(
            [
              (done) =>
                moveTo(cell.square, cell.trackRight + SQUARE / 2, baseY, 800, easeInOutCubic, {
                  ticker,
                  onComplete: done,
                }),
              (done) => fadeTo(cell.square, 0.3, 800, easeInOutCubic, { ticker, onComplete: done }),
            ],
            () => {
              cell.setActive(
                parallel(
                  [
                    (done) =>
                      moveTo(cell.square, cell.trackLeft + SQUARE / 2, baseY, 800, easeInOutCubic, {
                        ticker,
                        onComplete: done,
                      }),
                    (done) =>
                      fadeTo(cell.square, 1, 800, easeInOutCubic, { ticker, onComplete: done }),
                  ],
                  loop,
                ),
              );
            },
          ),
        );
      };
      loop();
    },
  },
];

export interface AnimSandboxScreenOptions {
  ticker: Ticker;
}

export class AnimSandboxScreen extends Container implements Screen {
  private readonly cells: Cell[] = [];
  private readonly ticker: Ticker;
  private readonly grid: Container;
  private readonly title: Text;

  constructor(options: AnimSandboxScreenOptions) {
    super();
    this.ticker = options.ticker;

    this.title = new Text({
      text: "ANIMATION PRIMITIVES",
      style: {
        fontFamily: typography.family,
        fontSize: typography.size.lg,
        fontWeight: typography.weight.bold,
        fill: color.text,
        letterSpacing: typography.letterSpacing.stamp,
      },
    });
    this.title.x = spacing.lg;
    this.title.y = spacing.md;
    this.addChild(this.title);

    this.grid = new Container();
    this.grid.x = spacing.lg;
    this.grid.y = spacing.md + this.title.height + spacing.lg;
    this.addChild(this.grid);

    for (const spec of PRIMITIVES) {
      const cell = new Cell(spec.label);
      this.cells.push(cell);
      this.grid.addChild(cell);
      spec.build(cell, this.ticker);
    }
  }

  layout(viewWidth: number, _viewHeight: number): void {
    const usableWidth = Math.max(CELL_W, viewWidth - spacing.lg * 2);
    const gap = spacing.md;
    const cols = Math.max(1, Math.floor((usableWidth + gap) / (CELL_W + gap)));
    for (let i = 0; i < this.cells.length; i += 1) {
      const cell = this.cells[i];
      if (!cell) continue;
      const col = i % cols;
      const row = Math.floor(i / cols);
      cell.x = col * (CELL_W + gap);
      cell.y = row * (CELL_H + gap);
    }
  }

  dispose(): void {
    for (const cell of this.cells) cell.dispose();
  }
}
