const { BrowserWindow, app } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { getNowPlaying, onNowPlayingChanged } = require('../media/now-playing');

// Backdrop loudness, from whichever app is now-playing.
//
// The backdrop pulses off the now-playing app's own output, analysed by
// vendor/loudness-tap: a 2048-point Hann FFT every 512 frames, 48 log-spaced
// bands from 40 Hz to 16 kHz, each mapped from a 66 dB window into 0..1, an
// instant attack with a 0.43 s release, and the low / mid / high / overall
// energies over those bands.
// This module owns the child, its target, and the freshness rule the native
// LoudnessMonitor applies, and pushes `backdrop:volume` to the windows.
//
// macOS taps the now-playing app's own process; Windows runs the loopback
// helper, which hears every app through the speakers (no supported per-process
// tap) and needs no target -- the child starts once and never restarts for a
// player change.

// How old a sample may be before it stops being believed. Generous one way on
// purpose: a late sample is still a good answer, while a source that died --
// permission revoked, player quit, tap torn down -- simply stops publishing and
// has to be told apart from a quiet passage. A stale loud value would hold the
// backdrop at its loudest exactly when nothing is playing.
const kMaxSampleAgeMs = 200;

// Fallback re-read of the now-playing source, and how often the current band is
// pushed. The source itself is pushed by onNowPlayingChanged, so this interval
// is belt-and-braces only -- 500 ms, not the second it used to be, because
// waiting out a poll was measured as most of a 1-1.5 s "the tracker is late"
// delay whenever the helper was not already running.
const kTargetPollMs = 500;
const kPublishMs = 33;

// The backdrop pulse gain (YOURLYRICS_PULSE_GAIN overrides it, read once). The
// renderer divides it back out against this default, so 0.25 is the neutral
// setting: the analyzer's own 0..1 energies reach the backdrop untouched and
// the Pulse amount slider scales them from there. Tunable without a rebuild
// because "how hard should a kick move the window" is a taste question, not one
// measurement can answer: YOURLYRICS_PULSE_GAIN=0.4 npm start.
const kDefaultPulseGain = 0.25;

function readPulseGain() {
  const raw = process.env.YOURLYRICS_PULSE_GAIN;
  if (raw === undefined || raw === '') {
    return kDefaultPulseGain;
  }
  const value = Number(raw);
  // `>= 0` rather than `> 0`: zero disables the pulse without disabling the
  // capture, and a strict test would let it fall through to the default.
  return Number.isFinite(value) && value >= 0 ? value : kDefaultPulseGain;
}

const pulseGain = readPulseGain();

// Time constant of the renderer's per-frame filter, in seconds. Higher is
// smoother and lazier (0.05 is the native renderer's number: a kick lands in
// ~3 frames), lower is snappier. Read once like the gain, for the same reason.
function readPulseTau() {
  const raw = process.env.YOURLYRICS_PULSE_TAU;
  if (raw === undefined || raw === '') {
    return 0.08;
  }
  const value = Number(raw);
  // Bounded below so a typo cannot turn the pulse into per-frame noise, and
  // above so a huge value cannot make the backdrop look stuck.
  return Number.isFinite(value) && value > 0 ? Math.min(value, 2) : 0.05;
}

const pulseTau = readPulseTau();

// Only a real bundle id can be tapped; a source that is a display name (or
// anything else without a dot) is not a process to look up.
function tapTargetFor(state) {
  const source = state && typeof state.source === 'string' ? state.source : '';
  return /^[^\s.]+(\.[^\s.]+)+$/.test(source) ? source : '';
}

function helperPath() {
  if (process.platform === 'win32') {
    return app.isPackaged
      ? path.join(process.resourcesPath, 'vendor', 'windows-loudness', 'loudness-tap.exe')
      : path.join(__dirname, '../../../vendor/windows-loudness/build/loudness-tap.exe');
  }
  return app.isPackaged
    ? path.join(process.resourcesPath, 'vendor', 'loudness-tap', 'loudness-tap')
    : path.join(__dirname, '../../../vendor/loudness-tap/build/loudness-tap');
}

function addonPath() {
  if (process.platform !== 'darwin') {
    return '';
  }
  return app.isPackaged
    ? path.join(process.resourcesPath, 'vendor', 'loudness-tap', 'loudness-tap.node')
    : path.join(__dirname, '../../../vendor/loudness-tap/build/loudness-tap.node');
}

