// Existing materials describe depth, tint and glare. Resolve those controls into
// explicit stage parameters so callers can also supply a complete optics recipe.
// These defaults adapt the public material API; they are not a recovered preset.
export function resolveGlassOptics(uniforms, { width, height, blurRadius = 0 }) {
  const scale = Math.max(uniforms.contentsScale, 0.001);
  const extent = uniforms.resolution.map(value => Math.max(value / scale, 0.001));
  const source = [Math.max(width, 1), Math.max(height, 1)];
  const texels = [source[0] / extent[0], source[1] / extent[1]];
  const thickness = Math.max(uniforms.glassThickness, 0.001);
  const angle = uniforms.glareDirectionOffset;
  const direction = [Math.cos(angle), Math.sin(angle)];
  const tint = uniforms.materialTint;
  const [saturation, brightness] = uniforms.backdropTone;
  const tintAlpha = Math.max(0, Math.min(tint[3], 1));
  const luma = [0.2126, 0.7152, 0.0722];
  // Fold saturation, brightness and straight tint into one affine transform.
  // This avoids applying a second colour transform to the specular highlights.
  const faceMatrix = luma.flatMap((_, row) => [
    ...luma.map((weight, column) => ((1 - saturation) * weight
      + (row === column ? saturation : 0)) * brightness * (1 - tintAlpha)),
    tint[row] * tintAlpha,
  ]);
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];
  const glare = Math.max(uniforms.glareIntensity, 0);
  const fresnel = Math.max(uniforms.fresnelIntensity, 0);
  // The view already supplies this radius in capture texels, including the
  // display scale. Multiplying by the capture coefficient again collapses
  // the frost on low-resolution panel captures into a nearly sharp sample.
  const radius = Math.max(blurRadius, 0);
  const cssPixel = 1 / scale;
  const values = {
    bg_u_lastMip: Math.floor(Math.log2(Math.max(...source))),
    bg_u_sourceExtent: source,
    bg_u_backdropMap0: [texels[0], 0, 0, texels[1]],
    bg_u_backdropMap1: [0, 0],
    bg_u_sdfMap0: [1, 0, 0, 1],
    bg_u_sdfMap1: [0, 0],
    bg_u_sdfDistanceScale: cssPixel,
    bg_u_sdfExtent: extent,
    bg_displacementMat: [1 / extent[0], 0, 0, 1 / extent[1]],
    bg_innerRefractionAmount: -thickness * Math.max(uniforms.refractiveIndex - 1, 0),
    bg_innerRefractionInverseHeight: 1 / thickness,
    bg_outerRefractionAmount: 0,
    bg_outerRefractionInverseHeight: 1 / thickness,
    bg_refractionThreshold0: -thickness,
    bg_refractionThreshold1: 0,
    bg_blurRadius: radius,
    bg_edgeBleedBlurRadius: radius,
    bg_edgeBleedAmount: 0,
    bg_edgeBleedInverseHeight: 1 / thickness,
    bg_shadowAmount: 0,
    bg_shadowInverseHeight: 1 / thickness,
    bg_shadowOffset: [0, 0],
    bg_shadowBlurRadius: 0,
    bg_shadowInverseRadius: 1,
    bg_faceCM: faceMatrix,
    bg_bleedCM: identity,
    bg_shadowCM: identity,
    bg_shadowContribution: 0,
    bg_shadowFaceOpacity: 0,
    bg_blurAlpha: [1, 0, 0, 0],
    bg_blurDistance: [-thickness, 0, 0, 0],
    bg_edgeBleedDistance: [-thickness, 0],
    bg_edgeBleedOpacity: 0,
    bg_faceOpacity: 1,
    bg_bleedDarken: [0, 1],
    bg_shadowDistanceOffset: 0,
    bg_shadowOpacity: 0,
    bg_refractionOpacity: 0,
    bg_holdingToneOpacity: 0,
    bg_sdrShadowDistance0: -thickness,
    bg_sdrShadowInverse: 1 / thickness,
    bg_ringShadowOffset: [0, 0],
    bg_ringShadowStrokeWidth: 1,
    bg_ringShadowRadius: 1,
    bg_ringShadowOpacity: 0,
    bg_ringShadowMask: 1,
    bg_keyFillHighlightDirection: direction,
    bg_keyFillHighlightHeight: 0,
    bg_keyFillHighlightSpread: 0,
    bg_keyFillHighlightAmount: 0,
    bg_keyFillHighlightEffectOffset: 0,
    bg_keyFillHighlightColorBias: 0,
    bg_blurFillBlurRadius: radius,
    bg_blurFillLightenOpacity: 0,
    bg_blurFillDarkenOpacity: 0,
    bg_blurFillNormalOpacity: 0,
    bg_aberrationAmount: Math.max(uniforms.dispersionStrength, 0) * 0.1,
    bg_aberrationDirection: [0, 1],
    bg_inverseAberrationHeight: 1 / thickness,
    bg_aberrationOffset: 0,
    bg_sdrWhiteValue: 1,
    bg_clampLimit: 1,
    bg_faceMaxLumaComplement: 0,
    bg_preserveHue: 1,
    bg_blurFillEnabled: 0,
    bg_strokeMode: 0,
    bg_highlightExtension: 0,
    bg_wantsHighlightBiasCorrection: 0,
    bg_hasChromaticAberration: uniforms.dispersionStrength > 0 ? 1 : 0,
    bg_hasOuterRefraction: 0,
    bg_hasEdgeBleed: 0,
    bg_edrScale: 1,
    hl_u_sdfMap0: [1, 0, 0, 1],
    hl_u_sdfMap1: [0, 0],
    hl_u_sdfDistanceScale: cssPixel,
    hl_keyDirection: direction,
    hl_keyHeight: Math.max(0.5, uniforms.glareDistanceRange * 0.05),
    hl_keySpread: Math.min(0.99, uniforms.glareAngleConvergence),
    hl_keyAmount: Math.max(0, 1 + uniforms.glareEdgeSharpness),
    hl_keyColor: [1, 1, 1, 1],
    hl_fillDirection: direction.map(value => -value),
    hl_fillHeight: Math.max(0.5, uniforms.glareDistanceRange * 0.05),
    hl_fillSpread: Math.min(0.99, uniforms.glareAngleConvergence),
    hl_fillAmount: Math.max(0, 1 + uniforms.glareEdgeSharpness),
    hl_fillColor: Array(4).fill(Math.max(0, uniforms.glareOppositeSideBias)),
    hl_curvature: 0.75,
    hl_effectOffset: 0,
    hl_diffuseKeyHeight: Math.max(0.5, uniforms.fresnelDistanceRange * 0.1),
    hl_diffuseKeySpread: Math.min(0.99, uniforms.fresnelEdgeSharpness),
    hl_diffuseKeyAmount: 1,
    hl_diffuseFillHeight: Math.max(0.5, uniforms.fresnelDistanceRange * 0.1),
    hl_diffuseFillSpread: Math.min(0.99, uniforms.fresnelEdgeSharpness),
    hl_diffuseFillAmount: 1,
    hl_hasDiffuse: fresnel > 0 ? 1 : 0,
    hl_effectiveGroupGain: 1,
    hl_groupOpacity: Math.min(1, glare + fresnel),
    hl_groupBlend: 0,
    hl_groupCM: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0],
    edge_u_sdfMap0: [1, 0, 0, 1],
    edge_u_sdfMap1: [0, 0],
    edge_offsetHDR: 0,
    edge_opacity: 0,
    edge_width: 1,
  };
  // Names match the GLSL stages. Explicit overrides allow independent inner
  // and outer refraction, blur stops, edge bleed and key/fill lighting recipes.
  return { ...values, ...uniforms.optics };
}
