import { defaultFilterVert, Filter, type Texture } from "pixi.js";

// Phase 2 pattern shader. Applied to a Sprite covering the card area; the
// uTexture passthrough is ignored (the sprite is just a placeholder so the
// filter has a region to render into). The shader samples three external
// textures from the pattern bundle:
//
//   - uColorMap: per-cell palette colors (flat — no lighting baked in)
//   - uHeightMap: per-pixel surface elevation
//   - uGlossMap: per-pixel "shine" factor
//
// Per-pixel lighting runs every frame so the light direction can animate
// (motion mode), and a Blinn-Phong-ish specular term modulated by gloss
// produces highlights that catch on metallic pixels rather than washing
// over the whole card. This is what makes Phase 2 procedural cards feel
// alive vs. Phase 1's baked-once-and-static lighting.
const fragment = `
in vec2 vTextureCoord;
out vec4 finalColor;

uniform sampler2D uTexture;       // unused — sprite-passthrough placeholder
uniform sampler2D uColorMap;
uniform sampler2D uHeightMap;
uniform sampler2D uGlossMap;

uniform float uTime;
uniform float uMotion;
uniform vec2 uTileScale;
uniform vec2 uTileOffset;
uniform float uOverlayAlpha;
uniform float uBumpScale;
uniform float uTexelSize;

void main() {
  // Mask: sample the sprite that hosts this filter. The displayobject is
  // a rounded-rect Graphics, so uTexture is opaque inside the rounded
  // silhouette and transparent outside — automatically tracks the
  // card's shape, including under parent skew/tilt. Earlier attempts to
  // compute the silhouette in-shader (rounded-rect SDF on vTextureCoord)
  // failed because under tilt the filter framebuffer is the sheared
  // sprite's AABB, so vTextureCoord is in AABB space rather than the
  // sprite's local space.
  vec4 spriteAlpha = texture(uTexture, vTextureCoord);
  if (spriteAlpha.a < 0.001) {
    finalColor = vec4(0.0);
    return;
  }

  // Tile UV: how many tile-repeats fit across the card.
  vec2 tileUV = fract(vTextureCoord * uTileScale + uTileOffset);

  vec3 color = texture(uColorMap, tileUV).rgb;
  float gloss = texture(uGlossMap, tileUV).r;

  // Height gradient via central difference (1 texel offset). fract() wraps
  // so neighbour samples at the tile edge come from the opposite side,
  // matching the seamless-tile property of the source bitmap.
  float hL = texture(uHeightMap, fract(tileUV - vec2(uTexelSize, 0.0))).r;
  float hR = texture(uHeightMap, fract(tileUV + vec2(uTexelSize, 0.0))).r;
  float hT = texture(uHeightMap, fract(tileUV - vec2(0.0, uTexelSize))).r;
  float hB = texture(uHeightMap, fract(tileUV + vec2(0.0, uTexelSize))).r;
  vec3 normal = normalize(vec3(
    -(hR - hL) * uBumpScale,
    -(hB - hT) * uBumpScale,
    1.0
  ));

  // Light direction varies by motion mode. uMotion floats: 0 none, 1
  // shimmer (sweep), 2 pulse (intensity), 3 drift (wobble).
  // Motion intensities are deliberately subtle — the pattern shader
  // composes with the foil shader on top, and full-throttle motion in
  // both fights for attention rather than feeling unified.
  vec3 lightDir;
  float pulseMod = 1.0;
  if (uMotion < 0.5) {
    lightDir = normalize(vec3(-0.5, -0.5, 0.7));
  } else if (uMotion < 1.5) {
    // Shimmer: small horizontal sweep around the default top-left.
    lightDir = normalize(vec3(-0.4 + sin(uTime * 1.5) * 0.3, -0.5, 0.7));
  } else if (uMotion < 2.5) {
    // Pulse: light direction stable, intensity gently oscillates.
    lightDir = normalize(vec3(-0.5, -0.5, 0.7));
    pulseMod = 0.78 + 0.22 * (0.5 + 0.5 * sin(uTime * 2.0));
  } else {
    // Drift: light wobbles in a small ellipse near top-left rather than
    // a full circular rotation — feels like a card being held with
    // gentle motion instead of a disco ball.
    float a = uTime * 0.35;
    lightDir = normalize(vec3(-0.45 + cos(a) * 0.2, -0.45 + sin(a) * 0.18, 0.7));
  }

  float lambert = max(0.0, dot(normal, lightDir));
  float ambient = 0.4;
  float lit = (ambient + (1.0 - ambient) * lambert) * pulseMod;

  // Specular highlight. Half-vector Blinn-Phong, exponent ramps with
  // gloss so glossy pixels get sharp pinpoint highlights and matte
  // pixels get a wider, dimmer one (or none, since we multiply by gloss).
  vec3 viewDir = vec3(0.0, 0.0, 1.0);
  vec3 halfway = normalize(lightDir + viewDir);
  float specPower = mix(8.0, 48.0, gloss);
  float spec = pow(max(0.0, dot(normal, halfway)), specPower);
  vec3 highlight = vec3(spec * gloss);

  vec3 finalRGB = color * lit + highlight;

  // Multiply alpha by sprite alpha so the rounded-rect edge is anti-
  // aliased exactly the way the bg's Graphics renders it.
  finalColor = vec4(finalRGB, uOverlayAlpha * spriteAlpha.a);
}
`;

