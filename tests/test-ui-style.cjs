const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '../src/renderer/player/ui-style.js'), 'utf8');
const load = () => import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

test('iOS and iPadOS are selectable and saved settings survive normalization', async () => {
  const { uiStyleOptions, normalizeUiStyle, uiStyleLayout, createUiStyleSwitcher } = await load();
  assert.ok(uiStyleOptions.some(option => option.value === 'ios' && option.label === 'iOS'));
  assert.ok(uiStyleOptions.some(option => option.value === 'ipados' && option.label === 'iPadOS'));
  assert.equal(normalizeUiStyle('ios'), 'ios');
  assert.equal(normalizeUiStyle('ipados'), 'ipados');
  assert.equal(uiStyleLayout('ipados'), 'ios');
  const f = fixture();
  await createUiStyleSwitcher(f.element, value => f.applied.push(value), f.motion)('ios', false);
  await createUiStyleSwitcher(f.element, value => f.applied.push(value), f.motion)('ipados', false);
  assert.deepEqual(f.applied, ['ios', 'ipados']);
});

function fixture() {
  const animations = [];
  const applied = [];
  const classes = new Set();
  const motion = { matches: false, addEventListener(_event, listener) { this.change = listener; } };
  const element = {
    inert: false,
    classList: { add: name => classes.add(name), remove: name => classes.delete(name) },
    animate(keyframes, options) {
      let finish;
      let reject;
      const animation = { keyframes, options, cancelled: false,
        finished: new Promise((resolve, failure) => { finish = resolve; reject = failure; }),
        finish: () => finish(),
        cancel() { this.cancelled = true; reject(new Error('Cancelled')); }
      };
      animations.push(animation);
      return animation;
    }
  };
  return { element, applied, animations, motion, classes };
}

test('old layout fades out before applying tvOS; new layout enters from scale 1.2', async () => {
  const { createUiStyleSwitcher } = await load();
  const f = fixture();
  const switchStyle = createUiStyleSwitcher(f.element, value => f.applied.push(value), f.motion);
  const pending = switchStyle('tvos');
  assert.deepEqual(f.applied, []);
  assert.equal(f.element.inert, true);
  assert.deepEqual(f.animations[0].keyframes.at(-1), { opacity: 0, filter: 'blur(12px)', transform: 'scale(1.2)' });
  f.animations[0].finish();
  await flush();
  assert.deepEqual(f.applied, ['tvos']);
  assert.equal(f.animations[1].keyframes[0].transform, 'scale(1.2)');
  assert.equal(f.animations[1].keyframes.at(-1).transform, 'scale(1)');
  f.animations[1].finish();
  await pending;
  assert.equal(f.element.inert, false);
  assert.equal(f.classes.size, 0);
  assert.ok(f.animations.every(animation => animation.cancelled));
});

test('a newer selection wins an interrupted switch', async () => {
  const { createUiStyleSwitcher } = await load();
  const f = fixture();
  const switchStyle = createUiStyleSwitcher(f.element, value => f.applied.push(value), f.motion);
  global.getComputedStyle = () => ({ opacity: '0.5', filter: 'blur(6px)', transform: 'scale(1.1)' });
  try {
    const first = switchStyle('tvos');
    const second = switchStyle('macos');
    await first;
    assert.deepEqual(f.applied, []);
    assert.equal(f.animations[1].keyframes[0].opacity, '0.5');
    f.animations[1].finish();
    await flush();
    f.animations[2].finish();
    await second;
    assert.deepEqual(f.applied, ['macos']);
    assert.equal(f.element.inert, false);
  } finally { delete global.getComputedStyle; }
});

test('saved settings and reduced motion apply immediately; invalid styles fall back to macOS', async () => {
  const { createUiStyleSwitcher } = await load();
  const f = fixture();
  const switchStyle = createUiStyleSwitcher(f.element, value => f.applied.push(value), f.motion);
  await switchStyle('tvos', false);
  f.motion.matches = true;
  await switchStyle('unknown');
  assert.deepEqual(f.applied, ['tvos', 'macos']);
  assert.equal(f.animations.length, 0);
  f.motion.matches = false;
  const pending = switchStyle('tvos');
  f.motion.matches = true;
  f.motion.change();
  await pending;
  assert.deepEqual(f.applied, ['tvos', 'macos', 'tvos']);
  assert.equal(f.element.inert, false);
  assert.equal(f.classes.size, 0);
});

test('the new player waits for window resizing before fading in', async () => {
  const { createUiStyleSwitcher } = await load();
  const f = fixture();
  let resized;
  const resize = new Promise(resolve => { resized = resolve; });
  const switchStyle = createUiStyleSwitcher(f.element, (value, animate) => {
    assert.equal(value, 'ios');
    assert.equal(animate, true);
    return resize;
  }, f.motion);
  const pending = switchStyle('ios');
  f.animations[0].finish();
  await flush();
  assert.equal(f.animations.length, 1);
  assert.equal(f.element.inert, true);
  resized();
  await flush();
  assert.equal(f.animations.length, 2);
  f.animations[1].finish();
  await pending;
  assert.equal(f.element.inert, false);
});
