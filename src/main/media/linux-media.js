'use strict';

// Linux media integration. Linux exposes every player as an MPRIS object on
// the session D-Bus, and `playerctl` is the standard CLI over that bus: it
// already absorbs the quirks players ship (missing fields, streams without
// durations, odd value types) and it can follow property changes as a
// stream. That lets this module stay a stream consumer -- the same shape as
// the macOS MediaRemote adapter and the Windows SMTC host -- instead of
// being a D-Bus client of its own.
//
// playerctl is an OS package rather than a bundled helper: it carries its
// own shared-library dependencies and every distro already packages it.
// Without it the app runs normally but reports no now-playing; the first
// failed spawn logs a single console hint with the install command.

const { execFile, spawn } = require('node:child_process');
const readline = require('node:readline');
const fs = require('node:fs');
const { fileURLToPath } = require('node:url');
const {
  publishNowPlaying,
  setSeekHandler,
  setPlaybackHandler
} = require('./now-playing');

const idleState = {
  title: '',
  artist: '',
  album: '',
  artworkPath: '',
  artworkUrl: '',
  source: '',
  positionSeconds: 0,
  durationSeconds: 0,
  playing: false
};

function publishIdle() {
  publishNowPlaying(idleState);
}

// MPRIS reports time in microseconds everywhere it reports time at all
// ({{position}}, mpris:length), unlike the macOS and Windows providers,
// which speak seconds. The unit separator keeps the format literal apart
// from song text: titles can contain newlines but never this character.
const fieldSeparator = '\u001f';
const playerctlFormat = [
  '{{playerName}}',
  '{{status}}',
  '{{title}}',
  '{{artist}}',
  '{{album}}',
  '{{position}}',
  '{{mpris:length}}',
  '{{mpris:artUrl}}'
].join(fieldSeparator);

// --follow only reports changes for players that exist, so it can never
// announce that a player quit. A slow one-shot re-query is the ground truth
// for who is alive, doubles as the startup snapshot (the stream emits
// deltas only, like the macOS adapter) and re-anchors position while a
// track plays.
const reconcileIntervalMs = 2000;
const restartDelayMs = 3000;
// Some playerctl builds exit immediately when --follow starts on an empty
// bus; restarting those deserves a gentler cadence than a crash.
const quietRestartDelayMs = 5000;

const playbackCommands = new Map([
  ['play', 'play'],
  ['pause', 'pause'],
  ['previous', 'previous'],
  ['next', 'next']
]);

let followProcess = null;
let followGeneration = 0;
let readInterface = null;
let reconcileProcess = null;
let pollTimer = null;
let restartTimer = null;
let stopping = false;
let hasSeenMedia = false;
let hasWarnedMissing = false;
let players = new Map();
let activeName = '';
let pendingPlayback = new Set();
const artworkByUrl = new Map();
const artworkFetches = new Set();

function parseMicroseconds(value) {
  const microseconds = Number(value);
  return Number.isFinite(microseconds) && microseconds > 0
    ? microseconds / 1000000
    : 0;
}

function parseLine(text) {
  const fields = text.split(fieldSeparator);
  if (fields.length < 6) {
    return null;
  }
  const [name, status, title, artist, album, position, length, artUrl] = fields;
  if (!name || !status) {
    return null;
  }
  return {
    name,
    status,
    title: title || '',
    artist: artist || '',
    album: album || '',
    position: parseMicroseconds(position),
    duration: parseMicroseconds(length),
    artUrl: artUrl || '',
    seenAt: Date.now()
  };
}

function publishIdleOnce() {
  if (!hasSeenMedia) {
    return;
  }
  hasSeenMedia = false;
  activeName = '';
  publishIdle();
}

// Selection mirrors what a desktop shell does: whichever player most
// recently started playing owns the session. A paused player keeps the
// selection until something else plays, so a transient status flip does not
// bounce the lyrics off the screen.
function selectActivePlayer() {
  let newestPlaying = '';
  let newestPlayingAt = -1;
  let newestPaused = '';
  let newestPausedAt = -1;
  for (const player of players.values()) {
    // A player with no track has nothing for the lyrics to match.
    if (!player.title) {
      continue;
    }
    if (player.status === 'Playing') {
      if (player.seenAt >= newestPlayingAt) {
        newestPlayingAt = player.seenAt;
        newestPlaying = player.name;
      }
    } else if (player.status === 'Paused' && player.seenAt >= newestPausedAt) {
      newestPausedAt = player.seenAt;
      newestPaused = player.name;
    }
  }
  if (newestPlaying) {
    return newestPlaying;
  }
  const active = players.get(activeName);
  if (active && active.title && active.status === 'Paused') {
    return activeName;
  }
  return newestPaused;
}

