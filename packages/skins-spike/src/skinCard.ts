import { ColorMatrixFilter, Container, type Filter, Sprite } from "pixi.js";
import { createFoilFilter, type FoilController } from "./renderers/foilFilter.js";
import type { Finish, Motion, SkinSpec } from "./spec.js";
import { CARD_HEIGHT, CARD_WIDTH, type SkinAssets } from "./textures.js";

export interface Axes {
  pattern: boolean;
  tint: boolean;
  finish: boolean;
  motion: boolean;
}

export class SkinCard extends Container {
  static readonly width = CARD_WIDTH;
  static readonly height = CARD_HEIGHT;

  private readonly assets: SkinAssets;
  private readonly content: Container;
  private readonly bg: Sprite;
  private readonly pattern: Sprite;
  private readonly tintFilter: ColorMatrixFilter;
  private readonly foil: FoilController;
  private spec: SkinSpec | null = null;
  private axes: Axes = { pattern: true, tint: true, finish: true, motion: true };

  constructor(assets: SkinAssets) {
    super();
    this.assets = assets;
    this.content = new Container();
    this.addChild(this.content);

    this.bg = new Sprite(assets.baseCard);
    this.content.addChild(this.bg);

    const fallback = assets.patterns[0];
    if (!fallback) throw new Error("SkinCard: assets.patterns is empty");
    this.pattern = new Sprite(fallback);
    this.content.addChild(this.pattern);

    this.tintFilter = new ColorMatrixFilter();
    this.foil = createFoilFilter();
  }

  apply(spec: SkinSpec, axes: Axes): void {
    this.spec = spec;
    this.axes = axes;

    if (axes.pattern) {
      this.pattern.visible = true;
      const tex =
        this.assets.patterns[spec.pattern.index % this.assets.patterns.length] ??
        this.assets.patterns[0];
      if (tex) this.pattern.texture = tex;
      this.pattern.scale.set(spec.pattern.scale);
      this.pattern.position.set(
        Math.round((spec.pattern.offsetX - 0.5) * 24),
        Math.round((spec.pattern.offsetY - 0.5) * 24),
      );
      this.pattern.alpha = 0.65;
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
      this.foil.setUniforms(
        0,
        finishToFloat(spec.finish),
        axes.motion ? motionToFloat(spec.motion) : 0,
        (spec.pattern.offsetX + spec.pattern.offsetY) * 0.5,
      );
      filters.push(this.foil.filter);
    }

    this.content.filters = filters;
  }

  tick(timeSeconds: number): void {
    if (!this.spec) return;
    if (!this.axes.finish || this.spec.finish === "matte") return;
    if (!this.axes.motion || this.spec.motion === "none") {
      // still need to update time once for static foil; but motion-off means no animation
      return;
    }
    this.foil.setUniforms(
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
