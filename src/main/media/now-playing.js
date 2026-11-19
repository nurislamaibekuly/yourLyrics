const { BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { isBrowserSource } = require('./browser-metadata');

const idleState = {
  title: 'No song playing',
  artist: '',
  album: '',
  artworkPath: '',
  artworkUrl: '',
  artworkRemoteUrl: '',
  artworkFallback: false,
  lyricsPath: '',
  source: '',
  positionSeconds: 0,
  durationSeconds: 0,
  playing: false
};

let current = { ...idleState };
let cachedArtworkPath = '';
let cachedArtworkUrl = '';
let catalogArtworkFallbackEnabled = true;
let seekHandler = null;
let playbackHandler = null;
const playbackActions = new Set(['play', 'pause', 'previous', 'next']);
const pendingPlayback = new Set();

function artworkDataUrl(artworkPath) {
  if (!artworkPath) {
    return '';
  }
  if (artworkPath === cachedArtworkPath) {
    return cachedArtworkUrl;
  }

  try {
    const extension = path.extname(artworkPath).toLowerCase();
    const mime = extension === '.png'
      ? 'image/png'
      : extension === '.webp'
        ? 'image/webp'
        : 'image/jpeg';
    const data = fs.readFileSync(artworkPath).toString('base64');
    cachedArtworkPath = artworkPath;
    cachedArtworkUrl = `data:${mime};base64,${data}`;
    return cachedArtworkUrl;
  } catch {
    return '';
  }
}

function normalizedSeconds(value, fallback) {
  return Number.isFinite(value) ? Math.max(0, value) : fallback;
}

function normalizeState(update) {
  const title = typeof update.title === 'string' ? update.title : current.title;
  const artist = typeof update.artist === 'string' ? update.artist : current.artist;
  const album = typeof update.album === 'string' ? update.album : current.album;
  const trackChanged = title !== current.title || artist !== current.artist || album !== current.album;
  const artworkPath = typeof update.artworkPath === 'string'
    ? update.artworkPath
    : current.artworkPath;
  let artworkUrl = current.artworkUrl;
  let artworkRemoteUrl = trackChanged ? '' : current.artworkRemoteUrl;

  if (typeof update.artworkUrl === 'string') {
    artworkUrl = update.artworkUrl;
  } else if (artworkPath !== current.artworkPath) {
    artworkUrl = artworkDataUrl(artworkPath);
  }

  if (typeof update.artworkRemoteUrl === 'string') {
    artworkRemoteUrl = update.artworkRemoteUrl;
  }

  return {
    title,
    artist,
    album,
    artworkPath,
    artworkUrl,
    artworkRemoteUrl,
    artworkFallback: update.artworkFallback === true ||
      (update.artworkFallback !== false && !trackChanged && current.artworkFallback &&
        !(typeof update.artworkUrl === 'string' && update.artworkUrl)),
    artworkPending: update.artworkPending === true,
    lyricsPath: typeof update.lyricsPath === 'string'
      ? update.lyricsPath
      : current.lyricsPath,
    source: typeof update.source === 'string' ? update.source : current.source,
    positionSeconds: normalizedSeconds(
      update.positionSeconds,
      current.positionSeconds
    ),
    durationSeconds: normalizedSeconds(
      update.durationSeconds,
      current.durationSeconds
    ),
    // Preserve a provider's transport rate through metadata-only updates so
    // progress and lyrics continue to advance at the same speed.
    ...(Number.isFinite(update.playbackRate)
      ? { playbackRate: Math.max(0, update.playbackRate) }
      : Number.isFinite(current.playbackRate) ? { playbackRate: current.playbackRate } : {}),
    playing: typeof update.playing === 'boolean'
      ? update.playing
      : current.playing
  };
}

// Native players that publish no artwork of their own get their cover
// from the very catalog search the lyrics fetch performs; resolveLyricsFlowTrack's
// session cache makes that free once lyrics have run for this track. The
// renderer's CSP only admits local images, so the picture is downloaded here
// and shipped as a data URL, exactly like native artwork. Browsers use their
// media-session artwork only: a video/uploader title is not a catalog identity.
const catalogArtworkCache = new Map();
const catalogArtworkInflight = new Set();
let lastPublishAt = Date.now();

function catalogTrack(state) {
  return {
    title: state.title,
    artist: state.artist,
    album: state.album,
    durationSeconds: state.durationSeconds
  };
}

function catalogTrackKey(track) {
  return [
    track.title,
    track.artist,
    track.album
  ].join('\u001f');
}

async function fetchCoverImage(url) {
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), 15000);
  let response;
  try {
    response = await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(deadline);
  }
  if (!response.ok) {
    return '';
  }
  const contentType = (response.headers.get('content-type') || '')
    .split(';')[0]
    .trim();
  if (!contentType.startsWith('image/')) {
    return '';
  }
  const body = Buffer.from(await response.arrayBuffer());
  if (body.length === 0 || body.length > 12 * 1024 * 1024) {
    return '';
  }
  return `data:${contentType};base64,${body.toString('base64')}`;
}

