const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createWindowStyleController } = require('../src/main/window/window-style');

function fixture(area = { x: 0, y: 25, width: 1440, height: 1000 }, platform = process.platform) {
  const win = new EventEmitter();
  const original = { x: 30, y: 50, width: 1200, height: 900 };
  let bounds = { ...original };
  let minimum = [800, 600];
  let maximum = [0, 0];
  let nativeMaximum = [Infinity, Infinity];
  Object.assign(win, {
    destroyed: false, maximized: false, fullscreen: false,
    isDestroyed: () => win.destroyed,
    getNormalBounds: () => ({ ...bounds }),
    getBounds: () => ({ ...bounds }),
    getMinimumSize: () => [...minimum],
    getMaximumSize: () => [...maximum],
    getNativeMaximumSize: () => [...nativeMaximum],
    isMaximized: () => win.maximized,
    isFullScreen: () => win.fullscreen,
    unmaximize: () => { win.maximized = false; queueMicrotask(() => win.emit('unmaximize')); },
    maximize: () => { win.maximized = true; },
    setFullScreen(value) {
      win.fullscreen = value;
      queueMicrotask(() => win.emit(value ? 'enter-full-screen' : 'leave-full-screen'));
    },
    setMinimumSize: (width, height) => {
      assert.ok(!maximum[0] || width <= maximum[0], 'Minimum width must fit the active maximum');
      assert.ok(!maximum[1] || height <= maximum[1], 'Minimum height must fit the active maximum');
      minimum = [width, height];
    },
    setMaximumSize: (width, height) => {
      assert.ok(!width || width >= minimum[0], 'Maximum width must fit the active minimum');
      assert.ok(!height || height >= minimum[1], 'Maximum height must fit the active minimum');
      maximum = [width, height];
      // Cocoa retains its old maximum when Electron is given the unlimited
      // sentinel, even though getMaximumSize() immediately reports zeros.
      if (platform !== 'darwin' || (width && height)) {
        nativeMaximum = [width || Infinity, height || Infinity];
      }
    },
    setBounds: value => { bounds = value; }
  });
  return { win, original, controller: createWindowStyleController({ getDisplayMatching: () => ({ workArea: area }) }, platform) };
}

for (const style of ['macos', 'tvos']) {
  test(`leaving iOS for ${style} clears the actual macOS resize limit`, async () => {
    const { win, controller } = fixture(undefined, 'darwin');
    for (let cycle = 0; cycle < 2; cycle++) {
      await controller.set(win, 'ios');
      assert.deepEqual(win.getMaximumSize(), [0, 0], 'iOS leaves resizing unlimited');
      const [nativeWidth, nativeHeight] = win.getNativeMaximumSize();
      assert.ok(nativeWidth >= 1440 && nativeHeight >= 1000, 'iOS installs no native resize cap');
      await controller.set(win, style);
      assert.deepEqual(win.getMaximumSize(), [0, 0]);
      const [width, height] = win.getNativeMaximumSize();
      assert.ok(width >= 1440 && height >= 1000, 'Native resizing must allow a full desktop window');
    }
  });
}

test('restoring a finite macOS desktop limit also restores the native limit', async () => {
  const { win, controller } = fixture(undefined, 'darwin');
  win.setMaximumSize(1600, 1200);
  await controller.set(win, 'ios');
  await controller.set(win, 'macos');
  assert.deepEqual(win.getNativeMaximumSize(), [1600, 1200]);
});

test('portrait bounds fit the display and switching back restores the desktop window', async () => {
  const { win, original, controller } = fixture();
  await controller.set(win, 'ios');
  assert.deepEqual(win.getMinimumSize(), [360, 600]);
  assert.deepEqual(win.getMaximumSize(), [0, 0]);
  assert.equal(win.getNormalBounds().width, 390);
  assert.equal(win.getNormalBounds().height, 844);
  await controller.set(win, 'ios');
  await controller.set(win, 'tvos');
  assert.deepEqual(win.getNormalBounds(), original);
  assert.deepEqual(win.getMinimumSize(), [800, 600]);
  assert.deepEqual(win.getMaximumSize(), [0, 0]);
  await controller.set(win, 'macos');
  assert.deepEqual(win.getNormalBounds(), original);
});

