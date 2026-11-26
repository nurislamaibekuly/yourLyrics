import { LiquidGlass, LiquidGlassView, createMenuMaterial } from '../solarium/index.js';
import { LiquidGlassRenderer } from '../solarium/renderer.js';
import { createSetupFlow } from './setup-flow.js';
import { VERTEX_SHADER } from '../solarium/shaders.js';
import { BACKDROP_STAGE, HIGHLIGHT_STAGE, CONTRAST_STAGE } from '../solarium/shader-stages.js';

const ICON_SVG_URL = new URL('../../../assets/icon.icon/Assets/icon.svg', import.meta.url).href;

const HELLO_SVG_NS = 'http://www.w3.org/2000/svg';
const HELLO_PATH_D = 'M-293.58-104.62S-103.61-205.49-60-366.25c9.13-32.45,9-58.31,0-74-10.72-18.82-49.69-33.21-75.55,31.94-27.82,70.11-52.22,377.24-44.11,322.48s34-176.24,99.89-183.19c37.66-4,49.55,23.58,52.83,47.92a117.06,117.06,0,0,1-3,45.32c-7.17,27.28-20.47,97.67,33.51,96.86,66.93-1,131.91-53.89,159.55-84.49,31.1-36.17,31.1-70.64,19.27-90.25-16.74-29.92-69.47-33-92.79,16.73C62.78-179.86,98.7-93.8,159-81.63S302.7-99.55,393.3-269.92c29.86-58.16,52.85-114.71,46.14-150.08-7.44-39.21-59.74-54.5-92.87-8.7-47,65-61.78,266.62-34.74,308.53S416.62-58,481.52-130.31s133.2-188.56,146.54-256.23c14-71.15-56.94-94.64-88.4-47.32C500.53-375,467.58-229.49,503.3-127a73.73,73.73,0,0,0,23.43,33.67c25.49,20.23,55.1,16,77.46,6.32a111.25,111.25,0,0,0,30.44-19.87c37.73-34.23,29-36.71,64.58-127.53C724-284.3,785-298.63,821-259.13a71,71,0,0,1,13.69,22.56c17.68,46,6.81,80-6.81,107.89-12,24.62-34.56,42.72-61.45,47.91-23.06,4.45-48.37-.35-66.48-24.27a78.88,78.88,0,0,1-12.66-25.8c-14.75-51,4.14-88.76,11-101.41,6.18-11.39,37.26-69.61,103.42-42.24,55.71,23.05,100.66-23.31,100.66-23.31';
const HELLO_VB_W = 1230.94;
const HELLO_VB_H = 414.57;
const HELLO_TX = 311.08;
const HELLO_TY = 476.02;

const SEG_COUNT = 512;
const CHUNK_SIZE = 16;
const CHUNK_COUNT = SEG_COUNT / CHUNK_SIZE;

const START_SCALE = 2.05;
const BACKDROP_FADE_DELAY = 0.5;
const BACKDROP_FADE_DUR = 1.20;
const MORPH_START = 2.00;
const MORPH_DUR = 0.85;
const MORPH_END = MORPH_START + MORPH_DUR;
const SCRIBBLE_START = 2.88;
const SCRIBBLE_DUR = 3.55;
const CAM_START = 3.12;
const CAM_DUR = 2.60;
const BOUNCE_SETTLE = 1.20;
const BUTTON_REVEAL_AT = SCRIBBLE_START + SCRIBBLE_DUR;

function cubicBezier(x1, y1, x2, y2) {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sampleX = t => ((ax * t + bx) * t + cx) * t;
  const sampleY = t => ((ay * t + by) * t + cy) * t;
  const sampleDX = t => (3 * ax * t + 2 * bx) * t + cx;
  return x => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 6; i += 1) {
      const dx = sampleDX(t);
      if (Math.abs(dx) < 1e-6) break;
      t = Math.min(1, Math.max(0, t - (sampleX(t) - x) / dx));
    }
    if (Math.abs(sampleX(t) - x) > 1e-4) {
      let lo = 0;
      let hi = 1;
      t = x;
      for (let i = 0; i < 12; i += 1) {
        const sx = sampleX(t);
        if (Math.abs(sx - x) < 1e-5) break;
        if (sx < x) lo = t;
        else hi = t;
        t = 0.5 * (lo + hi);
      }
    }
    return sampleY(t);
  };
}

const easeBackdropFade = cubicBezier(0.0, 0.0, 0.42, 1.0);
const easeIntro = cubicBezier(0.16, 1.0, 0.30, 1.0);
const easeIconMorph = cubicBezier(0.45, 0.0, 0.55, 1.0);
const easeDotGrow = cubicBezier(0.22, 1.0, 0.36, 1.0);
const easeScribble = cubicBezier(0.35, 0.04, 0.62, 1.0);
const easeCameraPull = cubicBezier(0.28, 0.0, 0.42, 1.0);

function edt1d(f, n, v, z, d) {
  let k = 0;
  v[0] = 0;
  z[0] = -1e20;
  z[1] = 1e20;
  for (let q = 1; q < n; q += 1) {
    let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k -= 1;
      s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k += 1;
    v[k] = q;
    z[k] = s;
    z[k + 1] = 1e20;
  }
  k = 0;
  for (let q = 0; q < n; q += 1) {
    while (z[k + 1] < q) k += 1;
    const dx = q - v[k];
    d[q] = dx * dx + f[v[k]];
  }
}

function edt2d(binaryMask, w, h) {
  const INF = 1e12;
  const grid = new Float32Array(w * h);
  for (let i = 0; i < grid.length; i += 1) {
    grid[i] = binaryMask[i] ? 0 : INF;
  }
  const maxDim = Math.max(w, h);
  const f = new Float32Array(maxDim);
  const d = new Float32Array(maxDim);
  const v = new Int32Array(maxDim);
  const z = new Float32Array(maxDim + 1);
  for (let x = 0; x < w; x += 1) {
    for (let y = 0; y < h; y += 1) f[y] = grid[y * w + x];
    edt1d(f, h, v, z, d);
    for (let y = 0; y < h; y += 1) grid[y * w + x] = d[y];
  }
  for (let y = 0; y < h; y += 1) {
    const row = y * w;
    for (let x = 0; x < w; x += 1) f[x] = grid[row + x];
    edt1d(f, w, v, z, d);
    for (let x = 0; x < w; x += 1) grid[row + x] = Math.sqrt(d[x]);
  }
  return grid;
}

