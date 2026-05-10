import type { Container, Ticker } from "pixi.js";
import { type Anim, sequence } from "./compose.js";
import { type Easing, easeInOutCubic, easeOutBack } from "./easings.js";
import { type TweenHandle, tween } from "./tween.js";

// Card animation primitives. Designed for a 2D Pixi card sitting at its
// pivot centre — see SkinTunerScreen / CardView. They build on the base
// tween + sequence/parallel composers so they're cancellable, ticker-
// aware, and do not own any Pixi state of their own.
//
// "3D feel" without a real 3D scene comes from compounding two cheap
// tricks: a per-axis scale animation (the visible flatten / pop) plus a
// modest skew at the same time (a perspective-y shear). Together they
// read as a card rotating on an axis rather than just shrinking.

const DEFAULT_FLIP_MS = 600;
const DEFAULT_PLAY_MS = 700;
const DEFAULT_PEAK_DEPTH = 0.08;
const DEFAULT_PEAK_SKEW = 0.18;

export type FlipAxis = "x" | "y";

export interface FlipRevealOptions {
  /** The card container. Pivot should be at its centre. */
  target: Container;
  /**
   * Rotation axis. `"y"` (default) flips horizontally — left edge swings
   * forward, right edge swings back, like turning a page. `"x"` flips
   * vertically (top swings forward).
   */
  axis?: FlipAxis;
  durationMs?: number;
  ticker?: Ticker;
  /**
   * Fires once at the card's edge-on midpoint. Callers can swap visible
   * content (e.g. face → back) here without seeing the swap happen.
   */
  onMidpoint?(): void;
  onComplete?(): void;
}

/**
 * Y-axis (or X-axis) flip with a perspective shear and a depth pop. The
 * card squashes to zero on its rotation axis, briefly scales up overall
 * to feel like it travelled toward the camera, then unfolds again.
 */
export function flipReveal(options: FlipRevealOptions): TweenHandle {
  const target = options.target;
  const axis = options.axis ?? "y";
  const total = options.durationMs ?? DEFAULT_FLIP_MS;
  const half = total / 2;
  const startScaleX = target.scale.x;
  const startScaleY = target.scale.y;
  const startSkewX = target.skew.x;
  const startSkewY = target.skew.y;

  const tickerOpt: { ticker?: Ticker } = {};
  if (options.ticker) tickerOpt.ticker = options.ticker;

  // Y-axis flip animates scale.x (the card's width collapses); X-axis
  // animates scale.y. Skew on the orthogonal axis adds the perspective
  // shear so the leading edge appears foreshortened.
  const isY = axis === "y";

  const phase1: Anim = (done) =>
    tween({
      from: 0,
      to: 1,
      durationMs: half,
      easing: easeInOutCubic,
      onUpdate: (t) => {
        const collapse = 1 - t;
        // Brief overall scale boost peaks at midpoint (1 + DEFAULT_PEAK_DEPTH)
        // to fake the "card moving toward camera" cue.
        const depth = 1 + DEFAULT_PEAK_DEPTH * t;
        if (isY) {
          target.scale.x = startScaleX * collapse * depth;
          target.scale.y = startScaleY * depth;
          target.skew.y = startSkewY + DEFAULT_PEAK_SKEW * t;
        } else {
          target.scale.x = startScaleX * depth;
          target.scale.y = startScaleY * collapse * depth;
          target.skew.x = startSkewX + DEFAULT_PEAK_SKEW * t;
        }
      },
      onComplete: () => {
        options.onMidpoint?.();
        done();
      },
      ...tickerOpt,
    });

  const phase2: Anim = (done) =>
    tween({
      from: 0,
      to: 1,
      durationMs: half,
      easing: easeInOutCubic,
      onUpdate: (t) => {
        const expand = t;
        const depth = 1 + DEFAULT_PEAK_DEPTH * (1 - t);
        if (isY) {
          target.scale.x = startScaleX * expand * depth;
          target.scale.y = startScaleY * depth;
          target.skew.y = startSkewY + DEFAULT_PEAK_SKEW * (1 - t);
        } else {
          target.scale.x = startScaleX * depth;
          target.scale.y = startScaleY * expand * depth;
          target.skew.x = startSkewX + DEFAULT_PEAK_SKEW * (1 - t);
        }
      },
      onComplete: () => {
        // Restore exact original transform — incremental drift over many
        // flips would otherwise leave the card slightly off.
        target.scale.set(startScaleX, startScaleY);
        target.skew.set(startSkewX, startSkewY);
        done();
      },
      ...tickerOpt,
    });

  return sequence([phase1, phase2], options.onComplete);
}

