const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { getNowPlaying } = require('../media/now-playing');

const apiRoot = 'https://lrclib.net/api/';
const lyricsFlowRoot = 'https://api.trylyricsflow.com';
const betterLyricsRoot = 'https://api.betterlyrics.org';
const unisonRoot = 'https://unison.betterlyrics.org';
const paxsenixRoot = 'https://lyrics.paxsenix.org';
const liriqoRoot = 'https://api.liriqo-alfarrizi.my.id/v1';
const amllRoot = 'https://raw.githubusercontent.com/amll-dev/amll-ttml-db/main';
const amllRawLyricsIndexUrl = `${amllRoot}/metadata/raw-lyrics-index.jsonl`;
const userAgent = 'yourLyrics (https://github.com/ligma-team/yourLyrics)';
const requestTimeoutMs = 7000;
const maxDurationDeltaSeconds = 5;
const maxLyricsFlowDurationDeltaSeconds = 8;
const lyricsFlowSearchLimit = 50;
const lyricsFlowArtistPageLimit = 6;
const lyricsFlowAlbumPageLimit = 2;
const lyricsFlowEditionArtistAttempts = 2;
const lyricsFlowEditionAlbumAttempts = 2;
const lyricsFlowEditionLyricsAttempts = 3;
const lyricsFlowExplicitWordRank = 6;
const minLyricsFlowScore = 7;
const maxLocalLyricsBytes = 4 * 1024 * 1024;
// Providers often correct a rounded duration by a fraction of a second after
// the first lookup. Treat tiny corrections as the same track so they do not
// restart the whole provider chain.
const trackDurationToleranceSeconds = 2;
// Re-resolve old cache entries when a new lyrics source is added, or when the
// matcher changes enough that an old entry may now come from a worse provider.
const lyricCacheVersion = 15;
const lyricCacheTtlMs = 30 * 24 * 60 * 60 * 1000;
const cache = new Map();
const inflight = new Map();
let amllRawLyricsIndexRequest = null;

function cleanText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeTrack(input) {
  const fallback = getNowPlaying();
  const source = input && typeof input === 'object' ? input : fallback;
  return {
    title: cleanText(source.title),
    artist: cleanText(source.artist),
    album: cleanText(source.album),
    durationSeconds: Number.isFinite(source.durationSeconds)
      ? Math.max(0, source.durationSeconds)
      : 0
  };
}

function trackIdentity(track) {
  return [track.title, track.artist, track.album].join('\u001f');
}

function trackKey(track) {
  return [
    trackIdentity(track),
    Math.round(track.durationSeconds)
  ].join('\u001f');
}

function trackKeyIdentity(key) {
  return key.slice(0, key.lastIndexOf('\u001f'));
}

function trackKeyDuration(key) {
  return Number(key.slice(key.lastIndexOf('\u001f') + 1));
}

function reusableTrackKey(track) {
  const exactKey = trackKey(track);
  if (cache.has(exactKey) || inflight.has(exactKey)) {
    return exactKey;
  }

  const trackDuration = Math.round(track.durationSeconds);
  if (trackDuration <= 0) {
    return '';
  }

  const identity = trackIdentity(track);
  let bestKey = '';
  let bestDelta = Infinity;
  for (const key of [...cache.keys(), ...inflight.keys()]) {
    if (trackKeyIdentity(key) !== identity) {
      continue;
    }
    const keyDuration = trackKeyDuration(key);
    if (keyDuration <= 0) {
      continue;
    }
    const delta = Math.abs(keyDuration - trackDuration);
    if (delta <= trackDurationToleranceSeconds && delta < bestDelta) {
      bestKey = key;
      bestDelta = delta;
    }
  }
  return bestKey;
}

function lyricCachePath(key) {
  const digest = crypto.createHash('sha256').update(key).digest('hex');
  return path.join(
    app.getPath('userData'),
    'lyrics-cache',
    `${digest}.json`
  );
}

function validCachedLyrics(value) {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const text = typeof value.text === 'string' ? value.text : '';
  const format = typeof value.format === 'string' ? value.format : '';
  const source = typeof value.source === 'string' ? value.source : '';
  if (!text) {
    return null;
  }
  return {
    text,
    format,
    source,
    communityAuthor: cleanText(value.communityAuthor),
    communityAuthorUrl: cleanText(value.communityAuthorUrl)
  };
}

async function readPersistedLyrics(key) {
  try {
    const filePath = lyricCachePath(key);
    console.log("Reading persisted lyrics from:", filePath);
    const stats = await fs.stat(filePath);
    if (!stats.isFile() || stats.size > maxLocalLyricsBytes) {
      return null;
    }
    const payload = JSON.parse(await fs.readFile(filePath, 'utf8'));
    if (!payload ||
        payload.version !== lyricCacheVersion ||
        payload.key !== key) {
      return null;
    }
    const value = validCachedLyrics(payload.value);
    if (!value) {
      return null;
    }
    const savedAt = Number(payload.savedAt);
    return {
      value,
      fresh: Number.isFinite(savedAt) &&
        Date.now() - savedAt < lyricCacheTtlMs
    };
  } catch {
    return null;
  }
}

async function writePersistedLyrics(key, value) {
  const cached = validCachedLyrics(value);
  if (!cached) {
    return;
  }

  const filePath = lyricCachePath(key);
  console.log("Writing persisted lyrics to:", filePath);
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(
      tempPath,
      JSON.stringify({
        version: lyricCacheVersion,
        key,
        savedAt: Date.now(),
        value: cached
      }),
      'utf8'
    );
    await fs.rename(tempPath, filePath);
  } catch {
    await fs.rm(tempPath, { force: true }).catch(() => {});
  }
}

function normalizeName(value) {
  return cleanText(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function coreTitle(value) {
  return normalizeName(value)
    .replace(/\b(feat|ft|featuring)\b.*$/, '')
    .trim();
}

function matchTitle(candidate, query) {
  const left = coreTitle(candidate);
  const right = coreTitle(query);
  if (!left || !right) {
    return 0;
  }
  if (left === right) {
    return 5;
  }
  if (left.startsWith(`${right} `) || right.startsWith(`${left} `)) {
    return 3;
  }
  if (left.includes(right) || right.includes(left)) {
    return 2;
  }
  return 0;
}

// Storefront search happily answers the exact title with a different recording
// of that title. "Moonlight (Instrumental)" agrees with "Moonlight" on title
// prefix, artist and duration, yet its catalog entry has no lyrics at all —
// and a remix, cover or karaoke version carries someone else's vocal. A
// qualifier the query does not name itself marks such a candidate, so it never
// wins the lookup; playing "Song (Remix)" still matches that remix because the
// query carries the same qualifier.
const alternateRecordingPhrases = [
  'instrumental',
  'karaoke',
  'backing track',
  'off vocal',
  'cover',
  'tribute',
  'made famous by',
  'in the style of',
  'originally performed by',
  'remix',
  'bootleg',
  'mashup',
  'medley',
  'sped up',
  'slowed',
  'nightcore',
  'reverb',
  '8d'
];

function alternateRecordingPhrase(value) {
  const text = ` ${normalizeName(value)} `;
  return alternateRecordingPhrases.find(
    (phrase) => text.includes(` ${phrase} `)
  ) ?? '';
}

function artistParts(value) {
  return new Set(
    cleanText(value)
      .split(/\s*[,&+/]\s*|\s+(?:and|with|feat\.?|ft\.?|x)\s+/i)
      .map(normalizeName)
      .filter(Boolean)
  );
}

function matchArtist(candidate, query) {
  const left = normalizeName(candidate);
  const right = normalizeName(query);
  if (!left || !right) {
    return 0;
  }
  if (left === right) {
    return 3;
  }
  if (left.includes(right) || right.includes(left)) {
    return 1.5;
  }

  // Collaborative credits list the same artists in varying order
  // ("Kanye West & JAŸ-Z" vs "JAŸ-Z & Kanye West"), so compare the individual
  // names when the whole credit string does not line up.
  const leftParts = artistParts(candidate);
  const rightParts = artistParts(query);
  let shared = 0;
  for (const part of rightParts) {
    if (leftParts.has(part)) {
      shared += 1;
    }
  }
  if (shared === 0) {
    return 0;
  }
  return shared === leftParts.size && shared === rightParts.size ? 2.5 : 1.5;
}

function lyricsFlowStorefronts() {
  let country = '';
  try {
    country = cleanText(
      app && typeof app.getLocaleCountryCode === 'function'
        ? app.getLocaleCountryCode()
        : ''
    ).toLowerCase();
  } catch {
    country = '';
  }
  return Array.from(new Set(
    [country, 'us'].filter((value) => /^[a-z]{2}$/.test(value))
  ));
}

function queryUrl(endpoint, track, includeAlbum = true) {
  const params = new URLSearchParams({
    artist_name: track.artist,
    track_name: track.title
  });
  if (track.album && includeAlbum) {
    params.set('album_name', track.album);
  }
  if (track.durationSeconds > 0) {
    params.set('duration', track.durationSeconds.toFixed(2));
  }
  return `${apiRoot}${endpoint}?${params.toString()}`;
}

async function requestJson(url) {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': userAgent
    },
    signal: AbortSignal.timeout(requestTimeoutMs)
  });
  if (!response.ok) {
    return { status: response.status, body: null };
  }
  return { status: response.status, body: await response.json() };
}

