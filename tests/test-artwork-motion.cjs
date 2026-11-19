'use strict';

// Synthetic playback samples the cover spring and actual styles in a hidden
// window without starting a native media provider or the application.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL, fileURLToPath } = require('node:url');
const root = path.resolve(__dirname, '..');

async function artworkChecks(moduleURL, fixture) {
  const { createArtworkMotion, ArtworkPlaybackSpring } = await import(moduleURL);
  const group = document.querySelector('.album-group');
  const art = group.querySelector('img');
  const video = group.querySelector('video');
  const motion = new EventTarget();
  motion.matches = false;
  const controller = createArtworkMotion(group, motion);
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const scale = element => new DOMMatrixReadOnly(getComputedStyle(element).transform).a;
  const shadow = () => getComputedStyle(art).boxShadow;
  group.style.setProperty('--art-radius', '10px');
  const shadowGeometry = () => shadow().replace(/rgba?\([^)]+\)/, '').match(/-?[\d.]+/g).map(Number);
  const checks = [];
  const check = (name, ok) => checks.push({ name, ok: Boolean(ok) });
  for (const [direction, samples] of Object.entries(fixture.samples)) {
    for (const [seconds, expected] of samples) {
      const spring = new ArtworkPlaybackSpring(direction === 'resume' ? .73 : 1);
      spring.retarget(direction === 'resume');
      spring.step(seconds);
      check(`${direction} at ${seconds}s matches the extracted solver`, Math.abs(spring.value - expected) < 1e-12);
    }
  }
  controller.playback(false);
  const restingShadow = shadow();
  check('initial paused cover settles immediately', Math.abs(scale(art) - .73) < .00001);
  check('paused shadow compensates for cover scaling',
    Math.abs(shadowGeometry()[1] * scale(art) - 4) < .001 &&
    Math.abs(shadowGeometry()[2] * scale(art) - 16) < .001 && shadow().includes('0.15'));
  controller.playback(true);
  await wait(100);
  check('resume expands the cover progressively', scale(art) > .80 && scale(art) < 1);
  check('shadow expands alongside the cover', shadow() !== restingShadow);
  check('video and poster share the playback spring', Math.abs(scale(art) - scale(video)) < .00001);
  const clone = art.cloneNode(); group.append(clone);
  check('outgoing cover inherits the live spring', Math.abs(scale(art) - scale(clone)) < .00001);
  // Read at a frame boundary so retargeting's event-time sample differs only
  // by the time spent dispatching the event, rather than a full display frame.
  await new Promise(requestAnimationFrame);
  const before = scale(art);
  controller.playback(false);
  const after = scale(art);
  check('reversal preserves the rendered scale', Math.abs(before - after) < .008);
  await wait(32);
  check('reversal keeps momentum before turning around', scale(art) > after);
  await wait(1100);
  check('pause settles at the reduced scale', Math.abs(scale(art) - .73) < .001);
  check('shadow settles with the paused cover', shadow() === restingShadow);
  controller.playback(true);
  for (let i = 0; i < 6; i += 1) { await wait(40); controller.playback(true); }
  check('repeated playback updates do not restart the spring', scale(art) > .96);
  await wait(70);
  check('resume retains the extracted visible overshoot', scale(art) > 1.02 && scale(art) < 1.03);
  await wait(850);
  check('resume settles without a stuck overshoot', Math.abs(scale(art) - 1) < .00001);
  check('playing shadow uses the extracted offset, Gaussian width and opacity',
    Math.abs(shadowGeometry()[1] - 16) < .001 && Math.abs(shadowGeometry()[2] - 64) < .001 &&
    shadow().includes('0.45'));
  check('CSS does not add another scale or shadow curve', !art.getAnimations().some(a =>
    a.effect.getKeyframes().some(k => 'transform' in k || 'boxShadow' in k)));
  controller.playback(false); await wait(75);
  motion.matches = true; motion.dispatchEvent(new Event('change'));
  check('reduced motion finishes an in-flight spring immediately', Math.abs(scale(art) - .73) < .00001);
  controller.playback(true);
  check('reduced motion snaps subsequent changes', Math.abs(scale(art) - 1) < .00001);
  controller.playback(false);
  document.body.classList.add('is-bleed-artwork');
  check('immersive artwork stays full size', scale(art) === 1 &&
    (shadow() === 'none' || shadow().includes('0px 0px 0px')));
  document.body.classList.remove('is-bleed-artwork');
  document.body.dataset.uiStyle = 'ios';
  check('compact artwork stays still', getComputedStyle(art).transform === 'none');
  document.body.classList.add('is-lyrics-hidden');
  check('expanded iOS cover uses the playback scale', Math.abs(scale(art) - .75) < .00001);
  document.body.classList.remove('is-lyrics-hidden');
  document.body.classList.add('is-ipados-landscape');
  check('iPad cover uses the same playback spring', Math.abs(scale(art) - .75) < .00001);
  document.body.classList.add('is-bleed-artwork');
  check('iPad immersive cover stays full size', scale(art) === 1);
  document.body.classList.remove('is-bleed-artwork');
  document.body.dataset.uiStyle = 'tvos';
  check('tvOS keeps its independent cover presentation', scale(art) === 1 && shadow() === 'none');
  return checks;
}

async function run() {
  const { app, BrowserWindow, session } = require('electron');
  const profile = process.env.YOURLYRICS_ARTWORK_PROFILE;
  if (!profile || !path.basename(profile).startsWith('yourlyrics-artwork-')) throw new Error('Missing test profile');
  for (const key of ['userData', 'sessionData', 'logs', 'crashDumps']) app.setPath(key, profile);
  app.commandLine.appendSwitch('disable-background-networking');
  const deadline = setTimeout(() => { console.error('Animation test timed out'); app.exit(2); }, 10000);
  try {
    await app.whenReady();
    const isolated = session.fromPartition(`animation-test-${process.pid}`, { cache: false });
    const base = pathToFileURL(path.join(root, 'src/renderer') + path.sep).href;
    const fixture = pathToFileURL(path.join(profile, 'fixture.html')).href;
    const html = `<!doctype html><head><base href="${base}">
      <link rel="stylesheet" href="styles/styles.css"><link rel="stylesheet" href="styles/ios.css"></head>
      <body><div class="album-group"><img class="artwork"><video class="artwork artwork-video"></video></div></body>`;
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
    const checks = await win.webContents.executeJavaScript(`(${artworkChecks.toString()})(${JSON.stringify(base + 'player/artwork-motion.js')}, ${fs.readFileSync(path.join(root, 'tests/fixtures/artwork-motion.json'), 'utf8')})`);
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
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'yourlyrics-artwork-'));
  try {
    const env = { ...process.env, YOURLYRICS_ARTWORK_PROFILE: profile };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.NODE_OPTIONS;
    const result = spawnSync(require('electron'), [__filename], { env, stdio: 'inherit', timeout: 15000, killSignal: 'SIGKILL' });
    if (result.error) console.error(result.error);
    process.exitCode = result.status ?? 2;
  } finally {
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}
