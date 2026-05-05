import { GlProgram, Mesh, MeshGeometry, Shader, UniformGroup } from "pixi.js";
import type { PatternBundle } from "./patternMesh.js";

// Foil Mesh: replaces the screen-space foil filter.
//
// The previous filter rendered finish effects (foil/chrome/holographic +
// shimmer/pulse/drift motion) in framebuffer space, so under tilt the
// rainbow band sweeps and pixel grid stayed axis-aligned while the card
// silhouette sheared. Like the pattern Mesh, this Mesh runs the finish
// shader in mesh-local space so the pixel grid + sweep + drift all
// follow the card's perspective.
//
// Rendered ON TOP of the pattern Mesh with screen blend so highlights
// brighten without darkening, mirroring the old foil filter's screen
// composite. Strength is modulated by the gloss texture from the same
// pattern bundle — finish only catches strongly on metallic pixels.

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

uniform float uTime;
uniform float uFinish;
uniform float uMotion;
uniform float uSeed;

uniform float uFoilStrength;
uniform float uChromeStrength;
uniform float uHoloStrength;

uniform float uShimmerSpeed;
uniform float uShimmerWidth;
uniform float uPulseSpeed;
uniform float uPulseAmount;
uniform float uDriftSpeed;

uniform vec2 uTileScale;
uniform vec2 uTileOffset;
uniform vec2 uCardSize;
uniform float uCornerRadius;
uniform vec2 uPixelGrid;
// (skewX, skewY) of the card. Tilting rotates the visible portion of
// the rainbow, brightens the highlight catch, and shifts the foil band's
// phase — the shimmer/diffraction response to tilt is what makes a
// holographic card look real.
uniform vec2 uViewTilt;