test('switching away from iOS restores an existing desktop maximum', async () => {
  const { win, controller } = fixture();
  win.setMaximumSize(1600, 1200);
  await controller.set(win, 'ios');
  assert.deepEqual(win.getMaximumSize(), [0, 0]);
  await controller.set(win, 'ios');
  await controller.set(win, 'macos');
  assert.deepEqual(win.getMaximumSize(), [1600, 1200]);
});

test('short displays retain portrait proportions without placing the window offscreen', async () => {
  const area = { x: -1280, y: 30, width: 1280, height: 680 };
  const { win, controller } = fixture(area);
  await controller.set(win, 'ios');
  const bounds = win.getNormalBounds();
  assert.ok(bounds.width < bounds.height);
  assert.ok(bounds.x >= area.x && bounds.x + bounds.width <= area.x + area.width);
  assert.ok(bounds.y >= area.y && bounds.y + bounds.height <= area.y + area.height);
});

test('rapid selections during a fullscreen exit finish at the last requested layout', async () => {
  const { win, original, controller } = fixture();
  win.fullscreen = true;
  await Promise.all([controller.set(win, 'ios'), controller.set(win, 'macos'), controller.set(win, 'ios')]);
  assert.equal(win.isFullScreen(), false);
  assert.equal(win.getNormalBounds().width, 390);
  await controller.set(win, 'tvos');
  assert.equal(win.isFullScreen(), true);
  assert.deepEqual(win.getNormalBounds(), original);
});

test('invalid requests and closed windows leave bounds unchanged', async () => {
  const { win, original, controller } = fixture();
  assert.deepEqual(await controller.set(win, 'unknown'), { ok: false });
  assert.deepEqual(await controller.set(null, 'ios'), { ok: false });
  win.destroyed = true;
  assert.deepEqual(await controller.set(win, 'ios'), { ok: false });
  assert.deepEqual(win.getNormalBounds(), original);
});

test('a maximized desktop window restores after leaving the portrait player', async () => {
  const { win, original, controller } = fixture();
  win.maximized = true;
  await controller.set(win, 'ios');
  assert.equal(win.isMaximized(), false);
  await controller.set(win, 'macos');
  assert.equal(win.isMaximized(), true);
  assert.deepEqual(win.getNormalBounds(), original);
});

test('animated portrait switches interpolate bounds before installing final constraints', async () => {
  const { win, controller, original } = fixture();
  const frames = [];
  const setBounds = win.setBounds;
  win.setBounds = bounds => {
    const [minWidth] = win.getMinimumSize();
    const [maxWidth] = win.getMaximumSize();
    assert.ok(bounds.width >= minWidth && (!maxWidth || bounds.width <= maxWidth));
    frames.push({ ...bounds });
    setBounds(bounds);
  };
  await controller.set(win, 'ios', { animate: true });
  assert.ok(frames.some(frame => frame.width > 390 && frame.width < original.width));
  assert.equal(frames.at(-1).width, 390);
  assert.deepEqual(win.getMaximumSize(), [0, 0]);
  frames.length = 0;
  await controller.set(win, 'macos', { animate: true });
  assert.ok(frames.some(frame => frame.width > 390 && frame.width < original.width));
  assert.deepEqual(frames.at(-1), original);
});

test('nonanimated startup sets the final bounds in one step', async () => {
  const { win, controller } = fixture();
  let frames = 0;
  const setBounds = win.setBounds;
  win.setBounds = bounds => { frames++; setBounds(bounds); };
  await controller.set(win, 'ios', { animate: false });
  assert.equal(frames, 1);
});
