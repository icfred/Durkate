export type Easing = (t: number) => number;

export const linear: Easing = (t) => t;

export const easeOutQuad: Easing = (t) => 1 - (1 - t) * (1 - t);

export const easeInQuad: Easing = (t) => t * t;

export const easeInOutCubic: Easing = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

export const easeOutBack: Easing = (t) => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2;
};

export const easings = {
  linear,
  easeOutQuad,
  easeInQuad,
  easeInOutCubic,
  easeOutBack,
} as const;
