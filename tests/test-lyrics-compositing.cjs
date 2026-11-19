'use strict';

// Pixel check through the real CSS hierarchy: fade masks and row filters must
// not stop the completed lyric group from blending with its sibling mesh.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL, fileURLToPath } = require('node:url');

async function run() {
  const { app, BrowserWindow } = require('electron');
  const profile = process.env.YOURLYRICS_COMPOSITING_PROFILE;
  if (!profile || !path.basename(profile).startsWith('yourlyrics-compositing-')) {
    throw new Error('Missing disposable profile');
  }
  for (const name of ['userData', 'sessionData', 'logs', 'crashDumps']) app.setPath(name, profile);
  app.commandLine.appendSwitch('force-color-profile', 'srgb');
  await app.whenReady();
  const win = new BrowserWindow({ show: false, width: 1000, height: 800,
    useContentSize: true, webPreferences: { sandbox: true, backgroundThrottling: false } });
  const css = pathToFileURL(path.resolve(__dirname, '../src/renderer/styles/styles.css')).href;
  const lyricsModule = pathToFileURL(path.resolve(__dirname, '../src/renderer/lyrics/index.js')).href;
  const lyricsParsers = pathToFileURL(path.resolve(__dirname, '../src/renderer/lyrics/parsers.js')).href;
  const html = `<!doctype html>
    <link rel="stylesheet" href="${css}">
    <style id="compositing-fixture-style">
      .backdrop { filter: none; transform: none; background: rgb(80, 30, 10); }
      .lyrics { top: 0; left: 0; width: 100%; height: 100%; }
      .lyrics-track { top: 300px; }
      /* Supply the renderer's alpha inputs so this fixture isolates blending. */
      .lyrics-line { --line-blur: 0px; --line-opacity: 1; --word-dark-alpha: 0.38; font-size: 100px; }
      .lyrics-line.is-active .lyrics-word {
        --fill: -500px; --fade-width: 0px;
        /* Solid glyph interior avoids antialiasing at font block seams. */
        background-clip: border-box; -webkit-background-clip: border-box;
      }
    </style>
    <div id="app"><div class="backdrop"></div><main class="stage">
      <section class="lyrics"><div class="lyrics-mask"><div class="lyrics-track">
        <p class="lyrics-line is-active"><span class="lyrics-word">████</span></p>
      </div></div></section>
    </main></div><div id="reference" style="position:fixed;left:800px;top:600px;width:20px;height:20px;isolation:isolate">
      <div style="position:absolute;inset:0;background:white;opacity:0.4;mix-blend-mode:plus-lighter"></div>
    </div>`;
  const fixture = pathToFileURL(path.join(profile, 'fixture.html')).href;
  win.webContents.session.protocol.handle('file', request => {
    if (request.url === fixture) return new Response(html, { headers: { 'content-type': 'text/html' } });
    const file = fileURLToPath(request.url);
    if (request.url === css || request.url === lyricsModule || request.url === lyricsParsers || file.startsWith(path.resolve(__dirname, '../assets/fonts') + path.sep)) {
      return new Response(fs.readFileSync(file), { headers: {
        'content-type': request.url === css ? 'text/css' : (request.url === lyricsModule || request.url === lyricsParsers) ? 'text/javascript' : 'font/otf'
      } });
    }
    return new Response('', { status: 403 });
  });
  await win.loadURL(fixture);
  const js = code => win.webContents.executeJavaScript(code);
  await js('document.fonts.ready');
  const point = await js(`(() => {
    const r = document.querySelector('.lyrics-word').getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`);
  const sample = async (position = point) => {
    await js('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))');
    const image = await win.webContents.capturePage({ ...position, width: 1, height: 1 });
    const pixel = image.toBitmap(); // BGRA on this host.
    return [pixel[2], pixel[1], pixel[0]];
  };
  let failed = 0;
  const check = async (name, background, blend = 'plus-lighter', alpha = 0.38) => {
    // Compare with a minimal browser-rendered blend, including the browser's
    // color handling, instead of assuming a screenshot's numeric color space.
    await js(`document.querySelector('#reference').style.background = 'rgb(${background.join(',')})';
      Object.assign(document.querySelector('#reference > div').style,
        { mixBlendMode: '${blend}', opacity: '${alpha}' })`);
    const actual = await sample();
    const expected = await sample({ x: 810, y: 610 });
    const ok = actual.every((channel, i) => Math.abs(channel - expected[i]) <= 3);
    console.log(JSON.stringify({ name, ok, actual, expected }));
    if (!ok) failed++;
  };
  for (const background of [[80, 30, 10], [10, 30, 80], [40, 40, 40]]) {
    await js(`document.querySelector('.backdrop').style.background = 'rgb(${background.join(',')})'`);
    await check('38% mask matches additive white over the local background', background);
  }
  // Prove that the test detects the previous stage isolation bug.
  await js(`document.querySelector('.stage').style.zIndex = '1'`);
  await check('isolated stage reproduces source-over dimming', [40, 40, 40], 'normal');
  await js(`document.querySelector('.stage').style.zIndex = 'auto';
    document.querySelector('.lyrics-word').style.setProperty('--fill', '1000px')`);
  await check('completed fill stays white', [40, 40, 40], 'plus-lighter', 1);
  // Compare painted text, not just the numeric frontier. A small per-word
  // offset can pass a timing test while leaving the visible fill unchanged.
  await js(`(async () => {
    document.querySelector('#compositing-fixture-style').remove();
    const style = document.createElement('style');
    style.textContent = \`
      body, .backdrop { background: black !important; }
      .backdrop { filter: none !important; transform: none !important; }
      .lyrics { inset: 0; width: 100%; height: 100%; }
      .lyrics-line { --lyrics-font-size: 64px; }
      #reference { display: none !important; }
    \`;
    document.head.append(style);
    const { LyricsView, parseLyrics } = await import(${JSON.stringify(lyricsModule)});
    window.parseFillLyrics = parseLyrics;
    window.fillView = new LyricsView(document.querySelector('.lyrics'));
    window.fillView.reduceMotion = { matches: false };
    window.fillView.setLyrics([
      { time: 0, end: 3, text: 'Held fast finish', words: [
        { time: 0, end: 2.8, text: 'Held ' },
        { time: 2.8, end: 2.9, text: 'fast ' },
        { time: 2.9, end: 3, text: 'finish' }
      ] },
      { time: 3, end: 6, text: 'Next line' }
    ], 2, 6, false);
  })()`);
  const paintFill = async (enabled, position, lineIndex = 0, wordIndex = -1) => {
    const rect = await js(`(() => {
      window.fillView.setAccelerateFill(${enabled});
      window.fillView.update(${position}, window.fillView.duration, false);
      const r = window.fillView.wordElements[${lineIndex}].at(${wordIndex}).getBoundingClientRect();
      return { x: Math.floor(r.left), y: Math.floor(r.top), width: Math.ceil(r.width), height: Math.ceil(r.height) };
    })()`);
    await js('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))');
    const painted = await win.webContents.capturePage(rect);
    const pixels = painted.toBitmap();
    let brightPixels = 0;
    let total = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      total += pixels[i + 1];
      if (pixels[i + 1] > 150) brightPixels += 1;
    }
    return { brightPixels, mean: total / (pixels.length / 4) };
  };
  for (const position of [2.4, 2.48]) {
    const natural = await paintFill(false, position);
    const accelerated = await paintFill(true, position);
    const ok = accelerated.brightPixels > natural.brightPixels * 1.2 && accelerated.mean > natural.mean + 2;
    console.log(JSON.stringify({ name: `handoff acceleration visibly fills upcoming text at ${position}s`, ok, natural, accelerated }));
    if (!ok) failed++;
  }
  const wrapped = await js(`(() => {
    const view = window.fillView;
    view.setAccelerateFill(true);
    view.setLyrics([
      { time: 0, end: 4, text: 'Silver go', words: [
        { time: 3.6, end: 3.8, text: 'Silver ' }, { time: 3.8, end: 4, text: 'go' }
      ] }, { time: 4, end: 7, text: 'Next phrase' }
    ], 1, 8, false);
    view.lineElements[0].style.fontSize = '40px';
    view.lineElements[0].querySelector('.lyrics-main-text').style.width = '130px';
    view.refreshMetrics();
    const geo = view.ensureLineFillGeometry(0);
    const fillWindow = view.fillAccelerationWindowFor(0, view.lines[0].words);
    return { rows: geo.runs.length, position: fillWindow.start + 0.15 };
  })()`);
  for (const wordIndex of [0, 1]) {
    const natural = await paintFill(false, wrapped.position, 0, wordIndex);
    const accelerated = await paintFill(true, wrapped.position, 0, wordIndex);
    const ok = wrapped.rows === 2 && accelerated.brightPixels > natural.brightPixels + 20 &&
      accelerated.mean > natural.mean + 2;
    console.log(JSON.stringify({ name: `wrapped visual row ${wordIndex + 1} visibly fills during the same sweep`, ok, natural, accelerated }));
    if (!ok) failed++;
  }
  if (process.env.YOURLYRICS_FILL_LYRICS) {
    const payload = JSON.parse(fs.readFileSync(process.env.YOURLYRICS_FILL_LYRICS, 'utf8'));
    for (const timestamp of [25.031, 29.426, 31.084]) {
      const fixture = await js(`(() => {
        const payload = ${JSON.stringify(payload)};
        const lines = window.parseFillLyrics(payload.text, payload.format);
        const index = lines.findIndex(line => Math.abs(line.time - ${timestamp}) < 0.001);
        if (index < 0) throw new Error('Missing timed phrase at ${timestamp}s');
        window.fillView.setAccelerateFill(true);
        window.fillView.setLyrics(lines, lines[index].time + 0.01, 219, false);
        const fillWindow = window.fillView.fillAccelerationWindowFor(index, lines[index].words);
        return { index, position: fillWindow.start + 0.2, start: fillWindow.start, end: fillWindow.end };
      })()`);
      const natural = await paintFill(false, fixture.position, fixture.index);
      const accelerated = await paintFill(true, fixture.position, fixture.index);
      const ok = accelerated.brightPixels > natural.brightPixels + 50 && accelerated.mean > natural.mean + 2;
      console.log(JSON.stringify({ name: `cached rapid phrase at ${timestamp}s visibly accelerates`, ok, fixture, natural, accelerated }));
      if (!ok) failed++;
      const handoff = await js(`(() => {
        const view = window.fillView;
        view.update(${fixture.end - 0.001}, view.duration, true);
        const before = view.lineStates[${fixture.index + 1}].y.target;
        view.update(${fixture.end + 0.001}, view.duration, true);
        const spring = view.lineStates[${fixture.index + 1}].y;
        return { anchor: view.anchorIndex, delay: spring.queuedDelay,
          targetChange: Math.abs((spring.queuedTarget ?? spring.target) - before) };
      })()`);
      const handoffOk = handoff.anchor === fixture.index + 1 && handoff.delay > 0 && handoff.targetChange > 0.01;
      console.log(JSON.stringify({ name: `cached rapid phrase at ${timestamp}s queues the staggered handoff at fill completion`, ok: handoffOk, handoff }));
      if (!handoffOk) failed++;
    }
  }
  const backingFixture = await js(`(() => {
    const view = window.fillView;
    view.setAccelerateFill(false);
    view.setLyrics([
      { time: 0, end: 6, text: 'Lead vocal', backgroundText: 'Ooh yeah', backgroundWords: [
        { time: 1, end: 3, text: 'Ooh ' }, { time: 4, end: 5, text: 'yeah' }
      ] }, { time: 7, end: 10, text: 'Next phrase' }
    ], 0.1, 10, false);
    view.refreshMetrics();
    const word = view.backgroundWordElements[0][0];
    const r = word.getBoundingClientRect();
    return { x: Math.floor(r.left), y: Math.floor(r.top), width: Math.ceil(r.width), height: Math.ceil(r.height) };
  })()`);
  const backingPaint = [];
  for (const position of [0.5, 3.8]) {
    await js(`window.fillView.updateBackgroundLineFill(0, ${position});
      new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))`);
    const pixels = (await win.webContents.capturePage(backingFixture)).toBitmap();
    let total = 0;
    let brightPixels = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      total += pixels[index + 1];
      if (pixels[index + 1] > 60) brightPixels++;
    }
    backingPaint.push({ mean: total / (pixels.length / 4), brightPixels });
  }
  const [unsungBacking, sungBacking] = backingPaint;
  const backingPaintOk = sungBacking.mean > unsungBacking.mean + 2 &&
    sungBacking.brightPixels > unsungBacking.brightPixels + 20;
  console.log(JSON.stringify({ name: 'backing fill visibly brightens the sung word without emphasis',
    ok: backingPaintOk, unsungBacking, sungBacking }));
  if (!backingPaintOk) failed++;
  const backingExitMask = await js(`(() => {
    const view = window.fillView;
    view.applyClasses([]);
    return getComputedStyle(view.backgroundWordMotions[0][0].element).maskImage !== 'none';
  })()`);
  console.log(JSON.stringify({ name: 'outgoing backing words retain their mask when the untimed lead deactivates', ok: backingExitMask }));
  if (!backingExitMask) failed++;
  if (process.env.YOURLYRICS_FILL_PREVIEW) {
    fs.writeFileSync(process.env.YOURLYRICS_FILL_PREVIEW, (await win.webContents.capturePage()).toPNG());
  }
  win.destroy();
  app.exit(failed ? 1 : 0);
}

if (process.versions.electron) {
  run().catch(error => { console.error(error); require('electron').app.exit(2); });
} else {
  const { spawnSync } = require('node:child_process');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'yourlyrics-compositing-'));
  try {
    const env = { ...process.env, YOURLYRICS_COMPOSITING_PROFILE: profile };
    delete env.ELECTRON_RUN_AS_NODE;
    const result = spawnSync(require('electron'), [__filename], { env, stdio: 'inherit', timeout: 20000 });
    process.exitCode = result.status ?? 2;
  } finally {
    fs.rmSync(profile, { recursive: true, force: true });
  }
}