function candidateFrom(value) {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const duration = Number(value.duration);
  return {
    artist: cleanText(value.artistName),
    track: cleanText(value.trackName),
    duration: Number.isFinite(duration) ? duration : 0,
    instrumental: value.instrumental === true,
    syncedLyrics: typeof value.syncedLyrics === 'string'
      ? value.syncedLyrics
      : ''
  };
}

function containsEither(candidate, query) {
  if (!candidate || !query) {
    return false;
  }
  const left = candidate.toLocaleLowerCase();
  const right = query.toLocaleLowerCase();
  return left.includes(right) || right.includes(left);
}

function scoreCandidate(candidate, track) {
  if (!candidate) {
    return null;
  }
  const durationDelta = track.durationSeconds > 0 && candidate.duration > 0
    ? Math.abs(candidate.duration - track.durationSeconds)
    : 0;
  if (durationDelta > maxDurationDeltaSeconds) {
    return null;
  }
  let score = 0;
  if (containsEither(candidate.artist, track.artist)) {
    score += 2;
  }
  if (containsEither(candidate.track, track.title)) {
    score += 3;
  }
  if (score < 2) {
    return null;
  }
  return { candidate, durationDelta, score };
}

function lyricsFromCandidate(candidate) {
  if (!candidate || candidate.instrumental) {
    return '';
  }
  return candidate.syncedLyrics;
}

