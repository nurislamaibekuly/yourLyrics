'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = path.resolve(__dirname, '..');

async function run() {
  const { app, BrowserWindow, ipcMain, nativeImage, screen, session } = require('electron');
  const { createWindowStyleController } = require('../src/main/window/window-style');
  const profile = process.env.YOURLYRICS_IOS_PROFILE;
  if (!profile || !path.basename(profile).startsWith('yourlyrics-ios-')) throw new Error('Missing test profile');
  for (const key of ['userData', 'sessionData', 'logs', 'crashDumps']) app.setPath(key, profile);
  const deadline = setTimeout(() => { console.error('Portrait test timed out'); app.exit(2); }, 45000);
  await app.whenReady();
  const controller = createWindowStyleController(screen);
  let media = {
    title: '#brooklynbloodpop!', artist: 'Syko', album: 'Portrait',
    positionSeconds: 40, durationSeconds: 145, playing: false, controlsAvailable: true
  };
  // A manual visual check can reuse the supplied screenshot's cover without
  // adding the image to the app or making automated checks depend on it.
  if (process.env.YOURLYRICS_IOS_REFERENCE_ARTWORK) {
    media.artworkUrl = nativeImage.createFromPath(process.env.YOURLYRICS_IOS_REFERENCE_ARTWORK)
      .crop({ x: 296, y: 468, width: 555, height: 555 }).toDataURL();
  }
  const commands = [];
  const seeks = [];
  const noop = () => ({ ok: true });
  const handlers = {
    'now-playing:get': () => media,
    'now-playing:refresh': noop,
    'now-playing:set-artwork-fallback': noop,
    'now-playing:control': (event, action) => {
      commands.push(action);
      if (action === 'play' || action === 'pause') {
        media = { ...media, playing: action === 'play' };
        event.sender.send('now-playing:changed', media);
      }
      return noop();
    },
    'lyrics:get': () => ({ text: '[00:00.00]Previous phrase\n[00:10.00]Cover fire\n[01:00.00]A longer phrase that wraps over two lines\n[02:00.00]Following phrase', source: 'lrclib' }),
    'animated-art:get': () => null,
    'theme:set': noop,
    'discord:status': () => ({ state: 'disabled' }),
    'discord:set-settings': noop,
    'updates:check': () => ({}),
    'updates:version': () => '0.2.14',
    'window:set-ui-style': (event, style, options) => controller.set(BrowserWindow.fromWebContents(event.sender), style, options),
    'window:set-ui-scale': (_event, scale) => ({ ok: true, scale: Number(scale) || 1 }),
    'window:get-ui-scale': () => ({ ok: true, scale: 1 }),
    'window:is-maximized': () => ({ maximized: false }),
    'window:is-pinned': () => ({ alwaysOnTop: false }),
    'window:get-state': () => ({ maximized: false, fullscreen: false, alwaysOnTop: false })
  };
  for (const [channel, handler] of Object.entries(handlers)) ipcMain.handle(channel, handler);
  ipcMain.on('now-playing:seek', (_event, seconds) => seeks.push(seconds));
  const isolated = session.fromPartition(`ios-test-${process.pid}`, { cache: false });
  isolated.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !/^(file|data):/.test(details.url) }));
  const win = new BrowserWindow({ show: false, width: 1100, height: 800, minWidth: 800, minHeight: 600,
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hidden' } : {}),
    webPreferences: { preload: path.join(root, 'src/preload/index.js'), session: isolated,
      nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  const errors = [];
  win.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message); });
  const js = source => win.webContents.executeJavaScript(source);
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const capture = async name => {
    if (process.env.YOURLYRICS_IOS_SCREENSHOTS) {
      fs.writeFileSync(path.join(profile, `${name}.png`), (await win.webContents.capturePage()).toPNG());
    }
  };
  try {
    await win.loadFile(path.join(root, 'src/renderer/index.html'));
    await wait(1100);
    const desktopStyle = await js(`(() => {
      const art = getComputedStyle(document.querySelector('.artwork'));
      const lyric = getComputedStyle(document.querySelector('.lyrics-line'));
      return { fontRatio:parseFloat(lyric.fontSize)/innerHeight, weight:lyric.fontWeight,
        transition:art.transition, origin:art.transformOrigin.split(' ').map(parseFloat) };
    })()`);
    const desktop = win.getBounds();
    const desktopMaximum = win.getMaximumSize();
    await js(`localStorage.setItem('yourlyrics:settings', JSON.stringify({ uiStyle: 'ios' })); location.reload();`);
    await wait(2400);
    assert.ok(win.getBounds().width < win.getBounds().height, 'Saved iOS style resizes the native window');
    assert.deepEqual(win.getMaximumSize(), [0, 0], 'iOS leaves resizing unlimited past the minimum');
    assert.equal(await js(`document.body.dataset.uiStyle`), 'ios');
    assert.equal(await js(`document.body.classList.contains('is-tall-animated-art')`), false,
      'Static artwork never enables the animated extension');
    assert.equal(await js(`getComputedStyle(document.querySelector('.artwork-blur')).display`), 'none',
      'Static artwork has no variable-blur overlay');
    assert.equal(await js(`getComputedStyle(document.querySelector('.artwork-shade')).display`), 'none',
      'Static artwork has no animated-art gradient');

    const alertMaterial = await js(`(async () => {
      const { AlertView } = await import('./ui/alertview.js');
      window.__testAlert = new AlertView({ title: 'Alert material', message: 'Blur over the live player' });
      window.__testAlert.present();
      await new Promise(resolve => setTimeout(resolve, 450));
      const root = getComputedStyle(window.__testAlert.el);
      const card = getComputedStyle(window.__testAlert._card);
      const shade = getComputedStyle(window.__testAlert._backdrop);
      return { clip: root.clipPath, filter: card.backdropFilter, shadeClip: shade.clipPath };
    })()`);
    assert.equal(alertMaterial.clip, 'none', 'Alert parent must not isolate the card backdrop');
    assert.ok(alertMaterial.filter.includes('blur(20px)'), 'Alert retains its frosted material');
    assert.notEqual(alertMaterial.shadeClip, 'none', 'Alert shade still follows rounded window corners');
    await capture('alert-material');
    await js(`window.__testAlert.dismiss(); delete window.__testAlert;`);
    await wait(450);

    assert.equal(await js(`document.querySelector('.lyrics-toggle').getAttribute('aria-pressed')`), 'false');
    const checkAlbumGeometry = async () => {
      const layout = await js(`(() => {
        const rect = selector => { const r=document.querySelector(selector).getBoundingClientRect();
          return { x:r.x, y:r.y, width:r.width, height:r.height, centerX:r.x+r.width/2, centerY:r.y+r.height/2 }; };
        return { width:innerWidth, height:innerHeight, art:rect('.artwork'), title:rect('.title'),
          artist:rect('.artist'), progress:rect('.progress'), play:rect('[data-playback="toggle"]'),
          previous:rect('[data-playback="previous"]'), next:rect('[data-playback="next"]'),
          icon:rect('[data-playback="toggle"] svg').width };
      })()`);
      const near = (actual, expected, label) => assert.ok(Math.abs(actual - expected) < .005,
        `${label}: actual=${actual}, expected=${expected}`);
      // Static covers retain their original paused scale and album layout.
      near(layout.art.width / layout.width, .64125, 'Paused artwork width');
      near(layout.art.centerX / layout.width, .5, 'Artwork horizontal center');
      near(layout.art.centerY / layout.height, .311, 'Artwork vertical center');
      near(layout.title.y / layout.height, .565, 'Song title position');
      near(layout.artist.y / layout.height, .595, 'Artist position');
      near(layout.progress.x / layout.width, .085, 'Progress left inset');
      near(layout.progress.width / layout.width, .83, 'Progress width');
      near(layout.progress.y / layout.height, .655, 'Progress vertical position');
      near(layout.play.centerY / layout.height, .767, 'Play button vertical center');
      near(layout.play.centerX / layout.width, .5, 'Play button horizontal center');
      near(layout.previous.centerX / layout.width, .228, 'Previous button center');
      near(layout.next.centerX / layout.width, .772, 'Next button center');
      assert.ok(layout.play.width > layout.previous.width, 'Play button is larger than the skip buttons');
      near(layout.icon / layout.width, .132, 'Play icon ratio');
    };
    await checkAlbumGeometry();
    await capture('album');

    const transition = await js(`(async () => {
      window.__lyricNode = document.querySelector('.lyrics-track');
      window.__backdropNode = document.querySelector('.backdrop');
      const selectors=['.progress', '.time-elapsed', '.time-remaining', '.playback-controls',
        '[data-playback="previous"]', '[data-playback="toggle"]', '[data-playback="next"]'];
      const snapshot=() => selectors.map(selector => {
        const r=document.querySelector(selector).getBoundingClientRect(); return [r.x,r.y,r.width,r.height];
      });
      const baseline=snapshot();
      const metadata = [...document.querySelectorAll('.title, .artist, .metadata-menu')];
      const first = metadata.map(element => element.getBoundingClientRect());
      document.querySelector('.lyrics-toggle').click();
      const initial = metadata.map(element => element.getBoundingClientRect());
      const jump = Math.max(...initial.flatMap((rect, index) =>
        [Math.abs(rect.x - first[index].x), Math.abs(rect.y - first[index].y)]));
      const layout = metadata.map(element => [element.offsetTop, element.offsetLeft, element.offsetWidth, element.offsetHeight]);
      const transforms = metadata.every(element => element.getAnimations().some(animation =>
        animation.effect.getKeyframes().every(frame => 'translate' in frame && 'scale' in frame)));
      let drift=0, frames=0, metadataLayoutDrift=0;
      const end=performance.now()+750;
      do {
        await new Promise(requestAnimationFrame);
        const current=snapshot();
        drift=Math.max(drift,...current.flatMap((r,i)=>r.map((v,j)=>Math.abs(v-baseline[i][j]))));
        metadataLayoutDrift=Math.max(metadataLayoutDrift,...metadata.flatMap((element,index) =>
          [element.offsetTop,element.offsetLeft,element.offsetWidth,element.offsetHeight]
            .map((value,key) => Math.abs(value-layout[index][key]))));
        frames++;
      } while(performance.now()<end);
      return {drift,frames,jump,transforms,metadataLayoutDrift};
    })()`);
    assert.ok(transition.frames > 5);
    assert.ok(transition.jump < 1, 'Metadata collapse starts at the current visible position');
    assert.ok(transition.transforms, 'Metadata moves with compositor transforms');
    assert.equal(transition.metadataLayoutDrift, 0, 'Metadata layout does not recalculate its geometry on animation frames');
    assert.ok(transition.drift < .1, `Opening lyrics moves or resizes the transport: ${JSON.stringify(transition)}`);
    const geometry = await js(`(() => {
      const rect = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { x:r.x, y:r.y, width:r.width, height:r.height, bottom:r.bottom, right:r.right }; };
      return { width:innerWidth, height:innerHeight, art:rect('.artwork'), lyrics:rect('.lyrics'),
        progress:rect('.progress'), active:rect('.lyrics-line.is-active'),
        anchor:rect('.lyrics-line.is-active .lyrics-main-text'),
        fontRatio:parseFloat(getComputedStyle(document.querySelector('.lyrics-line')).fontSize)/innerHeight,
        weight:getComputedStyle(document.querySelector('.lyrics-line')).fontWeight,
        transition:getComputedStyle(document.querySelector('.artwork')).transition,
        preserved:window.__lyricNode === document.querySelector('.lyrics-track') && window.__backdropNode === document.querySelector('.backdrop') };
    })()`);
    assert.equal(geometry.preserved, true, 'Both renderers retain their live nodes');
    assert.ok(Math.abs(geometry.fontRatio - Math.min(desktopStyle.fontRatio, 0.078 * geometry.width / geometry.height)) < .0002, 'Portrait lyric size scales cleanly from desktop lyric size');
    assert.equal(geometry.weight, desktopStyle.weight, 'Portrait keeps the existing lyric weight');
    assert.equal(geometry.transition, desktopStyle.transition, 'Portrait keeps the existing artwork animation');
    const checkAnchor = async label => {
      const result = await js(`(() => {
        const lyrics=document.querySelector('.lyrics');
        const row=document.querySelector('.lyrics-line.is-active .lyrics-main-text').getBoundingClientRect();
        const art=document.querySelector('.artwork').getBoundingClientRect();
        // Transparent mask areas can appear lower in the hit-test stack.
        // Only the topmost element determines whether lyrics intercept input.
        const headerOverlap=Boolean(document.elementFromPoint(art.left+5, art.bottom-1)
          ?.closest('.lyrics'));
        // Mirror lyrics.js: viewport basis, the style's ratio, then the extra
        // offset that keeps the top fade clear of the header on short windows.
        const style=getComputedStyle(document.body);
        const ratio=parseFloat(style.getPropertyValue('--lyrics-anchor-ratio'))||.3815;
        const basis=style.getPropertyValue('--lyrics-anchor-basis').trim()==='container'
          ? lyrics.clientHeight : innerHeight;
        const padding=parseFloat(style.getPropertyValue('--lyrics-anchor-padding'))||0;
        return { actual:row.top, expected:basis*ratio+padding, headerOverlap };
      })()`);
      assert.ok(Math.abs(result.actual - result.expected) < 1, `${label}: ${JSON.stringify(result)}`);
      assert.equal(result.headerOverlap, false, `${label}: lyrics must not cover the metadata header`);
      return result.actual;
    };
    await checkAnchor('Active row starts at the mobile top anchor');
    assert.equal(await js(`document.querySelectorAll('.ios-favorite, .ios-volume, .ios-output, .ios-lyrics-options').length`), 0);
    assert.equal(await js(`'audio' in window.app`), false);
    assert.ok(Math.abs(geometry.art.width - geometry.width * .174) < .1);
    assert.ok(Math.abs(geometry.art.x - geometry.width * .085) < .1);
    assert.ok(Math.abs(geometry.art.y - geometry.height * .08) < .1);
    assert.ok(geometry.active.y >= geometry.lyrics.y && geometry.active.y < geometry.lyrics.bottom, 'Active lyric is inside the portrait mask');
    assert.ok(await js(`(() => {
      const mask = document.querySelector('.lyrics-mask');
      const style = getComputedStyle(mask);
      return parseFloat(style.getPropertyValue('--ios-mask-open')) === 0 &&
        mask.getBoundingClientRect().top + innerHeight * .65 < document.querySelector('.progress').getBoundingClientRect().top;
    })()`), 'Lyric mask fades to transparent above the scrubber');
    await capture('lyrics');

    // Changing from a short line to a wrapped line must keep the same text
    // origin. Centering the paragraph would move the first line upwards.
    for (const positionSeconds of [0, 12, 65, 12]) {
      media = { ...media, positionSeconds, playing: false };
      win.webContents.send('now-playing:changed', media);
      await wait(1250);
      await checkAnchor(`Lyric origin at ${positionSeconds}s`);
    }

    win.setSize(360, 600);
    await wait(1300);
    await checkAnchor('Resizing retains the mobile top anchor');
    assert.ok(await js(`(() => {
      const selectors = ['.artwork', '.title', '.artist', '.metadata-menu', '.progress', '.playback-controls', '.lyrics-toggle'];
      return selectors.every(selector => { const r = document.querySelector(selector).getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 38 && r.bottom <= innerHeight; });
    })()`), 'Controls remain inside the smallest supported portrait window');
    await capture('compact');

    // Neither artwork layer may acquire a playback transform in the header.
    for (const playing of [false, true]) {
      media = { ...media, playing };
      win.webContents.send('now-playing:changed', media);
      await wait(100);
      assert.ok(await js(`[...document.querySelectorAll('.artwork')].every(art =>
        getComputedStyle(art).transform === 'none' && !art.getAnimations().some(a =>
          a.effect.getKeyframes().some(k => 'transform' in k)))`), 'Compact artwork stays still across pause and resume');
    }
    media = { ...media, playing: false };
    win.webContents.send('now-playing:changed', media);
    await wait(200);

    // Native input must reach the buttons through the visible lyric surface.
    // Dispatching pressend directly bypasses Chromium's hit testing and would
    // miss a transparent lyric layer covering the controls.
    const clickPlayback = async (name, action) => {
      const point = await js(`(() => {
        const r=document.querySelector('[data-playback="${name}"]').getBoundingClientRect();
        return { x:Math.round(r.x+r.width/2), y:Math.round(r.y+r.height/2) };
      })()`);
      win.webContents.sendInputEvent({ type: 'mouseMove', ...point });
      await wait(60);
      const hit = await js(`(() => {
        const hit=document.elementFromPoint(${point.x}, ${point.y});
        return hit?.closest('[data-playback]')?.dataset.playback || hit?.className || '';
      })()`);
      assert.equal(hit, name, `A lyric layer covers the ${name} button: ${hit}`);
      const count = commands.length;
      win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
      await wait(30);
      win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
      const deadline = Date.now() + 3000;
      while (commands.length === count && Date.now() < deadline) await wait(20);
      assert.equal(commands.length, count + 1, `One ${action} command per pointer click`);
      assert.equal(commands.at(-1), action);
      await wait(150);
    };
    const controlGap = await js(`({ x: Math.round(innerWidth * .36), y: Math.round(innerHeight * .767) })`);
    assert.equal(await js(`Boolean(document.elementFromPoint(${controlGap.x}, ${controlGap.y})?.closest('.lyrics'))`), false, 'Control-band gaps do not target the transparent lyrics layer');
    const seeksBeforeGap = seeks.length;
    win.webContents.sendInputEvent({ type: 'mouseMove', ...controlGap });
    win.webContents.sendInputEvent({ type: 'mouseWheel', deltaY: -80, deltaX: 0, ...controlGap });
    win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...controlGap });
    win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...controlGap });
    await wait(80);
    assert.equal(seeks.length, seeksBeforeGap, 'Clicks over the control band cannot seek lyrics');
    assert.equal(await js(`document.querySelector('.lyrics').classList.contains('is-scrolling')`), false, 'Wheels over the control band cannot scroll lyrics');
    await clickPlayback('previous', 'previous');
    await clickPlayback('toggle', 'play');
    await clickPlayback('toggle', 'pause');
    await clickPlayback('next', 'next');

    const point = await js(`(() => { const r=document.querySelector('.progress').getBoundingClientRect(); return {x:Math.round(r.x+r.width/2), y:Math.round(r.y+r.height/2)}; })()`);
    win.webContents.sendInputEvent({ type:'mouseMove', ...point });
    await wait(120);
    const scaleDuring = await js(`new DOMMatrixReadOnly(getComputedStyle(document.querySelector('.progress')).transform).d`);
    assert.ok(scaleDuring > 1 && scaleDuring < 2, 'Progress hover animates instead of snapping');
    await wait(600);
    assert.ok(await js(`Math.abs(new DOMMatrixReadOnly(getComputedStyle(document.querySelector('.progress')).transform).d - 2) < .001`));
    win.webContents.sendInputEvent({ type:'mouseMove', x:0, y:0 });
    await wait(120);
    const scaleLeaving = await js(`new DOMMatrixReadOnly(getComputedStyle(document.querySelector('.progress')).transform).d`);
    assert.ok(scaleLeaving > 1 && scaleLeaving < 2, 'Progress hover-out also animates');
    await wait(600);

    await js(`document.querySelector('.progress').dispatchEvent(new KeyboardEvent('keydown', { key:'ArrowRight', bubbles:true }));`);
    await wait(30);
    assert.ok(await js(`document.querySelector('.progress-fill').getAnimations().some(a => a.transitionProperty === 'width')`), 'Seeking retains the progress-fill animation');
    await wait(100);
    assert.deepEqual(commands, ['previous', 'play', 'pause', 'next']);
    for (const selector of ['[data-playback="toggle"]', '.lyrics-toggle', '.progress']) {
      if (selector === '.lyrics-toggle') {
        const point = await js(`(() => { const rect = document.querySelector('.lyrics-toggle').getBoundingClientRect(); return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) }; })()`);
        // Two real clicks restore the initial view while retaining pointer focus
        // on the lyrics button, which is outside the main stage subtree.
        for (let click = 0; click < 2; click++) {
          win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
          win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
          await wait(40);
        }
        assert.equal(await js(`document.activeElement === document.querySelector('.lyrics-toggle')`), true);
      } else {
        await js(`document.querySelector('${selector}').focus();`);
      }
      const beforeSpace = commands.length;
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' });
      await wait(30);
      const focusOnPress = await js(`({ body: document.activeElement === document.body, element: document.activeElement.outerHTML.slice(0, 200) })`);
      assert.equal(focusOnPress.body, true, `Space press clears ${selector} focus: ${focusOnPress.element}`);
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' });
      await wait(80);
      assert.equal(commands.length, beforeSpace + 1, 'Space sends one playback command without activating the focused control');
      assert.equal(await js(`document.activeElement === document.body`), true, 'Space clears stale player focus in iOS');
      assert.equal(await js(`document.body.classList.contains('is-lyrics-hidden')`), false, 'Space does not activate the focused lyrics switch');
    }

    assert.ok(seeks.length > 0, 'Portrait scrubber keeps keyboard seeking');
    await wait(1300);
    const beforeIdle = await checkAnchor('Seek settles at the mobile top anchor');
    await wait(1500);
    assert.equal(await js(`document.body.classList.contains('is-ios-idle')`), true);
    assert.equal(await js(`getComputedStyle(document.body).cursor`), 'none', 'Idle iOS hides the cursor');
    assert.equal(await js(`getComputedStyle(document.querySelector('.lyrics-line')).pointerEvents`), 'none', 'Idle iOS disables lyric hit-testing');
    const seeksBeforeIdle = seeks.length;
    await js(`(() => {
      const row = document.querySelector('.lyrics-line');
      row.dispatchEvent(new PointerEvent('pointerenter'));
      row.dispatchEvent(new MouseEvent('click'));
    })()`);
    assert.equal(await js(`document.querySelectorAll('.lyrics-line.is-hovered').length`), 0, 'Idle lyrics cannot retain hover effects');
    assert.equal(seeks.length, seeksBeforeIdle, 'Idle lyric clicks do not seek');
    const afterIdle = await checkAnchor('Hiding transport leaves the active line in place');
    assert.ok(Math.abs(afterIdle - beforeIdle) < 1);
    await js(`window.dispatchEvent(new Event('pointermove'));`);
    assert.equal(await js(`document.body.classList.contains('is-ios-idle')`), false);
    assert.notEqual(await js(`getComputedStyle(document.querySelector('.lyrics-line')).pointerEvents`), 'none', 'Movement restores lyric interaction');
    const maskTransition = await js(`(async () => {
      const mask = document.querySelector('.lyrics-mask');
      const sample = () => {
        const style = getComputedStyle(mask);
        return { alpha: parseFloat(style.getPropertyValue('--ios-mask-open')),
          bottom: parseFloat(style.bottom) / innerHeight, image: style.maskImage };
      };
      await new Promise(resolve => setTimeout(resolve, 120));
      const waking = sample();
      await new Promise(resolve => setTimeout(resolve, 300));
      const awake = sample();
      document.body.classList.add('is-ios-idle');
      await new Promise(resolve => setTimeout(resolve, 120));
      const waiting = sample();
      await new Promise(resolve => setTimeout(resolve, 60));
      const hiding = sample();
      await new Promise(resolve => setTimeout(resolve, 250));
      const idle = sample();
      window.dispatchEvent(new Event('pointermove'));
      return { waking, awake, waiting, hiding, idle };
    })()`);
    assert.ok(maskTransition.waking.alpha > 0 && maskTransition.waking.alpha < 1, 'Lower lyrics fade out when controls return');
    assert.ok(Math.abs(maskTransition.awake.alpha) < .001);
    assert.ok(maskTransition.waiting.alpha > 0 && maskTransition.waiting.alpha < 1, 'Mask starts fading alongside outgoing controls');
    assert.ok(maskTransition.hiding.alpha > 0 && maskTransition.hiding.alpha < 1, 'Lower lyrics fade in after controls hide');
    assert.ok(Math.abs(maskTransition.idle.alpha - 1) < .001);
    assert.ok(Object.values(maskTransition).every(sample => sample.bottom === 0), 'Mask viewport stays fixed throughout the crossfade');
    const fixedStops = image => image.replace(/rgba?\([^)]*\)/g, 'color');
    assert.ok(Object.values(maskTransition).every(sample =>
      fixedStops(sample.image) === fixedStops(maskTransition.awake.image)), 'Mask gradient stops stay stationary throughout the crossfade');


    await js(`document.querySelector('.ios-artwork-toggle').click();`);
    await wait(650);
    media = { ...media, playing: false };
    win.webContents.send('now-playing:changed', media);
    await wait(800);
    assert.ok(await js(`Math.abs(new DOMMatrixReadOnly(getComputedStyle(document.querySelector('.artwork')).transform).a - .75) < .001`), 'Paused artwork uses the portrait resting scale');
    media = { ...media, playing: true };
    win.webContents.send('now-playing:changed', media);
    await wait(60);
    assert.ok(await js(`(() => {
      const scale = new DOMMatrixReadOnly(getComputedStyle(document.querySelector('.artwork')).transform).a;
      return scale > .75 && scale < 1;
    })()`), 'Resuming artwork expands through the playback spring');
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value:'reduce' }] });
    await js(`document.querySelector('.lyrics-toggle').click();`);
    assert.equal(await js(`getComputedStyle(document.querySelector('.artwork')).transitionDuration`), '0s');
    assert.equal(await js(`getComputedStyle(document.querySelector('.lyrics-mask')).transitionDuration`), '0s');
    assert.equal(await js(`(() => {
      document.body.classList.add('is-ios-idle');
      const alpha = parseFloat(getComputedStyle(document.querySelector('.lyrics-mask')).getPropertyValue('--ios-mask-open'));
      window.dispatchEvent(new Event('pointermove'));
      return alpha === 1;
    })()`), true, 'Reduced motion applies the expanded mask immediately');

    win.webContents.debugger.detach();

    await js(`document.querySelector('.metadata-menu').click();`);
    await wait(300);
    await js(`[...document.querySelectorAll('.menuview button')].find(button => button.textContent.trim() === 'Settings').click();`);
    await wait(600);
    assert.ok(await js(`document.querySelector('.sheetview').textContent.includes('Lyrics · iOS')`));
    await capture('settings');
    await js(`[...document.querySelectorAll('.sheet-menu-row')].find(row => row.firstElementChild.textContent === 'UI style').click();`);
    await wait(350);
    await js(`[...document.querySelectorAll('.menuview button')].find(button => button.textContent.trim() === 'macOS').click();`);
    await wait(1800);
    assert.equal(await js(`document.body.dataset.uiStyle`), 'macos');
    assert.deepEqual(win.getBounds(), desktop, 'Leaving iOS restores the original wide bounds');
    assert.deepEqual(win.getMaximumSize(), desktopMaximum, 'Leaving iOS restores the desktop resize limits');
    assert.equal(await js(`window.__lyricNode === document.querySelector('.lyrics-track') && window.__backdropNode === document.querySelector('.backdrop')`), true);
    assert.deepEqual(errors, []);
    console.log('Portrait layout, live renderers, playback, idle controls, settings, reduced motion and window restoration passed.');
    if (process.env.YOURLYRICS_IOS_SCREENSHOTS) console.log(`Screenshots: ${profile}`);
    win.destroy();
    app.exit(0);
  } catch (error) { console.error({ rendererErrors: errors }); throw error; }
  finally { clearTimeout(deadline); }
}

if (process.versions.electron) {
  run().catch(error => { console.error(error); require('electron').app.exit(2); });
} else {
  const { spawnSync } = require('node:child_process');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'yourlyrics-ios-'));
  try {
    const env = { ...process.env, YOURLYRICS_IOS_PROFILE: profile };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.NODE_OPTIONS;
    const result = spawnSync(require('electron'), [__filename], { env, stdio:'inherit', timeout:50000, killSignal:'SIGKILL' });
    if (result.error) console.error(result.error);
    process.exitCode = result.status ?? 2;
  } finally {
    if (!process.env.YOURLYRICS_IOS_SCREENSHOTS) fs.rmSync(profile, { recursive:true, force:true, maxRetries:3, retryDelay:100 });
  }
}
