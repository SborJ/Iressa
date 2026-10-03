import { COMMON_CHUNK, GBUFFER_OUT, LIGHTING_CHUNK } from './tissue.js';

/**
 * Cells and nuclei, drawn as packed overlapping bodies rather than separate
 * spheres.
 *
 * The same program draws both: a nucleus is the same instance at roughly half
 * the diameter, offset off centre, with its own wobble seed. Instance
 * attributes are shared between the two draws, so a cell and its nucleus can
 * never disagree about where the cell is.
 *
 * Preset parameters arrive per instance (see render/visuals.ts):
 *   aP0 = (durationTicks, scaleTarget,    scaleCurve,  alphaTarget)
 *   aP1 = (swell,         bleb,           blebFreq,    blebDrift)
 *   aP2 = (fragments,     fragmentSpread, nuclei,      nucleiBulge)
 *   aP3 = (tintAmount,    tintCurve,      desaturate,  emissive)
 *   aP4 = (flashTicks,    alphaCurve,     animStart,   seed)
 *   aP5 = (grain,         nucleusScale,   nucleusFade, 0)
 *   aShape = (sizeVariation, wobbleAmp, wobbleFreq, 0)
 */

export const CELL_VERTEX = /* glsl */ `
in vec3 aPos;
in vec3 aBase;
in vec3 aTint;
in vec3 aPick;
in vec4 aP0;
in vec4 aP1;
in vec4 aP2;
in vec4 aP3;
in vec4 aP4;
in vec4 aP5;
in vec4 aShape;

uniform float uTick;
uniform float uRadius;
uniform float uRestingScale;
uniform float uIsNucleus;
uniform float uNucleusOffset;

out vec3  vViewNormal;
out vec3  vWorld;
out vec3  vBase;
out vec3  vTint;
out vec3  vPick;
out float vTintBlend;
out float vDesaturate;
out float vAlpha;
out float vEmissive;
out float vGrain;
out float vSeed;
out float vViewDepth;
out float vCut;
out float vOnCutFace;

${COMMON_CHUNK}

float curveAt(float t, float id) {
  if (id < 0.5) return t;
  if (id < 1.5) return t * t;
  if (id < 2.5) return 1.0 - (1.0 - t) * (1.0 - t);
  if (id < 3.5) return t * t * (3.0 - 2.0 * t);
  if (id < 4.5) return sin(t * PI);
  return step(0.5, t);
}

/** k lobes, each pushed along its own direction, so a cell comes apart cleanly. */
vec3 lobeDirection(vec3 n, float k, float seed) {
  if (k < 1.5) return n;
  float ang = atan(n.z, n.x);
  float w = floor((ang / TAU + 0.5) * k + seed * k);
  float h1 = hash31(vec3(w, seed * 37.0, 1.0));
  float h2 = hash31(vec3(w, seed * 37.0, 2.0));
  float theta = (w + 0.5) / k * TAU + (h1 - 0.5) * 0.7;
  return normalize(vec3(cos(theta), (h2 - 0.5) * 1.6, sin(theta)));
}

float nucleiField(vec3 n, float k, float seed) {
  if (k < 0.5) return 0.0;
  return (0.5 + 0.5 * cos(k * atan(n.z, n.x) + seed * TAU)) * (1.0 - 0.45 * abs(n.y));
}

void main() {
  float duration  = aP0.x;
  float animStart = aP4.z;
  float seed      = aP4.w;
  float phase = duration <= 0.0 ? 1.0 : clamp((uTick - animStart) / duration, 0.0, 1.0);

  float scale = mix(1.0, aP0.y, curveAt(phase, aP0.z));
  scale += aP1.x * sin(phase * PI);
  scale *= uRestingScale * aShape.x;

  /* Organic wobble: no two cells are the same shape, and none is a sphere. */
  float wobble = aShape.y * (fbm(normal * aShape.z + seed * 31.0) - 0.5) * 2.0;

  float bulge = aP2.w * nucleiField(normal, aP2.z, seed) * curveAt(phase, aP0.z);

  float bleb = 0.0;
  if (aP1.y > 0.0) {
    float n = valueNoise(normal * aP1.z + vec3(seed * 53.0, phase * aP1.w * 4.0, seed * 17.0));
    bleb = aP1.y * (n - 0.5) * 2.0 * phase;
  }

  vec3 away = vec3(0.0);
  if (aP2.x > 0.5 && aP2.y > 0.0) {
    away = lobeDirection(normal, aP2.x, seed) * aP2.y * curveAt(phase, 1.0);
  }

  vec3 centre = aPos;
  float radius = uRadius;
  if (uIsNucleus > 0.5) {
    /* A tumour nucleus is large relative to its cell and sits off centre. */
    radius *= aP5.y;
    wobble *= 1.6;
    vec3 off = normalize(vec3(
      hash11(seed * 13.0) - 0.5,
      hash11(seed * 29.0) - 0.5,
      hash11(seed * 41.0) - 0.5) + 1e-4);
    centre += off * uNucleusOffset * uRadius * scale;
    away = vec3(0.0);
    bleb *= 0.4;
  }

  vec3 local = normal * (scale * (1.0 + wobble) + bulge + bleb) + away;
  vec3 world = centre + local * radius;

  /* Anything past the cut is flattened onto it, so the cell shows a flat cut
     face the way a cell in a section does. */
  float onFace;
  vec3 faceNormal;
  world = clampToCut(world, onFace, faceNormal);
  vOnCutFace = onFace;

  vTintBlend  = aP3.x * curveAt(phase, aP3.y);
  vDesaturate = aP3.z * phase;
  vAlpha      = mix(1.0, aP0.w, curveAt(phase, aP4.y));
  if (uIsNucleus > 0.5) vAlpha *= 1.0 - aP5.z * phase;
  vEmissive = aP4.x <= 0.0
    ? aP3.w
    : aP3.w * max(0.0, 1.0 - (uTick - animStart) / aP4.x);
  vGrain = aP5.x * phase;

  vec3 shapedNormal = normalize(mix(normal, normalize(normal + away * 2.0), 0.5));
  if (onFace > 0.5) shapedNormal = faceNormal;
  vec4 viewPos = viewMatrix * vec4(world, 1.0);
  vViewNormal = normalize((viewMatrix * vec4(shapedNormal, 0.0)).xyz);
  vWorld = world;
  vBase = aBase;
  vTint = aTint;
  vPick = aPick;
  vSeed = seed;
  vViewDepth = -viewPos.z;
  // The geometry is clamped rather than removed, so nothing needs discarding.
  vCut = -1.0;

  gl_Position = projectionMatrix * viewPos;
}
`;

