const { app, BrowserWindow, ipcMain, shell } = require('electron');
const { isNewerVersion } = require('./update-version');

// Releases live in a separate repository from the source, so the check hits
// that repo's latest release rather than anything derived from the git remote.
const releasesApi = 'https://api.github.com/repos/nurislamaibekuly/yourLyrics/releases/latest';
const userAgent = 'yourLyrics (https://github.com/nurislamaibekuly/yourLyrics)';
const requestTimeoutMs = 7000;

// electron-updater needs a packaged build: outside packaging there is no
// app-update.yml to resolve the update feed from, and macOS builds are
// unsigned, which Squirrel.Mac refuses to install. Those cases fall back to
// opening the release page in the browser.
function canAutoUpdate() {
  return app.isPackaged && (process.platform === 'win32' || process.platform === 'linux');
}

// The last release seen from the check; the install step replays its URL so
// the renderer never has to pass a navigation target across the bridge.
let lastRelease = null;
let updaterBound = false;
// Reassigned on every install so a recreated window (macOS activate) still
// receives progress events after the listeners were bound once.
let updateWindow = null;

function notify(channel, payload) {
  if (updateWindow && !updateWindow.isDestroyed()) {
    updateWindow.webContents.send(channel, payload);
  }
}

function bindUpdater() {
  if (updaterBound) {
    return;
  }
  updaterBound = true;
  // Lazy require: the module is only meaningful for the auto-update path, and
  // requiring it at registration time would load it on macOS as well.
  const { autoUpdater } = require('electron-updater');
  autoUpdater.autoDownload = true;
  // Installing is always an explicit user action from the alert; quitting into
  // an installer on its own would interrupt playback.
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.on('download-progress', progress => {
    notify('updates:progress', {
      percent: Number.isFinite(progress?.percent) ? progress.percent : 0
    });
  });
  autoUpdater.on('update-downloaded', () => {
    notify('updates:downloaded', {});
  });
  autoUpdater.on('update-not-available', () => {
    notify('updates:failed', { reason: 'no-update' });
  });
  autoUpdater.on('error', () => {
    notify('updates:failed', { reason: 'error' });
  });
}

async function fetchLatestRelease() {
  const response = await fetch(releasesApi, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': userAgent
    },
    signal: AbortSignal.timeout(requestTimeoutMs)
  });
  if (!response.ok) {
    return null;
  }
  const body = await response.json();
  if (!body || typeof body.tag_name !== 'string') {
    return null;
  }
  return {
    version: body.tag_name.replace(/^v/, ''),
    notes: typeof body.body === 'string' ? body.body : '',
    // The update card shows this where iOS Settings shows the download size;
    // the installer assets are the bulk of it, so their total is the honest
    // number to quote.
    size: Array.isArray(body.assets)
      ? body.assets.reduce((total, asset) =>
          total + (Number.isFinite(asset && asset.size) ? asset.size : 0), 0)
      : 0,
    htmlUrl: typeof body.html_url === 'string' ? body.html_url : ''
  };
}

async function checkForUpdate() {
  const currentVersion = app.getVersion();
  let release;
  try {
    release = await fetchLatestRelease();
  } catch {
    return null;
  }
  if (!release || !release.htmlUrl) {
    return null;
  }
  const updateAvailable = isNewerVersion(release.version, currentVersion);
  lastRelease = updateAvailable ? release : null;
  return {
    ok: true,
    updateAvailable,
    version: release.version,
    notes: release.notes,
    size: release.size,
    currentVersion
  };
}

function registerUpdateCheckIpc() {
  ipcMain.handle('updates:check', () => checkForUpdate());

  ipcMain.handle('updates:version', () => app.getVersion());

  // The card's "Learn more…" link. The URL stays in main: the renderer asks
  // for the release page it was just told about, never for a target of its own.
  ipcMain.handle('updates:open-release', () => {
    if (!lastRelease || !lastRelease.htmlUrl) {
      return { ok: false };
    }
    shell.openExternal(lastRelease.htmlUrl).catch(() => {});
    return { ok: true };
  });

  ipcMain.handle('updates:install', async event => {
    const release = lastRelease;
    if (!release) {
      return { ok: false, mode: 'none' };
    }
    if (!canAutoUpdate()) {
      shell.openExternal(release.htmlUrl).catch(() => {});
      return { ok: true, mode: 'browser' };
    }
    const window = BrowserWindow.fromWebContents(event.sender);
    updateWindow = window;
    bindUpdater();
    try {
      const { autoUpdater } = require('electron-updater');
      await autoUpdater.checkForUpdates();
      return { ok: true, mode: 'download' };
    } catch {
      // A missing or malformed update feed still leaves the user a way to
      // update: the release page they would have opened anyway.
      shell.openExternal(release.htmlUrl).catch(() => {});
      return { ok: true, mode: 'browser' };
    }
  });

  ipcMain.handle('updates:restart', () => {
    if (!canAutoUpdate()) {
      return { ok: false };
    }
    try {
      const { autoUpdater } = require('electron-updater');
      autoUpdater.quitAndInstall();
      return { ok: true };
    } catch {
      return { ok: false };
    }
  });
}

module.exports = { registerUpdateCheckIpc };
