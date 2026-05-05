import { GlProgram, Mesh, MeshGeometry, Shader, UniformGroup } from "pixi.js";
import type { PatternBundle } from "./patternMesh.js";

// Foil Mesh: renders the finish on top of the pattern Mesh. Composition
// model differs by finish:
//
//   - Foil & Holographic — STAMPED via gloss gate. Alpha = 0 where the
//     pattern's gloss map is matte, alpha → 1 where gloss is high. The
//     pattern shows through unchanged in matte regions; in glossy
//     regions the foil/holo effect REPLACES the pattern color (normal
//     alpha blend). Mirrors how real foil-stamped cards work — the
//     rainbow appears only on the stamped elements, the rest is
//     ordinary ink.
//
//   - Chrome — FULL-COVERAGE. Alpha = 1 across the card; the chrome
//     gradient replaces the pattern entirely. The pattern's height map
//     is sampled and used to emboss the chrome (bumps brighten, valleys
//     darken) so the pattern's relief is still visible through the
//     metal surface.
//
// All effect phases are tilt-driven, never time-driven. Turning a foil
// card cycles the diffraction colors, sliding chrome shifts where the
// sweep highlight catches.

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

uniform float uFinish;
uniform float uSeed;

uniform float uFoilStrength;
uniform float uChromeStrength;
uniform float uHoloStrength;

uniform vec2 uTileScale;
uniform vec2 uTileOffset;
uniform vec2 uCardSize;
uniform float uCornerRadius;
uniform vec2 uPixelGrid;
uniform vec2 uViewTilt;
uniform float uWear;

