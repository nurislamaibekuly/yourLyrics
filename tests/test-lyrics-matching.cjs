'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '../src/main/lyrics/index.js'), 'utf8');
const wordLevelTtml = '<tt xmlns:itunes="http://music.apple.com/lyric-ttml-internal" itunes:timing="Word">' +
  '<body><p begin="1s"><span begin="1s">Spotlight,</span> <span begin="2s">moonlight</span></p></body></tt>';
const untimedTtml = '<tt xmlns:itunes="http://music.apple.com/lyric-ttml-internal" itunes:timing="None">' +
  '<body><div><p>Unsynced words</p></div></body></tt>';
const json = body => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

function song(id, name, artistName, albumName, durationInMillis, albumId, rating = '') {
  return {
    id,
    type: 'songs',
    attributes: {
      name,
      artistName,
      albumName,
      durationInMillis,
      contentRating: rating,
      hasTimeSyncedLyrics: false,
      url: `https://music.apple.com/us/album/x/${albumId}?i=${id}`
    }
  };
}

// Trimmed from the real catalog answer for "Moonlight XXXTENTACION": the
// original is missing and an instrumental of the same artist, album and
// duration leads the list.
const moonlightSearch = [
  song('1474891805', 'Moonlight (Instrumental)', 'XXXTENTACION', '? (Deluxe)', 135067, 1474891456),
  song('1464059504', 'Moonlight (Xxxtentacion Remix)', 'Dero', 'Moonlight (Xxxtentacion Remix) - Single', 240000, 1464059503),
  song('1707995383', 'Moonlight (XXXTENTACION tribute)', 'LinkScumm', 'Moonlight (XXXTENTACION tribute) - Single', 196784, 1707995380),
  song('1691534211', 'Moonlight (Radio Edit)', 'MC Jay', 'XXXTentacion #1 (Freestyle Street) [Radio Edit]', 169979, 1691534206)
];
const moonlightAlbumTracks = [
  song('1359292535', 'Introduction (instructions)', 'XXXTENTACION', '?', 117483, 1359292515),
  song('1359293315', 'Moonlight', 'XXXTENTACION', '?', 135090, 1359292515),
  song('1359293318', 'SAD!', 'XXXTENTACION', '?', 166606, 1359292515)
];

function harness(routes) {
  const calls = [];
  const module = { exports: {} };
  vm.runInNewContext(source, {
    module, URL, URLSearchParams, Buffer, AbortSignal, process: { pid: 1 },
    console: { log() {}, warn() {} },
    fetch: async (url) => {
      calls.push(url);
      return (await routes(new URL(url))) ?? new Response('', { status: 404 });
    },
    require(name) {
      if (name === 'electron') {
        return {
          app: { getPath: () => '/fixture', getLocaleCountryCode: () => 'kz' },
          BrowserWindow: {}, dialog: {}, ipcMain: {}
        };
      }
      if (name === '../media/now-playing') return { getNowPlaying: () => ({}) };
      if (name === 'node:fs/promises') return {
        stat: async () => ({ isFile: () => true, size: 100 }),
        readFile: async () => { throw new Error('no cache'); },
        mkdir: async () => {}, writeFile: async () => {},
        rename: async () => {}, rm: async () => {}
      };
      return require(name);
    }
  }, { filename: 'lyrics.js' });
  return { module, calls };
}

function catalogRoutes(searchRows) {
  return url => {
    if (url.pathname === '/search') {
      const types = url.searchParams.get('types');
      if (types === 'songs') return json({ results: { songs: { data: searchRows } } });
      if (types === 'artists') {
        return json({ results: { artists: { data: [
          { id: '1082533559', attributes: { name: 'XXXTENTACION' } }
        ] } } });
      }
      return json({ results: {} });
    }
    if (url.pathname === '/artist/albums') {
      return json({ data: [
        { id: '1359292515', href: '/v1/catalog/us/albums/1359292515', attributes: { name: '?', contentRating: 'explicit' } },
        { id: '1474891456', href: '/v1/catalog/us/albums/1474891456', attributes: { name: '? (Deluxe)', contentRating: 'explicit' } }
      ] });
    }
    if (url.pathname === '/v1/catalog/us/albums/1359292515') {
      return json({ data: [{ relationships: { tracks: { data: moonlightAlbumTracks } } }] });
    }
    if (url.pathname === '/v1/catalog/us/albums/1474891456') {
      return json({ data: [{ relationships: { tracks: { data: [
        song('1474891805', 'Moonlight (Instrumental)', 'XXXTENTACION', '? (Deluxe)', 135067, 1474891456)
      ] } } }] });
    }
    if (url.pathname === '/v1/catalog/us/songs/1359293315') {
      return json({ data: [{ relationships: { artists: { data: [{ id: '1082533559' }] } } }] });
    }
    if (url.pathname === '/artist/songs') return json({ data: [] });
    if (url.pathname.startsWith('/api/community/lyrics/')) return json({ available: [] });
    if (url.pathname === '/lyrics') {
      return url.searchParams.get('song') === '1359293315'
        ? json({ syncedLyrics: wordLevelTtml, hasWordLevel: true, timingType: 'word' })
        : new Response('', { status: 404 });
    }
    return null;
  };
}

test('another recording of the same title never wins the catalog lookup', async () => {
  const { module } = harness(catalogRoutes(moonlightSearch));
  const resolved = await module.exports.resolveLyricsFlowTrack({
    title: 'Moonlight', artist: 'XXXTENTACION', album: '?', durationSeconds: 135.138
  });
  assert.equal(resolved.candidate.id, '1359293315');
  assert.equal(resolved.candidate.title, 'Moonlight');
});

