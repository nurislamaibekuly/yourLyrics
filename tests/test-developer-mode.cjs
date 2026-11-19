const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '../src/renderer/ui/developer-mode.js'), 'utf8');
const load = () => import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

test('developer preferences survive recreation; disabling hides saved overlays', async () => {
  const { createDeveloperMode } = await load();
  let saved = null;
  const storage = { getItem: () => saved, setItem: (_key, value) => { saved = value; } };
  const overlay = {};
  const first = createDeveloperMode({ storage, overlay, details: () => [] });
  for (let i = 0; i < 8; i++) first.pressVersion();
  first.setOption('showFps', true);
  const restored = createDeveloperMode({ storage, overlay, details: () => [] });
  assert.deepEqual(restored.state, { enabled: true, showFps: true, showDiagnostics: false, showClock: false, showLyrics: false,
    showBounds: false, refreshMs: 500, corner: 'top-right' });
  assert.equal(overlay.hidden, false);
  for (let i = 0; i < 8; i++) restored.pressVersion();
  assert.equal(overlay.hidden, true);
  const disabled = createDeveloperMode({ storage, overlay, details: () => { throw Error('Must stay idle'); } });
  disabled.recordFrame(1000);
  assert.equal(overlay.hidden, true);
});

test('malformed or unavailable storage keeps developer mode usable', async () => {
  const { createDeveloperMode } = await load();
  for (const getItem of [() => '{broken', () => { throw Error('Unavailable'); }]) {
    const mode = createDeveloperMode({
      storage: { getItem, setItem: () => { throw Error('Unavailable'); } },
      overlay: {}, details: () => []
    });
    assert.equal(mode.state.enabled, false);
    for (let i = 0; i < 8; i++) mode.pressVersion();
    assert.equal(mode.state.enabled, true);
    mode.pressVersion();
    mode.resetPresses();
    for (let i = 0; i < 7; i++) assert.equal(mode.pressVersion(), false);
    assert.equal(mode.pressVersion(), true);
  }
});

test('frame sampler measures elapsed time and resets after hiding the document', async () => {
  const { createDeveloperMode } = await load();
  global.document = { hidden: false };
  try {
    const overlay = {};
    const mode = createDeveloperMode({
      storage: { getItem: () => '{"enabled":true,"showFps":true,"showDiagnostics":true}', setItem() {} },
      overlay, details: () => ['Synthetic playback']
    });
    for (let now = 0; now <= 500; now += 10) mode.recordFrame(now);
    assert.match(overlay.textContent, /100 FPS · 10.0 ms\/frame/);
    assert.match(overlay.textContent, /Slow frames \(>50 ms\) 0/);
    assert.match(overlay.textContent, /Synthetic playback/);
    document.hidden = true;
    mode.recordFrame(10000);
    document.hidden = false;
    for (let now = 10010; now <= 10500; now += 10) mode.recordFrame(now);
    assert.match(overlay.textContent, /100 FPS/);
    mode.recordFrame(11000);
    assert.match(overlay.textContent, /Slow frames \(>50 ms\) 1/);
  } finally { delete global.document; }
});

