import { GlProgram, Mesh, MeshGeometry, Shader, type Texture, UniformGroup } from "pixi.js";
import type { PatternBundle } from "./patternMesh.js";

// Foil Mesh: renders the metallic finish stamping on top of the pattern.
// Composition by finish:
//
//   - Silver / Gold / Bronze — STAMPED metallic. Same gloss-gated
//     coverage as the pattern's pre-existing finish-mask: foil shows
//     up only where the pattern's gloss map is high. Each metal has
//     its own colour ramp (cool / warm / rim) but shares the same
//     metallic gradient + tilt-tracking sweep + height embossing.
//
//   - Holographic — STAMPED iridescent. Three smooth rainbow ramps
//     interfering, with tilt-driven hue shift.
//
// Wear is driven by a scratch-map texture: per-pixel wear thresholds
// generated procedurally (long curved scratches, short scuffs, point
// chips, edge ramp). Pixels with threshold ≤ uWear show wear, with
// the foil's alpha chipping off entirely there to reveal the pattern.

const vertex = `
in vec2 aPosition;
in vec2 aUV;
out vec2 vUV;

uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform mat3 uTransformMatrix;

void main(void) {
  mat3 mvp = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
  gl_Position = vec4((mvp * vec3(aPosition, 1.0)).xy, 0.0, 1.0);
  vUV = aUV;
}
`;