// Smooth full-rainbow hue palette. Per-pixel quantization comes from the
// uPixelGrid sampling above — colors are uniform within each grid cell —
// so we don't need to also posterize the hue ramp itself, and removing
// that quantization gives much richer color transitions across the card.
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

  float tiltHueShift = uViewTilt.x * 1.4 + uViewTilt.y * 1.1;
  float tiltMag = length(uViewTilt);

  vec3 sheen = vec3(0.0);
  float strength = 0.0;

  if (uFinish < 1.5) {
    // FOIL — STAMPED. Alpha gates by gloss; in glossy areas the foil
    // replaces the pattern color, in matte areas the pattern shows
    // through unchanged. Two interfering diagonal hue bands blended by
    // height give the rainbow surface relief.
    float band1 = pixelUv.x * 1.6 + pixelUv.y * 0.5;
    float band2 = pixelUv.y * 2.0 - pixelUv.x * 0.4;
    float h = fract(mix(band1, band2, height * 0.6) + tiltHueShift + uSeed);
    vec3 rainbow = huePalette(h);

    float highlightCenter = 0.5 + uViewTilt.y * 1.6;
    float highlightDist = abs(pixelUv.y - highlightCenter);
    float highlight = exp(-highlightDist * highlightDist * 18.0);

    float subband = 0.5 + 0.5 * sin((band1 + tiltHueShift * 2.0) * 6.28318);
    float subbandIntensity = pow(subband, 4.0) * height;

    sheen = rainbow * (0.6 + 0.4 * height)
          + vec3(highlight) * 0.5
          + vec3(subbandIntensity) * 0.6;

    // Gloss gate: 0 below 0.35, ramps to 1 above 0.78. Anything matte
    // is fully transparent → pattern shows through.
    float coverage = smoothstep(0.35, 0.78, gloss);
    strength = coverage * uFoilStrength;
  } else if (uFinish < 2.5) {
    // CHROME — FULL COVERAGE. Punchier vertical metallic gradient +
    // tilt-fading sweep + stronger height embossing.
    float horizon = 1.0 - abs(pixelUv.y - 0.5) * 2.0;
    horizon = floor(max(horizon, 0.0) * 4.0) / 4.0;
    // Deep navy at edges, bright cream at horizon, warm gold rim.
    // More saturated than before so the metal reads as polished steel
    // rather than washed grey.
    vec3 sky = mix(vec3(0.16, 0.24, 0.46), vec3(0.99, 0.97, 0.92), horizon);
    sky = mix(sky, vec3(1.0, 0.85, 0.55), step(0.7, 1.0 - horizon) * 0.55);

    // Sweep fades in with tilt magnitude. At rest it's invisible —
    // the bright bar down the middle was reading as a permanent
    // feature rather than a movement-cue. Smoothstep starts at 0.015
    // rad so very small tilts stay clean, ramps in by 0.06.
    float sweepBase = clamp(0.5 + uViewTilt.x * 2.5, 0.0, 1.0);
    float sweepX = floor(sweepBase * uPixelGrid.x) / uPixelGrid.x;
    float sweep = step(abs(pixelUv.x - sweepX) * uPixelGrid.x, 0.5);
    sweep *= smoothstep(0.015, 0.06, tiltMag);

    // Stronger embossing — bumps brighten, valleys darken — so the
    // pattern's relief reads as etched metal.
    float emboss = 0.5 + 0.8 * height;

    sheen = (sky + vec3(sweep) * 0.85) * emboss;
    strength = uChromeStrength;
  } else {
    // HOLOGRAPHIC — STAMPED, like foil. Three smooth rainbow ramps
    // max-blended (most-saturated wins), plus a height-driven 4th
    // ramp for surface relief, plus Gaussian sparkles.
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

    // Same gloss gate as foil — holographic stamps onto the glossy
    // pattern elements, leaves matte ones alone.
    float coverage = smoothstep(0.35, 0.78, gloss);
    strength = coverage * uHoloStrength;
  }

  strength *= 1.0 + tiltMag * 1.6;
  strength = clamp(strength, 0.0, 1.0);

  // Wear: scratches and edge wear chip the finish off entirely
  // (alpha drop), revealing the pattern beneath. The colour that
  // remains also fades. Same scratch / edge math as the pattern
  // shader so they line up — scratches run continuously across
  // both layers, finish-on rubbed-off transitions are sharp.
  if (uWear > 0.001) {
    vec2 toEdge = min(px, uCardSize - px);
    float edgeDist = min(toEdge.x, toEdge.y);
    float edgeProx = pow(1.0 - smoothstep(0.0, 14.0, edgeDist), 1.8);
    float cornerProx = pow(1.0 - smoothstep(0.0, 11.0, max(toEdge.x, toEdge.y)), 2.0);
    float edgeWear = clamp(edgeProx + cornerProx * 0.6, 0.0, 1.0);

    mat2 rotA = mat2(0.97, 0.26, -0.26, 0.97);
    mat2 rotB = mat2(0.91, -0.42, 0.42, 0.91);
    vec2 sa = rotA * px;
    float ha = hash21(floor(vec2(sa.x / 1.5, sa.y / 26.0)));
    float scrA = step(0.99 - uWear * 0.15, ha);
    vec2 sb = rotB * px;
    float hb = hash21(floor(vec2(sb.x / 1.5, sb.y / 32.0)));
    float scrB = step(0.99 - uWear * 0.10, hb);
    float scratch = max(scrA, scrB);

    // Edge whitening eats the alpha — finish has rubbed off entirely
    // at corners and edges.
    strength *= 1.0 - edgeWear * uWear * 0.9;
    // Scratches chip alpha along long thin lines so the pattern shows
    // through where the foil has flaked off.
    strength *= 1.0 - scratch * uWear * 0.85;

    // What finish remains is duller — desaturated as the diffraction
    // film degrades.
    float wlum = dot(sheen, vec3(0.299, 0.587, 0.114));
    sheen = mix(sheen, vec3(wlum) * 0.82, uWear * 0.4);
  }

  finalColor = vec4(sheen * strength, strength);
}
`;

interface FoilMeshUniforms {
  uFinish: number;
  uSeed: number;
  uFoilStrength: number;
  uChromeStrength: number;
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
  setTunables(opts: { foilStrength: number; chromeStrength: number; holoStrength: number }): void;
  setPixelGrid(cellsX: number, cellsY: number): void;
}

export function createFoilMesh(
  bundle: PatternBundle,
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
    uFoilStrength: { value: 0.45, type: "f32" },
    uChromeStrength: { value: 0.6, type: "f32" },
    uHoloStrength: { value: 0.75, type: "f32" },
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
    },
  });

  const mesh = new Mesh<MeshGeometry, Shader>({ geometry, shader });
  // Normal blend (was "screen"): alpha gates how much of the foil
  // replaces the pattern. With strength near 1 in glossy stamped
  // regions and 0 elsewhere, foil cleanly stamps over the pattern.
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
      u.uFoilStrength = opts.foilStrength;
      u.uChromeStrength = opts.chromeStrength;
      u.uHoloStrength = opts.holoStrength;
    },
    setPixelGrid(cellsX, cellsY) {
      u.uPixelGrid[0] = cellsX;
      u.uPixelGrid[1] = cellsY;
    },
  };
}
