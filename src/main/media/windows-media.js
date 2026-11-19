const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { app } = require('electron');
const { publishNowPlaying, setSeekHandler, setPlaybackHandler } = require('./now-playing');
const { normalizeBrowserMetadata } = require('./browser-metadata');

// Windows exposes the current media session through System Media Transport
// Controls (SMTC). A small PowerShell host owns the WinRT session manager and
// answers newline-delimited JSON requests, so we do not pay the CLR/WinRT
// startup cost on every poll.
const scriptPath = app.isPackaged
  ? path.join(process.resourcesPath, 'vendor', 'windows-media', 'smtc.ps1')
  : path.join(__dirname, '../../../vendor/windows-media/smtc.ps1');

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

let mediaProcess = null;
let readInterface = null;
let pollTimer = null;
let restartTimer = null;
let requestId = 0;
let pendingInfoId = 0;
let infoSentAt = 0;
let stopping = false;
let hasSeenMedia = false;
let lastArtworkKey = '';
let lastArtworkUrl = '';
let stderr = '';
const playbackActions = new Set(['play', 'pause', 'previous', 'next']);
const pendingPlayback = new Map();

function powershellPath() {
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  const bundled = path.join(
    root,
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  );
  return fs.existsSync(bundled) ? bundled : 'powershell.exe';
}

function send(message, callback) {
  if (!mediaProcess || !mediaProcess.stdin || mediaProcess.stdin.destroyed) {
    return false;
  }
  try {
    mediaProcess.stdin.write(`${JSON.stringify(message)}\n`, callback);
    return true;
  } catch (error) {
    console.error(`[windows-media] Could not write to helper: ${error.message}`);
    return false;
  }
}

function publishIdle() {
  publishNowPlaying(idleState);
}

function artworkForFrame(frame) {
  const key = [
    frame.source,
    frame.title,
    frame.artist,
    frame.album
  ].join('\u001f');

  if (key !== lastArtworkKey) {
    lastArtworkKey = key;
    lastArtworkUrl = '';
  }
  if (typeof frame.thumbnail === 'string' &&
      frame.thumbnail.startsWith('data:image/')) {
    lastArtworkUrl = frame.thumbnail;
  }
  return lastArtworkUrl;
}

function handleFrame(frame) {
  if (!frame || typeof frame !== 'object') {
    return;
  }

  const playback = pendingPlayback.get(frame.id);
  if (playback) {
    playback.finish(frame.action !== playback.action
      ? { ok: false, error: 'invalid_playback_response' }
      : frame.ok === true
        ? { ok: true }
        : {
            ok: false,
            error: typeof frame.error === 'string' && frame.error
              ? frame.error
              : 'playback_failed'
          });
    return;
  }
  // Acknowledgements (including late ones) contain no media state.
  if (playbackActions.has(frame.action)) {
    return;
  }

  if (frame.id === pendingInfoId) {
    pendingInfoId = 0;
    infoSentAt = 0;
  }

  if (frame.action === 'seek') {
    if (frame.ok !== true && frame.error) {
      console.error(`[windows-media] Seek failed: ${frame.error}`);
    }
    return;
  }

  if (frame.ok !== true) {
    if (frame.error) {
      console.error(`[windows-media] ${frame.error}`);
    }
    return;
  }

  if (frame.active !== true || typeof frame.title !== 'string' || !frame.title) {
    if (hasSeenMedia) {
      hasSeenMedia = false;
      publishIdle();
    }
    return;
  }

  hasSeenMedia = true;
  frame = normalizeBrowserMetadata(frame);
  publishNowPlaying({
    title: frame.title,
    artist: typeof frame.artist === 'string' ? frame.artist : '',
    album: typeof frame.album === 'string' ? frame.album : '',
    artworkPath: '',
    artworkUrl: artworkForFrame(frame),
    lyricsPath: '',
    source: typeof frame.source === 'string' ? frame.source : '',
    positionSeconds: Number.isFinite(frame.position)
      ? Math.max(0, frame.position)
      : 0,
    durationSeconds: Number.isFinite(frame.duration)
      ? Math.max(0, frame.duration)
      : 0,
    playing: frame.playing === true
  });
}

function handleLine(line) {
  if (!line.startsWith('SMTC ')) {
    return;
  }
  try {
    handleFrame(JSON.parse(line.slice(5)));
  } catch (error) {
    console.error(`[windows-media] Invalid helper response: ${error.message}`);
  }
}

