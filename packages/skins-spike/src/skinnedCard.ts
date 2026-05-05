import { ColorMatrixFilter, Container } from "pixi.js";
import { PROC_TILE_PX } from "./proceduralPatterns.js";
import { createFoilMesh, type FoilMeshController } from "./renderers/foilMesh.js";
import { createPatternMesh, type PatternMeshController } from "./renderers/patternMesh.js";
import type { Finish, SkinSpec } from "./spec.js";
import { PATTERN_TILE, type SkinAssets } from "./textures.js";
import { defaultTunables, type Tunables } from "./tunables.js";

export interface Axes {
  pattern: boolean;
  tint: boolean;
  finish: boolean;
}

const ALL_AXES: Axes = { pattern: true, tint: true, finish: true };

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
 * Mesh layered on top via screen blend (foil/chrome/holographic finish),
 * and a tint ColorMatrix filter applied to the whole skin target.
 *
 * Both meshes run their shaders in mesh-local space, so the pattern's tile
 * UVs and the foil's pixel grid both shear with the card's perspective
 * during a tilt drag.
 *
 * There is no "motion" axis. All animation is driven by the card's tilt:
 * rotating the card rotates the surface normal (highlights slide across
 * the bumps, Fresnel rim glows on grazing edges, foil/holo rainbow rolls
 * with the angle). Cards are perfectly static at rest, the way real
 * shiny cards are — they only come alive when you turn them.
 *
 * `applySkin(null)` removes all effects so the wrapper renders identically
 * to a bare base.
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

    this.patternCtrl = createPatternMesh(
      fallback,
      options.assets.scratchMap,
      options.baseWidth,
      options.baseHeight,
    );
    this.patternCtrl.view.visible = false;
    this.skinTarget.addChild(this.patternCtrl.view);

    this.foilCtrl = createFoilMesh(
      fallback,
      options.assets.scratchMap,
      options.baseWidth,
      options.baseHeight,
    );
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
      metalStrength: this.tunables.foil.metalStrength,
      holoStrength: this.tunables.foil.holographicStrength,
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
      this.patternCtrl.view.filters = [];
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
      this.refreshPatternLook();
    } else {
      this.patternCtrl.view.visible = false;
    }

    const finishActive = axes.finish && spec.finish !== "matte";
    if (finishActive) {
      this.foilCtrl.view.visible = true;
      this.refreshFoilLook();
    } else {
      this.foilCtrl.view.visible = false;
    }

    // Tint applies ONLY to the pattern mesh — never to the foil. Real
    // gold and silver foil stay gold and silver regardless of how the
    // underlying pattern is hue-shifted; tinting them too would turn
    // a "gold foil" finish into "blue foil" depending on the spec's
    // hue setting, which reads as a bug.
    if (axes.tint) {
      this.tintFilter.reset();
      this.tintFilter.hue(spec.tint.hue * 180, false);
      this.tintFilter.saturate(spec.tint.saturation - 1, true);
      this.tintFilter.brightness(spec.tint.brightness, true);
      this.patternCtrl.view.filters = [this.tintFilter];
    } else {
      this.patternCtrl.view.filters = [];
    }
    // skinTarget itself stays unfiltered now; per-mesh filters above
    // handle the tint scoping.
    this.skinTarget.filters = [];
  }

  private refreshPatternLook(): void {
    if (!this.spec) return;
    const tileWorldSize = PATTERN_TILE * this.spec.pattern.scale;
    const tilesAcross = this.baseWidth / tileWorldSize;
    const tilesDown = this.baseHeight / tileWorldSize;
    this.patternCtrl.setLook({
      tileScaleX: tilesAcross,
      tileScaleY: tilesDown,
      tileOffsetX: this.spec.pattern.offsetX,
      tileOffsetY: this.spec.pattern.offsetY,
      overlayAlpha: this.tunables.pattern.overlayAlpha,
      bumpScale: 2.0,
      texelSize: 1 / PROC_TILE_PX,
      viewTiltX: this.skew.x,
      viewTiltY: this.skew.y,
      wear: this.tunables.wear,
    });
  }

  private refreshFoilLook(): void {
    if (!this.spec) return;
    const tileWorldSize = PATTERN_TILE * this.spec.pattern.scale;
    const tilesAcross = this.baseWidth / tileWorldSize;
    const tilesDown = this.baseHeight / tileWorldSize;
    this.foilCtrl.setLook({
      finish: finishToFloat(this.spec.finish),
      seed: (this.spec.pattern.offsetX + this.spec.pattern.offsetY) * 0.5,
      tileScaleX: tilesAcross,
      tileScaleY: tilesDown,
      tileOffsetX: this.spec.pattern.offsetX,
      tileOffsetY: this.spec.pattern.offsetY,
      viewTiltX: this.skew.x,
      viewTiltY: this.skew.y,
      wear: this.tunables.wear,
    });
  }

  /**
   * Refreshes shader uniforms that depend on the current tilt (skew). The
   * tuner calls this on every frame while drag-tilting; without it the
   * shader's tilt-driven highlights, Fresnel, and rainbow phase don't
   * track the live skew value.
   */
  refreshTilt(): void {
    if (!this.spec) return;
    if (this.axes.pattern) this.refreshPatternLook();
    if (this.axes.finish && this.spec.finish !== "matte") this.refreshFoilLook();
  }
}

function finishToFloat(finish: Finish): number {
  switch (finish) {
    case "matte":
      return 0;
    case "silver":
      return 1;
    case "gold":
      return 2;
    case "bronze":
      return 3;
    case "holographic":
      return 4;
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
