import { Ticker, type TickerCallback } from "pixi.js";
import { type Easing, linear } from "./easings.js";

export interface TweenOptions {
  from: number;
  to: number;
  durationMs: number;
  easing?: Easing;
  onUpdate: (value: number, progress: number) => void;
  onComplete?: () => void;
  ticker?: Ticker;
  now?: () => number;
  /** Optional speed scale (e.g. devtools animSpeed). 1 = real time. */
  speed?: () => number;
}

export interface TweenHandle {
  cancel(): void;
}

const defaultNow = (): number => performance.now();

export function tween(options: TweenOptions): TweenHandle {
  const ticker = options.ticker ?? Ticker.shared;
  const now = options.now ?? defaultNow;
  const easing = options.easing ?? linear;
  const speed = options.speed;
  const duration = Math.max(0, options.durationMs);

  let elapsed = 0;
  let last = now();
  let done = false;

  const apply = (progress: number): void => {
    const eased = easing(progress);
    const value = options.from + (options.to - options.from) * eased;
    options.onUpdate(value, progress);
  };

  const finish = (): void => {
    if (done) return;
    done = true;
    apply(1);
    ticker.remove(callback);
    options.onComplete?.();
  };

  const callback: TickerCallback<unknown> = () => {
    if (done) return;
    const t = now();
    const dt = (t - last) * (speed?.() ?? 1);
    last = t;
    elapsed += dt;
    if (duration === 0 || elapsed >= duration) {
      finish();
      return;
    }
    apply(elapsed / duration);
  };

  ticker.add(callback);

  if (duration === 0) finish();

  return {
    cancel(): void {
      if (done) return;
      done = true;
      ticker.remove(callback);
    },
  };
}