function albumIdFromUrl(value) {
  // Song URLs look like
  // https://music.apple.com/us/album/lavender-haze/1649434996?i=1649435004
  // The album id is the segment before the song query parameter.
  const match = /\/(?:album|playlist)\/[^/]+\/(\d+)(?:[?#]|$)/.exec(
    cleanText(value)
  );
  return match ? match[1] : '';
}

function lyricsFlowCandidateFrom(value) {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const attributes = value.attributes && typeof value.attributes === 'object'
    ? value.attributes
    : {};
  const duration = Number(attributes.durationInMillis);
  const artwork = attributes.artwork && typeof attributes.artwork === 'object'
    ? attributes.artwork
    : {};
  return {
    id: cleanText(String(value.id ?? '')),
    albumId: albumIdFromUrl(attributes.url),
    title: cleanText(attributes.name),
    artist: cleanText(attributes.artistName),
    album: cleanText(attributes.albumName),
    rating: cleanText(attributes.contentRating),
    duration: Number.isFinite(duration) ? duration / 1000 : 0,
    synced: attributes.hasTimeSyncedLyrics === true,
    // The catalog ships a {w}x{h} template instead of a fixed image; the
    // now-playing artwork fallback substitutes a size into it.
    artworkUrl: cleanText(artwork.url)
  };
}

function scoreLyricsFlowCandidate(candidate, track) {
  if (!candidate || !candidate.id) {
    return null;
  }
  const titleScore = matchTitle(candidate.title, track.title);
  if (titleScore < 2) {
    return null;
  }
  const artistScore = matchArtist(candidate.artist, track.artist);
  if (track.artist && artistScore === 0) {
    return null;
  }
  if (alternateRecordingPhrase(candidate.title) &&
      !alternateRecordingPhrase(track.title)) {
    return null;
  }

  let durationDelta = null;
  if (track.durationSeconds > 0 && candidate.duration > 0) {
    durationDelta = Math.abs(candidate.duration - track.durationSeconds);
    if (durationDelta > maxLyricsFlowDurationDeltaSeconds) {
      return null;
    }
  }

  let score = titleScore + artistScore;
  if (durationDelta !== null) {
    score += Math.max(0, 3 - durationDelta / 3);
  }
  if (matchTitle(candidate.album, track.album) > 0) {
    score += 1;
  }
  if (candidate.synced) {
    score += 2;
  }
  if (candidate.rating === 'explicit') {
    // Prefer explicit editions over clean ones when everything else matches.
    score += 0.5;
  }
  if (score < minLyricsFlowScore) {
    return null;
  }
  return { candidate, score, durationDelta };
}

function preferLyricsFlowCandidate(best, scored, storefront) {
  if (!scored) {
    return best;
  }
  const next = { ...scored, storefront };
  if (!best ||
      next.score > best.score ||
      (next.score === best.score &&
       (next.durationDelta ?? Infinity) <
         (best.durationDelta ?? Infinity))) {
    return next;
  }
  return best;
}

async function lyricsFlowSearchQuery(term, storefront) {
  const params = new URLSearchParams({
    term,
    types: 'songs',
    storefront,
    limit: String(lyricsFlowSearchLimit)
  });
  const result = await requestJson(`${lyricsFlowRoot}/search?${params.toString()}`);
  if (result.status !== 200) {
    return [];
  }
  return Array.isArray(result.body?.results?.songs?.data)
    ? result.body.results.songs.data
    : [];
}

async function lyricsFlowSearchSongs(track, storefront) {
  const term = [track.title, track.artist].filter(Boolean).join(' ');
  if (!term) {
    return [];
  }
  console.log("Searching LyricsFlow for", term, "in storefront", storefront);
  let rows = await lyricsFlowSearchQuery(term, storefront);
  if (rows.length === 0 && track.title) {
    // YouTube-style sources put "Artist - Song" into the title and hand over
    // a channel name as the artist ("DanielCaesarVEVO"); that combined term
    // matches nothing in the catalog while the title alone matches. One extra
    // request only on a miss — lyrics and the artwork fallback both ride on
    // this same lookup.
    const titleOnly = track.title.trim();
    if (titleOnly && titleOnly.toLowerCase() !== term.toLowerCase()) {
      rows = await lyricsFlowSearchQuery(titleOnly, storefront);
    }
  }
  console.log("LyricsFlow search results for", term, "in storefront", storefront, ":", rows);
  return rows;
}

async function lyricsFlowArtistSearchRows(term, storefront) {
  const params = new URLSearchParams({
    term,
    types: 'artists',
    storefront,
    limit: '10'
  });
  const result = await requestJson(`${lyricsFlowRoot}/search?${params.toString()}`);
  if (result.status !== 200) {
    return [];
  }
  const rows = result.body?.results?.artists?.data;
  return Array.isArray(rows) ? rows : [];
}

// Some artists share a shorter prefix or alternate credit (e.g. "Hildir" vs
// "Hildir Svensson"), and collaborative credits ("Artist A & Artist B") often
// have no combined artist entity in the catalog, so fall back to individual
// artist parts when the full credit returns no hits.
async function lyricsFlowArtistIds(track, storefront) {
  if (!track.artist) {
    return [];
  }
  const terms = [track.artist];
  const parts = [...artistParts(track.artist)];
  if (parts.length > 1) {
    for (const part of parts) {
      terms.push(part);
    }
  }

  const matches = new Map();
  for (let index = 0; index < terms.length; index += 1) {
    // Only split into individual collaborators when the full artist credit
    // produced no catalog matches.
    if (index > 0 && matches.size > 0) {
      break;
    }
    const rows = await lyricsFlowArtistSearchRows(terms[index], storefront);
    for (const value of rows) {
      const id = cleanText(String(value?.id ?? ''));
      const name = cleanText(value?.attributes?.name);
      if (!id || !name) {
        continue;
      }
      const score = normalizeName(name) === normalizeName(track.artist)
        ? 2
        : (matchArtist(name, track.artist) > 0 ? 1 : 0);
      if (score > 0) {
        matches.set(id, Math.max(matches.get(id) ?? 0, score));
      }
    }
  }

  return [...matches.entries()]
    .sort((left, right) => right[1] - left[1])
    .map(([id]) => id);
}

// The candidate's own catalog record credits every artist directly, which is
// more reliable than searching for composite credits such as
// "JAŸ-Z & Kanye West".
async function lyricsFlowCandidateArtistIds(songId) {
  const id = cleanText(String(songId ?? ''));
  if (!id) {
    return [];
  }
  const result = await requestJson(
    `${lyricsFlowRoot}/v1/catalog/us/songs/${encodeURIComponent(id)}` +
    `?${new URLSearchParams({ l: 'en-US', include: 'artists' }).toString()}`
  );
  if (result.status !== 200) {
    return [];
  }
  const row = Array.isArray(result.body?.data) ? result.body.data[0] : null;
  const artists = row?.relationships?.artists?.data;
  if (!Array.isArray(artists)) {
    return [];
  }
  return artists
    .map((value) => cleanText(String(value?.id ?? '')))
    .filter(Boolean);
}

async function lyricsFlowEditionArtistIds(track, resolved) {
  const fromCatalog = await lyricsFlowCandidateArtistIds(resolved.candidate.id)
    .catch(() => []);
  if (fromCatalog.length > 0) {
    return fromCatalog;
  }
  return lyricsFlowArtistIds(track, 'us').catch(() => []);
}

async function lyricsFlowArtistSongs(artistId, track) {
  let url = `${lyricsFlowRoot}/artist/songs?${new URLSearchParams({
    artist: artistId
  }).toString()}`;
  let best = null;

  for (let page = 0; page < lyricsFlowArtistPageLimit && url; page += 1) {
    const result = await requestJson(url);
    if (result.status !== 200) {
      break;
    }
    const rows = result.body?.data;
    if (Array.isArray(rows)) {
      for (const value of rows) {
        const scored = scoreLyricsFlowCandidate(lyricsFlowCandidateFrom(value), track);
        best = preferLyricsFlowCandidate(best, scored, 'us');
      }
    }
    const next = cleanText(result.body?.next);
    url = next ? new URL(next, lyricsFlowRoot).toString() : '';
  }
  return best;
}

// Album names such as "?" lose every character to the normaliser, which would
// hide exactly the release that holds the track from the album fallback. When
// the stripped name is empty, keep the punctuation-carrying form so those
// releases can still be compared and matched against each other.
function albumKey(value) {
  const cleaned = cleanText(value).toLocaleLowerCase();
  return albumBaseName(cleaned) || cleaned.replace(/\s+/g, ' ').trim();
}

// Apple's store search index drops some releases outright: a re-issued single
// such as "Teeth (Interlude)" answers every title/artist query with the wrong
// song (or nothing) while the catalog still serves it by id. The artist's
// album list is short and still carries the release, so match the album name
// and score its tracks under the same rules as the search results.
function albumNameScore(candidate, query) {
  const left = albumKey(candidate);
  const right = albumKey(query);
  if (!left || !right) {
    return 0;
  }
  if (left === right) {
    return 5;
  }
  return left.includes(right) || right.includes(left) ? 2 : 0;
}

async function lyricsFlowAlbumTrackCandidate(track, artistId) {
  if (!track.album) {
    return null;
  }
  const albums = (await lyricsFlowArtistAlbums(artistId))
    .map(lyricsFlowAlbumFrom)
    .filter((album) => album && albumNameScore(album.name, track.album) >= 2);
  if (albums.length === 0) {
    return null;
  }
  albums.sort((left, right) =>
    (albumNameScore(right.name, track.album) -
      albumNameScore(left.name, track.album)) ||
    (Number(right.rating === 'explicit') - Number(left.rating === 'explicit'))
  );

  let best = null;
  for (const album of albums.slice(0, lyricsFlowEditionAlbumAttempts)) {
    for (const value of await lyricsFlowAlbumTracks(album)) {
      const scored = scoreLyricsFlowCandidate(lyricsFlowCandidateFrom(value), track);
      best = preferLyricsFlowCandidate(best, scored, album.storefront);
    }
  }
  return best;
}

async function resolveLyricsFlowTrackUncached(track) {
  const storefronts = lyricsFlowStorefronts();
  let best = null;

  for (const storefront of storefronts) {
    const rows = await lyricsFlowSearchSongs(track, storefront);
    for (const value of rows) {
      const scored = scoreLyricsFlowCandidate(lyricsFlowCandidateFrom(value), track);
      best = preferLyricsFlowCandidate(best, scored, storefront);
    }
    if (best && best.score >= 10) {
      break;
    }
  }
  if (best) {
    return best;
  }

  // Multiple catalog artists can match the same query (e.g. a shorter alias
  // and a full name), so check the top matches in order until one yields the
  // track.
  const artistIds = await lyricsFlowArtistIds(track, storefronts[0] ?? 'us');
  for (const artistId of artistIds.slice(0, 5)) {
    const fromAlbum = await lyricsFlowAlbumTrackCandidate(track, artistId);
    if (fromAlbum) {
      console.log(
        "LyricsFlow search missed; matched album track", fromAlbum.candidate.id,
        fromAlbum.candidate.title, "in storefront", fromAlbum.storefront
      );
      return fromAlbum;
    }
    const fromSongs = await lyricsFlowArtistSongs(artistId, track);
    if (fromSongs) {
      return fromSongs;
    }
  }
  return null;
}

// The shared matcher compares whole normalized names, so a channel name with
// its spaces removed ("DanielCaesarVEVO") never contains "Daniel Caesar" —
// exactly the metadata browsers deliver. Fall back to space-stripped
// containment before giving up on the artist.
function artworkArtistScore(candidate, track) {
  const direct = matchArtist(candidate, track);
  if (direct > 0) {
    return direct;
  }
  const left = normalizeName(candidate).replace(/\s+/g, '');
  const right = normalizeName(track).replace(/\s+/g, '');
  if (!left || !right) {
    return 0;
  }
  return left.includes(right) || right.includes(left) ? 1 : 0;
}

// Artwork wants the cover of this *song*, not this exact recording: official
// videos routinely run tens of seconds longer than the catalog master, which
// the lyrics duration gate (correctly) rejects — while the cover is still the
// right one. Same search, title agreement required, artist agreement preferred.
async function resolveLyricsFlowArtworkUncached(track) {
  if (!track.title && !track.artist) {
    return null;
  }
  const queryAlt = alternateRecordingPhrase(track.title);
  let best = null;
  let bestScore = -1;
  for (const storefront of lyricsFlowStorefronts()) {
    const rows = await lyricsFlowSearchSongs(track, storefront);
    for (const value of rows) {
      const candidate = lyricsFlowCandidateFrom(value);
      if (!candidate || !candidate.artworkUrl) {
        continue;
      }
      const titleScore = matchTitle(candidate.title, track.title);
      if (titleScore < 2) {
        continue;
      }
      const artistScore = artworkArtistScore(candidate.artist, track.artist);
      if (track.artist && artistScore === 0) {
        continue;
      }
      if (alternateRecordingPhrase(candidate.title) && !queryAlt) {
        continue;
      }
      let score = titleScore + artistScore * 2;
      if (track.album) {
        score += albumNameScore(candidate.album, track.album) * 2;
      }
      if (track.durationSeconds > 0 && candidate.duration > 0) {
        const delta = Math.abs(candidate.duration - track.durationSeconds);
        if (delta <= 8) {
          score += 2;
        } else if (delta <= 25) {
          score += 1;
        }
      }
      if (score > bestScore) {
        bestScore = score;
        best = candidate;
      }
    }
    if (best && (!track.album || albumNameScore(best.album, track.album) > 0)) {
      return { candidate: best };
    }
  }
  if (best) {
    return { candidate: best };
  }
  const resolved = await resolveLyricsFlowTrack(track);
  return resolved?.candidate?.artworkUrl ? { candidate: resolved.candidate } : null;
}

// Session-cached like the lyrics resolution — both usually run per track.
const lyricsFlowArtworkCache = new Map();

function resolveLyricsFlowArtwork(track) {
  const key = trackKey(track);
  if (!lyricsFlowArtworkCache.has(key)) {
    const request = resolveLyricsFlowArtworkUncached(track).catch((error) => {
      lyricsFlowArtworkCache.delete(key);
      throw error;
    });
    lyricsFlowArtworkCache.set(key, request);
  }
  return lyricsFlowArtworkCache.get(key);
}

// Lyrics and animated artwork both need the same catalog lookup, and the app
// starts both on every track change. Resolve once per track for the session.
const lyricsFlowTrackCache = new Map();

async function resolveLyricsFlowTrack(track) {
  const key = trackKey(track);
  if (!lyricsFlowTrackCache.has(key)) {
    const request = resolveLyricsFlowTrackUncached(track).catch((error) => {
      lyricsFlowTrackCache.delete(key);
      throw error;
    });
    
    lyricsFlowTrackCache.set(key, request);
  }
  return lyricsFlowTrackCache.get(key);
}

function isWordLevelLyricsFlowLyrics(body, text) {
  if (body && (body.hasWordLevel === true || body.timingType === 'word')) {
    return true;
  }
  return /itunes:timing="Word"/i.test(text) || text.includes('<span');
}

// TTML metadata can claim line or word timing while the body carries
// itunes:timing="None" and no begin attributes at all. Only trust timing that
// is present in the asset, otherwise unsynced text would outrank real lyrics.
function isTimedTtml(text) {
  return /<[^>]+\bbegin\s*=/i.test(text);
}

// Clean lyric assets blank profanity out with "****", so among timed assets
// an explicit edition is preferred over a clean one; word-level timing only
// breaks ties within the same rating. `rating` comes from the catalog
// `contentRating`. Untimed text ranks below every timed asset: synced clean
// lyrics are more useful than the same words with no clock at all.
function lyricsFlowRank(lyrics) {
  if (!lyrics) {
    return -1;
  }
  if (lyrics.timed === false) {
    if (lyrics.rating === 'explicit') {
      return -1;
    }
    return lyrics.rating === 'clean' ? -3 : -2;
  }
  if (lyrics.rating === 'explicit') {
    return lyrics.wordLevel ? 6 : 5;
  }
  if (lyrics.wordLevel) {
    return lyrics.rating === 'clean' ? 2 : 3;
  }
  return lyrics.rating === 'clean' ? 0 : 1;
}

async function fetchLyricsFlowCommunityLyrics(songId) {
  try {
    const result = await requestJson(
      `${lyricsFlowRoot}/api/community/lyrics/${encodeURIComponent(songId)}`
    );
    const available = result.body?.available;
    if (result.status !== 200 || !Array.isArray(available)) {
      return null;
    }
    // The API orders submissions by preference. Try another if an asset is broken.
    for (const entry of available.slice(0, 3)) {
      const stream = cleanText(entry?.stream_url);
      if (!stream) continue;
      try {
        const url = new URL(stream, lyricsFlowRoot);
        if (url.protocol !== 'https:' && url.protocol !== 'http:') continue;
        const response = await fetch(url.href, {
          headers: {
            Accept: 'application/ttml+xml, application/xml, text/xml;q=0.9',
            'User-Agent': userAgent
          },
          signal: AbortSignal.timeout(requestTimeoutMs)
        });
        if (!response.ok) continue;
        const text = (await response.text()).trim();
        if (text && Buffer.byteLength(text, 'utf8') <= maxLocalLyricsBytes &&
            /<tt(?:\s|>)/i.test(text)) {
          const author = cleanText(entry.author);
          const communityAuthor = cleanText(entry.nickname) || author;
          const communityAuthorUrl = author
            ? `https://trylyricsflow.com/${encodeURIComponent(author)}`
            : '';
          return {
            text, format: 'ttml', source: 'lyricsflow-community',
            timed: isTimedTtml(text),
            communityAuthor,
            ...(communityAuthorUrl ? { communityAuthorUrl } : {})
          };
        }
      } catch {
        // A failed community asset must not prevent the other providers from loading.
      }
    }
  } catch {
    // Community availability is independent of Apple Music lyrics.
  }
  return null;
}

async function fetchLyricsFlowLyrics(songId, storefront) {
  const params = new URLSearchParams({
    song: songId,
    storefront
  });
  const result = await requestJson(`${lyricsFlowRoot}/lyrics?${params.toString()}`);
  if (result.status !== 200) {
    return null;
  }
  const text = cleanText(result.body?.syncedLyrics);
  if (!text || !/<tt[\s>]/i.test(text)) {
    return null;
  }
  return {
    text,
    format: 'ttml',
    source: 'lyricsflow',
    timed: isTimedTtml(text),
    wordLevel: isWordLevelLyricsFlowLyrics(result.body, text)
  };
}

function albumBaseName(value) {
  return normalizeName(
    cleanText(value)
      .replace(/\([^)]*\)/g, ' ')
      .replace(/\[[^\]]*\]/g, ' ')
  );
}