async function fillCatalogArtwork(key, track) {
  catalogArtworkInflight.add(key);
  let dataUrl = '';
  let artworkRemoteUrl = '';
  try {
    // Deferred on purpose: lyrics.js imports this module, so requiring it at
    // load time would catch its destructured imports half-initialized.
    const { resolveLyricsFlowArtwork } = require('../lyrics');
    const resolved = await resolveLyricsFlowArtwork(track);
    const template = resolved?.candidate?.artworkUrl || '';
    if (template) {
      artworkRemoteUrl = template.replace('{w}', '1000').replace('{h}', '1000');
      dataUrl = await fetchCoverImage(artworkRemoteUrl);
    }
  } catch (error) {
    console.error(`[now-playing] Catalog artwork failed: ${error.message}`);
  } finally {
    catalogArtworkInflight.delete(key);
    // Misses are remembered too: this fires on every publish for a track, and
    // a dead network must not become a request storm.
    if (catalogArtworkCache.size >= 64) {
      catalogArtworkCache.delete(catalogArtworkCache.keys().next().value);
    }
    catalogArtworkCache.set(key, { dataUrl, artworkRemoteUrl });
  }
  if (!dataUrl ||
      !catalogArtworkFallbackEnabled ||
      isBrowserSource(current.source) ||
      catalogTrackKey(catalogTrack(current)) !== key) {
    return;
  }
  // The renderer re-anchors its progress clock on every event, so an
  // artwork-only republish has to carry the position advanced by however long
  // the lookup took, or the bar jumps backwards.
  const advanced = current.playing
    ? current.positionSeconds + (Date.now() - lastPublishAt) / 1000 * (current.playbackRate ?? 1)
    : current.positionSeconds;
  const update = {
    artworkRemoteUrl,
    artworkFallback: !current.artworkUrl,
    positionSeconds: current.durationSeconds > 0
      ? Math.min(advanced, current.durationSeconds)
      : advanced
  };
  if (!current.artworkUrl) {
    update.artworkUrl = dataUrl;
  }
  publishNowPlaying(update);
}

function getNowPlaying() {
  return { ...current, controlsAvailable: playbackHandler !== null };
}

// Main-process subscribers (the loudness module wants to re-tap the moment the
// source app changes). The renderer gets its own send through
// broadcastNowPlaying; this is the same event on the other side of the bridge,
// and it exists so a consumer does not have to poll a value that is already
// being pushed somewhere.
const nowPlayingListeners = [];

function onNowPlayingChanged(listener) {
  if (typeof listener !== 'function') {
    return () => {};
  }
  nowPlayingListeners.push(listener);
  return () => {
    const index = nowPlayingListeners.indexOf(listener);
    if (index >= 0) {
      nowPlayingListeners.splice(index, 1);
    }
  };
}

function broadcastNowPlaying() {
  const snapshot = getNowPlaying();
  for (const listener of nowPlayingListeners) {
    try {
      listener(snapshot);
    } catch (error) {
      console.error(`[now-playing] Listener failed: ${error.message}`);
    }
  }
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send('now-playing:changed', getNowPlaying());
    }
  }

  return getNowPlaying();
}

