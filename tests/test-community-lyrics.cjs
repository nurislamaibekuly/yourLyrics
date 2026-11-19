'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '../src/main/lyrics/index.js'), 'utf8');
const track = { title: 'Test', artist: 'Artist', album: 'Album', durationSeconds: 200 };
const community = '<tt xmlns="http://www.w3.org/ns/ttml"><body><p begin="0s">Community</p></body></tt>';
const apple = '<tt><body><p begin="0s">Apple</p></body></tt>';
const json = body => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

function harness(respond, persisted) {
  const calls = [];
  const writes = [];
  const module = { exports: {} };
  vm.runInNewContext(source + `
    resolveLyricsFlowTrack = async () => ({ candidate: { id: '123', rating: 'explicit' }, storefront: 'us' });
    resolveLyricsFlowEditionLyrics = async () => null;
    resolveAmllLyrics = async () => ({ text: '[00:00]AMLL', format: 'lrc', source: 'amll-ttml-db' });
  `, {
    module, URL, URLSearchParams, Buffer, AbortSignal, process: { pid: 1 },
    console: { log() {}, warn() {} },
    fetch: async (url, options) => { calls.push(url); return respond(url, options); },
    require(name) {
      if (name === 'electron') return { app: { getPath: () => '/fixture' } };
      if (name === '../media/now-playing') return { getNowPlaying: () => track };
      if (name === 'node:fs/promises') return {
        stat: async () => ({ isFile: () => true, size: 100 }),
        readFile: async () => {
          if (!persisted) throw new Error('no cache');
          return JSON.stringify(persisted);
        },
        mkdir: async () => {}, writeFile: async (_path, text) => writes.push(JSON.parse(text)),
        rename: async () => {}, rm: async () => {}
      };
      return require(name);
    }
  }, { filename: 'lyrics.js' });
  return {
    get: (input = track) => module.exports.getLyricsForTrack(input),
    search: (query, input = track) => module.exports.searchLyrics(input, query),
    calls,
    writes
  };
}

test('manual lyrics search returns usable synced and plain lyric candidates', async () => {
  const h = harness(url => {
    assert.match(url, /\/api\/search\?q=Test\+Artist$/);
    return json([
      {
        trackName: 'Test', artistName: 'Artist', albumName: 'Album', duration: 200,
        syncedLyrics: '[00:00.00]First line'
      },
      { trackName: 'No lyrics', artistName: 'Artist', duration: 190 },
      { trackName: 'Plain lyrics', artistName: 'Artist', plainLyrics: 'A plain line' }
    ]);
  });
  const result = await h.search('Test Artist');
  assert.equal(result.results.length, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(result.results[0])), {
    title: 'Test', artist: 'Artist', album: 'Album', durationSeconds: 200,
    text: '[00:00.00]First line', source: 'lrclib'
  });
  assert.equal(result.results[1].text, 'A plain line');
});

test('manual lyrics search bounds queries and handles provider failures', async () => {
  const h = harness(() => { throw new Error('offline'); });
  const result = await h.search('x'.repeat(500));
  assert.equal(result.error, 'search_failed');
  assert.ok(h.calls[0].length < 300);
});

for (const stream of ['/api/community/stream/entry', 'https://assets.example/entry.ttml']) {
  test(`community wins before Apple Music (${stream})`, async () => {
    const h = harness(url => {
      if (url.endsWith('/api/community/lyrics/123')) return json({ available: [{ stream_url: stream, author: 'creator' }] });
      assert.equal(url, new URL(stream, 'https://api.trylyricsflow.com').href);
      return new Response(community);
    });
    const result = await h.get();
    assert.equal(result.text, community);
    assert.equal(result.source, 'lyricsflow-community');
    assert.equal(result.format, 'ttml');
    assert.equal(result.communityAuthor, 'creator');
    assert.equal(h.writes[0].value.communityAuthor, 'creator');
    assert.equal(h.calls.length, 2);
    assert.equal(h.writes[0].version, 15);
  });
}

for (const [name, response] of [
  ['no submissions', () => json({ available: [] })],
  ['404', () => new Response('', { status: 404 })],
  ['server error', () => new Response('', { status: 503 })],
  ['timeout', () => { throw new Error('timeout'); }],
  ['invalid JSON', () => new Response('broken')]
]) {
  test(`${name} falls through to Apple Music`, async () => {
    const h = harness(url => url.includes('/api/community/') ? response() : json({ syncedLyrics: apple }));
    assert.equal((await h.get()).text, apple);
    assert.match(h.calls[0], /\/api\/community\/lyrics\/123$/);
    assert.match(h.calls[1], /\/lyrics\?song=123&storefront=us$/);
  });
}

