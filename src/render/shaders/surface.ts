import { COMMON_CHUNK, GBUFFER_OUT, LIGHTING_CHUNK } from './tissue.js';

/**
 * The outer surface of the mass, where individual cells are not drawn.
 *
 * It carries a procedural cell mosaic so that at a distance the surface still
 * reads as made of cells rather than as a blob of plastic. The mosaic is
 * illustrative - it is a texture at the scale of one cell, not a picture of
 * particular cells - and is labelled as such in the legend.
 */
export const SURFACE_VERTEX = /* glsl */ `
out vec3 vWorld;
out vec3 vViewNormal;
out vec3 vWorldNormal;
out float vViewDepth;
out float vCut;

${COMMON_CHUNK}

void main() {
  vec3 world = position;
  vec4 viewPos = viewMatrix * vec4(world, 1.0);
  vWorld = world;
  vWorldNormal = normal;
  vViewNormal = normalize((viewMatrix * vec4(normal, 0.0)).xyz);
  vViewDepth = -viewPos.z;
  vCut = cutDistance(world);
  gl_Position = projectionMatrix * viewPos;
}
`;

export const SURFACE_FRAGMENT = /* glsl */ `
precision highp float;

in vec3 vWorld;
in vec3 vViewNormal;
in vec3 vWorldNormal;
in float vViewDepth;
in float vCut;

uniform vec3  uAlbedo;
uniform vec3  uSubsurface;
uniform float uRoughness;
uniform float uClearcoat;
uniform float uSheen;
uniform float uThickness;
uniform float uMosaic;
uniform float uMosaicScale;
uniform float uEmission;

${COMMON_CHUNK}
${LIGHTING_CHUNK}
${GBUFFER_OUT}

void main() {
  if (vCut > 0.0) discard;

  vec3 albedo = uAlbedo;

  /* Cell mosaic at the scale of one cell: illustrative, so the surface does
     not read as a smooth shell at a distance. */
  if (uMosaic > 0.0) {
    // Warp the lattice before sampling it, so the mosaic is irregular the way
    // packed cells are rather than a regular net.
    vec3 warp = vWorld * uMosaicScale + vec3(fbm(vWorld * 0.7)) * 1.4;
    float edge = voronoiEdge(warp);
    float seam = 1.0 - smoothstep(0.0, 0.16, edge);
    albedo *= 1.0 - uMosaic * 0.32 * seam;
    albedo *= 0.88 + 0.26 * fbm(vWorld * 0.55);
  }

  // Back faces are the inside of the mass; shade them darker so a peek through
  // the cut reads as depth, not as a hollow shell.
  vec3 n = normalize(vViewNormal);
  if (!gl_FrontFacing) {
    n = -n;
    albedo *= 0.55;
  }

  vec3 v = vec3(0.0, 0.0, 1.0);
  vec3 lit;
  if (uViewMode == 1) {
    lit = shadeFluorescent(albedo, uEmission, n, v);
  } else {
    TissueSurface s;
    s.albedo = albedo;
    s.subsurfaceColor = uSubsurface;
    s.roughness = uRoughness;
    s.clearcoat = uClearcoat;
    s.sheen = uSheen;
    s.thickness = uThickness;
    s.emissive = 0.0;
    lit = shadeTissue(s, n, v);
  }

  writeGBuffer(lit, n, vViewDepth, vec3(0.0), 0.75);
}
`;
