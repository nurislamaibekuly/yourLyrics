'use strict';

// Exercise endpoint parsing, aspect-aware caching and retries without Electron or network access.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '../src/main/media/animated-art.js'), 'utf8');
const track = { title: 'Song', artist: 'Artist', album: 'Album', durationSeconds: 200 };
const video = 'https://mvod.itunes.apple.com/example.m3u8';
const response = payload => new Response(JSON.stringify(payload));

function harness(respond = () => response({ hasMotion: true, video }), albumId = '123') {
  let now = Date.now();
  const calls = [];
  const module = { exports: {} };
  vm.runInNewContext(source, {
    module, console: { error() {} }, AbortSignal, URL, URLSearchParams,
    Date: class extends Date { static now() { return now; } },
    fetch: async (url, options) => {
      calls.push({ url, options });
      return respond(calls.length);
    },
    require(name) {
      if (name === './browser-metadata') return require('../src/main/media/browser-metadata');
      if (name === 'electron') return { ipcMain: {} };
      if (name === '../lyrics') return {
        lyricsFlowRoot: 'https://fixture.invalid', userAgent: 'test', normalizeTrack: input => input,
        resolveLyricsFlowTrack: async () => ({ candidate: { albumId, id: '456' } })
      };
      return require(name);
    }
  }, { filename: 'animated-art.js' });
  return {
    get: input => module.exports.getAnimatedArt({ ...track, ...input }),
    calls, advance: ms => { now += ms; }
  };
}

test('requests the JSON API at high quality and shares album URLs across tracks', async () => {
  const h = harness();
  assert.equal((await h.get()).url, video);
  assert.equal((await h.get({ title: 'Another song' })).url, video);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].url, 'https://fixture.invalid/animatedart?album=123&quality=high&aspect=square');
  assert.equal(h.calls[0].options.headers.Accept, 'application/json');
});

test('tall and square requests have separate caches', async () => {
  const h = harness(count => response({ hasMotion: true, video: `${video}?variant=${count}` }));
  const square = await h.get();
  const tall = await h.get({ aspect: 'tall' });
  assert.notEqual(square.url, tall.url);
  assert.equal((await h.get()).url, square.url);
  assert.equal((await h.get({ aspect: 'tall' })).url, tall.url);
  assert.equal(h.calls.length, 2);
  assert.match(h.calls[1].url, /aspect=tall$/);
});

test('browser sessions and tracks without an album ID skip animated art', async () => {
  const h = harness();
  for (const source of ['firefox.exe', 'com.apple.Safari', 'chromium.instance42']) {
    assert.equal((await h.get({ source })).url, '');
  }
  assert.equal(h.calls.length, 0);
  const noAlbum = harness(undefined, '');
  assert.equal((await noAlbum.get()).url, '');
  assert.equal(noAlbum.calls.length, 0);
});

test('cached URLs expire without extending their lifetime across tracks', async () => {
  const h = harness();
  await h.get();
  h.advance(59 * 60 * 1000);
  await h.get({ title: 'Another song' });
  h.advance(2 * 60 * 1000);
  await h.get({ title: 'Another song' });
  assert.equal(h.calls.length, 2);
});

for (const [name, respond] of [
  ['server error', () => new Response('{}', { status: 503 })],
  ['malformed JSON', () => new Response('not JSON')],
  ['missing video', () => response({ hasMotion: true })],
  ['unexpected payload', () => response({})],
  ['unsafe URL', () => response({ hasMotion: true, video: 'file:///private/video.mp4' })],
  ['network failure', () => { throw new Error('connection lost'); }]
]) {
  test(`${name} remains retryable`, async () => {
    const h = harness(count => count === 1 ? respond() : response({ hasMotion: true, video }));
    assert.equal((await h.get()).url, '');
    assert.equal((await h.get()).url, video);
    assert.equal(h.calls.length, 2);
  });
}

for (const respond of [() => response({ hasMotion: false }), () => new Response('{}', { status: 404 })]) {
  test('missing motion is remembered separately for each aspect', async () => {
    const h = harness(respond);
    assert.equal((await h.get()).url, '');
    assert.equal((await h.get({ title: 'Another song' })).url, '');
    assert.equal(h.calls.length, 1);
    assert.equal((await h.get({ aspect: 'tall' })).url, '');
    assert.equal(h.calls.length, 2);
  });
}
