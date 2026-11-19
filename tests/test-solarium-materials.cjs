'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

// These checks run entirely in Node and never create a window or application.
const source = fs.readFileSync(path.join(__dirname, '../src/renderer/solarium/glass-optics.js'), 'utf8');
const opticsModule = import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const material = {
  resolution: [400, 300], contentsScale: 2, glassThickness: 10, refractiveIndex: 1.56,
  glareDirectionOffset: -Math.PI / 4, materialTint: [0, 0, 0, 0], backdropTone: [1, 1],
  glareIntensity: 0.07, fresnelIntensity: 0, dispersionStrength: 0,
  glareAngleConvergence: 0.25, glareEdgeSharpness: -0.02, glareOppositeSideBias: 0.85,
  glareDistanceRange: 18, fresnelDistanceRange: 70, fresnelEdgeSharpness: 0,
};

test('Downsampled captures retain the requested texture-space blur at every display scale', async () => {
  const { resolveGlassOptics } = await opticsModule;
  for (const displayScale of [1, 2, 3]) {
    const uniforms = { ...material, contentsScale: displayScale,
      resolution: [200 * displayScale, 150 * displayScale] };
    for (const captureScale of [1, 0.5, 0.25, 0.2]) {
      const blurRadius = 2 * displayScale;
      const result = resolveGlassOptics(uniforms, {
        width: 200 * displayScale * captureScale,
        height: 150 * displayScale * captureScale,
        blurRadius,
      });
      assert.equal(result.bg_blurRadius, blurRadius);
      assert.equal(result.bg_edgeBleedBlurRadius, blurRadius);
      assert.equal(result.bg_blurFillBlurRadius, blurRadius);
    }
  }
});

test('Backdrop grading preserves neutrals and saturated colour distinctions before tint', async () => {
  const { resolveGlassOptics } = await opticsModule;
  const result = resolveGlassOptics({ ...material, backdropTone: [1.26, 1.03] },
    { width: 80, height: 60, blurRadius: 4 });
  const apply = color => [0, 1, 2].map(row => {
    const offset = row * 4;
    return color.reduce((sum, value, channel) => sum + value * result.bg_faceCM[offset + channel],
      result.bg_faceCM[offset + 3]);
  });
  const neutral = apply([0.4, 0.4, 0.4]);
  assert.ok(neutral.every(channel => Math.abs(channel - 0.412) < 1e-6));
  const purple = apply([0.4, 0.2, 0.5]);
  assert.ok(purple[0] - purple[1] > 0.2);
  assert.ok(purple[2] - purple[1] > 0.3);
});

const vm = require('node:vm');
const { buildSync } = require('esbuild');
const materialModule = { exports: {} };
const bundle = buildSync({entryPoints:[path.join(__dirname,'../src/renderer/solarium/menu-material.js')],
  bundle:true,format:'cjs',platform:'node',write:false,logLevel:'silent'});
vm.runInNewContext(bundle.outputFiles[0].text,{module:materialModule,exports:materialModule.exports});
const {createMenuMaterial} = materialModule.exports;
const fixture = require('./fixtures/solarium-menu-material.json');

test('Regular menu uniforms agree with the independently decoded material packets', async () => {
  const {resolveGlassOptics} = await opticsModule;
  const aliases = { innerRefractionInvHeight:'innerRefractionInverseHeight',
    outerRefractionInvHeight:'outerRefractionInverseHeight' };
  for (const [appearance, expected] of Object.entries(fixture.appearances)) {
    const menu = createMenuMaterial();
    const geometry={width:200,height:320,sourceWidth:50,sourceHeight:80};
    const overrides=menu.resolveOptics(appearance==='dark',geometry);
    const actual=resolveGlassOptics({...material,...menu.uniforms,optics:overrides},
      {width:50,height:80,blurRadius:0});
    assert.equal(menu.backgroundTextureScaleCoefficient,0.25);
    assert.equal(menu.backgroundTextureBlurRadius,0);
    for (const [name,value] of Object.entries(expected)) {
      if (/^(faceCM|shadowCM)[012]$/.test(name)) {
        const slot=Number(name.at(-1));
        const matrix=actual[`bg_${name.slice(0,-1)}`];
        assert.deepEqual(Array.from(matrix.slice(slot*4,slot*4+4)),value);
      } else if (/^blur(Alpha|Dist)[0-3]$/.test(name)) {
        const slot=Number(name.at(-1));
        const vector=name.startsWith('blurAlpha')?'bg_blurAlpha':'bg_blurDistance';
        assert.equal(actual[vector][slot],value);
      } else if (name==='blurFillBlurRadius') {
        assert.equal(actual.bg_blurFillBlurRadius,value*0.25);
      } else {
        assert.ok(Math.abs(actual[`bg_${aliases[name]??name}`]-value)<0.000001,
          `${appearance} ${name} must match the decoded packet`);
      }
    }
  }
});

test('Menu optics retain the selected appearance independently of the system theme', () => {
  const menu=createMenuMaterial();
  const geometry={width:200,height:320,sourceWidth:100,sourceHeight:160};
  const dark=menu.resolveOptics(true,geometry),light=menu.resolveOptics(false,geometry);
  assert.equal(dark.bg_blurFillLightenOpacity,0);
  assert.equal(light.bg_blurFillDarkenOpacity,0);
  assert.equal(dark.bg_faceCM[3],0.125);
  assert.equal(light.bg_faceCM[3],0.52001953125);
  assert.equal(dark.bg_blurFillBlurRadius,4);
});

test('Menu reflection lobes agree with the independently decoded highlight packet', () => {
  const expected = fixture.highlight;
  for (const isDark of [false, true]) {
    const actual = createMenuMaterial().resolveOptics(isDark,
      { width: 200, height: 320, sourceWidth: 50, sourceHeight: 80 });
    for (const [name, value] of Object.entries(expected)) {
      if (['semanticGain', 'groupColorMatrix', 'keyColor', 'fillColor'].includes(name)) continue;
      const values = Array.isArray(value) ? value : [value];
      const resolved = Array.isArray(actual[`hl_${name}`]) ? actual[`hl_${name}`] : [actual[`hl_${name}`]];
      values.forEach((component, index) => assert.ok(Math.abs(component - resolved[index]) < 1e-6, name));
    }
    // The white lobe colours remain coverage masks. The matrix belongs to
    // the destination blend, with columns packed for the shader's vectors.
    for (const name of ['keyColor', 'fillColor']) {
      assert.deepEqual(Array.from(actual[`hl_${name}`]), expected[name]);
    }
    const columns = [0, 1, 2, 3, 4].flatMap(column =>
      [0, 1, 2, 3].map(row => expected.groupColorMatrix[row * 5 + column]));
    assert.deepEqual(Array.from(actual.hl_groupCM), columns);
    assert.equal(actual.hl_groupBlend, 1);
    assert.equal(actual.hl_effectiveGroupGain, expected.semanticGain);
    assert.equal(actual.hl_groupOpacity, 1);
    assert.equal(actual.edge_opacity, 0);
  }
});