function lyricsFlowAlbumFrom(value) {
  const id = cleanText(String(value?.id ?? ''));
  if (!id) {
    return null;
  }
  const attributes = value && value.attributes && typeof value.attributes === 'object'
    ? value.attributes
    : {};
  const storefront = /\/v1\/catalog\/([a-z]{2})\//.exec(cleanText(value?.href));
  return {
    id,
    name: cleanText(attributes.name),
    rating: cleanText(attributes.contentRating),
    storefront: storefront ? storefront[1] : 'us'
  };
}

async function lyricsFlowArtistAlbums(artistId) {
  let url = `${lyricsFlowRoot}/artist/albums?${new URLSearchParams({
    artist: artistId
  }).toString()}`;
  const rows = [];

  for (let page = 0; page < lyricsFlowAlbumPageLimit && url; page += 1) {
    const result = await requestJson(url);
    if (result.status !== 200) {
      break;
    }
    if (Array.isArray(result.body?.data)) {
      rows.push(...result.body.data);
    }
    const next = cleanText(result.body?.next);
    url = next ? new URL(next, lyricsFlowRoot).toString() : '';
  }
  return rows;
}

async function lyricsFlowAlbumTracks(album) {
  const params = new URLSearchParams({ l: 'en-US' });
  const result = await requestJson(
    `${lyricsFlowRoot}/v1/catalog/${album.storefront}/albums/${album.id}?${params.toString()}`
  );
  if (result.status !== 200) {
    return [];
  }
  const albumRow = Array.isArray(result.body?.data) ? result.body.data[0] : null;
  const tracks = albumRow?.relationships?.tracks?.data;
  return Array.isArray(tracks) ? tracks : [];
}

