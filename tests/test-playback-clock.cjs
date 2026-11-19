'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const source = fs.readFileSync(path.join(__dirname, '../src/renderer/player/playback-clock.js'));
const clockModule = import('data:text/javascript;base64,' + source.toString('base64'));
const snapshot = overrides => ({
  title: 'Synthetic song', artist: 'Clock test', album: '', source: 'test-player',
  positionSeconds: 116.528, playing: false, playbackRate: 0, ...overrides
});

test('play starts advancing immediately despite a retained zero rate', async () => {
  const { PlaybackClock } = await clockModule;
  const clock = new PlaybackClock();
  clock.update(snapshot(), 0);
  clock.update(snapshot({ playing: true }), 1000);
  assert.equal(clock.read(1250), 116.778);
  assert.equal(clock.read(2000), 117.528);
});

test('the delayed resume sample cannot rewind or freeze the visible lyric clock', async () => {
  const { PlaybackClock } = await clockModule;
  const clock = new PlaybackClock();
  clock.update(snapshot(), 0);
  clock.update(snapshot({ playing: true }), 1000);
  const before = clock.read(2500);
  clock.update(snapshot({ playing: true, playbackRate: 1, positionSeconds: 117.16 }), 2500);
  assert.equal(clock.read(2500), before);
  let previous = before;
  for (let now = 2510; now <= 5000; now += 10) {
    const position = clock.read(now);
    assert.ok(position > previous, 'A late correction must never stop or rewind word fill');
    assert.ok(position - previous <= 0.010001);
    previous = position;
  }
  assert.ok(Math.abs(clock.read(5000) - 119.66) < 0.000001,
    'The clock must still converge to the timestamped source position');
});

test('small forward and backward corrections remain continuous and converge', async () => {
  const { PlaybackClock } = await clockModule;
  for (const error of [-0.8, 0.8]) {
    const clock = new PlaybackClock();
    clock.update(snapshot({ playing: true, playbackRate: 1, positionSeconds: 10 }), 0);
    clock.update(snapshot({ playing: true, playbackRate: 1, positionSeconds: 11 + error }), 1000);
    assert.equal(clock.read(1000), 11);
    let previous = 11;
    for (let now = 1010; now <= 3000; now += 10) {
      const position = clock.read(now);
      const step = position - previous;
      assert.ok(step >= 0.004999 && step <= 0.015001);
      previous = position;
    }
    assert.ok(Math.abs(clock.read(3000) - (13 + error)) < 0.000001);
  }
});

test('pause freezes the clock and resume has no warm-up period', async () => {
  const { PlaybackClock } = await clockModule;
  const clock = new PlaybackClock();
  clock.update(snapshot({ playing: true, playbackRate: 1, positionSeconds: 10 }), 0);
  clock.update(snapshot({ positionSeconds: 10.5 }), 500);
  assert.equal(clock.read(5000), 10.5);
  clock.update(snapshot({ playing: true, positionSeconds: 10.5 }), 5000);
  assert.equal(clock.read(5100), 10.6);
});

test('positive playback speeds and seeks are preserved', async () => {
  const { PlaybackClock } = await clockModule;
  const clock = new PlaybackClock();
  clock.update(snapshot({ playing: true, playbackRate: 2, positionSeconds: 10 }), 0);
  assert.equal(clock.read(500), 11);
  clock.update(snapshot({ playing: true, playbackRate: 2, positionSeconds: 30 }), 500);
  assert.equal(clock.read(500), 30);
  clock.seek(30.5, 500);
  assert.equal(clock.read(500), 30.5);
  assert.equal(clock.read(1000), 31.5);
});

test('a new recording resets even when its position differs by less than a second', async () => {
  const { PlaybackClock } = await clockModule;
  const clock = new PlaybackClock();
  clock.update(snapshot({ playing: true, positionSeconds: 0.5 }), 0);
  clock.update(snapshot({ title: 'Another song', playing: true, positionSeconds: 0.1 }), 100);
  assert.equal(clock.read(100), 0.1);
});
