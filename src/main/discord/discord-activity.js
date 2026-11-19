
'use strict';

const defaultSettings = {
  enabled: false,
  clientId: '1568929555841032262',
  displayNameMode: 'app',
  displayName: '',
  showTitle: true,
  showArtist: true,
  showAlbum: false,
  showTimestamps: true,
  showArtwork: true,
  hideWhenPaused: false,
  activityType: 2
};

const clean = (value, limit = 128) => typeof value === 'string'
  ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit)
  : '';

function sanitizeSettings (settings = {}) {
  const s = settings && typeof settings === 'object' ? settings : {};
  const id = String(s.clientId || '').replace(/\D/g, '');
  return {
    enabled: s.enabled === true,
    clientId: id || defaultSettings.clientId,
    displayNameMode: ['app', 'player', 'title', 'artist', 'custom'].includes(s.displayNameMode)
      ? s.displayNameMode : defaultSettings.displayNameMode,
    displayName: clean(s.displayName),
    showTitle: s.showTitle !== false,
    showArtist: s.showArtist !== false,
    showAlbum: s.showAlbum === true,
    showTimestamps: s.showTimestamps !== false,
    showArtwork: s.showArtwork !== false,
    hideWhenPaused: s.hideWhenPaused === true,
    activityType: [0, 2, 3, 5].includes(s.activityType) ? s.activityType : defaultSettings.activityType
  };
}

function playerName (source) {
  const value = clean(source, 256).replace(/\.exe$/i, '');
  if (!value) return '';
  const key = value.toLowerCase();
  const knownNames = {
    'com.apple.music': 'Apple Music',
    'com.spotify.client': 'Spotify',
    'org.mpris.mediaplayer2.spotify': 'Spotify',
    'com.google.chrome': 'Google Chrome',
    'com.microsoft.edge': 'Microsoft Edge',
    'org.videolan.vlc': 'VLC',
    'com.apple.quicktimeplayerx': 'QuickTime Player'
  };
  if (knownNames[key]) return knownNames[key];

  const label = value
    .replace(/^org\.mpris\.mediaplayer2\./i, '')
    .replace(/\.instance\d+$/i, '')
    .split(/[.\\/]/)
    .filter(Boolean)
    .pop();
  if (!label) return '';
  return label.replace(/(^|[\s_-])([a-z])/g, (_match, prefix, letter) =>
    `${prefix}${letter.toUpperCase()}`);
}

function buildActivity (settings, nowPlaying) {
  const s = sanitizeSettings(settings);
  const np = nowPlaying || {};
  const title = clean(np.title);
  const artist = clean(np.artist);
  const album = clean(np.album);
  if (!s.enabled || !np || (!title && !artist && !album) ||
      (title === 'No song playing' && !artist && !album)) {
    return null;
  }
  const names = {
    app: 'yourLyrics',
    player: playerName(np.source) || 'yourLyrics',
    title: title || 'yourLyrics',
    artist: artist || 'yourLyrics',
    custom: s.displayName || 'yourLyrics'
  };
  const activity = { name: clean(names[s.displayNameMode]) || 'yourLyrics', type: s.activityType };
  if (s.showTitle && title) activity.details = title;
  let state;
  if (s.showArtist && artist && s.showAlbum && album) {
    const albumText = album.slice(0, 128);
    const artistText = artist.slice(0, Math.max(0, 128 - albumText.length - 3));
    state = artistText ? `${artistText} - ${albumText}` : albumText;
  } else {
    state = [s.showArtist ? artist : '', s.showAlbum ? album : '']
      .filter(Boolean)
      .join(' - ')
      .slice(0, 128);
  }
  if (state) activity.state = state;

  const duration = Number(np.durationSeconds);
  const position = Number(np.positionSeconds);
  const paused = np.isPaused === true || np.paused === true || np.playing === false || np.isPlaying === false;
  if (s.showTimestamps && !paused && Number.isFinite(duration) && duration > 0) {
    const now = Math.floor(Date.now() / 1000);
    const start = now - Math.floor(Number.isFinite(position) ? Math.max(0, Math.min(position, duration)) : 0);
    activity.timestamps = { start, end: start + Math.floor(duration) };
  }

  const artwork = [np.artworkRemoteUrl, np.artworkUrl].find(v => typeof v === 'string' && /^https:\/\//i.test(v));
  if (s.showArtwork && artwork) {
    activity.assets = { large_image: artwork };
    const label = album || title;
    if (label) activity.assets.large_text = label;
  }
  return activity;
}

function activitySignature (activity) {
  if (!activity) return 'null';
  const stable = { ...activity };
  if (stable.timestamps) {
    stable.timestamps = {
      start: Math.floor(stable.timestamps.start / 5),
      duration: stable.timestamps.end - stable.timestamps.start
    };
  }
  return JSON.stringify(stable);
}

module.exports = { defaultSettings, sanitizeSettings, buildActivity, activitySignature };
