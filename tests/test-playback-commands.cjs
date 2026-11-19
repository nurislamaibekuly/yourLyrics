'use strict';

// Run: node --test scripts/test-playback-commands.cjs
// Only source files are read. Every Electron, process, filesystem and timer
// dependency of the modules under test is mocked; no native helper is run.
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const actions = ['play', 'pause', 'previous', 'next'];
const invalidActions = [
  undefined, null, true, 0, 4, {}, [], ['play'], new String('play'),
  '', 'PLAY', 'Play', ' play', 'play ', 'toggle', 'playPause', 'seek',
  'constructor', '__proto__', 'next; touch /tmp/not-run', 'play\nnext'
];
const plain = value => JSON.parse(JSON.stringify(value));
const equal = (actual, expected) => assert.deepEqual(plain(actual), expected);
const flush = async () => {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
};
const source = file => fs.readFileSync(path.join(root, file), 'utf8');

function fakeClock() {
  let id = 0;
  const timeouts = new Map();
  const intervals = new Map();
  return {
    timeouts,
    intervals,
    setTimeout(fn, delay) {
      const key = ++id;
      timeouts.set(key, { fn, delay });
      return key;
    },
    clearTimeout: key => timeouts.delete(key),
    setInterval(fn, delay) {
      const key = ++id;
      intervals.set(key, { fn, delay });
      return key;
    },
    clearInterval: key => intervals.delete(key),
    fire(delay) {
      const due = [...timeouts].filter(([, timer]) => timer.delay === delay);
      assert.ok(due.length, `Expected a ${delay}ms deadline`);
      for (const [key, timer] of due) {
        if (timeouts.delete(key)) timer.fn();
      }
    },
    poll() {
      for (const timer of [...intervals.values()]) timer.fn();
    }
  };
}

function load(file, dependencies, globals) {
  const module = { exports: {} };
  const context = vm.createContext({
    module,
    exports: module.exports,
    __dirname: path.posix.join('/fixture/project with spaces;literal', path.posix.dirname(file)),
    require(name) {
      assert.ok(Object.hasOwn(dependencies, name), `Unmocked dependency: ${name}`);
      return dependencies[name];
    },
    ...globals
  });
  new vm.Script(source(file), { filename: file }).runInContext(context);
  return module.exports;
}

function mainHarness(platform = 'darwin', options = {}) {
  const clock = fakeClock();
  const handlers = new Map();
  const listeners = new Map();
  const events = new EventEmitter();
  const changes = [];
  const invocations = [];
  const logs = [];
  const globals = {
    ...clock,
    process: {
      platform,
      resourcesPath: '/fixture/Resources with spaces;literal',
      env: { SystemRoot: 'C:\\Test Windows' },
      versions: { electron: 'test', chrome: 'test', node: 'test' }
    },
    console: { error: (...args) => logs.push(args) },
    Buffer,
    Date: options.Date || Date,
    AbortController,
    fetch: options.fetch
  };
  const nowPlaying = load('src/main/media/now-playing.js', {
    './browser-metadata': require('../src/main/media/browser-metadata'),
    electron: {
      ipcMain: {
        handle: (name, fn) => handlers.set(name, fn),
        on: (name, fn) => listeners.set(name, fn)
      },
      BrowserWindow: {
        getAllWindows: () => [
          {
            isDestroyed: () => false,
            webContents: {
              send(name, state) {
                changes.push(plain(state));
                events.emit(name, { privateEvent: true }, state);
              }
            }
          },
          {
            isDestroyed: () => true,
            webContents: { send: () => assert.fail('Sent to a destroyed window') }
          }
        ]
      }
    },
    'node:fs': { readFileSync: () => assert.fail('Unexpected artwork read') },
    'node:path': path,
    // The catalog artwork fallback resolves through the lyrics search; the
    // default answer is "no art in the catalog" so existing tests see no
    // extra publishes.
    '../lyrics': {
      resolveLyricsFlowArtwork: options.resolveLyricsFlowArtwork || (async () => null)
    }
  }, globals);
  nowPlaying.registerNowPlayingIpc(options.refreshNowPlaying);
  let bridge;
  const ipcRenderer = {
    invoke(name, ...args) {
      invocations.push({ name, args });
      return Promise.resolve().then(() => handlers.get(name)({}, ...args));
    },
    send: (name, ...args) => listeners.get(name)({}, ...args),
    on: (name, callback) => events.on(name, callback)
  };
  load('src/preload/index.js', {
    electron: {
      contextBridge: {
        exposeInMainWorld(name, value) {
          assert.equal(name, 'app');
          bridge = value;
        }
      },
      ipcRenderer
    }
  }, globals);
  return {
    nowPlaying, bridge, clock, globals, handlers, changes, invocations,
    events, logs, ipcRenderer,
    control: action => bridge.nowPlaying.control(action),
    direct: action => handlers.get('now-playing:control')({}, action)
  };
}

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stderr.setEncoding = () => {};
  child.stdin = new EventEmitter();
  child.writes = [];
  child.kills = [];
  child.stdin.destroyed = false;
  child.stdin.write = (text, callback) => {
    if (child.writeError) throw child.writeError;
    assert.ok(text.endsWith('\n'));
    child.writes.push({ text, message: JSON.parse(text), callback });
    return child.writeReturn !== false;
  };
  child.stdin.end = () => { child.stdin.destroyed = true; };
  child.kill = signal => {
    child.kills.push(signal);
    return true;
  };
  return child;
}

