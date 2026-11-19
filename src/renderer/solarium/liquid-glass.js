// Must match MAX_RECTANGLES in shaders.js.
export const MAX_RECTANGLES = 16;

// The Swift struct defaults to `.zero` and relies on every preset filling in
// the refraction fields. Division by zero in the shader is harmless there but
// produces NaNs here, so the base values are the physical ones a preset would
// supply: borosilicate glass, a 70pt Fresnel falloff and a soft glare band.
const BASE_UNIFORMS = {
  resolution: [0, 0],
  contentsScale: 1,
  touchPoint: [0, 0],
  pressProgress: 0,
  pressGlow: 0.3,
  pressStretch: [0, 0],
  pressInflate: 0,
  shapeMergeSmoothness: 0.2,
  cornerRadius: 0,
  cornerRoundnessExponent: 2,
  materialTint: [0, 0, 0, 0],
  glassThickness: 10,
  refractiveIndex: 1.5,
  dispersionStrength: 5,
  fresnelDistanceRange: 70,
  fresnelIntensity: 0,
  fresnelEdgeSharpness: 0,
  glareDistanceRange: 30,
  glareAngleConvergence: 0.1,
  glareOppositeSideBias: 1,
  glareIntensity: 0.1,
  glareEdgeSharpness: -0.15,
  glareDirectionOffset: -Math.PI / 4,
  rectangles: [],
};

export class LiquidGlass {
  constructor({
    uniforms = {},
    backgroundTextureSizeCoefficient = 1,
    backgroundTextureScaleCoefficient = 1,
    backgroundTextureBlurRadius = 0,
    tintColor = null,
    shadowOverlay = false,
    backdropTone = null,
    optics = null,
    interactive = false,
  } = {}) {
    this.uniforms = { ...BASE_UNIFORMS, ...uniforms };
    this.backgroundTextureSizeCoefficient = backgroundTextureSizeCoefficient;
    this.backgroundTextureScaleCoefficient = backgroundTextureScaleCoefficient;
    this.backgroundTextureBlurRadius = backgroundTextureBlurRadius;
    // A tint may be a straight RGBA array or a function of the current theme,
    // which is how the Swift preset expresses its dynamic system color.
    this.tintColor = tintColor;
    this.shadowOverlay = shadowOverlay;
    this.backdropTone = backdropTone;
    this.optics = optics;
    // UIGlassEffect.isInteractive (@callstack/liquid-glass): the material
    // answers a touch inside its bounds. The view feeds the pointer through
    // `touchPoint`; whether the shader bends for it is the shader's call.
    this.interactive = interactive;
  }

  // The thumb of a slider or switch: almost clear, cool bias, and heavily
  // magnified because it is drawn inside a control that is only a few points
  // wide.
  static thumb({ magnification = 1.3 } = {}) {
    return new LiquidGlass({
      uniforms: {
        materialTint: [0.9, 0.95, 1.0, 0.035],
        // Thumb feedback comes from its morph and refraction, without a
        // pointer light washing over the track while it is dragged.
        pressGlow: 0,
        glassThickness: 9,
        refractiveIndex: 1.55,
        dispersionStrength: 5,
        fresnelDistanceRange: 70,
        fresnelIntensity: 0,
        fresnelEdgeSharpness: 0,
        glareDistanceRange: 30,
        glareAngleConvergence: 0,
        glareOppositeSideBias: 0,
        glareIntensity: 0.26,
        glareEdgeSharpness: -0.2,
        glareDirectionOffset: -Math.PI * 0.75,
        // Keep reflections confined to the light-facing arcs. Broad opposing
        // lobes join into an outline and obscure the refracted backdrop.
        optics: {
          hl_keyDirection: [-Math.SQRT1_2, -Math.SQRT1_2],
          hl_fillDirection: [Math.SQRT1_2, Math.SQRT1_2],
          hl_keyHeight: 1.25,
          hl_fillHeight: 1,
          hl_keySpread: 0.85,
          hl_fillSpread: 0.85,
          hl_keyAmount: 0.6,
          hl_fillAmount: 2,
          hl_keyColor: [1, 1, 1, 1],
          hl_fillColor: [0.2, 0.2, 0.2, 0.2],
          hl_hasDiffuse: 0,
          hl_groupOpacity: 0.26,
          edge_opacity: 0,
        },
      },
      backgroundTextureSizeCoefficient: 1 / magnification,
      backgroundTextureScaleCoefficient: magnification,
      backgroundTextureBlurRadius: 0,
      shadowOverlay: true,
    });
  }

