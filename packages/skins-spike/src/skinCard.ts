import { ColorMatrixFilter, Container, type Filter, Sprite, TilingSprite } from "pixi.js";
import { createFoilFilter, type FoilController } from "./renderers/foilFilter.js";
import type { Finish, Motion, SkinSpec } from "./spec.js";
import { CARD_HEIGHT, CARD_WIDTH, PATTERN_TILE, type SkinAssets } from "./textures.js";
import { defaultTunables, type Tunables } from "./tunables.js";

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
  private readonly pattern: TilingSprite;
  private readonly decoration: Sprite;
  private readonly tintFilter: ColorMatrixFilter;
  private readonly foil: FoilController;
  private spec: SkinSpec | null = null;
  private axes: Axes = { pattern: true, tint: true, finish: true, motion: true };
  private tunables: Tunables = defaultTunables;

  constructor(assets: SkinAssets) {
    super();
    this.assets = assets;
    this.content = new Container();
    this.addChild(this.content);

    this.bg = new Sprite(assets.cardSurface);
    this.content.addChild(this.bg);

    const fallback = assets.patterns[0];
    if (!fallback) throw new Error("SkinCard: assets.patterns is empty");
    this.pattern = new TilingSprite({
      texture: fallback,
      width: CARD_WIDTH,
      height: CARD_HEIGHT,
    });
    this.content.addChild(this.pattern);

    this.decoration = new Sprite(assets.cardDecoration);
    this.addChild(this.decoration);

    this.tintFilter = new ColorMatrixFilter();
    this.foil = createFoilFilter();
    this.foil.setTunables(this.tunables.foil, this.tunables.motion);
  }

  setTunables(tunables: Tunables): void {
    this.tunables = tunables;
    this.foil.setTunables(tunables.foil, tunables.motion);
    if (this.spec) this.apply(this.spec, this.axes);
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

    this.content.filters = filters;
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