async function lyricsFlowAlbumTrackMatches(album, track) {
  const tracks = await lyricsFlowAlbumTracks(album);
  const matches = [];
  for (const value of tracks) {
    const attributes = value && value.attributes && typeof value.attributes === 'object'
      ? value.attributes
      : {};
    const id = cleanText(String(value?.id ?? ''));
    if (!id || matchTitle(attributes.name, track.title) < 2) {
      continue;
    }
    const duration = Number(attributes.durationInMillis);
    const durationDelta = Number.isFinite(duration) && track.durationSeconds > 0
      ? Math.abs(duration / 1000 - track.durationSeconds)
      : null;
    if (durationDelta !== null && durationDelta > maxLyricsFlowDurationDeltaSeconds) {
      continue;
    }
    matches.push({ id, durationDelta });
  }
  return matches.sort(
    (left, right) =>
      (left.durationDelta ?? Infinity) - (right.durationDelta ?? Infinity)
  );
}

// The best catalog match is often the clean edition of a release, whose Apple
// lyric asset is line-synced, censored, or missing entirely even when the
// explicit edition ships uncensored word-level timing. Look through the
// artist's other editions of the same album and keep the best-ranked asset.
// `shouldStop` lets the caller abandon the scan once an explicit word-level
// asset is already in hand.
async function resolveLyricsFlowEditionLyrics(track, resolved, shouldStop) {
  const stop = typeof shouldStop === 'function' ? shouldStop : () => false;
  const albumBases = new Set(
    [resolved.candidate.album, track.album]
      .map(albumKey)
      .filter(Boolean)
  );
  if (albumBases.size === 0) {
    return null;
  }

  const artistIds = await lyricsFlowEditionArtistIds(track, resolved);
  if (artistIds.length === 0 || stop()) {
    return null;
  }

  const editions = [];
  for (const artistId of artistIds.slice(0, lyricsFlowEditionArtistAttempts)) {
    const rows = await lyricsFlowArtistAlbums(artistId);
    for (const album of rows.map(lyricsFlowAlbumFrom)) {
      if (
        !album ||
        album.id === resolved.candidate.albumId ||
        !albumBases.has(albumKey(album.name)) ||
        editions.some((existing) => existing.id === album.id)
      ) {
        continue;
      }
      editions.push(album);
    }
    if (editions.length > 0) {
      break;
    }
    if (stop()) {
      return null;
    }
  }
  if (stop()) {
    return null;
  }
  editions.sort(
    (left, right) =>
      Number(right.rating === 'explicit') - Number(left.rating === 'explicit')
  );

  let attempts = 0;
  let best = null;
  let bestRank = -Infinity;
  for (const album of editions.slice(0, lyricsFlowEditionAlbumAttempts)) {
    for (const match of await lyricsFlowAlbumTrackMatches(album, track)) {
      if (stop() || attempts >= lyricsFlowEditionLyricsAttempts) {
        return best;
      }
      attempts += 1;
      const lyrics = await fetchLyricsFlowLyrics(match.id, resolved.storefront);
      if (!lyrics) {
        continue;
      }
      const rated = { ...lyrics, rating: album.rating };
      const rank = lyricsFlowRank(rated);
      if (rank > bestRank) {
        best = rated;
        bestRank = rank;
      }
      if (bestRank >= lyricsFlowExplicitWordRank) {
        console.log(
          "id:", match.id, "storefront:", resolved.storefront,
          `(explicit word-level edition of ${resolved.candidate.id})`
        );
        return best;
      }
    }
  }
  return best;
}

async function resolveLyricsFlowCatalogLyrics(track, resolved) {
  try {
    if (!resolved) {
      return null;
    }
    // `hasTimeSyncedLyrics` from the catalog is unreliable: it is false for
    // many tracks (especially explicit releases) whose TTML the lyrics
    // endpoint happily returns. Use it for ranking only, never as a gate.
    console.log("id:", resolved.candidate.id, "storefront:", resolved.storefront);

    // Track the primary result so the edition scan can bail out early once an
    // explicit word-level asset is in hand.
    let primaryLyrics = null;
    const primaryPromise = fetchLyricsFlowLyrics(resolved.candidate.id, resolved.storefront)
      .then((value) => {
        primaryLyrics = value
          ? { ...value, rating: resolved.candidate.rating }
          : null;
        return primaryLyrics;
      })
      .catch(() => null);

    // The catalog match may be a clean edition whose Apple asset is missing,
    // line-synced, or censored while the explicit edition carries uncensored
    // word-level timing. The scan often finds that asset before the primary's
    // slow 404 answers, so both run at once and the best-ranked result wins.
    const editionPromise = resolveLyricsFlowEditionLyrics(
      track,
      resolved,
      () => lyricsFlowRank(primaryLyrics) >= lyricsFlowExplicitWordRank
    ).catch(() => null);

    const settled = await Promise.race([
      primaryPromise.then((value) => ({ source: "primary", value })),
      editionPromise.then((value) => ({ source: "editions", value }))
    ]);
    if (lyricsFlowRank(settled.value) >= lyricsFlowExplicitWordRank) {
      return settled.value;
    }

    // Nothing ideal yet: wait for the other lookup before settling, then keep
    // the better-ranked asset.
    const remaining = settled.source === "primary" ? editionPromise : primaryPromise;
    const other = await remaining;
    const primary = settled.source === "primary" ? settled.value : other;
    const edition = settled.source === "editions" ? settled.value : other;
    return lyricsFlowRank(edition) > lyricsFlowRank(primary)
      ? edition
      : (primary ?? edition);
  } catch {
    return null;
  }
}

async function resolveLyricsFlowLyrics(track) {
  try {
    const resolved = await resolveLyricsFlowTrack(track);
    if (!resolved) {
      return null;
    }
    const community = await fetchLyricsFlowCommunityLyrics(resolved.candidate.id);
    if (community) {
      return community;
    }
    return await resolveLyricsFlowCatalogLyrics(track, resolved);
  } catch {
    return null;
  }
}