function requestInfo() {
  if (!mediaProcess) {
    return false;
  }
  if (pendingInfoId !== 0) {
    if (infoSentAt && Date.now() - infoSentAt > 10000) {
      console.error('[windows-media] Helper stopped responding; restarting');
      mediaProcess.kill();
    }
    return true;
  }
  const id = ++requestId;
  if (send({ id, action: 'info' })) {
    pendingInfoId = id;
    infoSentAt = Date.now();
    return true;
  }
  return false;
}

function refreshNowPlaying() {
  if (stopping || !mediaProcess) {
    return { ok: false, error: 'refresh_unavailable' };
  }
  return requestInfo()
    ? { ok: true }
    : { ok: false, error: 'refresh_unavailable' };
}

function seek(seconds) {
  if (!Number.isFinite(seconds)) {
    return;
  }
  send({
    id: ++requestId,
    action: 'seek',
    position: Math.max(0, seconds)
  });
}

function controlPlayback(action) {
  if (!playbackActions.has(action)) {
    return Promise.resolve({ ok: false, error: 'invalid_action' });
  }
  if (!mediaProcess || stopping) {
    return Promise.resolve({ ok: false, error: 'playback_unavailable' });
  }

  return new Promise((resolve) => {
    const id = ++requestId;
    const finish = (result) => {
      if (!pendingPlayback.delete(id)) {
        return;
      }
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      finish({ ok: false, error: 'playback_timeout' });
    }, 10000);
    pendingPlayback.set(id, { action, finish });
    if (!send({ id, action }, (error) => {
      if (error) {
        finish({ ok: false, error: error.message || 'playback_failed' });
      }
    })) {
      finish({ ok: false, error: 'playback_unavailable' });
    }
  });
}

function cancelPlayback() {
  setPlaybackHandler(null);
  for (const request of pendingPlayback.values()) {
    request.finish({ ok: false, error: 'playback_unavailable' });
  }
}

function clearPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }
}

function scheduleRestart() {
  if (stopping || restartTimer) {
    return;
  }
  restartTimer = setTimeout(() => {
    restartTimer = null;
    startWindowsMedia();
  }, 3000);
}

function detachProcess(child) {
  if (mediaProcess !== child) {
    return false;
  }
  cancelPlayback();
  if (readInterface) {
    readInterface.close();
    readInterface = null;
  }
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (mediaProcess === child) {
    mediaProcess = null;
  }
  pendingInfoId = 0;
  infoSentAt = 0;
  return true;
}

function startWindowsMedia() {
  if (process.platform !== 'win32' || mediaProcess || stopping) {
    return;
  }
  if (!fs.existsSync(scriptPath)) {
    console.error('[windows-media] Bundled SMTC helper is missing');
    return;
  }

  const child = spawn(
    powershellPath(),
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      scriptPath,
      '-Serve'
    ],
    {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    }
  );

  mediaProcess = child;
  pendingInfoId = 0;
  infoSentAt = 0;
  hasSeenMedia = false;
  lastArtworkKey = '';
  lastArtworkUrl = '';
  stderr = '';
  setSeekHandler(seek);
  child.once('spawn', () => {
    if (mediaProcess === child && !stopping && !child.stdin.destroyed) {
      setPlaybackHandler(controlPlayback);
    }
  });
  child.stdin.on('error', () => {
    if (mediaProcess === child) {
      cancelPlayback();
    }
  });

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-4096);
  });

  readInterface = readline.createInterface({ input: child.stdout });
  readInterface.on('line', handleLine);

  child.on('error', (error) => {
    if (!detachProcess(child)) {
      return;
    }
    if (!stopping) {
      console.error(`[windows-media] Failed to start helper: ${error.message}`);
      publishIdle();
      scheduleRestart();
    }
  });

  child.on('exit', (code, signal) => {
    if (!detachProcess(child)) {
      return;
    }
    if (stopping) {
      return;
    }

    const reason = signal ? `signal ${signal}` : `exit ${code}`;
    if (code !== 0 || stderr) {
      console.error(
        `[windows-media] Helper stopped (${reason})` +
        `${stderr ? `: ${stderr.trim()}` : ''}`
      );
    }
    publishIdle();
    scheduleRestart();
  });

  pollTimer = setInterval(requestInfo, 500);
  requestInfo();
}

function stopWindowsMedia() {
  stopping = true;
  setSeekHandler(null);
  cancelPlayback();
  clearPolling();

  if (readInterface) {
    readInterface.close();
    readInterface = null;
  }

  if (mediaProcess) {
    try {
      mediaProcess.stdin.end();
    } catch {
      // The process may already have exited.
    }
    mediaProcess.kill();
    mediaProcess = null;
  }

  pendingInfoId = 0;
  infoSentAt = 0;
}

module.exports = {
  refreshNowPlaying,
  startWindowsMedia,
  stopWindowsMedia
};
