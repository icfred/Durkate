import { GlProgram, Mesh, MeshGeometry, Shader, Texture, UniformGroup } from "pixi.js";

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

// Colorway palette as a 1×8 RGBA texture. Sampling at (region+0.5)/8
// hits the centre of each texel. We use a texture rather than a
// uniform array because Pixi v8's UBO-backed uniform arrays don't
// always upload reliably (we hit cases where the cards rendered
// invisibly with no error). Sampling is rock solid.
uniform sampler2D uPaletteMap;

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
  // round(r * 7) recovers the region as a float in [0, 7]. Sample
  // uPaletteMap at (region + 0.5) / 8 to hit the centre of the
  // texel for that region.
  float regionR = texture(uRegionMap, tileUV).r;
  float regionF = clamp(floor(regionR * 7.0 + 0.5), 0.0, 7.0);
  vec3 color = texture(uPaletteMap, vec2((regionF + 0.5) / 8.0, 0.5)).rgb;

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

  // Wear: scratch-map driven. The "stock" colour the pattern wears
  // toward is the colorway's palette[0], which by convention is the
  // card background — the dark substrate the pattern was painted on.
  // Slightly darkened so chips read as recessed material rather than
  // matching the BG exactly (which would make scratches invisible on
  // patterns whose background is also palette[0]).
  if (uWear > 0.001) {
    vec3 stock = uPalette[0].rgb * 0.55;
    float wearThreshold = texture(uScratchMap, vUV).r;
    float scratchAmount = smoothstep(wearThreshold - 0.06, wearThreshold + 0.02, uWear);
    finalRGB = mix(finalRGB, stock, scratchAmount * 0.8);
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
  });

  // Colorway palette as a 1×8 RGBA texture. Owned by the controller so
  // setColorway can rebuild it without affecting other meshes.
  let paletteTex = createPaletteTexture(defaultPalette());

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
      uPaletteMap: paletteTex.source,
      uPaletteSampler: paletteTex.source.style,
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
      paletteTex = createPaletteTexture(palette);
      shader.resources.uPaletteMap = paletteTex.source;
      shader.resources.uPaletteSampler = paletteTex.source.style;
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

function createPaletteTexture(palette: readonly number[]): Texture {
  // jsdom (used by vitest) doesn't ship a real canvas, so we fall back
  // to Texture.EMPTY when ImageData isn't available. Tests don't render,
  // they just construct the mesh, so a stand-in is fine.
  const canvas = document.createElement("canvas");
  canvas.width = 8;
  canvas.height = 1;
  const ctx = canvas.getContext("2d");
  if (!ctx || typeof ctx.createImageData !== "function") return Texture.EMPTY;
  const img = ctx.createImageData(8, 1);
  for (let i = 0; i < 8; i++) {
    const c = palette[i] ?? 0xffffff;
    img.data[i * 4] = (c >> 16) & 0xff;
    img.data[i * 4 + 1] = (c >> 8) & 0xff;
    img.data[i * 4 + 2] = c & 0xff;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const tex = Texture.from(canvas);
  // Nearest sampling so the discrete region IDs land cleanly on the
  // intended palette colour rather than blending across neighbours.
  tex.source.scaleMode = "nearest";
  return tex;
}

function defaultPalette(): readonly number[] {
  // Magenta everywhere. A missing setColorway call is impossible to miss
  // in dev — every card paints loud pink instead of going silently
  // invisible like an array-uniform upload failure does.
  return [0xff00ff, 0xff00ff, 0xff00ff, 0xff00ff, 0xff00ff, 0xff00ff, 0xff00ff, 0xff00ff];
}

export type { Texture };
