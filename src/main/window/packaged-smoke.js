'use strict';

const fs = require('node:fs');
const path = require('node:path');

// This stays a string because the main process ships as bytecode, where
// Function.prototype.toString() cannot recover a function's source code.
const rendererCheck = `(async () => {
  const deadline = performance.now() + 10000;
  while (document.body.hidden || document.body.classList.contains('is-startup-pending')) {
    if (performance.now() >= deadline) throw new Error('Renderer did not finish startup');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  await document.fonts.ready;
  if (!window.app?.nowPlaying?.get || !window.app?.updates?.version) {
    throw new Error('Sandboxed preload bridge is missing');
  }
  const state = await window.app.nowPlaying.get();
  const version = await window.app.updates.version();
  const canvas = document.querySelector('.backdrop');
  if (!state || typeof state.title !== 'string' || !version) {
    throw new Error('Main-process IPC did not return valid startup data');
  }
  // The player deliberately removes its canvas when WebGL is unavailable.
  // Hosted Intel Mac runners exercise that supported static fallback.
  if ((canvas && (canvas.width <= 0 || canvas.height <= 0)) ||
      !document.querySelector('.lyrics-track') || !document.querySelector('.artwork') ||
      !document.querySelector('.progress')) {
    throw new Error('Player surfaces were not initialized');
  }
  if (!document.fonts.check('400 16px "SF Pro Display"')) {
    throw new Error('Bundled player font did not load');
  }
  return { version, preload: true, renderer: true, ipc: true, backdrop: canvas ? 'animated' : 'fallback' };
})()`;

function createPackagedSmokeCheck(app, { argv = process.argv, env = process.env } = {}) {
  if (!argv.includes('--smoke-test')) return null;
  const profile = env.YOURLYRICS_SMOKE_PROFILE;
  if (!app.isPackaged || !profile || !path.isAbsolute(profile) ||
      !path.basename(profile).startsWith('yourlyrics-packaged-')) {
    throw new Error('Packaged startup checks require a disposable test profile');
  }
  // Every Chromium path belongs to this run, so the check never opens the
  // user's settings, cache, cookies or crash reports.
  for (const name of ['userData', 'sessionData', 'logs', 'crashDumps']) {
    const directory = path.join(profile, name);
    fs.mkdirSync(directory, { recursive: true });
    app.setPath(name, directory);
  }

  let finished = false;
  const errors = [];
  const deadline = setTimeout(() => finish(new Error('Packaged startup timed out')), 25000);

  function finish(error, checks) {
    if (finished) return;
    finished = true;
    clearTimeout(deadline);
    const report = {
      ok: !error,
      packaged: app.isPackaged,
      platform: process.platform,
      arch: process.arch,
      electron: process.versions.electron,
      version: app.getVersion(),
      checks,
      error: error ? String(error.stack || error) : undefined
    };
    let code = error ? 1 : 0;
    try {
      fs.writeFileSync(path.join(profile, 'result.json'), JSON.stringify(report, null, 2));
    } catch (writeError) {
      console.error('[packaged-check]', writeError);
      code = 1;
    }
    app.exit(code);
  }

  process.once('uncaughtException', error => finish(error));
  process.once('unhandledRejection', error => finish(error instanceof Error ? error : new Error(String(error))));

  return {
    observe(win) {
      const contents = win.webContents;
      contents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      contents.session.webRequest.onBeforeRequest((details, callback) => {
        callback({ cancel: !/^(file|data):/.test(details.url) });
      });
      contents.on('preload-error', (_event, _file, error) => finish(error));
      contents.on('render-process-gone', (_event, details) => finish(new Error(`Renderer exited: ${details.reason}`)));
      contents.on('did-fail-load', (_event, code, description, _url, mainFrame) => {
        if (mainFrame) finish(new Error(`Page load failed (${code}): ${description}`));
      });
      contents.on('console-message', event => {
        if (event.level === 'error') errors.push(event.message);
      });
      contents.once('did-finish-load', async () => {
        try {
          const checks = await contents.executeJavaScript(rendererCheck);
          if (errors.length) throw new Error(errors.join('\n'));
          if (checks.version !== app.getVersion()) throw new Error('Renderer version does not match the packaged app');
          if (contents.getLastWebPreferences().devTools === true) throw new Error('Packaged DevTools must remain disabled');
          finish(null, checks);
        } catch (error) {
          finish(error);
        }
      });
    }
  };
}

module.exports = { createPackagedSmokeCheck, rendererCheck };