function providerHarness(t, platform, options = {}) {
  const h = mainHarness(platform, options);
  const spawns = [];
  const execs = [];
  const registrations = [];
  const children = {
    spawn(file, args, settings) {
      assert.equal(settings.shell, undefined);
      const child = fakeChild();
      spawns.push({ file, args: plain(args), settings: plain(settings), child });
      return child;
    },
    execFile(file, args, settings, callback) {
      assert.equal(settings.shell, undefined);
      if (h.execError) throw h.execError;
      const child = fakeChild();
      execs.push({ file, args: plain(args), settings: plain(settings), callback, child });
      return child;
    }
  };
  const isMac = platform === 'darwin';
  const provider = load(`src/main/media/${isMac ? 'media-remote' : 'windows-media'}.js`, {
    './player-artwork': {
      createArtworkDecoder: settings => require('../src/main/media/player-artwork').createArtworkDecoder({
        ...settings, convert: options.convertArtwork || (async () => '')
      })
    },
    './browser-metadata': require('../src/main/media/browser-metadata'),
    electron: { app: { isPackaged: options.packaged === true } },
    'node:child_process': children,
    'node:fs': { existsSync: () => options.missing !== true },
    'node:path': platform === 'win32' ? path.win32 : path.posix,
    'node:readline': {
      createInterface({ input }) {
        const reader = new EventEmitter();
        reader.closed = false;
        reader.close = () => {
          reader.closed = true;
          reader.removeAllListeners();
        };
        input.reader = reader;
        return reader;
      }
    },
    './now-playing': {
      ...h.nowPlaying,
      setPlaybackHandler(handler) {
        registrations.push(handler);
        h.nowPlaying.setPlaybackHandler(handler);
      }
    }
  }, h.globals);
  const start = isMac ? provider.startMediaRemote : provider.startWindowsMedia;
  const stop = isMac ? provider.stopMediaRemote : provider.stopWindowsMedia;
  Object.assign(h, {
    spawns, execs, registrations, start, stop,
    refresh: provider.refreshNowPlaying,
    handler: () => registrations.findLast(handler => typeof handler === 'function'),
    child: () => spawns.at(-1).child,
    ready() {
      start();
      h.child().emit('spawn');
      // Synthetic empty startup reply; never query a real media session.
      if (isMac) execs.findLast(call => call.args[2] === 'get')?.callback(null, '');
    },
    frame(frame, child = h.child()) {
      child.stdout.reader.emit('line', `${isMac ? '' : 'SMTC '}${JSON.stringify(frame)}`);
    },
    media() {
      if (isMac) {
        h.frame({ type: 'data', diff: false, payload: {
          title: 'Synthetic song', artist: 'Test artist', album: 'Test album',
          bundleIdentifier: 'test.player', duration: 180, elapsedTime: 12, playing: false
        } });
      } else {
        h.frame({ id: h.child().writes[0].message.id, action: 'info', ok: true,
          active: true, title: 'Synthetic song', artist: 'Test artist', album: 'Test album',
          source: 'test.player', duration: 180, position: 12, playing: false,
          thumbnail: 'data:image/png;base64,dGVzdA==' });
      }
      return plain(h.nowPlaying.getNowPlaying());
    }
  });
  t.after(() => {
    stop();
    assert.equal(h.clock.timeouts.size, 0, 'Leaked command or restart deadline');
    assert.equal(h.clock.intervals.size, 0, 'Leaked polling timer');
  });
  return h;
}

test('IPC strictly allowlists actions, including direct calls bypassing preload', async () => {
  const h = mainHarness();
  const calls = [];
  h.nowPlaying.setPlaybackHandler(action => { calls.push(action); return { ok: true }; });
  for (const action of invalidActions) {
    equal(await h.direct(action), { ok: false, error: 'invalid_action' });
  }
  assert.equal(calls.length, 0);
  for (const action of actions) equal(await h.direct(action), { ok: true });
  assert.deepEqual(calls, actions);
  assert.equal(h.clock.timeouts.size, 0);
});

test('preload forwards only exact actions and resolves IPC failures', async () => {
  const h = mainHarness();
  h.nowPlaying.setPlaybackHandler(() => ({ ok: true }));
  for (const action of invalidActions) {
    equal(await h.control(action), { ok: false, error: 'invalid_action' });
  }
  assert.equal(h.invocations.length, 0);
  for (const action of actions) equal(await h.control(action), { ok: true });
  equal(h.invocations, actions.map(action => ({ name: 'now-playing:control', args: [action] })));
  h.ipcRenderer.invoke = () => Promise.reject(new Error('IPC disconnected'));
  equal(await h.control('play'), { ok: false, error: 'IPC disconnected' });
  h.ipcRenderer.invoke = () => { throw { message: 42 }; };
  equal(await h.control('pause'), { ok: false, error: 'playback_failed' });
});

test('preload requests an immediate media refresh through IPC', async () => {
  let refreshes = 0;
  const h = mainHarness('darwin', {
    refreshNowPlaying: () => {
      refreshes += 1;
      return { ok: true };
    }
  });
  equal(await h.bridge.nowPlaying.refresh(), { ok: true });
  assert.equal(refreshes, 1);
  equal(h.invocations, [{ name: 'now-playing:refresh', args: [] }]);

  const unavailable = mainHarness();
  equal(await unavailable.bridge.nowPlaying.refresh(), {
    ok: false,
    error: 'refresh_unavailable'
  });
});

test('availability travels through get/onChanged without changing media fields', async () => {
  const h = mainHarness();
  const received = [];
  h.bridge.nowPlaying.onChanged(null);
  h.bridge.nowPlaying.onChanged((...args) => received.push(args));
  assert.equal((await h.bridge.nowPlaying.get()).controlsAvailable, false);
  h.nowPlaying.publishNowPlaying({ title: 'Synthetic song', artist: 'Fixture',
    positionSeconds: 12, durationSeconds: 180, playing: false, controlsAvailable: true });
  const before = plain(h.nowPlaying.getNowPlaying());
  assert.equal(before.controlsAvailable, false, 'Media updates cannot spoof availability');
  const handler = () => ({ ok: true });
  h.nowPlaying.setPlaybackHandler(handler);
  equal(await h.bridge.nowPlaying.get(), { ...before, controlsAvailable: true });
  equal(received.at(-1), [{ ...before, controlsAvailable: true }]);
  const count = received.length;
  h.nowPlaying.setPlaybackHandler(handler);
  assert.equal(received.length, count);
  h.nowPlaying.publishNowPlaying({ controlsAvailable: false });
  assert.equal(h.nowPlaying.getNowPlaying().controlsAvailable, true);
  h.nowPlaying.setPlaybackHandler('not a function');
  equal(await h.bridge.nowPlaying.get(), before);
  equal(received.at(-1), [before]);
  const copy = h.nowPlaying.getNowPlaying();
  copy.title = 'Changed copy';
  assert.equal(h.nowPlaying.getNowPlaying().title, before.title);
});

test('unavailable, thrown, rejected and malformed handler results always resolve', async () => {
  const h = mainHarness();
  equal(await h.control('play'), { ok: false, error: 'playback_unavailable' });
  for (const [handler, expected] of [
    [() => { throw new Error('sync failure'); }, 'sync failure'],
    [() => Promise.reject(new Error('async failure')), 'async failure'],
    [() => Promise.reject(null), 'playback_failed'],
    [() => Promise.reject({ message: 42 }), 'playback_failed'],
    [() => undefined, 'playback_failed'],
    [() => ({ ok: 'yes' }), 'playback_failed'],
    [() => ({ ok: false, error: 'no_session' }), 'no_session'],
    [() => ({ get ok() { throw new Error('bad result'); } }), 'bad result']
  ]) {
    h.nowPlaying.setPlaybackHandler(handler);
    equal(await h.control('next'), { ok: false, error: expected });
    assert.equal(h.clock.timeouts.size, 0);
  }
  h.nowPlaying.setPlaybackHandler(() => ({ ok: true, private: 'not exposed' }));
  equal(await h.control('play'), { ok: true });
});

test('a stuck handler times out; removal/replacement settles every pending IPC call', async () => {
  const h = mainHarness();
  h.nowPlaying.setPlaybackHandler(() => new Promise(() => {}));
  const timedOut = h.direct('play');
  await flush();
  h.clock.fire(15000);
  equal(await timedOut, { ok: false, error: 'playback_timeout' });
  for (const replacement of [null, () => ({ ok: true })]) {
    const late = [];
    h.nowPlaying.setPlaybackHandler(() => new Promise(resolve => late.push(resolve)));
    const pending = actions.map(h.direct);
    await flush();
    h.nowPlaying.setPlaybackHandler(replacement);
    for (const promise of pending) {
      equal(await promise, { ok: false, error: 'playback_unavailable' });
    }
    for (const resolve of late) resolve({ ok: true });
    await flush();
    assert.equal(h.clock.timeouts.size, 0);
  }
  equal(await h.direct('pause'), { ok: true });
});

