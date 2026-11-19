// GLSL ES translations of the embedded runtime glass stages. Child image
// shaders become explicit texture lookups; the analytic field remains shared.
// The target is an SDR, premultiplied WebGL canvas, so output headroom is one.

export const CORNER_FIELD = `

float saturateExact(float value) { return clamp(value, 0.0, 1.0); }

// The polynomial eases each corner into its straight edges without the
// flattened diagonal produced by a generic superellipse distance estimate.
vec3 continuousCornerField(vec2 q, vec2 shapeHalfExtent, float equalCornerRadius,
             vec2 continuousCorner) {
  vec2 a = abs(q);
  const float K = 1.5286649465560913;
  const float C1 = 0.9260540008544922;
  const float C2 = 3.1560099124908447;
  const float C3 = -3.6412200927734375;
  const float C4 = 1.268030047416687;
  const float C5 = 0.2685309946537018;
  const float C6 = -0.5286650061607361;
  const float C7 = 0.6541655659675598;
  const float C8 = 0.3458344340324402;

  float rho = abs(equalCornerRadius);
  float r0 = rho * K;
  float rc = mix(r0, rho, max(continuousCorner.x, continuousCorner.y));
  vec2 d = a - shapeHalfExtent;
  vec2 cq = d + rc;

  vec2 uv = abs(max(vec2(0.0), (d + r0) / r0));
  float uvLength = length(uv);
  float maximum = max(uv.x, uv.y);
  float minimum = min(uv.x, uv.y);
  float t = maximum == 0.0 ? 0.0 : saturateExact(minimum / maximum);
  float polynomial = C2 - C1 * t;
  polynomial = polynomial * t + C3;
  polynomial = polynomial * t + C4;
  polynomial = polynomial * t + C5;
  float denominator = 1.0 - t * t * saturateExact(uvLength) * polynomial;
  float d0 = uvLength + 1.0 - 1.0 / denominator;

  vec2 v = max(vec2(0.0), K * uv + C6);
  float d1 = C7 * length(v) + C8;
  float dx = mix(d0, d1, continuousCorner.x);
  float dy = mix(d0, d1, continuousCorner.y);
  float direction = uv.y > uv.x ? 1.0 : -1.0;
  float alpha = saturateExact(0.5 - direction + direction * t);
  float dn = float(mix(dx, dy, alpha) - 1.0);

  vec2 gp = max(vec2(0.0), cq);
  float gpLength = length(gp);
  vec2 gradient;
  if (gpLength > 0.0) {
    gradient = vec2(gp / gpLength);
  } else {
    gradient = cq.x > cq.y ? vec2(1.0, 0.0)
               : vec2(0.0, 1.0);
  }
  float distance = float(min(max(cq.x, cq.y), 0.0)) + float(r0 * float(dn));
  vec2 signedGradient = gradient * vec2(
    q.x >= 0.0 ? float(1.0) : float(-1.0),
    q.y >= 0.0 ? float(1.0) : float(-1.0));

  return vec3(distance, signedGradient);
}
`;

