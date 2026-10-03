/**
 * One shader for every cause.
 *
 * It implements six generic effects - scale curve, colour curve, blebbing,
 * fragmenting, transparency, emissive - and each preset is a set of numbers
 * that combines them. A new cause needs a new preset in visuals.json and a new
 * entry in rules.json; it never needs a line of this file.
 *
 * Preset parameters arrive as per-instance attributes:
 *   aP0 = (durationTicks, scaleTarget,   scaleCurve,  alphaTarget)
 *   aP1 = (swell,         bleb,          blebFreq,    blebDrift)
 *   aP2 = (fragments,     fragmentSpread, nuclei,     nucleiBulge)
 *   aP3 = (tintAmount,    tintCurve,     desaturate,  emissive)
 *   aP4 = (flashTicks,    alphaCurve,    animStart,   seed)
 */

export const CELL_VERTEX_SHADER = /* glsl */ `
#define PI  3.14159265359
#define TAU 6.28318530718

attribute vec3 aPos;
attribute vec3 aBase;
attribute vec3 aTint;
attribute vec3 aPick;
attribute vec4 aP0;
attribute vec4 aP1;
attribute vec4 aP2;
attribute vec4 aP3;
attribute vec4 aP4;

uniform float uTick;
uniform float uRadius;

varying vec3 vNormal;
varying vec3 vBase;
varying vec3 vTint;
varying vec3 vWorld;
varying float vTintBlend;
varying float vDesaturate;
varying float vAlpha;
varying float vEmissive;
varying float vSeed;
varying vec3 vPick;

float curveAt(float t, float id) {
  if (id < 0.5) return t;                                  // linear
  if (id < 1.5) return t * t;                              // easeIn
  if (id < 2.5) return 1.0 - (1.0 - t) * (1.0 - t);        // easeOut
  if (id < 3.5) return t * t * (3.0 - 2.0 * t);            // easeInOut
  if (id < 4.5) return sin(t * PI);                        // pulse
  return step(0.5, t);                                     // step
}

float hash31(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.11, 0.17, 0.23));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}

float valueNoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  float n000 = hash31(i + vec3(0.0, 0.0, 0.0));
  float n100 = hash31(i + vec3(1.0, 0.0, 0.0));
  float n010 = hash31(i + vec3(0.0, 1.0, 0.0));
  float n110 = hash31(i + vec3(1.0, 1.0, 0.0));
  float n001 = hash31(i + vec3(0.0, 0.0, 1.0));
  float n101 = hash31(i + vec3(1.0, 0.0, 1.0));
  float n011 = hash31(i + vec3(0.0, 1.0, 1.0));
  float n111 = hash31(i + vec3(1.0, 1.0, 1.0));
  return mix(
    mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
    mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y),
    f.z
  );
}

/**
 * Splits the surface into k lobes and gives every vertex in a lobe the same
 * outward direction, so the lobes come apart cleanly. The split is irregular,
 * seeded per cell, so no two cells fragment the same way.
 */
vec3 lobeDirection(vec3 n, float k, float seed) {
  if (k < 1.5) return n;
  float ang = atan(n.z, n.x);
  float w = floor((ang / TAU + 0.5) * k + seed * k);
  float h1 = hash31(vec3(w, seed * 37.0, 1.0));
  float h2 = hash31(vec3(w, seed * 37.0, 2.0));
  float theta = (w + 0.5) / k * TAU + (h1 - 0.5) * 0.7;
  float lat = (h2 - 0.5) * 1.6;
  return normalize(vec3(cos(theta), lat, sin(theta)));
}

/** Smooth internal lobes, for the multinucleated look. No tearing. */
float nucleiField(vec3 n, float k, float seed) {
  if (k < 0.5) return 0.0;
  float ang = atan(n.z, n.x);
  float lobes = 0.5 + 0.5 * cos(k * ang + seed * TAU);
  return lobes * (1.0 - 0.45 * abs(n.y));
}

void main() {
  float duration  = aP0.x;
  float animStart = aP4.z;
  float seed      = aP4.w;
  float phase = duration <= 0.0 ? 1.0 : clamp((uTick - animStart) / duration, 0.0, 1.0);

  /* --- scale curve --- */
  float scale = mix(1.0, aP0.y, curveAt(phase, aP0.z));
  scale += aP1.x * sin(phase * PI);          // swell: an overshoot that releases

  /* --- nuclei: smooth bulges --- */
  float bulge = aP2.w * nucleiField(normal, aP2.z, seed) * curveAt(phase, aP0.z);

  /* --- blebbing: surface displacement --- */
  float bleb = 0.0;
  if (aP1.y > 0.0) {
    float n = valueNoise(normal * aP1.z + vec3(seed * 53.0, phase * aP1.w * 4.0, seed * 17.0));
    bleb = aP1.y * (n - 0.5) * 2.0 * phase;
  }

  /* --- fragmenting: lobes separate --- */
  vec3 away = vec3(0.0);
  if (aP2.x > 0.5 && aP2.y > 0.0) {
    away = lobeDirection(normal, aP2.x, seed) * aP2.y * curveAt(phase, 1.0);
  }

  vec3 local = normal * (scale + bulge + bleb) + away;
  vec3 world = aPos + local * uRadius;

  /* --- colour curve, transparency, emissive --- */
  vTintBlend  = aP3.x * curveAt(phase, aP3.y);
  vDesaturate = aP3.z * phase;
  vAlpha      = mix(1.0, aP0.w, curveAt(phase, aP4.y));
  float flash = aP4.x <= 0.0
    ? aP3.w
    : aP3.w * max(0.0, 1.0 - (uTick - animStart) / aP4.x);
  vEmissive = flash;

  vNormal = normalize(mix(normal, normalize(normal + away * 2.0), 0.5));
  vBase = aBase;
  vTint = aTint;
  vWorld = world;
  vSeed = seed;
  vPick = aPick;

  vec4 viewPos = viewMatrix * vec4(world, 1.0);
  gl_Position = projectionMatrix * viewPos;
}
`;

