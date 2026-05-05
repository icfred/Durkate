import { ColorMatrixFilter, Container, type Filter, TilingSprite } from "pixi.js";
import { createFoilFilter, type FoilController } from "./renderers/foilFilter.js";
import type { Finish, Motion, SkinSpec } from "./spec.js";
import { PATTERN_TILE, type SkinAssets } from "./textures.js";
import { defaultTunables, type Tunables } from "./tunables.js";

export interface Axes {
  pattern: boolean;
  tint: boolean;
  finish: boolean;
  motion: boolean;
}

const ALL_AXES: Axes = { pattern: true, tint: true, finish: true, motion: true };

export interface SkinnedCardOptions {
  /** The base card primitive to wrap. SkinnedCard does not own its lifecycle. */
  base: Container;
  /** Local-space size of the base, used to size the pattern overlay. */
  baseWidth: number;
  baseHeight: number;
  assets: SkinAssets;
}

/**
 * Wraps a base card Container (typically `CardView`) with cosmetic effects:
 * tint, finish (foil/chrome/holographic), motion, and pattern overlay.
 *
 * `applySkin(null)` removes all effects so the wrapper renders identically to
 * a bare base. This is the "no skin = default look" axiom.
 */
export class SkinnedCard extends Container {
  private readonly base: Container;
  // The Container that cosmetic effects target. If `base` is a CardView (or
  // anything that exposes a `skinLayer` field), filters and pattern overlay
  // attach there — sitting *under* the rank/suit glyphs so the text stays
  // legible. Falls back to `base` for non-CardView wrappers.
  private readonly skinTarget: Container;
  private readonly pattern: TilingSprite;
  private readonly tintFilter: ColorMatrixFilter;
  private readonly foil: FoilController;
  private readonly assets: SkinAssets;
  private spec: SkinSpec | null = null;
  private axes: Axes = { ...ALL_AXES };
  private tunables: Tunables = defaultTunables;

  constructor(options: SkinnedCardOptions) {
    super();
    this.base = options.base;
    this.skinTarget = resolveSkinTarget(options.base);
    this.assets = options.assets;
    this.addChild(this.base);

    const fallback = options.assets.patterns[0];
    if (!fallback) throw new Error("SkinnedCard: assets.patterns is empty");
    this.pattern = new TilingSprite({
      texture: fallback,
      width: options.baseWidth,
      height: options.baseHeight,
    });
    this.pattern.visible = false;
    // Pattern goes inside the skin target so it sits between the bg and the
    // rank/suit glyphs. Adding it to `this` instead would put it above the
    // glyphs and obscure them — the bug this layering rewrite fixes.
    this.skinTarget.addChild(this.pattern);

    this.tintFilter = new ColorMatrixFilter();
    this.foil = createFoilFilter();
    this.foil.setTunables(this.tunables.foil, this.tunables.motion);
  }

  setTunables(tunables: Tunables): void {
    this.tunables = tunables;
    this.foil.setTunables(tunables.foil, tunables.motion);
    if (this.spec) this.applySkin(this.spec, this.axes);
  }

  applySkin(spec: SkinSpec | null, axes: Axes = ALL_AXES): void {
    this.spec = spec;
    this.axes = { ...axes };

    if (!spec) {
      this.pattern.visible = false;
      this.skinTarget.filters = [];
      return;
    }

    if (axes.pattern) {
      this.pattern.visible = true;
      const tex =
        this.assets.patterns[spec.pattern.index % this.assets.patterns.length] ??
        this.assets.patterns[0];
      if (tex) this.pattern.texture = tex;
      this.pattern.tileScale.set(spec.pattern.scale);
      this.pattern.tilePosition.set(
        spec.pattern.offsetX * PATTERN_TILE,
        spec.pattern.offsetY * PATTERN_TILE,
      );
      this.pattern.alpha = this.tunables.pattern.overlayAlpha;
    } else {
      this.pattern.visible = false;
    }

    const filters: Filter[] = [];
    if (axes.tint) {
      this.tintFilter.reset();
      this.tintFilter.hue(spec.tint.hue * 180, false);
      this.tintFilter.saturate(spec.tint.saturation - 1, true);
      this.tintFilter.brightness(spec.tint.brightness, true);
      filters.push(this.tintFilter);
    }

    const finishActive = axes.finish && spec.finish !== "matte";
    if (finishActive) {
      this.foil.setLook(
        0,
        finishToFloat(spec.finish),
        axes.motion ? motionToFloat(spec.motion) : 0,
        (spec.pattern.offsetX + spec.pattern.offsetY) * 0.5,
      );
      filters.push(this.foil.filter);
    }

    this.skinTarget.filters = filters;
  }

  tick(timeSeconds: number): void {
    if (!this.spec) return;
    if (!this.axes.finish || this.spec.finish === "matte") return;
    if (!this.axes.motion || this.spec.motion === "none") return;
    this.foil.setLook(
      timeSeconds,
      finishToFloat(this.spec.finish),
      motionToFloat(this.spec.motion),
      (this.spec.pattern.offsetX + this.spec.pattern.offsetY) * 0.5,
    );
  }
}

function finishToFloat(finish: Finish): number {
  switch (finish) {
    case "matte":
      return 0;
    case "foil":
      return 1;
    case "chrome":
      return 2;
    case "holographic":
      return 3;
  }
}

function motionToFloat(motion: Motion): number {
  switch (motion) {
    case "none":
      return 0;
    case "shimmer":
      return 1;
    case "pulse":
      return 2;
    case "drift":
      return 3;
  }
}

// CardView exposes a `skinLayer` field; other wrappers may not. When the base
// is something else (a tester's plain Container, etc.) we fall back to the
// base itself — the previous behaviour of filtering the whole base.
function resolveSkinTarget(base: Container): Container {
  const candidate = (base as { skinLayer?: unknown }).skinLayer;
  if (candidate instanceof Container) return candidate;
  return base;
}
