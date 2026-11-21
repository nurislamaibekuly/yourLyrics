const { app, BrowserWindow, Menu, clipboard, ClipboardItem, dialog, nativeImage, nativeTheme, ipcMain, shell, screen } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { createWindowStyleController } = require('./window/window-style');
const { createPackagedSmokeCheck } = require('./window/packaged-smoke');
const { initLogger, attachWindowLogs, flushLogs } = require('./window/logger');
const packagedSmokeCheck = createPackagedSmokeCheck(app);
initLogger(app);

// Packaged builds refuse remote-debugging / inspector switches so an extracted
// copy cannot be reattached to Chrome DevTools Protocol. The electron fuses
// already kill --inspect*; this covers --remote-debugging-port / -pipe, which
// the fuses do not touch.
if (app.isPackaged && process.argv.some(arg => arg.startsWith('--remote-debugging'))) {
  app.exit(0);
}
const mediaProvider =
  process.platform === 'darwin'
    ? require('./media/media-remote')
    : process.platform === 'win32'
      ? require('./media/windows-media')
      : process.platform === 'linux'
        ? require('./media/linux-media')
        : null;
const { registerNowPlayingIpc } = require('./media/now-playing');
const { registerLyricsIpc } = require('./lyrics');
const { registerAnimatedArtIpc } = require('./media/animated-art');
const { registerUpdateCheckIpc } = require('./updates/update-check');
const { startLoudness, stopLoudness } = require('./audio/loudness');
const { registerDiscordRpcIpc, stopDiscordRpc } = require('./discord/discord-rpc');

// Runtime icon loads must be PNG/JPEG — Electron's nativeImage cannot read
// .icns. icon.icns stays alongside it for future packaging.
const iconPath = path.join(__dirname, '../../assets/icon.png');

// In development the Dock shows Electron's own icon; in a packaged build the
// bundle's icns wins (and macOS renders it adaptively from the .icon source).
// Calling setIcon() at runtime would override the adaptive icon, so only do
// it during development.
function applyAppIcon() {
  if (process.platform !== 'darwin' || !app.dock || app.isPackaged) {
    return;
  }
  const icon = nativeImage.createFromPath(iconPath);
  if (!icon.isEmpty()) {
    app.dock.setIcon(icon);
  }
}

function startMediaProvider() {
  if (process.platform === 'darwin') {
    mediaProvider.startMediaRemote();
  } else if (process.platform === 'win32') {
    mediaProvider.startWindowsMedia();
  } else if (process.platform === 'linux') {
    mediaProvider.startLinuxMedia();
  }
}

function stopMediaProvider() {
  if (process.platform === 'darwin') {
    mediaProvider.stopMediaRemote();
  } else if (process.platform === 'win32') {
    mediaProvider.stopWindowsMedia();
  } else if (process.platform === 'linux') {
    mediaProvider.stopLinuxMedia();
  }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1335,
    height: 935,
    minWidth: 800,
    minHeight: 600,
    title: 'yourLyrics',
    // Transparency is what makes the area outside the drawn radius empty
    // instead of black. macOS keeps its real traffic lights by hiding the
    // title bar rather than removing the frame; Windows and Linux go frameless
    // and draw their own controls. The OS corner mask is always tighter than
    // the stylesheet radius, so the visible shape is still the CSS one.
    transparent: true,
    backgroundColor: '#00000000',
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'darwin'
      ? {
          titleBarStyle: 'hidden',
          trafficLightPosition: { x: 19, y: 19 }
        }
      : {
          frame: false,
          roundedCorners: false,
          // Windows and Linux compositors read the taskbar icon from the
          // running window, not from the packaged desktop entry.
          icon: iconPath
        }),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      devTools: !app.isPackaged,
      // Allow Chromium to throttle timers, RAF, and video decoding when the
      // window is minimized, hidden, or occluded to prevent sustained heat.
      backgroundThrottling: true,
      zoomFactor: 1
    }
  });
  attachWindowLogs(win);

  // On macOS, native titlebar buttons are hidden so the app's unified traffic
  // lights (with hover-reveal, smooth fade, and window pin) render consistently
  // across macOS, Windows and Linux.
  if (process.platform === 'darwin' && typeof win.setWindowButtonVisibility === 'function') {
    win.setWindowButtonVisibility(false);
  }

  // Wait for the first paint: a transparent window has no background to show
  // while the document is still hidden, so showing it earlier would flash an
  // invisible window before the rounded page appears.
  if (!packagedSmokeCheck) win.once('ready-to-show', () => win.show());

  // Strip default menu so Ctrl+R / F5 (reload) and Ctrl+= / Ctrl+- (zoom) are gone.
  // Keep a minimal menu on macOS so Cmd+C / Cmd+V etc. still work.
  if (process.platform === 'darwin') {
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { role: 'appMenu' },
      { role: 'editMenu' }
    ]));
  } else {
    Menu.setApplicationMenu(null);
  }

  // Restore fullscreen explicitly because the default View menu is removed.
  // Also block zoom/reload via webContents.
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown') {
      const macFullscreen = process.platform === 'darwin' &&
        input.control && input.meta && !input.alt && !input.shift &&
        input.key.toLowerCase() === 'f';
      if (input.key === 'F11' || macFullscreen) {
        event.preventDefault();
        if (!input.isAutoRepeat) {
          win.setFullScreen(!win.isFullScreen());
        }
        return;
      }
      const mod = process.platform === 'darwin' ? input.meta : input.ctrl;
      if (mod && (input.key === '+' || input.key === '-' || input.key === '=' || input.key === '0')) {
        event.preventDefault();
      }
      if (input.key === 'F5' || (mod && input.key.toLowerCase() === 'r')) {
        event.preventDefault();
      }
    }
  });

  // Enforce the user's configured UI scale on load and whenever Chromium
  // attempts an ad-hoc zoom change (e.g. pinch-to-zoom).
  const applyZoom = () => {
    if (!win.isDestroyed()) {
      win.webContents.setZoomFactor(windowUiScales.get(win) ?? 1);
    }
  };
  win.webContents.on('did-finish-load', applyZoom);
  win.webContents.on('zoom-changed', applyZoom);

  // The renderer needs the maximize state for the green traffic light's
  // "restore" glyph, and both maximize and fullscreen make the window flush
  // with the screen, where the drawn rounded corners must disappear.
  const sendWindowState = () => {
    if (win.isDestroyed()) {
      return;
    }
    win.webContents.send('window:maximized-changed', win.isMaximized());
    win.webContents.send('window:always-on-top-changed', win.isAlwaysOnTop());
    win.webContents.send('window:state-changed', {
      maximized: win.isMaximized(),
      fullscreen: win.isFullScreen(),
      alwaysOnTop: win.isAlwaysOnTop()
    });
  };
  win.on('maximize', sendWindowState);
  win.on('unmaximize', sendWindowState);
  win.on('enter-full-screen', sendWindowState);
  win.on('leave-full-screen', () => {
    if (process.platform === 'darwin' && typeof win.setWindowButtonVisibility === 'function') {
      win.setWindowButtonVisibility(false);
    }
    sendWindowState();
  });
  win.on('always-on-top-changed', sendWindowState);

  packagedSmokeCheck?.observe(win);
  win.loadFile(path.join(__dirname, '../renderer/index.html'));
}