export interface EntranceAnimOptions {
  /** The card container. */
  target: Container;
  /** Starting X offset from the resting (current) position. */
  fromX?: number;
  /** Starting Y offset from the resting (current) position. */
  fromY?: number;
  /** Starting rotation offset (radians). */
  fromRotation?: number;
  /** Starting scale, multiplied with the resting scale. Default 1. */
  fromScale?: number;
  /** Starting skew on the X axis (radians). Adds perspective drama. */
  fromSkewX?: number;
  /** Easing for the journey. Default `easeOutBack` (overshoot landing). */
  easing?: Easing;
  durationMs?: number;
  ticker?: Ticker;
  onComplete?(): void;
}

/**
 * Generic card entrance. Captures the target's current transform as the
 * "rest" pose, snaps the target to a configurable starting offset (with
 * rotation, scale, skew), then tweens every channel back to rest in
 * lockstep. `easeOutBack` by default so the landing overshoots and reads
 * as a slam.
 *
 * Builds the dramatic "play card" feel — start far away + tilted +
 * small + rotated; arrive square + full size + flat with a punch. Use
 * different `from*` values for different vibes (deal from top-left,
 * play from below, etc.).
 */
function entranceFromOffset(options: EntranceAnimOptions): TweenHandle {
  const target = options.target;
  const total = options.durationMs ?? DEFAULT_PLAY_MS;
  const easing = options.easing ?? easeOutBack;
  const restX = target.x;
  const restY = target.y;
  const restRotation = target.rotation;
  const restScaleX = target.scale.x;
  const restScaleY = target.scale.y;
  const restSkewX = target.skew.x;
  const fromScale = options.fromScale ?? 1;

  // Snapshot of where the target needs to fly in from. Computed up
  // front so the tween's interpolation can lerp directly between two
  // fixed endpoints (avoids drift across long sequences).
  const startX = restX + (options.fromX ?? 0);
  const startY = restY + (options.fromY ?? 0);
  const startRotation = restRotation + (options.fromRotation ?? 0);
  const startScaleX = restScaleX * fromScale;
  const startScaleY = restScaleY * fromScale;
  const startSkewX = restSkewX + (options.fromSkewX ?? 0);

  // Snap to the start pose immediately so the first rendered frame
  // already shows the off-screen origin instead of one frame at rest.
  target.x = startX;
  target.y = startY;
  target.rotation = startRotation;
  target.scale.set(startScaleX, startScaleY);
  target.skew.x = startSkewX;

  const tickerOpt: { ticker?: Ticker } = {};
  if (options.ticker) tickerOpt.ticker = options.ticker;

  return tween({
    from: 0,
    to: 1,
    durationMs: total,
    easing,
    onUpdate: (t) => {
      target.x = startX + (restX - startX) * t;
      target.y = startY + (restY - startY) * t;
      target.rotation = startRotation + (restRotation - startRotation) * t;
      target.scale.set(
        startScaleX + (restScaleX - startScaleX) * t,
        startScaleY + (restScaleY - startScaleY) * t,
      );
      target.skew.x = startSkewX + (restSkewX - startSkewX) * t;
    },
    onComplete: () => {
      target.x = restX;
      target.y = restY;
      target.rotation = restRotation;
      target.scale.set(restScaleX, restScaleY);
      target.skew.x = restSkewX;
      options.onComplete?.();
    },
    ...tickerOpt,
  });
}

export type PlayCardOptions = EntranceAnimOptions;

/**
 * "Play card" gesture. Card flies in from off-screen below, rotates +
 * scales up as it travels, and lands on the table with an overshoot.
 * The default offsets are intentionally dramatic — override `fromX`,
 * `fromY`, `fromRotation`, `fromScale` for a calmer entrance.
 */
export function playCard(options: PlayCardOptions): TweenHandle {
  return entranceFromOffset({
    fromX: 0,
    fromY: 720,
    fromRotation: -0.45,
    fromScale: 0.35,
    fromSkewX: 0.35,
    durationMs: options.durationMs ?? 900,
    ...options,
  });
}

export type DealCardOptions = EntranceAnimOptions;

/**
 * "Deal" gesture. Slides in from off-screen top-left with a quarter-turn
 * rotation, gentler than `playCard`. Reads as a card being passed across
 * the table rather than slammed down.
 */
export function dealCard(options: DealCardOptions): TweenHandle {
  return entranceFromOffset({
    fromX: -640,
    fromY: -360,
    fromRotation: -0.6,
    fromScale: 0.55,
    fromSkewX: -0.18,
    durationMs: options.durationMs ?? 750,
    ...options,
  });
}