function publishNowPlaying(update = {}) {
  current = normalizeState(update);
  lastPublishAt = Date.now();
  if (catalogArtworkFallbackEnabled && !current.artworkUrl && !current.artworkPending && !isBrowserSource(current.source) &&
      current.title && current.title !== idleState.title) {
    const track = catalogTrack(current);
    const key = catalogTrackKey(track);
    if (catalogArtworkCache.has(key)) {
      // A cover for this track already resolved: repaint it *before*
      // broadcasting, so a provider that republishes without artwork (the
      // macOS adapter diffs on every elapsed-time tick) never flashes the
      // fallback gradient in between.
      const cached = catalogArtworkCache.get(key);
      if (cached?.dataUrl) {
        current = normalizeState({
          artworkUrl: cached.dataUrl,
          artworkRemoteUrl: cached.artworkRemoteUrl,
          artworkFallback: true
        });
      }
    } else if (!catalogArtworkInflight.has(key)) {
      void fillCatalogArtwork(key, track);
    }
  }
  return broadcastNowPlaying();
}

function setCatalogArtworkFallback(enabled) {
  catalogArtworkFallbackEnabled = enabled === true;
  if (catalogArtworkFallbackEnabled) {
    publishNowPlaying({});
  } else if (current.artworkFallback) {
    publishNowPlaying({
      artworkUrl: '',
      artworkRemoteUrl: '',
      artworkFallback: false
    });
  }
  return { ok: true, enabled: catalogArtworkFallbackEnabled };
}

function setSeekHandler(handler) {
  seekHandler = typeof handler === 'function' ? handler : null;
}

function setPlaybackHandler(handler) {
  const next = typeof handler === 'function' ? handler : null;
  if (next === playbackHandler) {
    return;
  }
  const wasAvailable = playbackHandler !== null;
  playbackHandler = next;
  for (const finish of pendingPlayback) {
    finish({ ok: false, error: 'playback_unavailable' });
  }
  if (wasAvailable !== (playbackHandler !== null)) {
    broadcastNowPlaying();
  }
}

function controlPlayback(action) {
  if (!playbackActions.has(action)) {
    return Promise.resolve({ ok: false, error: 'invalid_action' });
  }
  const handler = playbackHandler;
  if (!handler) {
    return Promise.resolve({ ok: false, error: 'playback_unavailable' });
  }

  return new Promise((resolve) => {
    const finish = (result) => {
      if (!pendingPlayback.delete(finish)) {
        return;
      }
      clearTimeout(timer);
      resolve(result);
    };
    // Providers have shorter deadlines; this also bounds a faulty handler.
    const timer = setTimeout(() => {
      finish({ ok: false, error: 'playback_timeout' });
    }, 15000);
    pendingPlayback.add(finish);
    Promise.resolve().then(() => {
      if (pendingPlayback.has(finish)) {
        return handler(action);
      }
    }).then((result) => {
      finish(result?.ok === true
        ? { ok: true }
        : {
            ok: false,
            error: typeof result?.error === 'string' && result.error
              ? result.error
              : 'playback_failed'
          });
    }).catch((error) => {
      finish({
        ok: false,
        error: typeof error?.message === 'string' && error.message
          ? error.message
          : 'playback_failed'
      });
    });
  });
}

function registerNowPlayingIpc(refreshNowPlaying) {
  ipcMain.handle('now-playing:get', getNowPlaying);
  ipcMain.handle('now-playing:set-artwork-fallback', (_event, enabled) =>
    setCatalogArtworkFallback(enabled)
  );
  ipcMain.handle('now-playing:control', (_event, action) => controlPlayback(action));
  ipcMain.handle('now-playing:refresh', () =>
    typeof refreshNowPlaying === 'function'
      ? refreshNowPlaying()
      : { ok: false, error: 'refresh_unavailable' }
  );
  ipcMain.on('now-playing:seek', (_event, seconds) => {
    if (!Number.isFinite(seconds) || !seekHandler) {
      return;
    }
    seekHandler(Math.max(0, seconds));
  });
}

module.exports = {
  getNowPlaying,
  onNowPlayingChanged,
  publishNowPlaying,
  registerNowPlayingIpc,
  setSeekHandler,
  setPlaybackHandler
};