export const BACKDROP_STAGE = `
uniform float bg_u_lastMip;
uniform vec2 bg_u_sourceExtent;
uniform vec4 bg_u_backdropMap0;
uniform vec2 bg_u_backdropMap1;
uniform vec4 bg_u_sdfMap0;
uniform vec2 bg_u_sdfMap1;
uniform float bg_u_sdfDistanceScale;

uniform vec2 bg_u_sdfExtent;
uniform vec4 bg_displacementMat;
uniform float bg_innerRefractionAmount, bg_innerRefractionInverseHeight;
uniform float bg_outerRefractionAmount, bg_outerRefractionInverseHeight;
uniform float bg_refractionThreshold0, bg_refractionThreshold1;
uniform float bg_blurRadius, bg_edgeBleedBlurRadius, bg_edgeBleedAmount;
uniform float bg_edgeBleedInverseHeight, bg_shadowAmount, bg_shadowInverseHeight;
uniform vec2 bg_shadowOffset;
uniform float bg_shadowBlurRadius, bg_shadowInverseRadius;
uniform vec4 bg_faceCM[3]; uniform vec4 bg_bleedCM[3]; uniform vec4 bg_shadowCM[3];
uniform float bg_shadowContribution, bg_shadowFaceOpacity;
uniform vec4 bg_blurAlpha, bg_blurDistance;
uniform vec2 bg_edgeBleedDistance;
uniform float bg_edgeBleedOpacity, bg_faceOpacity;
uniform vec2 bg_bleedDarken;
uniform float bg_shadowDistanceOffset, bg_shadowOpacity, bg_refractionOpacity;
uniform float bg_holdingToneOpacity, bg_sdrShadowDistance0, bg_sdrShadowInverse;
uniform vec2 bg_ringShadowOffset;
uniform float bg_ringShadowStrokeWidth, bg_ringShadowRadius, bg_ringShadowOpacity, bg_ringShadowMask;
uniform vec2 bg_keyFillHighlightDirection;
uniform float bg_keyFillHighlightHeight, bg_keyFillHighlightSpread;
uniform float bg_keyFillHighlightAmount, bg_keyFillHighlightEffectOffset;
uniform float bg_keyFillHighlightColorBias;
uniform float bg_blurFillBlurRadius, bg_blurFillLightenOpacity;
uniform float bg_blurFillDarkenOpacity, bg_blurFillNormalOpacity;
uniform float bg_aberrationAmount;
uniform vec2 bg_aberrationDirection;
uniform float bg_inverseAberrationHeight, bg_aberrationOffset;
uniform float bg_sdrWhiteValue, bg_clampLimit, bg_faceMaxLumaComplement;
uniform float bg_preserveHue, bg_blurFillEnabled, bg_strokeMode;
uniform float bg_highlightExtension, bg_wantsHighlightBiasCorrection;
uniform float bg_hasChromaticAberration, bg_hasOuterRefraction, bg_hasEdgeBleed;
uniform float bg_edrScale;

vec2 bg_mapPoint(vec2 p, vec4 a, vec2 b) {
  return vec2(dot(p, a.xy) + b.x, dot(p, a.zw) + b.y);
}
float bg_lodForRadius(float radius) {
  float q = radius < 2.0 ? 1.0 + 0.5 * radius : radius;
  return max(0.0, log2(max(q, 1e-6)));
}
// Coincident stops encode a hard step. Avoid dividing zero by zero because
// a NaN LOD can turn an otherwise valid face sample black on some backends.
float bg_blurStopRamp(float value, float lower, float upper) {
  float span = upper - lower;
  if (abs(span) <= 1e-6) return value < upper ? 0.0 : 1.0;
  return saturate((value - lower) / span);
}
vec3 bg_blurStopWeights(float value) {
  return vec3(
    bg_blurStopRamp(value, bg_blurDistance.x, bg_blurDistance.y),
    bg_blurStopRamp(value, bg_blurDistance.y, bg_blurDistance.z),
    bg_blurStopRamp(value, bg_blurDistance.z, bg_blurDistance.w));
}
vec4 bg_samplePyramidLOD(vec2 p, float lod) {
  return textureLod(u_background, p/bg_u_sourceExtent, clamp(lod, 0.0, bg_u_lastMip));
}
vec4 bg_sampleSourceLOD(vec2 p, float semanticLOD) {
  return bg_samplePyramidLOD(p, semanticLOD);
}
vec4 bg_sampleDiamond(vec2 p, float radius) {
  float lod = bg_lodForRadius(radius);
  vec2 d = vec2(0.25 * lod);
  return 0.25 * (bg_sampleSourceLOD(p + vec2( d.x, d.y), lod) +
         bg_sampleSourceLOD(p + vec2( d.x,-d.y), lod) +
         bg_sampleSourceLOD(p + vec2(-d.x, d.y), lod) +
         bg_sampleSourceLOD(p + vec2(-d.x,-d.y), lod));
}
vec4 bg_sampleAtRadius(vec2 p,float radius) {
  return bg_sampleSourceLOD(p,bg_lodForRadius(radius));
}
vec3 bg_straight(vec4 pma) {
  vec3 rgb = pma.rgb;
  rgb.x = abs(rgb.x) < 1e-6 ? 0.0 : rgb.x;
  rgb.y = abs(rgb.y) < 1e-6 ? 0.0 : rgb.y;
  rgb.z = abs(rgb.z) < 1e-6 ? 0.0 : rgb.z;
  return rgb / max(pma.a, 1e-6);
}
vec3 bg_faceAffine(vec3 c) {
  return vec3(dot(c,bg_faceCM[0].xyz)+bg_faceCM[0].w,
         dot(c,bg_faceCM[1].xyz)+bg_faceCM[1].w,
         dot(c,bg_faceCM[2].xyz)+bg_faceCM[2].w);
}
vec3 bg_bleedAffine(vec3 c) {
  return vec3(dot(c,bg_bleedCM[0].xyz)+bg_bleedCM[0].w,
         dot(c,bg_bleedCM[1].xyz)+bg_bleedCM[1].w,
         dot(c,bg_bleedCM[2].xyz)+bg_bleedCM[2].w);
}
vec2 bg_displacedGradient(vec2 g) {
  return vec2(dot(g, bg_displacementMat.xy), dot(g, bg_displacementMat.zw))
     * bg_u_sourceExtent;
}
vec2 bg_directionalGradient(vec2 g,vec2 dir,bool swapResult) {
  vec2 a=bg_displacementMat.xy,b=bg_displacementMat.zw;
  vec2 ra=vec2(dot(a,dir),dir.x*a.y-dir.y*a.x);
  vec2 rb=vec2(dot(b,dir),dir.x*b.y-dir.y*b.x);
  vec2 v=vec2(dot(ra,g),dot(rb,g));
  return (swapResult?v.yx:v)*bg_u_sourceExtent;
}
float bg_refractionCurve(float distance, float amount, float inverseHeight,
           float offset) {
  float h = saturate((-distance - offset) * inverseHeight);
  return amount * (1.0 - saturate(sqrt(h * (2.0 - h))));
}
// Accumulate straight spectral channels, average the seven coverage values,
// then premultiply once. Averaging already-premultiplied RGB darkens fringes.
vec4 bg_aberrate(vec2 center, vec2 delta, float radius) {
  vec4 acc = vec4(0.0);
  float alpha = 0.0;
  vec4 s = bg_sampleDiamond(center + delta, radius);
  vec3 c = bg_straight(s); acc.r += c.r; alpha += s.a;
  s = bg_sampleDiamond(center + delta * (2.0/3.0), radius); c = bg_straight(s);
  acc.r += c.r*(2.0/3.0); acc.g += c.g*(1.0/3.0); alpha += s.a;
  s = bg_sampleDiamond(center + delta * (1.0/3.0), radius); c = bg_straight(s);
  acc.r += c.r*(1.0/3.0); acc.g += c.g*(2.0/3.0); alpha += s.a;
  s = bg_sampleDiamond(center, radius); c = bg_straight(s); acc.g += c.g; alpha += s.a;
  s = bg_sampleDiamond(center - delta * (1.0/3.0), radius); c = bg_straight(s);
  acc.g += c.g*(2.0/3.0); acc.b += c.b*(1.0/3.0); alpha += s.a;
  s = bg_sampleDiamond(center - delta * (2.0/3.0), radius); c = bg_straight(s);
  acc.g += c.g*(1.0/3.0); acc.b += c.b*(2.0/3.0); alpha += s.a;
  s = bg_sampleDiamond(center - delta, radius); c = bg_straight(s);
  acc.b += c.b; alpha += s.a;
  float a = alpha / 7.0;
  return vec4(acc.rgb * vec3(0.5, 1.0/3.0, 0.5) * a, a);
}
float bg_cdfCurve(float t) {
  float x = saturate(0.25*t + 0.5);
  float z = 4.0*x - 2.0;
  return (((0.002954483*z*z - 0.034454346)*z*z
      + 0.16821289)*z*z - 0.560546875)*z + 0.5;
}
vec4 bg_sourceOver(vec4 source, vec4 destination) {
  return source + destination * (1.0 - source.a);
}
vec3 bg_lumaComplement(vec3 rgb) {
  if (bg_faceMaxLumaComplement <= 0.0) return rgb;
  float l = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
  float a = saturate(1.0 - l * bg_faceMaxLumaComplement);
  return mix(vec3(a*l), a*rgb, vec3(1.0 + 0.3*(1.0-a)));
}

float bg_sdfPixelWidth(vec2 gradient, vec4 outputToSDF) {
  float ddx = gradient.x * outputToSDF.x +
        gradient.y * outputToSDF.z;
  float ddy = gradient.x * outputToSDF.y +
        gradient.y * outputToSDF.w;
  return max((abs(ddx) + abs(ddy)) * bg_u_sdfDistanceScale, 1e-4);
}

vec4 bg_main(vec2 p) {
  vec2 backdropP = bg_mapPoint(p, bg_u_backdropMap0, bg_u_backdropMap1);
  vec2 sdfP = bg_mapPoint(p, bg_u_sdfMap0, bg_u_sdfMap1);
  vec4 field = vec4(glassField(sdfP));
  float distance = field.r;
  vec2 gradient = field.gb;
  float fw = bg_sdfPixelWidth(gradient, bg_u_sdfMap0);
  float coverage = saturate(0.5 - distance/fw) * field.a;

  float highlight = 0.0;
  if (bg_keyFillHighlightHeight > 0.0) {
    float x = distance + bg_keyFillHighlightEffectOffset;
    float halfAA = 0.5*fw;
    bool excluded = x >= halfAA;
    excluded = excluded || (bg_strokeMode != 0.0 ? coverage >= 1.0
                         : bg_keyFillHighlightHeight+halfAA <= -x);
    if (!excluded && field.a != 0.0) {
      float invH = 1.0/bg_keyFillHighlightHeight;
      float invAA = 1.0/fw;
      float edgeGain = 1.0;
      float edgeMask = 1.0-coverage;
      if (bg_strokeMode == 0.0) {
        float v = 1.0-saturate(-x*invH);
        edgeGain = mix(v != 0.0 ? 1.0 : 0.0, v, 0.75);
        edgeMask = saturate(
          (x+bg_keyFillHighlightHeight)*invAA+0.5);
      }
      float spatial = edgeGain*field.a*edgeMask*
              saturate(0.5-x*invAA);
      float spreadDenom = max(1.0-bg_keyFillHighlightSpread, 1e-6);
      float directional = dot(bg_keyFillHighlightDirection, gradient);
      vec2 lobes = saturate((vec2(directional,-directional)
                  - bg_keyFillHighlightSpread)/spreadDenom);
      lobes *= spatial;
      lobes /= max(vec2(1e-6),
            1.0 + bg_keyFillHighlightAmount*(1.0-lobes));
      highlight = lobes.x+lobes.y;
    }
  }

  float ringAlpha = 0.0;
  if (bg_ringShadowOpacity > 0.0 &&
    (coverage > 0.0 || bg_ringShadowMask < 1.0)) {
    vec4 ringField = vec4(
      glassField(sdfP + bg_ringShadowOffset * bg_u_sdfExtent));
    float radius = max(bg_ringShadowRadius, 1e-6);
    float x = ringField.r/radius;
    float stroke = bg_ringShadowStrokeWidth/radius;
    float core = saturate(bg_cdfCurve(0.70710678*x)
              - bg_cdfCurve(0.70710678*(x+stroke)));
    ringAlpha = bg_ringShadowOpacity*ringField.a*core
         * mix(1.0, coverage, bg_ringShadowMask);
  }

  vec4 result = vec4(0.0);
  if (coverage < 1.0 && bg_shadowOpacity > 0.0) {
    vec4 sf = vec4(glassField(sdfP + bg_shadowOffset * bg_u_sdfExtent));
    float sd = sf.r;
    float shadowDisplacement = bg_refractionCurve(
      sd, bg_shadowAmount, bg_shadowInverseHeight, bg_shadowDistanceOffset);
    vec2 shadowP = backdropP + bg_displacedGradient(gradient)*shadowDisplacement;
    float shadowCoverage = bg_shadowOpacity*sf.a
              *bg_cdfCurve(sd*bg_shadowInverseRadius);
    vec3 shadowRGB;
    float shadowA;
    if (bg_shadowContribution > 1e-6) {
      vec3 sc = bg_straight(bg_sampleAtRadius(shadowP,bg_shadowBlurRadius));
      shadowRGB = vec3(dot(sc,bg_shadowCM[0].xyz),
               dot(sc,bg_shadowCM[1].xyz),
               dot(sc,bg_shadowCM[2].xyz))*bg_shadowContribution
           + vec3(bg_shadowCM[0].w,bg_shadowCM[1].w,bg_shadowCM[2].w);
      shadowA = mix(bg_shadowFaceOpacity,1.0,bg_shadowContribution);
    } else {
      shadowRGB=vec3(bg_shadowCM[0].w,bg_shadowCM[1].w,bg_shadowCM[2].w);
      shadowA=bg_shadowFaceOpacity;
    }

    result=vec4(shadowRGB,shadowA)*shadowCoverage;
  }

  if (coverage > 0.0) {
    float inner = bg_refractionCurve(distance, bg_innerRefractionAmount,
                   bg_innerRefractionInverseHeight, 0.0);
    vec2 faceP = backdropP + bg_displacedGradient(gradient)*inner;
    float adjustedDistance = distance + inner;
    vec3 w = bg_blurStopWeights(adjustedDistance);
    float radius = (bg_blurAlpha.x-dot(bg_blurAlpha.yzw,w))*bg_blurRadius;
    vec4 facePMA;
    if (bg_hasChromaticAberration != 0.0 && bg_aberrationAmount != 0.0) {
      float aberr = bg_refractionCurve(distance, bg_aberrationAmount,
                     bg_inverseAberrationHeight, bg_aberrationOffset);
      vec2 delta = bg_directionalGradient(
        gradient,bg_aberrationDirection,true)*aberr;
      facePMA = bg_aberrate(faceP, delta, radius);
    } else {

      facePMA = bg_sampleAtRadius(faceP,radius);
    }
    vec3 face = bg_straight(facePMA);

    // The face is an opaque material; the SDF supplies its final coverage.
    // Source alpha participates only in the optional outer-refraction mix.
    float faceA = 1.0;

    if (bg_blurFillEnabled != 0.0) {
      float lod = bg_lodForRadius(bg_blurFillBlurRadius);
      vec2 d = vec2(0.25*lod);

      vec3 broad = bg_straight(0.5*(bg_sampleSourceLOD(backdropP+d,lod)+
                    bg_sampleSourceLOD(backdropP-d,lod)));
      vec3 base = bg_blurFillDarkenOpacity*min(face,broad)
            + bg_blurFillLightenOpacity*max(face,broad)
            + (1.0-bg_blurFillDarkenOpacity-
             bg_blurFillLightenOpacity)*face;
      face = mix(base,broad,bg_blurFillNormalOpacity);
    }

    if (bg_hasOuterRefraction != 0.0 && bg_refractionOpacity > 0.0) {
      float outer = bg_refractionCurve(distance, bg_outerRefractionAmount,
                     bg_outerRefractionInverseHeight, 0.0);
      float outerDistance = distance + outer;
      vec3 ow = bg_blurStopWeights(outerDistance);
      float outerRadius = (bg_blurAlpha.x-dot(bg_blurAlpha.yzw,ow))*bg_blurRadius;
      vec2 outerP = backdropP + bg_displacedGradient(gradient)*outer;
      vec4 outerPMA = bg_sampleAtRadius(outerP,outerRadius);
      vec3 outerStraight = bg_straight(outerPMA);
      float t = saturate((distance-bg_refractionThreshold0) /
               (bg_refractionThreshold1-bg_refractionThreshold0));
      float outerMix=t*bg_refractionOpacity;

      face=mix(face,outerStraight,outerMix);
      faceA=mix(faceA,outerPMA.a,outerMix);
    }

    face = bg_lumaComplement(face);
    face = mix(face,bg_faceAffine(face),bg_faceOpacity);

    if (bg_hasEdgeBleed != 0.0 && bg_edgeBleedOpacity > 0.0) {
      float bleedAmount = bg_refractionCurve(distance, bg_edgeBleedAmount,
                        bg_edgeBleedInverseHeight, 0.0);
      vec2 bleedP = backdropP + bg_displacedGradient(gradient)*bleedAmount;
      vec3 bleed = bg_straight(bg_sampleAtRadius(bleedP,bg_edgeBleedBlurRadius));
      bleed=bg_bleedAffine(bleed);
      float edgeT = saturate((distance-bg_edgeBleedDistance.x) /
                 (bg_edgeBleedDistance.y-bg_edgeBleedDistance.x));
      float lum = saturate(dot(face,vec3(0.2126,0.7152,0.0722)));
      float darkBase=bg_bleedDarken.x*lum+bg_bleedDarken.y;
      float dark=darkBase*darkBase; dark*=dark;
      face = mix(face,bleed,dark*edgeT*bg_edgeBleedOpacity);
    }

    vec4 faceOut=vec4(face,faceA);
    result=mix(result,faceOut,coverage);
  }

  result = bg_sourceOver(vec4(0.0,0.0,0.0,ringAlpha),result);
  if (highlight > 1e-6) {
    float alphaComplement = 1.0-result.a;
    vec3 backdropOriginal = vec3(0.0);
    vec3 highlightRGB = result.rgb;
    if (result.a < 1.0) {
      backdropOriginal = bg_straight(bg_sampleSourceLOD(backdropP,0.0));
      vec3 transformed = bg_lumaComplement(backdropOriginal);
      transformed=bg_faceAffine(transformed);
      if (bg_wantsHighlightBiasCorrection != 0.0)
        transformed = bg_keyFillHighlightColorBias < 0.0
              ? min(transformed,backdropOriginal)
              : max(transformed,backdropOriginal);
      vec3 fill = mix(backdropOriginal,transformed,
               bg_faceOpacity*highlight);
      highlightRGB += alphaComplement*fill;
    }
    float bias = bg_keyFillHighlightColorBias*highlight;
    highlightRGB *= 1.0+bias*(3.0-2.0*highlightRGB);
    float newAlpha = result.a + alphaComplement*highlight
            *(bg_highlightExtension != 0.0 ? 1.0 : 0.0);
    result.rgb = highlightRGB-(1.0-newAlpha)*backdropOriginal;
    result.a = newAlpha;
  }
  if (bg_holdingToneOpacity > 0.0) {
    float fade=(1.0-saturate((distance-bg_sdrShadowDistance0)*bg_sdrShadowInverse))
         *bg_holdingToneOpacity;
    float a=saturate(result.a);
    vec4 target=vec4(bg_sdrWhiteValue*result.rgb*a/max(result.a,1e-6),a);
    result=mix(result,target,fade);
  }
  if (bg_clampLimit > 0.0) {
    vec3 c=result.rgb/max(result.a,1e-6);
    if (bg_preserveHue != 0.0) {
      float peak=max(c.r,max(c.g,c.b));
      if (peak>bg_clampLimit) c*=bg_clampLimit/peak;
    } else c=clamp(c,vec3(-0.75),vec3(bg_clampLimit));
    result.rgb=c*result.a;
  }
  result.rgb*=bg_edrScale;
  return vec4(result);
}
`;