let cachedAddon;
function loadAddon() {
  if (cachedAddon !== undefined) {
    return cachedAddon;
  }
  if (process.platform !== 'darwin' || typeof process.dlopen !== 'function') {
    cachedAddon = null;
    return cachedAddon;
  }
  const file = addonPath();
  if (!file || !fs.existsSync(file)) {
    cachedAddon = null;
    return cachedAddon;
  }
  try {
    const mod = { exports: {} };
    process.dlopen(mod, file);
    cachedAddon = mod.exports;
  } catch (error) {
    console.error(`[loudness] Failed to load native addon: ${error.message}`);
    cachedAddon = null;
  }
  return cachedAddon;
}

let child = null;
let addonActive = false;
let readInterface = null;
let errorInterface = null;
let generation = 0;
let target = '';
const silentLevels = { low: 0, mid: 0, high: 0, overall: 0 };
let lastLevels = silentLevels;
let lastSampleAt = 0;
let lastStatus = '';
let warnedMissingBinary = false;
let pollTimer = null;
let publishTimer = null;
let unsubscribeNowPlaying = null;
const publishedBands = new WeakMap();
const observedContents = new WeakSet();

function sameLevels(a, b) {
  return a.low === b.low && a.mid === b.mid && a.high === b.high && a.overall === b.overall;
}

function send(levels) {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      const contents = window.webContents;
      if (!observedContents.has(contents)) {
        observedContents.add(contents);
        contents.on('did-start-loading', () => publishedBands.delete(contents));
      }
      if (contents.isDestroyed() || contents.isLoadingMainFrame()) {
        publishedBands.delete(contents);
        continue;
      }
      // Silence and held samples need only one message per renderer. Track
      // recipients separately so new or reloaded windows receive an initial value.
      const previous = publishedBands.get(contents);
      if (previous && sameLevels(previous, levels)) continue;
      contents.send('backdrop:volume', {
        low: levels.low,
        mid: levels.mid,
        high: levels.high,
        overall: levels.overall,
        gain: pulseGain,
        tau: pulseTau
      });
      publishedBands.set(contents, { ...levels });
    }
  }
}

// One publish step: the band if a fresh sample exists, zero if the source went
// quiet or went away. Published on a timer rather than per sample so the IPC
// rate is a frame budget and not the child's 112.5 Hz. Each window receives
// changes independently, including an initial sample when it opens.
function publish() {
  const fresh = Date.now() - lastSampleAt <= kMaxSampleAgeMs;
  send(fresh ? lastLevels : silentLevels);
}

// One 0..1 lane out of a sample line, with a fallback for a lane the helper did
// not send (and for the legacy single `band` value).
function level(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : fallback;
}

function handleLine(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (!message || typeof message !== 'object') {
    return;
  }
  if (message.type === 'sample') {
    // `band` is the legacy single-value sample (and what the test harness
    // feeds); the helpers publish the four lanes, where `overall` is the
    // low/mid/high mixture that replaces it.
    const overall = level(message.overall, level(message.band, NaN));
    if (!Number.isFinite(overall)) {
      return;
    }
    lastLevels = {
      low: level(message.low, overall),
      mid: level(message.mid, overall),
      high: level(message.high, overall),
      overall
    };
    lastSampleAt = Date.now();
    return;
  }
  if (message.type === 'status' || message.type === 'ready') {
    const status = [message.state || 'ready', message.detail, message.code]
      .filter((part) => part !== undefined && part !== null && part !== '')
      .join(' ');
    if (status === lastStatus) {
      return;
    }
    lastStatus = status;
    if (message.state === 'error') {
      console.error(`[loudness] ${status}`);
    } else {
      console.log(`[loudness] ${status}`);
    }
  }
}

function stopChild() {
  generation += 1;
  if (addonActive) {
    addonActive = false;
    try {
      cachedAddon?.stop();
    } catch (error) {
      console.error(`[loudness] Failed to stop native addon: ${error.message}`);
    }
  }
  if (readInterface) {
    readInterface.removeAllListeners('line');
    readInterface.close();
    readInterface = null;
  }
  if (errorInterface) {
    errorInterface.removeAllListeners('line');
    errorInterface.close();
    errorInterface = null;
  }
  if (child) {
    const doomed = child;
    doomed.removeAllListeners('exit');
    doomed.kill('SIGTERM');
    child = null;
    // A helper that does not go down on SIGTERM would keep the process tap
    // alive and, worse, keep capturing a player the user has stopped using.
    // SIGKILL is not graceful -- but the CoreAudio objects are keyed to the
    // process and are reclaimed either way, and this path only runs if the
    // graceful one already failed.
    const grace = setTimeout(() => {
      if (doomed.exitCode === null && doomed.signalCode === null) {
        doomed.kill('SIGKILL');
      }
    }, 1500);
    grace.unref?.();
  }
  lastStatus = '';
  // The samples stop with the child, so the freshness window is cleared rather
  // than left to expire: a target change should land as silence immediately.
  lastSampleAt = 0;
  lastLevels = silentLevels;
}

