import { Assets, Rectangle, type Renderer, Texture } from "pixi.js";
import { createSkinAssets, type SkinAssets } from "./textures.js";

interface AtlasFrame {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface AtlasManifest {
  image: string;
  cardSurface: AtlasFrame;
  cardDecoration: AtlasFrame;
  patterns: AtlasFrame[];
}

export interface AtlasUrls {
  imageUrl: string;
  manifestUrl: string;
}

export async function loadSkinAssets(renderer: Renderer, atlas?: AtlasUrls): Promise<SkinAssets> {
  if (atlas) {
    try {
      return await loadFromAtlas(atlas);
    } catch (err) {
      console.warn("[skins-spike] atlas load failed, falling back to procedural", err);
    }
  }
  return createSkinAssets(renderer);
}

async function loadFromAtlas({ imageUrl, manifestUrl }: AtlasUrls): Promise<SkinAssets> {
  const manifestRes = await fetch(manifestUrl);
  if (!manifestRes.ok) throw new Error(`atlas manifest ${manifestUrl} -> ${manifestRes.status}`);
  const manifest = (await manifestRes.json()) as AtlasManifest;
  const sheet = (await Assets.load(imageUrl)) as Texture;
  const cardSurface = slice(sheet, manifest.cardSurface);
  const cardDecoration = slice(sheet, manifest.cardDecoration);
  const patterns = manifest.patterns.map((f) => slice(sheet, f));
  return { cardSurface, cardDecoration, patterns };
}

function slice(sheet: Texture, frame: AtlasFrame): Texture {
  return new Texture({
    source: sheet.source,
    frame: new Rectangle(frame.x, frame.y, frame.w, frame.h),
  });
}