export const HIGHLIGHT_STAGE = `
uniform vec4 hl_u_sdfMap0;
uniform vec2 hl_u_sdfMap1;
uniform float hl_u_sdfDistanceScale;
uniform vec2 hl_keyDirection;
uniform float hl_keyHeight, hl_keySpread, hl_keyAmount;
uniform vec4 hl_keyColor;
uniform vec2 hl_fillDirection;
uniform float hl_fillHeight, hl_fillSpread, hl_fillAmount;
uniform vec4 hl_fillColor;
uniform float hl_curvature, hl_effectOffset;
uniform float hl_diffuseKeyHeight, hl_diffuseKeySpread, hl_diffuseKeyAmount;
uniform float hl_diffuseFillHeight, hl_diffuseFillSpread, hl_diffuseFillAmount;
uniform float hl_hasDiffuse;
uniform float hl_effectiveGroupGain;
uniform float hl_groupOpacity;
uniform float hl_groupBlend;
uniform vec4 hl_groupCM[5];

vec2 hl_mapPoint(vec2 p, vec4 a, vec2 b) {
  return vec2(dot(p, a.xy) + b.x, dot(p, a.zw) + b.y);
}
float hl_nativeEpsilon() { return 0.000100016594; }
float hl_safeDenominator(float v) { return max(v, hl_nativeEpsilon()); }
float hl_correctedWeight(float hl_lobe, float amount) {
  return hl_lobe / hl_safeDenominator(1.0 + (1.0-hl_lobe)*amount);
}
// The analytic gradient and affine Jacobian give the L1 pixel footprint.
float hl_pixelWidth(vec2 normal) {

  float dx = normal.x*hl_u_sdfMap0.x + normal.y*hl_u_sdfMap0.z;
  float dy = normal.x*hl_u_sdfMap0.y + normal.y*hl_u_sdfMap0.w;
  return max((abs(dx)+abs(dy))*hl_u_sdfDistanceScale, hl_nativeEpsilon());
}
float hl_lobe(float x, float fw, vec2 normal, vec2 direction,
     float height, float spread, float curve, bool curvedProfile) {
  float radial = saturate(x/height);
  float profile = curvedProfile
    ? mix(radial < 1.0 ? 1.0 : 0.0, 1.0-radial, curve)
    : 1.0-radial;
  float band = saturate(x/fw + 0.5)
       * profile
       * saturate((height-x)/fw + 0.5);
  float angular = saturate(
    (dot(direction, normal)-spread)/
    max(1.0-spread, hl_nativeEpsilon()));
  return x < -5.0 ? 0.0 : band*angular;
}
vec4 hl_main(vec2 p) {
  vec4 field = vec4(glassField(hl_mapPoint(p, hl_u_sdfMap0, hl_u_sdfMap1)));
  float gradientLength = length(field.gb);
  if (field.a == 0.0 || gradientLength <= 1e-12) return vec4(0.0);
  vec2 normal = field.gb/gradientLength;
  float x = -(field.r+hl_effectOffset)/gradientLength;
  float fw = hl_pixelWidth(normal);

  vec2 resolvedFillDirection = hl_hasDiffuse != 0.0
    ? -hl_keyDirection : hl_fillDirection;
  float key = hl_lobe(x, fw, normal, hl_keyDirection,
          hl_keyHeight, hl_keySpread, hl_curvature, true);
  float fill = hl_lobe(x, fw, normal, resolvedFillDirection,
           hl_fillHeight, hl_fillSpread, hl_curvature, true);
  float diffuseKey = 0.0;
  float diffuseFill = 0.0;
  if (hl_hasDiffuse != 0.0) {
    diffuseKey = hl_lobe(x, fw, normal, hl_keyDirection,
      hl_diffuseKeyHeight, hl_diffuseKeySpread, 1.0, false);
    diffuseFill = hl_lobe(x, fw, normal, resolvedFillDirection,
      hl_diffuseFillHeight, hl_diffuseFillSpread, 1.0, false);
  }

  if (key + fill + diffuseKey + diffuseFill < hl_nativeEpsilon()) {
    return vec4(0.0);
  }
  float keyWeight = hl_correctedWeight(key, hl_keyAmount);
  float fillWeight = hl_correctedWeight(fill, hl_fillAmount);
  if (hl_hasDiffuse != 0.0) {
    keyWeight += hl_correctedWeight(diffuseKey, hl_diffuseKeyAmount);
    fillWeight += hl_correctedWeight(diffuseFill, hl_diffuseFillAmount);
  }
  vec4 result = hl_keyColor*keyWeight + hl_fillColor*fillWeight;

  result *= field.a;
  return vec4(result.rgb * hl_effectiveGroupGain, result.a) *
     float(hl_groupOpacity);
}

vec4 hl_composite(vec4 reflection, vec4 destination) {
  if (hl_groupBlend == 0.0) return bg_sourceOver(reflection, destination);
  // A vibrant group changes the destination under its coverage mask. The
  // source RGB is not paint: applying its white value or its RGB gain here
  // would turn a small contrast change into an opaque illuminated outline.
  vec4 inputColor = vec4(destination.rgb / max(destination.a, 0.000001), destination.a);
  vec4 transformed = inputColor.r * hl_groupCM[0]
    + inputColor.g * hl_groupCM[1]
    + inputColor.b * hl_groupCM[2]
    + inputColor.a * hl_groupCM[3] + hl_groupCM[4];
  float alpha = saturate(transformed.a) * saturate(reflection.a);
  return vec4(transformed.rgb * alpha, alpha) + destination * (1.0 - alpha);
}
`;

