import type { SkinAssets } from "@durak/skins-spike";
import { Texture, Ticker } from "pixi.js";
import { describe, expect, it } from "vitest";
import { SkinTunerScreen } from "./SkinTunerScreen.js";

function mockAssets(): SkinAssets {
  return {
    cardSurface: Texture.EMPTY,
    cardDecoration: Texture.EMPTY,
    patterns: Array.from({ length: 4 }, () => ({
      height: Texture.EMPTY,
      regionId: Texture.EMPTY,
      finishMask: Texture.EMPTY,
    })),
    colorways: [{ name: "test", palette: [0, 0, 0, 0, 0, 0, 0, 0] }],
    scratchMap: Texture.EMPTY,
  };
}

describe("SkinTunerScreen", () => {
  it("mounts with the default tuning panel and preview", () => {
    const ticker = new Ticker();
    const screen = new SkinTunerScreen({ assets: mockAssets(), ticker });
    screen.layout(1280, 800);
    expect(screen.children.length).toBeGreaterThan(0);
    screen.dispose();
  });

  it("disposes without throwing", () => {
    const ticker = new Ticker();
    const screen = new SkinTunerScreen({ assets: mockAssets(), ticker });
    screen.layout(1280, 800);
    expect(() => screen.dispose()).not.toThrow();
  });
});
