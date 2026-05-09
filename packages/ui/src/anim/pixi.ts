import type { Container, Ticker } from "pixi.js";
import { type Easing, linear } from "./easings.js";
import { type TweenHandle, tween } from "./tween.js";

export interface PixiTweenOptions {
  ticker?: Ticker;
  now?: () => number;
  speed?: () => number;
  onComplete?: () => void;
}

export function fadeTo(
  target: Container,
  alpha: number,
  durationMs: number,
  easing: Easing = linear,
  options: PixiTweenOptions = {},
): TweenHandle {
  return tween({
    from: target.alpha,
    to: alpha,
    durationMs,
    easing,
    onUpdate: (value) => {
      target.alpha = value;
    },
    ...options,
  });
}

export function moveTo(
  target: Container,
  x: number,
  y: number,
  durationMs: number,
  easing: Easing = linear,
  options: PixiTweenOptions = {},
): TweenHandle {
  const fromX = target.x;
  const fromY = target.y;
  return tween({
    from: 0,
    to: 1,
    durationMs,
    easing,
    onUpdate: (eased) => {
      target.x = fromX + (x - fromX) * eased;
      target.y = fromY + (y - fromY) * eased;
    },
    ...options,
  });
}

export function scaleTo(
  target: Container,
  scale: number,
  durationMs: number,
  easing: Easing = linear,
  options: PixiTweenOptions = {},
): TweenHandle {
  const fromX = target.scale.x;
  const fromY = target.scale.y;
  return tween({
    from: 0,
    to: 1,
    durationMs,
    easing,
    onUpdate: (eased) => {
      target.scale.set(fromX + (scale - fromX) * eased, fromY + (scale - fromY) * eased);
    },
    ...options,
  });
}
