'use strict';

// Synthetic playback only. Samples the actual AeroUI/controller animation in
// Electron without starting any native media provider or the application.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL, fileURLToPath } = require('node:url');
const root = path.resolve(__dirname, '..');

async function animationChecks(moduleURL) {
  const { createPlaybackControls } = await import(moduleURL);
  const group = document.querySelector('.playback-controls');
  const button = group.querySelector('[data-playback="toggle"]');
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const checks = [];
  const check = (name, ok, details) => checks.push({ name, ok: Boolean(ok), details });
  let playing = false;
  let calls = 0;
  let hold = false;
  let fail = false;
  const errors = [];
  let finish;
  const controls = createPlaybackControls(group, {
    async control(action) {
      calls += 1;
      if (hold) await new Promise(resolve => { finish = resolve; });
      if (fail) return { ok: false };
      playing = action === 'play';
      controls.update({ playing, available: true });
      return { ok: true };
    },
    onError(message) { errors.push(message); }
  });
  controls.update({ playing, available: true });
  await wait(350);
  const label = button.querySelector('.aero-player-label');
  const scale = element => new DOMMatrixReadOnly(getComputedStyle(element).transform).a;
  const tap = async (keyboard = false) => {
    if (keyboard) {
      button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
      await wait(20);
      button.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter' }));
    } else {
      button.dispatchEvent(new PointerEvent('pointerdown', { button: 0, pointerId: 1 }));
      await wait(20);
      button.dispatchEvent(new PointerEvent('pointerup', { button: 0, pointerId: 1 }));
    }
  };
  const frames = async (name, duration) => {
    let collisions = 0;
    let minScale = Infinity;
    let symbolFrames = 0;
    let samples = 0;
    const until = performance.now() + duration;
    do {
      await new Promise(requestAnimationFrame);
      const writers = label.getAnimations().filter(animation =>
        animation.playState === 'running' && animation.effect.getKeyframes().some(key => 'transform' in key));
      collisions = Math.max(collisions, writers.length);
      minScale = Math.min(minScale, scale(label));
      const symbol = button.querySelector('.aero-player-symbol') ?? label;
      if (symbol.getAnimations({ subtree:true }).some(animation => animation.playState === 'running' &&
          animation.effect.getKeyframes().some(key => 'transform' in key))) symbolFrames += 1;
      samples += 1;
    } while (performance.now() < until);
    check(`${name}: press and symbol swap do not animate the same transform`, collisions <= 1,
      { maxTransformWriters: collisions, samples });
    check(`${name}: symbol replacement cannot shrink the press layer`, minScale > 0.8,
      { minPressScale: minScale });
    check(`${name}: symbol replacement still animates`, symbolFrames > 0, { symbolFrames });
  };

  await tap();
  const playIcon = button.querySelector('[data-icon="play"]');
  const pauseIcon = button.querySelector('[data-icon="pause"]');
  const outgoing = playIcon.getAnimations()[0];
  const incoming = pauseIcon.getAnimations()[0];
  check('outgoing icon shrinks over 130ms', outgoing.effect.getTiming().duration === 130 && outgoing.effect.getKeyframes().at(-1).transform === 'scale(0)');
  check('incoming icon starts from zero after a 70ms delay', incoming.effect.getTiming().delay === 70 && incoming.effect.getKeyframes()[0].transform === 'scale(0)');
  check('incoming icon uses the supplied damped spring', Math.abs(incoming.effect.getTiming().duration - Math.log(500) * 100) < .01 && incoming.effect.getTiming().easing.startsWith('linear('));
  await frames('quick play', 450);
  check('quick play sends one command and shows Pause', calls === 1 && button.getAttribute('aria-label') === 'Pause');
  await tap(true);
  await frames('keyboard pause', 450);
  check('keyboard pause shows Play', calls === 2 && button.getAttribute('aria-label') === 'Play');
  for (let i = 0; i < 3; i += 1) {
    const beforeSwap = [playIcon, pauseIcon].map(scale);
    await tap();
    const animations = [playIcon, pauseIcon].map(icon => icon.getAnimations()[0]);
    check(`rapid reversal ${i + 1}: icons reuse their live rendered scales`, animations.every((animation,index) => {
      const from = Number(animation.effect.getKeyframes()[0].transform.match(/scale\(([^)]+)\)/)[1]);
      // The pointer hold advances the old spring by 20ms before the swap.
      return Number.isFinite(from) && Math.abs(from - beforeSwap[index]) < .5;
    }));
    await frames(`rapid reversal ${i + 1}`, 85);
  }
  await wait(1100);
  check('rapid toggles end at the real playback state', calls === 5 && playing && button.getAttribute('aria-label') === 'Pause');
  check('all layers return to rest without a stuck scale or fade',
    Math.abs(scale(button) - 1) < 0.001 && Math.abs(scale(label) - 1) < 0.001 &&
    Number(getComputedStyle(label).opacity) === 1);

  const { playSkip } = await import(new URL('../vendor/aeroui/components/skip-label/skip-label.js', moduleURL));
  const skips = [...group.querySelectorAll('.aero-skip')];
  for (const skip of skips) {
    const direction = skip.dataset.direction;
    const skipButton = skip.closest('button');
    skipButton.dispatchEvent(new PointerEvent('pointerdown', { button: 0, pointerId: 7 }));
    await wait(30);
    check(direction + ': skip press uses the shared button and label springs', scale(skipButton) < 1 && scale(skipButton.querySelector('.aero-player-label')) < 1);
    check(direction + ': pressed background is translucent white', getComputedStyle(skipButton).getPropertyValue('--player-tint').includes('0.1333'));
    const pressedSpring = skipButton._aeroPlayer._btnAnim;
    skipButton.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 7 }));
    check(direction + ': release starts immediately without a minimum hold', skipButton._aeroPlayer._btnAnim !== pressedSpring);
    await wait(1000);
    check(direction + ': skip release returns both spring layers to rest', Math.abs(scale(skipButton) - 1) < .001 && Math.abs(scale(skipButton.querySelector('.aero-player-label')) - 1) < .001);
    const arrows = [...skip.querySelectorAll('.aero-skip-arrow')];
    const layout = arrows.map(arrow => [arrow.offsetLeft, arrow.offsetTop, arrow.offsetWidth, arrow.offsetHeight]);
    playSkip(skip);
    const active = skip._aeroSkip.animations;
    check(direction + ': three triangle transitions independent of the press spring', active.length === 3);
    check(direction + ': handoff uses the requested timing and overshoot', active[0].effect.getTiming().duration === 600 && active[0].effect.getTiming().easing === 'cubic-bezier(0.4, 1.51, 0.4, 1)');
    check(direction + ': outgoing triangle shrinks over 200ms', active[1].effect.getTiming().duration === 200 && active[1].effect.getKeyframes().at(-1).transform === 'scale(0)');
    check(direction + ': moving triangle stays opaque', !('opacity' in active[0].effect.getKeyframes()[0]));

    active.forEach(animation => { animation.currentTime = 140; });
    await new Promise(requestAnimationFrame);
    check(direction + ': triangle handoff adds no competing button-scale animation', !skip.getAnimations().some(animation => animation.effect.getKeyframes().some(frame => 'scale' in frame)));
    check(direction + ': entering triangle scales from its leading edge', getComputedStyle(arrows[2]).transformOrigin.startsWith('0px'));
    check(direction + ': outgoing triangle scales toward its trailing edge', Math.abs(parseFloat(getComputedStyle(arrows[1]).transformOrigin) - arrows[1].offsetWidth) < 1);
    check(direction + ': geometry stays fixed during the handoff', arrows.every((arrow,index) =>
      [arrow.offsetLeft,arrow.offsetTop,arrow.offsetWidth,arrow.offsetHeight].every((value,key) => value === layout[index][key])));
    playSkip(skip);
    check(direction + ': rapid trigger cannot stack or queue animations', skip._aeroSkip.animations === active);
    if (direction === 'backward') check('Previous mirrors the entire handoff', new DOMMatrixReadOnly(getComputedStyle(skip).transform).a === -1);
    await wait(750);
    check(direction + ': settles to two triangles without lingering transforms', !skip._aeroSkip.running &&
      skip._aeroSkip.animations.length === 0 && arrows.filter(arrow => Number(getComputedStyle(arrow).opacity) === 1).length === 2);
  }

  const normalColor = getComputedStyle(button).color;
  hold = true;
  await tap();
  await wait(180);
  check('pending native response blocks duplicate commands', button.disabled && group.getAttribute('aria-busy') === 'true');
  check('icon responds before the native command finishes', button.getAttribute('aria-label') === (playing ? 'Play' : 'Pause') && button.querySelector('.aero-player-icon.is-current').dataset.icon === (playing ? 'play' : 'pause'));
  check('waiting for native playback does not flash a disabled icon', getComputedStyle(button).color === normalColor,
    { normalColor, pendingColor: getComputedStyle(button).color });
  finish();
  await wait(450);
  hold = false;
  fail = true;
  const beforeFailure = playing;
  await tap();
  await wait(40);
  check('failed command restores the confirmed icon', playing === beforeFailure && button.getAttribute('aria-label') === (playing ? 'Pause' : 'Play') && errors.length === 1);
  fail = false;

  // Leave a replacement in flight for the host to switch reduced motion on.
  await tap();
  await wait(30);
  playSkip(skips[0]);
  window.__animationFixture = { controls, button, label, playing, checks, check, skips, playSkip };
  return checks;
}