test('lyrics for that track come from the word-level asset, not LRC Lib', async () => {
  const { module } = harness(catalogRoutes(moonlightSearch));
  const lyrics = await module.exports.getLyricsForTrack({
    title: 'Moonlight', artist: 'XXXTENTACION', album: '?', durationSeconds: 135.138
  });
  assert.equal(lyrics.source, 'lyricsflow');
  assert.equal(lyrics.format, 'ttml');
  assert.match(lyrics.text, /itunes:timing="Word"/);
});

test('a remix the listener is actually playing still matches', async () => {
  const { module } = harness(catalogRoutes(moonlightSearch));
  const resolved = await module.exports.resolveLyricsFlowTrack({
    title: 'Moonlight (Xxxtentacion Remix)', artist: 'Dero',
    album: 'Moonlight (Xxxtentacion Remix) - Single', durationSeconds: 240
  });
  assert.equal(resolved.candidate.id, '1464059504');
});

test('a timed edition beats an explicit but unsynced primary asset', async () => {
  const primary = song('111', 'Hit', 'Artist', 'Album', 200000, '333', 'explicit');
  const edition = song('222', 'Hit', 'Artist', 'Album', 200000, '444', 'clean');
  const routes = url => {
    if (url.pathname === '/search') {
      if (url.searchParams.get('types') === 'songs') {
        return json({ results: { songs: { data: [primary] } } });
      }
      return json({ results: {} });
    }
    if (url.pathname === '/api/community/lyrics/111') return json({ available: [] });
    if (url.pathname === '/lyrics') {
      if (url.searchParams.get('song') === '111') {
        return json({ syncedLyrics: untimedTtml, format: 'ttml', timingType: 'line', hasWordLevel: false });
      }
      if (url.searchParams.get('song') === '222') {
        return json({ syncedLyrics: wordLevelTtml, format: 'ttml', timingType: 'word', hasWordLevel: true });
      }
      return new Response('', { status: 404 });
    }
    if (url.pathname === '/v1/catalog/us/songs/111') {
      return json({ data: [{ relationships: { artists: { data: [{ id: '555' }] } } }] });
    }
    if (url.pathname === '/artist/albums') {
      return json({ data: [
        { id: '333', href: '/v1/catalog/us/albums/333', attributes: { name: 'Album', contentRating: 'explicit' } },
        { id: '444', href: '/v1/catalog/us/albums/444', attributes: { name: 'Album', contentRating: 'clean' } }
      ] });
    }
    if (url.pathname === '/v1/catalog/us/albums/444') {
      return json({ data: [{ relationships: { tracks: { data: [edition] } } }] });
    }
    return null;
  };
  const { module } = harness(routes);
  const lyrics = await module.exports.getLyricsForTrack({
    title: 'Hit', artist: 'Artist', album: 'Album', durationSeconds: 200
  });
  assert.equal(lyrics.source, 'lyricsflow');
  assert.match(lyrics.text, /itunes:timing="Word"/);
  assert.doesNotMatch(lyrics.text, /itunes:timing="None"/);
});

test('artist fallback checks secondary matching artists when song search misses', async () => {
  const innocence = song('1879514093', 'Innocence', 'Hildir Svensson & Deprezz', 'Innocence - EP', 356639, '1879514092', 'explicit');
  innocence.attributes.hasTimeSyncedLyrics = true;
  innocence.attributes.artwork = { url: 'https://example.com/{w}x{h}bb.jpg' };
  const routes = url => {
    if (url.pathname === '/search') {
      const types = url.searchParams.get('types');
      if (types === 'songs') {
        return json({ results: {} });
      }
      if (types === 'artists') {
        return json({
          results: {
            artists: {
              data: [
                { id: '1368566620', attributes: { name: 'Hildir' } },
                { id: '1822059487', attributes: { name: 'Hildir Svensson' } }
              ]
            }
          }
        });
      }
    }
    if (url.pathname === '/artist/albums') return json({ data: [] });
    if (url.pathname === '/artist/songs') {
      const artistId = url.searchParams.get('artist');
      return json({ data: artistId === '1822059487' ? [innocence] : [] });
    }
    return null;
  };
  const { module } = harness(routes);
  const track = { title: 'Innocence', artist: 'Hildir', durationSeconds: 357 };
  const resolved = await module.exports.resolveLyricsFlowTrack(track);
  assert.equal(resolved.candidate.id, '1879514093');
  const artwork = await module.exports.resolveLyricsFlowArtwork(track);
  assert.equal(artwork.candidate.id, '1879514093');
});

test('artist fallback splits collaborative credits when full artist search misses', async () => {
  const innocence = song('1879514093', 'Innocence', 'Hildir Svensson & Deprezz', 'Innocence - EP', 356639, '1879514092', 'explicit');
  innocence.attributes.hasTimeSyncedLyrics = true;
  const routes = url => {
    if (url.pathname === '/search') {
      const types = url.searchParams.get('types');
      const term = url.searchParams.get('term');
      if (types === 'songs') {
        return json({ results: {} });
      }
      if (types === 'artists') {
        if (term === 'hildir svensson') {
          return json({
            results: {
              artists: {
                data: [{ id: '1822059487', attributes: { name: 'Hildir Svensson' } }]
              }
            }
          });
        }
        return json({ results: {} });
      }
    }
    if (url.pathname === '/artist/albums') return json({ data: [] });
    if (url.pathname === '/artist/songs') {
      const artistId = url.searchParams.get('artist');
      return json({ data: artistId === '1822059487' ? [innocence] : [] });
    }
    return null;
  };
  const { module } = harness(routes);
  const resolved = await module.exports.resolveLyricsFlowTrack({
    title: 'Innocence', artist: 'Hildir Svensson & Deprezz', album: 'Innocence - EP', durationSeconds: 356.754
  });
  assert.equal(resolved.candidate.id, '1879514093');
});
