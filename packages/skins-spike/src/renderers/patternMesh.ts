import { GlProgram, Mesh, MeshGeometry, Shader, type Texture, UniformGroup } from "pixi.js";

export interface PatternBundle {
  color: Texture;
  height: Texture;
  gloss: Texture;
}

// Pattern Mesh: a quad covering the card area with a custom shader that
// samples the bundle's color/height/gloss textures and lights them
// per-pixel. The vertex shader projects local positions through the parent
// transform chain, so tile-UV math runs in mesh-local space and the
// pattern shears with the card during tilt.
//
// No time-based animation: lighting is fully static at rest. The only
// "motion" comes from the card's tilt itself — rotating the card rotates
// the surface normal, which changes how light catches the bumps and
// fires the Fresnel rim. That's the natural way real cards feel alive,
// and removing the always-on shimmer/pulse/drift tracks lets the tilt
// response read clearly.

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

uniform sampler2D uColorMap;
uniform sampler2D uHeightMap;
uniform sampler2D uGlossMap;

uniform vec2 uTileScale;
uniform vec2 uTileOffset;
uniform float uOverlayAlpha;
uniform float uBumpScale;
uniform float uTexelSize;
uniform vec2 uCardSize;
uniform float uCornerRadius;
// (skewX, skewY) of the card. Rotates the surface normal so different
// parts of the height map catch the static light when the card is
// tilted, and drives the Fresnel rim glow.
uniform vec2 uViewTilt;
// 0 = factory-new, 1 = battle-scarred. Desaturates and adds scratch
// noise. Same control on both pattern and foil so the whole surface
// ages together.
uniform float uWear;

float hashWear(vec2 p) {
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
  float maskA = clamp(0.5 - sdf, 0.0, 1.0);

  vec2 tileUV = fract(vUV * uTileScale + uTileOffset);
  vec3 color = texture(uColorMap, tileUV).rgb;
  float gloss = texture(uGlossMap, tileUV).r;

  float hL = texture(uHeightMap, fract(tileUV - vec2(uTexelSize, 0.0))).r;
  float hR = texture(uHeightMap, fract(tileUV + vec2(uTexelSize, 0.0))).r;
  float hT = texture(uHeightMap, fract(tileUV - vec2(0.0, uTexelSize))).r;
  float hB = texture(uHeightMap, fract(tileUV + vec2(0.0, uTexelSize))).r;
  vec3 baseNormal = normalize(vec3(
    -(hR - hL) * uBumpScale,
    -(hB - hT) * uBumpScale,
    1.0
  ));

  // Tilt-rotated normal. Highlights slide across the pattern's bumps
  // as the user turns the card.
  vec3 tiltVec = vec3(uViewTilt.y, -uViewTilt.x, 0.0) * 2.5;
  vec3 normal = normalize(baseNormal + tiltVec);

  // Fixed top-left light direction. All "motion" comes from the
  // tilt-rotated normal interacting with this static light.
  vec3 lightDir = normalize(vec3(-0.5, -0.5, 0.7));

  float lambert = max(0.0, dot(normal, lightDir));
  float ambient = 0.4;
  float lit = ambient + (1.0 - ambient) * lambert;

  vec3 viewDir = vec3(0.0, 0.0, 1.0);
  vec3 halfway = normalize(lightDir + viewDir);
  float specPower = mix(8.0, 48.0, gloss);
  float spec = pow(max(0.0, dot(normal, halfway)), specPower);
  vec3 highlight = vec3(spec * gloss);

  // Fresnel rim: surfaces glance brighter at grazing angles. The
  // tilt-rotated normal makes high-elevation pixels glow when the card
  // is held off-axis — the single biggest 3D-feel cue.
  float fresnel = pow(1.0 - max(0.0, dot(normal, viewDir)), 3.0);
  highlight += vec3(fresnel) * (0.35 + 0.65 * gloss);

  vec3 finalRGB = color * lit + highlight;

  // Wear: multi-layer card aging. Real cards don't degrade uniformly —
  // corners go first as white card stock shows through, scratches run
  // in directional lines, dirt collects in low-relief valleys, and
  // colours fade overall.
  if (uWear > 0.001) {
    vec3 stock = vec3(0.94, 0.91, 0.86); // cream card-stock material

    // Edge proximity. Distance to nearest edge identifies near-edge
    // pixels; max() of x/y edge distances identifies CORNER pixels
    // (both close to an edge), where wear is worst.
    vec2 toEdge = min(px, uCardSize - px);
    float edgeDist = min(toEdge.x, toEdge.y);
    float edgeProx = pow(1.0 - smoothstep(0.0, 14.0, edgeDist), 1.8);
    float cornerProx = pow(1.0 - smoothstep(0.0, 11.0, max(toEdge.x, toEdge.y)), 2.0);
    float edgeWear = clamp(edgeProx + cornerProx * 0.6, 0.0, 1.0);

    // Edge whitening: coloured ink rubs to card stock near edges.
    finalRGB = mix(finalRGB, stock, edgeWear * uWear * 0.85);

    // Directional scratches. Hash cells stretched along a +15° axis
    // give long thin scratch lines (1.5px wide × 26px long). A second
    // pass at -25° cross-hatches at high wear. The threshold formula
    // 0.99 - wear*K means at wear=0 essentially no cells qualify, so
    // scratches actually onset cleanly above zero rather than always
    // peeking through.
    mat2 rotA = mat2(0.97, 0.26, -0.26, 0.97);
    mat2 rotB = mat2(0.91, -0.42, 0.42, 0.91);
    vec2 sa = rotA * px;
    float ha = hashWear(floor(vec2(sa.x / 1.5, sa.y / 26.0)));
    float scrA = step(0.99 - uWear * 0.15, ha);
    vec2 sb = rotB * px;
    float hb = hashWear(floor(vec2(sb.x / 1.5, sb.y / 32.0)));
    float scrB = step(0.99 - uWear * 0.10, hb);
    float scratch = max(scrA, scrB);

    // Scratches expose card stock — slightly brighter than the colour
    // because the scratched area is bare material catching the light.
    finalRGB = mix(finalRGB, stock * 1.05, scratch * uWear * 0.55);

    // Dirt accumulation in low-relief areas: valleys (1 - height)
    // darken as grime collects.
    finalRGB *= 1.0 - (1.0 - height) * uWear * 0.25;

    // Global colour fade.
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

export type { Texture };
