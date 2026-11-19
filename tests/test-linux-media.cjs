'use strict';

// Run: node --test scripts/test-linux-media.cjs
// The Linux provider talks to `playerctl` through child processes; none of
// those run here. The follow stream, the reconcile snapshot, player
// selection, control/seek command lines and artwork handling are all
// driven through fakes, in the style of test-playback-commands.cjs.
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { pathToFileURL } = require('node:url');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const fieldSeparator = '\u001f';
const format = [
  '{{playerName}}',
  '{{status}}',
  '{{title}}',
  '{{artist}}',
  '{{album}}',
  '{{position}}',
  '{{mpris:length}}',
  '{{mpris:artUrl}}'
].join(fieldSeparator);

const plain = (value) => JSON.parse(JSON.stringify(value));
const flush = async () => {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
};

// MPRIS times are microseconds on the wire; every default below is in that
// unit so a conversion mistake in the provider cannot go unnoticed.
function playerLine(name, overrides = {}) {
  return [
    name,
    overrides.status ?? 'Playing',
    overrides.title ?? 'Synthetic song',
    overrides.artist ?? 'Test artist',
    overrides.album ?? 'Test album',
    overrides.position ?? 12000000,
    overrides.duration ?? 180000000,
    overrides.artUrl ?? ''
  ].join(fieldSeparator);
}

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
    clearTimeout: (key) => timeouts.delete(key),
    setInterval(fn, delay) {
      const key = ++id;
      intervals.set(key, { fn, delay });
      return key;
    },
    clearInterval: (key) => intervals.delete(key),
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

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stderr.setEncoding = () => {};
  child.kills = [];
  child.kill = (signal) => {
    child.kills.push(signal);
    return true;
  };
  return child;
}

function harness(t, options = {}) {
  const clock = fakeClock();
  const spawns = [];
  const execs = [];
  const published = [];
  const seekHandlers = [];
  const playbackHandlers = [];
  const logs = [];
  const children = {
    spawn(file, args, settings) {
      assert.equal(settings.shell, undefined);
      const child = fakeChild();
      spawns.push({ file, args: plain(args), settings: plain(settings), child });
      queueMicrotask(() => {
        if (options.spawnError) {
          child.emit('error', options.spawnError);
        } else {
          child.emit('spawn');
        }
      });
      return child;
    },
    execFile(file, args, settings, callback) {
      assert.equal(settings.shell, undefined);
      const child = fakeChild();
      const call = {
        file,
        args: plain(args),
        settings: plain(settings),
        callback,
        child,
        done: false,
        finish(error, stdout = '', stderr = '') {
          if (call.done) return;
          call.done = true;
          callback(error, stdout, stderr);
        }
      };
      execs.push(call);
      return child;
    }
  };

  const module = { exports: {} };
  const context = vm.createContext({
    module,
    exports: module.exports,
    __dirname: path.join(root, 'src', 'main'),
    __filename: path.join(root, 'src', 'main', 'linux-media.js'),
    require(name) {
      switch (name) {
        case 'node:child_process':
          return children;
        case 'node:readline':
          return {
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
          };
        case 'node:fs':
          return {
            existsSync: (candidate) =>
              options.existingPaths
                ? options.existingPaths.has(candidate)
                : true
          };
        case 'node:url':
          return require('node:url');
        case './now-playing':
          return {
            publishNowPlaying: (state) => published.push(plain(state)),
            setSeekHandler: (handler) => seekHandlers.push(handler),
            setPlaybackHandler: (handler) => playbackHandlers.push(handler)
          };
        default:
          assert.fail(`Unmocked dependency: ${name}`);
      }
    },
    process: {
      platform: options.platform || 'linux',
      env: {},
      versions: { node: '22' }
    },
    console: { log() {}, error: (...args) => logs.push(args.join(' ')) },
    Buffer,
    AbortController,
    fetch: options.fetch,
    ...clock
  });
  new vm.Script(
    fs.readFileSync(path.join(root, 'src/main/media/linux-media.js'), 'utf8'),
    { filename: 'src/main/media/linux-media.js' }
  ).runInContext(context);

  const provider = module.exports;
  const h = {
    spawns,
    execs,
    published,
    logs,
    clock,
    seekHandlers,
    playbackHandlers,
    start: provider.startLinuxMedia,
    refresh: provider.refreshNowPlaying,
    stop: provider.stopLinuxMedia,
    child: () => spawns.at(-1).child,
    frame(text) {
      h.child().stdout.reader.emit('line', text);
    },
    handler: () => playbackHandlers.findLast((fn) => typeof fn === 'function'),
    seekHandler: () => seekHandlers.at(-1),
    last: () => published.at(-1),
    reconcile: () => execs.findLast((call) => call.args.includes('metadata'))
  };
  t.after(() => {
    provider.stopLinuxMedia();
    assert.equal(clock.timeouts.size, 0, 'Leaked command or restart deadline');
    assert.equal(clock.intervals.size, 0, 'Leaked polling timer');
  });
  return h;
}