const fragment = `
in vec2 vUV;
out vec4 finalColor;

uniform sampler2D uGlossMap;
uniform sampler2D uHeightMap;
uniform sampler2D uScratchMap;

uniform float uFinish;
uniform float uSeed;

uniform float uMetalStrength;
uniform float uHoloStrength;

uniform vec2 uTileScale;
uniform vec2 uTileOffset;
uniform vec2 uCardSize;
uniform float uCornerRadius;
uniform vec2 uPixelGrid;
uniform vec2 uViewTilt;
uniform float uWear;

vec3 huePalette(float h) {
  h = fract(h);
  return clamp(vec3(
    abs(h * 6.0 - 3.0) - 1.0,
    2.0 - abs(h * 6.0 - 2.0),
    2.0 - abs(h * 6.0 - 4.0)
  ), 0.0, 1.0);
}

float hash21(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

float roundedRectSdf(vec2 px, vec2 size, float r) {
  vec2 q = abs(px - size * 0.5) - (size * 0.5 - r);
  return length(max(q, vec2(0.0))) + min(max(q.x, q.y), 0.0) - r;
}

void main() {
  vec2 px = vUV * uCardSize;
  float sdf = roundedRectSdf(px, uCardSize, uCornerRadius);
  if (sdf > 0.5) discard;
  if (uFinish < 0.5) discard;

  vec2 pixelUv = floor(vUV * uPixelGrid) / uPixelGrid;

  vec2 tileUV = fract(vUV * uTileScale + uTileOffset);
  float gloss = texture(uGlossMap, tileUV).r;
  float height = texture(uHeightMap, tileUV).r;

  float tiltMag = length(uViewTilt);

  vec3 sheen = vec3(0.0);
  float strength = 0.0;

  // Gloss gating — both metals and holo stamp ONLY where the pattern's
  // gloss map is high. The previous range (0.35-0.78) was greedy: it
  // covered most of every voronoi cell and most fbm vein peaks, which
  // meant the pattern's varied colours were mostly hidden under foil.
  // Tightening to 0.55-0.88 means stamps land just on the brightest
  // peaks; the rest of the pattern stays visible as the colour layer.
  float coverage = smoothstep(0.55, 0.88, gloss);

  if (uFinish < 3.5) {
    // METALLIC: Silver (1) / Gold (2) / Bronze (3). Each has its own
    // dark→bright→rim colour ramp. The metallic gradient + sweep +
    // embossing pipeline is shared.
    vec3 cool, warm, rim;
    if (uFinish < 1.5) {
      // Silver: cool blue-grey to bright white, blue rim.
      cool = vec3(0.32, 0.40, 0.55);
      warm = vec3(0.96, 0.97, 1.00);
      rim  = vec3(0.55, 0.62, 0.78);
    } else if (uFinish < 2.5) {
      // Gold: deep amber to bright yellow, orange rim.
      cool = vec3(0.40, 0.26, 0.08);
      warm = vec3(1.00, 0.93, 0.55);
      rim  = vec3(1.00, 0.65, 0.28);
    } else {
      // Bronze: dark umber to warm copper, rust rim.
      cool = vec3(0.22, 0.13, 0.07);
      warm = vec3(0.94, 0.66, 0.40);
      rim  = vec3(0.78, 0.42, 0.20);
    }

    // Stepped vertical metallic gradient. Same 4-step quantization as
    // the previous chrome shader so it reads as polished metal in
    // pixel-art style.
    float horizon = 1.0 - abs(pixelUv.y - 0.5) * 2.0;
    horizon = floor(max(horizon, 0.0) * 4.0) / 4.0;
    vec3 metalBase = mix(cool, warm, horizon);
    metalBase = mix(metalBase, rim, step(0.7, 1.0 - horizon) * 0.55);

    // Tilt-tracking sweep highlight. Single-column wide. Fades in
    // with tilt magnitude — invisible at rest, ramps up past 0.015 rad.
    float sweepBase = clamp(0.5 + uViewTilt.x * 2.5, 0.0, 1.0);
    float sweepX = floor(sweepBase * uPixelGrid.x) / uPixelGrid.x;
    float sweep = step(abs(pixelUv.x - sweepX) * uPixelGrid.x, 0.5);
    sweep *= smoothstep(0.015, 0.06, tiltMag);

    // Height embossing — pattern bumps brighten the metal, valleys
    // darken. Multiplicative so it preserves the metal's hue.
    float emboss = 0.55 + 0.7 * height;

    sheen = (metalBase + vec3(sweep) * 0.85) * emboss;
    strength = coverage * uMetalStrength;
  } else {
    // HOLOGRAPHIC — stamped rainbow. Three smooth hue ramps max-blended
    // with a height-driven 4th ramp for relief, plus Gaussian sparkles.
    float tiltHueShift = uViewTilt.x * 1.4 + uViewTilt.y * 1.1;

    float r1 = fract(pixelUv.x * 1.4 + tiltHueShift + uSeed);
    float r2 = fract(pixelUv.y * 1.8 + tiltHueShift * 0.7 + uSeed * 0.3);
    float r3 = fract((pixelUv.x + pixelUv.y) * 0.95 + tiltHueShift * 1.3 + uSeed * 0.7);
    float r4 = fract(height * 2.5 + tiltHueShift * 1.8 + uSeed * 1.1);

    vec3 c1 = huePalette(r1);
    vec3 c2 = huePalette(r2);
    vec3 c3 = huePalette(r3);
    vec3 c4 = huePalette(r4);
    vec3 holo = max(max(c1, c2), max(c3, c4));

    vec2 grid = floor(pixelUv * uPixelGrid);
    float tiltPhase = floor(uViewTilt.x * 12.0 + uViewTilt.y * 9.0 + uSeed * 17.0);
    float sparkleHash = hash21(grid + vec2(tiltPhase, tiltPhase * 1.3));
    float sparkle = pow(max(0.0, sparkleHash - 0.82) * 5.55, 2.0);

    sheen = holo * (0.7 + 0.3 * height) + vec3(sparkle);
    strength = coverage * uHoloStrength;
  }

  // Tilt boost: shiny finishes catch significantly more light at
  // glancing angles.
  strength *= 1.0 + tiltMag * 1.6;
  strength = clamp(strength, 0.0, 1.0);

  // Wear: scratch-map driven. Pixels with threshold ≤ uWear chip the
  // foil's alpha entirely, exposing the pattern beneath. What finish
  // remains is desaturated as the foil's diffraction film degrades.
  if (uWear > 0.001) {
    float wearThreshold = texture(uScratchMap, vUV).r;
    float scratchAmount = smoothstep(wearThreshold - 0.06, wearThreshold + 0.02, uWear);
    strength *= 1.0 - scratchAmount * 0.95;
    float wlum = dot(sheen, vec3(0.299, 0.587, 0.114));
    sheen = mix(sheen, vec3(wlum) * 0.82, uWear * 0.4);
  }

  finalColor = vec4(sheen * strength, strength);
}
`;