test('broken entries are skipped in favor of the next valid submission', async () => {
  const h = harness(url => {
    if (url.endsWith('/lyrics/123')) return json({ available: [
      null, { stream_url: '/broken' }, { stream_url: '/working' }
    ] });
    return new Response(url.endsWith('/broken') ? '<html>Error</html>' : community);
  });
  assert.equal((await h.get()).text, community);
  assert.equal(h.calls.length, 3);
});

test('failed community assets and Apple Music still reach the existing fallback', async () => {
  const h = harness(url => {
    if (url.endsWith('/lyrics/123')) return json({ available: [{ stream_url: '/broken' }] });
    return new Response('', { status: 404 });
  });
  assert.equal((await h.get()).source, 'amll-ttml-db');
});

test('Paxsenix retries the resolved Apple Music ID after Flow', async () => {
  const pax = '<tt xmlns="http://www.w3.org/ns/ttml"><body><p begin="0s">Paxsenix</p></body></tt>';
  const h = harness(url => {
    if (url.endsWith('/api/community/lyrics/123')) return json({ available: [] });
    if (url.startsWith('https://lyrics.paxsenix.org/apple-music/lyrics?')) {
      const params = new URL(url).searchParams;
      assert.equal(params.get('id'), '123');
      assert.equal(params.get('v'), '2');
      return json({ ttmlContent: pax });
    }
    return new Response('', { status: 404 });
  });
  const result = await h.get();
  assert.equal(result.source, 'paxsenix');
  assert.equal(result.format, 'ttml');
  assert.equal(result.text, pax);
  const flowIndex = h.calls.findIndex(url => url.includes('/lyrics?song=123'));
  const paxIndex = h.calls.findIndex(url => url.includes('lyrics.paxsenix.org'));
  assert.ok(flowIndex >= 0 && paxIndex > flowIndex);
});

test('Better Lyrics runs after Flow and before AMLL', async () => {
  const better = '<tt xmlns="http://www.w3.org/ns/ttml"><body><p begin="0s">Better</p></body></tt>';
  const h = harness(url => {
    if (url.endsWith('/api/community/lyrics/123')) return json({ available: [] });
    if (url.startsWith('https://api.betterlyrics.org/getLyrics?')) {
      return json({ ttml: better });
    }
    return new Response('', { status: 404 });
  });
  const result = await h.get();
  assert.equal(result.source, 'betterlyrics');
  assert.equal(result.text, better);
  assert.equal(result.format, 'ttml');
  const flowIndex = h.calls.findIndex(url => url.includes('/lyrics?song=123'));
  const betterIndex = h.calls.findIndex(url => url.startsWith('https://api.betterlyrics.org/'));
  assert.ok(flowIndex >= 0 && betterIndex > flowIndex);
});

test('a Better Lyrics cache miss still reaches the existing fallback', async () => {
  const h = harness(url => {
    if (url.endsWith('/api/community/lyrics/123')) return json({ available: [] });
    if (url.startsWith('https://api.betterlyrics.org/')) {
      return new Response(JSON.stringify({ error: 'API key required' }), {
        status: 401, headers: { 'content-type': 'application/json' }
      });
    }
    return new Response('', { status: 404 });
  });
  assert.equal((await h.get()).source, 'amll-ttml-db');
});

test('old cached lyrics are refreshed to allow community priority', async () => {
  const h = harness(url => url.endsWith('/lyrics/123')
    ? json({ available: [{ stream_url: '/stream' }] }) : new Response(community), {
    version: 7, key: ['Test', 'Artist', 'Album', 200].join('\u001f'), savedAt: Date.now(),
    value: { text: apple, format: 'ttml', source: 'lyricsflow' }
  });
  assert.equal((await h.get()).source, 'lyricsflow-community');
  assert.equal(h.calls.length, 2);
});