async function start(h) {
  h.start();
  await flush();
}

test('start spawns the follow stream and seeds from a reconcile snapshot', async (t) => {
  const h = harness(t);
  await start(h);
  assert.equal(h.spawns.length, 1);
  assert.equal(h.spawns[0].file, 'playerctl');
  assert.deepEqual(h.spawns[0].args, [
    '--all-players', '--follow', '--format', format, 'metadata'
  ]);
  h.reconcile().finish(null, `${playerLine('spotify')}\n`);
  assert.equal(h.published.length, 1);
  assert.equal(h.last().title, 'Synthetic song');
  assert.equal(h.last().artist, 'Test artist');
  assert.equal(h.last().source, 'spotify');
  assert.equal(h.last().playing, true);
  assert.equal(h.last().positionSeconds, 12, 'Microseconds must convert');
  assert.equal(h.last().durationSeconds, 180, 'Microseconds must convert');
});

test('resync requests an immediate playerctl snapshot', async (t) => {
  const h = harness(t);
  await start(h);
  assert.deepEqual(plain(h.refresh()), { ok: true });
  h.reconcile().finish(null, `${playerLine('spotify')}\n`);
  h.reconcile().finish(null, `${playerLine('spotify')}\n`);

  assert.deepEqual(plain(h.refresh()), { ok: true });
  const request = h.reconcile();
  assert.ok(request);
  request.finish(null, `${playerLine('spotify', { position: 48000000 })}\n`);
  assert.equal(h.last().positionSeconds, 48);
});

test('follow lines publish immediately and the newest player owns the session', async (t) => {
  const h = harness(t);
  await start(h);
  h.frame(playerLine('spotify', { title: 'First song' }));
  assert.equal(h.last().source, 'spotify');
  assert.equal(h.last().title, 'First song');
  h.frame(playerLine('chromium.instance2', { title: 'Second song' }));
  assert.equal(h.last().source, 'chromium.instance2');
  // A later line from the deselected player must not steal the session back.
  h.frame(playerLine('spotify', { title: 'First song', status: 'Paused' }));
  assert.equal(h.last().source, 'chromium.instance2');
  assert.equal(h.last().title, 'Second song');
});

test('a paused player keeps the selection until something else plays', async (t) => {
  const h = harness(t);
  await start(h);
  h.frame(playerLine('spotify', { status: 'Paused' }));
  assert.equal(h.last().source, 'spotify');
  assert.equal(h.last().playing, false);
  h.frame(playerLine('spotify', { status: 'Paused', title: 'Other song' }));
  assert.equal(h.last().source, 'spotify');
  assert.equal(h.last().title, 'Other song');
});