async function buildIconSdfTexture(gl, svgUrl, sdfSize = 512) {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.src = svgUrl;
  await img.decode();

  const c = document.createElement('canvas');
  c.width = sdfSize;
  c.height = sdfSize;
  const g = c.getContext('2d');
  g.clearRect(0, 0, sdfSize, sdfSize);

  const aspect = (img.naturalWidth || 24) / (img.naturalHeight || 30);
  const drawH = sdfSize * 0.72;
  const drawW = drawH * aspect;
  const ox = (sdfSize - drawW) * 0.5;
  const oy = (sdfSize - drawH) * 0.5 + sdfSize * 0.03;
  g.drawImage(img, ox, oy, drawW, drawH);

  const pixels = g.getImageData(0, 0, sdfSize, sdfSize).data;
  const n = sdfSize * sdfSize;
  const inside = new Uint8Array(n);
  const outside = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) {
    const a = pixels[i * 4 + 3];
    inside[i] = a >= 128 ? 1 : 0;
    outside[i] = a < 128 ? 1 : 0;
  }

  const distToInside = edt2d(inside, sdfSize, sdfSize);
  const distToOutside = edt2d(outside, sdfSize, sdfSize);
  const sd = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    const a = pixels[i * 4 + 3] / 255.0;
    let dist = inside[i] ? -distToOutside[i] : distToInside[i];
    if (a > 0.0 && a < 1.0) dist = 0.5 - a;
    sd[i] = dist;
  }

  const halfFloat = new Float32Array(n * 4);
  const sampleSd = (x, y) => sd[
    Math.max(0, Math.min(sdfSize - 1, y)) * sdfSize +
    Math.max(0, Math.min(sdfSize - 1, x))
  ];
  for (let y = 0; y < sdfSize; y += 1) {
    for (let x = 0; x < sdfSize; x += 1) {
      const i = y * sdfSize + x;
      const gx = (sampleSd(x + 1, y - 1) + 2 * sampleSd(x + 1, y) + sampleSd(x + 1, y + 1)) -
                 (sampleSd(x - 1, y - 1) + 2 * sampleSd(x - 1, y) + sampleSd(x - 1, y + 1));
      const gy = (sampleSd(x - 1, y + 1) + 2 * sampleSd(x, y + 1) + sampleSd(x + 1, y + 1)) -
                 (sampleSd(x - 1, y - 1) + 2 * sampleSd(x, y - 1) + sampleSd(x + 1, y - 1));
      const len = Math.hypot(gx, gy) || 1;
      halfFloat[i * 4 + 0] = sd[i];
      halfFloat[i * 4 + 1] = gx / len;
      halfFloat[i * 4 + 2] = gy / len;
      halfFloat[i * 4 + 3] = 1.0;
    }
  }

  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, sdfSize, sdfSize, 0, gl.RGBA, gl.FLOAT, halfFloat);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
  return { tex, sdfSize };
}

function createDataTexture(gl) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return tex;
}

function compileShader(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh) || 'unknown shader error';
    gl.deleteShader(sh);
    throw new Error(log);
  }
  return sh;
}

const HELLO_SOLARIUM_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 outColor;
const int MAX_RECTANGLES = 16;
const int SEG_COUNT = ${SEG_COUNT};
const int CHUNK_SIZE = ${CHUNK_SIZE};
const int CHUNK_COUNT = ${CHUNK_COUNT};
float saturate(float v) { return clamp(v, 0.0, 1.0); }
vec2 saturate(vec2 v) { return clamp(v, 0.0, 1.0); }
vec3 saturate(vec3 v) { return clamp(v, 0.0, 1.0); }
vec4 saturate(vec4 v) { return clamp(v, 0.0, 1.0); }

uniform vec2 u_resolution;
uniform float u_contentsScale;
uniform vec2 u_touchPoint;
uniform float u_pressGlow;
uniform float u_pressProgress;
uniform vec2 u_pressStretch;
uniform float u_pressInflate;
uniform float u_shapeMergeSmoothness;
uniform float u_cornerRadius;
uniform float u_cornerRoundnessExponent;
uniform int u_rectangleCount;
uniform vec4 u_rectangles[MAX_RECTANGLES];
uniform vec2 u_rectangleParams[MAX_RECTANGLES];
uniform sampler2D u_background;

uniform sampler2D u_iconSdf;
uniform sampler2D u_helloSegTex;
uniform sampler2D u_helloChunkTex;
uniform sampler2D u_helloMetaTex;
uniform vec4 u_iconRect;
uniform vec4 u_helloRect;
uniform float u_activeSegs;
uniform float u_strokeRadius;
uniform vec2 u_dotCenter;
uniform float u_dotRadius;
uniform float u_morphT;
uniform float u_iconScale;
uniform float u_iconDilate;
uniform float u_showHello;
uniform vec2 u_camFocus;
uniform vec2 u_camCenter;
uniform float u_camScale;

vec4 sminField(vec4 a, vec4 b, float k) {
  float h = clamp(0.5 + 0.5 * (b.r - a.r) / max(k, 0.001), 0.0, 1.0);
  float d = mix(b.r, a.r, h) - k * h * (1.0 - h);
  vec2 n = normalize(mix(b.gb, a.gb, h) + vec2(1e-5));
  return vec4(d, n, 1.0);
}

vec4 sampleIconField(vec2 p) {
  vec2 center = u_iconRect.xy + u_iconRect.zw * 0.5;
  float sc = max(u_iconScale, 0.04);
  vec2 scaledP = center + (p - center) / sc;
  vec2 local = scaledP - u_iconRect.xy;
  vec2 uv = clamp(local / max(u_iconRect.zw, vec2(1.0)), 0.001, 0.999);
  vec4 s = texture(u_iconSdf, uv);
  float dCss = s.r * (u_iconRect.z / 512.0) * sc - u_iconDilate;
  vec2 over = max(max(-local, local - u_iconRect.zw), vec2(0.0));
  dCss += length(over) * sc;
  vec2 n = length(s.gb) > 1e-4 ? normalize(s.gb) : vec2(0.0, -1.0);
  return vec4(dCss, n, 1.0);
}

vec4 sampleDotField(vec2 p) {
  vec2 diff = p - u_dotCenter;
  float len = length(diff);
  vec2 n = len > 1e-4 ? diff / len : vec2(0.0, -1.0);
  return vec4(len - u_dotRadius, n, 1.0);
}