const float HUE_STEPS = 6.0;
const float TIME_QUANT = 8.0;

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

  // Pixel-art UV (card-local — pixel grid shears with the card under tilt).
  vec2 pixelUv = floor(vUV * uPixelGrid) / uPixelGrid;
  float quantTime = floor(uTime * TIME_QUANT) / TIME_QUANT;

  // Gloss modulation: per-pixel shine factor from the pattern bundle.
  vec2 tileUV = fract(vUV * uTileScale + uTileOffset);
  float gloss = texture(uGlossMap, tileUV).r;

  // Motion: sweeping band (shimmer), intensity oscillation (pulse), or
  // hue-direction drift.
  float motionPulse = 0.0;
  if (uMotion > 0.5 && uMotion < 1.5) {
    float band = fract(pixelUv.x + pixelUv.y * 0.5 + quantTime * uShimmerSpeed + uSeed);
    float w = max(uShimmerWidth, 0.001);
    motionPulse = step(0.5 - w, band) * step(band, 0.5 + w) * 0.45;
  } else if (uMotion > 1.5 && uMotion < 2.5) {
    motionPulse = (0.5 + 0.5 * sin(quantTime * uPulseSpeed + uSeed * 6.28318)) * uPulseAmount;
  }
  float driftT = (uMotion > 2.5) ? quantTime * uDriftSpeed : 0.0;

  // Tilt-driven hue shift. Real holographic foil diffracts: the visible
  // colors cycle as you change viewing angle. Mapping the card's skew
  // into the hue offset produces the same effect — tilt the card and
  // the rainbow rolls, which sells the "this is a real shiny card" feel.
  float tiltHueShift = uViewTilt.x * 1.4 + uViewTilt.y * 1.1;
  float tiltMag = length(uViewTilt);

  vec3 sheen = vec3(0.0);
  float strength = 0.0;

  if (uFinish < 1.5) {
    // FOIL: chunky diagonal hue band + sweeping highlight.
    float diag = pixelUv.x * 1.6 + pixelUv.y * 0.5;
    float h = fract(diag + driftT + tiltHueShift + uSeed);
    vec3 rainbow = huePalette(h);

    float bandPos = fract(diag * 0.7 + quantTime * 0.22 + tiltHueShift * 0.6 + uSeed);
    float spec = step(0.42, bandPos) * step(bandPos, 0.58);

    sheen = rainbow * 0.95 + vec3(spec) * 0.7;
    strength = uFoilStrength;
  } else if (uFinish < 2.5) {
    // CHROME: stepped vertical gradient + sharp sweeping highlight column.
    // Tilt also nudges the sweep so highlights track the card angle.
    float horizon = 1.0 - abs(pixelUv.y - 0.5) * 2.0;
    horizon = floor(max(horizon, 0.0) * 4.0) / 4.0;
    vec3 sky = mix(vec3(0.32, 0.42, 0.58), vec3(0.92, 0.94, 0.98), horizon);
    sky = mix(sky, vec3(0.95, 0.82, 0.62), step(0.7, 1.0 - horizon) * 0.4);

    float sweepBase = 0.5 + 0.42 * sin(quantTime * 0.35 + uSeed * 6.28318) + uViewTilt.x * 1.2;
    float sweepX = floor(clamp(sweepBase, 0.0, 1.0) * uPixelGrid.x) / uPixelGrid.x;
    float sweep = step(abs(pixelUv.x - sweepX) * uPixelGrid.x, 1.5);

    sheen = sky + vec3(sweep) * 0.6;
    strength = uChromeStrength;
  } else {
    // HOLOGRAPHIC: three quantized hue ramps + grid-aligned sparkle.
    // Each ramp gets the tilt phase added so all three rainbows shift
    // together when the card turns.
    float r1 = fract(pixelUv.x * 1.4 + driftT + tiltHueShift + uSeed);
    float r2 = fract(pixelUv.y * 1.8 - driftT * 0.6 + tiltHueShift * 0.7 + uSeed * 0.3);
    float r3 = fract((pixelUv.x + pixelUv.y) * 0.95 + driftT * 1.5 + tiltHueShift * 1.3 + uSeed * 0.7);
    vec3 holo = (huePalette(r1) + huePalette(r2) + huePalette(r3)) * 0.5;

    vec2 grid = floor(pixelUv * uPixelGrid);
    float twinkle = floor(quantTime * 4.0 + uSeed * 17.0);
    float sparkle = step(0.93, hash21(grid + vec2(twinkle, twinkle * 1.3)));

    sheen = holo + vec3(sparkle);
    strength = uHoloStrength;
  }

  strength = clamp(strength + motionPulse, 0.0, 1.0);
  // Tilt boost: when the card is angled, real shiny finishes catch
  // significantly more light. Up to ~+80% strength at full tilt.
  strength *= 1.0 + tiltMag * 4.0;
  // Modulate by gloss so finish lights up on metallic pixels and stays
  // muted on matte ones — the gloss texture is the same one the pattern
  // shader uses for its specular highlight, so they harmonise.
  strength *= 0.25 + 0.75 * gloss;

  // Output the contribution color premultiplied with strength. Pixi's
  // screen blend on this mesh composes it over the pattern as
  //   result = src + dst - src*dst
  // which brightens rather than tints, the same as the old foil filter's
  // luminance-modulated screen blend.
  finalColor = vec4(sheen * strength, strength);
}
`;

interface FoilMeshUniforms {
  uTime: number;
  uFinish: number;
  uMotion: number;
  uSeed: number;
  uFoilStrength: number;
  uChromeStrength: number;
  uHoloStrength: number;
  uShimmerSpeed: number;
  uShimmerWidth: number;
  uPulseSpeed: number;
  uPulseAmount: number;
  uDriftSpeed: number;
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
    time: number;
    finish: number;
    motion: number;
    seed: number;
    tileScaleX: number;
    tileScaleY: number;
    tileOffsetX: number;
    tileOffsetY: number;
    viewTiltX: number;
    viewTiltY: number;
  }): void;
  setTunables(opts: {
    foilStrength: number;
    chromeStrength: number;
    holoStrength: number;
    shimmerSpeed: number;
    shimmerWidth: number;
    pulseSpeed: number;
    pulseAmount: number;
    driftSpeed: number;
  }): void;
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
    uTime: { value: 0, type: "f32" },
    uFinish: { value: 0, type: "f32" },
    uMotion: { value: 0, type: "f32" },
    uSeed: { value: 0, type: "f32" },
    uFoilStrength: { value: 0.45, type: "f32" },
    uChromeStrength: { value: 0.6, type: "f32" },
    uHoloStrength: { value: 0.75, type: "f32" },
    uShimmerSpeed: { value: 0.4, type: "f32" },
    uShimmerWidth: { value: 0.08, type: "f32" },
    uPulseSpeed: { value: 2.5, type: "f32" },
    uPulseAmount: { value: 0.25, type: "f32" },
    uDriftSpeed: { value: 0.08, type: "f32" },
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
  // Screen blend so the finish brightens rather than darkens — same
  // composite the old foil filter did via its inverse-then-multiply trick.
  mesh.blendMode = "screen";

  const u = uniforms.uniforms as FoilMeshUniforms;

  return {
    view: mesh,
    setBundle(next) {
      shader.resources.uGlossMap = next.gloss.source;
      shader.resources.uGlossSampler = next.gloss.source.style;
    },
    setLook(opts) {
      u.uTime = opts.time;
      u.uFinish = opts.finish;
      u.uMotion = opts.motion;
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
      u.uShimmerSpeed = opts.shimmerSpeed;
      u.uShimmerWidth = opts.shimmerWidth;
      u.uPulseSpeed = opts.pulseSpeed;
      u.uPulseAmount = opts.pulseAmount;
      u.uDriftSpeed = opts.driftSpeed;
    },
    setPixelGrid(cellsX, cellsY) {
      u.uPixelGrid[0] = cellsX;
      u.uPixelGrid[1] = cellsY;
    },
  };
}
