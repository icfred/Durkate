import { ColorMatrixFilter, Container, type Filter, Sprite, Texture } from "pixi.js";
import { PROC_TILE_PX } from "./proceduralPatterns.js";
import { createFoilFilter, type FoilController } from "./renderers/foilFilter.js";
import { createPatternFilter, type PatternFilterController } from "./renderers/patternFilter.js";
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
 * pattern overlay (color + height + gloss bundle, lit per-pixel by a custom
 * shader), tint (color matrix), finish (foil/chrome/holographic), and
 * motion (animates light direction + foil shimmer).
 *
 * Pattern is rendered via a placeholder Sprite covering the card area with
 * a custom filter that samples the pattern bundle's three textures and
 * does its own tiling math + per-pixel lighting. The Sprite's underlying
 * texture (Texture.WHITE) is ignored by the shader.
 *
 * `applySkin(null)` removes all effects so the wrapper renders identically
 * to a bare base. This is the "no skin = default look" axiom.
 */
export class SkinnedCard extends Container {
  private readonly base: Container;
  private readonly skinTarget: Container;
  private readonly patternSprite: Sprite;
  private readonly patternCtrl: PatternFilterController;
  private readonly tintFilter: ColorMatrixFilter;
  private readonly foil: FoilController;
  private readonly assets: SkinAssets;
  private readonly baseWidth: number;
  private readonly baseHeight: number;
  private spec: SkinSpec | null = null;
  private axes: Axes = { ...ALL_AXES };
  private tunables: Tunables = defaultTunables;
  private currentBundleIndex = -1;

  constructor(options: SkinnedCardOptions) {
    super();
    this.base = options.base;
    this.baseWidth = options.baseWidth;
    this.baseHeight = options.baseHeight;
    this.skinTarget = resolveSkinTarget(options.base);
    this.assets = options.assets;
    this.addChild(this.base);

    const fallback = options.assets.patterns[0];
    if (!fallback) throw new Error("SkinnedCard: assets.patterns is empty");

    // Placeholder sprite the pattern filter renders into. Texture.WHITE is
    // a 1×1 white pixel; the filter ignores uTexture and reads the bundle
    // textures directly.
    this.patternSprite = new Sprite({ texture: Texture.WHITE });
    this.patternSprite.width = options.baseWidth;
    this.patternSprite.height = options.baseHeight;
    this.patternSprite.visible = false;
    this.skinTarget.addChild(this.patternSprite);

    this.patternCtrl = createPatternFilter(fallback);
    this.patternSprite.filters = [this.patternCtrl.filter];

    this.tintFilter = new ColorMatrixFilter();
    this.foil = createFoilFilter();
    this.foil.setTunables(this.tunables.foil, this.tunables.motion);
    this.applyPixelGrid();
  }

  setTunables(tunables: Tunables): void {
    this.tunables = tunables;
    this.foil.setTunables(tunables.foil, tunables.motion);
    this.applyPixelGrid();
    if (this.spec) this.applySkin(this.spec, this.axes);
  }

  private applyPixelGrid(): void {
    const cell = Math.max(1, this.tunables.foil.cellSize);
    this.foil.setPixelGrid(this.baseWidth / cell, this.baseHeight / cell);
  }

  applySkin(spec: SkinSpec | null, axes: Axes = ALL_AXES): void {
    this.spec = spec;
    this.axes = { ...axes };

    if (!spec) {
      this.patternSprite.visible = false;
      this.skinTarget.filters = [];
      return;
    }

    if (axes.pattern) {
      this.patternSprite.visible = true;
      const idx = spec.pattern.index % this.assets.patterns.length;
      const bundle = this.assets.patterns[idx] ?? this.assets.patterns[0];
      if (bundle && idx !== this.currentBundleIndex) {
        this.patternCtrl.setBundle(bundle);
        this.currentBundleIndex = idx;
      }
      this.refreshPatternLook(0);
    } else {
      this.patternSprite.visible = false;
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

  /**
   * Updates the pattern shader uniforms — tile scale/offset, motion, and
   * overlay alpha — based on the current spec + tunables. Called from
   * `applySkin` (initial bind) and `tick` (motion animation).
   */
  private refreshPatternLook(time: number): void {
    if (!this.spec) return;
    const tileWorldSize = PATTERN_TILE * this.spec.pattern.scale;
    const tilesAcross = this.baseWidth / tileWorldSize;
    const tilesDown = this.baseHeight / tileWorldSize;
    const motion =
      this.axes.motion && this.spec.motion !== "none" ? motionToFloat(this.spec.motion) : 0;
    this.patternCtrl.setLook({
      time,
      motion,
      tileScaleX: tilesAcross,
      tileScaleY: tilesDown,
      tileOffsetX: this.spec.pattern.offsetX,
      tileOffsetY: this.spec.pattern.offsetY,
      overlayAlpha: this.tunables.pattern.overlayAlpha,
      bumpScale: 2.0,
      texelSize: 1 / PROC_TILE_PX,
    });
  }

  tick(timeSeconds: number): void {
    if (!this.spec) return;
    // Pattern shader animates with motion mode regardless of finish.
    if (this.axes.pattern) this.refreshPatternLook(timeSeconds);
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
