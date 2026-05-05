import { defaultFilterVert, Filter } from "pixi.js";
import { defaultTunables, type FoilTunables, type MotionTunables } from "../tunables.js";

// Pixel-art aesthetic: every spatial sample is snapped to a coarse grid
// (uPixelGrid cells across the card) and every hue is quantized to a small
// number of bands (HUE_STEPS). Smooth gauss / smoothstep highlights are
// replaced with hard `step` thresholds. The result is a chunky shimmer that
// matches the rest of the game's pixel-art typography rather than the
// modern smooth-gradient digital look the spike originally shipped.
const fragment = `
in vec2 vTextureCoord;
out vec4 finalColor;

uniform sampler2D uTexture;
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

// Fixed pixel grid for the cosmetic layer. The in-game card is 60x88 logical
// units; 15x22 cells ≈ 4-unit blocks, which matches the pixel-art glyphs and
// patterns. Kept as a const (not a uniform) because it never varies.
const vec2 PIXEL_GRID = vec2(15.0, 22.0);
const float HUE_STEPS = 6.0;
const float TIME_QUANT = 8.0;  // animation snaps to ~8 frames/sec

vec3 huePalette(float h) {
  // Quantize to HUE_STEPS bands so the rainbow reads as discrete pixel-art
  // colors instead of a smooth ramp.
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

void main() {
  vec4 base = texture(uTexture, vTextureCoord);
  if (uFinish < 0.5 || base.a < 0.001) {
    finalColor = base;
    return;
  }

  // Snap the spatial sample to the pixel grid. Every glsl reference to
  // pixelUv below produces colour blocks aligned to integer cells rather
  // than smooth gradients.
  vec2 pixelUv = floor(vTextureCoord * PIXEL_GRID) / PIXEL_GRID;
  float quantTime = floor(uTime * TIME_QUANT) / TIME_QUANT;

  float motionPulse = 0.0;
  if (uMotion > 0.5 && uMotion < 1.5) {
    float band = fract(pixelUv.x + pixelUv.y * 0.5 + quantTime * uShimmerSpeed + uSeed);
    float w = max(uShimmerWidth, 0.001);
    // Hard step instead of smoothstep — pixel-art band, no soft falloff.
    motionPulse = step(0.5 - w, band) * step(band, 0.5 + w) * 0.45;
  } else if (uMotion > 1.5 && uMotion < 2.5) {
    motionPulse = (0.5 + 0.5 * sin(quantTime * uPulseSpeed + uSeed * 6.28318)) * uPulseAmount;
  }

  float driftT = (uMotion > 2.5) ? quantTime * uDriftSpeed : 0.0;

  vec3 sheen = vec3(0.0);
  float strength = 0.0;

  if (uFinish < 1.5) {
    // FOIL: chunky diagonal hue band. The ramp is quantized to HUE_STEPS;
    // the highlight is a hard step rather than a gaussian.
    float diag = pixelUv.x * 1.6 + pixelUv.y * 0.5;
    float h = fract(diag + driftT + uSeed);
    vec3 rainbow = huePalette(h);

    float bandPos = fract(diag * 0.7 + quantTime * 0.22 + uSeed);
    float spec = step(0.42, bandPos) * step(bandPos, 0.58);

    sheen = rainbow * 0.85 + vec3(spec) * 0.55;
    strength = uFoilStrength;
  } else if (uFinish < 2.5) {
    // CHROME: stepped vertical band gradient + a hard sweeping highlight
    // column. Reads as a sheet of brushed pixel-metal.
    float horizon = 1.0 - abs(pixelUv.y - 0.5) * 2.0;
    horizon = floor(max(horizon, 0.0) * 4.0) / 4.0;
    vec3 sky = mix(vec3(0.32, 0.42, 0.58), vec3(0.92, 0.94, 0.98), horizon);
    sky = mix(sky, vec3(0.95, 0.82, 0.62), step(0.7, 1.0 - horizon) * 0.4);

    float sweepX = floor((0.5 + 0.42 * sin(quantTime * 0.35 + uSeed * 6.28318)) * PIXEL_GRID.x) / PIXEL_GRID.x;
    float sweep = step(abs(pixelUv.x - sweepX) * PIXEL_GRID.x, 1.5);

    sheen = sky + vec3(sweep) * 0.45;
    strength = uChromeStrength;
  } else {
    // HOLOGRAPHIC: three quantized hue ramps interfering, plus chunky
    // sparkle squares aligned to the same pixel grid (no sub-pixel
    // glitter — every sparkle is a full grid cell that pops on/off in
    // sync with quantTime).
    float r1 = fract(pixelUv.x * 1.4 + driftT + uSeed);
    float r2 = fract(pixelUv.y * 1.8 - driftT * 0.6 + uSeed * 0.3);
    float r3 = fract((pixelUv.x + pixelUv.y) * 0.95 + driftT * 1.5 + uSeed * 0.7);
    vec3 holo = (huePalette(r1) + huePalette(r2) + huePalette(r3)) * 0.42;

    vec2 grid = floor(pixelUv * PIXEL_GRID);
    float twinkle = floor(quantTime * 4.0 + uSeed * 17.0);
    float sparkle = step(0.97, hash21(grid + vec2(twinkle, twinkle * 1.3)));

    sheen = holo + vec3(sparkle) * 0.85;
    strength = uHoloStrength;
  }

  strength = clamp(strength + motionPulse, 0.0, 1.0);

  // Luminance-modulated screen blend: dark areas keep their darkness,
  // light areas pick up the iridescent layer. Multiplicative blends washed
  // everything out; this preserves the underlying art.
  float lum = dot(base.rgb, vec3(0.299, 0.587, 0.114));
  vec3 contribution = sheen * strength * (0.35 + 0.65 * lum);
  vec3 inv = (1.0 - base.rgb) * (1.0 - clamp(contribution, 0.0, 1.0));
  vec3 mixed = 1.0 - inv;

  finalColor = vec4(clamp(mixed, 0.0, 1.0), base.a);
}
`;

