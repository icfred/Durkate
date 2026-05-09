import {
  easeInOutCubic,
  easeOutQuad,
  fadeTo,
  moveTo,
  parallel,
  sequence,
  type TweenHandle,
} from "@durak/ui";
import { type Container, Graphics, type Ticker } from "pixi.js";
import type { Phase } from "./store.js";

export const SLIDE_MS = 240;
export const FADE_MS = 220;
export const OVERLAY_HALF_MS = 160;
const OVERLAY_PEAK_ALPHA = 0.65;
const OVERLAY_COLOR = 0x000000;

export interface TransitionContext {
  stage: Container;
  outgoing: Container;
  incoming: Container;
  viewWidth: number;
  viewHeight: number;
  ticker?: Ticker;
  now?: () => number;
  speed?: () => number;
}

const noop = (): void => {};

function tweenOpts(ctx: TransitionContext): {
  ticker?: Ticker;
  now?: () => number;
  speed?: () => number;
} {
  const out: { ticker?: Ticker; now?: () => number; speed?: () => number } = {};
  if (ctx.ticker) out.ticker = ctx.ticker;
  if (ctx.now) out.now = ctx.now;
  if (ctx.speed) out.speed = ctx.speed;
  return out;
}

function slideTransition(
  ctx: TransitionContext,
  outgoingTo: { dx: number; dy: number },
  incomingFrom: { dx: number; dy: number },
  durationMs: number,
  onComplete: () => void,
): TweenHandle {
  const { outgoing, incoming } = ctx;
  incoming.x = incomingFrom.dx;
  incoming.y = incomingFrom.dy;
  incoming.alpha = 1;
  outgoing.alpha = 1;
  const opts = tweenOpts(ctx);
  return parallel(
    [
      (done) => moveTo(incoming, 0, 0, durationMs, easeOutQuad, { ...opts, onComplete: done }),
      (done) =>
        moveTo(outgoing, outgoingTo.dx, outgoingTo.dy, durationMs, easeOutQuad, {
          ...opts,
          onComplete: done,
        }),
    ],
    onComplete,
  );
}

function crossFade(
  ctx: TransitionContext,
  durationMs: number,
  onComplete: () => void,
): TweenHandle {
  const { outgoing, incoming } = ctx;
  incoming.x = 0;
  incoming.y = 0;
  incoming.alpha = 0;
  outgoing.alpha = 1;
  const opts = tweenOpts(ctx);
  return parallel(
    [
      (done) => fadeTo(outgoing, 0, durationMs, easeInOutCubic, { ...opts, onComplete: done }),
      (done) => fadeTo(incoming, 1, durationMs, easeInOutCubic, { ...opts, onComplete: done }),
    ],
    onComplete,
  );
}

function darkeningCrossFade(ctx: TransitionContext, onComplete: () => void): TweenHandle {
  const { outgoing, incoming, stage, viewWidth, viewHeight } = ctx;
  incoming.x = 0;
  incoming.y = 0;
  incoming.alpha = 0;
  outgoing.alpha = 1;

  const overlay = new Graphics()
    .rect(0, 0, viewWidth, viewHeight)
    .fill({ color: OVERLAY_COLOR, alpha: 1 });
  overlay.alpha = 0;
  const incomingIndex = stage.getChildIndex(incoming);
  stage.addChildAt(overlay, incomingIndex);

  const cleanupOverlay = (): void => {
    if (overlay.destroyed) return;
    if (overlay.parent) overlay.parent.removeChild(overlay);
    overlay.destroy();
  };

  const opts = tweenOpts(ctx);

  const handle = sequence(
    [
      (done) =>
        parallel(
          [
            (cb) =>
              fadeTo(outgoing, 0, OVERLAY_HALF_MS, easeInOutCubic, {
                ...opts,
                onComplete: cb,
              }),
            (cb) =>
              fadeTo(overlay, OVERLAY_PEAK_ALPHA, OVERLAY_HALF_MS, easeInOutCubic, {
                ...opts,
                onComplete: cb,
              }),
          ],
          done,
        ),
      (done) =>
        parallel(
          [
            (cb) =>
              fadeTo(overlay, 0, OVERLAY_HALF_MS, easeInOutCubic, {
                ...opts,
                onComplete: cb,
              }),
            (cb) =>
              fadeTo(incoming, 1, OVERLAY_HALF_MS, easeInOutCubic, {
                ...opts,
                onComplete: cb,
              }),
          ],
          done,
        ),
    ],
    () => {
      cleanupOverlay();
      onComplete();
    },
  );

  return {
    cancel(): void {
      handle.cancel();
      cleanupOverlay();
    },
  };
}

const TRANSITIONS: Record<string, (ctx: TransitionContext, done: () => void) => TweenHandle> = {
  "menu->lobby": (ctx, done) =>
    slideTransition(
      ctx,
      { dx: 0, dy: -ctx.viewHeight },
      { dx: 0, dy: ctx.viewHeight },
      SLIDE_MS,
      done,
    ),
  "lobby->menu": (ctx, done) =>
    slideTransition(
      ctx,
      { dx: 0, dy: ctx.viewHeight },
      { dx: 0, dy: -ctx.viewHeight },
      SLIDE_MS,
      done,
    ),
  "lobby->game": (ctx, done) => crossFade(ctx, FADE_MS, done),
  "game->lobby": (ctx, done) => crossFade(ctx, FADE_MS, done),
  "game->gameover": (ctx, done) =>
    slideTransition(ctx, { dx: 0, dy: 0 }, { dx: 0, dy: -ctx.viewHeight }, SLIDE_MS, done),
  "gameover->game": (ctx, done) => crossFade(ctx, FADE_MS, done),
  "gameover->menu": (ctx, done) => darkeningCrossFade(ctx, done),
  "menu->gameover": (ctx, done) => darkeningCrossFade(ctx, done),
};

export function runTransition(
  from: Phase,
  to: Phase,
  ctx: TransitionContext,
  onComplete: () => void = noop,
): TweenHandle {
  const key = `${from}->${to}`;
  const runner = TRANSITIONS[key] ?? ((c, d) => crossFade(c, FADE_MS, d));
  return runner(ctx, onComplete);
}