export const CELL_FRAGMENT = /* glsl */ `
precision highp float;

in vec3  vViewNormal;
in vec3  vWorld;
in vec3  vBase;
in vec3  vTint;
in vec3  vPick;
in float vTintBlend;
in float vDesaturate;
in float vAlpha;
in float vEmissive;
in float vGrain;
in float vSeed;
in float vViewDepth;
in float vCut;
in float vOnCutFace;

uniform float uIsNucleus;
uniform float uRoughness;
uniform float uClearcoat;
uniform float uSheen;
uniform float uThickness;
uniform vec3  uSubsurface;
uniform vec3  uNucleusColor;
uniform float uNucleusBlend;
uniform float uFade;
uniform float uGrainScale;

${COMMON_CHUNK}
${LIGHTING_CHUNK}
${GBUFFER_OUT}

/* Order-independent stand-in for blending: no sorting, depth stays correct. */
float ign(vec2 p) {
  return fract(52.9829189 * fract(0.06711056 * p.x + 0.00583715 * p.y));
}

void main() {
  if (vCut > 0.0) discard;

  float alpha = vAlpha * uFade;
  if (alpha < 0.999) {
    if (ign(gl_FragCoord.xy + vec2(vSeed * 64.0, vSeed * 37.0)) > alpha) discard;
  }

  vec3 albedo = mix(vBase, vTint, clamp(vTintBlend, 0.0, 1.0));
  /* The nuclear stain is its own channel: in fluorescence it is the stain's
     colour outright, in a stained section it picks up some of the cytoplasm. */
  if (uIsNucleus > 0.5) albedo = mix(uNucleusColor, albedo * uNucleusColor * 2.0, uNucleusBlend);

  float grey = dot(albedo, vec3(0.2126, 0.7152, 0.0722));
  albedo = mix(albedo, vec3(grey), clamp(vDesaturate, 0.0, 1.0));

  /* Grain: necrotic tissue is coarse and granular, not smoothly coloured. */
  if (vGrain > 0.0) {
    float g = fbm(vWorld * uGrainScale + vSeed * 19.0);
    albedo *= 1.0 + vGrain * (g - 0.5) * 1.6;
  }

  vec3 n = normalize(vViewNormal);
  vec3 v = vec3(0.0, 0.0, 1.0);

  /* The flat face the cut left behind is exposed cytoplasm: flatter, a little
     lighter, and without the surface sheen of an intact membrane. */
  bool sliced = vOnCutFace > 0.5;
  if (!gl_FrontFacing) n = -n;
  if (sliced) albedo *= 1.06;

  vec3 lit;
  if (uViewMode == 1) {
    lit = shadeFluorescent(albedo, 1.0 + vEmissive, n, v);
  } else {
    TissueSurface s;
    s.albedo = albedo;
    s.subsurfaceColor = uSubsurface * albedo;
    s.roughness = sliced ? min(1.0, uRoughness + 0.2) : uRoughness;
    s.clearcoat = sliced ? 0.0 : (uIsNucleus > 0.5 ? uClearcoat * 0.3 : uClearcoat);
    s.sheen = sliced ? uSheen * 0.3 : uSheen;
    s.thickness = uIsNucleus > 0.5 ? uThickness * 0.3 : uThickness;
    s.emissive = vEmissive;
    lit = shadeTissue(s, n, v);
  }

  writeGBuffer(lit, n, vViewDepth, vPick, uIsNucleus > 0.5 ? ${'0.5'} : ${'0.25'});
}
`;

/**
 * Picking.
 *
 * The identity already rides along in the G-buffer, but a multiple-render-target
 * attachment cannot be read back - WebGL only ever hands back attachment zero -
 * so a pick is its own one-pixel render with a single-output material. The
 * vertex stage is shared, so the shape picked is exactly the shape drawn,
 * including the cut, the wobble and any fragmenting.
 */
export const PICK_FRAGMENT = /* glsl */ `
precision highp float;

in vec3  vPick;
in float vAlpha;
in float vSeed;
in float vCut;
in float vOnCutFace;

uniform float uFade;

layout(location = 0) out vec4 outId;

float ign(vec2 p) {
  return fract(52.9829189 * fract(0.06711056 * p.x + 0.00583715 * p.y));
}

void main() {
  if (vCut > 0.0) discard;
  float alpha = vAlpha * uFade;
  // A cell you cannot see is a cell you cannot hover.
  if (alpha < 0.999 && ign(gl_FragCoord.xy + vec2(vSeed * 64.0, vSeed * 37.0)) > alpha) discard;
  outId = vec4(vPick, 1.0);
}
`;