interface FoilUniformBlock {
  uniforms: {
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
  };
}

export interface FoilController {
  filter: Filter;
  setLook(time: number, finish: number, motion: number, seed: number): void;
  setTunables(foil: FoilTunables, motion: MotionTunables): void;
}

export function createFoilFilter(): FoilController {
  const filter = Filter.from({
    gl: { vertex: defaultFilterVert, fragment },
    resources: {
      foilUniforms: {
        uTime: { value: 0, type: "f32" },
        uFinish: { value: 0, type: "f32" },
        uMotion: { value: 0, type: "f32" },
        uSeed: { value: 0, type: "f32" },
        uFoilStrength: { value: defaultTunables.foil.foilStrength, type: "f32" },
        uChromeStrength: { value: defaultTunables.foil.chromeStrength, type: "f32" },
        uHoloStrength: { value: defaultTunables.foil.holographicStrength, type: "f32" },
        uShimmerSpeed: { value: defaultTunables.motion.shimmerSpeed, type: "f32" },
        uShimmerWidth: { value: defaultTunables.motion.shimmerWidth, type: "f32" },
        uPulseSpeed: { value: defaultTunables.motion.pulseSpeed, type: "f32" },
        uPulseAmount: { value: defaultTunables.motion.pulseAmount, type: "f32" },
        uDriftSpeed: { value: defaultTunables.motion.driftSpeed, type: "f32" },
      },
    },
  });

  const block = filter.resources.foilUniforms as FoilUniformBlock;
  const u = block.uniforms;

  return {
    filter,
    setLook(time, finish, motion, seed) {
      u.uTime = time;
      u.uFinish = finish;
      u.uMotion = motion;
      u.uSeed = seed;
    },
    setTunables(foil, motion) {
      u.uFoilStrength = foil.foilStrength;
      u.uChromeStrength = foil.chromeStrength;
      u.uHoloStrength = foil.holographicStrength;
      u.uShimmerSpeed = motion.shimmerSpeed;
      u.uShimmerWidth = motion.shimmerWidth;
      u.uPulseSpeed = motion.pulseSpeed;
      u.uPulseAmount = motion.pulseAmount;
      u.uDriftSpeed = motion.driftSpeed;
    },
  };
}
