import { GlProgram, Mesh, MeshGeometry, Shader, UniformGroup } from "pixi.js";
import type { PatternBundle } from "./patternMesh.js";

// Foil Mesh: renders the finish (foil/chrome/holographic) on top of the
// pattern Mesh via screen-blend. Like the pattern Mesh, it runs in
// mesh-local space so its pixel grid + hue band + chrome sweep all shear
// with the card during tilt.
//
// All effect phases are tilt-driven, never time-driven. The "motion"
// of a real shiny card is its response to viewing angle — turning a
// foil card cycles the diffraction colors, sliding chrome shifts where
// the sweep highlight catches. We mirror that exactly: at rest the
// finish is static, tilting it makes the rainbow roll. Removing the
// time-based shimmer/pulse/drift sweeps lets the tilt response read
// cleanly.

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
// (skewX, skewY) of the card. Drives every animated aspect of the
// finish — rainbow phase, sweep position, sparkle pattern, brightness.
uniform vec2 uViewTilt;

const float HUE_STEPS = 6.0;

vec3 huePalette(float h) {
  h = floor(h * HUE_STEPS) / HUE_STEPS;
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

  // Pixel-art UV (card-local — pixel grid shears with the card).
  vec2 pixelUv = floor(vUV * uPixelGrid) / uPixelGrid;

  // Gloss modulation — same texture the pattern shader uses for its
  // specular, so the two stay harmonised: glossy pixels light up
  // brightly under finish, matte pixels stay muted.
  vec2 tileUV = fract(vUV * uTileScale + uTileOffset);
  float gloss = texture(uGlossMap, tileUV).r;

  // Tilt drives every animated phase. At rest (uViewTilt = 0) the
  // finish is fully static.
  float tiltHueShift = uViewTilt.x * 1.4 + uViewTilt.y * 1.1;
  float tiltMag = length(uViewTilt);

  vec3 sheen = vec3(0.0);
  float strength = 0.0;

  if (uFinish < 1.5) {
    // FOIL: chunky diagonal hue band + a static highlight sliver. The
    // hue offset is pure tilt-driven, so the rainbow rolls only when
    // the card turns.
    float diag = pixelUv.x * 1.6 + pixelUv.y * 0.5;
    float h = fract(diag + tiltHueShift + uSeed);
    vec3 rainbow = huePalette(h);

    float bandPos = fract(diag * 0.7 + tiltHueShift * 0.6 + uSeed);
    float spec = step(0.42, bandPos) * step(bandPos, 0.58);

    sheen = rainbow * 0.95 + vec3(spec) * 0.7;
    strength = uFoilStrength;
  } else if (uFinish < 2.5) {
    // CHROME: stepped vertical gradient with a horizontal sweep
    // highlight whose position tracks the card's horizontal tilt.
    // Centered when flat, slides toward whichever edge is leaning
    // forward — same way real polished chrome catches a window.
    float horizon = 1.0 - abs(pixelUv.y - 0.5) * 2.0;
    horizon = floor(max(horizon, 0.0) * 4.0) / 4.0;
    vec3 sky = mix(vec3(0.32, 0.42, 0.58), vec3(0.92, 0.94, 0.98), horizon);
    sky = mix(sky, vec3(0.95, 0.82, 0.62), step(0.7, 1.0 - horizon) * 0.4);

    float sweepBase = clamp(0.5 + uViewTilt.x * 2.5, 0.0, 1.0);
    float sweepX = floor(sweepBase * uPixelGrid.x) / uPixelGrid.x;
    float sweep = step(abs(pixelUv.x - sweepX) * uPixelGrid.x, 1.5);

    sheen = sky + vec3(sweep) * 0.6;
    strength = uChromeStrength;
  } else {
    // HOLOGRAPHIC: three quantized hue ramps + grid-aligned sparkle.
    // Tilt phase is added uniformly to all three so the rainbow
    // rotates as one when the card turns. Sparkle pattern shifts
    // discretely with tilt rather than animating over time — gives
    // the impression of catching new glints as you move the card.
    float r1 = fract(pixelUv.x * 1.4 + tiltHueShift + uSeed);
    float r2 = fract(pixelUv.y * 1.8 + tiltHueShift * 0.7 + uSeed * 0.3);
    float r3 = fract((pixelUv.x + pixelUv.y) * 0.95 + tiltHueShift * 1.3 + uSeed * 0.7);
    vec3 holo = (huePalette(r1) + huePalette(r2) + huePalette(r3)) * 0.5;

    vec2 grid = floor(pixelUv * uPixelGrid);
    float tiltPhase = floor(uViewTilt.x * 12.0 + uViewTilt.y * 9.0 + uSeed * 17.0);
    float sparkle = step(0.93, hash21(grid + vec2(tiltPhase, tiltPhase * 1.3)));

    sheen = holo + vec3(sparkle);
    strength = uHoloStrength;
  }

  // Tilt-magnitude brightness boost: real shiny finishes catch
  // significantly more light at glancing angles.
  strength *= 1.0 + tiltMag * 4.0;
  strength *= 0.25 + 0.75 * gloss;

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
  });

  const shader = new Shader({
    glProgram,
    resources: {
      foilUniforms: uniforms,
      uGlossMap: bundle.gloss.source,
      uGlossSampler: bundle.gloss.source.style,
    },
  });

  const mesh = new Mesh<MeshGeometry, Shader>({ geometry, shader });
  mesh.blendMode = "screen";

  const u = uniforms.uniforms as FoilMeshUniforms;

  return {
    view: mesh,
    setBundle(next) {
      shader.resources.uGlossMap = next.gloss.source;
      shader.resources.uGlossSampler = next.gloss.source.style;
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