interface PatternUniformBlock {
  uniforms: {
    uTime: number;
    uMotion: number;
    uTileScale: Float32Array;
    uTileOffset: Float32Array;
    uOverlayAlpha: number;
    uBumpScale: number;
    uTexelSize: number;
  };
}

export interface PatternBundle {
  color: Texture;
  height: Texture;
  gloss: Texture;
}

export interface PatternFilterController {
  filter: Filter;
  setBundle(bundle: PatternBundle): void;
  setLook(opts: {
    time: number;
    motion: number;
    tileScaleX: number;
    tileScaleY: number;
    tileOffsetX: number;
    tileOffsetY: number;
    overlayAlpha: number;
    bumpScale: number;
    texelSize: number;
  }): void;
}

export function createPatternFilter(initial: PatternBundle): PatternFilterController {
  const filter = Filter.from({
    gl: { vertex: defaultFilterVert, fragment },
    resources: {
      patternUniforms: {
        uTime: { value: 0, type: "f32" },
        uMotion: { value: 0, type: "f32" },
        uTileScale: { value: new Float32Array([1, 1]), type: "vec2<f32>" },
        uTileOffset: { value: new Float32Array([0, 0]), type: "vec2<f32>" },
        uOverlayAlpha: { value: 0.55, type: "f32" },
        uBumpScale: { value: 2.0, type: "f32" },
        uTexelSize: { value: 1 / 48, type: "f32" },
      },
      uColorMap: initial.color.source,
      uColorSampler: initial.color.source.style,
      uHeightMap: initial.height.source,
      uHeightSampler: initial.height.source.style,
      uGlossMap: initial.gloss.source,
      uGlossSampler: initial.gloss.source.style,
    },
  });

  const block = filter.resources.patternUniforms as PatternUniformBlock;
  const u = block.uniforms;

  return {
    filter,
    setBundle(bundle) {
      filter.resources.uColorMap = bundle.color.source;
      filter.resources.uColorSampler = bundle.color.source.style;
      filter.resources.uHeightMap = bundle.height.source;
      filter.resources.uHeightSampler = bundle.height.source.style;
      filter.resources.uGlossMap = bundle.gloss.source;
      filter.resources.uGlossSampler = bundle.gloss.source.style;
    },
    setLook(opts) {
      u.uTime = opts.time;
      u.uMotion = opts.motion;
      u.uTileScale[0] = opts.tileScaleX;
      u.uTileScale[1] = opts.tileScaleY;
      u.uTileOffset[0] = opts.tileOffsetX;
      u.uTileOffset[1] = opts.tileOffsetY;
      u.uOverlayAlpha = opts.overlayAlpha;
      u.uBumpScale = opts.bumpScale;
      u.uTexelSize = opts.texelSize;
    },
  };
}
