'use strict';

const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, test } = require('node:test');

const { createLogger } = require('../src/main/window/logger');

const savedConsole = {
  log: console.log,
  info: console.info,
  warn: console.warn,
  error: console.error,
  debug: console.debug
};

afterEach(() => {
  Object.assign(console, savedConsole);
});

test('writes main and renderer logs under userData/logs/yourlyrics.log', async (t) => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'yourlyrics-log-'));
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }));

  const logger = createLogger();
  const ready = logger.init({
    getPath: (name) => (name === 'userData' ? userData : ''),
    getVersion: () => '0.2.18'
  });

  console.log('Flow search missed', 123);
  console.warn('Playback warning');

  const webContents = new EventEmitter();
  logger.attachWindow({ webContents });
  webContents.emit('console-message', {}, 2, 'Renderer warning', 42, 'file:///renderer.js');
  webContents.emit('console-message', {
    level: 'error',
    message: 'Renderer error',
    lineNumber: 99,
    sourceId: 'file:///lyrics.js'
  });

  await ready;
  await logger.flush();

  const logPath = logger.getLogPath();
  assert.equal(logPath, path.join(userData, 'logs', 'yourlyrics.log'));
  const text = fs.readFileSync(logPath, 'utf8');
  assert.match(text, /\[INFO\] \[main\] yourLyrics 0\.2\.18/);
  assert.match(text, /\[INFO\] \[main\] Flow search missed 123/);
  assert.match(text, /\[WARN\] \[main\] Playback warning/);
  assert.match(text, /\[WARN\] \[renderer\] Renderer warning \(renderer\.js:42\)/);
  assert.match(text, /\[ERROR\] \[renderer\] Renderer error \(lyrics\.js:99\)/);
});

test('rotates oversized log file to yourlyrics.prev.log on startup', async (t) => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'yourlyrics-log-rotate-'));
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }));

  const logDir = path.join(userData, 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(path.join(logDir, 'yourlyrics.log'), 'x'.repeat(200), 'utf8');

  const logger = createLogger({ maxBytes: 100 });
  await logger.init({
    getPath: (name) => (name === 'userData' ? userData : ''),
    getVersion: () => '0.2.18'
  });
  console.log('Fresh session');
  await logger.flush();

  assert.equal(fs.readFileSync(path.join(logDir, 'yourlyrics.prev.log'), 'utf8'), 'x'.repeat(200));
  const current = fs.readFileSync(path.join(logDir, 'yourlyrics.log'), 'utf8');
  assert.match(current, /Fresh session/);
  assert.doesNotMatch(current, /x{100}/);
});
