'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const vm = require('node:vm');
const { checkPackaged } = require('../scripts/smoke-packaged.cjs');
const { rendererCheck } = require('../src/main/window/packaged-smoke');

function launch({ report = {}, code = 0, write = true, hang = false, softwareRendering = false } = {}) {
  let profile;
  return {
    profile: () => profile,
    spawnApp(_executable, args, options) {
      assert.deepEqual(args, softwareRendering
        ? ['--use-gl=angle', '--use-angle=swiftshader-webgl', '--enable-unsafe-swiftshader', '--smoke-test']
        : ['--smoke-test']);
      assert.equal(options.env.ELECTRON_RUN_AS_NODE, undefined);
      assert.equal(options.env.NODE_OPTIONS, undefined);
      profile = options.env.YOURLYRICS_SMOKE_PROFILE;
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => child.emit('close', null, 'SIGKILL');
      if (!hang) queueMicrotask(() => {
        if (write) fs.writeFileSync(path.join(profile, 'result.json'), JSON.stringify({
          ok: true,
          packaged: true,
          platform: process.platform,
          arch: process.arch,
          electron: require('electron/package.json').version,
          version: require('../package.json').version,
          checks: { preload: true, renderer: true, ipc: true, backdrop: 'animated' },
          ...report
        }));
        child.emit('close', code, null);
      });
      return child;
    }
  };
}

test('packaged startup requires runtime proof and removes its disposable profile', async () => {
  const fixture = launch();
  const report = await checkPackaged('/unused/test-app', process.arch, fixture);
  assert.equal(report.ok, true);
  assert.equal(fs.existsSync(fixture.profile()), false);
});

test('a successful exit without a startup report fails', async () => {
  const fixture = launch({ write: false });
  await assert.rejects(checkPackaged('/unused/test-app', process.arch, fixture), /ENOENT/);
  assert.equal(fs.existsSync(fixture.profile()), false);
});

test('GPU-less runners can explicitly select software WebGL for the isolated check', async () => {
  const fixture = launch({ softwareRendering: true });
  const report = await checkPackaged('/unused/test-app', process.arch, { ...fixture, softwareRendering: true });
  assert.equal(report.ok, true);
});

for (const [name, report, message] of [
  ['wrong architecture', { arch: 'different' }, /architecture/],
  ['wrong Electron', { electron: '0.0.0' }, /Electron version/],
  ['wrong release', { version: '0.0.0' }, /version does not match/],
  ['development runtime', { packaged: false }, /packaged application/],
  ['missing renderer', { checks: { preload: true, ipc: true } }, /Renderer did not start/],
  ['missing preload', { checks: { renderer: true, ipc: true } }, /Preload did not start/],
  ['broken IPC', { checks: { preload: true, renderer: true } }, /IPC did not work/]
]) {
  test(`packaged startup rejects ${name}`, async () => {
    const fixture = launch({ report });
    await assert.rejects(checkPackaged('/unused/test-app', process.arch, fixture), message);
  });
}

test('startup failures preserve the packaged error in the CI result', async () => {
  const fixture = launch({ code: 1, report: { ok: false, error: 'Invalid or incompatible cached data' } });
  await assert.rejects(checkPackaged('/unused/test-app', process.arch, fixture), /incompatible cached data/);
});

test('a hung app fails instead of passing or waiting indefinitely', async () => {
  const fixture = launch({ hang: true });
  await assert.rejects(checkPackaged('/unused/test-app', process.arch, { ...fixture, timeout: 10 }), /timed out/);
  assert.equal(fs.existsSync(fixture.profile()), false);
});

function rendererFixture(canvas, missingSurface) {
  return {
    performance: { now: () => 0 },
    document: {
      body: { hidden: false, classList: { contains: () => false } },
      fonts: { ready: Promise.resolve(), check: () => true },
      querySelector: selector => selector === '.backdrop' ? canvas : selector === missingSurface ? null : {}
    },
    window: { app: {
      nowPlaying: { get: async () => ({ title: '' }) },
      updates: { version: async () => require('../package.json').version }
    } }
  };
}

test('renderer startup accepts the intentional fallback when WebGL is unavailable', async () => {
  const result = await vm.runInNewContext(rendererCheck, rendererFixture(null));
  assert.equal(result.renderer, true);
  assert.equal(result.backdrop, 'fallback');
});

test('renderer startup still rejects an uninitialized canvas or missing player surfaces', async () => {
  await assert.rejects(vm.runInNewContext(rendererCheck, rendererFixture({ width: 0, height: 0 })), /surfaces/);
  await assert.rejects(vm.runInNewContext(rendererCheck, rendererFixture(null, '.lyrics-track')), /surfaces/);
  const result = await vm.runInNewContext(rendererCheck, rendererFixture({ width: 800, height: 600 }));
  assert.equal(result.backdrop, 'animated');
});
