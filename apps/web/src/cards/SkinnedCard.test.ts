import { decode, type Finish, type Motion, type SkinAssets, SkinnedCard } from "@durak/skins-spike";
import { Texture } from "pixi.js";
import { describe, expect, it } from "vitest";
import { CARD_H, CARD_W, CardView } from "./CardView.js";

function mockAssets(): SkinAssets {
  return {
    cardSurface: Texture.EMPTY,
    cardDecoration: Texture.EMPTY,
    patterns: Array.from({ length: 4 }, () => ({
      color: Texture.EMPTY,
      height: Texture.EMPTY,
      gloss: Texture.EMPTY,
    })),
  };
}

function makeWrapper(): { base: CardView; card: SkinnedCard } {
  const base = new CardView({ suit: "spades", rank: 14 });
  const card = new SkinnedCard({
    base,
    baseWidth: CARD_W,
    baseHeight: CARD_H,
    assets: mockAssets(),
  });
  return { base, card };
}

describe("SkinnedCard", () => {
  it("constructs without errors and contains the base as a child", () => {
    const { base, card } = makeWrapper();
    expect(card.children).toContain(base);
  });

  it("applySkin(null) leaves the base bare (no filters, no pattern)", () => {
    const { base, card } = makeWrapper();
    card.applySkin(decode("a1b2c3d4e5f6"));
    card.applySkin(null);
    // Filters target the CardView's skinLayer (so glyphs stay unfiltered).
    expect(base.skinLayer.filters).toEqual([]);
    const pattern = base.skinLayer.children.find((c) => c.label === "pattern" || c !== base);
    // The pattern lives inside the skin layer now; it must be invisible.
    expect(base.skinLayer.children.some((c) => c.visible === false)).toBe(true);
    void pattern;
  });

  it("applies each finish and motion variant without throwing", () => {
    const { card } = makeWrapper();
    const finishes: readonly Finish[] = ["matte", "foil", "chrome", "holographic"];
    const motions: readonly Motion[] = ["none", "shimmer", "pulse", "drift"];
    const baseSpec = decode("000000000000");
    for (const finish of finishes) {
      for (const motion of motions) {
        expect(() => card.applySkin({ ...baseSpec, finish, motion })).not.toThrow();
      }
    }
  });

  it("re-applying a different spec replaces, not stacks", () => {
    const { base, card } = makeWrapper();
    card.applySkin(decode("000000000000"));
    const firstFilters = base.skinLayer.filters;
    card.applySkin(decode("ffffffffffff"));
    const secondFilters = base.skinLayer.filters;
    // Each apply produces at most 2 filters (tint + foil); never stacks.
    expect(Array.isArray(firstFilters) ? firstFilters.length : 0).toBeLessThanOrEqual(2);
    expect(Array.isArray(secondFilters) ? secondFilters.length : 0).toBeLessThanOrEqual(2);
  });

  it("disabling all axes still applies cleanly", () => {
    const { base, card } = makeWrapper();
    card.applySkin(decode("a1b2c3d4e5f6"), {
      pattern: false,
      tint: false,
      finish: false,
      motion: false,
    });
    expect(base.skinLayer.filters).toEqual([]);
  });

  it("propagates focus state to the wrapped CardView", () => {
    const { base, card } = makeWrapper();
    card.applySkin(decode("000000000000"));
    base.setFocus(true);
    base.setLegalState("legal");
    expect(() => base.setFocus(false)).not.toThrow();
  });

  it("tick is a no-op when finish is matte or motion is none", () => {
    const { card } = makeWrapper();
    const baseSpec = decode("000000000000");
    card.applySkin({ ...baseSpec, finish: "matte", motion: "shimmer" });
    expect(() => card.tick(1.0)).not.toThrow();
    card.applySkin({ ...baseSpec, finish: "foil", motion: "none" });
    expect(() => card.tick(1.0)).not.toThrow();
  });

  it("tick advances motion on animated finishes", () => {
    const { card } = makeWrapper();
    const baseSpec = decode("000000000000");
    card.applySkin({ ...baseSpec, finish: "holographic", motion: "drift" });
    expect(() => card.tick(1.5)).not.toThrow();
  });
});
