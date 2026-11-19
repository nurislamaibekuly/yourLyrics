'use strict';

// Compare glyph-filter pixels against real glass over patterned artwork in a
// transparent window, where masking the wrong layer can isolate its backdrop.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');

async function run() {
  const { app, BrowserWindow } = require('electron');
  const profile = process.env.YOURLYRICS_FROST_PROFILE;
  app.setPath('userData', profile);
  await app.whenReady();
  const win = new BrowserWindow({
    show: false, width: 384, height: 180, useContentSize: true,
    transparent: true, backgroundColor: '#00000000',
    webPreferences: { sandbox: true, backgroundThrottling: false }
  });
  const file = path.join(profile, 'fixture.html');
  fs.writeFileSync(file, `<!doctype html>
    <link rel="stylesheet" href="${pathToFileURL(path.join(root, 'src/renderer/styles/styles.css'))}">
    <link rel="stylesheet" href="${pathToFileURL(path.join(root, 'src/renderer/styles/ios.css'))}">
    <style>
      html,body { margin:0; width:100%; height:100%; }
      #pattern { position:absolute; inset:0; width:100%; height:100%; }
      #ref { position:absolute; left:224px; top:52px; width:96px; height:48px; background:#ffffff59; backdrop-filter:blur(12px) saturate(170%); }
    </style>
    <body data-ui-style="ios"><div id="app"><canvas id="pattern" width="384" height="180"></canvas>
      <p class="artist"></p><div id="ref"></div>
    </div></body>`);
  const js = source => win.webContents.executeJavaScript(source);
  try {
    await win.loadFile(file);
    await js(`(async () => {
      const { createFrostedLabelsRenderer } = await import(${JSON.stringify(pathToFileURL(path.join(root, 'src/renderer/player/frosted-labels.js')).href)});
      const background = document.querySelector('#pattern');
      const context = background.getContext('2d');
      for (let x=0;x<384;x+=8) {
        context.fillStyle = x%16 === 0 ? '#e02020' : '#2040e0';
        context.fillRect(x,0,8,180);
      }
      window.frostedPixels = createFrostedLabelsRenderer(background);
    })()`);
    const style = 'left:32px;top:52px;width:96px;height:48px;margin:0;padding:0';
    const cases = [
      `<p class="artist frost-ready" style="${style}"></p>`,
      `<span class="time frost-ready" style="${style}"></span>`,
      `<p class="artist is-marquee" style="${style}"><span class="metadata-marquee-viewport" style="width:96px;margin:0"><span class="metadata-marquee-text frost-ready" style="width:96px;height:48px;margin:0"></span></span></p>`
    ];
    for (const [index, html] of cases.entries()) {
      await js(`(async () => {
        document.querySelector('.artist, .time').outerHTML = ${JSON.stringify(html)};
        const label = document.querySelector('.frost-ready');
        const canvas = document.createElement('canvas');
        canvas.width = 96; canvas.height = 48;
        const context = canvas.getContext('2d');
        context.fillStyle = '#fff'; context.fillRect(32,12,32,24);
        label.style.setProperty('--frost-mask', 'url("'+canvas.toDataURL()+'")');
        const image = new Image(); image.src = canvas.toDataURL(); await image.decode();
        frostedPixels.setMask(label, image);
        frostedPixels.paint();
        document.querySelector('#ref').style.background = getComputedStyle(label).getPropertyValue('--frost-tint');
      })()`);
      for (const shift of [0, 8, 0]) {
        await js(`(() => {
          const label = document.querySelector('.frost-ready');
          label.style.transform = 'translateX(${shift}px)';
          if (${index} === 1) label.textContent = 'updated clock';
          frostedPixels.paint();
        })()`);
        assert.equal(await js(`(() => {
          const canvas = document.querySelector('.frost-ready .frosted-label-pixels');
          return canvas.getContext('2d').getImageData(0,0,1,1).data[3];
        })()`), 0, 'The text surface itself must be transparent outside its glyphs');
        await new Promise(resolve => setTimeout(resolve, 100));
        const shot = (await win.webContents.capturePage()).resize({ width: 384, height: 180 });
        const pixels = shot.toBitmap();
        const sample = (x, y) => Array.from(pixels.slice((y * 384 + x) * 4, (y * 384 + x) * 4 + 4));
        const near = (actual, expected) => actual.every((value, channel) => Math.abs(value - expected[channel]) <= 16);
        // Canvas and native backdrop filters interpolate color differently.
        // Allow a small tint difference, but require untouched pixels outside
        // the glyphs regardless of compositor movement or text replacement.
        assert.ok(near(sample(80 + shift, 76), sample(272, 76)),
          `Moving frosted label ${index} must match the glass reference: ${JSON.stringify([sample(80 + shift, 76), sample(272, 76)])}`);
        assert.ok(sample(34 + shift, 54).every((value, channel) => Math.abs(value - sample(194 + shift, 54)[channel]) <= 2), 'No rectangular pixels may escape the glyphs during motion or clock changes');
      }
    }
    const colors = await js(`(async () => {
      const { ProgressiveBlur: VariableBlur } = await import(${JSON.stringify(pathToFileURL(path.join(root, 'src/renderer/vendor/progressive-blur/progressive-blur.js')).href)});
      const source = document.createElement('canvas'); source.width = 180; source.height = 720;
      const context = source.getContext('2d');
      const output = document.createElement('canvas');
      const effect = new VariableBlur(output);
      const result = [];
      for (const color of [[206,72,18], [16,168,224], [128,128,128], [240,220,32]]) {
        context.fillStyle = 'rgb('+color.join(',')+')'; context.fillRect(0,0,180,720);
        effect.render(source, { radius:100, rampStart:0, rampEnd:1, transparentBorder:false });
        for (const y of [50,360,650]) {
          const pixel = new Uint8Array(4);
          effect.gl.readPixels(90,y,1,1,effect.gl.RGBA,effect.gl.UNSIGNED_BYTE,pixel);
          result.push({ expected:color, actual:Array.from(pixel).slice(0,3) });
        }
      }
      effect.dispose();
      return result;
    })()`);
    for (const { actual, expected } of colors) {
      assert.ok(actual.every((value, index) => Math.abs(value - expected[index]) <= 1),
        `Blur must not tint solid colors: ${JSON.stringify({ actual, expected })}`);
    }
    console.log('iOS artist, clock and marquee frosting sample the backdrop without rectangle leaks. Blur color fidelity passed.');
  } finally {
    win.destroy();
  }
  app.exit(0);
}

if (process.versions.electron) {
  run().catch(error => { console.error(error); require('electron').app.exit(1); });
} else {
  const { spawnSync } = require('node:child_process');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'yourlyrics-frost-'));
  try {
    const env = { ...process.env, YOURLYRICS_FROST_PROFILE: profile };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.NODE_OPTIONS;
    const result = spawnSync(require('electron'), [__filename], { env, stdio: 'inherit', timeout: 20000 });
    process.exitCode = result.status ?? 2;
  } finally {
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}