function artworkFor(player) {
  const source = player.artUrl;
  if (!source) {
    return { path: '', url: '' };
  }
  if (source.startsWith('data:image/')) {
    return { path: '', url: source };
  }
  if (source.startsWith('file://')) {
    let filePath = '';
    try {
      filePath = fileURLToPath(source);
    } catch {
      // A malformed file URL from the player counts as no artwork.
    }
    // Players cache covers in locations they later purge; only an art file
    // that still exists may be handed to the renderer as a path.
    return { path: filePath && fs.existsSync(filePath) ? filePath : '', url: '' };
  }
  if (source.startsWith('http://') || source.startsWith('https://')) {
    // The renderer's CSP is img-src 'self' data: -- a remote URL cannot
    // load in-page, so it is fetched here and shipped as a data URL, the
    // same shape the macOS adapter delivers.
    if (artworkByUrl.has(source)) {
      return { path: '', url: artworkByUrl.get(source) };
    }
    if (!artworkFetches.has(source)) {
      void fetchArtwork(source);
    }
    return { path: '', url: '' };
  }
  return { path: '', url: '' };
}

async function fetchArtwork(source) {
  artworkFetches.add(source);
  let url = '';
  try {
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 10000);
    let response;
    try {
      response = await fetch(source, { signal: controller.signal });
    } finally {
      clearTimeout(deadline);
    }
    if (response.ok) {
      const contentType = (response.headers.get('content-type') || '')
        .split(';')[0]
        .trim();
      if (contentType.startsWith('image/')) {
        const body = Buffer.from(await response.arrayBuffer());
        if (body.length > 0 && body.length <= 12 * 1024 * 1024) {
          url = `data:${contentType};base64,${body.toString('base64')}`;
        }
      }
    }
  } catch (error) {
    console.error(`[linux-media] Artwork download failed: ${error.message}`);
  }
  // Cache the outcome either way -- including the empty one. A URL that has
  // been tried must not re-trigger a download on every subsequent publish.
  if (artworkByUrl.size >= 12) {
    artworkByUrl.delete(artworkByUrl.keys().next().value);
  }
  artworkByUrl.set(source, url);
  artworkFetches.delete(source);
  publishActive();
}

function publishActive() {
  const player = activeName ? players.get(activeName) : null;
  if (!player || !player.title) {
    publishIdleOnce();
    return;
  }
  const artwork = artworkFor(player);
  hasSeenMedia = true;
  publishNowPlaying({
    title: player.title,
    artist: player.artist,
    album: player.album,
    artworkPath: artwork.path,
    // With a local file the URL is left out so normalizeState derives the
    // data URL from artworkPath; with nothing at all it must still be '' so
    // the previous track's cover is cleared rather than kept.
    artworkUrl: artwork.url || (artwork.path ? undefined : ''),
    source: player.name,
    positionSeconds: player.position,
    durationSeconds: player.duration,
    playing: player.status === 'Playing'
  });
}

function ingestSnapshot(stdout) {
  const seen = new Set();
  for (const text of String(stdout || '').split('\n')) {
    const record = parseLine(text);
    if (!record) {
      continue;
    }
    seen.add(record.name);
    players.set(record.name, record);
  }
  // Anything that did not answer this query has left the bus.
  for (const name of [...players.keys()]) {
    if (!seen.has(name)) {
      players.delete(name);
    }
  }
  activeName = selectActivePlayer();
  publishActive();
}

function handleLine(text) {
  if (!text.trim()) {
    return;
  }
  const record = parseLine(text);
  if (!record) {
    return;
  }
  players.set(record.name, record);
  activeName = selectActivePlayer();
  publishActive();
}

function cancelPlayback() {
  setPlaybackHandler(null);
  for (const request of pendingPlayback) {
    request.finish({ ok: false, error: 'playback_unavailable' });
  }
}

function controlPlayback(action) {
  if (!playbackCommands.has(action)) {
    return Promise.resolve({ ok: false, error: 'invalid_action' });
  }
  if (!activeName || stopping) {
    return Promise.resolve({ ok: false, error: 'playback_unavailable' });
  }

  return new Promise((resolve) => {
    const request = { finish: null };
    request.finish = (result) => {
      if (!pendingPlayback.delete(request)) {
        return;
      }
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      request.finish({ ok: false, error: 'playback_timeout' });
    }, 5000);
    pendingPlayback.add(request);
    try {
      execFile(
        'playerctl',
        ['--player', activeName, playbackCommands.get(action)],
        { timeout: 4000 },
        (error) => {
          request.finish(error
            ? {
                ok: false,
                error: error.killed
                  ? 'playback_timeout'
                  : error.message || 'playback_failed'
              }
            : { ok: true });
        }
      );
    } catch (error) {
      request.finish({ ok: false, error: error.message || 'playback_failed' });
    }
  });
}

function seek(seconds) {
  if (!Number.isFinite(seconds) || !activeName || stopping) {
    return;
  }
  // playerctl's position command takes an unsigned OFFSET as an absolute
  // seek target, which is exactly what the progress bar hands us.
  execFile(
    'playerctl',
    ['--player', activeName, 'position', String(Math.max(0, seconds))],
    { timeout: 4000 },
    (error) => {
      if (error && !stopping) {
        console.error(`[linux-media] Seek failed: ${error.message}`);
      }
    }
  );
}