test('reconcile prunes players that quit and republishes the survivor', async (t) => {
  const h = harness(t);
  await start(h);
  h.frame(playerLine('spotify'));
  h.frame(playerLine('chromium.instance2', { title: 'Second song' }));
  assert.equal(h.last().source, 'chromium.instance2');
  h.clock.poll();
  h.reconcile().finish(
    null,
    playerLine('chromium.instance2', { title: 'Second song', position: 30000000 })
  );
  assert.equal(h.last().source, 'chromium.instance2');
  assert.equal(h.last().positionSeconds, 30);
  assert.equal(h.published.at(-2).source, 'chromium.instance2');
});

test('an empty bus publishes idle once and stays quiet', async (t) => {
  const h = harness(t);
  await start(h);
  h.frame(playerLine('spotify'));
  assert.equal(h.last().source, 'spotify');
  h.clock.poll();
  const failure = Object.assign(new Error('playerctl exited with code 1'), {
    code: 1
  });
  h.reconcile().finish(failure, '', 'No players found');
  assert.deepEqual(h.last(), {
    title: '',
    artist: '',
    album: '',
    artworkPath: '',
    artworkUrl: '',
    source: '',
    positionSeconds: 0,
    durationSeconds: 0,
    playing: false
  });
  const publishedAfterIdle = h.published.length;
  h.clock.poll();
  h.reconcile().finish(null, '');
  assert.equal(h.published.length, publishedAfterIdle, 'Idle must not repeat');
});

test('playback controls run through playerctl for the active player', async (t) => {
  const h = harness(t);
  await start(h);
  h.frame(playerLine('spotify'));
  const handler = h.handler();
  assert.equal(typeof handler, 'function');
  assert.deepEqual(plain(await handler('banana')), {
    ok: false,
    error: 'invalid_action'
  });
  const result = handler('pause');
  const command = h.execs.findLast((call) => call.args.includes('pause'));
  assert.ok(command, 'Expected a playerctl pause command');
  assert.equal(command.file, 'playerctl');
  assert.deepEqual(command.args, ['--player', 'spotify', 'pause']);
  assert.equal(h.clock.timeouts.size, 1, 'Command deadline should be armed');
  command.finish(null);
  assert.deepEqual(plain(await result), { ok: true });
  assert.equal(h.clock.timeouts.size, 0, 'Command deadline should be cleared');
});

test('controls report playback_unavailable when nothing is playing', async (t) => {
  const h = harness(t);
  await start(h);
  assert.deepEqual(plain(await h.handler()('play')), {
    ok: false,
    error: 'playback_unavailable'
  });
});

test('seek issues an absolute position command and ignores nonsense', async (t) => {
  const h = harness(t);
  await start(h);
  h.frame(playerLine('spotify'));
  h.seekHandler()(33.5);
  const command = h.execs.findLast((call) => call.args.includes('position'));
  assert.ok(command, 'Expected a playerctl position command');
  assert.deepEqual(command.args, ['--player', 'spotify', 'position', '33.5']);
  const commandsBefore = h.execs.length;
  h.seekHandler()(Number.NaN);
  h.seekHandler()(undefined);
  assert.equal(h.execs.length, commandsBefore);
});

test('a local art file becomes artworkPath; a vanished one becomes none', async (t) => {
  const artPath = path.resolve('/tmp', 'cover with spaces.jpg');
  const h = harness(t, { existingPaths: new Set([artPath]) });
  await start(h);
  h.frame(playerLine('spotify', { artUrl: pathToFileURL(artPath).href }));
  assert.equal(h.last().artworkPath, artPath);
  // The URL is omitted for a file path so normalizeState derives the data
  // URL from the path itself.
  assert.ok(!('artworkUrl' in h.last()));
  // The player purged its cover between lines.
  h.frame(
    playerLine('spotify', { artUrl: pathToFileURL('/tmp/vanished.jpg').href })
  );
  assert.equal(h.last().artworkPath, '');
});