test('QQ has an independent public fallback after a TTML cache miss', async () => {
  const qrc = '[1000,2500]Hello (1000,500)world(2000,1000)';
  const h = harness(url => {
    if (url.includes('/qq/getLyrics?')) {
      const params = new URL(url).searchParams;
      assert.equal(params.get('s'), track.title);
      assert.equal(params.get('a'), track.artist);
      assert.equal(params.get('al'), track.album);
      assert.equal(params.get('d'), '200');
      return json({ lyrics: qrc, provider: 'qq' });
    }
    return new Response('', { status: 401 });
  });
  const result = await h.get();
  assert.equal(result.source, 'betterlyrics-qq');
  assert.equal(result.format, 'qrc');
  assert.equal(result.text, qrc);
  assert.ok(!h.calls.some(url => url.includes('liriqo')));
});

test('small duration corrections reuse the in-flight lyrics lookup', async () => {
  const qrc = '[1000,2500]Hello (1000,500)world(2000,1000)';
  const h = harness(url => {
    if (url.includes('/qq/getLyrics?')) {
      return json({ lyrics: qrc, provider: 'qq' });
    }
    if (url.startsWith('https://api.betterlyrics.org/')) {
      return new Response('', { status: 401 });
    }
    return new Response('', { status: 404 });
  });
  const [first, second] = await Promise.all([
    h.get({ ...track, durationSeconds: 122 }),
    h.get({ ...track, durationSeconds: 122.7 })
  ]);
  assert.equal(first.source, 'betterlyrics-qq');
  assert.equal(second.source, 'betterlyrics-qq');
  assert.equal(h.calls.filter(url => url.includes('/qq/getLyrics?')).length, 1);
});

test('unsynced Flow lyrics do not block a synced QQ fallback', async () => {
  const untimed = '<tt xmlns:itunes="http://music.apple.com/lyric-ttml-internal" itunes:timing="None">' +
    '<body><div><p>Unsynced words</p></div></body></tt>';
  const qrc = '[1000,2500]Hello (1000,500)world(2000,1000)';
  const h = harness(url => {
    if (url.includes('/api/community/lyrics/')) return json({ available: [] });
    if (url.includes('/lyrics?song=123')) {
      return json({ syncedLyrics: untimed, format: 'ttml', timingType: 'line', hasWordLevel: false });
    }
    if (url.includes('/qq/getLyrics?')) return json({ lyrics: qrc, provider: 'qq' });
    if (url.startsWith('https://api.betterlyrics.org/')) return new Response('', { status: 401 });
    return new Response('', { status: 404 });
  });
  const result = await h.get();
  assert.equal(result.source, 'betterlyrics-qq');
  assert.equal(result.format, 'qrc');
  assert.ok(!h.writes.some(write => write.value.source === 'lyricsflow'));
});

function liriqoHarness(body) {
  return harness(url => url.includes('liriqo') ? json(body) : new Response('', { status: 404 }));
}

test('LiriQo preserves native millisecond word windows and source attribution', async () => {
  const h = liriqoHarness({ metadata: { title: 'Test', artist: 'Artist', duration: 200 }, primary: {
    provider: 'netease', upstreamProvider: 'NetEase Cloud Music',
    timed: [{ id: 5, text: 'Hello & world', start: 1000, end: 4000 }],
    words: { 5: [{ text: 'Hello & ', start: 1000, end: 1500 }, { text: 'world', start: 2200, end: 3500 }] }
  } });
  const result = await h.get();
  assert.equal(result.source, 'LiriQo · NetEase Cloud Music');
  assert.equal(result.format, 'ttml');
  assert.match(result.text, /begin="1000ms" end="1500ms">Hello &amp; /);
  assert.match(result.text, /begin="2200ms" end="3500ms">world/);
  const params = new URL(h.calls.find(url => url.includes('liriqo'))).searchParams;
  assert.equal(params.get('title'), 'Test');
  assert.equal(params.get('duration'), '200');
});

test('LiriQo line-only results keep line timing without invented word timing', async () => {
  const result = await liriqoHarness({ primary: { timed: [{ text: '<Hello>', start: 1000, end: 3000 }] } }).get();
  assert.match(result.text, /<p begin="1000ms" end="3000ms">&lt;Hello&gt;<\/p>/);
  assert.ok(!result.text.includes('<span'));
});

for (const body of [
  { error: 'unavailable' },
  { primary: null, tracks: [] },
  { metadata: { title: 'Other song' }, primary: { lrc: '[00:01]Wrong song' } },
  { primary: { timed: [{ text: 'Broken', start: '1000' }] } },
  { primary: { plain: 'No timed lyrics' } }
]) {
  test(`unusable LiriQo response falls through: ${JSON.stringify(body)}`, async () => {
    assert.equal((await liriqoHarness(body).get()).source, 'amll-ttml-db');
  });
}
