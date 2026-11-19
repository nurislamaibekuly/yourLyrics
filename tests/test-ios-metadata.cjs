const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const source = fs.readFileSync(path.join(__dirname, '../src/renderer/player/ios-metadata.js'), 'utf8');
const load = () => import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

function fixture() {
  let compact = false;
  const animations = [];
  const classes = new Set();
  const listeners = {};
  const motion = { matches: false, addEventListener: (name, callback) => { listeners[name] = callback; } };
  const element = {
    style: { removeProperty(name) { delete this[name === 'will-change' ? 'willChange' : name]; } },
    getBoundingClientRect: () => compact
      ? { x: 120, y: 70, width: 210, height: 20 }
      : { x: 40, y: 540, width: 270, height: 24 },
    matches: () => true,
    animate(keyframes, options) {
      let finish;
      const animation = { keyframes, options, cancelled: false,
        finished: new Promise(resolve => { finish = resolve; }), finish: () => finish(),
        cancel() { this.cancelled = true; }
      };
      animations.push(animation);
      return animation;
    }
  };
  const root = { dataset: { uiStyle: 'ios' }, querySelectorAll: () => [element], querySelector: () => null,
    classList: { add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name) } };
  return { root, element, animations, classes, motion, listeners,
    change: () => { compact = !compact; } };
}

test('metadata collapse uses only compositor transforms and releases its layers', async () => {
  global.window = { addEventListener() {} };
  const { createIosMetadataTransition } = await load();
  const f = fixture();
  const change = createIosMetadataTransition(f.root, f.motion);
  change(f.change);
  assert.equal(f.animations.length, 1);
  const animation = f.animations[0];
  assert.deepEqual(Object.keys(animation.keyframes[0]).sort(), ['scale', 'translate']);
  assert.equal(animation.keyframes[0].translate, '-80px 472px');
  assert.equal(animation.keyframes[0].scale, '1.2');
  assert.equal(f.element.style.willChange, 'translate, scale');
  animation.finish();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(animation.cancelled, true);
  assert.equal(f.element.style.willChange, undefined);
  assert.equal(f.classes.size, 0);
});

test('reduced motion and desktop layouts commit immediately', async () => {
  global.window = { addEventListener() {} };
  const { createIosMetadataTransition } = await load();
  for (const style of ['ios', 'macos']) {
    const f = fixture();
    f.root.dataset.uiStyle = style;
    f.motion.matches = style === 'ios';
    createIosMetadataTransition(f.root, f.motion)(f.change);
    assert.equal(f.animations.length, 0);
    assert.equal(f.element.getBoundingClientRect().y, 70);
  }
});

test('reversing cancels old animations and motion changes clear promoted layers', async () => {
  global.window = { addEventListener() {} };
  const { createIosMetadataTransition } = await load();
  const f = fixture();
  const change = createIosMetadataTransition(f.root, f.motion);
  change(f.change);
  change(f.change);
  assert.equal(f.animations[0].cancelled, true);
  assert.equal(f.animations[1].cancelled, false);
  f.motion.matches = true;
  f.listeners.change();
  assert.equal(f.animations[1].cancelled, true);
  assert.equal(f.classes.size, 0);
});

// Run the renderer's visibility and artwork gates together so a delayed catalog
// response cannot put motion artwork back into the collapsed metadata header.
function artworkVisibilityFixture() {
  const vm = require('node:vm');
  const renderer = fs.readFileSync(path.join(__dirname, '../src/renderer/renderer.js'), 'utf8');
  const artwork = renderer.slice(renderer.indexOf('function animatedArtAspect()'),
    renderer.indexOf("reducedMotion.addEventListener('change'"));
  const visibility = renderer.slice(renderer.indexOf('function setLyricsVisible(visible)'),
    renderer.indexOf('if (lyricsToggle) {\n  lyricsToggle.addEventListener'));
  const classes = new Set(['is-lyrics-hidden']);
  const requests = [];
  let hidden = 0;
  let loaded = 0;
  let expanded = 0;
  class Hls {
    static Events = { ERROR: 'error' };
    static isSupported() { return true; }
    on() {}
    loadSource() { loaded += 1; }
    attachMedia() {}
  }
  const context = vm.createContext({
    document: { body: { dataset: { uiStyle: 'ios' }, classList: {
      contains: name => classes.has(name),
      toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); }
    } } },
    state: { title: 'Song', artist: 'Artist', album: 'Album', durationSeconds: 200 },
    animatedCovers: true, animatedArtKey: '', animatedArtGeneration: 0, lyricsVisible: false,
    lyricsVisibility: {}, reducedMotion: { matches: false }, Hls,
    lyricsKeyFor: value => value.title,
    window: { app: { animatedArt: { get: () => new Promise(resolve => requests.push(resolve)) } } },
    hideAnimatedArt() { hidden += 1; classes.delete('is-tall-animated-art'); },
    syncAnimatedArtPlayback() {}, transitionIosMetadata: change => change(),
    lyricsToggle: { setAttribute() {} }, syncBackdropPlayback() {}, refreshLyricsMetrics() {},
    artworkBlur: { beginExpansion() { expanded += 1; }, cancelExpansion() {} }, artworkImage: {},
    iosControls: null, artworkVideo: { addEventListener() {} }
  });
  vm.runInContext(`${artwork}\n${visibility}`, context);
  return { context, classes, requests, get hidden() { return hidden; }, get loaded() { return loaded; }, get expanded() { return expanded; } };
}

test('collapsing iOS metadata retires extended art and reopening requests it again', () => {
  const f = artworkVisibilityFixture();
  f.context.animatedArtKey = 'active-animation';
  f.classes.add('is-tall-animated-art');
  f.context.setLyricsVisible(true);
  assert.equal(f.hidden, 1);
  assert.equal(f.classes.has('is-tall-animated-art'), false);
  assert.equal(f.classes.has('is-lyrics-hidden'), false);
  assert.equal(f.requests.length, 0);
  f.context.setLyricsVisible(false);
  assert.equal(f.requests.length, 1);
});

test('an in-flight artwork response cannot restore video after metadata collapses', async () => {
  const f = artworkVisibilityFixture();
  f.context.updateAnimatedArt();
  assert.equal(f.requests.length, 1);
  f.context.setLyricsVisible(true);
  f.requests[0]({ url: 'https://fixture.invalid/tall.m3u8' });
  await Promise.resolve();
  assert.equal(f.loaded, 0);
  assert.equal(f.context.animatedArtKey, '');
});

test('track changes keep compact iOS metadata static', () => {
  const f = artworkVisibilityFixture();
  f.context.setLyricsVisible(true);
  f.context.state.title = 'Another song';
  f.context.updateAnimatedArt();
  assert.equal(f.requests.length, 0);
});

test('disabled animated covers do not begin an expansion morph', () => {
  const f = artworkVisibilityFixture();
  f.context.setLyricsVisible(true);
  f.context.animatedCovers = false;
  f.context.setLyricsVisible(false);
  assert.equal(f.expanded, 0);
  assert.equal(f.requests.length, 0);
});