// Paxsenix only leaves its Apple Music endpoint open, so it needs the same
// catalog ID the Flow lookup already resolves. That makes it a cheap retry of
// the same recording through a different backend rather than an independent
// search: when Flow's own lyrics asset is missing, this cache often has the
// word-level TTML. `v=2` returns a normalized envelope that carries the raw
// `ttmlContent`, which the existing TTML renderer already understands.
async function resolvePaxsenixLyrics(track) {
  try {
    const resolved = await resolveLyricsFlowTrack(track);
    const songId = cleanText(String(resolved?.candidate?.id ?? ''));
    if (!/^\d+$/.test(songId)) {
      return null;
    }
    const params = new URLSearchParams({ id: songId, v: '2' });
    const result = await requestJson(
      `${paxsenixRoot}/apple-music/lyrics?${params.toString()}`
    );
    if (result.status !== 200) {
      return null;
    }
    const text = cleanText(result.body?.ttmlContent);
    if (
      !text ||
      Buffer.byteLength(text, 'utf8') > maxLocalLyricsBytes ||
      !/<tt(?:\s|>)/i.test(text)
    ) {
      return null;
    }
    return { text, format: 'ttml', source: 'paxsenix', timed: isTimedTtml(text) };
  } catch {
    return null;
  }
}

// Better Lyrics serves TTML from a cache keyed by title, artist, album and
// duration. Without an API key it only answers cache hits and returns 401 for
// a miss, which is fine here: the request fails quietly and the next provider
// still runs. Send all four parameters anyway, because the key is built from
// them and a partial key would miss entries the extension already cached.
function betterLyricsUrl(track) {
  const params = new URLSearchParams({ s: track.title, a: track.artist });
  if (track.album) {
    params.set('al', track.album);
  }
  if (track.durationSeconds > 0) {
    params.set('d', String(Math.round(track.durationSeconds)));
  }
  return `${betterLyricsRoot}/getLyrics?${params.toString()}`;
}

async function resolveBetterLyrics(track) {
  if (!track.title) {
    return null;
  }
  try {
    const result = await requestJson(betterLyricsUrl(track));
    if (result.status !== 200) {
      return null;
    }
    const text = cleanText(result.body?.ttml);
    if (
      !text ||
      Buffer.byteLength(text, 'utf8') > maxLocalLyricsBytes ||
      !/<tt(?:\s|>)/i.test(text)
    ) {
      return null;
    }
    return { text, format: 'ttml', source: 'betterlyrics', timed: isTimedTtml(text) };
  } catch {
    return null;
  }
}

// QQ uses the same metadata parameters as TTML, but has its own public cache
// and returns decoded QRC rather than requiring a TTML cache hit.
async function resolveBetterLyricsQq(track) {
  try {
    const url = betterLyricsUrl(track).replace('/getLyrics?', '/qq/getLyrics?');
    const result = await requestJson(url);
    const text = cleanText(result.body?.lyrics);
    if (result.status !== 200 || !text ||
        Buffer.byteLength(text, 'utf8') > maxLocalLyricsBytes ||
        !/\[\d+,\d+\]/.test(text)) {
      return null;
    }
    return { text, format: 'qrc', source: 'betterlyrics-qq' };
  } catch {
    return null;
  }
}

function escapeLyricXml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