test('unregistering before dispatch prevents invoking a stale handler', async () => {
  const h = mainHarness();
  h.nowPlaying.setPlaybackHandler(() => assert.fail('Stale handler invoked'));
  const pending = h.direct('play');
  h.nowPlaying.setPlaybackHandler(null);
  equal(await pending, { ok: false, error: 'playback_unavailable' });
});

test('the preload/main seek channel still filters non-finite values and clamps negatives', () => {
  const h = mainHarness();
  const seeks = [];
  h.nowPlaying.setSeekHandler(seconds => seeks.push(seconds));
  for (const value of [NaN, Infinity, -Infinity, '12', null, {}]) h.bridge.nowPlaying.seek(value);
  h.bridge.nowPlaying.seek(-12);
  h.bridge.nowPlaying.seek(12.5);
  h.nowPlaying.setSeekHandler(null);
  h.bridge.nowPlaying.seek(25);
  assert.deepEqual(seeks, [0, 12.5]);
});

for (const packaged of [false, true]) {
  test(`macOS maps all four actions to Perl send IDs (packaged=${packaged})`, async t => {
    const h = providerHarness(t, 'darwin', { packaged });
    h.ready();
    const before = h.media();
    const adapter = packaged
      ? '/fixture/Resources with spaces;literal/vendor/mediaremote-adapter'
      : '/fixture/project with spaces;literal/vendor/mediaremote-adapter';
    for (const [action, command] of [['play', '0'], ['pause', '1'], ['previous', '5'], ['next', '4']]) {
      const pending = h.control(action);
      await flush();
      const call = h.execs.at(-1);
      assert.equal(call.file, '/usr/bin/perl');
      assert.deepEqual(call.args, [
        `${adapter}/mediaremote-adapter.pl`, `${adapter}/MediaRemoteAdapter.framework`, 'send', command
      ]);
      assert.equal(call.settings.timeout, 5000);
      call.callback(null, '');
      equal(await pending, { ok: true });
      equal(h.nowPlaying.getNowPlaying(), before, 'No optimistic media mutation');
    }
    const count = h.execs.length;
    for (const action of invalidActions) {
      equal(await h.handler()(action), { ok: false, error: 'invalid_action' });
    }
    assert.equal(h.execs.length, count);
  });
}

test('macOS reports exec failures, synchronous launch failures and timeouts', async t => {
  const h = providerHarness(t, 'darwin');
  h.ready();
  for (const error of [new Error('adapter exit 1'), Object.assign(new Error('killed'), { killed: true })]) {
    const pending = h.control('previous');
    await flush();
    h.execs.at(-1).callback(error);
    equal(await pending, { ok: false, error: error.killed ? 'playback_timeout' : error.message });
  }
  h.execError = new Error('cannot exec');
  equal(await h.control('next'), { ok: false, error: 'cannot exec' });
  h.execError = null;
  const pending = h.control('play');
  await flush();
  const call = h.execs.at(-1);
  h.clock.fire(5000);
  equal(await pending, { ok: false, error: 'playback_timeout' });
  assert.deepEqual(call.child.kills, ['SIGKILL']);
  call.callback(null, '');
  assert.equal(h.nowPlaying.getNowPlaying().controlsAvailable, true);
  assert.equal(h.clock.timeouts.size, 0);
});

test('macOS seek coalescing and stream handshake/diff semantics remain intact', t => {
  const h = providerHarness(t, 'darwin');
  h.ready();
  const before = h.media();
  h.frame({ type: 'data', diff: false, payload: {} });
  equal(h.nowPlaying.getNowPlaying(), before);
  h.frame({ type: 'data', diff: true, payload: { elapsedTime: 18 } });
  equal(h.nowPlaying.getNowPlaying(), { ...before, positionSeconds: 18 });
  h.bridge.nowPlaying.seek(1.25);
  const first = h.execs.at(-1);
  assert.deepEqual(first.args.slice(2), ['seek', '1250000']);
  const count = h.execs.length;
  h.bridge.nowPlaying.seek(2);
  h.bridge.nowPlaying.seek(3.5);
  assert.equal(h.execs.length, count);
  first.callback(null);
  const last = h.execs.at(-1);
  assert.deepEqual(last.args.slice(2), ['seek', '3500000']);
  last.callback(null);
  h.frame({ type: 'data', diff: true, payload: { title: null } });
  assert.equal(h.nowPlaying.getNowPlaying().title, 'No song playing');
  assert.equal(h.nowPlaying.getNowPlaying().controlsAvailable, true);
});

test('macOS resync polls MediaRemote without overwriting newer stream state', t => {
  const h = providerHarness(t, 'darwin');
  h.ready();
  h.media();

  equal(h.refresh(), { ok: true });
  const snapshot = h.execs.at(-1);
  assert.deepEqual(snapshot.args.slice(2), ['get', '--micros']);
  h.frame({ type: 'data', diff: true, payload: { elapsedTime: 50 } });
  snapshot.callback(null, JSON.stringify({
    type: 'data',
    diff: false,
    payload: {
      title: 'Synthetic song',
      artist: 'Test artist',
      album: 'Test album',
      elapsedTime: 30,
      duration: 180,
      playing: true,
      playbackRate: 1
    }
  }));
  assert.ok(h.nowPlaying.getNowPlaying().positionSeconds >= 50);
  equal(h.refresh(), { ok: true });
  h.stop();
  equal(h.refresh(), { ok: false, error: 'refresh_unavailable' });
});

test('macOS extrapolates from the fractional source timestamp without whole-second jitter', t => {
  const epochMs = 1700000000000;
  const h = providerHarness(t, 'darwin', {
    Date: class extends Date { static now() { return epochMs + 1250; } }
  });
  h.ready();
  assert.ok(h.spawns[0].args.includes('--micros'));
  for (const fractionalMicros of [1125, 638975, 999875]) {
    h.frame({ type: 'data', diff: false, payload: {
      title: 'Synthetic song', playing: true, playbackRate: 1,
      elapsedTimeMicros: 12345000, durationMicros: 180123456,
      timestampEpochMicros: epochMs * 1000 + fractionalMicros,
      // Prefer the precise fields even if a rounded date is also present.
      elapsedTime: 99, duration: 99, timestamp: new Date(epochMs).toISOString()
    } });
    const state = h.nowPlaying.getNowPlaying();
    const expected = 12.345 + 1.25 - fractionalMicros / 1000000;
    assert.ok(Math.abs(state.positionSeconds - expected) < 0.000001,
      `Fraction ${fractionalMicros} must not become a clock correction`);
    assert.equal(state.durationSeconds, 180.123456);
  }
});

