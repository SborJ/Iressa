/**
 * One pass over the G-buffer: cell membranes, ambient occlusion, depth cues.
 *
 * Membranes are the piece that turns overlapping spheres into a cell mosaic.
 * Every instance writes its node id into the identity target, and a line is
 * drawn wherever that id changes between neighbouring pixels - so the boundary
 * is exactly where two real cells meet, at whatever angle and overlap they
 * happen to have. Nothing is drawn for a boundary that is not there.
 */

export const FULLSCREEN_VERTEX = /* glsl */ `
out vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy * 2.0, 0.0, 1.0);
}
`;

export const COMPOSITE_FRAGMENT = /* glsl */ `
precision highp float;

in vec2 vUv;
layout(location = 0) out vec4 outColor;

uniform sampler2D tColor;
uniform sampler2D tNormalDepth;
uniform sampler2D tIdentity;
uniform sampler2D tBloom;

uniform vec2  uResolution;
uniform vec3  uBackground;
uniform float uTanHalfFov;
uniform float uAspect;
uniform float uNear;
uniform float uFar;

uniform float uAoStrength;
uniform float uAoRadius;
uniform float uMembrane;
uniform float uMembraneDarkness;
uniform float uFogDensity;
uniform float uFogStart;
uniform float uBloom;
uniform float uGrain;
uniform float uTime;

uniform float uDofStrength;
uniform float uDofFocus;
uniform float uDofRange;

#define PI 3.14159265359

vec3 viewPositionAt(vec2 uv, float depth) {
  vec2 ndc = uv * 2.0 - 1.0;
  return vec3(ndc.x * uAspect * uTanHalfFov * depth, ndc.y * uTanHalfFov * depth, -depth);
}

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

void main() {
  vec4 nd = texture(tNormalDepth, vUv);
  float depth = nd.w;
  vec3 color = texture(tColor, vUv).rgb;

  /* Nothing was drawn here. */
  if (depth <= 0.0) {
    vec3 bg = uBackground;
    if (uBloom > 0.0) bg += texture(tBloom, vUv).rgb * uBloom;
    outColor = vec4(bg, 1.0);
    return;
  }

  vec3 normal = normalize(nd.xyz * 2.0 - 1.0);
  vec3 viewPos = viewPositionAt(vUv, depth);
  vec2 texel = 1.0 / uResolution;

  /* ---- depth of field: a small disc blur weighted by how far the pixel is
     from the focus plane. Presentation only; uDofStrength is 0 otherwise. --- */
  if (uDofStrength > 0.0) {
    float coc = clamp(abs(depth - uDofFocus) / max(1e-3, uDofRange), 0.0, 1.0);
    coc *= uDofStrength;
    if (coc > 0.01) {
      vec3 sum = color;
      float weight = 1.0;
      float radius = coc * 5.0;
      for (int i = 0; i < 8; i++) {
        float a = (float(i) + hash12(gl_FragCoord.xy)) / 8.0 * 6.2831853;
        vec2 o = vec2(cos(a), sin(a)) * radius * texel;
        vec4 s = texture(tNormalDepth, vUv + o);
        if (s.w <= 0.0) continue;
        sum += texture(tColor, vUv + o).rgb;
        weight += 1.0;
      }
      color = sum / weight;
    }
  }

  /* ---- ambient occlusion -------------------------------------------------
     Hemisphere samples around the view-space normal. Crevices between packed
     cells are exactly the geometry this darkens, which is most of what makes
     them read as touching rather than floating. */
  float ao = 1.0;
  if (uAoStrength > 0.0) {
    float occlusion = 0.0;
    float rot = hash12(gl_FragCoord.xy) * 6.2831853;
    const int SAMPLES = 12;
    for (int i = 0; i < SAMPLES; i++) {
      float fi = float(i);
      float ang = rot + fi * 2.39996;
      float r = uAoRadius * sqrt((fi + 0.5) / float(SAMPLES));
      // Project the sample offset to screen space at this depth.
      vec2 offset = vec2(cos(ang), sin(ang)) * r / (depth * uTanHalfFov * 2.0);
      offset.x /= uAspect;
      vec2 suv = vUv + offset;
      if (suv.x < 0.0 || suv.y < 0.0 || suv.x > 1.0 || suv.y > 1.0) continue;
      vec4 snd = texture(tNormalDepth, suv);
      if (snd.w <= 0.0) continue;
      vec3 sPos = viewPositionAt(suv, snd.w);
      vec3 diff = sPos - viewPos;
      float dist = length(diff);
      if (dist < 1e-4 || dist > uAoRadius * 2.0) continue;
      float cosine = max(0.0, dot(normal, diff / dist));
      occlusion += cosine * (1.0 / (1.0 + dist * dist / (uAoRadius * uAoRadius)));
    }
    ao = clamp(1.0 - uAoStrength * occlusion / float(SAMPLES) * 2.6, 0.0, 1.0);
    color *= ao;
  }

  /* ---- cell membranes ----------------------------------------------------
     A line where the identity changes. It follows real boundaries between real
     cells; only its width and darkness are a styling choice. */
  if (uMembrane > 0.0) {
    vec4 here = texture(tIdentity, vUv);
    float edge = 0.0;
    vec2 offsets[8] = vec2[8](
      vec2( 1.0, 0.0), vec2(-1.0, 0.0), vec2(0.0,  1.0), vec2(0.0, -1.0),
      vec2( 1.0, 1.0), vec2(-1.0, 1.0), vec2(1.0, -1.0), vec2(-1.0, -1.0));
    for (int i = 0; i < 8; i++) {
      vec4 other = texture(tIdentity, vUv + offsets[i] * texel * 1.2);
      float idDelta = length(other.rgb - here.rgb);
      float kindDelta = abs(other.a - here.a);
      edge = max(edge, step(0.002, idDelta + kindDelta) * (i < 4 ? 1.0 : 0.6));
    }
    // A darker shade of the cell's own colour, never a black outline.
    color *= 1.0 - uMembrane * uMembraneDarkness * edge;
  }

  /* ---- depth cue ---------------------------------------------------------
     Measured from the near face of the sample rather than from the camera, so
     the haze reads as depth through the tissue at any zoom instead of erasing
     the whole scene as soon as you pull back. */
  if (uFogDensity > 0.0) {
    float d = max(0.0, depth - uFogStart);
    float f = 1.0 - exp(-uFogDensity * uFogDensity * d * d);
    color = mix(color, uBackground, clamp(f, 0.0, 1.0));
  }

  if (uBloom > 0.0) color += texture(tBloom, vUv).rgb * uBloom;

  /* Sensor grain: real imaging is never perfectly clean. */
  if (uGrain > 0.0) {
    float n = hash12(gl_FragCoord.xy + uTime) - 0.5;
    color += n * uGrain * 0.12;
  }

  /* Filmic-ish tone map, then sRGB. */
  color = max(vec3(0.0), color);
  color = (color * (2.51 * color + 0.03)) / (color * (2.43 * color + 0.59) + 0.14);
  color = pow(clamp(color, 0.0, 1.0), vec3(1.0 / 2.2));

  outColor = vec4(color, 1.0);
}
`;