interface FoilMeshUniforms {
  uFinish: number;
  uSeed: number;
  uMetalStrength: number;
  uHoloStrength: number;
  uTileScale: Float32Array;
  uTileOffset: Float32Array;
  uCardSize: Float32Array;
  uCornerRadius: number;
  uPixelGrid: Float32Array;
  uViewTilt: Float32Array;
  uWear: number;
}

export interface FoilMeshController {
  view: Mesh<MeshGeometry, Shader>;
  setBundle(bundle: PatternBundle): void;
  setLook(opts: {
    finish: number;
    seed: number;
    tileScaleX: number;
    tileScaleY: number;
    tileOffsetX: number;
    tileOffsetY: number;
    viewTiltX: number;
    viewTiltY: number;
    wear: number;
  }): void;
  setTunables(opts: { metalStrength: number; holoStrength: number }): void;
  setPixelGrid(cellsX: number, cellsY: number): void;
}

export function createFoilMesh(
  bundle: PatternBundle,
  scratchMap: Texture,
  cardWidth: number,
  cardHeight: number,
): FoilMeshController {
  const positions = new Float32Array([0, 0, cardWidth, 0, cardWidth, cardHeight, 0, cardHeight]);
  const uvs = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]);
  const indices = new Uint32Array([0, 1, 2, 0, 2, 3]);

  const geometry = new MeshGeometry({ positions, uvs, indices });
  const glProgram = GlProgram.from({ vertex, fragment, name: "foil-mesh" });

  const uniforms = new UniformGroup({
    uFinish: { value: 0, type: "f32" },
    uSeed: { value: 0, type: "f32" },
    uMetalStrength: { value: 0.95, type: "f32" },
    uHoloStrength: { value: 0.95, type: "f32" },
    uTileScale: { value: new Float32Array([1, 1]), type: "vec2<f32>" },
    uTileOffset: { value: new Float32Array([0, 0]), type: "vec2<f32>" },
    uCardSize: { value: new Float32Array([cardWidth, cardHeight]), type: "vec2<f32>" },
    uCornerRadius: { value: 4, type: "f32" },
    uPixelGrid: { value: new Float32Array([15, 22]), type: "vec2<f32>" },
    uViewTilt: { value: new Float32Array([0, 0]), type: "vec2<f32>" },
    uWear: { value: 0, type: "f32" },
  });

  const shader = new Shader({
    glProgram,
    resources: {
      foilUniforms: uniforms,
      uGlossMap: bundle.gloss.source,
      uGlossSampler: bundle.gloss.source.style,
      uHeightMap: bundle.height.source,
      uHeightSampler: bundle.height.source.style,
      uScratchMap: scratchMap.source,
      uScratchSampler: scratchMap.source.style,
    },
  });

  const mesh = new Mesh<MeshGeometry, Shader>({ geometry, shader });
  mesh.blendMode = "normal";

  const u = uniforms.uniforms as FoilMeshUniforms;

  return {
    view: mesh,
    setBundle(next) {
      shader.resources.uGlossMap = next.gloss.source;
      shader.resources.uGlossSampler = next.gloss.source.style;
      shader.resources.uHeightMap = next.height.source;
      shader.resources.uHeightSampler = next.height.source.style;
    },
    setLook(opts) {
      u.uFinish = opts.finish;
      u.uSeed = opts.seed;
      u.uTileScale[0] = opts.tileScaleX;
      u.uTileScale[1] = opts.tileScaleY;
      u.uTileOffset[0] = opts.tileOffsetX;
      u.uTileOffset[1] = opts.tileOffsetY;
      u.uViewTilt[0] = opts.viewTiltX;
      u.uViewTilt[1] = opts.viewTiltY;
      u.uWear = opts.wear;
    },
    setTunables(opts) {
      u.uMetalStrength = opts.metalStrength;
      u.uHoloStrength = opts.holoStrength;
    },
    setPixelGrid(cellsX, cellsY) {
      u.uPixelGrid[0] = cellsX;
      u.uPixelGrid[1] = cellsY;
    },
  };
}