function startChild() {
  const addon = loadAddon();
  if (addon) {
    const spawnGeneration = ++generation;
    addonActive = true;
    try {
      addon.start(target, (line) => {
        if (spawnGeneration === generation) {
          handleLine(line);
        }
      });
      return;
    } catch (error) {
      addonActive = false;
      console.error(`[loudness] Native addon start failed: ${error.message}`);
    }
  }

  const binary = helperPath();
  if (!fs.existsSync(binary)) {
    if (!warnedMissingBinary) {
      warnedMissingBinary = true;
      const hint =
        process.platform === 'win32' ? 'npm run build:loudness:win' : 'npm run build:loudness';
      console.error(`[loudness] Helper is missing; run \`${hint}\``);
    }
    return;
  }

  // The loopback helper takes no argument: it always captures the default
  // render endpoint, so there is no pid/bundle-id to pass.
  const args = process.platform === 'win32' ? [] : [target];
  const proc = spawn(binary, args, {
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const spawnGeneration = ++generation;
  child = proc;

  readInterface = readline.createInterface({ input: proc.stdout });
  readInterface.on('line', (line) => {
    if (spawnGeneration === generation) {
      handleLine(line);
    }
  });

  proc.on('error', (error) => {
    if (spawnGeneration !== generation) {
      return;
    }
    child = null;
    console.error(`[loudness] Could not start helper: ${error.message}`);
  });

  errorInterface = readline.createInterface({ input: proc.stderr });
  errorInterface.on('line', (line) => {
    if (spawnGeneration === generation && line.trim()) {
      console.error(`[loudness] ${line.trim()}`);
    }
  });

  proc.on('exit', (code, signal) => {
    if (spawnGeneration !== generation) {
      return;
    }
    child = null;
    if (signal === 'SIGTERM') {
      return;
    }
    console.error(`[loudness] Helper exited (code ${code ?? 'null'}); restarting`);
    if (process.platform === 'win32') {
      // Loopback has no target to clear; just retry. A loop that fails again
      // will fail again one poll later, same as the macOS path.
      setTimeout(() => {
        if (publishTimer) {
          startChild();
        }
      }, 2000);
      return;
    }
    // Clear the target and let the next sync bring it back: the child only
    // ever dies on its own for a reason worth retrying through, and a restart
    // loop that fails again will simply fail again one poll later.
    target = '';
    setTimeout(() => {
      if (pollTimer) {
        syncTarget();
      }
    }, 2000);
  });
}

// Re-resolve the tap target. The child itself re-resolves the pid behind a
// fixed bundle id (player relaunch), so a tap change is the only thing this
// side ever restarts it for.
//
// An empty source does NOT stop the child. Nothing is playing, so the tapped
// app is producing no audio, samples stop on their own, and the freshness rule
// publishes zero -- while the tap stays warm. Killing it there charged every
// pause->play cycle and every app-start-with-nothing-playing a full respawn,
// which is the 1-1.5 s the tracker was late by whenever it had to cold start.
function syncTarget() {
  const next = tapTargetFor(getNowPlaying());
  if (next === target || next === '') {
    return;
  }
  stopChild();
  target = next;
  startChild();
}

function startLoudness() {
  if (process.platform === 'win32') {
    if (publishTimer) {
      return;
    }
    startChild();
    publishTimer = setInterval(publish, kPublishMs);
    return;
  }
  if (process.platform !== 'darwin' || pollTimer) {
    return;
  }
  syncTarget();
  unsubscribeNowPlaying = onNowPlayingChanged(syncTarget);
  pollTimer = setInterval(syncTarget, kTargetPollMs);
  publishTimer = setInterval(publish, kPublishMs);
}

function stopLoudness() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (publishTimer) {
    clearInterval(publishTimer);
    publishTimer = null;
  }
  if (unsubscribeNowPlaying) {
    unsubscribeNowPlaying();
    unsubscribeNowPlaying = null;
  }
  stopChild();
}

module.exports = { startLoudness, stopLoudness };