export const CONTRAST_STAGE = `
uniform vec4 edge_u_sdfMap0;
uniform vec2 edge_u_sdfMap1;
uniform float edge_offsetHDR;
uniform float edge_opacity;
uniform float edge_width;

vec2 edge_mapPoint(vec2 p, vec4 a, vec2 b) {
  return vec2(dot(p, a.xy) + b.x, dot(p, a.zw) + b.y);
}
float edge_nativeEpsilon() { return 0.000100016594; }
float edge_cdfCurve(float t) {
  float x = saturate(0.25*t + 0.5);
  float z = 4.0*x - 2.0;
  return (((0.002954483*z*z - 0.034454346)*z*z
      + 0.16821289)*z*z - 0.560546875)*z + 0.5;
}
float edge_distanceFootprint(vec2 q, float centerDistance) {

  vec2 qdx = vec2(edge_u_sdfMap0.x, edge_u_sdfMap0.z);
  vec2 qdy = vec2(edge_u_sdfMap0.y, edge_u_sdfMap0.w);
  float rx = float(glassField(q + qdx).r);
  float ry = float(glassField(q + qdy).r);
  return max((abs(rx-centerDistance) + abs(ry-centerDistance)),
       edge_nativeEpsilon());
}
vec4 edge_main(vec2 p) {
  vec2 q = edge_mapPoint(p, edge_u_sdfMap0, edge_u_sdfMap1);

  vec4 field = vec4(glassField(q));
  if (field.a == 0.0 ||
    edge_opacity <= 0.0 || edge_width <= 0.0) return vec4(0.0);

  float shadowM = field.r + 1.0;
  float shadow = edge_cdfCurve(shadowM*(-1.0/edge_width));
  float shapeM = field.r + 1.0;
  float fw = edge_distanceFootprint(q, field.r);
  float punchout = saturate((1.0-shapeM)/fw + 0.5)*field.a;
  float scalar = shadow*field.a*punchout*edge_opacity;
  return vec4(vec4(edge_offsetHDR, edge_offsetHDR, edge_offsetHDR, 1.0)*scalar);
}
`;
