'use strict';

// Inspect the actual drawing commands so a viewport resize cannot silently
// squeeze the offscreen reflection back into the visible gap.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const source = fs.readFileSync(path.join(__dirname, '../src/renderer/player/artwork-blur.js'), 'utf8')
  .replace(/^import .*;\n/, '').replace('export function', 'function');

function drawing(viewportWidth, viewportHeight, options = {}) {
  const draws = [];
  const transforms = [];
  let paint;
  let output;
  let renders = 0;
  let decodedCallback;
  const context = {
    clearRect() {}, save() {}, restore() {},
    drawImage(...args) { draws.push(args.slice(1)); },
    translate(...args) { transforms.push(['translate', ...args]); },
    scale(...args) { transforms.push(['scale', ...args]); }
  };
  const classes = { contains: () => true, add() {}, remove() {} };
  const video = { videoWidth: options.videoWidth || 300, videoHeight: options.videoHeight || 400,
    requestVideoFrameCallback(callback) { decodedCallback = callback; return 1; }, currentSrc: 'blob:tall-video',
    classList: classes, after() {} };
  vm.runInNewContext(`${source}\ncreateArtworkBlur(video, { matches: false });`, {
    window: { addEventListener() {}, removeEventListener() {} },
    video, devicePixelRatio: options.pixelRatio || 1,
    ProgressiveBlur: class { render(canvas) { renders += 1; output = { width: canvas.width, height: canvas.height }; } },
    document: {
      body: { dataset: { uiStyle: 'ios' }, classList: classes },
      createElement: () => ({ clientWidth: viewportWidth, clientHeight: viewportHeight,
        style: {}, append() {}, classList: classes, setAttribute() {}, getContext: () => context })
    },
    requestAnimationFrame(callback) { paint = callback; return 1; },
    console
  });
  paint(100);
  return { draws, transforms, output,
    get renders() { return renders; },
    repaint: () => paint(200),
    decode: () => decodedCallback()
  };
}

test('reflected artwork retains its stretched height and extends offscreen', () => {
  const { draws, transforms, output } = drawing(300, 600);
  assert.deepEqual(draws, [[0, 0, 300, 400], [0, 0, 300, 600]]);
  assert.deepEqual(transforms, [['translate', 0, 1000], ['scale', 1, -1]]);
  assert.deepEqual(output, { width: 300, height: 1000 });
});

test('the shared blur source retains the offscreen clone at every viewport height', () => {
  for (const viewportHeight of [500, 700, 1000]) {
    const { draws, output } = drawing(300, viewportHeight);
    assert.equal(draws[1][3], 600);
    assert.equal(output.height, 1000);
  }
});

test('window width scales both artworks together while preserving the configured stretch', () => {
  for (const viewportWidth of [240, 300, 420]) {
    const { draws } = drawing(viewportWidth, 800);
    assert.equal(draws[1][2], draws[0][2]);
    assert.equal(draws[1][3], draws[0][3] * 1.5);
  }
});

test('the sharp artwork uses Retina resolution instead of a 320px intermediate', () => {
  const { output } = drawing(420, 800, { videoWidth: 1200, videoHeight: 1600, pixelRatio: 2 });
  assert.equal(output.width, 840);
  assert.equal(output.height, 2800);
});

test('a decoded video frame is rendered once, without a 15fps cap', () => {
  const result = drawing(300, 600);
  result.repaint();
  result.repaint();
  assert.equal(result.renders, 1, 'Repeated display ticks do not reprocess the same video frame');
  result.decode();
  result.repaint();
  assert.equal(result.renders, 2, 'The next decoded video frame is rendered immediately');
});