function reconcile() {
  if (reconcileProcess || stopping) {
    return false;
  }
  try {
    reconcileProcess = execFile(
      'playerctl',
      ['--all-players', '--format', playerctlFormat, 'metadata'],
      { timeout: 2000, maxBuffer: 32 * 1024 * 1024 },
      (error, stdout, stderr) => {
        reconcileProcess = null;
        if (stopping) {
          return;
        }
        if (error && error.code === 'ENOENT') {
          warnMissingPlayerctl();
          return;
        }
        if (error && !/no players found/i.test(stderr || error.message || '')) {
          // A transient bus error must not wipe what is known to be playing.
          return;
        }
        // Either the query succeeded or the bus answered "No players
        // found": both make its answer (possibly empty) the ground truth.
        ingestSnapshot(error ? '' : stdout);
      }
    );
    return true;
  } catch {
    reconcileProcess = null;
    return false;
  }
}

function refreshNowPlaying() {
  if (stopping || !followProcess) {
    return { ok: false, error: 'refresh_unavailable' };
  }
  if (reconcileProcess) {
    return { ok: true };
  }
  return reconcile()
    ? { ok: true }
    : { ok: false, error: 'refresh_in_progress' };
}

function warnMissingPlayerctl() {
  if (hasWarnedMissing) {
    return;
  }
  hasWarnedMissing = true;
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  console.error(
    '[linux-media] playerctl not found; install it (for example ' +
    '`sudo apt install playerctl`) for now-playing support'
  );
}

function scheduleRestart(delay) {
  if (stopping || restartTimer) {
    return;
  }
  restartTimer = setTimeout(() => {
    restartTimer = null;
    startLinuxMedia();
  }, delay);
}

function startLinuxMedia() {
  if (process.platform !== 'linux' || followProcess) {
    return;
  }

  stopping = false;
  let child;
  try {
    child = spawn('playerctl', [
      '--all-players',
      '--follow',
      '--format',
      playerctlFormat,
      'metadata'
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    console.error(`[linux-media] Failed to start playerctl: ${error.message}`);
    return;
  }
  const generation = ++followGeneration;
  followProcess = child;

  // Polling is the only thing that can learn a player quit, so it is armed
  // even while --follow is healthy.
  if (!pollTimer) {
    pollTimer = setInterval(reconcile, reconcileIntervalMs);
  }
  setSeekHandler(seek);

  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-4096);
  });

  readInterface = readline.createInterface({ input: child.stdout });
  readInterface.on('line', handleLine);

  child.once('spawn', () => {
    if (followProcess === child && !stopping) {
      setPlaybackHandler(controlPlayback);
    }
    // The stream emits deltas only; seed with a snapshot, which also prunes
    // players that quit before the stream was up.
    reconcile();
  });

  child.on('error', (error) => {
    if (generation !== followGeneration || followProcess !== child) {
      return;
    }
    followProcess = null;
    cancelPlayback();
    if (readInterface) {
      readInterface.close();
      readInterface = null;
    }
    if (error.code === 'ENOENT') {
      // No playerctl: the app keeps working without now-playing. Warn once
      // rather than respawning a binary that will never appear.
      warnMissingPlayerctl();
      return;
    }
    console.error(`[linux-media] Failed to start playerctl: ${error.message}`);
    scheduleRestart(restartDelayMs);
  });

  child.on('exit', (code, signal) => {
    if (generation !== followGeneration) {
      return;
    }
    if (followProcess === child) {
      followProcess = null;
    }
    cancelPlayback();
    if (readInterface) {
      readInterface.close();
      readInterface = null;
    }
    publishIdleOnce();
    if (stopping) {
      return;
    }
    // "No players found" is not a crash: some playerctl builds exit
    // immediately when --follow starts on an empty bus, so waiting a little
    // longer between attempts avoids a tight respawn loop.
    if (/no players found/i.test(stderr)) {
      scheduleRestart(quietRestartDelayMs);
      return;
    }
    const reason = signal ? `signal ${signal}` : `exit ${code}`;
    if (code !== 0 || stderr) {
      console.error(
        `[linux-media] playerctl stopped (${reason})${stderr ? `: ${stderr.trim()}` : ''}`
      );
    }
    scheduleRestart(restartDelayMs);
  });
}

function stopLinuxMedia() {
  stopping = true;
  // In-flight child events must now be ignored.
  followGeneration += 1;
  setSeekHandler(null);
  cancelPlayback();

  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }
  if (readInterface) {
    readInterface.close();
    readInterface = null;
  }
  if (followProcess) {
    followProcess.kill('SIGTERM');
    followProcess = null;
  }
  if (reconcileProcess) {
    reconcileProcess.kill('SIGTERM');
    reconcileProcess = null;
  }

  players.clear();
  activeName = '';
  hasSeenMedia = false;
}

module.exports = {
  refreshNowPlaying,
  startLinuxMedia,
  stopLinuxMedia
};
