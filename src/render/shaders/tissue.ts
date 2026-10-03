/**
 * Shared GLSL for every surface in the scene.
 *
 * Everything is drawn into one G-buffer so that a single later pass can do
 * ambient occlusion, cell membranes and depth cues over the whole image at
 * once:
 *
 *   location 0  lit colour
 *   location 1  view normal (xyz) and view depth (w)
 *   location 2  identity: node id in rgb, surface kind in a
 *
 * Lighting is a wrap-diffuse subsurface approximation rather than real
 * transmission. Transmission in three.js needs its own render pass and cannot
 * write a G-buffer, and at a few thousand overlapping cells it costs far more
 * than it returns; wrap lighting plus back-scatter and a sheen rim gives the
 * same soft, slightly translucent read for one dot product.
 */

export const VIEW_TISSUE = 0;
export const VIEW_FLUORESCENCE = 1;
export const VIEW_HISTOLOGY = 2;

/** `a` of the identity target, so the composite pass knows what it is looking at. */
export const KIND_EMPTY = 0.0;
export const KIND_CELL = 0.25;
export const KIND_NUCLEUS = 0.5;
export const KIND_SURFACE = 0.75;
export const KIND_VESSEL = 1.0;

/** Noise, hashing and the cut test. Shared by vertex and fragment stages. */
export const COMMON_CHUNK = /* glsl */ `
#define PI  3.14159265359
#define TAU 6.28318530718

float hash11(float p) {
  p = fract(p * 0.1031);
  p *= p + 33.33;
  return fract(p * (p + p));
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
  return mix(
    mix(mix(hash31(i), hash31(i + vec3(1,0,0)), f.x),
        mix(hash31(i + vec3(0,1,0)), hash31(i + vec3(1,1,0)), f.x), f.y),
    mix(mix(hash31(i + vec3(0,0,1)), hash31(i + vec3(1,0,1)), f.x),
        mix(hash31(i + vec3(0,1,1)), hash31(i + vec3(1,1,1)), f.x), f.y),
    f.z);
}

float fbm(vec3 p) {
  return 0.5 * valueNoise(p) + 0.25 * valueNoise(p * 2.03) + 0.125 * valueNoise(p * 4.07);
}

/**
 * Voronoi distance to the second-nearest cell centre: the classic mosaic.
 * Used on the far-away isosurface so it still reads as cellular when no
 * individual cells are being drawn. Labelled illustrative in the legend.
 */
float voronoiEdge(vec3 p) {
  vec3 base = floor(p);
  float d1 = 8.0;
  float d2 = 8.0;
  for (int k = -1; k <= 1; k++) {
    for (int j = -1; j <= 1; j++) {
      for (int i = -1; i <= 1; i++) {
        vec3 cellId = base + vec3(float(i), float(j), float(k));
        vec3 offset = vec3(
          hash31(cellId), hash31(cellId + 11.3), hash31(cellId + 27.7));
        float d = length(cellId + offset - p);
        if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) { d2 = d; }
      }
    }
  }
  return d2 - d1;
}

/* ---- the cut ------------------------------------------------------------ *
 * uCutMode 0 none, 1 one plane, 2 an octant removed.
 * uCutPoint is the corner or the point on the plane, in world space.
 * ------------------------------------------------------------------------- */
uniform int   uCutMode;
uniform vec3  uCutPoint;
uniform vec3  uCutNormal;

/**
 * Flattens whatever lies past the cut onto the cut itself, instead of removing
 * it. A sphere crossing the plane becomes a sphere with a flat face, which is
 * what a cell looks like in a section; discarding the fragments instead leaves
 * a hollow bowl with the far wall showing through.
 *
 * The face normal comes back as the normal of the face that did the cutting, so
 * the flattened part shades as a flat surface rather than as the sphere it came
 * from.
 */
vec3 clampToCut(vec3 world, out float onFace, out vec3 faceNormal) {
  onFace = 0.0;
  faceNormal = vec3(0.0, 0.0, 1.0);
  if (uCutMode == 0) return world;

  if (uCutMode == 1) {
    float d = dot(world - uCutPoint, uCutNormal);
    if (d <= 0.0) return world;
    onFace = 1.0;
    faceNormal = uCutNormal;
    return world - uCutNormal * d;
  }

  vec3 d = world - uCutPoint;
  if (d.x <= 0.0 || d.y <= 0.0 || d.z <= 0.0) return world;
  onFace = 1.0;
  // Push back through the nearest of the three faces.
  float m = min(min(d.x, d.y), d.z);
  if (m == d.x)      { world.x = uCutPoint.x; faceNormal = vec3(1.0, 0.0, 0.0); }
  else if (m == d.y) { world.y = uCutPoint.y; faceNormal = vec3(0.0, 1.0, 0.0); }
  else               { world.z = uCutPoint.z; faceNormal = vec3(0.0, 0.0, 1.0); }
  return world;
}

/** Positive outside the kept region. 0 exactly on the cut. */
float cutDistance(vec3 world) {
  if (uCutMode == 0) return -1.0;
  if (uCutMode == 1) return dot(world - uCutPoint, uCutNormal);
  vec3 d = world - uCutPoint;
  // Removed where all three components are positive; the distance to that
  // corner region is the length of whatever is still negative.
  if (d.x > 0.0 && d.y > 0.0 && d.z > 0.0) return min(min(d.x, d.y), d.z);
  vec3 outside = min(d, vec3(0.0));
  return -length(outside);
}
`;

