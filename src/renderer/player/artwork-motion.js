// Playback uses a half-second response, critical damping on pause and a 0.6
// damping ratio on resume. The two directions deliberately have different
// trajectories: expansion rebounds briefly, while contraction settles in place.
export class ArtworkPlaybackSpring {
  constructor(value = 1) {
    this.value = value;
    this.velocity = 0;
    this.target = value;
    this.playing = true;
    this.omega = 4 * Math.PI;
    this.decay = this.omega;
  }

  retarget(playing) {
    this.playing = playing;
    this.target = playing ? 1 : 0.73;
    this.decay = this.omega * (playing ? 0.6 : 1);
  }

  jump() {
    this.value = this.target;
    this.velocity = 0;
  }

  step(dt) {
    const displacement = this.value - this.target;
    const envelope = Math.exp(-this.decay * dt);
    if (this.playing) {
      const frequency = this.omega * 0.8;
      const coefficient = (this.velocity + this.decay * displacement) / frequency;
      const cosine = Math.cos(frequency * dt);
      const sine = Math.sin(frequency * dt);
      this.value = this.target + envelope * (displacement * cosine + coefficient * sine);
      this.velocity = envelope * ((coefficient * frequency - this.decay * displacement) * cosine
        - (displacement * frequency + this.decay * coefficient) * sine);
    } else {
      const coefficient = this.velocity + this.omega * displacement;
      this.value = this.target + envelope * (displacement + coefficient * dt);
      this.velocity = envelope * (this.velocity - this.omega * coefficient * dt);
    }
    const acceleration = -(this.omega ** 2) * (this.value - this.target)
      - 2 * this.decay * this.velocity;
    // The resting check uses scale, velocity and acceleration together. Checking
    // position alone would cut off the visible rebound as it crosses full size.
    const resting = Math.abs(this.value - this.target) < 0.01 && (this.playing
      ? Math.abs(this.velocity) < 0.01 && Math.abs(acceleration) < 0.01
      : this.velocity < 0.01 && acceleration < 0.01);
    if (resting) this.jump();
    return !resting;
  }
}

// All cover layers inherit one sample, including an outgoing crossfade clone.
// Geometry and playback clocks remain independent of this visual spring.
export function createArtworkMotion(group, motion) {
  const spring = new ArtworkPlaybackSpring();
  let initialized = false;
  let frame = 0;
  let previous = 0;

  function paint() {
    group.style.setProperty('--artwork-playback-progress', String((spring.value - 0.73) / 0.27));
  }

  function advance(now) {
    const elapsed = Math.max(previous, now);
    const moving = spring.step((elapsed - previous) / 1000);
    previous = elapsed;
    return moving;
  }

  function settle() {
    cancelAnimationFrame(frame);
    frame = 0;
    spring.jump();
    paint();
  }

  function tick(now) {
    frame = 0;
    const moving = advance(now);
    paint();
    if (moving) frame = requestAnimationFrame(tick);
  }

  function playback(playing) {
    if (initialized && playing === spring.playing) return;
    // Sample the old trajectory before changing damping, so a reversal keeps
    // the cover's current velocity rather than restarting from a still frame.
    const now = performance.now();
    if (frame) advance(now);
    spring.retarget(playing);
    if (!initialized || motion.matches) {
      initialized = true;
      settle();
      return;
    }
    previous = now;
    paint();
    if (!frame) frame = requestAnimationFrame(tick);
  }

  motion.addEventListener('change', () => {
    if (motion.matches) settle();
  });
  return { playback };
}