test('visibility reversals cancel stale exits; reduced motion skips the animation', async () => {
  const { setDeveloperVisibility } = await load();
  let reduce = false;
  global.window = { matchMedia: () => ({ matches: reduce }) };
  global.getComputedStyle = () => ({ opacity: '0.5', filter: 'blur(6px)', transform: 'scale(1.1)' });
  const animations = [];
  const element = {
    hidden: true,
    animate(keyframes, options) {
      let finish;
      const animation = { keyframes, options, cancelled: false,
        finished: new Promise(resolve => { finish = resolve; }),
        cancel() { this.cancelled = true; }, finish: () => finish() };
      animations.push(animation);
      return animation;
    }
  };
  try {
    setDeveloperVisibility(element, true);
    assert.equal(element.hidden, false);
    assert.equal(animations[0].keyframes[0].transform, 'scale(1.2)');
    setDeveloperVisibility(element, false);
    assert.equal(element.inert, true);
    assert.equal(element.hidden, false, 'exit remains visible until it finishes');
    setDeveloperVisibility(element, true);
    assert.equal(animations[1].cancelled, true);
    assert.equal(animations[2].keyframes[0].opacity, '0.5');
    animations[1].finish();
    await Promise.resolve();
    assert.equal(element.hidden, false, 'cancelled exit cannot hide the new entrance');
    animations[2].finish();
    await Promise.resolve();
    assert.equal(element.inert, false);
    reduce = true;
    setDeveloperVisibility(element, false);
    assert.equal(element.hidden, true);
    assert.equal(animations.length, 3);
    setDeveloperVisibility(element, true);
    assert.equal(element.hidden, false);
    assert.equal(animations.length, 3);
  } finally {
    delete global.window;
    delete global.getComputedStyle;
  }
});

test('new preferences are validated and restored without persisting a frozen session', async () => {
  const { createDeveloperMode } = await load();
  let saved = JSON.stringify({ enabled: true, corner: 'invalid', refreshMs: 1, showClock: 'yes' });
  const storage = { getItem: () => saved, setItem: (_key, value) => { saved = value; } };
  const changes = [];
  const mode = createDeveloperMode({ storage, overlay: {}, details: () => [],
    onChange: (options, session) => changes.push({ options, session }) });
  assert.equal(mode.state.corner, 'top-right');
  assert.equal(mode.state.refreshMs, 500);
  assert.equal(mode.state.showClock, false);
  mode.setOption('showClock', true);
  mode.setOption('showLyrics', true);
  mode.setOption('showBounds', true);
  mode.setOption('corner', 'bottom-left');
  mode.setOption('refreshMs', 100);
  mode.setOption('enabled', false);
  mode.setOption('toString', true);
  mode.setOption('refreshMs', -1);
  mode.setOption('showFps', 'true');
  mode.setFrozen(true);
  assert.equal(changes.at(-1).session.needsUpdates, true, 'Freezing holds the display while sampling continues');
  const restored = createDeveloperMode({ storage, overlay: {}, details: () => [] });
  assert.equal(restored.state.showClock, true);
  assert.equal(restored.state.showLyrics, true);
  assert.equal(restored.state.showBounds, true);
  assert.equal(restored.state.enabled, true);
  assert.equal(restored.state.showFps, false);
  assert.equal(restored.state.corner, 'bottom-left');
  assert.equal(restored.state.refreshMs, 100);
  assert.equal(restored.frozen, false);
});

test('paused inspectors refresh on their own interval; freeze only stops their display', async () => {
  const { createDeveloperMode } = await load();
  let position = 2;
  let reads = 0;
  const overlay = {};
  const mode = createDeveloperMode({ storage: { getItem: () => '{"enabled":true,"showClock":true}', setItem() {} },
    overlay, details: () => [], snapshot: () => {
      reads += 1;
      return { playback: { sourceSeconds: 2, rendererSeconds: position, lyricSeconds: position + .1,
        offsetMs: 100, rate: 0, anchorAgeMs: 700, correctionMs: -12, pendingTransport: false } };
    } });
  mode.refresh(0);
  assert.match(overlay.textContent, /Renderer 2.000 s/);
  position = 3;
  mode.refresh(200);
  assert.equal(reads, 1);
  mode.refresh(500);
  assert.match(overlay.textContent, /Renderer 3.000 s/);
  assert.match(overlay.textContent, /Correction -12.0 ms/);
  mode.setFrozen(true);
  const frozen = overlay.textContent;
  position = 4;
  mode.refresh(1000);
  assert.equal(overlay.textContent, frozen);
  assert.equal(mode.report(1000).current.playback.rendererSeconds, 4);
  mode.setFrozen(false);
  mode.refresh(1001);
  assert.match(overlay.textContent, /Renderer 4.000 s/);
});

