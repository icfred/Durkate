import { GlProgram, Mesh, MeshGeometry, Shader, type Texture, UniformGroup } from "pixi.js";

// Pattern bundle: pure structural data, no colors. The palette comes from
// a separately-selected Colorway, set on the mesh via setColorway. This
// lets the same pattern shape be re-skinned with any colorway, and lets
// COLORWAY exist as its own axis in the spec.
export interface PatternBundle {
  /** Surface elevation. R = 0..1. Drives Lambert lighting + Fresnel rim. */
  height: Texture;
  /**
   * Per-pixel region ID, encoded as round((id / 7) * 255) so the shader
   * can recover via int(round(r * 7.0)). 8 regions max. Sample with
   * NEAREST filter — region IDs must not interpolate across boundaries.
   */
  regionId: Texture;
  /**
   * Where the metallic/holographic finish stamps. R = 0..1; the foil
   * shader gloss-gates by this. Renamed from "gloss" to clarify intent
   * — it's a stencil for the finish, not a PBR property.
   */
  finishMask: Texture;
}

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

uniform sampler2D uHeightMap;
uniform sampler2D uRegionMap;
uniform sampler2D uFinishMask;
uniform sampler2D uScratchMap;

// Colorway palette: 8 RGBA colors. The pattern's regionId per pixel
// indexes into this. Storing as vec4 (alpha unused) avoids std140
// padding pitfalls that vec3 arrays trigger in some drivers.
uniform vec4 uPalette[8];

uniform vec2 uTileScale;
uniform vec2 uTileOffset;
uniform float uOverlayAlpha;
uniform float uBumpScale;
uniform float uTexelSize;
uniform vec2 uCardSize;
uniform float uCornerRadius;
uniform vec2 uViewTilt;
uniform float uWear;

float roundedRectSdf(vec2 px, vec2 size, float r) {
  vec2 q = abs(px - size * 0.5) - (size * 0.5 - r);
  return length(max(q, vec2(0.0))) + min(max(q.x, q.y), 0.0) - r;
}