/** Lighting. Fragment stage only. */
export const LIGHTING_CHUNK = /* glsl */ `
uniform vec3  uKeyDir;
uniform vec3  uFillDir;
uniform vec3  uRimDir;
uniform vec3  uKeyColor;
uniform vec3  uFillColor;
uniform vec3  uRimColor;
uniform vec3  uSkyColor;
uniform vec3  uGroundColor;
uniform float uExposure;
uniform int   uViewMode;

/**
 * Light bleeds past the terminator by a wrap term, so a translucent body never shows a
 * hard shadow line. This is the single cheapest thing that stops packed
 * spheres reading as billiard balls.
 */
float wrapDiffuse(vec3 n, vec3 l, float w) {
  return clamp((dot(n, l) + w) / ((1.0 + w) * (1.0 + w)), 0.0, 1.0);
}

/** Light that has travelled through the body and comes out towards the eye. */
float backScatter(vec3 n, vec3 l, vec3 v, float power, float thickness) {
  vec3 h = normalize(l + n * 0.25);
  return pow(clamp(dot(v, -h), 0.0, 1.0), power) * thickness;
}

float ggxSpecular(vec3 n, vec3 l, vec3 v, float roughness) {
  vec3 h = normalize(l + v);
  float a = max(1e-3, roughness * roughness);
  float ndh = max(0.0, dot(n, h));
  float d = a * a / (PI * pow(ndh * ndh * (a * a - 1.0) + 1.0, 2.0));
  return d * max(0.0, dot(n, l));
}

float fresnel(vec3 n, vec3 v, float power) {
  return pow(clamp(1.0 - max(0.0, dot(n, v)), 0.0, 1.0), power);
}

/** An analytic sky: no texture to fetch, and it cannot be blocked by a CSP. */
vec3 environment(vec3 n) {
  float t = n.y * 0.5 + 0.5;
  return mix(uGroundColor, uSkyColor, t * t * (3.0 - 2.0 * t));
}

struct TissueSurface {
  vec3  albedo;
  vec3  subsurfaceColor;
  float roughness;
  float clearcoat;
  float sheen;
  float thickness;
  float emissive;
};

vec3 shadeTissue(TissueSurface s, vec3 n, vec3 v) {
  vec3 lit = vec3(0.0);

  lit += s.albedo * uKeyColor * wrapDiffuse(n, uKeyDir, 0.55);
  lit += s.albedo * uFillColor * wrapDiffuse(n, uFillDir, 0.9);
  lit += s.subsurfaceColor * uKeyColor * backScatter(n, uKeyDir, v, 3.0, s.thickness);
  lit += s.subsurfaceColor * uFillColor * backScatter(n, uFillDir, v, 2.0, s.thickness * 0.6);

  lit += s.albedo * environment(n) * 0.55;

  float f = fresnel(n, v, 4.0);
  lit += uRimColor * f * s.sheen;
  lit += uRimColor * ggxSpecular(n, uRimDir, v, s.roughness) * 0.4;

  // Clearcoat: a second, tighter highlight over the top, which is what makes a
  // wet surface look wet.
  float coat = ggxSpecular(n, uKeyDir, v, 0.08) * s.clearcoat * (0.04 + 0.96 * f);
  lit += uKeyColor * coat;

  lit += s.albedo * s.emissive;
  return lit * uExposure;
}

/** Fluorescence is emission, not reflection: no key light, just glow and depth. */
vec3 shadeFluorescent(vec3 color, float intensity, vec3 n, vec3 v) {
  // Brighter towards the silhouette, the way a fluorescent body looks when the
  // light path through it is longest.
  float edge = 0.35 + 0.65 * fresnel(n, v, 1.6);
  return color * intensity * edge * uExposure;
}
`;

/** The three G-buffer outputs. Declare once, write once. */
export const GBUFFER_OUT = /* glsl */ `
layout(location = 0) out vec4 gColor;
layout(location = 1) out vec4 gNormalDepth;
layout(location = 2) out vec4 gIdentity;

void writeGBuffer(vec3 color, vec3 viewNormal, float viewDepth, vec3 id, float kind) {
  gColor = vec4(color, 1.0);
  gNormalDepth = vec4(normalize(viewNormal) * 0.5 + 0.5, viewDepth);
  gIdentity = vec4(id, kind);
}
`;
