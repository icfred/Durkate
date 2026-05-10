import type { Container, Ticker } from "pixi.js";
import { type Anim, sequence } from "./compose.js";
import { type Easing, easeInOutCubic, easeInQuad, easeOutBack, linear } from "./easings.js";
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
const DEFAULT_DEAL_MS = 900;
const DEFAULT_DISCARD_MS = 600;
const DEFAULT_SHAKE_MS = 420;
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
 * "Play card" gesture. Card flies in from above (the player's hand)
 * with rotation + skew, slams down at the table position with a
 * back-easing overshoot. Defaults are intentionally dramatic.
 */
export function playCard(options: PlayCardOptions): TweenHandle {
  return entranceFromOffset({
    fromX: 0,
    fromY: -720,
    fromRotation: -0.45,
    fromScale: 0.4,
    fromSkewX: 0.3,
    durationMs: options.durationMs ?? 900,
    ...options,
  });
}

export interface DealCardOptions extends EntranceAnimOptions {
  /**
   * Fired once at the deal's flip midpoint. The card is edge-on at this
   * moment; callers swap visible faces here so the deal lands face-up.
   */
  onMidpoint?(): void;
}

/**
 * "Deal" gesture. A `playCard`-style entrance from off-screen above,
 * with a Y-axis flip baked in: the card collapses to edge-on at the
 * midpoint of the journey and unfolds again, so it lands face-up
 * having travelled face-down. `onMidpoint` swaps the visible face when
 * the card is invisibly thin.
 */
export function dealCard(options: DealCardOptions): TweenHandle {
  const target = options.target;
  const total = options.durationMs ?? DEFAULT_DEAL_MS;
  const easing = options.easing ?? easeOutBack;
  const restX = target.x;
  const restY = target.y;
  const restRotation = target.rotation;
  const restScaleX = target.scale.x;
  const restScaleY = target.scale.y;
  const restSkewX = target.skew.x;
  const fromScale = options.fromScale ?? 0.45;

  const startX = restX + (options.fromX ?? 0);
  const startY = restY + (options.fromY ?? -640);
  const startRotation = restRotation + (options.fromRotation ?? -0.5);
  const startScaleX = restScaleX * fromScale;
  const startScaleY = restScaleY * fromScale;
  const startSkewX = restSkewX + (options.fromSkewX ?? 0.25);

  // Snap to start so the first rendered frame is the deal origin.
  target.x = startX;
  target.y = startY;
  target.rotation = startRotation;
  target.scale.set(startScaleX, startScaleY);
  target.skew.x = startSkewX;

  let midpointFired = false;
  const tickerOpt: { ticker?: Ticker } = {};
  if (options.ticker) tickerOpt.ticker = options.ticker;

  // The flip happens in the LAST quarter of the animation — the card
  // travels into hand position face-down first, then flips at the
  // tail-end. Gives the eye time to read the back's pattern before
  // the reveal.
  const flipStart = 0.7;

  return tween({
    from: 0,
    to: 1,
    durationMs: total,
    easing,
    onUpdate: (t) => {
      // Movement phase runs for the whole duration up to flipStart,
      // then holds at the rest pose. flipPhase 0..1 covers the flip.
      const moveT = Math.min(t / flipStart, 1);
      target.x = startX + (restX - startX) * moveT;
      target.y = startY + (restY - startY) * moveT;
      target.rotation = startRotation + (restRotation - startRotation) * moveT;
      target.skew.x = startSkewX + (restSkewX - startSkewX) * moveT;
      target.scale.y = startScaleY + (restScaleY - startScaleY) * moveT;
      // scale.x ALSO interps to rest during the move phase so the
      // card looks visually whole as it descends. The flip then
      // collapses + expands scale.x within the last 30% of the
      // duration.
      if (t < flipStart) {
        target.scale.x = startScaleX + (restScaleX - startScaleX) * moveT;
      } else {
        const flipT = (t - flipStart) / (1 - flipStart);
        target.scale.x =
          flipT < 0.5
            ? restScaleX + (0 - restScaleX) * (flipT * 2)
            : 0 + (restScaleX - 0) * ((flipT - 0.5) * 2);
        if (flipT >= 0.5 && !midpointFired) {
          midpointFired = true;
          options.onMidpoint?.();
        }
      }
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

export interface DiscardCardOptions {
  /** The card container. */
  target: Container;
  /** Resting → exit X delta. Default `+860` (off-screen right). */
  toX?: number;
  /** Resting → exit Y delta. Default `-180` (slight upward arc). */
  toY?: number;
  /** Resting → exit rotation delta (radians). Default `1.4`. */
  toRotation?: number;
  /** Exit scale, multiplied with the resting scale. Default `0.6`. */
  toScale?: number;
  /** Exit skew on the X axis (radians). Default `0.4`. */
  toSkewX?: number;
  durationMs?: number;
  ticker?: Ticker;
  onComplete?(): void;
}

/**
 * "Discard" — the card flies off-screen with a spin. Resets to the
 * resting transform on completion so callers (e.g. the tuner) can
 * iterate without having to manually re-place it.
 */
export function discardCard(options: DiscardCardOptions): TweenHandle {
  const target = options.target;
  const total = options.durationMs ?? DEFAULT_DISCARD_MS;
  const restX = target.x;
  const restY = target.y;
  const restRotation = target.rotation;
  const restScaleX = target.scale.x;
  const restScaleY = target.scale.y;
  const restSkewX = target.skew.x;
  const toScale = options.toScale ?? 0.6;
  const endX = restX + (options.toX ?? 860);
  const endY = restY + (options.toY ?? -180);
  const endRotation = restRotation + (options.toRotation ?? 1.4);
  const endScaleX = restScaleX * toScale;
  const endScaleY = restScaleY * toScale;
  const endSkewX = restSkewX + (options.toSkewX ?? 0.4);

  const tickerOpt: { ticker?: Ticker } = {};
  if (options.ticker) tickerOpt.ticker = options.ticker;

  return tween({
    from: 0,
    to: 1,
    durationMs: total,
    // easeInQuad accelerates outward — the card "yeets" away rather
    // than gliding to a stop.
    easing: easeInQuad,
    onUpdate: (t) => {
      target.x = restX + (endX - restX) * t;
      target.y = restY + (endY - restY) * t;
      target.rotation = restRotation + (endRotation - restRotation) * t;
      target.scale.set(
        restScaleX + (endScaleX - restScaleX) * t,
        restScaleY + (endScaleY - restScaleY) * t,
      );
      target.skew.x = restSkewX + (endSkewX - restSkewX) * t;
    },
    onComplete: () => {
      // Restore to rest so a sandbox / tuner can keep iterating; for
      // a real game callers should just remove the card on completion.
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

export interface ShakeCardOptions {
  target: Container;
  /** Peak horizontal displacement in pixels. Default 14. */
  intensityX?: number;
  /** Peak vertical displacement in pixels. Default 8. */
  intensityY?: number;
  /** Peak rotation displacement in radians. Default 0.05. */
  intensityRotation?: number;
  /** Peak skew wobble in radians (both axes). Default 0.12. */
  intensitySkew?: number;
  /** Number of full back-and-forth oscillations over the duration. Default 4. */
  cycles?: number;
  durationMs?: number;
  ticker?: Ticker;
  onComplete?(): void;
}

/**
 * "Shake" — rapid in-place wobble. Position wiggles on X (sin) and Y
 * (cos at a different frequency so it reads chaotic, not circular),
 * rotation tracks the X sin, and BOTH skew axes wobble too. The skew
 * is the important bit for the skin tuner: rotating the surface
 * normal mid-shake makes the foil / Fresnel highlights dance, which
 * is the whole point of having a shake in a lighting-heavy preview.
 */
export function shakeCard(options: ShakeCardOptions): TweenHandle {
  const target = options.target;
  const total = options.durationMs ?? DEFAULT_SHAKE_MS;
  const ix = options.intensityX ?? 14;
  const iy = options.intensityY ?? 8;
  const ir = options.intensityRotation ?? 0.05;
  const iSkew = options.intensitySkew ?? 0.12;
  const cycles = options.cycles ?? 4;
  const restX = target.x;
  const restY = target.y;
  const restRotation = target.rotation;
  const restSkewX = target.skew.x;
  const restSkewY = target.skew.y;

  const tickerOpt: { ticker?: Ticker } = {};
  if (options.ticker) tickerOpt.ticker = options.ticker;

  return tween({
    from: 0,
    to: 1,
    durationMs: total,
    easing: linear,
    onUpdate: (t) => {
      const decay = 1 - t;
      const phase = t * Math.PI * 2 * cycles;
      const sinX = Math.sin(phase);
      // Y uses a slightly higher frequency (1.3×) so the X / Y axes
      // don't trace a tidy circle — the motion looks like real shake
      // and the skin's tilt-driven shaders see varied normals.
      const cosY = Math.cos(phase * 1.3);
      target.x = restX + sinX * ix * decay;
      target.y = restY + cosY * iy * decay;
      target.rotation = restRotation + sinX * ir * decay;
      target.skew.x = restSkewX + sinX * iSkew * decay;
      target.skew.y = restSkewY + cosY * iSkew * decay;
    },
    onComplete: () => {
      target.x = restX;
      target.y = restY;
      target.rotation = restRotation;
      target.skew.x = restSkewX;
      target.skew.y = restSkewY;
      options.onComplete?.();
    },
    ...tickerOpt,
  });
}
