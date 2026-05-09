import type { Container, Ticker } from "pixi.js";
import { type Anim, parallel, sequence } from "./compose.js";
import { easeInOutCubic, easeOutBack, easeOutQuad } from "./easings.js";
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

export interface PlayCardOptions {
  /** The card container. */
  target: Container;
  /** Pixels the card lifts upward at peak. Default 80. */
  riseY?: number;
  /** Scale at peak. Default 1.12. */
  peakScale?: number;
  /** Tilt (skew, radians) at peak — adds rotation flavour. Default 0.12. */
  peakSkew?: number;
  durationMs?: number;
  ticker?: Ticker;
  onComplete?(): void;
}

/**
 * "Play card" gesture. Card lifts up + scales up + tilts forward, then
 * lands back at its origin with a slight overshoot. Reads as the player
 * lifting the card, presenting it, and slamming it on the table.
 */
export function playCard(options: PlayCardOptions): TweenHandle {
  const target = options.target;
  const total = options.durationMs ?? DEFAULT_PLAY_MS;
  const rise = options.riseY ?? 80;
  const peakScale = options.peakScale ?? 1.12;
  const peakSkew = options.peakSkew ?? 0.12;
  const startY = target.y;
  const startScaleX = target.scale.x;
  const startScaleY = target.scale.y;
  const startSkewX = target.skew.x;

  const tickerOpt: { ticker?: Ticker } = {};
  if (options.ticker) tickerOpt.ticker = options.ticker;

  // Three movements share the same time budget: lift (35%), hold (10%),
  // drop (55%). The drop uses an overshoot easing so the card "slaps"
  // the table rather than gliding to rest.
  const liftMs = total * 0.35;
  const holdMs = total * 0.1;
  const dropMs = total * 0.55;

  const lift: Anim = (done) =>
    parallel(
      [
        (cb) =>
          tween({
            from: startY,
            to: startY - rise,
            durationMs: liftMs,
            easing: easeOutQuad,
            onUpdate: (v) => {
              target.y = v;
            },
            onComplete: cb,
            ...tickerOpt,
          }),
        (cb) =>
          tween({
            from: 1,
            to: peakScale,
            durationMs: liftMs,
            easing: easeOutQuad,
            onUpdate: (s) => {
              target.scale.set(startScaleX * s, startScaleY * s);
            },
            onComplete: cb,
            ...tickerOpt,
          }),
        (cb) =>
          tween({
            from: 0,
            to: peakSkew,
            durationMs: liftMs,
            easing: easeOutQuad,
            onUpdate: (s) => {
              target.skew.x = startSkewX + s;
            },
            onComplete: cb,
            ...tickerOpt,
          }),
      ],
      done,
    );

  const hold: Anim = (done) =>
    tween({
      from: 0,
      to: 1,
      durationMs: holdMs,
      onUpdate: () => {},
      onComplete: done,
      ...tickerOpt,
    });

  const drop: Anim = (done) =>
    parallel(
      [
        (cb) =>
          tween({
            from: startY - rise,
            to: startY,
            durationMs: dropMs,
            easing: easeOutBack,
            onUpdate: (v) => {
              target.y = v;
            },
            onComplete: cb,
            ...tickerOpt,
          }),
        (cb) =>
          tween({
            from: peakScale,
            to: 1,
            durationMs: dropMs,
            easing: easeOutBack,
            onUpdate: (s) => {
              target.scale.set(startScaleX * s, startScaleY * s);
            },
            onComplete: cb,
            ...tickerOpt,
          }),
        (cb) =>
          tween({
            from: peakSkew,
            to: 0,
            durationMs: dropMs,
            easing: easeOutBack,
            onUpdate: (s) => {
              target.skew.x = startSkewX + s;
            },
            onComplete: cb,
            ...tickerOpt,
          }),
      ],
      done,
    );

  return sequence([lift, hold, drop], () => {
    target.y = startY;
    target.scale.set(startScaleX, startScaleY);
    target.skew.x = startSkewX;
    options.onComplete?.();
  });
}