test('remote artwork is downloaded into a data URL exactly once', async (t) => {
  let calls = 0;
  const body = Buffer.from('jpeg-bytes');
  const h = harness(t, {
    fetch: async () => {
      calls += 1;
      return {
        ok: true,
        headers: { get: () => 'image/jpeg; charset=binary' },
        arrayBuffer: async () =>
          body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength)
      };
    }
  });
  await start(h);
  const artUrl = 'https://cdn.example.com/cover.jpg';
  h.frame(playerLine('spotify', { artUrl }));
  assert.equal(h.last().artworkUrl, '', 'The download cannot finish inline');
  await flush();
  assert.equal(calls, 1);
  assert.equal(h.last().artworkUrl, `data:image/jpeg;base64,${body.toString('base64')}`);
  assert.equal(h.last().artworkPath, '');
  // A later line for the same track must reuse the cache, not refetch.
  h.frame(playerLine('spotify', { artUrl, position: 13000000 }));
  assert.equal(calls, 1);
  assert.ok(h.last().artworkUrl.startsWith('data:image/jpeg;base64,'));
});

test('data URLs from the player pass straight through', async (t) => {
  const h = harness(t);
  await start(h);
  h.frame(playerLine('spotify', { artUrl: 'data:image/png;base64,dGVzdA==' }));
  assert.equal(h.last().artworkUrl, 'data:image/png;base64,dGVzdA==');
  assert.equal(h.last().artworkPath, '');
});

test('a missing playerctl warns once and schedules no automatic retry', async (t) => {
  const h = harness(t, {
    spawnError: Object.assign(new Error('spawn playerctl ENOENT'), {
      code: 'ENOENT'
    })
  });
  await start(h);
  assert.equal(h.spawns.length, 1);
  assert.equal(h.logs.length, 1);
  assert.match(h.logs[0], /playerctl not found; install it/);
  assert.equal(h.clock.intervals.size, 0, 'Polling must stop without playerctl');
  assert.equal(h.clock.timeouts.size, 0, 'No retry may be scheduled');
  // An explicit later start may try again -- but must not warn twice.
  await start(h);
  assert.equal(h.spawns.length, 2);
  assert.equal(h.logs.length, 1);
});

test('a dead follow stream publishes idle and restarts on the deadline', async (t) => {
  const h = harness(t);
  await start(h);
  h.frame(playerLine('spotify'));
  assert.equal(h.last().source, 'spotify');
  h.child().emit('exit', 1, null);
  assert.equal(h.last().title, '', 'Death must publish idle');
  assert.equal(h.clock.timeouts.size, 1);
  h.clock.fire(3000);
  assert.equal(h.spawns.length, 2);
  await flush();
  // The restart re-seeds from the bus: the player is still there.
  h.reconcile().finish(null, playerLine('spotify'));
  assert.equal(h.last().source, 'spotify');
});

test('a stream that exits on an empty bus restarts on the quiet delay', async (t) => {
  const h = harness(t);
  await start(h);
  h.child().stderr.emit('data', 'No players found');
  h.child().emit('exit', 1, null);
  const delays = [...h.clock.timeouts.values()].map((timer) => timer.delay);
  assert.deepEqual(delays, [5000], 'The quiet delay outlives the crash delay');
  h.clock.fire(5000);
  assert.equal(h.spawns.length, 2);
});

test('stop kills the stream, closes it and clears every timer', async (t) => {
  const h = harness(t);
  await start(h);
  h.frame(playerLine('spotify'));
  const child = h.child();
  const reader = child.stdout.reader;
  h.stop();
  assert.deepEqual(child.kills, ['SIGTERM']);
  assert.equal(reader.closed, true);
  assert.equal(h.clock.intervals.size, 0);
  // Late events from the dead child must be ignored.
  const publishedBefore = h.published.length;
  child.emit('exit', 0, 'SIGTERM');
  assert.equal(h.published.length, publishedBefore);
  assert.equal(h.clock.timeouts.size, 0);
});

test('the provider stays inert off Linux', async (t) => {
  const h = harness(t, { platform: 'darwin' });
  await start(h);
  assert.equal(h.spawns.length, 0);
  assert.equal(h.clock.intervals.size, 0);
});