export const CELL_FRAGMENT_SHADER = /* glsl */ `
uniform vec3  uBackground;
uniform float uFogDensity;
uniform float uAmbient;
uniform float uKeyLight;
uniform float uRimLight;
uniform vec3  uKeyDirection;
uniform vec3  uCameraPos;
uniform vec3  uClipNormal;
uniform float uClipOffset;
uniform float uClipOn;
uniform float uPicking;

varying vec3 vNormal;
varying vec3 vBase;
varying vec3 vTint;
varying vec3 vWorld;
varying float vTintBlend;
varying float vDesaturate;
varying float vAlpha;
varying float vEmissive;
varying float vSeed;
varying vec3 vPick;

/* Interleaved gradient noise: an order-independent stand-in for blending, so
   translucent cells need no sorting and still read correctly through a crowd. */
float ign(vec2 p) {
  return fract(52.9829189 * fract(0.06711056 * p.x + 0.00583715 * p.y));
}

void main() {
  if (uClipOn > 0.5 && dot(vWorld, uClipNormal) > uClipOffset) discard;

  if (vAlpha < 0.999) {
    float threshold = ign(gl_FragCoord.xy + vec2(vSeed * 64.0, vSeed * 37.0));
    if (threshold > vAlpha) discard;
  }

  if (uPicking > 0.5) {
    gl_FragColor = vec4(vPick, 1.0);
    return;
  }

  vec3 albedo = mix(vBase, vTint, clamp(vTintBlend, 0.0, 1.0));
  float grey = dot(albedo, vec3(0.2126, 0.7152, 0.0722));
  albedo = mix(albedo, vec3(grey), clamp(vDesaturate, 0.0, 1.0));

  vec3 n = normalize(vNormal);
  vec3 view = normalize(uCameraPos - vWorld);
  float key = max(0.0, dot(n, normalize(uKeyDirection)));
  float rim = pow(1.0 - max(0.0, dot(n, view)), 2.5);

  vec3 lit = albedo * (uAmbient + uKeyLight * key) + albedo * uRimLight * rim;
  lit += albedo * vEmissive;

  float dist = length(uCameraPos - vWorld);
  float fog = 1.0 - exp(-uFogDensity * uFogDensity * dist * dist);
  lit = mix(lit, uBackground, clamp(fog, 0.0, 1.0));

  gl_FragColor = vec4(lit, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;
