import { GlProgram, Mesh, MeshGeometry, Shader, type Texture, UniformGroup } from "pixi.js";

export interface PatternBundle {
  color: Texture;
  height: Texture;
  gloss: Texture;
}

// Pattern Mesh: replaces the filter-based pattern renderer.
//
// Why a Mesh? Filters in Pixi v8 render the filtered displayobject into a
// screen-space AABB framebuffer. When the parent is skewed/rotated (the
// drag tilt), the filter's vTextureCoord covers that AABB rather than the
// displayobject's local coords — which means tile-UV math runs in
// screen-aligned space and the pattern stays axis-aligned while the card
// silhouette shears. Looks broken.
//
// A Mesh with a custom shader avoids the framebuffer indirection: the
// vertex shader projects local positions through the world transform
// directly, and the fragment shader interpolates per-vertex aUV in
// mesh-local space. Tile-UV math runs in card-local space → pattern
// shears with the card the way a real printed pattern would.

const vertex = `
in vec2 aPosition;
in vec2 aUV;
out vec2 vUV;

// Pixi v8 mesh pipeline binds these by name on each draw — group 100 is
// global uniforms (projection / world), group 101 is the per-mesh local
// transform.
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
uniform vec2 uCardSize;
uniform float uCornerRadius;

// Signed distance from a pixel to a rounded rectangle: negative inside,
// positive outside. Drives the silhouette mask in mesh-local space.
float roundedRectSdf(vec2 px, vec2 size, float r) {
  vec2 q = abs(px - size * 0.5) - (size * 0.5 - r);
  return length(max(q, vec2(0.0))) + min(max(q.x, q.y), 0.0) - r;
}

void main() {
  // Discard outside the rounded card silhouette. vUV is mesh-local in
  // [0,1]^2, so this works correctly under any parent transform.
  vec2 px = vUV * uCardSize;
  float sdf = roundedRectSdf(px, uCardSize, uCornerRadius);
  if (sdf > 0.5) discard;
  float maskA = clamp(0.5 - sdf, 0.0, 1.0);

  // Tile UV: how many tile-repeats fit across the card.
  vec2 tileUV = fract(vUV * uTileScale + uTileOffset);

  vec3 color = texture(uColorMap, tileUV).rgb;
  float gloss = texture(uGlossMap, tileUV).r;

  // Height gradient via central difference, fract() wraps at the seam.
  float hL = texture(uHeightMap, fract(tileUV - vec2(uTexelSize, 0.0))).r;
  float hR = texture(uHeightMap, fract(tileUV + vec2(uTexelSize, 0.0))).r;
  float hT = texture(uHeightMap, fract(tileUV - vec2(0.0, uTexelSize))).r;
  float hB = texture(uHeightMap, fract(tileUV + vec2(0.0, uTexelSize))).r;
  vec3 normal = normalize(vec3(
    -(hR - hL) * uBumpScale,
    -(hB - hT) * uBumpScale,
    1.0
  ));

  // Light direction by motion mode (subtle so it composes with foil).
  vec3 lightDir;
  float pulseMod = 1.0;
  if (uMotion < 0.5) {
    lightDir = normalize(vec3(-0.5, -0.5, 0.7));
  } else if (uMotion < 1.5) {
    lightDir = normalize(vec3(-0.4 + sin(uTime * 1.5) * 0.3, -0.5, 0.7));
  } else if (uMotion < 2.5) {
    lightDir = normalize(vec3(-0.5, -0.5, 0.7));
    pulseMod = 0.78 + 0.22 * (0.5 + 0.5 * sin(uTime * 2.0));
  } else {
    float a = uTime * 0.35;
    lightDir = normalize(vec3(-0.45 + cos(a) * 0.2, -0.45 + sin(a) * 0.18, 0.7));
  }

  float lambert = max(0.0, dot(normal, lightDir));
  float ambient = 0.4;
  float lit = (ambient + (1.0 - ambient) * lambert) * pulseMod;

  vec3 viewDir = vec3(0.0, 0.0, 1.0);
  vec3 halfway = normalize(lightDir + viewDir);
  float specPower = mix(8.0, 48.0, gloss);
  float spec = pow(max(0.0, dot(normal, halfway)), specPower);
  vec3 highlight = vec3(spec * gloss);

  vec3 finalRGB = color * lit + highlight;
  finalColor = vec4(finalRGB, uOverlayAlpha * maskA);
}
`;

interface PatternMeshUniforms {
  uTime: number;
  uMotion: number;
  uTileScale: Float32Array;
  uTileOffset: Float32Array;
  uOverlayAlpha: number;
  uBumpScale: number;
  uTexelSize: number;
  uCardSize: Float32Array;
  uCornerRadius: number;
}

export interface PatternMeshController {
  view: Mesh<MeshGeometry, Shader>;
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

export function createPatternMesh(
  bundle: PatternBundle,
  cardWidth: number,
  cardHeight: number,
): PatternMeshController {
  // Quad covering the card area. Two triangles, four corners.
  const positions = new Float32Array([0, 0, cardWidth, 0, cardWidth, cardHeight, 0, cardHeight]);
  const uvs = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]);
  const indices = new Uint32Array([0, 1, 2, 0, 2, 3]);

  const geometry = new MeshGeometry({
    positions,
    uvs,
    indices,
  });

  const glProgram = GlProgram.from({ vertex, fragment, name: "pattern-mesh" });

  const uniforms = new UniformGroup({
    uTime: { value: 0, type: "f32" },
    uMotion: { value: 0, type: "f32" },
    uTileScale: { value: new Float32Array([1, 1]), type: "vec2<f32>" },
    uTileOffset: { value: new Float32Array([0, 0]), type: "vec2<f32>" },
    uOverlayAlpha: { value: 0.55, type: "f32" },
    uBumpScale: { value: 2.0, type: "f32" },
    uTexelSize: { value: 1 / 48, type: "f32" },
    uCardSize: { value: new Float32Array([cardWidth, cardHeight]), type: "vec2<f32>" },
    uCornerRadius: { value: 4, type: "f32" },
  });

  const shader = new Shader({
    glProgram,
    resources: {
      patternUniforms: uniforms,
      uColorMap: bundle.color.source,
      uColorSampler: bundle.color.source.style,
      uHeightMap: bundle.height.source,
      uHeightSampler: bundle.height.source.style,
      uGlossMap: bundle.gloss.source,
      uGlossSampler: bundle.gloss.source.style,
    },
  });

  const mesh = new Mesh<MeshGeometry, Shader>({ geometry, shader });
  const u = uniforms.uniforms as PatternMeshUniforms;

  return {
    view: mesh,
    setBundle(next) {
      shader.resources.uColorMap = next.color.source;
      shader.resources.uColorSampler = next.color.source.style;
      shader.resources.uHeightMap = next.height.source;
      shader.resources.uHeightSampler = next.height.source.style;
      shader.resources.uGlossMap = next.gloss.source;
      shader.resources.uGlossSampler = next.gloss.source.style;
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

// Re-export Texture for downstream packages without a direct pixi import.
export type { Texture };
