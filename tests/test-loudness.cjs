'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

function harness() {
  let now = 1000;
  const windows = [];
  const readers = [];
  const intervals = new Map();
  const child = new EventEmitter();
  child.stdout = {};
  child.stderr = {};
  child.kill = () => {};
  const dependencies = {
    electron: { BrowserWindow: { getAllWindows: () => windows }, app: { isPackaged: false } },
    'node:child_process': { spawn: () => child },
    'node:fs': { existsSync: () => true },
    'node:path': path,
    'node:readline': {
      createInterface() {
        const reader = new EventEmitter();
        reader.close = () => {};
        readers.push(reader);
        return reader;
      }
    },
    '../media/now-playing': {
      getNowPlaying: () => ({ source: 'com.test.player' }),
      onNowPlayingChanged: () => () => {}
    }
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/main/audio/loudness.js'), 'utf8'), {
    module, __dirname, require: name => {
      assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency: ${name}`);
      return dependencies[name];
    },
    process: { platform: 'darwin', env: {} },
    Date: { now: () => now }, console,
    setInterval(fn, delay) { intervals.set(delay, fn); return delay; },
    clearInterval: id => intervals.delete(id),
    setTimeout: () => ({ unref() {} })
  });
  module.exports.startLoudness();
  return {
    windows,
    window() {
      const messages = [];
      const contents = Object.assign(new EventEmitter(), {
        loading: false, destroyed: false,
        isDestroyed() { return this.destroyed; },
        isLoadingMainFrame() { return this.loading; },
        send: (channel, payload) => messages.push({ channel, ...payload })
      });
      const window = { isDestroyed: () => false, webContents: contents, messages };
      windows.push(window);
      return window;
    },
    publish: () => intervals.get(33)(),
    // A number stands for the legacy single band, which now means the same
    // value in every lane; an object carries the four lanes separately.
    sample: value => readers[0].emit('line', JSON.stringify({
      type: 'sample',
      ...(typeof value === 'number'
        ? { low: value, mid: value, high: value, overall: value }
        : value)
    })),
    // A raw protocol line, for helper shapes the sample() helper does not build.
    line: payload => readers[0].emit('line', JSON.stringify(payload)),
    advance: ms => { now += ms; },
    stop: () => module.exports.stopLoudness(),
    intervals
  };
}

test('silence sends one initial message, including to a late-opening window', () => {
  const h = harness();
  const first = h.window();
  for (let i = 0; i < 300; i += 1) h.publish();
  assert.equal(first.messages.length, 1);
  assert.equal(first.messages[0].overall, 0);
  assert.equal(first.messages[0].low, 0);
  const second = h.window();
  h.publish();
  assert.equal(first.messages.length, 1);
  assert.equal(second.messages.length, 1);
  h.stop();
  assert.equal(h.intervals.size, 0);
});

test('changing samples preserve pulse values and stale samples send zero once', () => {
  const h = harness();
  const window = h.window();
  for (const band of [0.2, 0.2, 0.7, 0.4]) {
    h.sample(band);
    h.publish();
  }
  h.advance(201);
  h.publish();
  h.publish();
  assert.deepEqual(window.messages.map(message => message.overall), [0.2, 0.7, 0.4, 0]);
  assert.ok(window.messages.every(message => message.gain === 0.25));
  h.stop();
});

test('low, mid, high and overall travel as independent lanes', () => {
  const h = harness();
  const window = h.window();
  h.sample({ low: 0.8, mid: 0.4, high: 0.1, overall: 0.5 });
  h.publish();
  h.publish();
  // An unchanged sample is still one message.
  assert.equal(window.messages.length, 1);
  assert.equal(window.messages[0].low, 0.8);
  assert.equal(window.messages[0].mid, 0.4);
  assert.equal(window.messages[0].high, 0.1);
  assert.equal(window.messages[0].overall, 0.5);
  // A single lane moving is a new value, even when the overall level holds.
  h.sample({ low: 0.8, mid: 0.4, high: 0.6, overall: 0.5 });
  h.publish();
  assert.equal(window.messages.length, 2);
  assert.equal(window.messages[1].high, 0.6);
  h.stop();
});

test('a helper that only published one band fills every lane with it', () => {
  const h = harness();
  const window = h.window();
  h.line({ type: 'sample', band: 0.35 });
  h.publish();
  assert.equal(window.messages.length, 1);
  assert.equal(window.messages[0].overall, 0.35);
  assert.equal(window.messages[0].low, 0.35);
  assert.equal(window.messages[0].mid, 0.35);
  assert.equal(window.messages[0].high, 0.35);
  h.stop();
});

test('loading windows receive the current value after reload; destroyed contents are skipped', () => {
  const h = harness();
  const window = h.window();
  h.sample(0.3);
  h.publish();
  window.webContents.loading = true;
  h.publish();
  assert.equal(window.messages.length, 1);
  window.webContents.loading = false;
  h.publish();
  assert.equal(window.messages.length, 2);
  // A fast reload can start and finish between the 33 ms publish ticks.
  window.webContents.emit('did-start-loading');
  h.publish();
  assert.equal(window.messages.length, 3);
  window.webContents.destroyed = true;
  h.sample(0.6);
  h.publish();
  assert.equal(window.messages.length, 3);
  h.stop();
});
