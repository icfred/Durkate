import { defaultFilterVert, Filter } from "pixi.js";

const fragment = `
in vec2 vTextureCoord;
out vec4 finalColor;

uniform sampler2D uTexture;
uniform float uTime;
uniform float uFinish;
uniform float uMotion;
uniform float uSeed;

vec3 huePalette(float h) {
  return clamp(vec3(
    abs(h * 6.0 - 3.0) - 1.0,
    2.0 - abs(h * 6.0 - 2.0),
    2.0 - abs(h * 6.0 - 4.0)
  ), 0.0, 1.0);
}

void main() {
  vec4 base = texture(uTexture, vTextureCoord);
  if (uFinish < 0.5 || base.a < 0.001) {
    finalColor = base;
    return;
  }

  float motionPulse = 0.0;
  if (uMotion > 0.5 && uMotion < 1.5) {
    float band = fract(vTextureCoord.x + vTextureCoord.y * 0.5 + uTime * 0.4 + uSeed);
    motionPulse = (smoothstep(0.42, 0.5, band) - smoothstep(0.5, 0.58, band)) * 0.45;
  } else if (uMotion > 1.5 && uMotion < 2.5) {
    motionPulse = (0.5 + 0.5 * sin(uTime * 2.5 + uSeed * 6.28318)) * 0.25;
  }

  float driftT = (uMotion > 2.5) ? uTime * 0.08 : 0.0;

  vec3 sheen;
  float strength;
  if (uFinish < 1.5) {
    float h = fract(vTextureCoord.x * 1.6 + driftT + uSeed);
    sheen = huePalette(h);
    strength = 0.45;
  } else if (uFinish < 2.5) {
    float band = fract(vTextureCoord.x + vTextureCoord.y + driftT);
    float v = 0.7 + 0.3 * sin(band * 6.28318);
    sheen = vec3(v, v, v * 1.05);
    strength = 0.6;
  } else {
    float h = fract(vTextureCoord.x + vTextureCoord.y * 0.7 + driftT + uSeed * 0.5);
    sheen = huePalette(h);
    strength = 0.75;
  }

  strength = clamp(strength + motionPulse, 0.0, 1.0);
  vec3 mixed = mix(base.rgb, base.rgb * sheen + sheen * 0.25, strength);
  finalColor = vec4(clamp(mixed, 0.0, 1.0), base.a);
}
`;

export interface FoilController {
  filter: Filter;
  setUniforms(time: number, finish: number, motion: number, seed: number): void;
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
      },
    },
  });

  const block = filter.resources.foilUniforms as {
    uniforms: { uTime: number; uFinish: number; uMotion: number; uSeed: number };
  };

  return {
    filter,
    setUniforms(time, finish, motion, seed) {
      block.uniforms.uTime = time;
      block.uniforms.uFinish = finish;
      block.uniforms.uMotion = motion;
      block.uniforms.uSeed = seed;
    },
  };
}
