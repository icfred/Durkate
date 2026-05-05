import type { Renderer } from "pixi.js";
import { createSkinAssets, type SkinAssets } from "./textures.js";

// Phase 2 dropped the atlas pipeline. Procedural pattern bundles ship
// three textures (color/height/gloss) per slot; baking that into a single
// pre-rendered atlas would lose the per-channel data the pattern shader
// needs. Runtime generation is fast enough (sub-50ms for 8 bundles).
//
// `AtlasUrls` is kept as an exported type so the existing call sites in
// apps/web/src/main.ts compile, but the parameter is ignored.
export interface AtlasUrls {
  imageUrl: string;
  manifestUrl: string;
}

export async function loadSkinAssets(renderer: Renderer, _atlas?: AtlasUrls): Promise<SkinAssets> {
  return createSkinAssets(renderer);
}