/** Bloom: keep only what is genuinely bright, then blur it. */
export const BLOOM_PREFILTER_FRAGMENT = /* glsl */ `
precision highp float;
in vec2 vUv;
layout(location = 0) out vec4 outColor;
uniform sampler2D tColor;
uniform float uThreshold;
void main() {
  vec3 c = texture(tColor, vUv).rgb;
  float luma = dot(c, vec3(0.2126, 0.7152, 0.0722));
  float keep = max(0.0, luma - uThreshold) / max(1e-4, luma);
  outColor = vec4(c * keep, 1.0);
}
`;

export const BLOOM_BLUR_FRAGMENT = /* glsl */ `
precision highp float;
in vec2 vUv;
layout(location = 0) out vec4 outColor;
uniform sampler2D tColor;
uniform vec2 uDirection;
void main() {
  // Nine-tap gaussian, separable.
  float w[5] = float[5](0.227027, 0.1945946, 0.1216216, 0.054054, 0.016216);
  vec3 sum = texture(tColor, vUv).rgb * w[0];
  for (int i = 1; i < 5; i++) {
    vec2 o = uDirection * float(i);
    sum += texture(tColor, vUv + o).rgb * w[i];
    sum += texture(tColor, vUv - o).rgb * w[i];
  }
  outColor = vec4(sum, 1.0);
}
`;