if (process.platform === 'win32') {
  app.setAppUserModelId('com.nurislamaibekuly.yourlyrics');
}

const windowUiScales = new WeakMap();

function normalizeUiScale(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 1;
  }
  return Math.round(Math.min(1.5, Math.max(0.75, numeric)) * 100) / 100;
}

// Window controls for the frameless titlebar. Resolved from the sender's own
// window so a second window could never be driven by the first.
function registerWindowIpc() {
  const windowFor = event => BrowserWindow.fromWebContents(event.sender);
  const windowStyle = createWindowStyleController(screen);

  ipcMain.handle('window:set-ui-style', (event, style, options) => windowStyle.set(windowFor(event), style, options));

  ipcMain.handle('window:set-ui-scale', (event, scale) => {
    const win = windowFor(event);
    if (!win || win.isDestroyed()) {
      return { ok: false, scale: 1 };
    }
    const nextScale = normalizeUiScale(scale);
    windowUiScales.set(win, nextScale);
    win.webContents.setZoomFactor(nextScale);
    return { ok: true, scale: nextScale };
  });

  ipcMain.handle('window:get-ui-scale', event => {
    const win = windowFor(event);
    return { ok: true, scale: (win && windowUiScales.get(win)) ?? 1 };
  });

  ipcMain.handle('window:minimize', event => {
    windowFor(event)?.minimize();
    return { ok: true };
  });

  ipcMain.handle('window:toggle-maximize', event => {
    const win = windowFor(event);
    if (!win) {
      return { ok: false };
    }
    if (win.isMaximized()) {
      win.unmaximize();
    } else {
      win.maximize();
    }
    return { ok: true, maximized: win.isMaximized() };
  });

  ipcMain.handle('window:close', event => {
    windowFor(event)?.close();
    return { ok: true };
  });

  ipcMain.handle('window:is-maximized', event => ({
    ok: true,
    maximized: Boolean(windowFor(event)?.isMaximized())
  }));

  ipcMain.handle('window:get-state', event => {
    const win = windowFor(event);
    return win
      ? {
          ok: true,
          maximized: win.isMaximized(),
          fullscreen: win.isFullScreen(),
          alwaysOnTop: win.isAlwaysOnTop()
        }
      : { ok: false, maximized: false, fullscreen: false, alwaysOnTop: false };
  });

  ipcMain.handle('window:is-pinned', event => ({
    ok: true,
    alwaysOnTop: Boolean(windowFor(event)?.isAlwaysOnTop())
  }));

  ipcMain.handle('window:set-always-on-top', (event, flag) => {
    const win = windowFor(event);
    if (!win) {
      return { ok: false, alwaysOnTop: false };
    }
    const pinned = Boolean(flag);
    win.setAlwaysOnTop(pinned);
    const alwaysOnTop = win.isAlwaysOnTop();
    win.webContents.send('window:always-on-top-changed', alwaysOnTop);
    win.webContents.send('window:state-changed', {
      maximized: win.isMaximized(),
      fullscreen: win.isFullScreen(),
      alwaysOnTop
    });
    return { ok: true, alwaysOnTop };
  });

  ipcMain.handle('window:toggle-pin', event => {
    const win = windowFor(event);
    if (!win) {
      return { ok: false, alwaysOnTop: false };
    }
    const pinned = !win.isAlwaysOnTop();
    win.setAlwaysOnTop(pinned);
    const alwaysOnTop = win.isAlwaysOnTop();
    win.webContents.send('window:always-on-top-changed', alwaysOnTop);
    win.webContents.send('window:state-changed', {
      maximized: win.isMaximized(),
      fullscreen: win.isFullScreen(),
      alwaysOnTop
    });
    return { ok: true, alwaysOnTop };
  });
}

