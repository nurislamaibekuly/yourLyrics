'use strict';

// Exercise the real Settings sheet and overlay with a disposable profile and
// synthetic media. The hidden window never starts a native media provider.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const root = path.resolve(__dirname, '..');

async function run() {
  const { app, BrowserWindow, ipcMain, session } = require('electron');
  const profile = process.env.YOURLYRICS_DEVELOPER_PROFILE;
  if (!profile || !path.basename(profile).startsWith('yourlyrics-developer-')) throw Error('Missing disposable profile');
  for (const name of ['userData', 'sessionData', 'logs', 'crashDumps']) app.setPath(name, profile);
  app.commandLine.appendSwitch('disable-background-networking');
  const deadline = setTimeout(() => { console.error('Developer tools test timed out'); app.exit(2); }, 30000);
  await app.whenReady();
  const media = { title: 'Synthetic timing', artist: 'Fixture', album: 'Test', source: 'synthetic',
    positionSeconds: 2, durationSeconds: 20, playing: false, controlsAvailable: true };
  const noop = () => ({ ok: true });
  const handlers = {
    'now-playing:get': () => media, 'now-playing:refresh': noop, 'now-playing:set-artwork-fallback': noop,
    'lyrics:get': () => ({ text: '[00:00.00]<00:00.00>First <00:03.00>phrase\n[00:06.00]<00:06.00>Following <00:09.00>words', source: 'fixture' }),
    'animated-art:get': () => null, 'theme:set': noop,
    'discord:status': () => ({ state: 'disabled' }), 'discord:set-settings': noop,
    'updates:check': () => ({}), 'updates:version': () => '0.3.1',
    'window:set-ui-style': noop, 'window:set-ui-scale': () => ({ scale: 1 }),
    'window:get-ui-scale': () => ({ scale: 1 }),
    'window:is-pinned': () => ({ alwaysOnTop: false }),
    'window:get-state': () => ({ maximized: false, fullscreen: false, alwaysOnTop: false })
  };
  for (const [name, handler] of Object.entries(handlers)) ipcMain.handle(name, handler);
  const isolated = session.fromPartition(`developer-test-${process.pid}`, { cache: false });
  const blocked = [];
  isolated.webRequest.onBeforeRequest((details, callback) => {
    let allowed = details.url.startsWith('data:') || details.url.startsWith('blob:');
    if (details.url.startsWith('file:')) {
      const file = fileURLToPath(details.url);
      allowed = ['src', 'assets'].some(dir => file.startsWith(path.join(root, dir) + path.sep)) ||
        file === path.join(root, 'node_modules/hls.js/dist/hls.mjs');
    }
    if (!allowed) blocked.push(details.url);
    callback({ cancel: !allowed });
  });
  const win = new BrowserWindow({ show: false, width: 1080, height: 900,
    webPreferences: { session: isolated, preload: path.join(root, 'src/preload/index.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
  const errors = [];
  win.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message); });
  const js = code => win.webContents.executeJavaScript(code);
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async code => {
    const end = Date.now() + 5000;
    while (Date.now() < end) { if (await js(code)) return; await wait(50); }
    throw Error(`Timed out: ${code}; errors=${errors.join(' | ')}`);
  };
  try {
    await win.loadFile(path.join(root, 'src/renderer/index.html'));
    await until(`!document.body.hidden`);
    await js(`localStorage.setItem('yourlyrics:settings', JSON.stringify({ disableSolarium: true })); location.reload();`);
    await until(`!document.body.hidden && document.querySelector('.lyrics-line')`);
    await js(`document.querySelector('.metadata-menu').click()`);
    await until(`[...document.querySelectorAll('.menuview button')].some(b => b.textContent.trim() === 'Settings')`);
    await js(`[...document.querySelectorAll('.menuview button')].find(b => b.textContent.trim() === 'Settings').click()`);
    await until(`Boolean(document.querySelector('[data-action="version"]'))`);
    await js(`document.querySelector('[data-action="version"]').click()`);
    assert.equal(await js(`document.querySelector('.developer-settings').hidden`), true);
    await js(`for (let i = 0; i < 7; i++) document.querySelector('[data-action="version"]').click()`);
    await until(`Boolean(document.querySelector('.alertview button'))`);
    await js(`document.querySelector('.alertview button').click()`);
    await wait(800);
    await js(`window.__devRow = label => [...document.querySelectorAll('.developer-settings .sheet-row')]
      .find(row => row.querySelector(':scope > span')?.textContent === label || row.textContent === label);
      window.__devToggle = label => window.__devRow(label).querySelector('input').click();
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.__copiedReport = JSON.parse(text); } } });`);
    assert.equal(await js(`document.querySelectorAll('.developer-settings input').length`), 6);
    assert.equal(await js(`[...document.querySelectorAll('.developer-settings input')].every(input => input.getAttribute('aria-label'))`), true);
    await js(`__devToggle('Playback clock inspector'); __devToggle('Lyric fill inspector'); __devToggle('Show lyric layout bounds');`);
    await until(`document.querySelector('.developer-overlay').textContent.includes('Lyric inspector')`);
    assert.equal(await js(`document.body.classList.contains('has-developer-bounds')`), true);
    assert.equal(await js(`document.querySelector('.developer-overlay').textContent.includes('Rate 0.000')`), true);
    await js(`__devRow('Overlay position').click()`);
    await until(`[...document.querySelectorAll('.menuview button')].some(b => b.textContent.trim() === 'Bottom left')`);
    await js(`[...document.querySelectorAll('.menuview button')].find(b => b.textContent.trim() === 'Bottom left').click()`);
    await until(`document.querySelector('.developer-overlay').dataset.corner === 'bottom-left'`);
    await js(`__devToggle('Freeze overlay'); window.__frozenText = document.querySelector('.developer-overlay').textContent;`);
    win.webContents.send('now-playing:changed', { ...media, positionSeconds: 3 });
    await wait(700);
    assert.equal(await js(`document.querySelector('.developer-overlay').textContent === window.__frozenText`), true);
    await js(`__devRow('Copy diagnostic report').click()`);
    await until(`Boolean(window.__copiedReport)`);
    const copied = await js('window.__copiedReport');
    assert.equal(copied.playback, undefined);
    assert.equal(copied.current.playback.rendererSeconds, 3);
    assert.equal(copied.frozen, true);
    assert.equal(copied.current.lyrics.lineCount, 2);
    assert.ok(copied.current.lyrics.lines[0].masks.length > 0);
    await js(`__devToggle('Freeze overlay')`);
    await until(`document.querySelector('.developer-overlay').textContent.includes('Renderer 3.000 s')`);
    await js(`__devRow('Record timing trace (10 seconds)').click()`);
    await wait(350);
    await js(`__devRow('Stop timing recording').click()`);
    await js(`window.__copiedReport = null; __devRow('Copy diagnostic report').click()`);
    await until(`Boolean(window.__copiedReport)`);
    assert.ok(await js(`window.__copiedReport.trace.samples.length >= 3 && !window.__copiedReport.trace.recording`));
    const downloaded = new Promise((resolve, reject) => isolated.once('will-download', (_event, item) => {
      const output = path.join(profile, 'report.json');
      item.setSavePath(output);
      item.once('done', (_event, state) => state === 'completed'
        ? resolve(JSON.parse(fs.readFileSync(output, 'utf8'))) : reject(Error(state)));
    }));
    await js(`__devRow('Download diagnostic report').click()`);
    const report = await downloaded;
    assert.equal(report.schemaVersion, 1);
    assert.ok(report.trace.samples.length >= 3);
    assert.equal(report.current.app.version, '0.3.1');
    if (process.env.YOURLYRICS_DEVELOPER_PREVIEW) {
      await js(`document.querySelector('.developer-settings').scrollIntoView({block:'start'})`);
      await wait(350);
      fs.writeFileSync(process.env.YOURLYRICS_DEVELOPER_PREVIEW, (await win.webContents.capturePage()).toPNG());
    }
    await js(`__devRow('Reset developer preferences').click()`);
    await wait(750);
    assert.equal(await js(`document.querySelector('.developer-overlay').hidden && !document.body.classList.contains('has-developer-bounds')`), true);
    assert.equal(await js(`JSON.parse(localStorage.getItem('yourlyrics:settings')).disableSolarium`), true);
    await js(`__devRow('Disable developer mode').click()`);
    await wait(750);
    assert.equal(await js(`document.querySelector('.developer-settings').hidden`), true);
    assert.equal(await js(`JSON.parse(localStorage.getItem('yourlyrics:developer')).enabled`), false);
    assert.deepEqual(errors, []);
    assert.deepEqual(blocked, []);
    console.log('Developer Settings, paused inspectors, freeze, layout bounds, timing recording, clipboard and download checks passed.');
  } finally {
    clearTimeout(deadline);
    win.destroy();
  }
  app.exit(0);
}

if (process.versions.electron) {
  run().catch(error => { console.error(error); require('electron').app.exit(1); });
} else {
  const { spawnSync } = require('node:child_process');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'yourlyrics-developer-'));
  try {
    const env = { ...process.env, YOURLYRICS_DEVELOPER_PROFILE: profile };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.NODE_OPTIONS;
    const result = spawnSync(require('electron'), [__filename], { env, stdio: 'inherit', timeout: 35000, killSignal: 'SIGKILL' });
    if (result.error) console.error(result.error);
    process.exitCode = result.status ?? 1;
  } finally { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
}
