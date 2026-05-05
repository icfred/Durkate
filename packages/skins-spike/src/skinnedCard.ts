import { ColorMatrixFilter, Container, type Filter } from "pixi.js";
import { PROC_TILE_PX } from "./proceduralPatterns.js";
import { createFoilMesh, type FoilMeshController } from "./renderers/foilMesh.js";
import { createPatternMesh, type PatternMeshController } from "./renderers/patternMesh.js";
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
 * a pattern Mesh (color + height + gloss bundle, lit per-pixel), a foil
 * Mesh layered on top via screen blend (foil/chrome/holographic with
 * shimmer/pulse/drift motion), and a tint ColorMatrix filter applied to
 * the whole skin target.
 *
 * Both meshes run their shaders in mesh-local space, so the pattern's
 * tile UVs and the foil's pixel grid both shear with the card's
 * perspective during the drag tilt — printed-pattern + holographic-foil
 * both look glued to the surface, not floating in screen space.
 *
 * `applySkin(null)` removes all effects so the wrapper renders identically
 * to a bare base. This is the "no skin = default look" axiom.
 */
export class SkinnedCard extends Container {
  private readonly base: Container;
  private readonly skinTarget: Container;
  private readonly patternCtrl: PatternMeshController;
  private readonly foilCtrl: FoilMeshController;
  private readonly tintFilter: ColorMatrixFilter;
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

    // Pattern Mesh: card-local quad with custom shader doing per-pixel
    // lighting + gloss specular over the bundle's color/height/gloss
    // textures. Tile UV math runs in mesh-local space so the pattern
    // shears with the card during tilt.
    this.patternCtrl = createPatternMesh(fallback, options.baseWidth, options.baseHeight);
    this.patternCtrl.view.visible = false;
    this.skinTarget.addChild(this.patternCtrl.view);

    // Foil Mesh: card-local quad with custom shader doing foil/chrome/
    // holographic finish + shimmer/pulse/drift motion. Screen blend mode
    // composes it over the pattern Mesh below, the same brighten-don't-
    // darken behavior the old foil filter had via its inverse-multiply
    // trick. Strength is gloss-modulated so the finish only catches on
    // metallic pixels.
    this.foilCtrl = createFoilMesh(fallback, options.baseWidth, options.baseHeight);
    this.foilCtrl.view.visible = false;
    this.skinTarget.addChild(this.foilCtrl.view);

    this.tintFilter = new ColorMatrixFilter();
    this.applyFoilTunables();
  }

  setTunables(tunables: Tunables): void {
    this.tunables = tunables;
    this.applyFoilTunables();
    if (this.spec) this.applySkin(this.spec, this.axes);
  }

  private applyFoilTunables(): void {
    this.foilCtrl.setTunables({
      foilStrength: this.tunables.foil.foilStrength,
      chromeStrength: this.tunables.foil.chromeStrength,
      holoStrength: this.tunables.foil.holographicStrength,
      shimmerSpeed: this.tunables.motion.shimmerSpeed,
      shimmerWidth: this.tunables.motion.shimmerWidth,
      pulseSpeed: this.tunables.motion.pulseSpeed,
      pulseAmount: this.tunables.motion.pulseAmount,
      driftSpeed: this.tunables.motion.driftSpeed,
    });
    const cell = Math.max(1, this.tunables.foil.cellSize);
    this.foilCtrl.setPixelGrid(this.baseWidth / cell, this.baseHeight / cell);
  }

  applySkin(spec: SkinSpec | null, axes: Axes = ALL_AXES): void {
    this.spec = spec;
    this.axes = { ...axes };

    if (!spec) {
      this.patternCtrl.view.visible = false;
      this.foilCtrl.view.visible = false;
      this.skinTarget.filters = [];
      return;
    }

    const idx = spec.pattern.index % this.assets.patterns.length;
    const bundle = this.assets.patterns[idx] ?? this.assets.patterns[0];
    if (bundle && idx !== this.currentBundleIndex) {
      this.patternCtrl.setBundle(bundle);
      this.foilCtrl.setBundle(bundle);
      this.currentBundleIndex = idx;
    }

    if (axes.pattern) {
      this.patternCtrl.view.visible = true;
      this.refreshPatternLook(0);
    } else {
      this.patternCtrl.view.visible = false;
    }

    const finishActive = axes.finish && spec.finish !== "matte";
    if (finishActive) {
      this.foilCtrl.view.visible = true;
      this.refreshFoilLook(0);
    } else {
      this.foilCtrl.view.visible = false;
    }

    const filters: Filter[] = [];
    if (axes.tint) {
      this.tintFilter.reset();
      this.tintFilter.hue(spec.tint.hue * 180, false);
      this.tintFilter.saturate(spec.tint.saturation - 1, true);
      this.tintFilter.brightness(spec.tint.brightness, true);
      filters.push(this.tintFilter);
    }
    this.skinTarget.filters = filters;
  }

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
      // SkinnedCard's own skew is set externally (by the tuner during
      // drag tilt). Reading it here drives the shader's tilt-aware
      // lighting / Fresnel rim — that's what gives depth as the card
      // turns.
      viewTiltX: this.skew.x,
      viewTiltY: this.skew.y,
    });
  }

  private refreshFoilLook(time: number): void {
    if (!this.spec) return;
    const tileWorldSize = PATTERN_TILE * this.spec.pattern.scale;
    const tilesAcross = this.baseWidth / tileWorldSize;
    const tilesDown = this.baseHeight / tileWorldSize;
    const motion =
      this.axes.motion && this.spec.motion !== "none" ? motionToFloat(this.spec.motion) : 0;
    this.foilCtrl.setLook({
      time,
      finish: finishToFloat(this.spec.finish),
      motion,
      seed: (this.spec.pattern.offsetX + this.spec.pattern.offsetY) * 0.5,
      tileScaleX: tilesAcross,
      tileScaleY: tilesDown,
      tileOffsetX: this.spec.pattern.offsetX,
      tileOffsetY: this.spec.pattern.offsetY,
      viewTiltX: this.skew.x,
      viewTiltY: this.skew.y,
    });
  }

  tick(timeSeconds: number): void {
    if (!this.spec) return;
    if (this.axes.pattern) this.refreshPatternLook(timeSeconds);
    if (this.axes.finish && this.spec.finish !== "matte") {
      this.refreshFoilLook(timeSeconds);
    }
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
