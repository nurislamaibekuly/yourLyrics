const { execFile, spawn } = require('node:child_process');
const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { publishNowPlaying, setSeekHandler, setPlaybackHandler } = require('./now-playing');
const { createArtworkDecoder } = require('./player-artwork');

const decodeArtwork = createArtworkDecoder({
  onReady(base64) {
    // Conversion may finish after a track change, stop, or player exit.
    if (!stopping && hasSeenMedia && remoteState.artworkData === base64) {
      publishPayload(remoteState);
    }
  }
});

// The adapter is loaded by a child Perl process, so it cannot live inside the
// asar archive. electron-builder copies it to Contents/Resources/vendor.
const adapterRoot = app.isPackaged
  ? path.join(process.resourcesPath, 'vendor/mediaremote-adapter')
  : path.join(__dirname, '../../../vendor/mediaremote-adapter');
const scriptPath = path.join(adapterRoot, 'mediaremote-adapter.pl');
const frameworkPath = path.join(adapterRoot, 'MediaRemoteAdapter.framework');
const perlPath = '/usr/bin/perl';

const idleState = {
  title: 'No song playing',
  artist: '',
  album: '',
  artworkPath: '',
  artworkUrl: '',
  lyricsPath: '',
  source: '',
  positionSeconds: 0,
  durationSeconds: 0,
  playing: false
};

let streamProcess = null;
let streamGeneration = 0;
let readInterface = null;
let seekProcess = null;
let pendingSeekMicros = null;
let remoteState = {};
let playbackAnchor = null;
let hasSeenMedia = false;
let stopping = false;
let streamEventRevision = 0;
// mediaremote-adapter.pl FRAMEWORK_PATH send MRCommand
const playbackCommands = new Map([
  ['play', '0'],
  ['pause', '1'],
  ['previous', '5'],
  ['next', '4']
]);
const pendingPlayback = new Set();

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function payloadSeconds(payload, key) {
  const micros = finiteNumber(payload[`${key}Micros`]);
  return micros !== null ? micros / 1000000 : finiteNumber(payload[key]);
}

function timestampSeconds(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1e12 ? value / 1000 : value;
  }
  if (typeof value !== 'string') {
    return null;
  }

  const parsed = Date.parse(value);
  if (Number.isFinite(parsed)) {
    return parsed / 1000;
  }

  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function playbackRate(payload) {
  if (!payload.playing) return 0;
  const rate = finiteNumber(payload.playbackRate);
  // Playing and rate are separate notifications; a retained paused rate
  // must not hold the clock until the next elapsed-time packet arrives.
  return rate > 0 ? rate : 1;
}

function currentPosition(payload, now, hasElapsedSample = true, isDiff = false) {
  const elapsed = payloadSeconds(payload, 'elapsedTime') ?? 0;
  const duration = payloadSeconds(payload, 'duration');
  const rate = playbackRate(payload);
  // The default date string drops fractional seconds. Extrapolating from it
  // adds a varying fraction of a second that was never actually elapsed.
  const timestampMicros = finiteNumber(payload.timestampEpochMicros);
  const timestamp = timestampMicros !== null
    ? timestampMicros / 1000000 : timestampSeconds(payload.timestamp);
  const track = JSON.stringify([payload.bundleIdentifier, payload.title, payload.artist, payload.album]);
  const expected = playbackAnchor
    ? playbackAnchor.position + Math.max(0, now - playbackAnchor.at) * playbackAnchor.rate
    : 0;
  const sampled = payload.playing && payload.playbackRate !== 0 && timestamp !== null && now > timestamp
    ? elapsed + (now - timestamp) * rate
    : elapsed;
  // Apple Music's delayed playbackRate=1 packet (~1.4s after play/resume)
  // carries an elapsedTime sampled ~0.8s before timestampEpochMicros was
  // stamped. Because elapsed >= playbackAnchor.elapsed, it is not a backward
  // seek; keep advancing the existing anchor instead of rewinding by ~0.8s.
  const laggingConfirmation = isDiff &&
    playbackAnchor &&
    playbackAnchor.track === track &&
    payload.playing &&
    playbackAnchor.rate > 0 &&
    elapsed >= playbackAnchor.elapsed &&
    timestamp !== null &&
    playbackAnchor.timestamp !== null &&
    timestamp >= playbackAnchor.timestamp &&
    now - playbackAnchor.at < 3 &&
    expected > sampled &&
    expected - sampled < 2.5;
  const sameSample = playbackAnchor && playbackAnchor.track === track &&
    (!hasElapsedSample ||
      laggingConfirmation ||
      (playbackAnchor.elapsed === elapsed && playbackAnchor.timestamp === timestamp));
  let position = sameSample ? expected : sampled;

  position = Math.max(0, position);
  if (duration !== null && duration > 0) {
    position = Math.min(position, duration);
  }

  playbackAnchor = { track, elapsed, timestamp, position, at: now, rate };
  return position;
}