vec4 sampleAnalyticHello(vec2 screenP) {
  vec2 p = u_camFocus + (screenP - u_camCenter) / u_camScale;

  float maxR = u_strokeRadius * 1.32;
  float margin = maxR + 60.0;
  vec2 boxMin = u_helloRect.xy - vec2(margin);
  vec2 boxMax = u_helloRect.xy + u_helloRect.zw + vec2(margin);
  vec2 outVec = max(max(boxMin - p, p - boxMax), vec2(0.0));
  if (dot(outVec, outVec) > 0.0) {
    return vec4((length(outVec) + 52.0) * u_camScale, vec2(0.0, -1.0), 1.0);
  }

  if (u_activeSegs <= 0.001) {
    vec2 startP = texelFetch(u_helloSegTex, ivec2(0, 0), 0).xy;
    vec2 diff = p - startP;
    float len = length(diff);
    return vec4((len - u_strokeRadius) * u_camScale, len > 1e-4 ? diff / len : vec2(0.0, -1.0), 1.0);
  }

  float minSignedD = 1e20;
  float bestDist = 1e20;
  vec2 bestV = vec2(0.0, -1.0);
  int totalActive = int(ceil(u_activeSegs));

  for (int c = 0; c < CHUNK_COUNT; ++c) {
    int baseIdx = c * CHUNK_SIZE;
    if (baseIdx >= totalActive) break;
    vec4 bounds = texelFetch(u_helloChunkTex, ivec2(c, 0), 0);
    vec2 cOut = max(max(bounds.xy - p, p - bounds.zw), vec2(0.0));
    float cDist = length(cOut);
    if (cDist - maxR > min(minSignedD, 52.0)) continue;

    int endIdx = min(baseIdx + CHUNK_SIZE, totalActive);
    for (int i = baseIdx; i < endIdx; ++i) {
      vec4 seg = texelFetch(u_helloSegTex, ivec2(i, 0), 0);
      vec2 rad = texelFetch(u_helloMetaTex, ivec2(i, 0), 0).xy;
      vec2 a = seg.xy;
      vec2 b = seg.zw;
      float rA = rad.x * u_strokeRadius;
      float rB = rad.y * u_strokeRadius;
      if (i == totalActive - 1) {
        float frac = clamp(u_activeSegs - float(i), 0.0, 1.0);
        b = mix(a, b, frac);
        rB = mix(rA, rB, frac);
      }
      vec2 pa = p - a;
      vec2 ba = b - a;
      float denom = dot(ba, ba);
      float h = denom > 1e-6 ? clamp(dot(pa, ba) / denom, 0.0, 1.0) : 0.0;
      vec2 v = pa - ba * h;
      float dist = length(v);
      float signedD = dist - mix(rA, rB, h);
      if (signedD < minSignedD) {
        minSignedD = signedD;
        bestDist = dist;
        bestV = v;
      }
    }
  }
  vec2 n = bestDist > 1e-4 ? bestV / bestDist : vec2(0.0, -1.0);
  return vec4(minSignedD * u_camScale, n, 1.0);
}

vec4 glassField(vec2 p) {
  if (u_showHello > 0.5) {
    return sampleAnalyticHello(p);
  }
  vec4 iconF = sampleIconField(p);
  if (u_morphT <= 0.0005) return iconF;
  vec4 dotF = sampleDotField(p);
  if (u_morphT >= 0.9995) return dotF;
  float swallow = smoothstep(0.62, 0.96, u_morphT);
  iconF.r += swallow * 90.0;
  float k = 28.0 * sin(3.14159265 * u_morphT);
  return sminField(iconF, dotF, k);
}

${BACKDROP_STAGE}
${HIGHLIGHT_STAGE}
${CONTRAST_STAGE}