test('macOS precise stream diffs preserve paused fractions, rate and duration bounds', t => {
  const epochMs = 1700000000000;
  const h = providerHarness(t, 'darwin', {
    Date: class extends Date { static now() { return epochMs + 1500; } }
  });
  h.ready();
  h.frame({ type: 'data', diff: false, payload: {
    title: 'Synthetic song', playing: false, playbackRate: 0,
    elapsedTimeMicros: 12345678, durationMicros: 180000000,
    timestampEpochMicros: epochMs * 1000 + 500000
  } });
  assert.equal(h.nowPlaying.getNowPlaying().positionSeconds, 12.345678);
  h.frame({ type: 'data', diff: true, payload: { elapsedTimeMicros: 48456789 } });
  assert.equal(h.nowPlaying.getNowPlaying().positionSeconds, 48.456789);
  h.frame({ type: 'data', diff: true, payload: { playing: true, playbackRate: 2 } });
  // A rate-only resume must not extrapolate across the preceding pause.
  assert.equal(h.nowPlaying.getNowPlaying().positionSeconds, 48.456789);
  h.frame({ type: 'data', diff: true, payload: { elapsedTimeMicros: 179500000 } });
  assert.equal(h.nowPlaying.getNowPlaying().positionSeconds, 180);
});

test('macOS startup and resync snapshots request and decode precise timing', t => {
  const epochMs = 1700000000000;
  const h = providerHarness(t, 'darwin', {
    Date: class extends Date { static now() { return epochMs + 750; } }
  });
  h.start();
  const initial = h.execs[0];
  assert.deepEqual(initial.args.slice(2), ['get', '--micros']);
  const payload = {
    title: 'Synthetic song', playing: true, playbackRate: 1,
    elapsedTimeMicros: 30000000, durationMicros: 180000000,
    timestampEpochMicros: epochMs * 1000 + 625000
  };
  initial.callback(null, JSON.stringify(payload));
  assert.equal(h.nowPlaying.getNowPlaying().positionSeconds, 30.125);
  equal(h.refresh(), { ok: true });
  const refresh = h.execs.at(-1);
  assert.deepEqual(refresh.args.slice(2), ['get', '--micros']);
  refresh.callback(null, JSON.stringify({ ...payload, elapsedTimeMicros: 50000000 }));
  assert.equal(h.nowPlaying.getNowPlaying().positionSeconds, 50.125);
});

test('macOS split play and pause notifications keep the elapsed sample and transport rate coherent', t => {
  let now = 1700000000000;
  const h = providerHarness(t, 'darwin', {
    Date: class extends Date { static now() { return now; } }
  });
  h.ready();
  assert.ok(!h.spawns[0].args.some(arg => arg.startsWith('--debounce=')));
  h.frame({ type: 'data', diff: false, payload: {
    title: 'Synthetic song', playing: false, playbackRate: 0,
    elapsedTimeMicros: 116528000, durationMicros: 204068000,
    timestampEpochMicros: (now - 15000) * 1000
  } });
  now += 1000;
  h.frame({ type: 'data', diff: true, payload: { playing: true } });
  assert.equal(h.nowPlaying.getNowPlaying().positionSeconds, 116.528);
  assert.equal(h.nowPlaying.getNowPlaying().playbackRate, 1,
    'A retained zero rate must not delay the play notification');
  now += 1500;
  h.frame({ type: 'data', diff: true, payload: {
    elapsedTimeMicros: 117146000, timestampEpochMicros: (now - 14) * 1000, playbackRate: 1
  } });
  assert.ok(Math.abs(h.nowPlaying.getNowPlaying().positionSeconds - 118.028) < 0.000001,
    'A lagging post-resume rate confirmation must not rewind the running clock');
  assert.equal(h.nowPlaying.getNowPlaying().playbackRate, 1);
  now += 500;
  h.frame({ type: 'data', diff: true, payload: { artworkMimeType: 'image/png' } });
  assert.ok(Math.abs(h.nowPlaying.getNowPlaying().positionSeconds - 118.528) < 0.000001);
  now += 1000;
  h.frame({ type: 'data', diff: true, payload: { playing: false } });
  assert.ok(Math.abs(h.nowPlaying.getNowPlaying().positionSeconds - 119.528) < 0.000001,
    'The pause notification must not rewind to the old 117.146s sample');
  assert.equal(h.nowPlaying.getNowPlaying().playbackRate, 0);
  now += 1;
  h.frame({ type: 'data', diff: true, payload: {
    elapsedTimeMicros: 119528000, timestampEpochMicros: now * 1000, playbackRate: 0
  } });
  now += 1000;
  h.frame({ type: 'data', diff: true, payload: { artworkMimeType: 'image/jpeg' } });
  assert.equal(h.nowPlaying.getNowPlaying().positionSeconds, 119.528);
});

test('macOS timestamp-only diffs without elapsedTime do not rewind the playing timeline', t => {
  let now = 1700000000000;
  const h = providerHarness(t, 'darwin', {
    Date: class extends Date { static now() { return now; } }
  });
  h.ready();
  h.frame({ type: 'data', diff: false, payload: {
    title: 'Synthetic song', playing: true, playbackRate: 1,
    elapsedTimeMicros: 0, durationMicros: 200000000,
    timestampEpochMicros: now * 1000
  } });
  assert.equal(h.nowPlaying.getNowPlaying().positionSeconds, 0);
  now += 1050;
  h.frame({ type: 'data', diff: true, payload: {
    artworkMimeType: 'image/png',
    timestampEpochMicros: now * 1000
  } });
  assert.ok(Math.abs(h.nowPlaying.getNowPlaying().positionSeconds - 1.05) < 0.000001,
    'A metadata/timestamp diff without elapsedTime must keep advancing from the anchor');
  now += 500;
  h.frame({ type: 'data', diff: true, payload: {
    elapsedTimeMicros: 0,
    timestampEpochMicros: now * 1000
  } });
  assert.ok(Math.abs(h.nowPlaying.getNowPlaying().positionSeconds - 1.55) < 0.000001,
    'A repeated elapsedTime: 0 within 2s of playback start must not rewind the timeline');
});

test('macOS transient null duration, elapsedTime and artwork on resume keep track state intact', t => {
  let now = 1795008723768;
  const h = providerHarness(t, 'darwin', {
    Date: class extends Date { static now() { return now; } }
  });
  h.ready();
  const jpegB64 = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]).toString('base64');
  h.frame({ type: 'data', diff: false, payload: {
    title: 'rises the moon', artist: 'Liana Flores', album: 'recently - EP',
    bundleIdentifier: 'com.apple.Music',
    playing: false, playbackRate: 0,
    elapsedTimeMicros: 103539000, durationMicros: 161929000,
    timestampEpochMicros: now * 1000,
    artworkData: jpegB64
  } });
  const initialArtwork = h.nowPlaying.getNowPlaying().artworkUrl;
  assert.ok(initialArtwork.startsWith('data:image/jpeg;base64,'));

  now = 1795008746122;
  h.frame({ type: 'data', diff: true, payload: {
    elapsedTimeMicros: null, durationMicros: null, artworkData: null,
    timestampEpochMicros: now * 1000, playbackRate: 0
  } });
  const afterNull = h.nowPlaying.getNowPlaying();
  assert.equal(afterNull.durationSeconds, 161.929);
  assert.equal(afterNull.positionSeconds, 103.539);
  assert.equal(afterNull.artworkUrl, initialArtwork);

  h.frame({ type: 'data', diff: true, payload: {
    durationMicros: 161929000, elapsedTimeMicros: 103539000,
    timestampEpochMicros: now * 1000
  } });
  h.frame({ type: 'data', diff: true, payload: { playing: true } });
  assert.equal(h.nowPlaying.getNowPlaying().positionSeconds, 103.539);
  now = 1795008747521;
  h.frame({ type: 'data', diff: true, payload: {
    timestampEpochMicros: now * 1000, elapsedTimeMicros: 104121000, playbackRate: 1
  } });
  assert.ok(Math.abs(h.nowPlaying.getNowPlaying().positionSeconds - 104.938) < 0.001,
    'Apple Music delayed playbackRate=1 packet must not pull the timeline back by ~0.8s');
});