// Normalized LiriQo times are absolute milliseconds, including word ends.
// Adapting them to TTML keeps the existing singer and karaoke renderer shared
// with local files, without estimating word windows from line durations.
function liriqoLyrics(candidate) {
  if (!candidate || typeof candidate !== 'object') {
    return null;
  }
  // Prefer original TTML when present so background-vocal roles survive.
  const ttml = cleanText(candidate.ttml);
  if (/<tt(?:\s|>)/i.test(ttml)) return { text: ttml, format: 'ttml' };
  const paragraphs = (Array.isArray(candidate.timed) ? candidate.timed : []).flatMap(line => {
    if (!line || line.isInstrumental || !cleanText(line.text) ||
        !Number.isFinite(line.start) || line.start < 0) {
      return [];
    }
    const end = Number.isFinite(line.end) && line.end > line.start
      ? ` end="${line.end}ms"` : '';
    const agent = cleanText(line.agent)
      ? ` ttm:agent="${escapeLyricXml(line.agent)}"` : '';
    const words = line.words ?? candidate.words?.[line.id];
    const usableWords = Array.isArray(words) && words.length > 0 && words.every(word =>
      word && typeof word.text === 'string' && Number.isFinite(word.start) &&
      word.start >= 0 && Number.isFinite(word.end) && word.end > word.start
    ) && words.map(word => word.text).join('').trim() === line.text.trim();
    const text = usableWords
      ? words.map(word => `<span begin="${word.start}ms" end="${word.end}ms">${escapeLyricXml(word.text)}</span>`).join('')
      : escapeLyricXml(line.text);
    return [`<p begin="${line.start}ms"${end}${agent}>${text}</p>`];
  });
  if (paragraphs.length) {
    return { text: `<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttm="http://www.w3.org/ns/ttml#metadata"><body><div>${paragraphs.join('')}</div></body></tt>`, format: 'ttml' };
  }
  for (const format of ['ttml', 'qrc', 'lrc']) {
    const text = cleanText(candidate[format]);
    const valid = format === 'ttml' ? /<tt(?:\s|>)/i.test(text)
      : format === 'qrc' ? /\[\d+,\d+\]/.test(text) : /\[\d+:\d+/.test(text);
    if (text && valid) {
      return { text, format };
    }
  }
  return null;
}

function cleanUnisonArtist(artist) {
  return cleanText(artist).replace(/\s*-\s*topic$/i, '').trim();
}

async function fetchUnisonByParams(params) {
  try {
    const result = await requestJson(`${unisonRoot}/lyrics?${params}`);
    if (result.status !== 200 || !result.body?.success || !result.body?.data) {
      return null;
    }
    return result.body.data;
  } catch {
    return null;
  }
}

function unisonSubmitterInfo(submitter) {
  const communityAuthor = cleanText(submitter?.displayName);
  const keyId = cleanText(submitter?.keyId);
  const communityAuthorUrl = keyId
    ? `${unisonRoot}/curator/${encodeURIComponent(keyId)}`
    : '';
  return { communityAuthor, communityAuthorUrl };
}

async function resolveUnisonSubmitter({ videoId, title, artist }) {
  if (videoId) {
    const byVideo = await fetchUnisonByParams(new URLSearchParams({ v: videoId }));
    const info = unisonSubmitterInfo(byVideo?.submitter);
    if (info.communityAuthor || info.communityAuthorUrl) return info;
  }
  const cleanArtist = cleanUnisonArtist(artist);
  if (title && cleanArtist) {
    const byTrack = await fetchUnisonByParams(new URLSearchParams({ song: title, artist: cleanArtist }));
    return unisonSubmitterInfo(byTrack?.submitter);
  }
  return { communityAuthor: '', communityAuthorUrl: '' };
}

async function resolveUnisonLyrics(track) {
  const cleanArtist = cleanUnisonArtist(track.artist);
  if (!track.title || !cleanArtist) {
    return null;
  }
  const data = await fetchUnisonByParams(new URLSearchParams({ song: track.title, artist: cleanArtist }));
  if (!data) {
    return null;
  }
  if ((data.song && matchTitle(data.song, track.title) < 3) ||
      (data.artist && !matchArtist(data.artist, track.artist))) {
    return null;
  }
  const text = cleanText(data.lyrics);
  if (!text || Buffer.byteLength(text, 'utf8') > maxLocalLyricsBytes) {
    return null;
  }
  const format = /<tt(?:\s|>)/i.test(text) ? 'ttml' : (/\[\d+:\d+/.test(text) ? 'lrc' : '');
  if (!format) {
    return null;
  }
  const { communityAuthor, communityAuthorUrl } = unisonSubmitterInfo(data.submitter);
  return {
    text,
    format,
    source: 'unison',
    timed: format === 'ttml' ? isTimedTtml(text) : true,
    ...(communityAuthor ? { communityAuthor } : {}),
    ...(communityAuthorUrl ? { communityAuthorUrl } : {})
  };
}

async function resolveLiriqoLyrics(track) {
  try {
    const params = new URLSearchParams({ title: track.title, artist: track.artist, fast: '1' });
    if (track.album) params.set('album', track.album);
    if (track.durationSeconds > 0) params.set('duration', String(track.durationSeconds));
    const result = await requestJson(`${liriqoRoot}/lyrics?${params}`);
    if (result.status !== 200 || !result.body || result.body.error) return null;
    const metadata = result.body.metadata;
    if (metadata && ((metadata.title && (matchTitle(metadata.title, track.title) < 3 ||
         (alternateRecordingPhrase(metadata.title) &&
          alternateRecordingPhrase(metadata.title) !== alternateRecordingPhrase(track.title)))) ||
        (metadata.artist && track.artist && !matchArtist(metadata.artist, track.artist)) ||
        (Number.isFinite(metadata.duration) && track.durationSeconds > 0 &&
         Math.abs(metadata.duration - track.durationSeconds) > maxDurationDeltaSeconds))) {
      return null;
    }
    const candidates = [result.body.primary, ...(Array.isArray(result.body.tracks) ? result.body.tracks : [])];
    for (const candidate of candidates) {
      const lyrics = liriqoLyrics(candidate);
      if (lyrics && Buffer.byteLength(lyrics.text, 'utf8') <= maxLocalLyricsBytes) {
        const provider = cleanText(candidate.upstreamProvider || candidate.lyricsSource || candidate.provider);
        const isUnison = candidate.provider === 'unison_community' || /^unison\b/i.test(provider);
        const { communityAuthor, communityAuthorUrl } = isUnison
          ? await resolveUnisonSubmitter({
              videoId: cleanText(result.body.videoId),
              title: cleanText(candidate.title) || track.title,
              artist: cleanText(candidate.artist) || track.artist
            })
          : { communityAuthor: '', communityAuthorUrl: '' };
        return {
          ...lyrics,
          timed: lyrics.format === 'ttml' ? isTimedTtml(lyrics.text) : true,
          source: provider ? `LiriQo · ${provider}` : 'LiriQo',
          ...(communityAuthor ? { communityAuthor } : {}),
          ...(communityAuthorUrl ? { communityAuthorUrl } : {})
        };
      }
    }
    return null;
  } catch {
    return null;
  }
}

async function resolveLrcLibLyrics(track) {
  try {
    const exact = await requestJson(queryUrl('get', track));
    if (exact.status === 200) {
      const lrc = lyricsFromCandidate(candidateFrom(exact.body));
      return lrc ? { text: lrc, format: 'lrc', source: 'lrclib' } : null;
    }
    if (exact.status !== 404) {
      return null;
    }

    const search = await requestJson(queryUrl('search', track, false));
    if (search.status !== 200 || !Array.isArray(search.body)) {
      return null;
    }

    let best = null;
    for (const value of search.body) {
      const scored = scoreCandidate(candidateFrom(value), track);
      if (!scored) {
        continue;
      }
      if (!best ||
          scored.score > best.score ||
          (scored.score === best.score &&
           scored.durationDelta < best.durationDelta)) {
        best = scored;
      }
    }

    const lrc = best ? lyricsFromCandidate(best.candidate) : '';
    return lrc ? { text: lrc, format: 'lrc', source: 'lrclib' } : null;
  } catch {
    return null;
  }
}

async function fetchAmllRawLyricsIndex() {
  if (!amllRawLyricsIndexRequest) {
    amllRawLyricsIndexRequest = (async () => {
      const response = await fetch(amllRawLyricsIndexUrl, {
        headers: {
          Accept: 'text/plain',
          'User-Agent': userAgent
        },
        signal: AbortSignal.timeout(requestTimeoutMs)
      });
      if (!response.ok) {
        throw new Error(`AMLL raw lyrics index returned HTTP ${response.status}`);
      }

      const indexText = await response.text();
      if (Buffer.byteLength(indexText, 'utf8') > maxLocalLyricsBytes) {
        throw new Error('AMLL raw lyrics index is too large');
      }
      return indexText.split(/\r?\n/).flatMap((line) => {
        if (!line) {
          return [];
        }
        try {
          const entry = JSON.parse(line);
          return entry && typeof entry.rawLyricFile === 'string'
            ? [entry]
            : [];
        } catch {
          return [];
        }
      });
    })().catch((error) => {
      amllRawLyricsIndexRequest = null;
      throw error;
    });
  }
  return amllRawLyricsIndexRequest;
}

function rawLyricsMetadataValues(entry, key) {
  const metadata = Array.isArray(entry.metadata) ? entry.metadata : [];
  const pair = metadata.find(
    (item) => Array.isArray(item) && item[0] === key
  );
  return Array.isArray(pair?.[1])
    ? pair[1].filter((value) => typeof value === 'string')
    : [];
}

function scoreAmllRawEntry(entry, track) {
  const titles = rawLyricsMetadataValues(entry, 'musicName');
  const artists = rawLyricsMetadataValues(entry, 'artists');
  const albums = rawLyricsMetadataValues(entry, 'album');
  const titleScore = Math.max(0, ...titles.map((title) =>
    matchTitle(title, track.title)
  ));
  if (titleScore < 3) {
    return null;
  }

  const artistScore = track.artist
    ? Math.max(0, ...artists.map((artist) => matchArtist(artist, track.artist)))
    : 0;
  if (track.artist && artistScore === 0) {
    return null;
  }

  const albumScore = track.album
    ? Math.max(0, ...albums.map((album) => matchTitle(album, track.album)))
    : 0;
  return titleScore * 2 + artistScore * 2 + albumScore;
}

async function fetchAmllRawLyrics(entry) {
  const response = await fetch(
    `${amllRoot}/raw-lyrics/${encodeURIComponent(entry.rawLyricFile)}`,
    {
      headers: {
        Accept: 'application/ttml+xml, application/xml, text/xml;q=0.9',
        'User-Agent': userAgent
      },
      signal: AbortSignal.timeout(requestTimeoutMs)
    }
  );
  if (!response.ok) {
    return null;
  }

  const text = (await response.text()).trim();
  if (
    !text ||
    Buffer.byteLength(text, 'utf8') > maxLocalLyricsBytes ||
    !/<tt(?:\s|>)/i.test(text)
  ) {
    return null;
  }
  return { text, format: 'ttml', source: 'amll-ttml-db', timed: isTimedTtml(text) };
}

async function resolveAmllLyrics(track) {
  let resolved = null;
  try {
    resolved = await resolveLyricsFlowTrack(track);
  } catch (error) {
    console.warn('AMLL catalog ID lookup failed:', error);
  }

  const songId = cleanText(String(resolved?.candidate?.id ?? ''));
  if (/^\d+$/.test(songId)) {
    try {
      const response = await fetch(
        `${amllRoot}/am-lyrics/${songId}.ttml`,
        {
          headers: {
            Accept: 'application/ttml+xml, application/xml, text/xml;q=0.9',
            'User-Agent': userAgent
          },
          signal: AbortSignal.timeout(requestTimeoutMs)
        }
      );
      if (response.ok) {
        const text = (await response.text()).trim();
        if (
          text &&
          Buffer.byteLength(text, 'utf8') <= maxLocalLyricsBytes &&
          /<tt(?:\s|>)/i.test(text)
        ) {
          return { text, format: 'ttml', source: 'amll-ttml-db', timed: isTimedTtml(text) };
        }
      }
    } catch (error) {
      console.warn('AMLL track ID lookup failed:', error);
    }
  }

  try {
    const entries = await fetchAmllRawLyricsIndex();
    let best = null;
    let bestScore = 0;
    for (const entry of entries) {
      const score = scoreAmllRawEntry(entry, track);
      if (score !== null && score >= bestScore) {
        best = entry;
        bestScore = score;
      }
    }
    return best ? await fetchAmllRawLyrics(best) : null;
  } catch (error) {
    console.warn('AMLL raw lyrics lookup failed:', error);
    return null;
  }
}

function lyricsResponse(key, value) {
  return {
    trackKey: key,
    text: value.text,
    format: value.format,
    source: value.source,
    communityAuthor: cleanText(value.communityAuthor),
    communityAuthorUrl: cleanText(value.communityAuthorUrl)
  };
}

async function resolveLyrics(track) {
  // TTML without begin timing is still lyrics, but it is not synced lyrics.
  // Keep the first unsynced hit as a fallback while later providers get a
  // chance to supply real timing.
  let unsyncedFallback = null;
  const synced = (result) => {
    if (!result) {
      return null;
    }
    if (result.timed === false) {
      if (!unsyncedFallback) {
        console.log(`${result.source} lyrics are unsynced; checking synced providers first`);
      }
      unsyncedFallback ??= result;
      return null;
    }
    return result;
  };

  const flowTrack = await resolveLyricsFlowTrack(track).catch(() => null);
  const flowCommunity = flowTrack
    ? synced(await fetchLyricsFlowCommunityLyrics(flowTrack.candidate.id).catch(() => null))
    : null;
  if (flowCommunity) {
    console.log("Resolved lyrics from LyricsFlow Community:", flowCommunity);
    return flowCommunity;
  }

  const unison = synced(await resolveUnisonLyrics(track));
  if (unison) {
    console.log("Resolved lyrics from Unison (Better Lyrics)");
    return unison;
  }

  const flow = flowTrack
    ? synced(await resolveLyricsFlowCatalogLyrics(track, flowTrack))
    : null;
  if (flow) {
    console.log("Resolved lyrics from LyricsFlow:", flow);
    return flow;
  }

  const paxsenix = synced(await resolvePaxsenixLyrics(track));
  if (paxsenix) {
    console.log("Resolved lyrics from Paxsenix");
    return paxsenix;
  }

  console.log("Checking Better Lyrics for track:", track);
  const betterLyrics = synced(await resolveBetterLyrics(track));
  if (betterLyrics) {
    console.log("Resolved lyrics from Better Lyrics");
    return betterLyrics;
  }

  const qq = await resolveBetterLyricsQq(track);
  if (qq) return qq;

  const liriqo = synced(await resolveLiriqoLyrics(track));
  if (liriqo) return liriqo;

  console.log("Better Lyrics and LiriQo not found, checking AMLL TTML DB for track:", track);
  const amll = synced(await resolveAmllLyrics(track));
  if (amll) {
    console.log("Resolved lyrics from AMLL TTML DB");
    return amll;
  }

  console.log("AMLL TTML DB lyrics not found, falling back to LRC Lib for track:", track);

  const lrclib = synced(await resolveLrcLibLyrics(track));
  console.log("Resolved lyrics from LRC Lib:", lrclib);
  const resolved = lrclib ?? unsyncedFallback;
  if (resolved === unsyncedFallback && unsyncedFallback) {
    console.log("No synced lyrics found; falling back to unsynced lyrics:", unsyncedFallback);
  }
  return resolved ?? { text: '', format: '', source: '' };
}

async function loadLyrics(track, key) {
  const persisted = await readPersistedLyrics(key);
  if (persisted?.fresh) {
    cache.set(key, persisted.value);
    return lyricsResponse(key, persisted.value);
  }

  console.log("Fetching lyrics for track:", track);

  const resolved = await resolveLyrics(track);
  const value = resolved.text
    ? resolved
    : (persisted?.value ?? resolved);
  cache.set(key, value);

  console.log("Resolved lyrics:", value);

  // Unsynced text is only a fallback: keep it in memory for this session,
  // but do not pin it to disk where it would block a later synced lookup.
  if (resolved.text && resolved.timed !== false) {
    await writePersistedLyrics(key, resolved);
  }
  return lyricsResponse(key, value);
}

function getLyricsForTrack(input) {
  const track = normalizeTrack(input);
  if (!track.title) {
    return Promise.resolve(lyricsResponse('', {
      text: '',
      format: '',
      source: ''
    }));
  }

  const key = reusableTrackKey(track) || trackKey(track);
  if (cache.has(key)) {
    return Promise.resolve(lyricsResponse(key, cache.get(key)));
  }
  if (inflight.has(key)) {
    return inflight.get(key);
  }

  const request = loadLyrics(track, key).finally(() => {
    inflight.delete(key);
  });
  inflight.set(key, request);
  return request;
}

async function searchLyrics(input, queryInput) {
  const track = normalizeTrack(input);
  const query = cleanText(queryInput).slice(0, 200) ||
    [track.title, track.artist].filter(Boolean).join(' ');
  if (!query) {
    return { results: [] };
  }

  try {
    const params = new URLSearchParams({ q: query });
    const result = await requestJson(`${apiRoot}search?${params.toString()}`);
    if (result.status !== 200 || !Array.isArray(result.body)) {
      return { results: [] };
    }
    const results = result.body.slice(0, 40).flatMap(value => {
      const candidate = candidateFrom(value);
      const text = cleanText(candidate?.syncedLyrics || value?.plainLyrics);
      if (!candidate || !text ||
          Buffer.byteLength(text, 'utf8') > maxLocalLyricsBytes) {
        return [];
      }
      return [{
        title: candidate.track.slice(0, 160),
        artist: candidate.artist.slice(0, 160),
        album: cleanText(value.albumName).slice(0, 160),
        durationSeconds: candidate.duration,
        text,
        source: 'lrclib'
      }];
    });
    return { results };
  } catch {
    return { results: [], error: 'search_failed' };
  }
}

async function readLocalLyricsFile(filePath) {
  const stats = await fs.stat(filePath);
  if (!stats.isFile()) {
    return { error: 'That is not a file.' };
  }
  if (stats.size > maxLocalLyricsBytes) {
    return { error: 'Lyrics file is too large.' };
  }
  const text = await fs.readFile(filePath, 'utf8');
  return { canceled: false, name: path.basename(filePath), text };
}

async function openLocalLyricsFile() {
  const owner = BrowserWindow.getFocusedWindow();
  const options = {
    title: 'Open Lyrics',
    properties: ['openFile'],
    filters: [
      { name: 'Lyrics', extensions: ['lrc', 'elrc', 'qrc', 'ttml', 'xml', 'txt'] }
    ]
  };
  const result = owner
    ? await dialog.showOpenDialog(owner, options)
    : await dialog.showOpenDialog(options);
  if (result.canceled || result.filePaths.length === 0) {
    return { canceled: true };
  }
  try {
    return await readLocalLyricsFile(result.filePaths[0]);
  } catch {
    return { canceled: false, error: 'Could not read lyrics file.' };
  }
}

function registerLyricsIpc() {
  ipcMain.handle('lyrics:get', (_event, track) => getLyricsForTrack(track));
  ipcMain.handle('lyrics:search', (_event, track, query) => searchLyrics(track, query));
  ipcMain.handle('lyrics:open-file', () => openLocalLyricsFile());
}

module.exports = {
  lyricsFlowRoot,
  getLyricsForTrack,
  normalizeTrack,
  openLocalLyricsFile,
  readLocalLyricsFile,
  registerLyricsIpc,
  searchLyrics,
  resolveLyricsFlowArtwork,
  resolveLyricsFlowTrack,
  userAgent
};