// Appearance setting: nativeTheme.themeSource is what makes prefers-color-scheme
// resolve to light or dark for this app, so the sheets, menus and alerts keep
// using their plain CSS media queries instead of a second theme system.
function registerThemeIpc() {
  ipcMain.handle('theme:set', (_event, source) => {
    if (!['system', 'light', 'dark'].includes(source)) {
      return { ok: false };
    }
    nativeTheme.themeSource = source;
    return { ok: true, dark: nativeTheme.shouldUseDarkColors };
  });
}

function registerCacheIpc() {
  const cacheDirectories = () => ['lyrics-cache', 'animated-art']
    .map(name => path.join(app.getPath('userData'), name));

  ipcMain.handle('cache:open-folder', () =>
    shell.openPath(app.getPath('userData'))
  );

  ipcMain.handle('app:open-external', (_event, rawUrl) => {
    if (typeof rawUrl !== 'string') return false;
    try {
      const parsed = new URL(rawUrl);
      if (parsed.protocol !== 'https:') return false;
      shell.openExternal(parsed.href).catch(() => {});
      return true;
    } catch {
      return false;
    }
  });

  ipcMain.handle('cache:clear', async () => {
    for (const directory of cacheDirectories()) {
      try {
        const entries = await fs.readdir(directory);
        await Promise.all(entries.map(name =>
          fs.rm(path.join(directory, name), { recursive: true, force: true })
        ));
      } catch {
        // A missing or busy cache directory is not an error for "clear".
      }
    }
    return { ok: true };
  });
}

function registerShareIpc() {
  const decodePng = dataUrl => {
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/png;base64,')) {
      return null;
    }
    const image = nativeImage.createFromDataURL(dataUrl);
    return image.isEmpty() ? null : image;
  };

  ipcMain.handle('share:copy-image', async (_event, dataUrl) => {
    const image = decodePng(dataUrl);
    if (!image) return { ok: false, error: 'invalid_image' };
    if (typeof clipboard.write === 'function' && typeof ClipboardItem === 'function') {
      const pngBlob = new Blob([image.toPNG()], { type: 'image/png' });
      await clipboard.write([new ClipboardItem({ 'image/png': pngBlob })]);
      return { ok: true };
    }
    if (typeof clipboard.writeImage === 'function') {
      clipboard.writeImage(image);
      return { ok: true };
    }
    return { ok: false, error: 'clipboard_unavailable' };
  });

  ipcMain.handle('share:save-image', async (event, dataUrl, suggestedName) => {
    const image = decodePng(dataUrl);
    if (!image) return { ok: false, error: 'invalid_image' };
    const win = BrowserWindow.fromWebContents(event.sender);
    const baseName = typeof suggestedName === 'string' && suggestedName.trim()
      ? path.basename(suggestedName.trim())
      : 'yourLyrics.png';
    const safeName = baseName.toLowerCase().endsWith('.png') ? baseName : `${baseName}.png`;
    const defaultPath = path.join(app.getPath('pictures'), safeName);
    const { canceled, filePath } = await dialog.showSaveDialog(win || undefined, {
      defaultPath,
      filters: [{ name: 'PNG Image', extensions: ['png'] }],
    });
    if (canceled || !filePath) {
      return { ok: false, canceled: true };
    }
    await fs.writeFile(filePath, image.toPNG());
    return { ok: true, filePath };
  });
}

function registerAppIpc() {
  ipcMain.handle('app:relaunch', () => {
    app.relaunch();
    app.quit();
    return { ok: true };
  });
}

app.whenReady().then(() => {
  applyAppIcon();
  registerAppIpc();
  registerShareIpc();
  registerNowPlayingIpc(mediaProvider?.refreshNowPlaying);
  registerLyricsIpc();
  registerAnimatedArtIpc();
  registerCacheIpc();
  registerThemeIpc();
  registerWindowIpc();
  registerUpdateCheckIpc();
  registerDiscordRpcIpc();
  // The packaged check exercises the real app without requesting audio
  // capture permission or connecting to a user's now-playing source.
  if (!packagedSmokeCheck) {
    startMediaProvider();
    startLoudness();
  }
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  stopDiscordRpc();
  stopLoudness();
  stopMediaProvider();
  flushLogs();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
