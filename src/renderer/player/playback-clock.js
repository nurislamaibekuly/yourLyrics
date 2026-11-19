// Playback state and timeline samples can arrive separately. Keep one local
// clock running through those updates instead of restarting lyric animation.
export class PlaybackClock {
  constructor() {
    this.ready = false;
    this.position = 0;
    this.at = 0;
    this.rate = 0;
    this.playing = false;
    this.correction = 0;
    this.correctionDuration = 0;
    this.identity = '';
  }

  read(now) {
    const elapsed = Math.max(0, (now - this.at) / 1000);
    const progress = this.correctionDuration > 0
      ? Math.min(1, elapsed / this.correctionDuration) : 1;
    return Math.max(0, this.position + elapsed * this.rate + this.correction * progress);
  }

  update(snapshot, now) {
    const identity = JSON.stringify([snapshot.title, snapshot.artist, snapshot.album, snapshot.source]);
    const playing = snapshot.playing === true;
    // A zero rate can be left over from the paused metadata packet. The play
    // notification starts the clock immediately; a positive rate refines it.
    const rate = playing ? snapshot.playbackRate > 0 ? snapshot.playbackRate : 1 : 0;
    const position = Math.max(0, snapshot.positionSeconds);
    const previous = this.read(now);
    const error = position - previous;
    const reset = !this.ready || identity !== this.identity || !playing || !this.playing || Math.abs(error) > 1;
    this.position = reset ? position : previous;
    this.at = now;
    this.rate = rate;
    this.playing = playing;
    this.identity = identity;
    this.ready = true;
    this.correction = reset ? 0 : error;
    // Small source corrections change clock speed continuously. Limit them
    // to half the playback rate so a late sample never freezes or reverses
    // the karaoke fill. Larger jumps remain immediate seeks.
    this.correctionDuration = reset ? 0 : Math.max(0.2, Math.abs(error) * 2 / rate);
  }

  seek(position, now) {
    this.position = Math.max(0, position);
    this.at = now;
    this.correction = 0;
    this.correctionDuration = 0;
  }
}