test('macOS retains its idle-state cleanup when exit follows an error', t => {
  const h = providerHarness(t, 'darwin');
  h.ready();
  const before = h.media();
  h.child().emit('error', new Error('stream error'));
  equal(h.nowPlaying.getNowPlaying(), { ...before, controlsAvailable: false });
  h.child().emit('exit', 1, null);
  assert.equal(h.nowPlaying.getNowPlaying().title, 'No song playing');
  assert.equal(h.nowPlaying.getNowPlaying().controlsAvailable, false);
});

test('Windows resync requests a fresh SMTC info frame', t => {
  const h = providerHarness(t, 'win32');
  h.ready();
  h.frame({
    id: 1,
    ok: true,
    active: true,
    title: 'Synthetic song',
    artist: 'Test artist',
    album: 'Test album',
    position: 12,
    duration: 180,
    playing: true
  });
  const requestsBeforeRefresh = h.child().writes.length;
  equal(h.refresh(), { ok: true });
  assert.equal(h.child().writes.length, requestsBeforeRefresh + 1);
  assert.equal(h.child().writes.at(-1).message.action, 'info');
  const requestId = h.child().writes.at(-1).message.id;
  h.frame({
    id: requestId,
    ok: true,
    active: true,
    title: 'Synthetic song',
    artist: 'Test artist',
    album: 'Test album',
    position: 48,
    duration: 180,
    playing: true
  });
  assert.equal(h.nowPlaying.getNowPlaying().positionSeconds, 48);
});

for (const platform of ['darwin', 'win32']) {
  test(`${platform}: missing helper and failed startup never advertise controls`, async t => {
    const missing = providerHarness(t, platform, { missing: true });
    missing.start();
    assert.equal(missing.spawns.length, 0);
    equal(await missing.control('play'), { ok: false, error: 'playback_unavailable' });
    const h = providerHarness(t, platform);
    h.start();
    assert.equal(h.nowPlaying.getNowPlaying().controlsAvailable, false);
    equal(await h.control('play'), { ok: false, error: 'playback_unavailable' });
    h.child().emit('error', new Error('spawn failed'));
    assert.equal(h.nowPlaying.getNowPlaying().controlsAvailable, false);
    h.child().emit('spawn');
    assert.equal(h.nowPlaying.getNowPlaying().controlsAvailable, false);
  });

  for (const ending of ['error', 'exit', 'stop']) {
    test(`${platform}: ${ending} unregisters and settles pending commands`, async t => {
      const h = providerHarness(t, platform);
      h.ready();
      h.media();
      const handler = h.handler();
      const pending = actions.map(h.control);
      await flush();
      const child = h.child();
      const macCalls = h.execs.filter(call => call.args[2] === 'send');
      if (ending === 'stop') h.stop();
      else if (ending === 'error') child.emit('error', new Error('helper failed'));
      else child.emit('exit', 1, null);
      for (const promise of pending) {
        equal(await promise, { ok: false, error: 'playback_unavailable' });
      }
      assert.equal(h.nowPlaying.getNowPlaying().controlsAvailable, false);
      equal(await h.control('play'), { ok: false, error: 'playback_unavailable' });
      equal(await handler('play'), { ok: false, error: 'playback_unavailable' });
      assert.equal(child.stdout.reader.closed, true);
      const before = plain(h.nowPlaying.getNowPlaying());
      for (const call of macCalls) {
        assert.deepEqual(call.child.kills, ['SIGKILL']);
        call.callback(null, '');
      }
      await flush();
      equal(h.nowPlaying.getNowPlaying(), before);
      h.stop();
      assert.equal(h.clock.timeouts.size, 0);
    });
  }

  test(`${platform}: late events from an old process cannot unregister its replacement`, async t => {
    const h = providerHarness(t, platform);
    h.ready();
    const old = h.child();
    old.emit('error', new Error('old helper failed'));
    if (platform === 'win32') {
      h.clock.fire(3000);
      h.child().emit('spawn');
    } else {
      h.ready();
    }
    const before = h.media();
    old.emit('exit', 1, null);
    old.emit('error', new Error('late error'));
    equal(h.nowPlaying.getNowPlaying(), before);
    assert.equal(h.child().stdout.reader.closed, false);
    const pending = h.control('pause');
    await flush();
    if (platform === 'darwin') h.execs.at(-1).callback(null);
    else h.frame({ ...h.child().writes.at(-1).message, ok: true });
    equal(await pending, { ok: true });
  });
}

test('Windows browser sessions publish song metadata and retain the browser timeline', t => {
  const h = providerHarness(t, 'win32');
  h.ready();
  for (const source of ['chrome.exe', 'msedge.exe', 'firefox.exe', 'YandexBrowser']) {
    h.frame({ action: 'info', ok: true, active: true, source,
      title: 'Test Artist – Test Song (Official Music Video)', artist: 'TestArtistVEVO',
      album: '', position: 42.25, duration: 180, playing: true,
      thumbnail: 'data:image/png;base64,dGVzdA==' });
    const state = h.nowPlaying.getNowPlaying();
    assert.equal(state.title, 'Test Song');
    assert.equal(state.artist, 'Test Artist');
    assert.equal(state.source, source);
    assert.equal(state.positionSeconds, 42.25);
    assert.equal(state.durationSeconds, 180);
    assert.equal(state.playing, true);
    assert.equal(state.artworkUrl, 'data:image/png;base64,dGVzdA==');
  }
});

test('browser metadata cleanup preserves song editions and native-player titles', () => {
  const { normalizeBrowserMetadata: normalize } = require('../src/main/media/browser-metadata');
  const cases = [
    ['chrome.exe', 'Test Song', 'Test Artist - Topic', 'Test Song', 'Test Artist'],
    ['msedge.exe', 'Test Artist - Test Song (Official Audio) - YouTube', '', 'Test Song', 'Test Artist'],
    ['chrome.exe', 'Test Song - Live', 'Test Artist', 'Test Song - Live', 'Test Artist'],
    ['chrome.exe', 'Test Song (Acoustic)', 'Test Artist', 'Test Song (Acoustic)', 'Test Artist'],
    ['firefox.exe', 'Test Song (Remix)', 'Test Artist', 'Test Song (Remix)', 'Test Artist'],
    ['Spotify.exe', 'Test Artist - Test Song (Official Video)', 'TestArtistVEVO', 'Test Artist - Test Song (Official Video)', 'TestArtistVEVO'],
    ['msedge.exe', 'Test Song (Official Audio)', 'Actual Artist', 'Test Song', 'Actual Artist']
  ];
  for (const [source, title, artist, expectedTitle, expectedArtist] of cases) {
    const result = normalize({ source, title, artist });
    assert.equal(result.title, expectedTitle);
    assert.equal(result.artist, expectedArtist);
  }
});

