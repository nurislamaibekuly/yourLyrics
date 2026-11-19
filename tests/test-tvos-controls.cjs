const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const source = fs.readFileSync(path.join(__dirname, '../src/renderer/player/tvos-controls.js'), 'utf8');
const load = () => import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

async function fixture(style = 'tvos', options = {}) {
  const { createTvosControlsAutoHide } = await load();
  const classes = new Set();
  const view = new EventTarget();
  const timers = new Map();
  let id = 0;
  let blocked = false;
  const root = { dataset: { uiStyle: style }, ownerDocument: { defaultView: view, hidden: false },
    classList: { contains: value => classes.has(value), add: value => classes.add(value), remove: value => classes.delete(value) } };
  const controller = createTvosControlsAutoHide(root, () => blocked, {
    schedule(fn, delay) { assert.equal(delay, 3000); timers.set(++id, fn); return id; },
    cancel: key => timers.delete(key),
    ...options
  });
  return { root, controller, timers,
    get hidden() { return classes.has('is-tvos-idle'); },
    hasClass: name => classes.has(name),
    setBlocked: value => { blocked = value; },
    event: type => view.dispatchEvent(new Event(type)),
    expire() { const [key, fn] = timers.entries().next().value; timers.delete(key); fn(); }
  };
}

test('TV controls hide after three seconds; mouse and keyboard activity restore them', async () => {
  const f = await fixture();
  assert.equal(f.hidden, false);
  f.expire();
  assert.equal(f.hidden, true);
  f.event('pointermove');
  assert.equal(f.hidden, false);
  for (let i = 0; i < 20; i++) f.event('pointermove');
  assert.equal(f.timers.size, 1);
  f.expire();
  f.event('keydown');
  assert.equal(f.hidden, false);
  f.controller.dispose();
});

test('portrait transport auto-hide only runs on the lyrics page and wakes on activity', async () => {
  let lyricsVisible = false;
  const f = await fixture('ios', { style: 'ios', idleClass: 'is-ios-idle', enabled: () => lyricsVisible });
  assert.equal(f.timers.size, 0);
  lyricsVisible = true;
  f.controller.refresh();
  f.expire();
  assert.equal(f.hasClass('is-ios-idle'), true);
  f.event('pointerdown');
  assert.equal(f.hasClass('is-ios-idle'), false);
  lyricsVisible = false;
  f.controller.refresh();
  assert.equal(f.timers.size, 0);
  f.controller.dispose();
});

test('menus, dragging, keyboard focus and a hidden document defer auto-hide', async () => {
  const f = await fixture();
  f.setBlocked(true);
  f.expire();
  assert.equal(f.hidden, false);
  f.setBlocked(false);
  f.root.ownerDocument.hidden = true;
  f.expire();
  assert.equal(f.hidden, false);
  f.root.ownerDocument.hidden = false;
  f.expire();
  assert.equal(f.hidden, true);
  f.controller.dispose();
});

test('macOS stays visible; leaving tvOS and disposal cancel pending idle work', async () => {
  const f = await fixture('macos');
  assert.equal(f.timers.size, 0);
  f.root.dataset.uiStyle = 'tvos';
  f.controller.refresh();
  f.expire();
  f.root.dataset.uiStyle = 'macos';
  f.controller.refresh();
  assert.equal(f.hidden, false);
  assert.equal(f.timers.size, 0);
  f.root.dataset.uiStyle = 'tvos';
  f.controller.refresh();
  f.controller.dispose();
  f.event('pointermove');
  assert.equal(f.timers.size, 0);
});

test('idle transitions notify interaction owners once when hiding and waking', async () => {
  const changes = [];
  const f = await fixture('tvos', { onIdleChange: idle => changes.push(idle) });
  f.expire();
  assert.deepEqual(changes, [true]);
  f.event('pointermove');
  assert.deepEqual(changes, [true, false]);
  f.event('pointermove');
  assert.deepEqual(changes, [true, false]);
  f.controller.dispose();
});
