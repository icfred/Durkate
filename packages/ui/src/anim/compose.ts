import type { TweenHandle } from "./tween.js";

export type Anim = (onComplete: () => void) => TweenHandle;

const noop = (): void => {};

export function sequence(anims: readonly Anim[], onComplete?: () => void): TweenHandle {
  const done = onComplete ?? noop;
  let cancelled = false;
  let current: TweenHandle | null = null;
  let i = 0;

  const next = (): void => {
    if (cancelled) return;
    if (i >= anims.length) {
      done();
      return;
    }
    const a = anims[i++];
    if (!a) {
      next();
      return;
    }
    current = a(next);
  };

  next();

  return {
    cancel(): void {
      if (cancelled) return;
      cancelled = true;
      current?.cancel();
    },
  };
}

export function parallel(anims: readonly Anim[], onComplete?: () => void): TweenHandle {
  const done = onComplete ?? noop;
  if (anims.length === 0) {
    done();
    return { cancel: noop };
  }
  let cancelled = false;
  let remaining = anims.length;
  const handles: TweenHandle[] = [];

  const childDone = (): void => {
    if (cancelled) return;
    remaining -= 1;
    if (remaining === 0) done();
  };

  for (const a of anims) {
    if (cancelled) break;
    handles.push(a(childDone));
  }

  return {
    cancel(): void {
      if (cancelled) return;
      cancelled = true;
      for (const h of handles) h.cancel();
    },
  };
}
