const { ipcMain } = require('electron');
const { isBrowserSource } = require('./browser-metadata');
const {
  lyricsFlowRoot,
  normalizeTrack,
  resolveLyricsFlowTrack,
  userAgent
} = require('../lyrics');

const requestTimeoutMs = 90000;
const cacheTtlMs = 60 * 60 * 1000;
const negativeCache = new Set();
const urlCache = new Map();
const trackCache = new Map();
const inflight = new Map();
let latestRequest = 0;

function trackKey(track) {
  return [
    track.title,
    track.artist,
    track.album,
    Math.round(track.durationSeconds)
  ].join('\u001f');
}

function remember(cache, key, url, expiresAt = Date.now() + cacheTtlMs) {
  cache.set(key, { url, expiresAt });
}

function remembered(cache, key) {
  const entry = cache.get(key);
  if (entry && entry.expiresAt > Date.now()) {
    return entry.url;
  }
  cache.delete(key);
  return undefined;
}

// HLS playlists reference remote segments and cannot be cached as standalone MP4s.
// Cache the resolved URL briefly so signed CDN links can be refreshed later.
async function fetchArtwork(albumId, aspect) {
  try {
    const params = new URLSearchParams({ album: albumId, quality: 'high', aspect });
    const response = await fetch(`${lyricsFlowRoot}/animatedart?${params}`, {
      headers: { Accept: 'application/json', 'User-Agent': userAgent },
      signal: AbortSignal.timeout(requestTimeoutMs)
    });
    if (response.status === 404) return { url: '', missing: true };
    if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    if (payload.hasMotion === false) return { url: '', missing: true };
    if (payload.hasMotion !== true || typeof payload.video !== 'string') {
      throw new Error('Invalid animated artwork response');
    }
    const url = new URL(payload.video);
    if (url.protocol !== 'https:' || url.username || url.password) {
      throw new Error('Invalid artwork URL');
    }
    return { url: url.href, missing: false };
  } catch (error) {
    console.error(`[animated-art] ${albumId}: ${error.message}`);
    return { url: '', missing: false };
  }
}

async function animatedArtFor(track, aspect) {
  const requestToken = ++latestRequest;
  const key = `${aspect}\u001f${trackKey(track)}`;
  const cached = remembered(trackCache, key);
  if (cached !== undefined) {
    return { url: cached };
  }

  let resolved = null;
  try {
    resolved = await resolveLyricsFlowTrack(track);
  } catch (error) {
    console.error(`[animated-art] resolve failed: ${error.message}`);
    return { url: '' };
  }
  // The track changed while the catalog lookup was in flight; do not spend
  // bandwidth fetching artwork the renderer will never show.
  if (requestToken !== latestRequest) {
    return { url: '' };
  }
  if (!resolved) {
    remember(trackCache, key, '');
    return { url: '' };
  }

  const albumId = resolved.candidate.albumId;
  // The new API accepts album IDs only; a song ID could select unrelated art.
  if (!albumId) {
    remember(trackCache, key, '');
    return { url: '' };
  }

  const cacheId = `${albumId}-${aspect}`;
  if (negativeCache.has(cacheId)) {
    remember(trackCache, key, '');
    return { url: '' };
  }

  const existing = remembered(urlCache, cacheId);
  if (existing) {
    remember(trackCache, key, existing, urlCache.get(cacheId).expiresAt);
    return { url: existing };
  }

  let request = inflight.get(cacheId);
  if (!request) {
    request = fetchArtwork(albumId, aspect).then((result) => {
      if (result.missing) {
        negativeCache.add(cacheId);
      }
      if (result.url) {
        remember(urlCache, cacheId, result.url);
      }
      return result;
    }).finally(() => {
      inflight.delete(cacheId);
    });
    inflight.set(cacheId, request);
  }

  const result = await request;
  if (result.url || result.missing) {
    remember(trackCache, key, result.url,
      result.url ? urlCache.get(cacheId).expiresAt : undefined);
  }
  return { url: result.url };
}

async function getAnimatedArt(input) {
  // Browser video titles are not reliable catalog identities. Keep the
  // media-session image instead of replacing it with another album's video.
  if (isBrowserSource(input?.source)) {
    latestRequest += 1;
    return { url: '' };
  }
  const track = normalizeTrack(input);
  if (!track.title) {
    return { url: '' };
  }
  return animatedArtFor(track, input?.aspect === 'tall' ? 'tall' : 'square');
}

function registerAnimatedArtIpc() {
  ipcMain.handle('animated-art:get', (_event, track) =>
    getAnimatedArt(track)
  );
}

module.exports = {
  getAnimatedArt,
  registerAnimatedArtIpc
};