test('Windows uses an argv-launched helper and correlated JSON actions without changing media', async t => {
  const h = providerHarness(t, 'win32', { packaged: true });
  h.ready();
  const launch = h.spawns[0];
  assert.equal(launch.file, 'C:\\Test Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.deepEqual(launch.args, ['-NoLogo', '-NoProfile', '-NonInteractive',
    '-ExecutionPolicy', 'Bypass', '-File',
    '\\fixture\\Resources with spaces;literal\\vendor\\windows-media\\smtc.ps1', '-Serve']);
  assert.equal(launch.settings.windowsHide, true);
  const before = h.media();
  const pending = actions.map(h.control);
  await flush();
  const messages = h.child().writes.slice(1).map(write => write.message);
  assert.deepEqual(messages.map(message => message.action), actions);
  assert.equal(new Set(messages.map(message => message.id)).size, 4);
  for (const message of messages) assert.deepEqual(Object.keys(message), ['id', 'action']);
  for (const message of [...messages].reverse()) h.frame({ ...message, ok: true });
  for (const promise of pending) equal(await promise, { ok: true });
  equal(h.nowPlaying.getNowPlaying(), before);
  for (const message of messages) h.frame({ ...message, ok: true });
  equal(h.nowPlaying.getNowPlaying(), before, 'Late replies cannot clear media');
  const count = h.child().writes.length;
  for (const action of invalidActions) {
    equal(await h.handler()(action), { ok: false, error: 'invalid_action' });
  }
  assert.equal(h.child().writes.length, count);
  assert.equal(h.execs.length, 0);
});

test('Windows correlates concurrent successes and failures by id, not response order', async t => {
  const h = providerHarness(t, 'win32');
  h.ready();
  const before = h.media();
  const pending = ['play', 'play', 'next'].map(h.control);
  await flush();
  const messages = h.child().writes.slice(1).map(write => write.message);
  h.frame({ ...messages[2], ok: false, error: 'cannot_skip' });
  h.frame({ ...messages[1], ok: true });
  h.frame({ ...messages[0], ok: false, error: 'cannot_play' });
  equal(await Promise.all(pending), [
    { ok: false, error: 'cannot_play' }, { ok: true }, { ok: false, error: 'cannot_skip' }
  ]);
  equal(h.nowPlaying.getNowPlaying(), before);
});

test('Windows reports rejected commands, helper exceptions and malformed acknowledgements', async t => {
  const h = providerHarness(t, 'win32');
  h.ready();
  const before = h.media();
  for (const [reply, error] of [
    [{ ok: false, error: 'no_session' }, 'no_session'],
    [{ ok: false, error: 'playback_failed' }, 'playback_failed'],
    [{ ok: false, error: 'The Windows media API timed out.' }, 'The Windows media API timed out.'],
    [{ ok: false }, 'playback_failed'],
    [{ ok: 'true', error: {} }, 'playback_failed'],
    [{ ok: true, action: 'info' }, 'invalid_playback_response']
  ]) {
    const pending = h.control('next');
    await flush();
    h.frame({ ...h.child().writes.at(-1).message, ...reply });
    equal(await pending, { ok: false, error });
    equal(h.nowPlaying.getNowPlaying(), before);
  }
});

test('Windows times out missing/malformed responses and ignores late acknowledgements', async t => {
  const h = providerHarness(t, 'win32');
  h.ready();
  const before = h.media();
  const pending = h.control('play');
  await flush();
  const message = h.child().writes.at(-1).message;
  h.child().stdout.reader.emit('line', 'SMTC {bad JSON');
  h.child().stdout.reader.emit('line', JSON.stringify({ ...message, ok: true }));
  h.frame({ ...message, id: message.id + 100, ok: true });
  h.clock.fire(10000);
  equal(await pending, { ok: false, error: 'playback_timeout' });
  h.frame({ ...message, ok: true });
  equal(h.nowPlaying.getNowPlaying(), before);
  assert.equal(h.clock.timeouts.size, 0);
});

test('Windows write failures and broken pipes settle commands without unhandled errors', async t => {
  const h = providerHarness(t, 'win32');
  h.ready();
  h.child().writeError = new Error('write threw');
  equal(await h.control('play'), { ok: false, error: 'playback_unavailable' });
  h.child().writeError = null;
  const pending = h.control('play');
  await flush();
  h.child().writes.at(-1).callback(new Error('write callback failed'));
  equal(await pending, { ok: false, error: 'write callback failed' });
  h.child().stdin.destroyed = true;
  equal(await h.control('pause'), { ok: false, error: 'playback_unavailable' });
  h.child().stdin.destroyed = false;
  const pendingPipe = actions.map(h.control);
  await flush();
  h.child().stdin.emit('error', new Error('EPIPE'));
  for (const promise of pendingPipe) {
    equal(await promise, { ok: false, error: 'playback_unavailable' });
  }
  assert.equal(h.nowPlaying.getNowPlaying().controlsAvailable, false);
});

test('Windows backpressure is not a failed write; seek and info still work independently', async t => {
  const h = providerHarness(t, 'win32');
  h.ready();
  const before = h.media();
  h.child().writeReturn = false;
  const pending = h.control('previous');
  await flush();
  const control = h.child().writes.at(-1).message;
  h.bridge.nowPlaying.seek(-3);
  const seek = h.child().writes.at(-1).message;
  assert.equal(seek.action, 'seek');
  assert.equal(seek.position, 0);
  h.frame({ ...seek, ok: true });
  equal(h.nowPlaying.getNowPlaying(), before);
  h.clock.poll();
  const info = h.child().writes.at(-1).message;
  assert.equal(info.action, 'info');
  const writes = h.child().writes.length;
  h.frame({ ...control, ok: true });
  equal(await pending, { ok: true });
  h.clock.poll();
  assert.equal(h.child().writes.length, writes, 'A control reply must not clear the info request');
  h.frame({ ...info, ok: true, active: false });
  assert.equal(h.nowPlaying.getNowPlaying().title, 'No song playing');
  assert.equal(h.nowPlaying.getNowPlaying().controlsAvailable, true);
});

test('bundled Perl source documents the send protocol used by macOS commands', () => {
  const perl = source('vendor/mediaremote-adapter/mediaremote-adapter.pl');
  assert.match(perl, /mediaremote-adapter\.pl FRAMEWORK_PATH/);
  assert.match(perl, /send\(command\)/);
  assert.match(perl, /command: The MRCommand ID as a number/);
  assert.match(perl, /\$function_name eq "send"[\s\S]*?set_env_param\(\$symbol_name, 0, "command", "\$id"\)/);
});

