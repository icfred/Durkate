import type { SkinAssets } from "@durak/skins-spike";
import { Texture, Ticker } from "pixi.js";
import { describe, expect, it } from "vitest";
import { SkinSandboxScreen } from "./SkinSandboxScreen.js";

function mockAssets(): SkinAssets {
  return {
    cardSurface: Texture.EMPTY,
    cardDecoration: Texture.EMPTY,
    patterns: Array.from({ length: 4 }, () => ({
      color: Texture.EMPTY,
      height: Texture.EMPTY,
      gloss: Texture.EMPTY,
    })),
    scratchMap: Texture.EMPTY,
  };
}

describe("SkinSandboxScreen", () => {
  it("mounts with the default 36-card grid", () => {
    const ticker = new Ticker();
    const screen = new SkinSandboxScreen({ assets: mockAssets(), ticker });
    screen.layout(1024, 768);
    expect(screen.children.length).toBeGreaterThan(0);
    screen.dispose();
  });

  it("disposes cleanly without leaving ticker callbacks", () => {
    const ticker = new Ticker();
    const screen = new SkinSandboxScreen({ assets: mockAssets(), ticker });
    screen.layout(1024, 768);
    expect(() => screen.dispose()).not.toThrow();
  });
});