function publishPayload(payload, hasElapsedSample = true, isDiff = false) {
  const now = Date.now() / 1000;
  const duration = payloadSeconds(payload, 'duration');
  const artwork = decodeArtwork(payload.artworkData);

  publishNowPlaying({
    title: typeof payload.title === 'string' ? payload.title : '',
    artist: typeof payload.artist === 'string' ? payload.artist : '',
    album: typeof payload.album === 'string' ? payload.album : '',
    artworkPath: '',
    artworkUrl: artwork.url,
    artworkPending: artwork.pending,
    lyricsPath: '',
    source: typeof payload.bundleIdentifier === 'string'
      ? payload.bundleIdentifier
      : '',
    positionSeconds: currentPosition(payload, now, hasElapsedSample, isDiff),
    durationSeconds: duration !== null ? Math.max(0, duration) : 0,
    playbackRate: playbackRate(payload),
    playing: payload.playing === true
  });
}

function publishIdle() {
  playbackAnchor = null;
  publishNowPlaying(idleState);
}

function hasMedia(payload) {
  return typeof payload.title === 'string' && payload.title.length > 0;
}

const transientSameTrackKeys = new Set([
  'durationMicros',
  'duration',
  'elapsedTimeMicros',
  'elapsedTime',
  'artworkData',
  'artworkMimeType',
  'bundleIdentifier'
]);

function mergePayload(payload) {
  const next = { ...remoteState };
  const changedTrack = ['title', 'artist', 'album', 'bundleIdentifier'].some(key =>
    Object.hasOwn(payload, key) &&
    payload[key] !== null &&
    payload[key] !== undefined &&
    payload[key] !== remoteState[key]);
  const stayingOnTrack = !changedTrack && hasMedia(remoteState) &&
    (!Object.hasOwn(payload, 'title') || hasMedia(payload));
  if (changedTrack && !Object.hasOwn(payload, 'artworkData')) {
    delete next.artworkData;
    delete next.artworkMimeType;
  }
  for (const [key, value] of Object.entries(payload)) {
    if (value === null || value === undefined) {
      if (!(stayingOnTrack && transientSameTrackKeys.has(key))) {
        delete next[key];
      }
    } else if (
      stayingOnTrack &&
      (key === 'artworkData' || key === 'artworkMimeType') &&
      typeof remoteState.artworkData === 'string' &&
      remoteState.artworkData.length > 0
    ) {
      // Keep the existing cover data on the same track so a re-serialized
      // TIFF/HEIC buffer on pause/resume never triggers a blank pending state.
    } else {
      next[key] = value;
    }
  }
  return next;
}

function handleStreamEvent(event) {
  if (event.type !== 'data' || !event.payload || typeof event.payload !== 'object') {
    return;
  }

  // The adapter's first stream event is an empty handshake emitted before
  // MediaRemote has answered. It carries no state, so treating it as
  // "nothing playing" would wipe the startup snapshot and blank the UI.
  if (!event.diff && Object.keys(event.payload).length === 0) {
    return;
  }

  streamEventRevision += 1;
  remoteState = event.diff ? mergePayload(event.payload) : { ...event.payload };

  if (!hasMedia(remoteState)) {
    if (hasSeenMedia) {
      hasSeenMedia = false;
      publishIdle();
    }
    return;
  }

  hasSeenMedia = true;
  const hasElapsedSample = !event.diff ||
    finiteNumber(event.payload.elapsedTimeMicros) !== null ||
    finiteNumber(event.payload.elapsedTime) !== null;
  publishPayload(remoteState, hasElapsedSample, event.diff === true);
}

function handleLine(line) {
  if (!line.trim()) {
    return;
  }
  try {
    handleStreamEvent(JSON.parse(line));
  } catch (error) {
    console.error(`[media-remote] Invalid stream event: ${error.message}`);
  }
}

function pumpSeek() {
  if (seekProcess || pendingSeekMicros === null || stopping) {
    return;
  }

  const position = pendingSeekMicros;
  pendingSeekMicros = null;

  seekProcess = execFile(
    perlPath,
    [scriptPath, frameworkPath, 'seek', String(position)],
    { timeout: 5000 },
    (error) => {
      seekProcess = null;
      if (error && !stopping) {
        console.error(`[media-remote] Seek failed: ${error.message}`);
      }
      pumpSeek();
    }
  );
}

function seek(seconds) {
  if (!Number.isFinite(seconds)) {
    return;
  }
  pendingSeekMicros = Math.max(0, Math.round(seconds * 1000000));
  pumpSeek();
}

