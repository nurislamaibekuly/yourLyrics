const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL, fileURLToPath } = require('node:url');
const root = path.resolve(__dirname, '..');

async function checks(base, preserve = false) {
  const { createMetadataMarquee } = await import(base + 'player/metadata-marquee.js');
  const labels = [...document.querySelectorAll('.title, .artist')];
  const motion = { matches: false, addEventListener(_name, handler) { this.change = handler; }, removeEventListener() {} };
  const marquee = createMetadataMarquee(labels, motion);
  const wait = () => new Promise(resolve => setTimeout(resolve, 100));
  const results = [];
  const check = (name, ok) => results.push({ name, ok });
  const long = 'A very long song title and artist credit that should scroll all the way to its end';
  for (const style of ['macos', 'ios']) {
    document.body.dataset.uiStyle = style;
    labels.forEach(label => { label.textContent = long; });
    await wait();
    check(style + ' scrolls overflowing title and artist', labels.every(label => label.classList.contains('is-marquee') && label.querySelector('.metadata-marquee-text').getAnimations().length === 1));
    check(style + ' preserves the full accessible text', labels.every(label => label.textContent === long));
    check(style + ' extends the left fade 10px outside the text box', labels.every(label => {
      const viewport = label.querySelector('.metadata-marquee-viewport').getBoundingClientRect();
      const bounds = label.getBoundingClientRect();
      const padding = parseFloat(getComputedStyle(label).paddingLeft) || 0;
      return Math.abs(viewport.left - bounds.left - padding + 10) < 1 && getComputedStyle(label).overflow === 'visible';
    }));
    check(style + ' keeps the original text position', labels.every(label => {
      const inset = parseFloat(getComputedStyle(label).paddingLeft) || 0;
      return Math.abs(label.querySelector('.metadata-marquee-text').getBoundingClientRect().left - label.getBoundingClientRect().left - inset) < 1;
    }));
    check(style + ' keeps the right fade aligned with the content edge', labels.every(label => {
      const viewport = label.querySelector('.metadata-marquee-viewport').getBoundingClientRect();
      const bounds = label.getBoundingClientRect();
      return Math.abs(viewport.right - bounds.right + (parseFloat(getComputedStyle(label).paddingRight) || 0)) < 1;
    }));

    const content = labels[0].querySelector('.metadata-marquee-text');
    const animation = content.getAnimations()[0];
    check(style + ' animates only transforms', animation.effect.getKeyframes().every(frame => 'transform' in frame));
    animation.currentTime = 2200;
    await wait();
    check(style + ' moves the text after the opening pause', new DOMMatrixReadOnly(getComputedStyle(content).transform).m41 < 0);
    labels.forEach(label => { label.textContent = 'Short'; });
    await wait();
    check(style + ' leaves short labels still', labels.every(label => !label.classList.contains('is-marquee') && label.firstChild.nodeType === 3));
  }
  labels.forEach(label => { label.textContent = long; });
  await wait();
  labels.forEach(label => { label.style.width = '2000px'; });
  await wait();
  check('resizing to fit removes the marquee', labels.every(label => !label.classList.contains('is-marquee')));
  labels.forEach(label => { label.style.width = '160px'; });
  await wait();
  check('resizing narrower restarts overflowing text', labels.every(label => label.classList.contains('is-marquee')));
  motion.matches = true;
  motion.change();
  await wait();
  check('reduced motion restores static labels', labels.every(label => !label.classList.contains('is-marquee')));
  motion.matches = false;
  motion.change();
  await wait();
  document.body.dataset.uiStyle = 'tvos';
  await wait();
  check('tvOS keeps its original text layout', labels.every(label => !label.classList.contains('is-marquee') && label.firstChild.nodeType === 3));
  if (!preserve) marquee.dispose();
  return results;
}

