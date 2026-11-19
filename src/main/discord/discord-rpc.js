
'use strict';

const net = require('net');
const path = require('path');
const { ipcMain, BrowserWindow } = require('electron');
const { onNowPlayingChanged, getNowPlaying } = require('../media/now-playing');
const { buildActivity, sanitizeSettings, defaultSettings, activitySignature } = require('./discord-activity');

let settings = { ...defaultSettings };
let socket = null;
let buffer = Buffer.alloc(0);
let ready = false;
let status = { state: 'disabled' };
let onStatusCallback = null;
let reconnectTimer = null;
let updateTimer = null;
let unsubscribe = null;
let registered = false;
let stopped = false;
let attempt = 0;
let generation = 0;
let lastSignature = null;
let lastActivityAt = 0;
let nonce = 0;
const activityMinIntervalMs = 4500;

function emitStatus (state, detail) {
  status = detail ? { state, detail } : { state };
  if (onStatusCallback) onStatusCallback(status);
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send('discord:status', status);
    }
  }
}

function send (opcode, data) {
  if (!socket || socket.destroyed) return false;
  const body = data === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(data), 'utf8');
  const header = Buffer.alloc(8);
  header.writeUInt32LE(opcode, 0);
  header.writeUInt32LE(body.length, 4);
  socket.write(Buffer.concat([header, body]));
  return true;
}

function setActivity (activity) {
  if (!ready) return false;
  return send(1, {
    cmd: 'SET_ACTIVITY',
    args: { pid: process.pid, activity },
    nonce: String(++nonce)
  });
}

function updateActivity () {
  if (!ready || !settings.enabled) return;
  try {
    const np = getNowPlaying();
    const paused = np && (
      np.isPaused === true ||
      np.paused === true ||
      np.playing === false ||
      np.isPlaying === false
    );
    const activity = !np || (settings.hideWhenPaused && paused)
      ? null
      : buildActivity(settings, np);
    const signature = activitySignature(activity);
    if (signature === lastSignature) return;
    if (setActivity(activity)) {
      lastSignature = signature;
      lastActivityAt = Date.now();
    }
  } catch (err) {
    console.error('[discord-rpc] activity update failed:', err);
    emitStatus('error', err.message);
  }
}

function queueUpdate () {
  if (updateTimer) return;
  const elapsed = Date.now() - lastActivityAt;
  const delay = Math.max(
    150,
    lastActivityAt ? activityMinIntervalMs - elapsed : 150
  );
  updateTimer = setTimeout(() => {
    updateTimer = null;
    updateActivity();
  }, delay);
}

function paths () {
  const roots = process.platform === 'win32'
    ? ['\\\\.\\pipe\\']
    : [...new Set([
        process.env.XDG_RUNTIME_DIR,
        process.env.TMPDIR,
        process.env.TMP,
        process.env.TEMP,
        '/tmp',
        '/var/tmp'
      ].filter(Boolean))];

  const result = [];
  for (const root of roots) {
    for (let i = 0; i < 10; i++) {
      result.push(process.platform === 'win32'
        ? `${root}discord-ipc-${i}`
        : path.join(root, `discord-ipc-${i}`));
    }
  }
  return result;
}

function disconnect () {
  generation++;
  ready = false;
  lastSignature = null;
  lastActivityAt = 0;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  clearTimeout(updateTimer);
  updateTimer = null;
  const old = socket;
  socket = null;
  buffer = Buffer.alloc(0);
  if (old) old.destroy();
}

function scheduleReconnect () {
  if (stopped || !settings.enabled || reconnectTimer) return;
  const delay = Math.min(30000, 1000 * 2 ** Math.min(attempt++, 5));
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

function connect () {
  if (stopped || !settings.enabled) return;
  disconnect();
  emitStatus('connecting');
  const token = generation;
  const candidates = paths();
  let index = 0;

  function tryNext () {
    if (token !== generation || stopped || !settings.enabled) return;
    if (index >= candidates.length) {
      emitStatus('unavailable', 'Discord IPC unavailable. Open the Discord desktop app.');
      scheduleReconnect();
      return;
    }

    const candidate = candidates[index++];
    const conn = net.createConnection(candidate);
    socket = conn;
    buffer = Buffer.alloc(0);
    let connected = false;
    let settled = false;
    const timeout = setTimeout(() => conn.destroy(new Error('Discord IPC timeout')), 1500);

    conn.on('connect', () => {
      connected = true;
      clearTimeout(timeout);
      send(0, { v: 1, client_id: settings.clientId });
    });

    conn.on('data', chunk => {
      if (token !== generation) return;
      buffer = Buffer.concat([buffer, chunk]);

      while (buffer.length >= 8) {
        const opcode = buffer.readUInt32LE(0);
        const size = buffer.readUInt32LE(4);
        if (size > 1024 * 1024) {
          conn.destroy(new Error('Invalid Discord frame'));
          return;
        }
        if (buffer.length < size + 8) break;

        const payload = buffer.subarray(8, size + 8);
        buffer = buffer.subarray(size + 8);

        if (opcode === 2) {
          conn.end();
          return;
        }
        if (opcode === 3) {
          send(4, undefined);
          continue;
        }
        if (opcode !== 1) continue;

        let msg;
        try {
          msg = JSON.parse(payload.toString('utf8'));
        } catch (_) {
          continue;
        }

        if (msg.evt === 'READY') {
          ready = true;
          attempt = 0;
          emitStatus('connected');
          updateActivity();
        } else if (msg.evt === 'ERROR') {
          const detail = msg.data?.message || 'Discord rejected the RPC request';
          console.error('[discord-rpc]', detail);
          emitStatus('error', detail);
          if (!ready) conn.destroy();
        }
      }
    });

    conn.on('error', err => {
      if (token === generation && connected) {
        console.error('[discord-rpc] IPC error:', err.message);
      }
    });

    conn.on('close', () => {
      clearTimeout(timeout);
      if (token !== generation || settled) return;
      settled = true;
      ready = false;
      lastSignature = null;
      if (!connected) tryNext();
      else {
        emitStatus('unavailable');
        scheduleReconnect();
      }
    });
  }

  tryNext();
}

exports.registerDiscordRpcIpc = () => {
  if (registered) return;
  registered = true;
  stopped = false;

  ipcMain.handle('discord:set-settings', (_event, value) => {
    const next = sanitizeSettings(value);
    const changed = JSON.stringify(settings) !== JSON.stringify(next);
    settings = next;

    if (!settings.enabled) {
      disconnect();
      emitStatus('disabled');
    } else if (changed || !socket || socket.destroyed) {
      connect();
    } else {
      queueUpdate();
    }
    return { ok: true };
  });

  ipcMain.handle('discord:status', () => status);
  unsubscribe = onNowPlayingChanged(() => queueUpdate());
};

exports.stopDiscordRpc = () => {
  stopped = true;
  disconnect();
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
  if (registered) {
    ipcMain.removeHandler('discord:set-settings');
    ipcMain.removeHandler('discord:status');
    registered = false;
  }
  emitStatus('disabled');
};

exports.onStatus = callback => {
  onStatusCallback = typeof callback === 'function' ? callback : null;
  if (onStatusCallback) onStatusCallback(status);
};