function controlPlayback(action) {
  if (!playbackCommands.has(action)) {
    return Promise.resolve({ ok: false, error: 'invalid_action' });
  }
  if (!streamProcess || stopping) {
    return Promise.resolve({ ok: false, error: 'playback_unavailable' });
  }

  return new Promise((resolve) => {
    const request = { child: null, finish: null };
    request.finish = (result, terminate = false) => {
      if (!pendingPlayback.delete(request)) {
        return;
      }
      clearTimeout(timer);
      resolve(result);
      if (terminate && request.child) {
        try {
          request.child.kill('SIGKILL');
        } catch {
          // The command may already have exited.
        }
      }
    };
    // execFile's timeout alone can wait forever for a child ignoring SIGTERM.
    const timer = setTimeout(() => {
      request.finish({ ok: false, error: 'playback_timeout' }, true);
    }, 5000);
    pendingPlayback.add(request);
    try {
      request.child = execFile(
        perlPath,
        [scriptPath, frameworkPath, 'send', playbackCommands.get(action)],
        { timeout: 5000 },
        (error) => {
          request.finish(error
            ? { ok: false, error: error.killed ? 'playback_timeout' : error.message }
            : { ok: true });
        }
      );
    } catch (error) {
      request.finish({ ok: false, error: error.message || 'playback_failed' });
    }
  });
}

function cancelPlayback() {
  setPlaybackHandler(null);
  for (const request of pendingPlayback) {
    request.finish({ ok: false, error: 'playback_unavailable' }, true);
  }
}

let seedProcess = null;

// One-shot snapshot at startup. The stream only reports *changes*, so without
// this the app has no duration — and therefore no duration-scored lyrics match
// and a disabled progress bar — until the target player next changes state.
function seedFromGet(force = false) {
  if (seedProcess) {
    return false;
  }

  const generation = streamGeneration;
  const eventRevision = streamEventRevision;
  const child = execFile(
    perlPath,
    [scriptPath, frameworkPath, 'get', '--micros'],
    { timeout: 5000, maxBuffer: 32 * 1024 * 1024 },
    (error, stdout) => {
      if (seedProcess === child) {
        seedProcess = null;
      }
      if (error || typeof stdout !== 'string' || stdout.length === 0) {
        return;
      }
      if (stopping || generation !== streamGeneration) {
        return;
      }
      // A snapshot must never overwrite a newer stream event.
      if (streamEventRevision !== eventRevision || (!force && hasSeenMedia)) {
        return;
      }
      try {
        handleStreamEvent({
          type: 'data',
          diff: false,
          payload: JSON.parse(stdout)
        });
      } catch (parseError) {
        console.error(
          `[media-remote] Startup snapshot invalid: ${parseError.message}`
        );
      }
    }
  );
  seedProcess = child;
  return true;
}

function refreshNowPlaying() {
  if (!streamProcess || stopping) {
    return { ok: false, error: 'refresh_unavailable' };
  }
  if (!seedFromGet(true)) {
    return seedProcess
      ? { ok: true }
      : { ok: false, error: 'refresh_unavailable' };
  }
  return { ok: true };
}

function startMediaRemote() {
  if (process.platform !== 'darwin' || streamProcess) {
    return;
  }
  if (!fs.existsSync(scriptPath) || !fs.existsSync(frameworkPath)) {
    console.error('[media-remote] Bundled MediaRemote adapter is missing');
    return;
  }

  stopping = false;
  const child = spawn(
    perlPath,
    [scriptPath, frameworkPath, 'stream', '--micros'],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );
  streamProcess = child;
  const generation = ++streamGeneration;
  setSeekHandler(seek);
  child.once('spawn', () => {
    if (streamProcess === child && !stopping) {
      setPlaybackHandler(controlPlayback);
    }
  });
  seedFromGet();

  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-4096);
  });

  readInterface = readline.createInterface({ input: child.stdout });
  readInterface.on('line', handleLine);

  child.on('error', (error) => {
    if (generation !== streamGeneration) {
      return;
    }
    cancelPlayback();
    if (readInterface) {
      readInterface.close();
      readInterface = null;
    }
    if (streamProcess === child) {
      streamProcess = null;
    }
    console.error(`[media-remote] Failed to start adapter: ${error.message}`);
  });

  child.on('exit', (code, signal) => {
    if (generation !== streamGeneration) {
      return;
    }
    cancelPlayback();
    if (readInterface) {
      readInterface.close();
      readInterface = null;
    }
    if (streamProcess === child) {
      streamProcess = null;
    }
    if (!stopping) {
      remoteState = {};
      hasSeenMedia = false;
      publishIdle();
      const reason = signal ? `signal ${signal}` : `exit ${code}`;
      if (code !== 0 || stderr) {
        console.error(`[media-remote] Adapter stopped (${reason})${stderr ? `: ${stderr.trim()}` : ''}`);
      }
    }
  });
}

function stopMediaRemote() {
  stopping = true;
  playbackAnchor = null;
  setSeekHandler(null);
  cancelPlayback();

  if (readInterface) {
    readInterface.close();
    readInterface = null;
  }

  if (streamProcess) {
    streamProcess.kill('SIGTERM');
    streamProcess = null;
  }

  if (seekProcess) {
    seekProcess.kill('SIGTERM');
    seekProcess = null;
  }

  if (seedProcess) {
    seedProcess.kill('SIGTERM');
    seedProcess = null;
  }

  pendingSeekMicros = null;
}

module.exports = {
  refreshNowPlaying,
  startMediaRemote,
  stopMediaRemote
};
