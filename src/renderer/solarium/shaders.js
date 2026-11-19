// The glass surface uses separate distance-field, backdrop, highlight and edge
// stages. Geometry stays in CSS pixels; only backdrop lookups use capture texels.
import { BACKDROP_STAGE, HIGHLIGHT_STAGE, CONTRAST_STAGE, CORNER_FIELD } from './shader-stages.js';

export const VERTEX_SHADER = `#version 300 es
precision highp float;

out vec2 v_uv;

void main() {
  vec2 positions[4] = vec2[4](
    vec2(-1.0, -1.0),
    vec2( 1.0, -1.0),
    vec2(-1.0,  1.0),
    vec2( 1.0,  1.0)
  );
  vec2 position = positions[gl_VertexID];
  gl_Position = vec4(position, 0.0, 1.0);

  // Upper-left origin UVs. Every rectangle, corner and distance in the
  // fragment shader is expressed in UIKit-style screen coordinates, and the
  // captured backdrop is uploaded top row first (UNPACK_FLIP_Y_WEBGL stays
  // false), so v = 0 has to be the top of the view.
  v_uv = vec2(position.x * 0.5 + 0.5, 0.5 - position.y * 0.5);
}`;

export const FRAGMENT_SHADER = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 outColor;
const int MAX_RECTANGLES = 16;
float saturate(float v) { return clamp(v, 0.0, 1.0); }
vec2 saturate(vec2 v) { return clamp(v, 0.0, 1.0); }
vec3 saturate(vec3 v) { return clamp(v, 0.0, 1.0); }
vec4 saturate(vec4 v) { return clamp(v, 0.0, 1.0); }
uniform vec2 u_resolution;              // Drawable size in device pixels.
uniform float u_contentsScale;          // Device pixels per CSS pixel.
uniform vec2 u_touchPoint;              // Pointer in local CSS coordinates.
uniform float u_pressGlow;              // White press-light opacity.
uniform float u_pressProgress;          // Interactive press spring in [0, 1].
uniform vec2 u_pressStretch;            // Normalized rubber-band drag stretch vector.
uniform float u_pressInflate;           // Padded SDF expansion factor on press.
uniform float u_shapeMergeSmoothness;   // Smooth-union blend width, in view heights.
uniform float u_cornerRadius;           // Corner radius in CSS pixels.
uniform float u_cornerRoundnessExponent;// 2 = circular, 4 = fully continuous corners.
uniform int u_rectangleCount;
uniform vec4 u_rectangles[MAX_RECTANGLES]; // (x, y, width, height) in CSS px, upper-left origin.
uniform vec2 u_rectangleParams[MAX_RECTANGLES]; // (radiusPx (<0 => u_cornerRadius), unionOpacity)
uniform sampler2D u_background;

${CORNER_FIELD}
vec2 pressedSampleCoord(vec2 fragmentCoord) {
  if (u_pressInflate <= 0.0001 || (u_pressProgress <= 0.0005 && dot(u_pressStretch, u_pressStretch) <= 0.00001)) {
    return fragmentCoord;
  }
  vec2 centerPx = u_rectangleCount > 0
    ? (u_rectangles[0].xy + u_rectangles[0].zw * 0.5) * u_contentsScale
    : u_resolution * 0.5;
  vec2 local = fragmentCoord - centerPx;
  local -= u_pressStretch * (5.0 * u_contentsScale);
  float inflate = 1.0 + u_pressInflate * clamp(u_pressProgress, 0.0, 1.35);
  float ax = min(abs(u_pressStretch.x), 1.35);
  float ay = min(abs(u_pressStretch.y), 1.35);
  float sx = inflate * (1.0 + 0.065 * ax - 0.028 * ay);
  float sy = inflate * (1.0 + 0.065 * ay - 0.028 * ax);
  local /= vec2(max(0.85, sx), max(0.85, sy));
  return centerPx + local;
}


vec2 safeNormal(vec2 v) {
  float magnitude = dot(v, v);
  return magnitude > 1e-12 ? v * inversesqrt(magnitude) : vec2(1.0, 0.0);
}

vec3 rectangleField(vec2 p, vec4 rectangle, float radius) {
  vec2 halfSize = rectangle.zw * 0.5;
  vec2 q = p - rectangle.xy - halfSize;
  radius = clamp(radius, 0.0, min(halfSize.x, halfSize.y));
  if (radius <= 0.0001) {
    vec2 d = abs(q) - halfSize;
    vec2 outside = max(d, vec2(0.0));
    vec2 gradient = length(outside) > 0.0001 ? safeNormal(outside)
      : (d.x > d.y ? vec2(1.0, 0.0) : vec2(0.0, 1.0));
    return vec3(length(outside) + min(max(d.x, d.y), 0.0), gradient * vec2(q.x < 0.0 ? -1.0 : 1.0, q.y < 0.0 ? -1.0 : 1.0));
  }
  // Continuous corners need room to ease into a straight edge. As a capsule
  // approaches a half-extent radius, the field becomes circular on that axis.
  vec2 fits = clamp((vec2(1.5286649465560913) - halfSize/radius) / 0.5286650061607361, 0.0, 1.0);
  float continuous = clamp((u_cornerRoundnessExponent - 2.0) * 0.5, 0.0, 1.0);
  return continuousCornerField(q, halfSize, radius, mix(vec2(1.0), fits, continuous));
}

