import { COMMON_CHUNK, GBUFFER_OUT, LIGHTING_CHUNK } from './tissue.js';

/**
 * Vessel walls and the red cells inside them.
 *
 * The tube follows the real centreline of the vascular tree grown from
 * rules.json. The wall is a thin pale endothelium with a wet clearcoat; the
 * red cells are instanced biconcave discs whose motion along the centreline is
 * illustrative and carries no data.
 */
export const VESSEL_VERTEX = /* glsl */ `
out vec3 vWorld;
out vec3 vViewNormal;
out float vViewDepth;
out float vCut;

${COMMON_CHUNK}

void main() {
  vec3 world = position;
  vec4 viewPos = viewMatrix * vec4(world, 1.0);
  vWorld = world;
  vViewNormal = normalize((viewMatrix * vec4(normal, 0.0)).xyz);
  vViewDepth = -viewPos.z;
  vCut = cutDistance(world);
  gl_Position = projectionMatrix * viewPos;
}
`;

export const VESSEL_FRAGMENT = /* glsl */ `
precision highp float;

in vec3 vWorld;
in vec3 vViewNormal;
in float vViewDepth;
in float vCut;

uniform vec3  uWallColor;
uniform vec3  uBloodColor;
uniform float uRoughness;

${COMMON_CHUNK}
${LIGHTING_CHUNK}
${GBUFFER_OUT}

void main() {
  if (vCut > 0.0) discard;

  vec3 n = normalize(vViewNormal);
  bool inside = !gl_FrontFacing;
  if (inside) n = -n;

  // Outside: pale endothelium. Inside, where the cut opens a vessel: the
  // blood-filled lumen.
  vec3 albedo = inside ? uBloodColor : uWallColor;
  albedo *= 0.92 + 0.16 * fbm(vWorld * 2.2);

  vec3 v = vec3(0.0, 0.0, 1.0);
  vec3 lit;
  if (uViewMode == 1) {
    lit = shadeFluorescent(albedo, 0.9, n, v);
  } else {
    TissueSurface s;
    s.albedo = albedo;
    s.subsurfaceColor = uBloodColor * 1.2;
    s.roughness = uRoughness;
    // A vessel is wet: a tight clearcoat highlight is most of what says so.
    s.clearcoat = 0.9;
    s.sheen = 0.25;
    s.thickness = 0.8;
    s.emissive = 0.0;
    lit = shadeTissue(s, n, v);
  }

  writeGBuffer(lit, n, vViewDepth, vec3(0.0), 1.0);
}
`;

/** Red cells: instanced, flowing along the centreline. Illustrative motion. */
export const RBC_VERTEX = /* glsl */ `
in vec3 aStart;
in vec3 aEnd;
in vec4 aFlow;   // (phase, speed, radialOffset, spin)

uniform float uTime;
uniform float uRadius;

out vec3 vWorld;
out vec3 vViewNormal;
out float vViewDepth;
out float vCut;

${COMMON_CHUNK}

mat3 basisFrom(vec3 d) {
  vec3 up = abs(d.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
  vec3 t = normalize(cross(up, d));
  vec3 b = cross(d, t);
  return mat3(t, b, d);
}

void main() {
  vec3 axis = aEnd - aStart;
  float len = length(axis);
  vec3 dir = len > 1e-5 ? axis / len : vec3(0.0, 0.0, 1.0);
  mat3 frame = basisFrom(dir);

  float t = fract(aFlow.x + uTime * aFlow.y);
  vec3 centre = aStart + axis * t;
  // Drift off the axis, so the stream is not a single file down the middle.
  centre += frame[0] * aFlow.z * cos(aFlow.w + uTime * 0.7);
  centre += frame[1] * aFlow.z * sin(aFlow.w + uTime * 0.7);

  /* A biconcave disc: flatten the sphere, then press the faces in. */
  vec3 p = position;
  float r = length(p.xy);
  p.z *= 0.34;
  p.z *= 0.55 + 0.75 * smoothstep(0.0, 0.85, r);

  vec3 local = frame * p * uRadius;
  vec3 world = centre + local;

  vec3 nrm = normalize(frame * normalize(vec3(position.xy * 0.6, position.z * 2.2)));
  vec4 viewPos = viewMatrix * vec4(world, 1.0);
  vWorld = world;
  vViewNormal = normalize((viewMatrix * vec4(nrm, 0.0)).xyz);
  vViewDepth = -viewPos.z;
  vCut = cutDistance(world);
  gl_Position = projectionMatrix * viewPos;
}
`;

export const RBC_FRAGMENT = /* glsl */ `
precision highp float;

in vec3 vWorld;
in vec3 vViewNormal;
in float vViewDepth;
in float vCut;

uniform vec3 uBloodColor;

${COMMON_CHUNK}
${LIGHTING_CHUNK}
${GBUFFER_OUT}

void main() {
  if (vCut > 0.0) discard;
  vec3 n = normalize(vViewNormal);
  if (!gl_FrontFacing) n = -n;
  vec3 v = vec3(0.0, 0.0, 1.0);

  vec3 lit;
  if (uViewMode == 1) {
    lit = shadeFluorescent(uBloodColor, 0.6, n, v);
  } else {
    TissueSurface s;
    s.albedo = uBloodColor;
    s.subsurfaceColor = uBloodColor * 1.6;
    s.roughness = 0.35;
    s.clearcoat = 0.5;
    s.sheen = 0.2;
    s.thickness = 1.0;
    s.emissive = 0.0;
    lit = shadeTissue(s, n, v);
  }
  writeGBuffer(lit, n, vViewDepth, vec3(0.0), 1.0);
}
`;
