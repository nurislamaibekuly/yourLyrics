import { ProgressiveBlur } from '../vendor/progressive-blur/progressive-blur.js';

export function createArtworkBlur(video, motion, onPresented = () => {}) {
  const composition = document.createElement('div');
  composition.className = 'animated-artwork-composition';
  composition.setAttribute('aria-hidden', 'true');
  const canvas = document.createElement('canvas');
  canvas.className = 'artwork artwork-blur';
  canvas.setAttribute('aria-hidden', 'true');
  // Widescreen extended art composites into a separate 2D canvas: the blurred
  // side strips render offscreen and the sharp cover is drawn back on top,
  // which a single WebGL target cannot do.
  const wideCanvas = document.createElement('canvas');
  wideCanvas.className = 'artwork-blur-wide';
  wideCanvas.setAttribute('aria-hidden', 'true');
  const wideContext = wideCanvas.getContext('2d');
  const shade = document.createElement('div');
  shade.className = 'artwork-shade';
  shade.setAttribute('aria-hidden', 'true');
  composition.append(canvas, wideCanvas, shade);
  video.after(composition);
  const source = document.createElement('canvas');
  const context = source.getContext('2d');
  const wideBlurCanvas = document.createElement('canvas');
  let blur = null;
  let wideBlur = null;
  let frame = 0;
  let lastFrameKey = '';
  let decodedFrame = 0;
  let videoFrameCallback = null;
  function onVideoFrame() {
    decodedFrame += 1;
    videoFrameCallback = video.requestVideoFrameCallback(onVideoFrame);
    schedulePaint();
  }
  if (video.requestVideoFrameCallback) {
    videoFrameCallback = video.requestVideoFrameCallback(onVideoFrame);
  }
  let failedSource = null;
  let revealAnimation = null;
  let morph = null;
  let rememberedTrack = '';
  let cachedSnapshot = null;
  let presentation = 0;
  const duration = 500;
  // Match createIosMetadataTransition's 500ms duration so both expanding and
  // collapsing covers land in lockstep with the metadata row and menu button.
  const collapseDuration = 500;
  const easing = 'cubic-bezier(0.32, 0.72, 0, 1)';

  function sampleCubicBezier(x1, y1, x2, y2, x) {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let u = x;
    for (let i = 0; i < 5; i += 1) {
      const inv = 1 - u;
      const bx = 3 * inv * inv * u * x1 + 3 * inv * u * u * x2 + u * u * u - x;
      const dbx = 3 * inv * inv * x1 + 6 * inv * u * (x2 - x1) + 3 * u * u * (1 - x2);
      if (Math.abs(dbx) < 1e-6) break;
      u = Math.min(1, Math.max(0, u - bx / dbx));
    }
    const inv = 1 - u;
    return 3 * inv * inv * u * y1 + 3 * inv * u * u * y2 + u * u * u;
  }

  function cancelReveal() {
    presentation += 1;
    revealAnimation?.cancel();
    revealAnimation = null;
  }

  function clearMorph() {
    if (morph) {
      morph.geometry?.cancel();
      morph.blend?.cancel();
      morph.layer.remove();
      morph = null;
    }
    document.body.classList.remove('is-artwork-morphing');
  }

  function viewportRect() {
    const parent = video.closest('.player-column');
    return parent ? parent.getBoundingClientRect() : { left: 0, top: 0, width: innerWidth, height: innerHeight };
  }

  // The extended surface is clipped to the window's rounded corners, so the
  // morph must start and end on that same radius. body::before paints
  // --window-radius, which keeps this correct for the iOS proportional value,
  // the desktop default and the flush 0px state without duplicating the calc.
  function windowRadius() {
    return getComputedStyle(document.body, '::before').borderRadius || '0px';
  }

  function animateGeometry(state, target, radius, shadow = 'none', animDuration = duration) {
    const start = state.layer.getBoundingClientRect();
    const parent = viewportRect();
    const startLeft = start.left - parent.left;
    const startTop = start.top - parent.top;
    const endLeft = target.left - parent.left;
    const endTop = target.top - parent.top;
    const startRadius = getComputedStyle(state.layer).borderRadius;
    const startShadow = getComputedStyle(state.layer).boxShadow;
    state.geometry?.cancel();
    Object.assign(state.layer.style, {
      left: `${startLeft}px`, top: `${startTop}px`,
      width: `${start.width}px`, height: `${start.height}px`,
      borderRadius: startRadius, boxShadow: startShadow
    });
    // Interpolate the box center (cx, cy) on separate X/Y Bezier curves so both
    // collapse and expansion of extended artwork sweep along a true curved arc
    // instead of having width/height scaling pull the center into a straight line.
    if (state.mode === 'closing' || state.mode === 'opening') {
      const startR = parseFloat(startRadius) || 0;
      const endR = parseFloat(radius) || 0;
      const startCx = startLeft + start.width / 2;
      const startCy = startTop + start.height / 2;
      const endCx = endLeft + target.width / 2;
      const endCy = endTop + target.height / 2;
      const steps = 24;
      const keyframes = [];
      const closing = state.mode === 'closing';
      for (let i = 0; i <= steps; i += 1) {
        const t = i / steps;
        const pX = closing ? sampleCubicBezier(0.2, 0.94, 0.28, 1, t) : sampleCubicBezier(0.38, 0.78, 0.22, 1, t);
        const pY = closing ? sampleCubicBezier(0.38, 0.78, 0.22, 1, t) : sampleCubicBezier(0.2, 0.94, 0.28, 1, t);
        const pSize = sampleCubicBezier(0.28, 0.88, 0.24, 1, t);
        const w = start.width + (target.width - start.width) * pSize;
        const h = start.height + (target.height - start.height) * pSize;
        const cx = startCx + (endCx - startCx) * pX;
        const cy = startCy + (endCy - startCy) * pY;
        keyframes.push({
          left: `${cx - w / 2}px`,
          top: `${cy - h / 2}px`,
          width: `${w}px`,
          height: `${h}px`,
          borderRadius: `${startR + (endR - startR) * pSize}px`,
          boxShadow: i === 0 ? startShadow : shadow
        });
      }
      state.geometry = state.layer.animate(keyframes, {
        duration: animDuration, easing: 'linear', fill: 'forwards'
      });
      return;
    }
    state.geometry = state.layer.animate([{
      left: `${startLeft}px`, top: `${startTop}px`,
      width: `${start.width}px`, height: `${start.height}px`,
      borderRadius: startRadius, boxShadow: startShadow
    }, {
      left: `${endLeft}px`, top: `${endTop}px`,
      width: `${target.width}px`, height: `${target.height}px`,
      borderRadius: radius, boxShadow: shadow
    }], { duration: animDuration, easing, fill: 'forwards' });
  }

  function createMorph(image, start, mode, key) {
    const parent = viewportRect();
    const layer = document.createElement('div');
    layer.className = 'artwork-transition';
    layer.classList.toggle('is-wide-art', isWideArt());
    layer.setAttribute('aria-hidden', 'true');
    Object.assign(layer.style, { left: `${start.left - parent.left}px`, top: `${start.top - parent.top}px`,
      width: `${start.width}px`, height: `${start.height}px`,
      borderRadius: mode === 'opening' ? getComputedStyle(image).borderRadius : windowRadius(),
      boxShadow: mode === 'opening' ? getComputedStyle(image).boxShadow : 'none' });
    const cover = document.createElement('img');
    cover.src = image.currentSrc || image.src;
    cover.alt = '';
    const art = document.createElement('div');
    art.className = 'artwork-transition-motion';
    art.style.opacity = mode === 'opening' ? '0' : '1';
    const snapshot = document.createElement('canvas');
    const tint = document.createElement('div');
    tint.className = 'artwork-transition-shade';
    tint.style.backgroundImage = getComputedStyle(shade).backgroundImage;
    tint.style.visibility = getComputedStyle(shade).visibility;
    art.append(snapshot, tint);
    layer.append(cover, art);
    composition.after(layer);
    document.body.classList.add('is-artwork-morphing');
    morph = { layer, cover, art, snapshot, tint, mode, key, ready: false, geometry: null, blend: null };
    return morph;
  }

  // The two extended modes are mutually exclusive classes, but tests stub
  // classList.contains to true for everything; requiring the tall class to be
  // absent keeps the wide branch from hijacking those fixtures.
  function isWideArt() {
    return document.body.classList.contains('is-wide-animated-art') &&
      !document.body.classList.contains('is-tall-animated-art');
  }

  function activeSurface() {
    return isWideArt() ? wideCanvas : canvas;
  }

  function copyArtwork(state) {
    const surface = activeSurface();
    if (!surface.classList.contains('is-ready') || !surface.width) return;
    state.tint.style.backgroundImage = getComputedStyle(shade).backgroundImage;
    state.tint.style.visibility = getComputedStyle(shade).visibility;
    const height = Math.max(1, Math.round(surface.width * composition.clientHeight / composition.clientWidth));
    if (state.snapshot.width !== surface.width) state.snapshot.width = surface.width;
    if (state.snapshot.height !== height) state.snapshot.height = height;
    const context = state.snapshot.getContext('2d');
    context.clearRect(0, 0, state.snapshot.width, state.snapshot.height);
    context.drawImage(surface, 0, 0);
  }

  function blendArtwork(state, opacity, blendDuration, delay = 0) {
    const start = getComputedStyle(state.art).opacity;
    state.blend?.cancel();
    state.art.style.opacity = start;
    state.blend = state.art.animate([{ opacity: start }, { opacity }], {
      duration: blendDuration, delay, easing: 'ease', fill: 'forwards'
    });
  }

  function finishOpening(state) {
    Promise.all([state.geometry.finished, state.blend.finished]).then(() => {
      if (morph !== state || state.mode !== 'opening') return;
      onPresented();
      clearMorph();
    }).catch(() => {});
  }

  function beginExpansion(image, key) {
    if (!key || key !== rememberedTrack || motion.matches || document.body.dataset.uiStyle !== 'ios') return;
    if (morph?.mode === 'opening' && morph.key === key) return;
    let state = morph;
    if (state && state.key === key) {
      state.mode = 'opening';
      state.ready = false;
      const opacity = getComputedStyle(state.art).opacity;
      state.blend?.cancel();
      state.art.style.opacity = opacity;
    } else {
      clearMorph();
      state = createMorph(image, image.getBoundingClientRect(), 'opening', key);
      if (cachedSnapshot && cachedSnapshot.key === key && cachedSnapshot.wide === isWideArt()) {
        state.tint.style.backgroundImage = cachedSnapshot.shadeImage;
        state.tint.style.visibility = cachedSnapshot.shadeVisibility;
        state.snapshot.width = cachedSnapshot.canvas.width;
        state.snapshot.height = cachedSnapshot.canvas.height;
        state.snapshot.getContext('2d').drawImage(cachedSnapshot.canvas, 0, 0);
        state.ready = true;
        blendArtwork(state, 1, 260, 140);
      }
    }
    animateGeometry(state, viewportRect(), windowRadius());
    // Hold the growing static cover until a decoded animated frame is ready.
    // Network latency must not uncover an empty full-window surface.
  }

  function collapseToStatic(image) {
    if (!image || motion.matches || document.body.dataset.uiStyle !== 'ios') { clearMorph(); return; }
    let state = morph;
    if (!state) {
      if (!activeSurface().classList.contains('is-ready')) return;
      state = createMorph(image, composition.getBoundingClientRect(), 'closing', rememberedTrack);
      copyArtwork(state);
    }
    if (rememberedTrack && state.snapshot.width && state.snapshot.height) {
      const cacheCanvas = document.createElement('canvas');
      cacheCanvas.width = state.snapshot.width;
      cacheCanvas.height = state.snapshot.height;
      cacheCanvas.getContext('2d').drawImage(state.snapshot, 0, 0);
      cachedSnapshot = {
        key: rememberedTrack,
        wide: isWideArt(),
        canvas: cacheCanvas,
        shadeImage: state.tint.style.backgroundImage,
        shadeVisibility: state.tint.style.visibility
      };
    }
    state.mode = 'closing';
    const imageStyle = getComputedStyle(image);
    animateGeometry(state, image.getBoundingClientRect(), imageStyle.borderRadius, imageStyle.boxShadow, collapseDuration);
    // Fade extended artwork out during the first half of the collapse spring
    // so the static square cover is opaque as it lands into the header.
    blendArtwork(state, 0, Math.round(collapseDuration * 0.45), 0);
    Promise.all([state.geometry.finished, state.blend.finished]).then(() => {
      if (morph === state && state.mode === 'closing') clearMorph();
    }).catch(() => {});
  }

  function reveal() {
    cancelReveal();
    composition.classList.add('is-ready');
    if (morph?.mode === 'opening') {
      const state = morph;
      state.ready = true;
      copyArtwork(state);
      blendArtwork(state, 1, 280);
      finishOpening(state);
      return;
    }
    const token = presentation;
    if (motion.matches) { onPresented(); return; }
    revealAnimation = composition.animate([{ opacity: 0 }, { opacity: 1 }], {
      duration: 320, easing: 'ease'
    });
    revealAnimation.finished.then(() => {
      if (presentation !== token) return;
      revealAnimation = null;
      onPresented();
    }).catch(() => {});
  }

  function isEnabled() {
    const wideArt = isWideArt();
    const extended = wideArt || document.body.classList.contains('is-tall-animated-art');
    return document.body.dataset.uiStyle === 'ios' && extended &&
      !motion.matches && video.classList.contains('is-visible') &&
      (wideArt || video.videoHeight > video.videoWidth);
  }

  function schedulePaint() {
    if (frame || document.hidden || !isEnabled()) return;
    frame = requestAnimationFrame(paint);
  }

  const cancelTransitions = () => {
    cancelReveal();
    clearMorph();
    schedulePaint();
  };
  window.addEventListener('resize', cancelTransitions);
  motion.addEventListener?.('change', cancelTransitions);
  document.addEventListener('visibilitychange', schedulePaint);
  video.addEventListener('play', schedulePaint);
  video.addEventListener('loadeddata', schedulePaint);
  video.addEventListener('seeked', schedulePaint);
  const stateObserver = typeof MutationObserver === 'function'
    ? new MutationObserver(schedulePaint)
    : null;
  stateObserver?.observe(document.body, { attributes: true, attributeFilter: ['data-ui-style', 'class'] });
  stateObserver?.observe(video, { attributes: true, attributeFilter: ['class', 'src'] });

  function paint() {
    frame = 0;
    if (document.hidden) return;
    const wideArt = isWideArt();
    const enabled = isEnabled();
    const media = video;
    const identity = media.currentSrc || media.src;
    if (!enabled || !context) {
      lastFrameKey = '';
      canvas.classList.remove('is-ready');
      wideCanvas.classList.remove('is-ready');
      return;
    }
    const width = media.videoWidth || media.naturalWidth;
    const height = media.videoHeight || media.naturalHeight;
    if (!width || !height || !composition.clientWidth || !composition.clientHeight) {
      schedulePaint();
      return;
    }
    try {
      const frameId = video.requestVideoFrameCallback ? decodedFrame : media.currentTime;
      let frameKey = '';
      if (wideArt) {
        // The square cover keeps the full window height and centres itself.
        // Each side is a clone of the cover stretched horizontally and
        // hanging offscreen — both mirrored, the left one reflecting the
        // leading edge and the right one the trailing edge — so the strips
        // sample the artwork at near-native scale instead of squishing the
        // whole frame into a sliver.
        const compW = composition.clientWidth;
        const compH = composition.clientHeight;
        const scale = Math.min(2, globalThis.devicePixelRatio || 1, 2048 / Math.max(compW, compH));
        const outW = Math.max(1, Math.round(compW * scale));
        const outH = Math.max(1, Math.round(compH * scale));
        frameKey = [identity, frameId, 'wide', outW, outH].join(':');
        if (frameKey === lastFrameKey) {
          if (!video.requestVideoFrameCallback && !media.paused) schedulePaint();
          return;
        }
        if (wideCanvas.width !== outW) wideCanvas.width = outW;
        if (wideCanvas.height !== outH) wideCanvas.height = outH;
        wideBlur ||= new ProgressiveBlur(wideBlurCanvas);
        const side = Math.min(compW, compH);
        const gap = (compW - side) / 2;
        let sx = 0, sy = 0, sw = width, sh = height;
        if (width > height) { sw = height; sx = (width - sw) / 2; }
        else if (height > width) { sh = width; sy = (height - sh) / 2; }
        wideContext.clearRect(0, 0, outW, outH);
        // Each window half gets the same treatment as the tall composition:
        // one source canvas holding the mirrored clone and its half of the
        // artwork, run through a single directional blur whose ramp keeps the
        // artwork side sharp and softens toward the window edge.
        const stripScale = scale * 0.8;
        const halfW = Math.ceil(compW / 2);
        const halfWp = Math.max(1, Math.round(halfW * stripScale));
        const halfHp = Math.max(1, Math.round(outH * 0.5));
        if (source.width !== halfWp) source.width = halfWp;
        if (source.height !== halfHp) source.height = halfHp;
        // The clone is cloneStretch times wider than the cover, so the
        // visible gap only shows gap/(stretch*side) of its columns.
        const cloneStretch = 1.5;
        const sliceW = Math.max(1, Math.min(sw, sw * gap / (side * cloneStretch)));
        // The clone strip is gap px of each half, so the artwork's edge sits
        // at 1 - gap/halfW along the blur direction on both sides. Anchoring
        // rampStart there keeps the artwork perfectly sharp and lets the
        // blur build across exactly the clone's visible span.
        const stripOptions = { radius: halfWp * 0.15, minRadius: 0,
          rampStart: 0.5 - gap / halfW, rampEnd: 1.5,
          directionY: 0, transparentBorder: false };
        // Left half: mirrored leading-edge clone, then the artwork's left half.
        if (gap > 0.5) {
          context.save();
          context.translate(gap * stripScale, 0);
          context.scale(-1, 1);
          context.drawImage(media, sx, sy, sliceW, sh, 0, 0, gap * stripScale, halfHp);
          context.restore();
        }
        context.drawImage(media, sx, sy, sw * (halfW - gap) / side, sh,
          gap * stripScale, 0, (halfW - gap) * stripScale, halfHp);
        wideBlur.render(source, { ...stripOptions, directionX: -1 });
        wideContext.drawImage(wideBlurCanvas, 0, 0, halfWp, halfHp, 0, 0, halfW * scale, outH);
        // Right half: the artwork's right half, then the mirrored
        // trailing-edge clone out to the window edge.
        context.clearRect(0, 0, halfWp, halfHp);
        const artEnd = gap + side - compW / 2;
        const a0 = (compW / 2 - gap) / side;
        context.drawImage(media, sx + sw * a0, sy, sw * (1 - a0), sh,
          0, 0, artEnd * stripScale, halfHp);
        if (gap > 0.5) {
          context.save();
          // Flipping about the strip's own span needs translate(2*dx + dw):
          // translate(dx + dw) only lands correctly when dx is zero.
          context.translate((artEnd * 2 + gap) * stripScale, 0);
          context.scale(-1, 1);
          context.drawImage(media, sx + sw - sliceW, sy, sliceW, sh,
            artEnd * stripScale, 0, gap * stripScale, halfHp);
          context.restore();
        }
        wideBlur.render(source, { ...stripOptions, directionX: 1 });
        wideContext.drawImage(wideBlurCanvas, 0, 0, halfWp, halfHp,
          outW - halfW * scale, 0, halfW * scale, outH);
      } else {
        const pixelRatio = Math.min(2, globalThis.devicePixelRatio || 1);
        const renderWidth = Math.min(width, 1024, Math.round(composition.clientWidth * pixelRatio));
        frameKey = [identity, frameId, renderWidth, composition.clientHeight, composition.clientWidth].join(':');
        if (frameKey === lastFrameKey) {
          if (!video.requestVideoFrameCallback && !media.paused) schedulePaint();
          return;
        }
        blur ||= new ProgressiveBlur(canvas);
        // The reflected clone retains its configured tall stretch, even when
        // most of it lies below the window. Blur the complete shared source first;
        // only the wrapper clips the result to the visible window afterwards.
        if (source.width !== renderWidth) source.width = renderWidth;
        const viewportHeight = source.width * composition.clientHeight / composition.clientWidth;
        const artworkHeight = source.width * height / width;
        const extensionHeight = artworkHeight * 1.5;
        const renderHeight = Math.ceil(Math.max(viewportHeight, artworkHeight + extensionHeight));
        if (source.height !== renderHeight) source.height = renderHeight;
        const cssHeight = `${source.height * composition.clientWidth / source.width}px`;
        if (canvas.style.height !== cssHeight) canvas.style.height = cssHeight;
        context.clearRect(0, 0, source.width, source.height);
        context.drawImage(media, 0, 0, source.width, artworkHeight);
        context.save();
        context.translate(0, artworkHeight + extensionHeight);
        context.scale(1, -1);
        context.drawImage(media, 0, 0, source.width, extensionHeight);
        context.restore();

        // Portrait blur uses a 2D curved arch mask: sharp across the upper half
        // of the portrait viewport (~0..48%), curving upward at the left/right
        // edges (~41%) and feathering smoothly into full blur by ~80% with
        // quadratic radius growth and Gaussian-weighted sampling.
        const rampStart = Math.min(1, Math.min(viewportHeight * 0.48, artworkHeight * 0.90) / source.height);
        const rampEnd = Math.max(rampStart, Math.min(1, (viewportHeight * 0.80) / source.height));
        blur.render(source, {
          radius: source.width * 280 / 393,
          minRadius: 0,
          rampStart,
          rampEnd,
          archLift: 0.22,
          directionX: 0,
          directionY: 1,
          transparentBorder: false,
          viewportHeight
        });
      }
      lastFrameKey = frameKey;
      const surface = wideArt ? wideCanvas : canvas;
      const firstPresentation = !surface.classList.contains('is-ready');
      surface.classList.add('is-ready');
      if (firstPresentation) reveal();
      else if (morph?.mode === 'opening' && morph.ready) copyArtwork(morph);
      if (!video.requestVideoFrameCallback && !media.paused) schedulePaint();
    } catch (error) {
      console.warn(`[artwork-blur] ${error.message}`);
      cancelTransitions();
      composition.classList.remove('is-ready');
      document.body.classList.remove('is-tall-animated-art');
      document.body.classList.remove('is-wide-animated-art');
      // CORS restrictions or unavailable WebGL must leave ordinary artwork visible.
      failedSource = identity;
      canvas.classList.remove('is-ready');
      wideCanvas.classList.remove('is-ready');
    }
  }
  schedulePaint();
  return {
    rememberTrack(key) {
      if (key !== rememberedTrack) cachedSnapshot = null;
      rememberedTrack = key;
    },
    beginExpansion(image, key) {
      beginExpansion(image, key);
      schedulePaint();
    },
    cancelExpansion() { if (morph?.mode === 'opening') clearMorph(); },
    reset({ morphToStatic = false, staticImage, preserveExpansion } = {}) {
      if (morphToStatic) collapseToStatic(staticImage);
      else if (!(morph?.mode === 'opening' && morph.key === preserveExpansion)) clearMorph();
      cancelReveal();
      composition.classList.remove('is-ready');
      document.body.classList.remove('is-tall-animated-art');
      document.body.classList.remove('is-wide-animated-art');
      document.body.style.removeProperty('--ios-animated-art-ratio');
      canvas.classList.remove('is-ready');
      wideCanvas.classList.remove('is-ready');
      failedSource = null;
      lastFrameKey = '';
      schedulePaint();
    },
    dispose() {
      cancelTransitions();
      window.removeEventListener('resize', cancelTransitions);
      motion.removeEventListener?.('change', cancelTransitions);
      document.removeEventListener('visibilitychange', schedulePaint);
      video.removeEventListener('play', schedulePaint);
      video.removeEventListener('loadeddata', schedulePaint);
      video.removeEventListener('seeked', schedulePaint);
      stateObserver?.disconnect();
      cancelAnimationFrame(frame);
      frame = 0;
      if (videoFrameCallback !== null) video.cancelVideoFrameCallback(videoFrameCallback);
      blur?.dispose();
      wideBlur?.dispose();
      composition.remove();
    }
  };
}