vec4 glassField(vec2 p) {
  p = pressedSampleCoord(p * u_contentsScale) / u_contentsScale;
  float distance = 1e10;
  vec2 gradient = vec2(1.0, 0.0);
  float membership = 0.0;
  float k = max(u_shapeMergeSmoothness * u_resolution.y / u_contentsScale, 0.0);
  for (int i = 0; i < MAX_RECTANGLES; ++i) {
    if (i >= u_rectangleCount) break;
    vec4 rect = u_rectangles[i];
    float weight = clamp(u_rectangleParams[i].y, 0.0, 1.0);
    if (min(rect.z, rect.w) <= 0.0 || weight <= 0.0) continue;
    float radius = u_rectangleParams[i].x >= 0.0 ? u_rectangleParams[i].x : u_cornerRadius;
    vec3 field = rectangleField(p, rect, radius);
    if (membership == 0.0) {
      distance = field.x;
      gradient = field.yz;
      membership = weight;
    } else {
      float h = k > 0.0001 ? clamp(1.0 - abs(distance - field.x)/k, 0.0, 1.0) : 0.0;
      float blend = distance <= field.x ? 1.0 - 0.5*h : 0.5*h;
      float united = min(distance, field.x) - 0.25*k*h*h;
      vec2 normal = safeNormal(mix(field.yz, gradient, blend));
      distance = mix(distance, united, weight);
      gradient = safeNormal(mix(gradient, normal, weight));
      float support = max(membership, clamp(1.0 - field.x / max(k, 0.000001), 0.0, 1.0));
      membership = mix(membership, support, weight);
    }
  }
  return vec4(distance, gradient, membership);
}

${BACKDROP_STAGE}
${HIGHLIGHT_STAGE}
${CONTRAST_STAGE}
void main() {
  vec2 p = v_uv * u_resolution / u_contentsScale;
  vec4 face = bg_main(p);
  // Disabled siblings must not re-evaluate every analytic shape per pixel.
  if (edge_opacity > 0.0 && edge_width > 0.0) face = bg_sourceOver(edge_main(p), face);
  if (hl_groupOpacity > 0.0) face = hl_composite(hl_main(p), face);
  // The press light is a separate material layer. Keep it in local CSS
  // coordinates so its position and softness survive capture downsampling.
  float press = clamp(u_pressProgress, 0.0, 1.0);
  if (press > 0.0001 && u_pressGlow > 0.0) {
    vec4 field = glassField(p);
    float coverage = saturate(0.5 - field.r / max(fwidth(field.r), 0.0001)) * field.a;
    vec2 size = u_resolution / u_contentsScale;
    float radius = clamp(min(size.x, size.y) * 0.8, 24.0, 140.0);
    vec2 delta = (p - u_touchPoint) / radius;
    float glow = exp(-2.0 * dot(delta, delta)) * press * u_pressGlow * coverage;
    // Brighten premultiplied RGB without changing silhouette or alpha. A
    // released pointer leaves its last position until the press spring settles.
    face.rgb = mix(face.rgb, vec3(face.a), clamp(glow, 0.0, 1.0));
  }
  outColor = face;
}`;

// Separable factor-two resampling preserves local contrast while constructing
// the pyramid. A broad Gaussian at every level would repeatedly desaturate
// small captures before the material's own blur-fill stage gets to sample them.
export const PYRAMID_SHADER = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 outColor;
uniform sampler2D u_source;
uniform vec2 u_sourceExtent;
uniform vec2 u_sampleAxis;
vec4 sampleOffset(vec2 uv, float offset) {
  return textureLod(u_source, uv + offset * u_sampleAxis / u_sourceExtent, 0.0);
}
void main() {
  // Cancel the framebuffer row flip on each pass so every level retains the
  // same sampling origin as the uploaded canvas.
  vec2 uv = vec2(v_uv.x, 1.0 - v_uv.y);
  outColor = sampleOffset(uv, 0.0) * 0.501429021358
    + (sampleOffset(uv, 0.5) + sampleOffset(uv, -0.5)) * 0.304832994938
    + (sampleOffset(uv, 1.5) + sampleOffset(uv, -1.5)) * -0.067740596831
    + (sampleOffset(uv, 2.5) + sampleOffset(uv, -2.5)) * 0.012193299830;
}`;