async function run() {
  const { app, BrowserWindow, session } = require('electron');
  const profile = process.env.YOURLYRICS_MARQUEE_PROFILE;
  if (!profile || !path.basename(profile).startsWith('yourlyrics-marquee-')) throw new Error('Missing test profile');
  for (const key of ['userData', 'sessionData', 'logs', 'crashDumps']) app.setPath(key, profile);
  await app.whenReady();
  const isolated = session.fromPartition('marquee-test', { cache: false });
  const base = pathToFileURL(path.join(root, 'src/renderer') + path.sep).href;
  const fixture = pathToFileURL(path.join(profile, 'fixture.html')).href;
  isolated.protocol.handle('file', request => {
    if (request.url === fixture) return new Response(`<!doctype html><head><base href="${base}"><link rel="stylesheet" href="styles/styles.css"><link rel="stylesheet" href="styles/ios.css"><style>.title,.artist,body[data-ui-style] .title,body[data-ui-style] .artist {position:relative;inset:auto;width:160px;font:20px/1.3 sans-serif}</style></head><body data-ui-style="macos"><h1 class="title">Short</h1><p class="artist">Short</p></body>`, { headers: { 'content-type': 'text/html' } });
    const file = fileURLToPath(request.url);
    if (!['src/renderer', 'assets'].some(dir => file.startsWith(path.join(root, dir) + path.sep))) return new Response('', { status: 403 });
    return new Response(fs.readFileSync(file), { headers: { 'content-type': file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'text/javascript' : 'font/otf' } });
  });
  const win = new BrowserWindow({ show: false, webPreferences: { session: isolated, sandbox: true, backgroundThrottling: false } });
  await win.loadURL(fixture);
  const results = await win.webContents.executeJavaScript(`(${checks.toString()})(${JSON.stringify(base)}, ${Boolean(process.env.YOURLYRICS_MARQUEE_PREVIEW)})`);
  for (const result of results) { console.log(result); assert.ok(result.ok, result.name); }
  // Check rendered mask pixels, so a correctly spelled CSS declaration cannot
  // hide a missing fade or a fade positioned outside the visible text area.
  const rect = await win.webContents.executeJavaScript(`(() => {
    const probe = document.createElement('div');
    probe.id = 'fade-probe'; probe.className = 'title is-marquee';
    probe.style.cssText = 'position:fixed!important;left:40px!important;top:350px!important;width:160px!important;height:20px!important;padding:0!important;margin:0!important;background:transparent!important';
    document.body.dataset.uiStyle = 'macos';
    document.body.style.background = 'black';
    probe.innerHTML = '<span class="metadata-marquee-viewport"><span style="display:block;width:200px;height:20px;background:white"></span></span>';
    document.body.append(probe);
    return { x:30, y:350, width:170, height:20 };
  })()`);
  await new Promise(resolve => setTimeout(resolve, 100));
  const pixels = (await win.webContents.capturePage(rect)).resize({ width:170, height:20 }).toBitmap();
  const brightness = x => pixels[(10 * 170 + x) * 4];
  assert.ok(brightness(1) < brightness(5) && brightness(5) < brightness(12), 'Left fade renders outside the original text box without being clipped');
  assert.ok(brightness(168) < brightness(164) && brightness(164) < brightness(157), 'Right edge visibly fades out');
  console.log('Shifted left fade and unchanged right fade pixels passed');
  await win.webContents.executeJavaScript(`document.querySelector('#fade-probe').remove()`);
  if (process.env.YOURLYRICS_MARQUEE_PREVIEW) {
    await win.webContents.executeJavaScript(`document.body.dataset.uiStyle = 'macos'; document.body.style.background = '#333'; document.querySelectorAll('.title, .artist').forEach(label => { label.textContent = 'A very long title and artist name scrolling past the right edge'; });`);
    await new Promise(resolve => setTimeout(resolve, 150));
    fs.writeFileSync(process.env.YOURLYRICS_MARQUEE_PREVIEW, (await win.webContents.capturePage()).toPNG());
  }
  win.destroy();
  app.exit(0);
}

if (process.versions.electron) {
  run().catch(error => { console.error(error); require('electron').app.exit(1); });
} else {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'yourlyrics-marquee-'));
  try {
    const env = { ...process.env, YOURLYRICS_MARQUEE_PROFILE: profile };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.NODE_OPTIONS;
    const result = require('node:child_process').spawnSync(require('electron'), [__filename], { env, stdio: 'inherit', timeout: 15000 });
    process.exitCode = result.status ?? 1;
  } finally { fs.rmSync(profile, { recursive: true, force: true }); }
}