void main() {
  vec2 p = v_uv * u_resolution / u_contentsScale;
  vec4 face = bg_main(p);
  if (edge_opacity > 0.0 && edge_width > 0.0) face = bg_sourceOver(edge_main(p), face);
  if (hl_groupOpacity > 0.0) face = hl_composite(hl_main(p), face);
  outColor = face;
}`;

function buildHelloGlassMaterial(opticalRadiusCss, viewH, lightAngleOffset = 0) {
  const r = Math.max(opticalRadiusCss, 6);
  const keyAngle = -2.14 + lightAngleOffset;
  const keyDir = [Math.cos(keyAngle), Math.sin(keyAngle)];
  const fillDir = [-keyDir[0], -keyDir[1]];
  return new LiquidGlass({
    uniforms: {
      glassThickness: r,
      refractiveIndex: 1.56,
      dispersionStrength: 8.5,
      glareIntensity: 0.78,
      optics: {
        bg_innerRefractionAmount: -(r * 1.95),
        bg_innerRefractionInverseHeight: 1 / Math.max(r * 1.02, 5),
        bg_hasOuterRefraction: 1,
        bg_outerRefractionAmount: r * 0.72,
        bg_outerRefractionInverseHeight: 1 / Math.max(r * 0.55, 4),
        bg_refractionThreshold0: -Math.max(2.2, r * 0.16),
        bg_refractionThreshold1: 0,
        bg_refractionOpacity: 0.55,
        bg_blurRadius: 2.2,
        bg_blurFillEnabled: 1,
        bg_blurFillBlurRadius: 10.0,
        bg_blurFillLightenOpacity: 0.24,
        bg_blurFillDarkenOpacity: 0,
        bg_blurFillNormalOpacity: 0.18,
        bg_keyFillHighlightDirection: fillDir,
        bg_keyFillHighlightHeight: Math.max(2.4, r * 0.28),
        bg_keyFillHighlightSpread: 0.16,
        bg_keyFillHighlightAmount: 0.45,
        bg_keyFillHighlightEffectOffset: -0.4,
        bg_keyFillHighlightColorBias: -0.22,
        bg_wantsHighlightBiasCorrection: 1,
        bg_shadowAmount: 0,
        bg_shadowInverseHeight: 0,
        bg_shadowOffset: [0, -Math.max(4, r * 0.30) / Math.max(viewH, 1)],
        bg_shadowInverseRadius: 1 / Math.max(9, r * 0.65),
        bg_shadowBlurRadius: 10,
        bg_shadowOpacity: 0.048,
        bg_shadowContribution: 0.35,
        bg_shadowFaceOpacity: 0.35,
        bg_shadowCM: [
          0.72, 0, 0, 0,
          0, 0.74, 0, 0,
          0, 0, 0.78, 0,
        ],
        hl_keyDirection: keyDir,
        hl_fillDirection: fillDir,
        hl_keyHeight: Math.max(1.8, r * 0.19),
        hl_fillHeight: Math.max(1.5, r * 0.14),
        hl_keySpread: 0.22,
        hl_fillSpread: 0.36,
        hl_keyAmount: 0.55,
        hl_fillAmount: 1.55,
        hl_keyColor: [1.0, 1.0, 1.0, 0.92],
        hl_fillColor: [0.90, 0.96, 1.0, 0.52],
        hl_curvature: 0.72,
        hl_diffuseKeyHeight: Math.max(5.0, r * 0.66),
        hl_diffuseFillHeight: Math.max(3.5, r * 0.40),
        hl_diffuseKeySpread: -0.10,
        hl_diffuseFillSpread: 0.18,
        hl_diffuseKeyAmount: 2.2,
        hl_diffuseFillAmount: 3.4,
        hl_hasDiffuse: 1,
        hl_effectiveGroupGain: 1.08,
        hl_groupOpacity: 0.78,
        hl_groupBlend: 0,
        edge_opacity: 0,
      },
    },
    backgroundTextureSizeCoefficient: 1,
    backgroundTextureScaleCoefficient: 0.75,
    backgroundTextureBlurRadius: 2.2,
    backdropTone: [1.16, 1.06],
    tintColor: [0.95, 0.985, 1.0, 0.22],
  });
}

function buildGetStartedGlassMaterial() {
  const material = createMenuMaterial('regular');
  const resolveOptics = material.resolveOptics.bind(material);
  // Match MenuView's dark platter, independent of the system appearance.
  material.resolveOptics = (_isDark, geometry) => resolveOptics(true, geometry);
  return material;
}

function sampleHelloCurve(pathEl) {
  const totalLen = pathEl.getTotalLength();
  const normPts = new Float32Array((SEG_COUNT + 1) * 2);
  for (let i = 0; i <= SEG_COUNT; i += 1) {
    const pt = pathEl.getPointAtLength((i / SEG_COUNT) * totalLen);
    normPts[i * 2 + 0] = (pt.x + HELLO_TX) / HELLO_VB_W;
    normPts[i * 2 + 1] = (pt.y + HELLO_TY) / HELLO_VB_H;
  }

  const rawTurn = new Float32Array(SEG_COUNT);
  for (let i = 1; i < SEG_COUNT; i += 1) {
    const ax = (normPts[i * 2] - normPts[(i - 1) * 2]) * HELLO_VB_W;
    const ay = (normPts[i * 2 + 1] - normPts[(i - 1) * 2 + 1]) * HELLO_VB_H;
    const bx = (normPts[(i + 1) * 2] - normPts[i * 2]) * HELLO_VB_W;
    const by = (normPts[(i + 1) * 2 + 1] - normPts[i * 2 + 1]) * HELLO_VB_H;
    const la = Math.hypot(ax, ay) || 1;
    const lb = Math.hypot(bx, by) || 1;
    const cosA = Math.max(-1, Math.min(1, (ax * bx + ay * by) / (la * lb)));
    rawTurn[i] = Math.acos(cosA);
  }

  const cumTime = new Float32Array(SEG_COUNT + 1);
  const smoothR = 12;
  for (let i = 0; i < SEG_COUNT; i += 1) {
    let sum = 0;
    let wSum = 0;
    for (let k = -smoothR; k <= smoothR; k += 1) {
      const idx = Math.max(0, Math.min(SEG_COUNT - 1, i + k));
      const w = 1 - Math.abs(k) / (smoothR + 1);
      sum += rawTurn[idx] * w;
      wSum += w;
    }
    const avgTurn = sum / wSum;
    cumTime[i + 1] = cumTime[i] + 1.0 + Math.min(1.4, avgTurn * 9.5);
  }
  const totalTimeWeight = cumTime[SEG_COUNT] || 1;
  for (let i = 0; i <= SEG_COUNT; i += 1) {
    cumTime[i] /= totalTimeWeight;
  }

  const vertexBirthSec = new Float32Array(SEG_COUNT + 1);
  for (let i = 0; i <= SEG_COUNT; i += 1) {
    const targetP = cumTime[i];
    let lo = 0;
    let hi = 1;
    for (let iter = 0; iter < 18; iter += 1) {
      const mid = 0.5 * (lo + hi);
      if (easeScribble(mid) < targetP) lo = mid;
      else hi = mid;
    }
    vertexBirthSec[i] = 0.5 * (lo + hi) * SCRIBBLE_DUR;
  }

  const tanX = new Float32Array(SEG_COUNT + 1);
  const tanY = new Float32Array(SEG_COUNT + 1);
  for (let i = 0; i <= SEG_COUNT; i += 1) {
    const i0 = Math.max(0, i - 1);
    const i1 = Math.min(SEG_COUNT, i + 1);
    const dx = (normPts[i1 * 2] - normPts[i0 * 2]) * HELLO_VB_W;
    const dy = (normPts[i1 * 2 + 1] - normPts[i0 * 2 + 1]) * HELLO_VB_H;
    const len = Math.hypot(dx, dy) || 1;
    tanX[i] = dx / len;
    tanY[i] = dy / len;
  }

  const rawBx = new Float32Array(SEG_COUNT + 1);
  const rawBy = new Float32Array(SEG_COUNT + 1);
  for (let i = 0; i <= SEG_COUNT; i += 1) {
    const iPrev = Math.max(0, i - 4);
    const iNext = Math.min(SEG_COUNT, i + 4);
    rawBx[i] = (tanX[iPrev] - tanX[iNext]) * 2.2;
    rawBy[i] = (tanY[iPrev] - tanY[iNext]) * 2.2 - 0.52;
  }

  const bounceDirX = new Float32Array(SEG_COUNT + 1);
  const bounceDirY = new Float32Array(SEG_COUNT + 1);
  const bounceSmoothR = 14;
  for (let i = 0; i <= SEG_COUNT; i += 1) {
    let sx = 0;
    let sy = 0;
    let ws = 0;
    for (let k = -bounceSmoothR; k <= bounceSmoothR; k += 1) {
      const idx = Math.max(0, Math.min(SEG_COUNT, i + k));
      const w = 1 - Math.abs(k) / (bounceSmoothR + 1);
      sx += rawBx[idx] * w;
      sy += rawBy[idx] * w;
      ws += w;
    }
    sx /= ws;
    sy /= ws;
    const len = Math.hypot(sx, sy);
    const gain = len > 1e-4 ? len / (len + 0.28) : 0;
    bounceDirX[i] = len > 1e-4 ? (sx / len) * gain : 0;
    bounceDirY[i] = len > 1e-4 ? (sy / len) * gain : -0.4;
  }

  return { normPts, cumTime, vertexBirthSec, bounceDirX, bounceDirY };
}

export function createHelloScreen({
  container = document.querySelector('#app') || document.body,
  backdropCanvas = document.querySelector('.backdrop'),
  isBackdropPlaying = () => false,
  initialSettings = {},
  onSetupComplete = () => {},
  onDismiss = () => {},
} = {}) {
  const root = document.createElement('div');
  root.className = 'hello-screen';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-label', 'Welcome to yourLyrics');

  const canvas = document.createElement('canvas');
  canvas.className = 'hello-screen__canvas';
  canvas.setAttribute('aria-hidden', 'true');

  const svg = document.createElementNS(HELLO_SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${HELLO_VB_W} ${HELLO_VB_H}`);
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('hello-screen__path-svg');
  const pathEl = document.createElementNS(HELLO_SVG_NS, 'path');
  pathEl.setAttribute('d', HELLO_PATH_D);
  pathEl.setAttribute('transform', `translate(${HELLO_TX} ${HELLO_TY})`);
  svg.append(pathEl);

  const footer = document.createElement('div');
  footer.className = 'hello-screen__footer';

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'hello-get-started';
  const label = document.createElement('span');
  label.className = 'hello-get-started__label';
  label.textContent = 'Get Started';
  button.append(label);
  footer.append(button);

  root.append(canvas, svg, footer);
  container.append(root);

  const curve = sampleHelloCurve(pathEl);

  function segsAtProgress(p) {
    if (p <= 0) return 0;
    if (p >= 1) return SEG_COUNT;
    let lo = 0;
    let hi = SEG_COUNT;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1;
      if (curve.cumTime[mid] <= p) lo = mid;
      else hi = mid;
    }
    const span = Math.max(curve.cumTime[hi] - curve.cumTime[lo], 1e-6);
    return lo + (p - curve.cumTime[lo]) / span;
  }

  let disposed = false;
  let started = false;
  let dismissing = false;
  let buttonVisible = false;
  let settingUp = false;
  let setup = null;
  let rafId = 0;
  let startTime = 0;
  let warmupFrames = 0;
  let fallbackRevealTimer = 0;

  let renderer = null;
  let gl = null;
  let loc = null;
  let iconSdf = null;
  let helloSegTex = null;
  let helloChunkTex = null;
  let helloMetaTex = null;
  let buttonGlass = null;

  const baseVertsX = new Float32Array(SEG_COUNT + 1);
  const baseVertsY = new Float32Array(SEG_COUNT + 1);
  const curVertsX = new Float32Array(SEG_COUNT + 1);
  const curVertsY = new Float32Array(SEG_COUNT + 1);
  const curRadScale = new Float32Array(SEG_COUNT + 1);
  const segData = new Float32Array(SEG_COUNT * 4);
  const chunkData = new Float32Array(CHUNK_COUNT * 4);
  const metaData = new Float32Array(SEG_COUNT * 4);

  let lastLayoutKey = '';
  let helloTexturesAllocated = false;
  let helloSettled = false;

  const bgCaptureCanvas = document.createElement('canvas');
  const bgCaptureCtx = bgCaptureCanvas.getContext('2d');
  let lastBgKey = '';
  let prevBackdropPlaying = false;

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const webglReady = (() => {
    if (!LiquidGlassRenderer.isSupported()) return false;
    try {
      renderer = new LiquidGlassRenderer(canvas);
      gl = renderer.gl;
      gl.deleteProgram(renderer.program);
      const prog = gl.createProgram();
      const vs = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
      const fs = compileShader(gl, gl.FRAGMENT_SHADER, HELLO_SOLARIUM_FS);
      gl.attachShader(prog, vs);
      gl.attachShader(prog, fs);
      gl.linkProgram(prog);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        const log = gl.getProgramInfoLog(prog) || 'program link failed';
        gl.deleteProgram(prog);
        throw new Error(log);
      }
      renderer.program = prog;
      for (const name of Object.keys(renderer.locations)) {
        renderer.locations[name] = gl.getUniformLocation(prog, name);
      }
      renderer.opticsLocations = [];
      for (let i = 0; i < gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS); i += 1) {
        const info = gl.getActiveUniform(prog, i);
        if (!/^(bg_|hl_|edge_)/.test(info.name)) continue;
        renderer.opticsLocations.push({
          name: info.name.replace(/\[0\]$/, ''),
          type: info.type,
          location: gl.getUniformLocation(prog, info.name),
        });
      }
      renderer.rectanglesLocation = gl.getUniformLocation(prog, 'u_rectangles');
      renderer.rectangleParamsLocation = gl.getUniformLocation(prog, 'u_rectangleParams');
      renderer.backgroundLocation = gl.getUniformLocation(prog, 'u_background');

      loc = {
        iconSdf: gl.getUniformLocation(prog, 'u_iconSdf'),
        helloSegTex: gl.getUniformLocation(prog, 'u_helloSegTex'),
        helloChunkTex: gl.getUniformLocation(prog, 'u_helloChunkTex'),
        helloMetaTex: gl.getUniformLocation(prog, 'u_helloMetaTex'),
        iconRect: gl.getUniformLocation(prog, 'u_iconRect'),
        helloRect: gl.getUniformLocation(prog, 'u_helloRect'),
        activeSegs: gl.getUniformLocation(prog, 'u_activeSegs'),
        strokeRadius: gl.getUniformLocation(prog, 'u_strokeRadius'),
        dotCenter: gl.getUniformLocation(prog, 'u_dotCenter'),
        dotRadius: gl.getUniformLocation(prog, 'u_dotRadius'),
        morphT: gl.getUniformLocation(prog, 'u_morphT'),
        iconScale: gl.getUniformLocation(prog, 'u_iconScale'),
        iconDilate: gl.getUniformLocation(prog, 'u_iconDilate'),
        showHello: gl.getUniformLocation(prog, 'u_showHello'),
        camFocus: gl.getUniformLocation(prog, 'u_camFocus'),
        camCenter: gl.getUniformLocation(prog, 'u_camCenter'),
        camScale: gl.getUniformLocation(prog, 'u_camScale'),
      };

      helloSegTex = createDataTexture(gl);
      helloChunkTex = createDataTexture(gl);
      helloMetaTex = createDataTexture(gl);
      return true;
    } catch {
      renderer = null;
      gl = null;
      return false;
    }
  })();

  if (!webglReady) {
    canvas.remove();
    const fallbackWrap = document.createElement('div');
    fallbackWrap.className = 'hello-screen__fallback';
    const fallbackSvg = document.createElementNS(HELLO_SVG_NS, 'svg');
    fallbackSvg.setAttribute('viewBox', `0 0 ${HELLO_VB_W} ${HELLO_VB_H}`);
    fallbackSvg.classList.add('hello-screen__fallback-svg');
    const fallbackPath = document.createElementNS(HELLO_SVG_NS, 'path');
    fallbackPath.setAttribute('d', HELLO_PATH_D);
    fallbackPath.setAttribute('transform', `translate(${HELLO_TX} ${HELLO_TY})`);
    fallbackPath.classList.add('hello-screen__fallback-path');
    fallbackSvg.append(fallbackPath);
    fallbackWrap.append(fallbackSvg);
    root.prepend(fallbackWrap);
  }

  function resizeCanvases() {
    if (!renderer) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(window.innerWidth * dpr));
    const h = Math.max(1, Math.round(window.innerHeight * dpr));
    renderer.resize(w, h);
    const cw = Math.max(1, Math.round(window.innerWidth));
    const ch = Math.max(1, Math.round(window.innerHeight));
    if (bgCaptureCanvas.width !== cw || bgCaptureCanvas.height !== ch) {
      bgCaptureCanvas.width = cw;
      bgCaptureCanvas.height = ch;
    }
    lastBgKey = '';
    lastLayoutKey = '';
    helloSettled = false;
    buttonGlass?.requestDraw();
  }

  function captureLiveBackdrop(elapsed) {
    if (!renderer || !bgCaptureCtx) return;
    const cw = bgCaptureCanvas.width;
    const ch = bgCaptureCanvas.height;
    if (!cw || !ch) return;

    const fadeRaw = reducedMotion
      ? Math.min(1, Math.max(0, (elapsed - 0.2) / 0.2))
      : Math.min(1, Math.max(0, (elapsed - BACKDROP_FADE_DELAY) / BACKDROP_FADE_DUR));
    const backdropAlpha = easeBackdropFade(fadeRaw);

    // Keep the visible .backdrop canvas and Solarium's refracted backdrop capture
    // driven by this exact same per-frame alpha so they can never drift out of sync.
    if (backdropCanvas?.isConnected) {
      backdropCanvas.style.opacity = backdropAlpha <= 0.0005
        ? '0'
        : backdropAlpha >= 0.9995
          ? '1'
          : backdropAlpha.toFixed(4);
    }

    const playing = Boolean(isBackdropPlaying());
    const justStopped = prevBackdropPlaying && !playing;
    prevBackdropPlaying = playing;

    const bgKey = `${cw}x${ch}:${Math.round(backdropAlpha * 1000)}`;
    const needsCapture = !renderer.hasBackground || playing || justStopped || lastBgKey !== bgKey;
    if (!needsCapture) return;

    bgCaptureCtx.globalAlpha = 1;
    bgCaptureCtx.fillStyle = '#000';
    bgCaptureCtx.fillRect(0, 0, cw, ch);

    if (backdropAlpha > 0.001 && backdropCanvas?.isConnected &&
        backdropCanvas.width > 0 && backdropCanvas.height > 0) {
      const rect = backdropCanvas.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        const sx = cw / Math.max(1, window.innerWidth);
        const sy = ch / Math.max(1, window.innerHeight);
        bgCaptureCtx.save();
        bgCaptureCtx.globalAlpha = backdropAlpha;
        bgCaptureCtx.drawImage(
          backdropCanvas,
          rect.left * sx,
          rect.top * sy,
          rect.width * sx,
          rect.height * sy,
        );
        bgCaptureCtx.restore();
      }
    }

    renderer.setBackground(bgCaptureCanvas);
    lastBgKey = bgKey;
  }

  function uploadHelloGeometry(helloRect, scribbleElapsed) {
    const key = helloRect.join(',');
    const layoutChanged = key !== lastLayoutKey;
    const [rx, ry, rw, rh] = helloRect;

    if (layoutChanged) {
      lastLayoutKey = key;
      helloSettled = false;
      for (let i = 0; i <= SEG_COUNT; i += 1) {
        baseVertsX[i] = rx + curve.normPts[i * 2 + 0] * rw;
        baseVertsY[i] = ry + curve.normPts[i * 2 + 1] * rh;
      }
    }

    const bounceActive = !reducedMotion &&
      scribbleElapsed > 0 && scribbleElapsed < SCRIBBLE_DUR + BOUNCE_SETTLE;
    if (!layoutChanged && !bounceActive && helloSettled) return;

    const swayAmpPx = (15.5 / HELLO_VB_W) * rw;
    if (bounceActive) {
      helloSettled = false;
      for (let i = 0; i <= SEG_COUNT; i += 1) {
        const age = scribbleElapsed - curve.vertexBirthSec[i];
        if (age > 0 && age < BOUNCE_SETTLE) {
          const startRamp = Math.min(1, i / 12);
          const sway = startRamp * swayAmpPx * Math.exp(-age * 5.2) * Math.sin(age * 17.0);
          curVertsX[i] = baseVertsX[i] + curve.bounceDirX[i] * sway;
          curVertsY[i] = baseVertsY[i] + curve.bounceDirY[i] * sway;
          curRadScale[i] = 1.0 + startRamp * 0.34 * Math.exp(-age * 6.0) * Math.sin(age * 19.5);
        } else {
          curVertsX[i] = baseVertsX[i];
          curVertsY[i] = baseVertsY[i];
          curRadScale[i] = 1.0;
        }
      }
    } else {
      for (let i = 0; i <= SEG_COUNT; i += 1) {
        curVertsX[i] = baseVertsX[i];
        curVertsY[i] = baseVertsY[i];
        curRadScale[i] = 1.0;
      }
      helloSettled = true;
    }

    for (let i = 0; i < SEG_COUNT; i += 1) {
      segData[i * 4 + 0] = curVertsX[i];
      segData[i * 4 + 1] = curVertsY[i];
      segData[i * 4 + 2] = curVertsX[i + 1];
      segData[i * 4 + 3] = curVertsY[i + 1];
      metaData[i * 4 + 0] = curRadScale[i];
      metaData[i * 4 + 1] = curRadScale[i + 1];
    }

    for (let c = 0; c < CHUNK_COUNT; c += 1) {
      let minX = 1e9;
      let minY = 1e9;
      let maxX = -1e9;
      let maxY = -1e9;
      for (let j = 0; j < CHUNK_SIZE; j += 1) {
        const idx = (c * CHUNK_SIZE + j) * 4;
        const ax = segData[idx];
        const ay = segData[idx + 1];
        const bx = segData[idx + 2];
        const by = segData[idx + 3];
        minX = Math.min(minX, ax, bx);
        minY = Math.min(minY, ay, by);
        maxX = Math.max(maxX, ax, bx);
        maxY = Math.max(maxY, ay, by);
      }
      chunkData[c * 4 + 0] = minX;
      chunkData[c * 4 + 1] = minY;
      chunkData[c * 4 + 2] = maxX;
      chunkData[c * 4 + 3] = maxY;
    }

    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    if (!helloTexturesAllocated) {
      gl.bindTexture(gl.TEXTURE_2D, helloSegTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, SEG_COUNT, 1, 0, gl.RGBA, gl.FLOAT, segData);
      gl.bindTexture(gl.TEXTURE_2D, helloChunkTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, CHUNK_COUNT, 1, 0, gl.RGBA, gl.FLOAT, chunkData);
      gl.bindTexture(gl.TEXTURE_2D, helloMetaTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, SEG_COUNT, 1, 0, gl.RGBA, gl.FLOAT, metaData);
      helloTexturesAllocated = true;
    } else {
      gl.bindTexture(gl.TEXTURE_2D, helloSegTex);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, SEG_COUNT, 1, gl.RGBA, gl.FLOAT, segData);
      gl.bindTexture(gl.TEXTURE_2D, helloChunkTex);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, CHUNK_COUNT, 1, gl.RGBA, gl.FLOAT, chunkData);
      gl.bindTexture(gl.TEXTURE_2D, helloMetaTex);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, SEG_COUNT, 1, gl.RGBA, gl.FLOAT, metaData);
    }
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
  }

  function revealGetStartedButton() {
    if (buttonVisible || disposed || dismissing) return;
    buttonVisible = true;
    footer.classList.add('is-visible');
    button.focus({ preventScroll: true });

    if (LiquidGlassRenderer.isSupported()) {
      try {
        const material = buildGetStartedGlassMaterial();
        buttonGlass = new LiquidGlassView(material, {
          source: backdropCanvas?.isConnected ? backdropCanvas : null,
          sourceBounds: () => backdropCanvas.getBoundingClientRect(),
          cornerRadius: 23,
          interactive: true,
          pressTransformTarget: button,
          pressScaleAmount: 0.06,
        });
        if (buttonGlass.renderer) {
          button.classList.add('is-solarium-glass');
        }
        buttonGlass.element.className = 'hello-get-started__glass';
        Object.assign(buttonGlass.element.style, {
          position: 'absolute',
          inset: '0',
          zIndex: '0',
          pointerEvents: 'none',
        });
        buttonGlass.element.setAttribute('aria-hidden', 'true');
        button.prepend(buttonGlass.element);
        buttonGlass.requestDraw();
        requestAnimationFrame(() => buttonGlass?.requestDraw());
      } catch {
        buttonGlass = null;
      }
    }
  }

  function renderFrame(now) {
    if (disposed) return;
    if (!renderer || !iconSdf) {
      rafId = requestAnimationFrame(renderFrame);
      return;
    }

    // Frame 1 (warmupFrames === 0): draw at elapsed = 0 so the GPU compiles the
    // WebGL/Metal pipeline without eating into the 0.8s backdrop delay.
    // Frame 2 (warmupFrames === 1): pipeline is warm; latch startTime = now.
    let elapsed = 0;
    if (warmupFrames === 0) {
      warmupFrames = 1;
    } else if (warmupFrames === 1) {
      warmupFrames = 2;
      startTime = now;
    } else {
      elapsed = Math.max(0, (now - startTime) * 0.001);
    }

    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    const viewW = window.innerWidth;
    const viewH = window.innerHeight;
    const iconSize = Math.min(260, Math.min(viewW, viewH) * 0.36);
    const centerX = viewW * 0.5;
    const centerY = viewH * 0.5 - 12;
    const iconRect = [centerX - iconSize * 0.5, centerY - iconSize * 0.5, iconSize, iconSize];

    const helloW = Math.min(720, viewW * 0.78, viewH * 1.35);
    const helloH = helloW * (HELLO_VB_H / HELLO_VB_W);
    const helloRect = [centerX - helloW * 0.5, centerY - helloH * 0.5, helloW, helloH];

    const baseStrokeRadius = (27.5 / HELLO_VB_W) * helloW;
    const scribbleElapsed = reducedMotion ? SCRIBBLE_DUR + BOUNCE_SETTLE : elapsed - SCRIBBLE_START;
    uploadHelloGeometry(helloRect, scribbleElapsed);

    const wordCX = helloRect[0] + helloRect[2] * 0.5;
    const wordCY = helloRect[1] + helloRect[3] * 0.5;
    const startPenX = baseVertsX[0];
    const startPenY = baseVertsY[0];

    let morphT = 0;
    let iconScale = 1;
    let iconDilate = 0;
    let activeSegs = 0;
    let showHello = 0;
    let camScale = START_SCALE;
    let focusX = startPenX;
    let focusY = startPenY;

    if (reducedMotion) {
      morphT = 1;
      showHello = 1;
      iconScale = 0.08;
      activeSegs = SEG_COUNT;
      camScale = 1;
      focusX = wordCX;
      focusY = wordCY;
      if (elapsed >= 0.45) revealGetStartedButton();
    } else {
      if (elapsed < MORPH_START) {
        const introT = Math.min(1, Math.max(0, elapsed / 0.65));
        iconScale = 0.94 + 0.06 * easeIntro(introT);
      } else if (elapsed < MORPH_END) {
        const mt = (elapsed - MORPH_START) / MORPH_DUR;
        const m = easeIconMorph(mt);
        morphT = mt;
        iconScale = 1.0 - 0.92 * m;
        iconDilate = 5.5 * Math.sin(Math.PI * Math.min(1, mt * 1.15));
      } else {
        morphT = 1;
        showHello = 1;
        iconScale = 0.08;

        const scribbleRaw = Math.min(1, Math.max(0, scribbleElapsed / SCRIBBLE_DUR));
        const scribblePaced = easeScribble(scribbleRaw);
        activeSegs = segsAtProgress(scribblePaced);

        const pullRaw = Math.min(1, Math.max(0, (elapsed - CAM_START) / CAM_DUR));
        const cameraU = easeCameraPull(pullRaw);
        const zStart = 1 / START_SCALE;
        const z = zStart + (1.0 - zStart) * cameraU;
        camScale = 1 / z;
        focusX = startPenX - (startPenX - wordCX) * cameraU * z;
        focusY = startPenY - (startPenY - wordCY) * cameraU * z;

        if (elapsed >= BUTTON_REVEAL_AT) {
          revealGetStartedButton();
        }
      }
    }

    const settleElapsed = Math.max(0, elapsed - 2.55);
    const dropletPulse = !reducedMotion && elapsed >= 2.55
      ? 1.0 + 0.065 * Math.exp(-settleElapsed * 7.5) * Math.sin(settleElapsed * 14.5)
      : 1.0;

    const dotGrowRaw = Math.min(1, Math.max(0, ((elapsed - MORPH_START) / MORPH_DUR - 0.14) / 0.72));
    const effectiveStrokeRadius = baseStrokeRadius * dropletPulse;
    const dotRadius = effectiveStrokeRadius * START_SCALE * easeDotGrow(dotGrowRaw);
    const strokeRadiusCss = effectiveStrokeRadius * camScale;

    const iconOpticalRadius = iconSize * 0.055;
    const morphOpticalT = reducedMotion
      ? 1
      : Math.min(1, Math.max(0, (elapsed - MORPH_START) / MORPH_DUR));
    const opticalRadius = iconOpticalRadius +
      (strokeRadiusCss - iconOpticalRadius) * easeIconMorph(morphOpticalT);

    const lightSweep = reducedMotion
      ? 0
      : Math.sin(Math.min(elapsed, 7.2) * 0.85 - 0.8) * 0.22;

    captureLiveBackdrop(elapsed);

    const material = buildHelloGlassMaterial(opticalRadius, viewH, lightSweep);
    const uniforms = {
      ...material.uniforms,
      resolution: [canvas.width, canvas.height],
      contentsScale: dpr,
      touchPoint: [centerX, centerY],
      pressGlow: 0,
      pressProgress: 0,
      pressStretch: [0, 0],
      pressInflate: 0,
      cornerRadius: 40,
      shapeMergeSmoothness: 0.0001,
      optics: material.resolveOptics(false, {
        width: viewW,
        height: viewH,
        sourceWidth: renderer.backgroundWidth,
        sourceHeight: renderer.backgroundHeight,
      }),
      materialTint: material.resolveTint(false),
      backdropTone: material.resolveBackdropTone(false),
      rectangles: [{ x: 0, y: 0, width: viewW, height: viewH, radius: 0, opacity: 1 }],
    };

    gl.useProgram(renderer.program);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, iconSdf.tex);
    gl.uniform1i(loc.iconSdf, 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, helloSegTex);
    gl.uniform1i(loc.helloSegTex, 2);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, helloChunkTex);
    gl.uniform1i(loc.helloChunkTex, 3);
    gl.activeTexture(gl.TEXTURE4);
    gl.bindTexture(gl.TEXTURE_2D, helloMetaTex);
    gl.uniform1i(loc.helloMetaTex, 4);

    gl.uniform4f(loc.iconRect, iconRect[0], iconRect[1], iconRect[2], iconRect[3]);
    gl.uniform4f(loc.helloRect, helloRect[0], helloRect[1], helloRect[2], helloRect[3]);
    gl.uniform1f(loc.activeSegs, activeSegs);
    gl.uniform1f(loc.strokeRadius, effectiveStrokeRadius);
    gl.uniform2f(loc.camFocus, focusX, focusY);
    gl.uniform2f(loc.camCenter, centerX, centerY);
    gl.uniform1f(loc.camScale, camScale);
    gl.uniform2f(loc.dotCenter, centerX, centerY);
    gl.uniform1f(loc.dotRadius, dotRadius);
    gl.uniform1f(loc.morphT, morphT);
    gl.uniform1f(loc.iconScale, iconScale);
    gl.uniform1f(loc.iconDilate, iconDilate);
    gl.uniform1f(loc.showHello, showHello);

    const blurSigma = material.backgroundTextureBlurRadius *
      material.backgroundTextureScaleCoefficient * dpr;
    renderer.draw(uniforms, blurSigma);

    if (buttonGlass && (isBackdropPlaying() || elapsed < BUTTON_REVEAL_AT + 1.0)) {
      buttonGlass.requestDraw();
    }

    rafId = requestAnimationFrame(renderFrame);
  }

  function destroy() {
    if (disposed) return;
    disposed = true;
    cancelAnimationFrame(rafId);
    clearTimeout(fallbackRevealTimer);
    window.removeEventListener('resize', resizeCanvases);
    window.removeEventListener('keydown', onKeyDown);
    buttonGlass?.dispose();
    buttonGlass = null;
    setup?.destroy();
    if (gl) {
      if (iconSdf?.tex) gl.deleteTexture(iconSdf.tex);
      if (helloSegTex) gl.deleteTexture(helloSegTex);
      if (helloChunkTex) gl.deleteTexture(helloChunkTex);
      if (helloMetaTex) gl.deleteTexture(helloMetaTex);
      if (renderer?.program) gl.deleteProgram(renderer.program);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
    renderer = null;
    gl = null;
    if (backdropCanvas?.isConnected) {
      backdropCanvas.style.opacity = '';
    }
    document.body.classList.remove('is-hello-fallback-fade');
    root.remove();
  }

  async function dismiss() {
    if (dismissing || disposed) return;
    dismissing = true;
    root.inert = true;
    if (backdropCanvas?.isConnected) backdropCanvas.style.opacity = '';
    document.body.classList.remove('is-hello-fallback-fade');
    const reveal = onDismiss();
    const exit = root.animate(reducedMotion
      ? [{ opacity: 1 }, { opacity: 0 }]
      : [{ opacity: 1, transform: 'none', filter: 'blur(0px)' },
        { opacity: 0, transform: 'scale(1.09)', filter: 'blur(16px)' }],
    { duration: reducedMotion ? 180 : 620, easing: 'cubic-bezier(.4,0,.2,1)', fill: 'forwards' });
    await Promise.allSettled([exit.finished, reveal]);
    exit.cancel();
    destroy();
  }

  function beginSetup() {
    if (settingUp || dismissing || disposed || !buttonVisible) return;
    settingUp = true;
    cancelAnimationFrame(rafId);
    buttonGlass?.dispose();
    buttonGlass = null;
    footer.inert = true;
    root.classList.add('is-setting-up');
    setup = createSetupFlow({
      initialSettings,
      backdropCanvas: backdropCanvas?.isConnected ? backdropCanvas : null,
      isBackdropPlaying,
      onComplete: async settings => {
        await onSetupComplete(settings);
        if (!disposed) await dismiss();
      },
    });
    root.append(setup.element);
    setup.focus();
  }

  function onKeyDown(event) {
    if (dismissing || disposed) return;
    if (event.key === 'Tab') {
      const controls = [...root.querySelectorAll('button:not(:disabled), input:checked')]
        .filter(el => !el.closest('[inert]') && el.getClientRects().length);
      if (!controls.length) { event.preventDefault(); return; }
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && (document.activeElement === first || !controls.includes(document.activeElement))) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !controls.includes(document.activeElement))) {
        event.preventDefault(); first.focus();
      }
    }
    // Let native radio and button keyboard behavior handle the setup screens.
    if (!settingUp && buttonVisible && (event.key === 'Enter' || event.key === ' ') && event.target !== button) {
      event.preventDefault();
      beginSetup();
    }
  }

  button.addEventListener('click', beginSetup);
  window.addEventListener('resize', resizeCanvases);
  window.addEventListener('keydown', onKeyDown);

  let iconReadyPromise = null;
  if (webglReady && gl) {
    resizeCanvases();
    iconReadyPromise = buildIconSdfTexture(gl, ICON_SVG_URL, 512)
      .then(result => {
        if (disposed) {
          gl?.deleteTexture(result.tex);
          return;
        }
        iconSdf = result;
      })
      .catch(() => {
        if (!disposed) {
          revealGetStartedButton();
        }
      });
  }

  function start() {
    if (started || disposed) return;
    started = true;
    startTime = 0;
    warmupFrames = 0;
    if (backdropCanvas?.isConnected) {
      backdropCanvas.style.opacity = '0';
    }
    if (webglReady) {
      resizeCanvases();
      rafId = requestAnimationFrame(renderFrame);
    } else {
      if (backdropCanvas?.isConnected) {
        backdropCanvas.style.opacity = '';
      }
      document.body.classList.add('is-hello-fallback-fade');
      fallbackRevealTimer = window.setTimeout(
        revealGetStartedButton,
        reducedMotion ? 350 : 1400,
      );
    }
  }

  return {
    element: root,
    ready: iconReadyPromise || Promise.resolve(),
    start,
    dismiss,
    destroy,
  };
}
