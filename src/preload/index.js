const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('app', {
  platform: process.platform,
  relaunch: () => ipcRenderer.invoke('app:relaunch'),
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node
  },
  nowPlaying: {
    get: () => ipcRenderer.invoke('now-playing:get'),
    refresh: () => ipcRenderer.invoke('now-playing:refresh'),
    control: async (action) => {
      if (!['play', 'pause', 'previous', 'next'].includes(action)) {
        return { ok: false, error: 'invalid_action' };
      }
      try {
        return await ipcRenderer.invoke('now-playing:control', action);
      } catch (error) {
        return {
          ok: false,
          error: typeof error?.message === 'string' && error.message
            ? error.message
            : 'playback_failed'
        };
      }
    },
    onChanged: (callback) => {
      if (typeof callback !== 'function') {
        return;
      }
      ipcRenderer.on('now-playing:changed', (_event, state) => callback(state));
    },
    setArtworkFallback: enabled =>
      ipcRenderer.invoke('now-playing:set-artwork-fallback', enabled === true),
    seek: (seconds) => {
      if (Number.isFinite(seconds)) {
        ipcRenderer.send('now-playing:seek', seconds);
      }
    }
  },
  lyrics: {
    get: (track) => ipcRenderer.invoke('lyrics:get', track),
    search: (track, query) => ipcRenderer.invoke('lyrics:search', track, query),
    openFile: () => ipcRenderer.invoke('lyrics:open-file')
  },
  animatedArt: {
    get: (track) => ipcRenderer.invoke('animated-art:get', track)
  },
  cache: {
    openFolder: () => ipcRenderer.invoke('cache:open-folder'),
    clear: () => ipcRenderer.invoke('cache:clear')
  },
  // 'system' | 'light' | 'dark'; main maps it onto nativeTheme.themeSource so
  // prefers-color-scheme switches with it.
  theme: {
    set: (source) => ipcRenderer.invoke('theme:set', source)
  },
  discord: {
    setSettings: settings => ipcRenderer.invoke('discord:set-settings', settings),
    getStatus: () => ipcRenderer.invoke('discord:status'),
    onStatus: callback => {
      if (typeof callback !== 'function') return;
      ipcRenderer.on('discord:status', (_event, status) => callback(status));
    }
  },
  // Custom titlebar controls. The title bar is hidden so the stylesheet
  // can draw the window radius and custom traffic lights with hover reveal
  // and always-on-top window pinning across all platforms.
  window: {
    setUiStyle: (style, options) => ipcRenderer.invoke('window:set-ui-style', style, options),
    setUiScale: (scale) => ipcRenderer.invoke('window:set-ui-scale', scale)
      .then(result => result?.scale ?? 1)
      .catch(() => 1),
    getUiScale: () => ipcRenderer.invoke('window:get-ui-scale')
      .then(result => result?.scale ?? 1)
      .catch(() => 1),
    minimize: () => ipcRenderer.invoke('window:minimize'),
    toggleMaximize: () => ipcRenderer.invoke('window:toggle-maximize'),
    close: () => ipcRenderer.invoke('window:close'),
    isMaximized: () => ipcRenderer.invoke('window:is-maximized')
      .then(result => result?.maximized === true)
      .catch(() => false),
    isAlwaysOnTop: () => ipcRenderer.invoke('window:is-pinned')
      .then(result => result?.alwaysOnTop === true)
      .catch(() => false),
    setAlwaysOnTop: (flag) => ipcRenderer.invoke('window:set-always-on-top', flag)
      .then(result => result?.alwaysOnTop === true)
      .catch(() => false),
    togglePin: () => ipcRenderer.invoke('window:toggle-pin')
      .then(result => result?.alwaysOnTop === true)
      .catch(() => false),
    onAlwaysOnTopChange: (callback) => {
      if (typeof callback !== 'function') {
        return;
      }
      ipcRenderer.on('window:always-on-top-changed', (_event, pinned) => {
        callback(pinned === true);
      });
    },
    onMaximizedChange: (callback) => {
      if (typeof callback !== 'function') {
        return;
      }
      ipcRenderer.on('window:maximized-changed', (_event, maximized) => {
        callback(maximized === true);
      });
    },
    getState: () => ipcRenderer.invoke('window:get-state')
      .then(result => ({
        maximized: result?.maximized === true,
        fullscreen: result?.fullscreen === true,
        alwaysOnTop: result?.alwaysOnTop === true
      }))
      .catch(() => ({ maximized: false, fullscreen: false, alwaysOnTop: false })),
    onStateChange: (callback) => {
      if (typeof callback !== 'function') {
        return;
      }
      ipcRenderer.on('window:state-changed', (_event, state) => {
        callback({
          maximized: state?.maximized === true,
          fullscreen: state?.fullscreen === true,
          alwaysOnTop: state?.alwaysOnTop === true
        });
      });
    }
  },
  // Backdrop loudness from the now-playing app's own output; payload is
  // `{ low, mid, high, overall, gain }`, each level already normalised to 0..1.
  loudness: {
    onVolume: (callback) => {
      if (typeof callback !== 'function') {
        return;
      }
      ipcRenderer.on('backdrop:volume', (_event, payload) => callback(payload));
    }
  },
  // Update checks run in main: the renderer's CSP has no connect-src for
  // GitHub, and the auto-updater only exists in a packaged build.
  updates: {
    check: () => ipcRenderer.invoke('updates:check'),
    version: () => ipcRenderer.invoke('updates:version'),
    install: () => ipcRenderer.invoke('updates:install'),
    openRelease: () => ipcRenderer.invoke('updates:open-release'),
    restart: () => ipcRenderer.invoke('updates:restart'),
    onProgress: (callback) => {
      if (typeof callback !== 'function') {
        return;
      }
      ipcRenderer.on('updates:progress', (_event, payload) => callback(payload));
    },
    onDownloaded: (callback) => {
      if (typeof callback !== 'function') {
        return;
      }
      ipcRenderer.on('updates:downloaded', () => callback());
    },
    onFailed: (callback) => {
      if (typeof callback !== 'function') {
        return;
      }
      ipcRenderer.on('updates:failed', (_event, payload) => callback(payload));
    }
  }
});
