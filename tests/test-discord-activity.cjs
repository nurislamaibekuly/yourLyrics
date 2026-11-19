const { test } = require('node:test');
const assert = require('node:assert');
const {
  defaultSettings,
  sanitizeSettings,
  buildActivity,
  activitySignature
} = require('../src/main/discord/discord-activity');

const track = {
  title: 'Synthetic song',
  artist: 'Test artist',
  album: 'Test album',
  durationSeconds: 180,
  positionSeconds: 30,
  playing: true
};

test('application IDs are normalized to digits with the configured default as fallback', () => {
  assert.equal(sanitizeSettings({ clientId: '123-45abc' }).clientId, '12345');
  assert.equal(sanitizeSettings({ clientId: 'not-an-id' }).clientId, defaultSettings.clientId);
});

test('status name modes use the app, track, artist or custom text', () => {
  const activityFor = displayNameMode => buildActivity({
    enabled: true,
    displayNameMode,
    displayName: 'Custom status'
  }, track);
  assert.equal(activityFor('app').name, 'yourLyrics');
  assert.equal(activityFor('player').name, 'yourLyrics');
  assert.equal(activityFor('title').name, track.title);
  assert.equal(activityFor('artist').name, track.artist);
  assert.equal(activityFor('custom').name, 'Custom status');
});

test('player status names use a readable source app label', () => {
  const appleMusic = buildActivity({ enabled: true, displayNameMode: 'player' }, {
    ...track,
    source: 'com.apple.Music'
  });
  assert.equal(appleMusic.name, 'Apple Music');
  assert.equal(appleMusic.details, track.title);
  assert.equal(appleMusic.state, track.artist);

  const spotify = buildActivity({ enabled: true, displayNameMode: 'player' }, {
    ...track,
    source: 'org.mpris.MediaPlayer2.spotify'
  });
  assert.equal(spotify.name, 'Spotify');
});

test('title and artist remain visible in the body when selected as status name', () => {
  const titleStatus = buildActivity({
    enabled: true,
    displayNameMode: 'title'
  }, track);
  assert.equal(titleStatus.name, track.title);
  assert.equal(titleStatus.details, track.title);

  const artistStatus = buildActivity({
    enabled: true,
    displayNameMode: 'artist'
  }, track);
  assert.equal(artistStatus.name, track.artist);
  assert.equal(artistStatus.state, track.artist);
});

test('idle or disabled state produces no activity', () => {
  assert.equal(buildActivity({}, track), null);
  assert.equal(buildActivity({ enabled: true }, { title: 'No song playing' }), null);
  assert.equal(buildActivity({ enabled: true }, null), null);
});

test('title, artist and album toggles shape the two visible lines', () => {
  const activity = buildActivity({
    enabled: true,
    showTitle: true,
    showArtist: true,
    showAlbum: true
  }, track);
  assert.equal(activity.details, track.title);
  assert.equal(activity.state, `${track.artist} - ${track.album}`);

  const albumOnly = buildActivity({
    enabled: true,
    showTitle: false,
    showArtist: false,
    showAlbum: true
  }, track);
  assert.equal(albumOnly.state, track.album);

  const longArtist = buildActivity({
    enabled: true,
    showArtist: true,
    showAlbum: true
  }, { ...track, artist: 'A'.repeat(128) });
  assert.ok(longArtist.state.endsWith(` - ${track.album}`));
  assert.ok(longArtist.state.length <= 128);
});

test('timestamps follow playback and disappear while paused', () => {
  const playing = buildActivity({ enabled: true }, track);
  assert.equal(playing.timestamps.end - playing.timestamps.start, track.durationSeconds);
  assert.equal(playing.timestamps.start, Math.floor(Date.now() / 1000) - track.positionSeconds);
  assert.equal(buildActivity({ enabled: true }, { ...track, playing: false }).timestamps, undefined);
});

test('only remote artwork is sent to Discord', () => {
  const remoteUrl = 'https://cdn.example.com/cover.jpg';
  const withRemote = buildActivity({ enabled: true }, {
    ...track,
    artworkRemoteUrl: remoteUrl,
    artworkUrl: 'data:image/jpeg;base64,Y292ZXI='
  });
  assert.equal(withRemote.assets.large_image, remoteUrl);

  const dataOnly = buildActivity({ enabled: true }, {
    ...track,
    artworkUrl: 'data:image/jpeg;base64,Y292ZXI='
  });
  assert.equal(dataOnly.assets, undefined);
  assert.equal(buildActivity({ enabled: true, showArtwork: false }, {
    ...track,
    artworkRemoteUrl: remoteUrl
  }).assets, undefined);
});

test('activity signatures ignore clock-derived timestamps', () => {
  const first = { name: 'yourLyrics', timestamps: { start: 100, end: 280 } };
  const later = { name: 'yourLyrics', timestamps: { start: 101, end: 281 } };
  assert.equal(activitySignature(first), activitySignature(later));
  assert.notEqual(activitySignature(first), activitySignature({ name: 'yourLyrics' }));
  assert.notEqual(activitySignature(first), activitySignature({
    name: 'yourLyrics',
    timestamps: { start: 110, end: 290 }
  }));
  assert.notEqual(activitySignature(first), activitySignature({ name: 'Other' }));
});