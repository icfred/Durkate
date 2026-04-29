import { defaultFilterVert, Filter } from "pixi.js";
import { defaultTunables, type FoilTunables, type MotionTunables } from "../tunables.js";

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

vec3 huePalette(float h) {
  return clamp(vec3(
    abs(h * 6.0 - 3.0) - 1.0,
    2.0 - abs(h * 6.0 - 2.0),
    2.0 - abs(h * 6.0 - 4.0)
  ), 0.0, 1.0);
}

float hash21(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

float gauss(float x, float sharpness) {
  return exp(-x * x * sharpness);
}

void main() {
  vec4 base = texture(uTexture, vTextureCoord);
  if (uFinish < 0.5 || base.a < 0.001) {
    finalColor = base;
    return;
  }

  float motionPulse = 0.0;
  if (uMotion > 0.5 && uMotion < 1.5) {
    float band = fract(vTextureCoord.x + vTextureCoord.y * 0.5 + uTime * uShimmerSpeed + uSeed);
    float w = max(uShimmerWidth, 0.001);
    motionPulse = (smoothstep(0.5 - w, 0.5, band) - smoothstep(0.5, 0.5 + w, band)) * 0.45;
  } else if (uMotion > 1.5 && uMotion < 2.5) {
    motionPulse = (0.5 + 0.5 * sin(uTime * uPulseSpeed + uSeed * 6.28318)) * uPulseAmount;
  }

  float driftT = (uMotion > 2.5) ? uTime * uDriftSpeed : 0.0;

  vec3 sheen = vec3(0.0);
  float strength = 0.0;

  if (uFinish < 1.5) {
    // FOIL: angled iridescent ramp with a moving specular highlight band.
    // The ramp gives the rainbow base, the gaussian band sells it as foil.
    float diag = vTextureCoord.x * 1.6 + vTextureCoord.y * 0.5;
    float perturb = sin(vTextureCoord.x * 17.0 + vTextureCoord.y * 13.0) * 0.05;
    float h = fract(diag + driftT + uSeed + perturb);
    vec3 rainbow = huePalette(h);

    float bandPos = fract(diag * 0.7 + uTime * 0.22 + uSeed);
    float spec = gauss((bandPos - 0.5) * 2.6, 8.0);

    sheen = rainbow * 0.85 + vec3(spec) * 0.6;
    strength = uFoilStrength;
  } else if (uFinish < 2.5) {
    // CHROME: vertical horizon-style gradient + a sweeping specular stripe.
    // Reads as a curved metal surface reflecting a sky / floor.
    float horizon = 1.0 - abs(vTextureCoord.y - 0.5) * 2.0;
    horizon = pow(max(horizon, 0.0), 0.6);
    vec3 sky = mix(vec3(0.32, 0.42, 0.58), vec3(0.95, 0.97, 1.0), horizon);
    sky = mix(sky, vec3(1.0, 0.86, 0.68), pow(max(1.0 - horizon, 0.0), 3.0) * 0.55);

    float sweepX = 0.5 + 0.42 * sin(uTime * 0.35 + uSeed * 6.28318);
    float sweep = gauss((vTextureCoord.x - sweepX) * 2.8, 9.0);

    sheen = sky + vec3(sweep) * 0.5;
    strength = uChromeStrength;
  } else {
    // HOLOGRAPHIC: layered iridescent ramps in different directions plus
    // glitter speckle that drifts with time. Multiple ramps interfere into
    // the angular hue shift you get on real holo stickers.
    float r1 = fract(vTextureCoord.x * 1.4 + driftT + uSeed);
    float r2 = fract(vTextureCoord.y * 1.8 - driftT * 0.6 + uSeed * 0.3);
    float r3 = fract((vTextureCoord.x + vTextureCoord.y) * 0.95 + driftT * 1.5 + uSeed * 0.7);
    vec3 holo = (huePalette(r1) + huePalette(r2) + huePalette(r3)) * 0.42;

    vec2 grid = floor(vTextureCoord * 90.0);
    float twinkle = floor(uTime * 4.0 + uSeed * 17.0);
    float sparkle = step(0.985, hash21(grid + vec2(twinkle, twinkle * 1.3)));

    sheen = holo + vec3(sparkle) * 0.95;
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
