'use strict';

// Render a patterned video through the supplied WebGL blur so the checks cover
// the actual pixels, rather than treating a ready class as proof of an effect.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');

async function run() {
  const { app, BrowserWindow } = require('electron');
  const profile = process.env.YOURLYRICS_BLUR_PROFILE;
  app.setPath('userData', profile);
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
  await app.whenReady();
  const deadline = setTimeout(() => app.exit(2), 20000);
  const fixture = path.join(profile, 'blur.html');
  fs.writeFileSync(fixture, `<!doctype html>
    <meta http-equiv="Content-Security-Policy" content="default-src 'self' file:; script-src 'self' file:; style-src 'self' file: 'unsafe-inline'; img-src 'self' data:; media-src 'self' blob:">
    <link rel="stylesheet" href="${pathToFileURL(path.join(root, 'src/renderer/styles/ios.css'))}">
    <style>html,body{margin:0;background:#222} .artwork{position:absolute;left:30px;top:30px;width:80px;height:80px}
    .artwork-shade{visibility:hidden}</style>
    <body data-ui-style="ios"><div class="album-group">
      <img class="artwork"><video class="artwork artwork-video" muted playsinline></video>
    </div></body>`);
  const win = new BrowserWindow({ show: false, width: 300, height: 600, useContentSize: true,
    webPreferences: { sandbox: true, backgroundThrottling: false } });
  win.webContents.on('console-message', event => { if (event.level === 'warning' || event.level === 'error') console.log(event.message); });
  const js = code => win.webContents.executeJavaScript(code);
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  try {
    await win.loadFile(fixture);
    await js(`(async () => {
      const { createArtworkBlur } = await import(${JSON.stringify(pathToFileURL(path.join(root, 'src/renderer/player/artwork-blur.js')).href)});
      const { ProgressiveBlur: VariableBlur } = await import(${JSON.stringify(pathToFileURL(path.join(root, 'src/renderer/vendor/progressive-blur/progressive-blur.js')).href)});
      const render = VariableBlur.prototype.render;
      VariableBlur.prototype.render = function(source, options) {
        window.blurOptions = options;
        return render.call(this, source, options);
      };
      window.motion = { matches: false };
      const video = document.querySelector('video');
      window.effect = createArtworkBlur(video, window.motion);
      window.pattern = document.createElement('canvas');
      pattern.width = 150; pattern.height = 200;
      const context = pattern.getContext('2d');
      for (let y=0;y<200;y+=8) for (let x=0;x<150;x+=8) {
        context.fillStyle = ((x/8+y/8)%2) ? '#fff' : '#000';
        context.fillRect(x,y,8,8);
      }
      document.querySelector('img').src = pattern.toDataURL();
      video.srcObject = pattern.captureStream(15);
      await video.play();
    })()`);
    await wait(250);
    assert.equal(await js(`document.querySelector('.artwork-blur').classList.contains('is-ready')`), false,
      'A static cover and an unselected video never activate the blur');
    assert.equal(await js(`getComputedStyle(document.querySelector('.artwork-blur')).display`), 'none');
    await js(`document.body.classList.add('is-tall-animated-art'); document.body.style.setProperty('--ios-animated-art-ratio', '1.3333333333333333'); document.querySelector('video').classList.add('is-visible');`);
    await js(`new Promise(requestAnimationFrame)`);
    await wait(600);
    assert.equal(await js(`document.querySelector('.artwork-blur').classList.contains('is-ready')`), true,
      JSON.stringify(await js(`({style:document.body.dataset.uiStyle,visibility:document.visibilityState,videoClass:document.querySelector('video').className,size:[document.querySelector('video').videoWidth,document.querySelector('video').videoHeight],body:document.body.className,canvas:[document.querySelector('canvas').clientWidth,document.querySelector('canvas').clientHeight]})`)));
    assert.equal(await js(`getComputedStyle(document.querySelector('.artwork-blur')).clipPath`), 'none',
      'The blur output covers the whole composition');
    assert.equal(await js(`getComputedStyle(document.querySelector('video')).opacity`), '0',
      'The original video is presented through the shared blurred canvas');
    assert.ok(await js(`document.querySelector('.artwork-blur').getBoundingClientRect().height > innerHeight`),
      'The blur source retains the offscreen part of the stretched clone');
    const screenshot = (await win.webContents.capturePage()).resize({ width: 300, height: 600 });
    const pixels = screenshot.toBitmap();
    const contrast = y => {
      let total = 0;
      for (let row=y-2;row<=y+2;row++) {
        for (let x=80;x<220;x++) total += Math.abs(pixels[(row*300+x)*4] - pixels[(row*300+x+1)*4]);
      }
      return total / (140 * 5);
    };
    const sharp = contrast(100);
    const rampTop = await js(`blurOptions.rampStart * document.querySelector('.artwork-blur').getBoundingClientRect().height`);
    const nearJoin = contrast(Math.round(rampTop + 4));
    const deepBlur = contrast(550);
    assert.ok(sharp > 8, `The original video retains sharp detail: ${sharp}`);
    assert.ok(nearJoin > deepBlur * 2 + 0.1,
      `The reflection becomes progressively smoother: ${JSON.stringify({ nearJoin, deepBlur })}`);
    await js(`effect.reset({ morphToStatic:true, staticImage:document.querySelector('img') });`);
    const fullStart = await js(`(() => {const r=document.querySelector('.artwork-transition').getBoundingClientRect();return {width:r.width,height:r.height};})()`);
    assert.equal(fullStart.width, 300, 'Collapse starts at the full artwork width');
    assert.equal(fullStart.height, 600, 'Collapse starts at the full window height');
    await wait(80);
    const shrinking = await js(`document.querySelector('.artwork-transition').getBoundingClientRect().width`);
    assert.ok(shrinking > 80 && shrinking < 300, 'Artwork shrinks toward the static cover');
    await wait(700);
    assert.equal(await js(`document.querySelector('.artwork-transition')`), null, 'The morph surface is removed at the compact cover');
    await js(`effect.rememberTrack('fixture');effect.beginExpansion(document.querySelector('img'),'fixture');document.body.classList.add('is-tall-animated-art');document.body.style.setProperty('--ios-animated-art-ratio','1.3333333333333333');`);
    const smallStart = await js(`document.querySelector('.artwork-transition').getBoundingClientRect().width`);
    assert.equal(smallStart, 80, 'Expansion starts at the compact static cover');
    await wait(80);
    const growing = await js(`document.querySelector('.artwork-transition').getBoundingClientRect().width`);
    assert.ok(growing > 80 && growing < 300, 'Artwork expands toward the full viewport');
    await wait(700);
    assert.equal(await js(`document.querySelector('.artwork-transition')`), null, 'The real animated canvas takes over after expansion');
    await js(`effect.reset({morphToStatic:true,staticImage:document.querySelector('img')});`);
    await wait(60);
    const reversal = await js(`(() => {
      const before=document.querySelector('.artwork-transition').getBoundingClientRect();
      effect.beginExpansion(document.querySelector('img'),'fixture');
      effect.reset({preserveExpansion:'fixture'});
      document.body.classList.add('is-tall-animated-art');
      document.body.style.setProperty('--ios-animated-art-ratio','1.3333333333333333');
      const after=document.querySelector('.artwork-transition').getBoundingClientRect();
      return Math.abs(before.width-after.width)+Math.abs(before.height-after.height);
    })()`);
    assert.ok(reversal < 1, 'Reversing a running morph starts at its current size');
    await wait(800);
    assert.equal(await js(`document.querySelector('.artwork-transition')`), null, 'Rapid reversal releases its temporary surface');
    const sampling = await js(`(async () => {
      const { ProgressiveBlur: VariableBlur } = await import(${JSON.stringify(pathToFileURL(path.join(root, 'src/renderer/vendor/progressive-blur/progressive-blur.js')).href)});
      const source = document.createElement('canvas');
      source.width = 256; source.height = 256;
      const context = source.getContext('2d');
      context.fillStyle = '#000'; context.fillRect(0,0,256,256);
      context.fillStyle = '#fff'; context.fillRect(124,124,8,8);
      const output = document.createElement('canvas');
      const effect = new VariableBlur(output);
      effect.render(source, { radius:48, minRadius:48, transparentBorder:false });
      const pixels = new Uint8Array(256 * 256 * 4);
      effect.gl.readPixels(0,0,256,256,effect.gl.RGBA,effect.gl.UNSIGNED_BYTE,pixels);
      effect.render(source, { radius:48, minRadius:48, transparentBorder:false });
      const repeated = new Uint8Array(pixels.length);
      effect.gl.readPixels(0,0,256,256,effect.gl.RGBA,effect.gl.UNSIGNED_BYTE,repeated);
      let peak=0, count=0, left=256, right=0, top=256, bottom=0;
      for (let y=0;y<256;y++) for (let x=0;x<256;x++) {
        const value=pixels[(y*256+x)*4];
        peak=Math.max(peak,value);
        if (value>0) { count++;left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y); }
      }
      effect.dispose();
      return { peak,count,width:right-left,height:bottom-top,stable:pixels.every((value,index)=>value===repeated[index]) };
    })()`);
    assert.ok(sampling.peak > 0 && sampling.peak < 255, 'Paired sampling averages a bright highlight');
    assert.ok(sampling.width > 16 && sampling.height > 16, 'The blur spreads in both directions');
    assert.equal(sampling.stable, true, 'The same video frame does not acquire animated grain');
    const stripeContrast = await js(`(async () => {
      const { ProgressiveBlur: VariableBlur } = await import(${JSON.stringify(pathToFileURL(path.join(root, 'src/renderer/vendor/progressive-blur/progressive-blur.js')).href)});
      const source = document.createElement('canvas');
      source.width = 512; source.height = 2048;
      const context = source.getContext('2d');
      for (let x=0;x<512;x+=2) {
        context.fillStyle = x%4 === 0 ? '#0040ff' : '#000020';
        context.fillRect(x,0,2,2048);
      }
      const output = document.createElement('canvas');
      const effect = new VariableBlur(output, { quality:'realtime' });
      effect.render(source, {radius:512*400/393,rampStart:0.3,rampEnd:0.7,transparentBorder:false});
      const start = Math.ceil(source.height * 0.3) - 4;
      const rows = 100;
      const pixels = new Uint8Array(256 * rows * 4);
      effect.gl.readPixels(128,2048-start-rows,256,rows,effect.gl.RGBA,effect.gl.UNSIGNED_BYTE,pixels);
      effect.dispose();
      return Array.from({length:rows}, (_,row) => {
        const offset = (rows-row-1)*256*4;
        let contrast = 0;
        for (let x=0;x<255;x++) contrast += Math.abs(pixels[offset+x*4+2] - pixels[offset+(x+1)*4+2]);
        return contrast/255;
      });
    })()`);
    const initialStripeContrast = stripeContrast[0];
    const largestDrop = Math.max(...stripeContrast.slice(1).map((value,index) => stripeContrast[index]-value));
    assert.ok(initialStripeContrast > 50, 'Fine blue stripes are visible before the blur begins');
    assert.ok(largestDrop / initialStripeContrast < 0.08,
      `Fine stripes fade gradually instead of forming a horizontal edge: ${largestDrop/initialStripeContrast}`);
    assert.ok(stripeContrast.at(-1) < initialStripeContrast * 0.15,
      'The paired-sampling blur suppresses the repeating stripes');
    await js(`motion.matches = true;`);
    await wait(150);
    assert.equal(await js(`document.querySelector('.artwork-blur').classList.contains('is-ready')`), false,
      'Reduced motion stops the animated blur');
    await js(`motion.matches = false;`);
    await wait(150);
    assert.equal(await js(`document.querySelector('.artwork-blur').classList.contains('is-ready')`), true);
    win.setContentSize(300, 700);
    await wait(150);
    assert.equal(await js(`document.querySelector('.animated-artwork-composition').clientHeight`), 700,
      'The reflection viewport follows window resizing');
    await js(`motion.matches=true; effect.reset({ morphToStatic:true, staticImage:document.querySelector('img') });`);
    assert.equal(await js(`document.querySelector('.artwork-transition')`),null,'Reduced motion skips the snapshot fade');
    assert.equal(await js(`getComputedStyle(document.querySelector('.artwork-blur')).display`), 'none');
    assert.equal(await js(`document.querySelector('img').getBoundingClientRect().width`), 80,
      'Stopping tall animation restores the ordinary static cover');
    await js(`motion.matches=false; pattern.width = 200; pattern.height = 200; document.body.classList.add('is-tall-animated-art');`);
    await wait(300);
    assert.equal(await js(`document.querySelector('.artwork-blur').classList.contains('is-ready')`), false,
      'Square animation cannot render the tall-artwork blur');
    console.log(`Tall video blur pixels passed: ${JSON.stringify({ sharp, nearJoin, deepBlur })}. Static and square exclusions passed.`);
    await js(`effect.dispose(); document.querySelector('video').srcObject.getTracks().forEach(track => track.stop());`);
  } finally { clearTimeout(deadline); win.destroy(); }
  app.exit(0);
}

if (process.versions.electron) {
  run().catch(error => { console.error(error); require('electron').app.exit(1); });
} else {
  const { spawnSync } = require('node:child_process');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'yourlyrics-blur-'));
  try {
    const env = { ...process.env, YOURLYRICS_BLUR_PROFILE: profile };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.NODE_OPTIONS;
    const result = spawnSync(require('electron'), [__filename], { env, stdio: 'inherit', timeout: 25000 });
    process.exitCode = result.status ?? 2;
  } finally { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
}
