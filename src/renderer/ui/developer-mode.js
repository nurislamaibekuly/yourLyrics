const storageKey = 'yourlyrics:developer';
const visibilityAnimations = new WeakMap();

export function setDeveloperVisibility(element, visible, animate = true) {
  const previous = visibilityAnimations.get(element);
  if (!previous && element.hidden === !visible) return;
  const from = previous && !element.hidden ? (() => {
    const style = getComputedStyle(element);
    return { opacity: style.opacity, filter: style.filter, transform: style.transform };
  })() : null;
  previous?.cancel();
  visibilityAnimations.delete(element);
  element.inert = !visible;
  if (!animate || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    element.hidden = !visible;
    return;
  }
  element.hidden = false;
  const expanded = { opacity: 0, filter: 'blur(12px)', transform: 'scale(1.2)' };
  const resting = { opacity: 1, filter: 'blur(0px)', transform: 'scale(1)' };
  const animation = element.animate(
    [from || (visible ? expanded : resting), visible ? resting : expanded],
    { duration: 700, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', fill: 'both' }
  );
  visibilityAnimations.set(element, animation);
  animation.finished.then(() => {
    if (visibilityAnimations.get(element) !== animation) return;
    element.hidden = !visible;
    visibilityAnimations.delete(element);
    animation.cancel();
  }).catch(() => {}); // Reversing a transition cancels its previous completion.
}

const defaults = {
  enabled: false, showFps: false, showDiagnostics: false,
  showClock: false, showLyrics: false, showBounds: false,
  refreshMs: 500, corner: 'top-right'
};
const corners = ['top-right', 'top-left', 'bottom-right', 'bottom-left'];
const refreshRates = [100, 250, 500, 1000];

export function createDeveloperMode({ storage, overlay, details = () => [], snapshot = () => ({}),
  onChange = () => {}, onTraceComplete = () => {},
  setVisibility = (element, visible) => { element.hidden = !visible; } }) {
  let saved;
  try { saved = JSON.parse(storage.getItem(storageKey) || 'null'); } catch { /* Session-only settings. */ }
  const state = { ...defaults };
  for (const key of Object.keys(defaults)) {
    if (typeof defaults[key] === 'boolean') state[key] = saved?.[key] === true;
  }
  if (refreshRates.includes(saved?.refreshMs)) state.refreshMs = saved.refreshMs;
  if (corners.includes(saved?.corner)) state.corner = saved.corner;
  let presses = 0;
  let start = null;
  let previous = null;
  let lastRefresh = -Infinity;
  let frames = 0;
  let longestFrame = 0;
  let slowFrames = 0;
  let totalFrames = 0;
  let totalSlowFrames = 0;
  let sessionLongest = 0;
  let intervals = [];
  let frozen = false;
  let trace = null;
  let recording = false;
  let performanceSample = { fps: 0, averageMs: 0, p95Ms: 0, longestMs: 0, slowFrames: 0 };

  const visible = () => state.enabled && (state.showFps || state.showDiagnostics || state.showClock || state.showLyrics);
  const needsUpdates = () => state.enabled && (recording || visible());
  const round = value => Number.isFinite(value) ? Number(value.toFixed(3)) : null;
  function resetSample() {
    start = previous = null;
    frames = slowFrames = longestFrame = 0;
  }
  function sync(animate = true) {
    if (visible() && !frozen) overlay.textContent = 'Measuring…';
    setVisibility(overlay, visible(), animate);
    lastRefresh = -Infinity;
    resetSample();
    try { storage.setItem(storageKey, JSON.stringify(state)); } catch { /* Session-only settings. */ }
    onChange({ ...state }, { frozen, recording, needsUpdates: needsUpdates() });
  }
  function samplePerformance(now) {
    const duration = start === null ? 0 : now - start;
    const sorted = [...intervals].sort((a, b) => a - b);
    if (frames === 0) previous = null;
    performanceSample = {
      fps: duration > 0 ? Math.round(frames * 1000 / duration) : 0,
      averageMs: frames > 0 ? round(duration / frames) : 0,
      p95Ms: sorted.length ? round(sorted[Math.ceil(sorted.length * .95) - 1]) : 0,
      longestMs: round(longestFrame), slowFrames
    };
    start = now;
    frames = slowFrames = longestFrame = 0;
  }
  function finishTrace(cancelled = false) {
    if (!recording) return;
    recording = false;
    trace.cancelled = cancelled;
    if (!cancelled) onTraceComplete(trace.samples.length);
    onChange({ ...state }, { frozen, recording, needsUpdates: needsUpdates() });
  }
  function refresh(now) {
    if (!state.enabled) return;
    if (start !== null && now - start >= state.refreshMs) samplePerformance(now);
    const hidden = typeof document !== 'undefined' && document.hidden;
    const traceDue = recording && (now - trace.lastAt >= 100 || now - trace.startAt >= 10000);
    const overlayDue = visible() && !frozen && !hidden && now - lastRefresh >= state.refreshMs;
    if (!traceDue && !overlayDue) return;
    const current = traceDue || state.showClock || state.showLyrics ? snapshot(now) : null;
    if (traceDue) {
      // Keep an explicit elapsed timestamp instead of inventing missing samples
      // when the window is hidden or the renderer misses a frame.
      trace.samples.push({ elapsedMs: round(now - trace.startAt), ...current });
      trace.lastAt = now;
      if (now - trace.startAt >= 10000 || trace.samples.length >= 101) finishTrace();
    }
    if (!overlayDue) return;
    const lines = [];
    if (state.showFps) {
      const sample = performanceSample;
      lines.push(`${sample.fps} FPS · ${sample.averageMs.toFixed(1)} ms/frame · p95 ${sample.p95Ms.toFixed(1)} ms`);
    }
    if (state.showDiagnostics) {
      lines.push(`Longest frame ${performanceSample.longestMs.toFixed(1)} ms · Slow frames (>50 ms) ${performanceSample.slowFrames}`);
      lines.push(...details());
    }
    if (state.showClock && current?.playback) {
      const clock = current.playback;
      lines.push('— Playback clock —',
        `Source ${clock.sourceSeconds.toFixed(3)} s · Renderer ${clock.rendererSeconds.toFixed(3)} s`,
        `Lyrics ${clock.lyricSeconds.toFixed(3)} s · Offset ${clock.offsetMs} ms`,
        `Rate ${clock.rate.toFixed(3)} · Anchor age ${Math.round(clock.anchorAgeMs)} ms`,
        `Correction ${clock.correctionMs.toFixed(1)} ms · Transport ${clock.pendingTransport ? 'pending' : 'confirmed'}`);
    }
    if (state.showLyrics && current?.lyrics) {
      const lyrics = current.lyrics;
      lines.push('— Lyric inspector —', `Anchor ${lyrics.anchorIndex + 1} · Active ${lyrics.activeIndices.map(i => i + 1).join(', ') || 'none'} · ${lyrics.lineCount} lines`);
      for (const line of lyrics.lines) {
        lines.push(`Line ${line.index + 1}: word ${line.wordIndex < 0 ? '—' : line.wordIndex + 1}/${line.wordCount} · ${line.visualRows} visual ${line.visualRows === 1 ? 'row' : 'rows'}`,
          `Fill ${line.accelerationProgress === null ? 'word timing' : `accelerating ${Math.round(line.accelerationProgress * 100)}%`} · Y ${line.y.toFixed(1)} → ${line.targetY.toFixed(1)}`,
          `Delay ${Math.round(line.delayMs)} ms · Blur ${line.blur.toFixed(2)} px · Alpha ${line.opacity.toFixed(3)}`);
      }
    }
    if (recording) lines.push(`Recording timing trace · ${trace.samples.length} samples`);
    overlay.textContent = lines.join('\n');
    lastRefresh = now;
  }
  sync(false);

  return {
    get state() { return { ...state }; },
    get frozen() { return frozen; },
    get recording() { return recording; },
    get needsUpdates() { return needsUpdates(); },
    resetPresses() { presses = 0; },
    pressVersion() {
      if (++presses < 8) return false;
      presses = 0;
      state.enabled = !state.enabled;
      if (!state.enabled) { frozen = false; finishTrace(true); }
      sync();
      return true;
    },
    setOption(name, value) {
      if (!Object.hasOwn(defaults, name) || name === 'enabled') return;
      if (name === 'refreshMs') {
        if (!refreshRates.includes(value)) return;
      } else if (name === 'corner') {
        if (!corners.includes(value)) return;
      } else if (typeof value !== 'boolean') return;
      state[name] = value;
      sync();
    },
    setFrozen(value) { frozen = value === true; sync(false); },
    resetStats() {
      resetSample();
      intervals = [];
      totalFrames = totalSlowFrames = sessionLongest = 0;
      performanceSample = { fps: 0, averageMs: 0, p95Ms: 0, longestMs: 0, slowFrames: 0 };
      lastRefresh = -Infinity;
    },
    resetPreferences() {
      Object.assign(state, defaults, { enabled: state.enabled });
      frozen = false;
      sync();
    },
    disable() { state.enabled = false; frozen = false; finishTrace(true); sync(); },
    startTrace(now) {
      if (!state.enabled || recording) return false;
      trace = { startAt: now, lastAt: now, startedAt: new Date().toISOString(), cancelled: false,
        samples: [{ elapsedMs: 0, ...snapshot(now) }] };
      recording = true;
      resetSample();
      onChange({ ...state }, { frozen, recording, needsUpdates: needsUpdates() });
      return true;
    },
    stopTrace() { finishTrace(); },
    report(now) {
      return { schemaVersion: 1, capturedAt: new Date().toISOString(), preferences: { ...state },
        frozen, performance: { ...performanceSample, totalFrames, totalSlowFrames, sessionLongestMs: round(sessionLongest) },
        current: state.enabled ? snapshot(now) : null,
        trace: trace ? { startedAt: trace.startedAt, recording, cancelled: trace.cancelled,
          samples: structuredClone(trace.samples) } : null };
    },
    refresh,
    recordFrame(now) {
      if (!needsUpdates()) return;
      if (start === null || document.hidden) {
        resetSample();
        start = previous = now;
        return;
      }
      if (previous !== null) {
        const delta = Math.max(0, now - previous);
        frames += 1;
        totalFrames += 1;
        if (delta > 50) { slowFrames += 1; totalSlowFrames += 1; }
        longestFrame = Math.max(longestFrame, delta);
        sessionLongest = Math.max(sessionLongest, delta);
        intervals.push(delta);
        if (intervals.length > 120) intervals.shift();
      }
      previous = now;
      // Sampling belongs to the renderer clock, but diagnostics can also be
      // refreshed by a quiet timer while playback is paused.
      if (now - start >= state.refreshMs) refresh(now);
    }
  };
}
