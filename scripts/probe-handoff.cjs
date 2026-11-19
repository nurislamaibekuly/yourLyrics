'use strict';

// Probe: drive the real LyricsView across a word-timed line hand-off and
// record active set, anchor, classes and fill for every step.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const repo = path.resolve(__dirname, '..');

async function checkRenderer(moduleURL) {
  const { LyricsView } = await import(moduleURL);
  await document.fonts.load('700 40px "SF Pro Display"');
  await document.fonts.ready;
  const view = new LyricsView(document.querySelector('.lyrics'));
  const lines = [
    { time: 0, end: 10, text: 'aa bb',
      words: [{ time: 8.5, end: 9, text: 'aa' }, { time: 9, end: 10, text: 'bb' }] },
    { time: 10.4, end: 12, text: 'cc dd',
      words: [{ time: 10.4, end: 11, text: 'cc' }, { time: 11, end: 12, text: 'dd' }] }
  ];
  view.setLyrics(lines, 9.5, 15, true);
  const rows = [];
  for (let position = 9.5; position <= 10.45; position += 0.00625) {
    const pos = Math.round(position * 10000) / 10000;
    view.update(pos, 15, true);
    const wordEls = view.wordElements.map(els => els?.map(el => el.style.getPropertyValue('--fill')));
    rows.push({
      pos,
      active: view.activeIndices.join(','),
      isLine0Active: view.lineElements[0]?.classList.contains('is-active'),
      fill0: wordEls[0]?.join('|'),
      rush: view.fillRushes[0]
    });
  }
  view.resizeObserver.disconnect();
  view.clear();
  return rows;
}

async function runElectron() {
  const { app, BrowserWindow, session } = require('electron');
  const profile = process.env.YOURLYRICS_LAYOUT_PROFILE;
  if (!profile || !path.basename(profile).startsWith('yourlyrics-layout-')) {
    throw new Error('Missing disposable test profile');
  }
  for (const name of ['userData', 'sessionData', 'logs', 'crashDumps']) app.setPath(name, profile);
  app.commandLine.appendSwitch('disable-background-networking');
  app.commandLine.appendSwitch('disable-component-update');
  const deadline = setTimeout(() => { console.error('Probe timed out'); app.exit(2); }, 25000);
  try {
    await app.whenReady();
    const renderer = path.join(repo, 'src/renderer');
    const base = pathToFileURL(renderer + path.sep).href;
    const fixture = pathToFileURL(path.join(profile, 'fixture.html')).href;
    const assets = new Map();
    for (const [file, type] of [
      [path.join(renderer, 'lyrics.js'), 'text/javascript'],
      [path.join(renderer, 'styles.css'), 'text/css'],
      ...['Regular', 'Medium', 'Bold'].map(weight =>
        [path.join(repo, 'assets/fonts', `SF-Pro-Display-${weight}.otf`), 'font/otf'])
    ]) assets.set(pathToFileURL(file).href, { bytes: fs.readFileSync(file), type });
    assets.set(fixture, { type: 'text/html', bytes: `<!doctype html><html><head>
      <meta charset="utf-8"><base href="${base}"><link rel="stylesheet" href="styles.css">
      </head><body><div class="lyrics"><div class="lyrics-mask"><div class="lyrics-track"></div></div></div></body></html>` });
    const isolated = session.fromPartition(`lyrics-layout-${process.pid}`, { cache: false });
    isolated.webRequest.onBeforeRequest((details, callback) => {
      callback({ cancel: !assets.has(details.url) });
    });
    isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    isolated.protocol.handle('file', request => {
      const asset = assets.get(request.url);
      return asset ? new Response(asset.bytes, { headers: { 'content-type': asset.type } }) :
        new Response('Not a test asset', { status: 403 });
    });
    const win = new BrowserWindow({ show: false, width: 1000, height: 800, useContentSize: true,
      webPreferences: { session: isolated, nodeIntegration: false, contextIsolation: true,
        sandbox: true, backgroundThrottling: false } });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    await win.loadURL(fixture);
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }]
    });
    const rows = await win.webContents.executeJavaScript(
      `(${checkRenderer.toString()})(${JSON.stringify(base + 'lyrics.js')})`);
    for (const row of rows) console.log(JSON.stringify(row));
    win.destroy();
    app.exit(0);
  } finally {
    clearTimeout(deadline);
  }
}

if (process.versions.electron) {
  runElectron().catch(error => { console.error(error); require('electron').app.exit(2); });
} else {
  const { spawnSync } = require('node:child_process');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'yourlyrics-layout-'));
  try {
    const env = { ...process.env, YOURLYRICS_LAYOUT_PROFILE: profile };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.NODE_OPTIONS;
    const result = spawnSync(require('electron'), [__filename], {
      env, stdio: 'inherit', timeout: 30000, killSignal: 'SIGKILL'
    });
    if (result.error) console.error(result.error);
    process.exitCode = result.status ?? 2;
  } finally {
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}