test('Windows helper source implements exact WinRT actions and preserves response id/action', () => {
  // Source protocol checks only: PowerShell/WinRT cannot execute in this mock VM.
  const helper = source('vendor/windows-media/smtc.ps1');
  const playback = helper.slice(helper.indexOf('function Invoke-Playback'), helper.indexOf('function Write-Frame'));
  assert.ok(playback.length > 0);
  assert.match(playback, /@\('play', 'pause', 'previous', 'next'\) -cnotcontains \$command/);
  const mapping = [...playback.matchAll(/'(play|pause|previous|next)'\s*\{\s*Await\s*\(\$session\.(\w+)\(\)\)\s*\(\[bool\]\)\s*\}/g)]
    .map(([, action, method]) => [action, method]);
  assert.deepEqual(mapping, [['play', 'TryPlayAsync'], ['pause', 'TryPauseAsync'],
    ['previous', 'TrySkipPreviousAsync'], ['next', 'TrySkipNextAsync']]);
  assert.match(playback, /switch -CaseSensitive \(\$command\)/);
  assert.match(playback, /SourceAppUserModelId -eq \$script:lastSource/);
  assert.ok(playback.indexOf('$script:lastSource') < playback.indexOf('$manager.GetCurrentSession()'));
  assert.match(playback, /ok = \$false; action = \$command; error = 'no_session'/);
  assert.match(playback, /ok = \[bool\]\$ok\s+action = \$command/);
  assert.match(helper, /\$task.Wait\(\$timeoutMs\)/);
  assert.match(helper, /\[Console\]::Out.WriteLine\('SMTC ' \+ \$json\)/);
  const serve = helper.slice(helper.indexOf('while ($true)'));
  assert.match(serve, /\$requestAction = \[string\]\$request.action/);
  assert.match(serve, /@\('play', 'pause', 'previous', 'next'\) -ccontains \$requestAction/);
  assert.match(serve, /\$payload = Invoke-Playback \$requestAction/);
  assert.match(serve, /\$payload.id = \$id\s+Write-Frame \$payload/);
  assert.match(serve, /catch\s*\{\s*Write-Frame @\{\s*id = \$id\s+ok = \$false\s+action = \$requestAction/);
  assert.match(serve, /\$payload = Invoke-Seek \(\[double\]\$request.position\)/);
  assert.match(serve, /error = 'invalid_action'/);
});

test('Windows helper falls back to the current session when enumeration is empty', () => {
  const helper = source('vendor/windows-media/smtc.ps1');
  const selection = helper.slice(
    helper.indexOf('function Select-Session'),
    helper.indexOf('function Read-Thumbnail')
  );
  const emptyList = selection.match(
    /if \(\$sessions\.Count -eq 0\) \{([\s\S]*?)\n  \}\n  \$script:emptyCount = 0/
  )?.[1];
  assert.ok(emptyList);
  assert.match(emptyList, /\$null -ne \$current/);
  assert.match(emptyList, /Get-SessionInfo \$current/);
  assert.match(emptyList, /return \[pscustomobject\]@\{ session = \$current; info = \$info \}/);
});

test('artwork falls back to the catalog search when the platform reports none', async () => {
  const resolveCalls = [];
  const coverBody = Buffer.from('cover-bytes');
  const h = mainHarness('darwin', {
    resolveLyricsFlowArtwork: async (track) => {
      resolveCalls.push(track);
      return {
        candidate: {
          artworkUrl:
            'https://is1-ssl.mzstatic.com/image/thumb/Music/x/{w}x{h}bb.jpg'
        }
      };
    },
    fetch: async (url) => {
      assert.equal(
        url,
        'https://is1-ssl.mzstatic.com/image/thumb/Music/x/1000x1000bb.jpg'
      );
      return {
        ok: true,
        headers: { get: () => 'image/jpeg' },
        arrayBuffer: async () =>
          coverBody.buffer.slice(
            coverBody.byteOffset,
            coverBody.byteOffset + coverBody.byteLength
          )
      };
    }
  });
  const nativeTrack = {
    title: 'Synthetic song',
    artist: 'Test artist',
    album: 'Test album',
    artworkUrl: '',
    source: 'com.apple.Music',
    positionSeconds: 10,
    durationSeconds: 180,
    playing: true
  };

  h.nowPlaying.publishNowPlaying(nativeTrack);
  assert.equal(h.changes.at(-1).artworkUrl, '', 'First paint has no art yet');
  await flush();
  await flush();

  const expected = `data:image/jpeg;base64,${coverBody.toString('base64')}`;
  assert.equal(h.changes.at(-1).artworkUrl, expected);
  assert.deepEqual(plain(resolveCalls[0]), {
    title: 'Synthetic song',
    artist: 'Test artist',
    album: 'Test album',
    durationSeconds: 180
  });
  const filled = h.changes.at(-1);
  assert.ok(
    filled.positionSeconds >= 10 && filled.positionSeconds < 10 + 60,
    'The artwork republish must not rewind the progress clock'
  );
  assert.equal(filled.artworkFallback, true);

  const setFallback = h.handlers.get('now-playing:set-artwork-fallback');
  equal(setFallback({}, false), { ok: true, enabled: false });
  assert.equal(h.nowPlaying.getNowPlaying().artworkUrl, '');
  assert.equal(h.nowPlaying.getNowPlaying().artworkRemoteUrl, '');
  assert.equal(h.nowPlaying.getNowPlaying().artworkFallback, false);

  h.nowPlaying.publishNowPlaying({ ...nativeTrack, positionSeconds: 11 });
  assert.equal(h.nowPlaying.getNowPlaying().artworkUrl, '', 'Disabled fallback stays off');
  assert.equal(resolveCalls.length, 1);

  equal(setFallback({}, true), { ok: true, enabled: true });
  assert.equal(h.nowPlaying.getNowPlaying().artworkUrl, expected);
  assert.equal(
    h.nowPlaying.getNowPlaying().artworkRemoteUrl,
    'https://is1-ssl.mzstatic.com/image/thumb/Music/x/1000x1000bb.jpg'
  );
  assert.equal(h.nowPlaying.getNowPlaying().artworkFallback, true);

  // The provider republishing the same track without artwork (the macOS
  // adapter diffs on every elapsed-time tick) must repaint from cache and
  // never flash ''.
  h.nowPlaying.publishNowPlaying({ ...nativeTrack, positionSeconds: 11, durationSeconds: 181 });
  assert.equal(h.changes.at(-1).artworkUrl, expected);
  assert.equal(h.changes.at(-1).positionSeconds, 11);
  assert.equal(resolveCalls.length, 1, 'One catalog search per track');
});

test('idle never searches the catalog; a mid-lookup track change discards the cover', async () => {
  const pending = [];
  const coverBody = Buffer.from('cover-bytes');
  const h = mainHarness('darwin', {
    resolveLyricsFlowArtwork: (track) => new Promise((resolve) => {
      pending.push({ track, resolve });
    }),
    fetch: async () => ({
      ok: true,
      headers: { get: () => 'image/jpeg' },
      arrayBuffer: async () =>
        coverBody.buffer.slice(
          coverBody.byteOffset,
          coverBody.byteOffset + coverBody.byteLength
        )
    })
  });

  h.nowPlaying.publishNowPlaying({});
  await flush();
  assert.equal(pending.length, 0, 'Idle must not search the catalog');

  h.nowPlaying.publishNowPlaying({
    title: 'Track A', artist: 'Artist', album: '', artworkUrl: '',
    positionSeconds: 0, durationSeconds: 100, playing: true
  });
  await flush();
  assert.equal(pending.length, 1);

  // The track changes while A's cover is still in flight.
  h.nowPlaying.publishNowPlaying({
    title: 'Track B', artist: 'Artist', album: '', artworkUrl: '',
    positionSeconds: 0, durationSeconds: 100, playing: true
  });
  await flush();
  assert.equal(pending.length, 2, 'The new track resolves independently');

  const changesBefore = h.changes.length;
  pending[0].resolve({
    candidate: {
      artworkUrl: 'https://is1-ssl.mzstatic.com/image/thumb/x/{w}x{h}bb.jpg'
    }
  });
  await flush();
  await flush();
  assert.equal(h.changes.length, changesBefore, 'The stale cover never publishes');
  assert.equal(h.changes.at(-1).artworkUrl, '');

  pending[1].resolve(null);
  await flush();
  assert.equal(pending.length, 2);

  // Returning to track A repaints instantly from cache, with no new search.
  h.nowPlaying.publishNowPlaying({
    title: 'Track A', artist: 'Artist', album: '', artworkUrl: '',
    positionSeconds: 5, durationSeconds: 100, playing: true
  });
  assert.equal(
    h.changes.at(-1).artworkUrl,
    `data:image/jpeg;base64,${coverBody.toString('base64')}`
  );
  assert.equal(pending.length, 2, 'The cache answers without a third search');
});

test('browser sessions never guess a catalog cover, including timeline and duration updates', async () => {
  let searches = 0;
  const h = mainHarness('win32', {
    resolveLyricsFlowArtwork: async () => { searches++; return null; }
  });
  for (const source of ['firefox.exe', 'com.apple.Safari', 'com.google.Chrome', 'firefox.instance42']) {
    for (const durationSeconds of [0, 180, 181]) {
      h.nowPlaying.publishNowPlaying({
        source, title: 'Video title', artist: 'Uploader', artworkUrl: '', durationSeconds
      });
    }
  }
  await flush();
  assert.equal(searches, 0);
  h.nowPlaying.publishNowPlaying({ artworkUrl: 'data:image/png;base64,iVBORw0KGgo=' });
  assert.match(h.nowPlaying.getNowPlaying().artworkUrl, /^data:image\/png/);
});

test('pending native artwork conversion suppresses catalog lookup', async () => {
  let searches = 0;
  const h = mainHarness('darwin', {
    resolveLyricsFlowArtwork: async () => { searches++; return null; }
  });
  h.nowPlaying.publishNowPlaying({
    source: 'com.apple.Music', title: 'Song', artworkUrl: '', artworkPending: true
  });
  await flush();
  assert.equal(searches, 0);
});

test('a late macOS artwork conversion cannot repaint the next track', async t => {
  let finish;
  const h = providerHarness(t, 'darwin', {
    convertArtwork: () => new Promise(resolve => { finish = resolve; })
  });
  h.ready();
  h.frame({ type: 'data', payload: {
    title: 'Old video', bundleIdentifier: 'org.mozilla.firefox',
    artworkData: Buffer.from('II*\x00old-image').toString('base64')
  } });
  await flush();
  h.frame({ type: 'data', diff: true, payload: { title: 'New video' } });
  finish('data:image/png;base64,iVBORw0KGgo=');
  await flush();
  assert.equal(h.nowPlaying.getNowPlaying().title, 'New video');
  assert.equal(h.nowPlaying.getNowPlaying().artworkUrl, '');
});

test('Windows keeps the browser thumbnail on timeline-only polls and clears it on the next video', t => {
  const h = providerHarness(t, 'win32');
  h.ready();
  const frame = { action: 'info', ok: true, active: true,
    title: 'Video', artist: 'Uploader', source: 'firefox.exe', duration: 180 };
  const thumbnail = 'data:image/png;base64,iVBORw0KGgo=';
  h.frame({ ...frame, thumbnail });
  h.frame({ ...frame, position: 2, thumbnail: null });
  assert.equal(h.nowPlaying.getNowPlaying().artworkUrl, thumbnail);
  h.frame({ ...frame, title: 'Next video', thumbnail: null });
  assert.equal(h.nowPlaying.getNowPlaying().artworkUrl, '');
});

test('macOS converts native TIFF once and keeps browser artwork across timeline updates', async (t) => {
  let conversions = 0;
  const pngUrl = 'data:image/png;base64,iVBORw0KGgo=';
  const h = providerHarness(t, 'darwin', {
    convertArtwork: async () => { conversions++; return pngUrl; }
  });
  h.ready();
  // WebKit publishes raw TIFF under an "image/jpeg" mime; such a data URL is
  // truthy but decodes to nothing, which blanked the cover and skipped the
  // renderer's fallback.
  const tiffB64 = Buffer.from([
    0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08
  ]).toString('base64');
  h.frame({
    type: 'data',
    diff: false,
    payload: {
      title: 'Synthetic song',
      artist: 'Test artist',
      album: 'Test album',
      bundleIdentifier: 'com.apple.WebKit.GPU',
      duration: 180,
      elapsedTime: 12,
      playing: true,
      artworkData: tiffB64,
      artworkMimeType: 'image/jpeg'
    }
  });
  const dropped = plain(h.nowPlaying.getNowPlaying());
  assert.equal(dropped.artworkUrl, '', 'Conversion is asynchronous');
  assert.equal(dropped.artworkPending, true);
  assert.equal(dropped.title, 'Synthetic song');
  await flush();
  assert.equal(h.nowPlaying.getNowPlaying().artworkUrl, pngUrl);
  h.frame({ type: 'data', diff: true, payload: { elapsedTime: 13 } });
  assert.equal(h.nowPlaying.getNowPlaying().artworkUrl, pngUrl);
  assert.equal(conversions, 1);

  h.frame({ type: 'data', diff: true, payload: { title: 'Next browser track' } });
  assert.equal(h.nowPlaying.getNowPlaying().artworkUrl, '', 'A new track cannot inherit old artwork');

  // A genuine JPEG flows through untouched.
  const jpegB64 = Buffer.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46
  ]).toString('base64');
  h.frame({
    type: 'data',
    diff: false,
    payload: {
      title: 'Synthetic song',
      artist: 'Test artist',
      album: 'Test album',
      bundleIdentifier: 'com.apple.Music',
      duration: 180,
      elapsedTime: 13,
      playing: true,
      artworkData: jpegB64,
      artworkMimeType: 'image/jpeg'
    }
  });
  const kept = plain(h.nowPlaying.getNowPlaying());
  assert.equal(kept.artworkUrl, `data:image/jpeg;base64,${jpegB64}`);
});