void main() {
  vec2 px = vUV * uCardSize;
  float sdf = roundedRectSdf(px, uCardSize, uCornerRadius);
  if (sdf > 0.5) discard;
  float maskA = clamp(0.5 - sdf, 0.0, 1.0);

  vec2 tileUV = fract(vUV * uTileScale + uTileOffset);

  // Region lookup: regionMap encodes 0..7 as 0..255 in even steps;
  // round(r * 7) recovers the integer region ID. Then look up the
  // colorway's palette at that region.
  float regionR = texture(uRegionMap, tileUV).r;
  int region = int(clamp(floor(regionR * 7.0 + 0.5), 0.0, 7.0));
  vec3 color = uPalette[region].rgb;

  float finishMask = texture(uFinishMask, tileUV).r;

  float hL = texture(uHeightMap, fract(tileUV - vec2(uTexelSize, 0.0))).r;
  float hR = texture(uHeightMap, fract(tileUV + vec2(uTexelSize, 0.0))).r;
  float hT = texture(uHeightMap, fract(tileUV - vec2(0.0, uTexelSize))).r;
  float hB = texture(uHeightMap, fract(tileUV + vec2(0.0, uTexelSize))).r;
  vec3 baseNormal = normalize(vec3(
    -(hR - hL) * uBumpScale,
    -(hB - hT) * uBumpScale,
    1.0
  ));

  vec3 tiltVec = vec3(uViewTilt.y, -uViewTilt.x, 0.0) * 2.5;
  vec3 normal = normalize(baseNormal + tiltVec);

  vec3 lightDir = normalize(vec3(-0.5, -0.5, 0.7));

  float lambert = max(0.0, dot(normal, lightDir));
  float ambient = 0.4;
  float lit = ambient + (1.0 - ambient) * lambert;

  vec3 viewDir = vec3(0.0, 0.0, 1.0);
  vec3 halfway = normalize(lightDir + viewDir);
  float specPower = mix(8.0, 48.0, finishMask);
  float spec = pow(max(0.0, dot(normal, halfway)), specPower);
  vec3 highlight = vec3(spec * finishMask);

  float fresnel = pow(1.0 - max(0.0, dot(normal, viewDir)), 3.0);
  highlight += vec3(fresnel) * (0.35 + 0.65 * finishMask);

  float height = texture(uHeightMap, tileUV).r;
  vec3 finalRGB = color * lit + highlight;

  // Wear: scratch-map driven. Same pipeline as before — only the
  // texture sampling for color changed.
  if (uWear > 0.001) {
    vec3 stock = vec3(0.94, 0.91, 0.86);
    float wearThreshold = texture(uScratchMap, vUV).r;
    float scratchAmount = smoothstep(wearThreshold - 0.06, wearThreshold + 0.02, uWear);
    finalRGB = mix(finalRGB, stock * 1.05, scratchAmount * 0.7);
    finalRGB *= 1.0 - (1.0 - height) * uWear * 0.25;
    float wlum = dot(finalRGB, vec3(0.299, 0.587, 0.114));
    finalRGB = mix(finalRGB, vec3(wlum) * 0.92, uWear * 0.2);
  }

  finalColor = vec4(finalRGB, uOverlayAlpha * maskA);
}
`;

interface PatternMeshUniforms {
  uTileScale: Float32Array;
  uTileOffset: Float32Array;
  uOverlayAlpha: number;
  uBumpScale: number;
  uTexelSize: number;
  uCardSize: Float32Array;
  uCornerRadius: number;
  uViewTilt: Float32Array;
  uWear: number;
  uPalette: Float32Array;
}

export interface PatternMeshController {
  view: Mesh<MeshGeometry, Shader>;
  setBundle(bundle: PatternBundle): void;
  /** Replace the active colorway. Pass an array of 8 packed RGB ints. */
  setColorway(palette: readonly number[]): void;
  setLook(opts: {
    tileScaleX: number;
    tileScaleY: number;
    tileOffsetX: number;
    tileOffsetY: number;
    overlayAlpha: number;
    bumpScale: number;
    texelSize: number;
    viewTiltX: number;
    viewTiltY: number;
    wear: number;
  }): void;
}

export function createPatternMesh(
  bundle: PatternBundle,
  scratchMap: Texture,
  cardWidth: number,
  cardHeight: number,
): PatternMeshController {
  const positions = new Float32Array([0, 0, cardWidth, 0, cardWidth, cardHeight, 0, cardHeight]);
  const uvs = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]);
  const indices = new Uint32Array([0, 1, 2, 0, 2, 3]);

  const geometry = new MeshGeometry({ positions, uvs, indices });
  const glProgram = GlProgram.from({ vertex, fragment, name: "pattern-mesh" });

  const uniforms = new UniformGroup({
    uTileScale: { value: new Float32Array([1, 1]), type: "vec2<f32>" },
    uTileOffset: { value: new Float32Array([0, 0]), type: "vec2<f32>" },
    uOverlayAlpha: { value: 0.55, type: "f32" },
    uBumpScale: { value: 2.0, type: "f32" },
    uTexelSize: { value: 1 / 48, type: "f32" },
    uCardSize: { value: new Float32Array([cardWidth, cardHeight]), type: "vec2<f32>" },
    uCornerRadius: { value: 4, type: "f32" },
    uViewTilt: { value: new Float32Array([0, 0]), type: "vec2<f32>" },
    uWear: { value: 0, type: "f32" },
    // 8 vec4 palette colors = 32 floats. Pixi v8's UniformGroup uses
    // `type + size` to declare arrays rather than the wgsl array<…> form.
    // Defaults to magenta so a missing setColorway() call is visually
    // obvious during testing.
    uPalette: { value: defaultPalette(), type: "vec4<f32>", size: 8 },
  });

  const shader = new Shader({
    glProgram,
    resources: {
      patternUniforms: uniforms,
      uHeightMap: bundle.height.source,
      uHeightSampler: bundle.height.source.style,
      uRegionMap: bundle.regionId.source,
      uRegionSampler: bundle.regionId.source.style,
      uFinishMask: bundle.finishMask.source,
      uFinishMaskSampler: bundle.finishMask.source.style,
      uScratchMap: scratchMap.source,
      uScratchSampler: scratchMap.source.style,
    },
  });

  const mesh = new Mesh<MeshGeometry, Shader>({ geometry, shader });
  const u = uniforms.uniforms as PatternMeshUniforms;

  return {
    view: mesh,
    setBundle(next) {
      shader.resources.uHeightMap = next.height.source;
      shader.resources.uHeightSampler = next.height.source.style;
      shader.resources.uRegionMap = next.regionId.source;
      shader.resources.uRegionSampler = next.regionId.source.style;
      shader.resources.uFinishMask = next.finishMask.source;
      shader.resources.uFinishMaskSampler = next.finishMask.source.style;
    },
    setColorway(palette) {
      for (let i = 0; i < 8; i++) {
        const c = palette[i] ?? 0xffffff;
        u.uPalette[i * 4] = ((c >> 16) & 0xff) / 255;
        u.uPalette[i * 4 + 1] = ((c >> 8) & 0xff) / 255;
        u.uPalette[i * 4 + 2] = (c & 0xff) / 255;
        u.uPalette[i * 4 + 3] = 1;
      }
    },
    setLook(opts) {
      u.uTileScale[0] = opts.tileScaleX;
      u.uTileScale[1] = opts.tileScaleY;
      u.uTileOffset[0] = opts.tileOffsetX;
      u.uTileOffset[1] = opts.tileOffsetY;
      u.uOverlayAlpha = opts.overlayAlpha;
      u.uBumpScale = opts.bumpScale;
      u.uTexelSize = opts.texelSize;
      u.uViewTilt[0] = opts.viewTiltX;
      u.uViewTilt[1] = opts.viewTiltY;
      u.uWear = opts.wear;
    },
  };
}

function defaultPalette(): Float32Array {
  // Pure magenta in every slot — visually loud so a missing colorway
  // bind is impossible to miss in dev.
  const buf = new Float32Array(32);
  for (let i = 0; i < 8; i++) {
    buf[i * 4] = 1;
    buf[i * 4 + 1] = 0;
    buf[i * 4 + 2] = 1;
    buf[i * 4 + 3] = 1;
  }
  return buf;
}

export type { Texture };