  // The resting pill of the tab-bar lens: thin, strongly dispersive, and a
  // little wider than the view so the lifted lens reads as a magnifier.
  static lens() {
    return new LiquidGlass({
      uniforms: {
        glassThickness: 6,
        refractiveIndex: 1.1,
        dispersionStrength: 15,
        fresnelDistanceRange: 70,
        fresnelIntensity: 0,
        fresnelEdgeSharpness: 0,
        glareDistanceRange: 30,
        glareAngleConvergence: 0.1,
        glareOppositeSideBias: 1,
        glareIntensity: 0.1,
        glareEdgeSharpness: -0.1,
        glareDirectionOffset: -Math.PI / 4,
      },
      backgroundTextureSizeCoefficient: 1.1,
      backgroundTextureScaleCoefficient: 0.8,
      backgroundTextureBlurRadius: 0,
      shadowOverlay: true,
    });
  }

  // Panels, buttons and effect views. The backdrop is captured at a fifth of
  // the screen scale and blurred, which is both cheaper and closer to the
  // frosted material than a sharp capture would be.
  static regular() {
    return new LiquidGlass({
      uniforms: {
        glassThickness: 12,
        refractiveIndex: 1.56,
        dispersionStrength: 7,
        fresnelDistanceRange: 70,
        fresnelIntensity: 0,
        fresnelEdgeSharpness: 0,
        glareDistanceRange: 22,
        glareAngleConvergence: 0.25,
        glareOppositeSideBias: 0.85,
        glareIntensity: 0.12,
        glareEdgeSharpness: -0.08,
        glareDirectionOffset: -Math.PI / 4,
      },
      backgroundTextureSizeCoefficient: 1,
      backgroundTextureScaleCoefficient: 0.25,
      backgroundTextureBlurRadius: 3.8,
      // Apple-style adaptive dark-mode vibrancy + rich minimal tint so colored
      // backdrops stay velvety and saturated instead of washing out to chalky grey.
      backdropTone: isDark => (isDark ? [1.26, 1.03] : [1.0, 1.0]),
      tintColor: isDark => (isDark
        ? [0.06, 0.06, 0.09, 0.08]
        : [0.96, 0.98, 1, 0.44]),
    });
  }

  // The `clear` style of UIGlassEffect: the same surface with a thinner
  // tint, a lighter frost and less dispersion, closest to the system's
  // ultra-thin material.
  static clear() {
    return new LiquidGlass({
      uniforms: {
        glassThickness: 6,
        refractiveIndex: 1.35,
        dispersionStrength: 3,
        fresnelDistanceRange: 70,
        fresnelIntensity: 0,
        fresnelEdgeSharpness: 0,
        glareDistanceRange: 30,
        glareAngleConvergence: 0.1,
        glareOppositeSideBias: 1,
        glareIntensity: 0.06,
        glareEdgeSharpness: -0.15,
        glareDirectionOffset: -Math.PI / 4,
      },
      backgroundTextureSizeCoefficient: 1,
      backgroundTextureScaleCoefficient: 0.2,
      backgroundTextureBlurRadius: 0.15,
      tintColor: isDark => (isDark
        ? [0, 0.04958364581, 0.09951775161, 0.45]
        : [0.9023525731, 0.9509486998, 1, 0.45]),
    });
  }

  // Resolve dynamic colour choices once per draw, before uploading the affine
  // backdrop transform and tint to the shader.
  resolveBackdropTone(isDark) {
    return (typeof this.backdropTone === 'function' ? this.backdropTone(isDark) : this.backdropTone) ?? [1, 1];
  }

  resolveOptics(isDark, geometry) {
    const optics = this.optics ?? this.uniforms.optics;
    return typeof optics === 'function' ? optics(isDark, geometry) : optics;
  }

  resolveTint(isDark) {
    const tint = typeof this.tintColor === 'function' ? this.tintColor(isDark) : this.tintColor;
    return tint ?? this.uniforms.materialTint;
  }
}
