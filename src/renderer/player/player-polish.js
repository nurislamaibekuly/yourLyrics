import { createArtworkMotion } from './artwork-motion.js';

// Visual transitions never own playback clocks or lyric position springs.
export function createPlayerPolish({ artwork, title, artist, lyrics, motion, onMetadata }) {
  const artworkMotion = createArtworkMotion(artwork.parentElement, motion);
  let metadataKey = '';
  let metadataGeneration = 0;
  let artworkGeneration = 0;
  let metadataAnimations = [];
  let coverAnimations = [];
  let outgoing = null;
  let revealAnimation = null;
  const lyricSurface = lyrics.querySelector('.lyrics-mask') || lyrics;
  let metadataReady = Promise.resolve();
  const timing = { duration: 420, easing: 'cubic-bezier(.22,1,.36,1)' };
  function metadata(nextTitle, nextArtist, animate) {
    const key = JSON.stringify([nextTitle, nextArtist]);
    if (key === metadataKey) return;
    metadataKey = key;
    const id = ++metadataGeneration;
    revealAnimation?.cancel();
    const from = [title, artist].map(label => {
      const style = getComputedStyle(label);
      return { opacity: style.opacity, filter: style.filter };
    });
    metadataAnimations.forEach(animation => animation.cancel()); metadataAnimations = [];
    const commit = () => { title.textContent = nextTitle; artist.textContent = nextArtist; onMetadata(); };
    if (!animate || motion.matches) { commit(); metadataReady = Promise.resolve(); return; }
    metadataAnimations = [title, artist].map((label, index) => label.animate([
      from[index], { opacity: 0, filter: 'blur(7px)' }
    ], { ...timing, duration: 180, fill: 'forwards' }));
    metadataReady = Promise.all(metadataAnimations.map(a => a.finished)).then(() => {
      if (id !== metadataGeneration) return;
      commit();
      metadataAnimations.forEach(a => a.cancel());
      if (motion.matches) { metadataAnimations = []; return; }
      metadataAnimations = [title, artist].map(label => label.animate([
        { opacity: 0, filter: 'blur(7px)' }, { opacity: 1, filter: 'blur(0px)' }
      ], timing));
      return Promise.all(metadataAnimations.map(a => a.finished));
    }).catch(() => {});
  }
  async function cover(source, animate, onLoaded) {
    const id = ++artworkGeneration;
    const image = new Image(); image.src = source;
    try { await image.decode(); } catch { return; }
    if (id !== artworkGeneration) return;
    coverAnimations.forEach(a => a.cancel()); coverAnimations = [];
    outgoing?.remove(); outgoing = null;
    if (animate && !motion.matches && artwork.complete && artwork.naturalWidth) {
      outgoing = artwork.cloneNode(); outgoing.classList.remove('is-covered');
      outgoing.classList.add('artwork-outgoing'); outgoing.alt = ''; outgoing.setAttribute('aria-hidden', 'true');
      artwork.before(outgoing);
    }
    artwork.src = source; onLoaded(image);
    if (outgoing) {
      const old = outgoing;
      coverAnimations = [old.animate([{ opacity: 1 }, { opacity: 0 }], { ...timing, duration: 650, fill: 'forwards' })];
      coverAnimations[0].finished.catch(() => {}).finally(() => { old.remove(); if (outgoing === old) outgoing = null; });
    }
  }
  async function revealLyrics() {
    const id = metadataGeneration;
    revealAnimation?.cancel();
    if (motion.matches) return;
    const hidden = lyricSurface.animate([{ opacity: 0 }, { opacity: 0 }], { duration: 1, fill: 'both' });
    revealAnimation = hidden;
    await metadataReady;
    if (id !== metadataGeneration || motion.matches) { hidden.cancel(); return; }
    hidden.cancel();
    revealAnimation = lyricSurface.animate([{ opacity: 0, filter: 'blur(5px)' }, { opacity: 1, filter: 'blur(0px)' }], timing);
  }
  const resetTilt = () => {
    const group = artwork.parentElement;
    group.style.setProperty('--cover-tilt', '0 1 0 0deg');
  };
  artwork.addEventListener('pointermove', event => {
    if (motion.matches || document.body.dataset.uiStyle !== 'tvos') { resetTilt(); return; }
    const rect = artwork.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width - .5;
    const y = (event.clientY - rect.top) / rect.height - .5;
    const angle = Math.min(2, Math.hypot(x, y) * 3);
    artwork.parentElement.style.setProperty('--cover-tilt', `${-y} ${x || .0001} 0 ${angle}deg`);
  });
  artwork.addEventListener('pointerleave', resetTilt);
  motion.addEventListener('change', () => {
    if (!motion.matches) return;
    metadataAnimations.forEach(a => a.finish()); coverAnimations.forEach(a => a.finish());
    revealAnimation?.cancel(); resetTilt();
  });
  return { metadata, cover, revealLyrics, resetTilt, playback: artworkMotion.playback };
}