test('timing recordings are bounded, finish automatically and export independent snapshots', async () => {
  const { createDeveloperMode } = await load();
  let reads = 0;
  let completed = 0;
  const mode = createDeveloperMode({ storage: { getItem: () => '{"enabled":true}', setItem() {} },
    overlay: {}, details: () => [], snapshot: now => { reads += 1; return { playback: { now } }; },
    onTraceComplete: count => { completed = count; } });
  assert.equal(mode.startTrace(1000), true);
  assert.equal(mode.startTrace(1100), false);
  for (let now = 1001; now <= 11000; now += 1) mode.refresh(now);
  assert.equal(mode.recording, false);
  assert.equal(mode.needsUpdates, false);
  assert.equal(completed, 101);
  assert.equal(reads, 101);
  const report = mode.report(12000);
  assert.equal(report.trace.samples.length, 101);
  assert.equal(report.trace.samples[0].elapsedMs, 0);
  assert.equal(report.trace.samples.at(-1).elapsedMs, 10000);
  assert.equal(report.trace.samples.at(-1).playback.now, 11000);
  report.trace.samples[0].playback.now = -1;
  assert.equal(mode.report(13000).trace.samples[0].playback.now, 1000);
  const count = reads;
  mode.refresh(14000);
  assert.equal(reads, count);
  mode.startTrace(15000);
  mode.refresh(35000);
  assert.equal(mode.report(35000).trace.samples.length, 2, 'A delayed timer does not invent skipped samples');
});

test('disabling cancels capture, removes live work and preserves other app preferences', async () => {
  const { createDeveloperMode } = await load();
  let saved;
  let completed = false;
  const overlay = {};
  const changes = [];
  const mode = createDeveloperMode({ storage: { getItem: () => '{"enabled":true,"showBounds":true}',
    setItem: (key, value) => { assert.equal(key, 'yourlyrics:developer'); saved = value; } },
    overlay, details: () => [], snapshot: () => ({}),
    onChange: (state, session) => changes.push({ state, session }),
    onTraceComplete: () => { completed = true; } });
  mode.startTrace(0);
  mode.disable();
  assert.equal(mode.recording, false);
  assert.equal(mode.needsUpdates, false);
  assert.equal(mode.report(100).trace.cancelled, true);
  assert.equal(mode.report(100).current, null);
  assert.equal(completed, false);
  assert.equal(overlay.hidden, true);
  assert.equal(changes.at(-1).state.enabled, false);
  assert.equal(JSON.parse(saved).showBounds, true);
  mode.resetPreferences();
  assert.equal(mode.state.enabled, false);
  assert.equal(mode.state.showBounds, false);
});

test('performance reports include percentiles and reset without erasing a capture', async () => {
  const { createDeveloperMode } = await load();
  global.document = { hidden: false };
  try {
    const mode = createDeveloperMode({ storage: { getItem: () => '{"enabled":true,"showFps":true}', setItem() {} },
      overlay: {}, details: () => [] });
    mode.recordFrame(0);
    for (let now = 10; now <= 500; now += 10) mode.recordFrame(now);
    mode.recordFrame(600);
    mode.refresh(1000);
    const report = mode.report(1000);
    assert.equal(report.performance.p95Ms, 10);
    assert.equal(report.performance.totalFrames, 51);
    assert.equal(report.performance.totalSlowFrames, 1);
    assert.equal(report.performance.sessionLongestMs, 100);
    mode.startTrace(1000);
    mode.stopTrace();
    mode.resetStats();
    assert.equal(mode.report(1001).performance.totalFrames, 0);
    assert.equal(mode.report(1001).trace.samples.length, 1);
    mode.refresh(2000);
    mode.recordFrame(9000);
    assert.equal(mode.report(9000).performance.totalSlowFrames, 0, 'Resuming an idle renderer is not a dropped frame');
  } finally { delete global.document; }
});
