import { LiquidGlass } from './liquid-glass.js';

// The regular platter has its own optical recipe. Its RGB rows already include
// contrast, saturation and material colour; a second tint would flatten it.
const FACE = {
  dark: [
    1.3095703125, -0.303955078125, -0.03057861328125, 0.125,
    -0.09033203125, 1.095703125, -0.0307159423828125, 0.125,
    -0.0904541015625, -0.303955078125, 1.369140625, 0.125,
  ],
  light: [
    0.86328125, -0.326171875, -0.0328369140625, 0.52001953125,
    -0.096923828125, 0.6337890625, -0.032958984375, 0.52001953125,
    -0.09698486328125, -0.326171875, 0.92724609375, 0.52001953125,
  ],
};

// The reflection supplies coverage for a destination colour operation. The
// five columns transform the colour under that mask, rather than the mask's
// white RGB, so the rim retains the surrounding material's hue and contrast.
const RIM_MATRIX = [
  1.1201999187469482, -0.056299999356269836, -0.056299999356269836, 0,
  -0.18940000236034393, 0.9870999455451965, -0.18930000066757202, 0,
  -0.01899999938905239, -0.019099999219179153, 1.1574000120162964, 0,
  0, 0, 0, 1,
  0.14710000157356262, 0.14710000157356262, 0.14710000157356262, 0,
];

export function regularMenuOptics(isDark, { width, height, sourceWidth, sourceHeight }) {
  const texelsPerPoint = Math.sqrt(sourceWidth * sourceHeight / (width * height));
  return {
    bg_innerRefractionAmount: -24,
    bg_innerRefractionInverseHeight: 1 / 12,
    bg_outerRefractionAmount: 16,
    bg_outerRefractionInverseHeight: 1 / 16,
    bg_refractionThreshold0: -1,
    bg_refractionThreshold1: 0,
    bg_refractionOpacity: 0.60009765625,
    bg_hasOuterRefraction: 1,
    bg_blurRadius: 0,
    bg_blurAlpha: [1, 0.5, 0, -0.5],
    bg_blurDistance: [-24, -1, 0, 0],
    bg_faceCM: FACE[isDark ? 'dark' : 'light'],
    bg_faceOpacity: 1,
    bg_faceMaxLumaComplement: isDark ? 0.4 : 0,
    // Broad undistorted colour is mixed separately from the refracted face.
    // Dark appearance suppresses bright detail; light appearance lifts it.
    bg_blurFillEnabled: 1,
    bg_blurFillBlurRadius: 8 * texelsPerPoint,
    bg_blurFillLightenOpacity: isDark ? 0 : 0.89990234375,
    bg_blurFillDarkenOpacity: isDark ? 0.89990234375 : 0,
    bg_blurFillNormalOpacity: 0.5,
    bg_keyFillHighlightDirection: [1, 0],
    bg_keyFillHighlightHeight: 2,
    bg_keyFillHighlightSpread: isDark ? 0.2587890625 : -0.275634765625,
    bg_keyFillHighlightAmount: 0.5,
    bg_keyFillHighlightEffectOffset: -2,
    bg_keyFillHighlightColorBias: -0.25,
    bg_wantsHighlightBiasCorrection: 1,
    bg_shadowAmount: 0,
    bg_shadowInverseHeight: 0,
    bg_shadowOffset: [0, -8 / height],
    bg_shadowInverseRadius: 1 / 8,
    bg_shadowOpacity: 0.040008544921875,
    bg_shadowContribution: 0.30000001192092896,
    bg_shadowFaceOpacity: 0.30000001192092896,
    bg_shadowCM: [
      0.7001953125, -0.000051915645599365234, 0.000051915645599365234, 0,
      0.0000036954879760742188, 0.7001953125, -0.00001531839370727539, 0,
      -0.0000362396240234375, 0.0000362396240234375, 0.7001953125, 0,
    ],
    bg_preserveHue: 0,
    bg_hasChromaticAberration: 0,
    // The rim is a separate pair of directional lobes, not a uniform stroke.
    // A one-point reflection sits above a much softer eight-point shoulder;
    // both use point-space distances even when the backdrop is downsampled.
    hl_keyDirection: [0, -1],
    hl_fillDirection: [0, 1],
    hl_keyHeight: 1,
    hl_fillHeight: 1,
    hl_keySpread: 0.17364822328090668,
    hl_fillSpread: 0.17364822328090668,
    hl_keyAmount: 0,
    hl_fillAmount: 0,
    hl_keyColor: [1, 1, 1, 1],
    hl_fillColor: [1, 1, 1, 1],
    hl_curvature: 0.75,
    hl_effectOffset: 0,
    hl_diffuseKeyHeight: 8,
    hl_diffuseFillHeight: 8,
    hl_diffuseKeySpread: 0.6156615614891052,
    hl_diffuseFillSpread: 0.6156615614891052,
    hl_diffuseKeyAmount: 11.333333015441895,
    hl_diffuseFillAmount: 11.333333015441895,
    hl_hasDiffuse: 1,
    hl_effectiveGroupGain: 1.2000000476837158,
    hl_groupOpacity: 1,
    hl_groupBlend: 1,
    hl_groupCM: RIM_MATRIX,
    // The backdrop already carries its contrast edge. Adding the generic
    // enclosing stroke here would double the rim and illuminate the sides.
    edge_opacity: 0,
  };
}

export function createMenuMaterial(effect = 'regular') {
  if (effect === 'clear') {
    return new LiquidGlass({
      uniforms: { ...LiquidGlass.clear().uniforms, dispersionStrength: 0 },
      backgroundTextureScaleCoefficient: 0.2,
      backgroundTextureBlurRadius: 1,
      tintColor: [1, 1, 1, 0.06],
    });
  }
  return new LiquidGlass({
    uniforms: { glassThickness: 12, dispersionStrength: 0, cornerRoundnessExponent: 4 },
    backgroundTextureScaleCoefficient: 0.25,
    backgroundTextureBlurRadius: 0,
    // Keep the shape's point-space geometry separate from capture texels.
    optics: regularMenuOptics,
  });
}