async function run() {
  const { app, BrowserWindow, session } = require('electron');
  const profile = process.env.YOURLYRICS_ANIMATION_PROFILE;
  if (!profile || !path.basename(profile).startsWith('yourlyrics-animation-')) throw new Error('Missing test profile');
  for (const key of ['userData', 'sessionData', 'logs', 'crashDumps']) app.setPath(key, profile);
  app.commandLine.appendSwitch('disable-background-networking');
  const deadline = setTimeout(() => { console.error('Animation test timed out'); app.exit(2); }, 15000);
  try {
    await app.whenReady();
    const isolated = session.fromPartition(`animation-test-${process.pid}`, { cache: false });
    const base = pathToFileURL(path.join(root, 'src/renderer') + path.sep).href;
    const fixture = pathToFileURL(path.join(profile, 'fixture.html')).href;
    const html = `<!doctype html><head><base href="${base}">
      <link rel="stylesheet" href="vendor/aeroui/components/player-button/player-button.css">
      <link rel="stylesheet" href="vendor/aeroui/components/skip-label/skip-label.css">
      <link rel="stylesheet" href="styles/styles.css"></head><body><div class="playback-controls">
      <button class="aero-player" data-playback="previous"><span class="aero-skip" data-direction="backward"></span></button>
      <button class="aero-player" data-playback="toggle" aria-label="Play"></button>
      <button class="aero-player" data-playback="next"><span class="aero-skip" data-direction="forward"></span></button>
      </div></body>`;
    isolated.protocol.handle('file', request => {
      if (request.url === fixture) return new Response(html, { headers: { 'content-type': 'text/html' } });
      const file = fileURLToPath(request.url);
      if (!['src/renderer', 'assets'].some(dir => file.startsWith(path.join(root, dir) + path.sep))) {
        return new Response('Blocked', { status: 403 });
      }
      const type = file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'text/javascript' : 'font/otf';
      return new Response(fs.readFileSync(file), { headers: { 'content-type': type } });
    });
    isolated.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith('file:') }));
    const win = new BrowserWindow({ show: false, width: 1000, height: 800,
      webPreferences: { session: isolated, nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
    await win.loadURL(fixture);
    const hoverPoint = await win.webContents.executeJavaScript(`(() => {
      const r = document.querySelector('[data-playback="toggle"]').getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    })()`);
    win.webContents.sendInputEvent({ type: 'mouseMove', ...hoverPoint });
    await new Promise(resolve => setTimeout(resolve, 400));
    const hoverBackground = await win.webContents.executeJavaScript(`getComputedStyle(document.querySelector('[data-playback="toggle"]')).backgroundColor`);
    win.webContents.sendInputEvent({ type: 'mouseMove', x: 0, y: 0 });
    await new Promise(resolve => setTimeout(resolve, 400));
    const idleBackground = await win.webContents.executeJavaScript(`getComputedStyle(document.querySelector('[data-playback="toggle"]')).backgroundColor`);

    win.webContents.debugger.attach('1.3');
    const motion = value => win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value }]
    });
    await motion('no-preference');
    await win.webContents.executeJavaScript(`(${animationChecks.toString()})(${JSON.stringify(base + 'player/playback-controls.js')})`);
    await motion('reduce');
    const checks = await win.webContents.executeJavaScript(`(async () => {
      const { controls, button, label, playing, checks, check, skips, playSkip } = window.__animationFixture;
      controls.update({playing: !playing, available: true});
      await new Promise(resolve => setTimeout(resolve, 35));
      const moving = button.getAnimations({subtree:true}).filter(a =>
        a.playState === 'running' && a.effect.getKeyframes().some(k => 'transform' in k));
      check('reduced motion cancels an in-flight press and symbol swap', moving.length === 0, {moving: moving.length});
      const symbol = button.querySelector('.aero-player-symbol') ?? label;
      check('reduced motion leaves the replacement fully visible',
        Number(getComputedStyle(label).opacity) === 1 && Number(getComputedStyle(symbol).opacity) === 1);
      check('reduced motion cancels an in-flight skip handoff', skips.every(skip => !skip._aeroSkip.running && skip._aeroSkip.animations.length === 0));
      playSkip(skips[0]);
      check('reduced motion keeps skip glyphs static', skips[0]._aeroSkip.animations.length === 0);
      const iconLayers = [...button.querySelectorAll('.aero-player-icon')];
      check('reduced motion leaves exactly the selected icon visible', iconLayers.filter(icon => new DOMMatrixReadOnly(getComputedStyle(icon).transform).a === 1).length === 1 && iconLayers.filter(icon => new DOMMatrixReadOnly(getComputedStyle(icon).transform).a === 0).length === 1);

      return checks;
    })()`);
    checks.push({ name: 'hover keeps the button background transparent', ok: hoverBackground === 'rgba(0, 0, 0, 0)' });
    checks.push({ name: 'pointer exit keeps the button background transparent', ok: idleBackground === 'rgba(0, 0, 0, 0)' });
    for (const check of checks) console.log(JSON.stringify(check));
    const failures = checks.filter(check => !check.ok);
    console.log(`${checks.length - failures.length} animation checks passed; ${failures.length} failed`);
    win.destroy();
    app.exit(failures.length ? 1 : 0);
  } finally {
    clearTimeout(deadline);
  }
}

if (process.versions.electron) {
  run().catch(error => { console.error(error); require('electron').app.exit(2); });
} else {
  const { spawnSync } = require('node:child_process');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'yourlyrics-animation-'));
  try {
    const env = { ...process.env, YOURLYRICS_ANIMATION_PROFILE: profile };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.NODE_OPTIONS;
    const result = spawnSync(require('electron'), [__filename], { env, stdio: 'inherit', timeout: 20000, killSignal: 'SIGKILL' });
    if (result.error) console.error(result.error);
    process.exitCode = result.status ?? 2;
  } finally {
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}
