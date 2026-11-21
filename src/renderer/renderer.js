import { createFrostedLabelsRenderer } from './player/frosted-labels.js';
import { createArtworkBlur } from './player/artwork-blur.js';
import Hls from '../../node_modules/hls.js/dist/hls.mjs';
import { createMetadataMarquee } from './player/metadata-marquee.js';
import { createIosMetadataTransition } from './player/ios-metadata.js';
import MeshBackdrop from './vendor/amlbg/amlbg.js';
import { Backdrop as ClassicBackdrop } from './vendor/tsl-backdrop/backdrop.js';
import { createPlayerPolish } from './player/player-polish.js';
import { readStylePreferences } from './player/style-preferences.js';
import { LyricsView, parseLyrics } from './lyrics/index.js';
import { generateShareLyricsCard } from './lyrics/share-image.js';
import { PlaybackClock } from './player/playback-clock.js';
import { createPlaybackControls } from './player/playback-controls.js';
import { createDeveloperMode, setDeveloperVisibility } from './ui/developer-mode.js';
import { createUiStyleSwitcher, normalizeUiStyle, uiStyleLayout, uiStyleOptions } from './player/ui-style.js';
import { createTvosControlsAutoHide } from './player/tvos-controls.js';
import { MenuView } from './ui/menuview.js';
import { SheetView } from './ui/sheetview.js';
import { alert as baseAlert, confirm as baseConfirm, prompt as basePrompt } from './ui/alertview.js';
import { buildUpdateCard as baseBuildUpdateCard, presentUpdate as basePresentUpdate } from './ui/updateview.js';

// The title bar is hidden on every platform so the stylesheet can round the
// window more than the OS mask allows. Windows, Linux and macOS draw macOS-style
// traffic lights with a window pin toggle in the drag strip, with hover-reveal
// and smooth fade out on leave.
function setupWindowControls() {
  const controls = document.querySelector('.window-controls');
  const api = window.app && window.app.window;
  if (!api) {
    return;
  }

  const maximizeButton = controls?.querySelector('[data-window-action="maximize"]');
  const pinButton = controls?.querySelector('[data-window-action="pin"]');

  const syncPinState = pinned => {
    const isPinned = pinned === true;
    document.body.classList.toggle('is-window-pinned', isPinned);
    if (pinButton) {
      pinButton.classList.toggle('is-active', isPinned);
      const label = isPinned ? 'Unpin window' : 'Pin window';
      pinButton.setAttribute('aria-label', label);
      pinButton.title = `${label} (Always on Top)`;
    }
  };

  const syncState = state => {
    const maximized = state?.maximized === true;
    document.body.classList.toggle('is-window-maximized', maximized);
    // Maximized and fullscreen windows sit flush against the screen, so the
    // drawn radius has to go or transparent notches remain in the corners.
    document.body.classList.toggle('is-window-flush', maximized || state?.fullscreen === true);
    document.body.classList.toggle('is-window-fullscreen', state?.fullscreen === true);
    if (maximizeButton) {
      const label = maximized ? 'Restore' : 'Maximize';
      maximizeButton.setAttribute('aria-label', label);
      maximizeButton.title = label;
    }
    if (typeof state?.alwaysOnTop === 'boolean') {
      syncPinState(state.alwaysOnTop);
    }
  };

  if (typeof api.getState === 'function') {
    api.getState().then(syncState).catch(() => { });
  } else if (typeof api.isMaximized === 'function') {
    api.isMaximized().then(maximized => syncState({ maximized })).catch(() => { });
  }
  if (typeof api.isAlwaysOnTop === 'function') {
    api.isAlwaysOnTop().then(syncPinState).catch(() => { });
  }
  if (typeof api.onStateChange === 'function') {
    api.onStateChange(syncState);
  } else if (typeof api.onMaximizedChange === 'function') {
    api.onMaximizedChange(maximized => syncState({ maximized }));
  }
  if (typeof api.onAlwaysOnTopChange === 'function') {
    api.onAlwaysOnTopChange(syncPinState);
  }

  if (!controls) {
    return;
  }
  controls.hidden = false;

  controls.addEventListener('pointerenter', () => controls.classList.add('is-hovered'));
  controls.addEventListener('pointerleave', () => controls.classList.remove('is-hovered'));

  const on = (name, run) => {
    const button = controls.querySelector(`[data-window-action="${name}"]`);
    if (button && typeof run === 'function') {
      button.addEventListener('click', () => run());
    }
  };
  on('close', api.close);
  on('minimize', api.minimize);
  on('maximize', api.toggleMaximize);
  if (pinButton && typeof api.togglePin === 'function') {
    pinButton.addEventListener('click', async () => {
      try {
        const pinned = await api.togglePin();
        syncPinState(pinned);
        persistSettings();
      } catch { }
    });
  }
}

setupWindowControls();

const discordDefaults = {
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
const discordActivityTypeOptions = [
  { value: 2, label: 'Listening' },
  { value: 0, label: 'Playing' },
  { value: 3, label: 'Watching' }
];
const discordStatusNameOptions = [
  { value: 'app', label: 'App name' },
  { value: 'player', label: 'Player app' },
  { value: 'artist', label: 'Artist' },
  { value: 'title', label: 'Song name' },
  { value: 'custom', label: 'Custom' }
];
let discordSettings = { ...discordDefaults };
let discordStatus = { state: 'disabled' };
let discordStatusElement = null;

function readDiscordSettings(saved = {}) {
  const source = saved && typeof saved === 'object' ? saved : {};
  const boolean = (value, fallback) => typeof value === 'boolean' ? value : fallback;
  const displayName = typeof source.displayName === 'string'
    ? source.displayName.replace(/\s+/g, ' ').trim().slice(0, 128)
    : discordDefaults.displayName;
  const displayNameMode = discordStatusNameOptions.some(option =>
    option.value === source.displayNameMode)
    ? source.displayNameMode
    : (displayName ? 'custom' : discordDefaults.displayNameMode);
  const activityType = Number(source.activityType);
  return {
    enabled: source.enabled === true,
    clientId: (typeof source.clientId === 'string'
      ? source.clientId.replace(/\D/g, '').slice(0, 22)
      : '') || discordDefaults.clientId,
    displayNameMode,
    displayName,
    showTitle: boolean(source.showTitle, discordDefaults.showTitle),
    showArtist: boolean(source.showArtist, discordDefaults.showArtist),
    showAlbum: boolean(source.showAlbum, discordDefaults.showAlbum),
    showTimestamps: boolean(source.showTimestamps, discordDefaults.showTimestamps),
    showArtwork: boolean(source.showArtwork, discordDefaults.showArtwork),
    hideWhenPaused: boolean(source.hideWhenPaused, discordDefaults.hideWhenPaused),
    activityType: discordActivityTypeOptions.some(option => option.value === activityType)
      ? activityType : discordDefaults.activityType
  };
}

function discordStatusText() {
  switch (discordStatus.state) {
    case 'connected': return 'Connected';
    case 'connecting': return 'Connecting…';
    case 'unavailable': return 'Discord not running';
    case 'unconfigured': return 'Add an application ID';
    case 'error': return discordStatus.detail || 'Unavailable';
    default: return 'Off';
  }
}

function applyDiscordSettings() {
  if (window.app?.discord) {
    window.app.discord.setSettings(discordSettings).catch(() => { });
  }
}

function setDiscordSettings(patch) {
  discordSettings = readDiscordSettings({ ...discordSettings, ...patch });
  applyDiscordSettings();
  persistSettings();
  return discordSettings;
}

function applyDiscordStatus(next) {
  if (!next || typeof next.state !== 'string') return;
  discordStatus = typeof next.detail === 'string' && next.detail
    ? { state: next.state, detail: next.detail }
    : { state: next.state };
  if (discordStatusElement) discordStatusElement.textContent = discordStatusText();
}

if (window.app?.discord) {
  window.app.discord.getStatus().then(applyDiscordStatus).catch(() => { });
  window.app.discord.onStatus(applyDiscordStatus);
}

const fallbackArtwork = new URL('../../assets/fallback.png', import.meta.url).href;

const backdropCanvas = document.querySelector('.backdrop');
const artworkImage = document.querySelector('.artwork');
const artworkVideo = document.querySelector('.artwork-video');
const titleLabel = document.querySelector('.title');
const artistLabel = document.querySelector('.artist');
const progress = document.querySelector('.progress');
const elapsed = document.querySelector('.time-elapsed');
const remaining = document.querySelector('.time-remaining');
const lyricsElement = document.querySelector('.lyrics');
const noticeElement = document.querySelector('.lyrics-notice');
const lyricsToggle = document.querySelector('.lyrics-toggle');
const metadataMenuToggle = document.querySelector('.metadata-menu');

const idleState = {
  title: 'No song playing',
  artist: '',
  album: '',
  source: '',
  artworkUrl: '',
  positionSeconds: 0,
  durationSeconds: 0,
  playbackRate: 0,
  playing: false,
  controlsAvailable: false
};

let state = { ...idleState };
let position = 0;
const playbackClock = new PlaybackClock();
let pendingTransport = null;
let transportGeneration = 0;
let dragging = false;
let currentArtworkUrl = '';
let animatedArtKey = '';
let artworkHls = null;
let removeArtworkReady = () => {};
let animatedArtGeneration = 0;
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const artworkBlur = createArtworkBlur(artworkVideo, reducedMotion, () => {
  if ((document.body.classList.contains('is-tall-animated-art') ||
    document.body.classList.contains('is-wide-animated-art')) &&
    artworkVideo.classList.contains('is-visible')) artworkImage.classList.add('is-covered');
});
window.addEventListener('beforeunload', () => artworkBlur.dispose());
let backdrop = null;
// amlbg only paints inside its own loop, so a paused backdrop needs an explicit
// frame to keep showing the current track's artwork.
let backdropPlaying = false;
// Loudness, as the four 0..1 lanes main sends: low, mid, high and the overall
// mixture. The analyzer behind them already attacks instantly and releases
// over 0.43 s, so this side feeds them straight through with no
// extra filter — a second exponential filter here only stacks lag and makes the
// pulse trail the music.
let loudnessLevels = { low: 0, mid: 0, high: 0, overall: 0 };
let loudnessGain = 0.25; // matches main's default; overwritten by the first payload
let loudnessGainOwned = false; // user set pulse amount; ignore payload gains after that
let backdropPulse = true; // settings toggle: pause the loudness-driven backdrop
let classicBackdrop = false; // settings toggle: use TSLBackdropMetalView-Web on desktop/landscape layouts
let lineBlur = true; // settings toggle: blur unsung lyrics lines
let lineScale = false; // settings toggle: scale inactive lyrics lines
let fadeCompletedLines = false;
let accelerateFill = true; // Settings toggle: retarget the fill at each word's timing.
let animatedCovers = true; // settings toggle: motion artwork covers
let catalogArtworkFallback = true;
let tapToSeek = true; // settings toggle: tap a lyric line to seek
let bleedArtwork = false; // settings toggle: Immersive artwork, full-column cover with gradient mask (iPhone AM style)
let lyricsFontVh = 5; // settings: lyrics text size in vh units
let lyricsSpacing = 1;
let stylePreferences = readStylePreferences();
let lyricsOffsetMs = 0; // settings: lyrics clock offset against the audio, in ms
let lyricsWeight = 700; // settings: weight the lyric lines render at
let tvosLyricsWeight = 700;
let ipadosLyricsWeight = 700;
let lyricsTextCase = 'original';
let fontFamily = 'sf-pro'; // settings: key into fontFamilies
let theme = 'system'; // settings: 'system' | 'light' | 'dark'
let uiStyle = 'macos';
let uiScale = 1;
let disableSolarium = false;
let solariumDisabledForSession = false;
let metadataMenu = null;
let lyricsToggleGlass = null;
let solariumModule = null;
let solariumModulePromise = null;
let solariumStylesheetPromise = null;
let solariumStylesheetEl = null;
let solariumSyncGeneration = 0;
const activeSheetMenus = new Set();
let tvosControls = null;
let iosControls = null;
let backdropArtwork = fallbackArtwork;
let backdropGeneration = 0;
let hasPlaybackState = false;
let lyricsRequestKey = '';
let lyricsRequestDuration = null;
let lyricsRenderedIdentity = '';
let lyricsRenderedContent = '';
let lyricsGeneration = 0;
let lyricsSearchGeneration = 0;
let syncedLyricsSource = '';
let syncedLyricsSyncer = '';
let syncedLyricsSyncerUrl = '';
// Duration corrections arrive after the first now-playing event often enough
// that a one-second key would restart the same lookup. Keep the request
// identity separate and tolerate small corrections instead.
const lyricsDurationToleranceSeconds = 2;
// The lyrics switch's own state, independent of what lyrics are loaded: the
// column can be hidden while a song's lines are present, and vice versa.
let lyricsVisible = true;
const lyricsVisibility = { desktop: true, ios: false, ipados: true };
let localLyrics = null;
let fileDragDepth = 0;
let noticeTimer = 0;
const maxLocalLyricsBytes = 4 * 1024 * 1024;

function seekToLyric(lyricSeconds) {
  if (!tapToSeek || !Number.isFinite(lyricSeconds)) {
    return;
  }
  // The lyrics run on a shifted clock (audio + offset), so a tapped line's own
  // timestamp has to be converted back to an audio position first.
  const seconds = lyricSeconds - lyricsOffsetMs / 1000;
  const duration = state.durationSeconds;
  const target = duration > 0
    ? Math.min(Math.max(seconds, 0), duration)
    : Math.max(0, seconds);
  dragging = false;
  position = target;
  state.positionSeconds = target;
  playbackClock.seek(target, performance.now());
  seekTo(target);
  if (!state.playing && state.controlsAvailable && typeof window.app?.nowPlaying?.control === 'function') {
    void requestPlaybackControl('play').catch(() => {});
  }
  render();
}

const lyricsView = new LyricsView(lyricsElement, seekToLyric, {
  onLineHold: openShareLyricsSheet,
  onCreditClick: url => window.app?.openExternal?.(url),
});
const developerOverlay = document.createElement('div');
developerOverlay.className = 'developer-overlay';
// Frequently changing telemetry should not interrupt screen reader speech.
developerOverlay.setAttribute('aria-hidden', 'true');
document.body.append(developerOverlay);
let developerRefreshTimer = 0;
const developerMode = createDeveloperMode({
  snapshot: developerSnapshot,
  onTraceComplete: count => {
    showNotice(`Timing trace recorded (${count} samples). Copy or download the diagnostic report to save it.`);
    const button = document.querySelector('[data-developer-action="trace"]');
    if (button) button.textContent = 'Record timing trace (10 seconds)';
  },
  onChange: (options, session) => {
    document.body.classList.toggle('has-developer-bounds', options.enabled && options.showBounds);
    developerOverlay.dataset.corner = options.corner;
    developerOverlay.dataset.frozen = String(session.frozen);
    clearInterval(developerRefreshTimer);
    developerRefreshTimer = session.needsUpdates
      ? setInterval(() => developerMode.refresh(performance.now()), 100) : 0;
  },
  setVisibility: setDeveloperVisibility,
  storage: {
    getItem: key => localStorage.getItem(key),
    setItem: (key, value) => localStorage.setItem(key, value)
  },
  overlay: developerOverlay,
  details: () => [
    `${state.playing ? 'Playing' : 'Paused'} · ${position.toFixed(2)} / ${state.durationSeconds.toFixed(2)} s`,
    `Source: ${state.source || 'None'} · Lyrics: ${lyricsView.lines.length} lines`,
    `Audio ${loudnessLevels.low.toFixed(2)}/${loudnessLevels.mid.toFixed(2)}/` +
    `${loudnessLevels.high.toFixed(2)} (${loudnessLevels.overall.toFixed(3)}) · ` +
    `Pulse: ${loudnessLane(loudnessLevels.overall).toFixed(3)}`
  ]
});
window.addEventListener('beforeunload', () => clearInterval(developerRefreshTimer));

function developerSnapshot(now = performance.now()) {
  const lyricPosition = lyricsClockPosition();
  const rounded = value => Number.isFinite(value) ? Number(value.toFixed(3)) : null;
  const indices = [...new Set([...lyricsView.activeIndices, lyricsView.anchorIndex])]
    .filter(index => index >= 0 && lyricsView.lines[index]).slice(0, 3);
  return {
    app: { version: currentAppVersion, uiStyle, uiScale, reducedMotion: reducedMotion.matches },
    playback: {
      playing: state.playing, source: state.source || null,
      sourceSeconds: state.positionSeconds, rendererSeconds: rounded(position),
      clockSeconds: rounded(playbackClock.read(now)), lyricSeconds: rounded(lyricPosition),
      durationSeconds: state.durationSeconds, rate: playbackClock.rate,
      anchorAgeMs: Math.max(0, now - playbackClock.at), correctionMs: playbackClock.correction * 1000,
      offsetMs: lyricsOffsetMs, pendingTransport: Boolean(pendingTransport)
    },
    lyrics: {
      lineCount: lyricsView.lines.length, activeIndices: [...lyricsView.activeIndices],
      anchorIndex: lyricsView.anchorIndex, scrolling: lyricsElement.classList.contains('is-scrolling'),
      accelerateFill, lineBlur, lineScale, fadeCompletedLines,
      lines: indices.map(index => {
        const line = lyricsView.lines[index];
        const row = lyricsView.lineStates[index];
        const words = line.words || [];
        const geo = lyricsView.fillGeos.get(index);
        const window = accelerateFill && !reducedMotion.matches && words.length
          ? lyricsView.fillAccelerationWindowFor(index, words) : null;
        return {
          index, start: line.time, end: line.end,
          wordCount: words.length,
          wordIndex: words.findIndex(word => lyricPosition >= word.time && lyricPosition < word.end),
          visualRows: geo?.runs.length ?? 0,
          rowWidths: geo?.runs.map(run => rounded(run.total)) ?? [],
          accelerationWindow: window,
          accelerationProgress: window && lyricPosition >= window.start
            ? Math.min(1, (lyricPosition - window.start) / (window.end - window.start)) : null,
          y: row?.y.value ?? 0, targetY: row?.y.queuedTarget ?? row?.y.target ?? 0,
          delayMs: (row?.y.queuedDelay ?? 0) * 1000, blur: row?.blur.value ?? 0,
          opacity: Number.isFinite(row?.lastOpacity) ? row.lastOpacity : row?.opacity.value ?? 0,
          // Read already-painted masks instead of measuring or advancing lyric
          // geometry from a diagnostic refresh. Reports must never move a fill.
          masks: (lyricsView.wordElements[index] || []).slice(0, 32).map((element, i) => ({
            wordIndex: i, start: words[i]?.time, end: words[i]?.end,
            fill: rounded(element.__fill),
            glyphFills: lyricsView.wordMotions[index]?.[i]?.chars?.slice(0, 32)
              .map(char => rounded(char.lastFill))
          }))
        };
      })
    }
  };
}

async function copyDeveloperReport() {
  try {
    await navigator.clipboard.writeText(JSON.stringify(developerMode.report(performance.now()), null, 2));
    showNotice('Diagnostic report copied.');
  } catch {
    showNotice('Could not copy the report. Use Download diagnostic report to save it.');
  }
}

function downloadDeveloperReport() {
  const report = developerMode.report(performance.now());
  const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `yourlyrics-diagnostics-${report.capturedAt.replace(/[:.]/g, '-')}.json`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const playbackControls = createPlaybackControls(document.querySelector('.playback-controls'), {
  control: typeof window.app?.nowPlaying?.control === 'function'
    ? requestPlaybackControl
    : null,
  onError: showNotice
});

function formatClock(value, negative) {
  const safe = Number.isFinite(value) ? value : 0;
  const total = Math.max(0, Math.floor(safe));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${negative ? '-' : ''}${minutes}:${String(seconds).padStart(2, '0')}`;
}

// Artist, title, and clock labels share rasterized glyph masks. Desktop styles
// use CSS glass for metadata, while clocks (which tick every second) and iOS
// labels draw sampled frost synchronously into a child canvas so neither a
// transparent-window compositor nor CSS mask-image re-decoding can flicker.
const frostedLabels = [titleLabel, artistLabel, elapsed, remaining];
const frostedPixels = createFrostedLabelsRenderer(backdropCanvas, () =>
  (document.body.classList.contains('is-tall-animated-art') ||
    document.body.classList.contains('is-wide-animated-art'))
    ? document.querySelector('.artwork-blur.is-ready, .artwork-blur-wide.is-ready') : null);
window.addEventListener('beforeunload', () => frostedPixels.dispose());
const frostedText = new WeakMap();
const frostedSequence = new WeakMap();
let frostedDirty = true;
let frostedResizeTimer = 0;
let frostedResizePending = false;

function frostMask(label, text) {
  // Font metrics are in layout pixels. Screen bounds include the UI-switch
  // and sheet scales, which would permanently shrink/stretch the cached mask.
  const rect = { width: label.offsetWidth, height: label.offsetHeight };
  if (rect.width < 1 || rect.height < 1) {
    return '';
  }
  const style = getComputedStyle(label);
  const fontSize = Number.parseFloat(style.fontSize);
  if (!Number.isFinite(fontSize) || fontSize <= 0) {
    return '';
  }
  const ratio = window.devicePixelRatio || 1;
  const tvMetadata = document.body.dataset.uiStyle === 'tvos' && (label === titleLabel || label === artistLabel);
  const wrappedTitle = tvMetadata && label === titleLabel;
  const gutter = wrappedTitle ? 2 : 0;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round((rect.width + gutter * 2) * ratio));
  canvas.height = Math.max(1, Math.round((rect.height + gutter * 2) * ratio));
  const context = canvas.getContext('2d');
  if (!context) {
    return '';
  }
  context.scale(ratio, ratio);
  context.translate(gutter, gutter);
  context.font = [
    style.fontStyle,
    style.fontWeight,
    `${fontSize}px`,
    style.fontFamily
  ].join(' ');
  context.fillStyle = '#fff';
  context.textBaseline = 'alphabetic';

  // CSS centres the half-leading of the single line box, so the baseline sits
  // at (line-height - (ascent + descent)) / 2 + ascent below the padding edge.
  const metrics = context.measureText('Mg');
  const ascent = metrics.fontBoundingBoxAscent;
  const descent = metrics.fontBoundingBoxDescent;
  const paddingTop = Number.parseFloat(style.paddingTop) || 0;
  const paddingLeft = Number.parseFloat(style.paddingLeft) || 0;
  const paddingRight = Number.parseFloat(style.paddingRight) || 0;
  const lineHeight = Number.parseFloat(style.lineHeight) || fontSize;
  const baseline = paddingTop + (lineHeight - (ascent + descent)) / 2 + ascent;

  if (wrappedTitle) {
    // Let Chromium wrap the actual text, then rasterize those same lines.
    // This preserves whole words, Unicode shaping and user-selected fonts.
    const node = label.firstChild;
    const range = document.createRange();
    const lines = [];
    let line = '';
    let top = null;
    let offset = 0;
    for (const character of text) {
      range.setStart(node, offset);
      offset += character.length;
      range.setEnd(node, offset);
      const bounds = range.getBoundingClientRect();
      if (character.trim() === '' && bounds.width === 0) continue;
      if (top !== null && Math.abs(bounds.top - top) > 1) {
        lines.push(line.trim().replace(/\s+/g, ' '));
        line = '';
      }
      top = bounds.top;
      line += character;
    }
    if (line) lines.push(line.trim().replace(/\s+/g, ' '));
    context.textAlign = 'center';
    context.direction = style.direction;
    lines.forEach((value, index) => context.fillText(value, rect.width / 2, baseline + index * lineHeight));
    return canvas;
  }

  // The remaining time is pinned to the right edge of the bar; canvases do not
  // honour tabular-nums, so anchor that label's mask to the same edge instead
  // of trusting its advance widths.
  const alignRight = label === remaining;
  const available = rect.width - paddingLeft - paddingRight;
  let visible = text;
  // Metadata ellipsises in CSS; clock labels never do, and their
  // canvas advances can differ from the tabular box by a fraction of a pixel.
  // Use actual text overflow, not rounded mask dimensions: a content-sized
  // title can measure a fraction wider than offsetWidth without overflowing.
  if ((label === artistLabel || label === titleLabel) &&
    label.scrollWidth > label.clientWidth && context.measureText(visible).width > available) {
    while (visible.length > 1 &&
      context.measureText(`${visible}\u2026`).width > available) {
      visible = visible.slice(0, -1);
    }
    visible += '\u2026';
  }
  const alignCenter = tvMetadata;
  context.textAlign = alignCenter ? 'center' : alignRight ? 'right' : 'left';
  context.fillText(
    visible,
    alignCenter ? rect.width / 2 : alignRight ? rect.width - paddingRight : paddingLeft,
    baseline
  );
  return canvas;
}

let frostedPixelsDirty = true;
let lastFrostedPaintAt = 0;

// Update only the leading text node so an appended frosted-label-pixels canvas
// stays mounted across per-second clock updates instead of blinking out.
function setLabelText(label, text) {
  for (const node of label.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      if (node.nodeValue !== text) {
        node.nodeValue = text;
      }
      return;
    }
  }
  label.prepend(document.createTextNode(text));
}

function updateFrostedText(now = performance.now()) {
  if (frostedResizePending) {
    return;
  }
  const wasDirty = frostedDirty;
  for (const sourceLabel of frostedLabels) {
    const label = sourceLabel.querySelector('.metadata-marquee-text') || sourceLabel;
    if (label !== sourceLabel && (sourceLabel.classList.contains('frost-ready') || frostedText.has(sourceLabel))) {
      frostedPixels.remove(sourceLabel);
      frostedSequence.set(sourceLabel, (frostedSequence.get(sourceLabel) || 0) + 1);
      sourceLabel.classList.remove('frost-ready');
      sourceLabel.style.removeProperty('--frost-mask');
      frostedText.delete(sourceLabel);
    }
    const text = sourceLabel === titleLabel && document.body.dataset.uiStyle !== 'tvos'
      ? '' : label.textContent || '';
    if (!text) {
      frostedPixels.remove(label);
      if (label.classList.contains('frost-ready') || frostedText.has(label)) {
        frostedSequence.set(label, (frostedSequence.get(label) || 0) + 1);
        label.classList.remove('frost-ready');
        label.style.removeProperty('--frost-mask');
        frostedText.delete(label);
      }
      continue;
    }
    if (!frostedDirty && frostedText.get(label) === text) {
      continue;
    }
    const mask = frostMask(label, text);
    if (!mask) {
      continue;
    }
    frostedText.set(label, text);
    const sequence = (frostedSequence.get(label) || 0) + 1;
    frostedSequence.set(label, sequence);
    const isClock = sourceLabel === elapsed || sourceLabel === remaining;
    const isArtist = sourceLabel === artistLabel;
    const uiStyle = document.body.dataset.uiStyle;
    const useCanvasFrost = uiStyle === 'ios' || ((isClock || (uiStyle === 'tvos' && isArtist)) && backdropCanvas.isConnected);
    if (useCanvasFrost) {
      label.style.removeProperty('--frost-mask');
      label.classList.add('frost-ready');
      frostedPixels.setMask(label, mask);
      frostedPixelsDirty = true;
      continue;
    }
    // Decode before swapping the CSS mask in: a mask whose raster is still
    // pending paints as fully transparent.
    frostedPixels.remove(label);
    const maskUrl = mask.toDataURL('image/png');
    const image = new Image();
    image.src = maskUrl;
    image.decode().then(() => {
      if (frostedSequence.get(label) !== sequence) {
        return;
      }
      label.style.setProperty('--frost-mask', `url("${maskUrl}")`);
      label.classList.add('frost-ready');
    }).catch(() => { });
  }
  frostedDirty = false;
  const backgroundMoving = backdropPlaying ||
    (artworkVideo.classList.contains('is-visible') && !artworkVideo.paused);
  if (wasDirty || frostedPixelsDirty || (backgroundMoving && now - lastFrostedPaintAt >= 150)) {
    frostedPixelsDirty = false;
    lastFrostedPaintAt = now;
    frostedPixels.paint();
    if (!solariumDisabledForSession) {
      requestSolariumGlassDraw();
    }
  }
}

const metadataMarquee = createMetadataMarquee([titleLabel, artistLabel], reducedMotion, () => { frostedDirty = true; });
window.addEventListener('beforeunload', () => metadataMarquee.dispose());

let animatedArtResizeTimer = 0;
window.addEventListener('resize', () => {
  frostedDirty = true;
  frostedResizePending = true;
  refreshSolariumMetadataGeometry();
  refreshLyricsMetrics();
  lyricsMotionUntil = performance.now() + 1500;
  scheduleTick();
  // iPadOS swaps between its portrait and two-column layouts as the window
  // crosses square, which has to follow the drag rather than wait for it.
  syncIpadOrientation();
  clearTimeout(frostedResizeTimer);
  frostedResizeTimer = setTimeout(() => {
    frostedResizeTimer = 0;
    frostedResizePending = false;
  }, 100);
  // Crossing the portrait/landscape line swaps the animated cover's aspect,
  // so the extended artwork has to be re-requested once the drag settles.
  clearTimeout(animatedArtResizeTimer);
  animatedArtResizeTimer = setTimeout(updateAnimatedArt, 200);
});
document.fonts?.ready.then(() => {
  frostedDirty = true;
});
const frostedLabelObserver = new ResizeObserver(() => { frostedDirty = true; });
for (const label of frostedLabels) frostedLabelObserver.observe(label);

let renderedProgress = '';
let renderedPercent = '';
let renderedClock = '';
let renderedDuration = null;
let renderedTimelinePosition = '';

function render(now = performance.now()) {
  const duration = state.durationSeconds;
  const fraction = duration > 0
    ? Math.min(Math.max(position / duration, 0), 1)
    : 0;
  const timelinePosition = document.body.dataset.uiStyle === 'tvos' ? String(fraction) : '';
  if (timelinePosition !== renderedTimelinePosition) {
    renderedTimelinePosition = timelinePosition;
    if (timelinePosition) elapsed.style.setProperty('--timeline-position', timelinePosition);
    else elapsed.style.removeProperty('--timeline-position');
  }

  const progressValue = `${fraction * 100}%`;
  if (progressValue !== renderedProgress) {
    renderedProgress = progressValue;
    progress.style.setProperty('--progress', progressValue);
  }
  const percent = String(Math.round(fraction * 100));
  if (percent !== renderedPercent) {
    renderedPercent = percent;
    progress.setAttribute('aria-valuenow', percent);
  }
  const elapsedText = formatClock(position, false);
  const remainingText = formatClock(duration - position, true);
  const clockText = `${elapsedText} of ${formatClock(duration, false)}`;
  if (clockText !== renderedClock) {
    renderedClock = clockText;
    progress.setAttribute('aria-valuetext', clockText);
  }
  if (duration !== renderedDuration) {
    renderedDuration = duration;
    progress.setAttribute('aria-disabled', duration > 0 ? 'false' : 'true');
    progress.classList.toggle('is-active', duration > 0);
  }
  // Replacing identical text still invalidates layout and the frosted masks.
  // Keep the progress animation at frame rate; clocks change once per second.
  if (elapsed.textContent !== elapsedText) setLabelText(elapsed, elapsedText);
  if (remaining.textContent !== remainingText) setLabelText(remaining, remainingText);
  playbackControls.update({
    playing: state.playing,
    available: state.controlsAvailable && Boolean(
      state.playing || duration > 0 || state.artist ||
      (state.title && state.title !== idleState.title)
    )
  });
  if (lyricsVisible) {
    lyricsView.update(lyricsClockPosition(), duration, state.playing);
  }
  updateFrostedText(now);
}

async function setBackdropArtwork(source) {
  backdropArtwork = source;
  if (!backdrop) {
    return;
  }

  const generation = ++backdropGeneration;
  try {
    const image = new Image();
    image.src = source;
    await image.decode();
    if (!backdrop || generation !== backdropGeneration) {
      return;
    }
    backdrop.setCover(image);
    // A paused backdrop only paints when its loop is running, so a track change
    // with the lyrics hidden needs one frame of its own. That frame has to
    // settle the cover blend: there is no later frame to finish the crossfade,
    // so without this the resting backdrop keeps showing the previous track.
    if (!backdropPlaying) {
      backdrop.renderOnce(null, true);
    }
  } catch {
    return;
  }
}

const playerPolish = createPlayerPolish({
  artwork: artworkImage, title: titleLabel, artist: artistLabel, lyrics: lyricsElement,
  motion: reducedMotion, onMetadata: () => { frostedDirty = true; }
});

let currentArtworkIdentity = '';

function updateArtwork() {
  const identity = lyricsIdentityFor(state);
  const source = state.artworkUrl || fallbackArtwork;
  if (identity && identity === currentArtworkIdentity &&
      currentArtworkUrl && currentArtworkUrl !== fallbackArtwork) {
    return;
  }
  if (source === currentArtworkUrl) {
    currentArtworkIdentity = identity;
    return;
  }
  currentArtworkIdentity = identity;
  currentArtworkUrl = source;
  // While a motion cover is fading out, the video swaps to its poster — the
  // new static cover — so a track change never flashes black.
  artworkVideo.poster = source;
  void playerPolish.cover(source, hasPlaybackState, () => { void setBackdropArtwork(source); });
}

function applyCatalogArtworkFallback() {
  if (typeof window.app?.nowPlaying?.setArtworkFallback === 'function') {
    window.app.nowPlaying.setArtworkFallback(catalogArtworkFallback).catch(() => { });
  }
}

function setCatalogArtworkFallback(enabled) {
  catalogArtworkFallback = enabled === true;
  currentArtworkIdentity = '';
  applyCatalogArtworkFallback();
  persistSettings();
}

function syncAnimatedArtPlayback() {
  if (!artworkVideo.classList.contains('is-visible') ||
    (!artworkHls && !artworkVideo.getAttribute('src'))) {
    return;
  }
  // Motion artwork keeps looping while the song is paused (only the cover
  // shrinks), so playback state never drives the video.
  if (artworkVideo.paused) {
    void artworkVideo.play().catch(() => { });
  }
}

function hideAnimatedArt(options) {
  artworkBlur.reset(options);
  removeArtworkReady();
  artworkHls?.destroy();
  artworkHls = null;
  // Bring the static cover back first so there is never a frame with neither.
  artworkImage.classList.remove('is-covered');
  artworkVideo.classList.remove('is-visible');
  artworkVideo.pause();
  artworkVideo.removeAttribute('src');
  artworkVideo.load();
}

// Decode errors can strike after the first frames were fine (some CDN encodes
// are broken a few seconds in). Whenever that happens the video is retired and
// the static cover stands in — no frozen frame, no restart loop.
artworkVideo.addEventListener('error', () => {
  if (artworkVideo.getAttribute('src')) {
    hideAnimatedArt();
  }
});

// Portrait iOS windows use the tall cover; a wide iOS window and every other
// style use the square one, which the wide layout composites with blurred
// side strips.
function animatedArtAspect() {
  return document.body.dataset.uiStyle === 'ios' &&
    window.innerWidth <= window.innerHeight ? 'tall' : 'square';
}

// iPadOS splits into a cover column and a lyric column once the window is
// wider than it is tall. That layout keeps the ordinary square cover, so it
// never takes over the window with extended motion artwork.
function isIpadLandscape() {
  return document.body.dataset.uiVariant === 'ipados' &&
    window.innerWidth > window.innerHeight;
}

function syncIpadOrientation() {
  const landscape = isIpadLandscape();
  const changed = document.body.classList.contains('is-ipados-landscape') !== landscape;
  document.body.classList.toggle('is-ipados-landscape', landscape);
  backdrop?.setForcePortrait?.(document.body.dataset.uiStyle === 'ios' && !landscape);
  if (changed) {
    frostedDirty = true;
    iosControls?.refresh();
    lyricsView.refreshMetrics();
    syncSolariumLyricsToggle();
    void syncBackdropEngine();
    if (document.querySelector('.sheetview')) settingsSheet.setContent(buildSettingsContent);
  }
  return changed;
}

function supportsClassicBackdrop() {
  return uiStyle === 'macos' || uiStyle === 'tvos' || isIpadLandscape();
}

function useClassicBackdrop() {
  return classicBackdrop && supportsClassicBackdrop();
}

function setClassicBackdrop(enabled) {
  const next = Boolean(enabled);
  if (next === classicBackdrop) return;
  classicBackdrop = next;
  persistSettings();
  void syncBackdropEngine();
}

function updateAnimatedArt() {
  // The compact iOS header uses the static cover. Retire pending requests as
  // well as decoded video so a late response cannot restore the extended art.
  const compactIosMetadata = document.body.dataset.uiStyle === 'ios' && lyricsVisible &&
    !isIpadLandscape();
  if (!animatedCovers || compactIosMetadata) {
    if (animatedArtKey !== '') {
      animatedArtGeneration += 1;
      animatedArtKey = '';
      hideAnimatedArt({ morphToStatic: compactIosMetadata, staticImage: artworkImage });
    }
    return;
  }
  const trackKey = lyricsIdentityFor(state);
  const aspect = animatedArtAspect();
  const key = trackKey ? `${aspect}\u001f${state.source || ''}\u001f${trackKey}` : '';
  if (key === animatedArtKey) {
    syncAnimatedArtPlayback();
    return;
  }

  animatedArtKey = key;
  const generation = ++animatedArtGeneration;
  hideAnimatedArt({ preserveExpansion: key });

  if (!key ||
    reducedMotion.matches ||
    !window.app ||
    !window.app.animatedArt ||
    typeof window.app.animatedArt.get !== 'function') {
    artworkBlur.cancelExpansion();
    return;
  }

  window.app.animatedArt.get({
    aspect,
    source: state.source,
    title: state.title,
    artist: state.artist,
    album: state.album,
    durationSeconds: state.durationSeconds
  }).then((payload) => {
    if (generation !== animatedArtGeneration) {
      return;
    }
    const url = payload && typeof payload.url === 'string' ? payload.url : '';
    if (!url) {
      artworkBlur.cancelExpansion();
      return;
    }

    const onReady = () => {
      if (generation !== animatedArtGeneration) {
        return;
      }
      artworkVideo.classList.add('is-visible');
      const tall = aspect === 'tall' && artworkVideo.videoHeight > artworkVideo.videoWidth;
      // A landscape iOS window cannot use the portrait cover, so the square
      // artwork takes over the extended surface with blurred side strips.
      const wide = !tall && aspect === 'square' &&
        document.body.dataset.uiStyle === 'ios' &&
        window.innerWidth > window.innerHeight && !isIpadLandscape();
      const extended = tall || wide;
      document.body.classList.toggle('is-tall-animated-art', tall);
      document.body.classList.toggle('is-wide-animated-art', wide);
      if (extended) {
        artworkBlur.rememberTrack(key);
        artworkBlur.beginExpansion(artworkImage, key);
        if (tall) {
          document.body.style.setProperty('--ios-animated-art-ratio',
            String(artworkVideo.videoHeight / artworkVideo.videoWidth));
        }
      }
      syncAnimatedArtPlayback();
      // The shared iOS surface retires the static cover after its full-window
      // morph and first rendered frame are ready, rather than after decoding.
      if (extended) return;
      // Once the video has fully faded in (320ms, see styles.css), retire the
      // static cover underneath it. Two stacked layers each carry their own
      // Immersive-artwork mask, so their alphas multiply at the edges and any
      // crop difference between the cover and the video shows up as a second copy.
      setTimeout(() => {
        if (generation === animatedArtGeneration &&
          artworkVideo.classList.contains('is-visible')) {
          artworkImage.classList.add('is-covered');
        }
      }, 340);
    };

    artworkVideo.addEventListener('loadeddata', onReady, { once: true });
    removeArtworkReady = () => artworkVideo.removeEventListener('loadeddata', onReady);
    if (Hls.isSupported()) {
      // The worker needs a blob script URL under our CSP. Running on the main
      // thread avoids that permission for these short, muted artwork loops.
      artworkHls = new Hls({ enableWorker: false, maxBufferLength: 20 });
      artworkHls.on(Hls.Events.ERROR, (_event, data) => {
        if (data.fatal && generation === animatedArtGeneration) hideAnimatedArt();
      });
      artworkHls.loadSource(url);
      artworkHls.attachMedia(artworkVideo);
    } else if (artworkVideo.canPlayType('application/vnd.apple.mpegurl')) {
      artworkVideo.src = url;
      artworkVideo.load();
    } else {
      hideAnimatedArt();
    }
  }).catch(() => {
    if (generation === animatedArtGeneration) artworkBlur.cancelExpansion();
  });
}

reducedMotion.addEventListener('change', () => {
  animatedArtKey = '';
  updateAnimatedArt();
});

function lyricsIdentityFor(value) {
  if (!value.title || value.title === idleState.title) {
    return '';
  }
  return [value.title, value.artist, value.album].join('\u001f');
}

function lyricsDurationMatches(previous, next) {
  if (!Number.isFinite(previous) || !Number.isFinite(next)) {
    return false;
  }
  if (previous <= 0 || next <= 0) {
    return previous === next;
  }
  return Math.abs(next - previous) <= lyricsDurationToleranceSeconds;
}

function lyricsKeyFor(value) {
  const identity = lyricsIdentityFor(value);
  if (!identity) {
    return '';
  }
  return [identity, Math.round(value.durationSeconds)].join('\u001f');
}

// amlbg eases its blur, saturation and pinch between the two intensities, and
// it only advances that ease inside its own loop. Pausing the moment lyrics
// leave froze the last excited frame, which is why the switch looked inert
// behind an empty or hidden column. So the loop keeps painting until the ease
// has settled and only then stops, leaving the resting frame on screen.
// Landscape blur travels 80 points at 60 points/s, so the settle window has to
// outlast that plus amlbg's 0.8 s crossfade.
const backdropRestSettleMs = 2000;
let backdropSettleTimer = 0;

// The backdrop's intensity is the lyrics switch: on while a column is up, off
// the moment it is hidden or gone. The switch starts on and no lyrics are
// loaded at launch, so a launch rests at amlbg's default intensity (off).
function syncBackdropPlayback() {
  const lyricsAreOnScreen = lyricsVisible && lyricsView.lines.length > 0;
  document.body.classList.toggle('has-lyric-scrim', lyricsAreOnScreen && !useClassicBackdrop());
  if (!backdrop) {
    return;
  }
  backdrop.setBehindLyrics(lyricsAreOnScreen);
  clearTimeout(backdropSettleTimer);
  backdropSettleTimer = 0;
  backdrop.play();
  backdropPlaying = true;
  scheduleTick();
  if (lyricsAreOnScreen && state.playing) {
    return;
  }
  backdropSettleTimer = setTimeout(() => {
    backdropSettleTimer = 0;
    backdrop.pause();
    backdropPlaying = false;
  }, backdropRestSettleMs);
}

const transitionIosMetadata = createIosMetadataTransition(document.body, reducedMotion);

// The bottom-right switch: the player column slides from its left third to the
// window centre while the lyrics column scales and fades away, and the
// backdrop stops animating behind a column nobody is reading. The body class
// also swaps the button's masked glyph in styles.css, so the icon needs no JS.
function setLyricsVisible(visible) {
  lyricsVisible = visible;
  const bucket = document.body.dataset.uiVariant === 'ipados'
    ? 'ipados'
    : document.body.dataset.uiStyle === 'ios' ? 'ios' : 'desktop';
  lyricsVisibility[bucket] = visible;
  if (document.body.classList.contains('is-lyrics-hidden') === visible) {
    if (!visible && animatedCovers && document.body.dataset.uiStyle === 'ios' && !isIpadLandscape()) {
      const trackKey = lyricsIdentityFor(state);
      const key = trackKey ? `${animatedArtAspect()}\u001f${state.source || ''}\u001f${trackKey}` : '';
      artworkBlur.beginExpansion(artworkImage, key);
    }
    transitionIosMetadata(() => {
      document.body.classList.toggle('is-lyrics-hidden', !visible);
      // Commit the artwork geometry before the transition captures its target.
      updateAnimatedArt();
    });
  }
  const label = visible ? 'Hide lyrics' : 'Show lyrics';
  if (lyricsToggle) {
    lyricsToggle.setAttribute('aria-pressed', String(visible));
    lyricsToggle.setAttribute('aria-label', label);
    lyricsToggle.title = label;
  }
  syncBackdropPlayback();
  lyricsToggleGlass?.requestDraw();
  if (document.body.dataset.uiStyle === 'ios') refreshLyricsMetrics();
  if (visible && typeof lyricsView !== 'undefined') {
    lyricsView.lastMotionTime = performance.now();
    lyricsView.update(lyricsClockPosition(), state.durationSeconds, state.playing);
  }
  iosControls?.refresh();
}

if (lyricsToggle) {
  lyricsToggle.addEventListener('click', () => setLyricsVisible(!lyricsVisible));
}

document.querySelector('.ios-artwork-toggle').addEventListener('click', () => setLyricsVisible(false));

// The iPadOS volume bar is a purely visual control: dragging updates its fill
// and triggers the min/max speaker bounce without touching system audio.
const volumeControl = document.querySelector('.volume-control');
const volumeSlider = document.querySelector('.volume-slider');
if (volumeControl && volumeSlider) {
  let volumeDragging = false;
  let lastVolumeFraction = 0.5;
  const minIcon = volumeControl.querySelector('.volume-icon--min');
  const maxIcon = volumeControl.querySelector('.volume-icon--max');
  const updateVolumeFromEvent = event => {
    const rect = volumeSlider.getBoundingClientRect();
    if (!rect.width) return;
    const fraction = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    volumeControl.style.setProperty('--volume-progress', `${(fraction * 100).toFixed(2)}%`);
    if (fraction <= 0 && lastVolumeFraction > 0 && minIcon) {
      minIcon.classList.remove('is-bouncing');
      requestAnimationFrame(() => minIcon.classList.add('is-bouncing'));
    } else if (fraction >= 1 && lastVolumeFraction < 1 && maxIcon) {
      maxIcon.classList.remove('is-bouncing');
      requestAnimationFrame(() => maxIcon.classList.add('is-bouncing'));
    }
    lastVolumeFraction = fraction;
  };
  volumeSlider.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    volumeDragging = true;
    volumeControl.classList.add('is-dragging');
    volumeSlider.setPointerCapture?.(event.pointerId);
    updateVolumeFromEvent(event);
  });
  volumeSlider.addEventListener('pointermove', event => {
    if (!volumeDragging) return;
    updateVolumeFromEvent(event);
  });
  const endVolumeDrag = () => {
    if (!volumeDragging) return;
    volumeDragging = false;
    volumeControl.classList.remove('is-dragging');
  };
  volumeSlider.addEventListener('pointerup', endVolumeDrag);
  volumeSlider.addEventListener('pointercancel', endVolumeDrag);
}

// The blur on unsung lines comes from --line-blur written per line by
// LyricsView; the !important override on the container zeroes it wholesale.
function setLineBlur(enabled) {
  lineBlur = enabled;
  stylePreferences[uiStyle].lineBlur = enabled;
  lyricsElement.classList.toggle('is-line-blur-off', !enabled);
  persistSettings();
}

function setLineScale(enabled) {
  lineScale = Boolean(enabled);
  lyricsView.setLineScale(lineScale);
  persistSettings();
}

function setFadeCompletedLines(enabled) {
  fadeCompletedLines = Boolean(enabled);
  lyricsView.setFadeCompleted(fadeCompletedLines);
  persistSettings();
}

// Fill acceleration changes word pacing, so update the lyric view directly.
function setAccelerateFill(enabled) {
  accelerateFill = enabled;
  lyricsView.setAccelerateFill(enabled);
  persistSettings();
}

// Immersive artwork fills the player column with soft edge fades on macOS
// and iPadOS.
function setBleedArtwork(enabled) {
  bleedArtwork = enabled;
  document.body.classList.toggle('is-bleed-artwork',
    enabled && (uiStyle === 'macos' || uiStyle === 'ipados'));
  persistSettings();
}

// What the lyrics believe the playhead is. The progress bar and the transport
// keep using `position`; only the lyric clock is nudged, so an offset never
// makes the seek bar disagree with the player.
function lyricsClockPosition() {
  return position + lyricsOffsetMs / 1000;
}

function setLyricsOffset(ms) {
  lyricsOffsetMs = Math.min(2000, Math.max(-2000, Math.round(ms)));
  persistSettings();
  render();
}

function applyLyricsFontSize(vh) {
  const vw = (vh * 1030 / 1376).toFixed(3);
  document.documentElement.style.setProperty('--lyrics-font-base', `${vh}vh`);
  document.documentElement.style.setProperty('--lyrics-font-vw', `${vw}vw`);
  document.documentElement.style.setProperty('--lyrics-font-size', `min(${vh}vh, ${vw}vw)`);
}

function setLyricsTextSize(vh) {
  lyricsFontVh = Math.min(8, Math.max(3.5, vh));
  stylePreferences[uiStyle].textSize = lyricsFontVh;
  persistSettings();
  applyLyricsFontSize(lyricsFontVh);
  refreshLyricsMetrics();
}

function setLyricsSpacing(value) {
  lyricsSpacing = Math.min(1.8, Math.max(.5, value));
  stylePreferences[uiStyle].spacing = lyricsSpacing;
  document.documentElement.style.setProperty('--lyrics-spacing-scale', String(lyricsSpacing));
  refreshLyricsMetrics();
  persistSettings();
}

function applyStylePreferences(style) {
  const profile = stylePreferences[style];
  lyricsFontVh = profile.textSize;
  lyricsSpacing = profile.spacing;
  lineBlur = profile.lineBlur;
  lyricsElement.classList.toggle('is-line-blur-off', !lineBlur);
  applyLyricsFontSize(lyricsFontVh);
  document.documentElement.style.setProperty('--lyrics-spacing-scale', String(lyricsSpacing));
}

// Font families the picker offers. Each is a stack, so the choice still has a
// sensible fallback where SF Pro Display is not installed.
const fontFamilies = [
  { id: 'sf-pro', label: 'SF Pro', stack: '"SF Pro Display", -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif' },
  { id: 'system', label: 'System', stack: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif' },
  { id: 'rounded', label: 'Rounded', stack: 'ui-rounded, "SF Pro Rounded", "Segoe UI Variable Display", sans-serif' },
  { id: 'serif', label: 'Serif', stack: 'ui-serif, Georgia, "Times New Roman", serif' },
  { id: 'mono', label: 'Mono', stack: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace' },
];

// The four faces the bundled SF Pro Display family ships, so a weight never
// has to be synthesised by the renderer.
const lyricWeights = [
  { value: 400, label: 'Regular' },
  { value: 500, label: 'Medium' },
  { value: 700, label: 'Bold' },
  { value: 800, label: 'Heavy' },
];

const themeOptions = [
  { value: 'system', label: 'Auto' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

const uiScaleOptions = [
  { value: 0.75, label: '75%' },
  { value: 0.85, label: '85%' },
  { value: 0.9, label: '90%' },
  { value: 1, label: '100%' },
  { value: 1.1, label: '110%' },
  { value: 1.25, label: '125%' },
  { value: 1.5, label: '150%' },
];

function normalizeUiScale(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 1;
  }
  const clamped = Math.round(Math.min(1.5, Math.max(0.75, numeric)) * 100) / 100;
  return uiScaleOptions.some(option => option.value === clamped) ? clamped : 1;
}

function setUiScale(value, persist = true) {
  uiScale = normalizeUiScale(value);
  if (typeof window.app?.window?.setUiScale === 'function') {
    window.app.window.setUiScale(uiScale).catch(() => { });
  }
  frostedDirty = true;
  if (persist) {
    persistSettings();
  }
}

const switchUiStyle = createUiStyleSwitcher(document.querySelector('.stage'), (value, animate) => {
  const layout = uiStyleLayout(value);
  const prevBucket = document.body.dataset.uiVariant === 'ipados'
    ? 'ipados'
    : document.body.dataset.uiStyle === 'ios' ? 'ios' : 'desktop';
  const nextBucket = value === 'ipados'
    ? 'ipados'
    : layout === 'ios' ? 'ios' : 'desktop';
  document.body.dataset.uiStyle = layout;
  if (value === 'ipados') document.body.dataset.uiVariant = 'ipados';
  else delete document.body.dataset.uiVariant;
  syncIpadOrientation();
  progress.tabIndex = layout === 'ios' ? 0 : -1;
  if (prevBucket !== nextBucket) {
    setLyricsVisible(lyricsVisibility[nextBucket]);
  }
  const resize = window.app?.window?.setUiStyle?.(value, { animate: animate && !reducedMotion.matches }).catch(() => {
    showNotice('Could not resize the window.');
  });
  applyStylePreferences(value);
  playerPolish.resetTilt();
  if (document.querySelector('.sheetview')) settingsSheet.setContent(buildSettingsContent);
  updateAnimatedArt();
  void syncBackdropEngine();
  syncBackdropFlowSpeed();
  tvosControls?.refresh();
  iosControls?.refresh();
  syncSolariumLyricsToggle();
  if (lyricsToggleGlass) requestAnimationFrame(refreshLyricsToggleGlass);
  document.body.classList.toggle('is-bleed-artwork',
    bleedArtwork && (value === 'macos' || value === 'ipados'));
  frostedDirty = true;
  lyricsView.refreshMetrics();
  // Width and font metrics changed behind the fade. Reveal at the new anchor
  // rather than springing from coordinates that belonged to the previous UI.
  for (const state of [...lyricsView.lineStates, ...lyricsView.interludeStates]) {
    state.y.jump(state.y.queuedTarget ?? state.y.target);
  }
  lyricsView.stepMotion(performance.now(), true);
  return resize;
});

function setUiStyle(value, animate = true) {
  const next = normalizeUiStyle(value);
  if (next === uiStyle && animate) return;
  uiStyle = next;
  void switchUiStyle(next, animate);
  persistSettings();
}

// A font or weight swap changes text metrics without changing a line box's
// width, which is the only thing LyricsView keys its fill geometry cache on.
// Drop the cache explicitly, then let the next frame re-measure.
function refreshLyricsMetrics() {
  requestAnimationFrame(() => lyricsView.refreshMetrics());
}

// One-shot feedback classes. The class stays until the keyframes finish and is
// then removed, so the next change can re-add the same class and replay it.
let themeFlashTimer = 0;
let retypeTimer = 0;

function flashThemeChange() {
  if (reducedMotion.matches) {
    return;
  }
  clearTimeout(themeFlashTimer);
  document.body.classList.remove('is-theme-flash');
  void document.body.offsetWidth; // restart the animation from 0%
  document.body.classList.add('is-theme-flash');
  themeFlashTimer = setTimeout(() => {
    document.body.classList.remove('is-theme-flash');
  }, 620);
}

function pulseLyricsTypography() {
  if (reducedMotion.matches) {
    return;
  }
  const track = document.querySelector('.lyrics-track');
  if (!track) {
    return;
  }
  clearTimeout(retypeTimer);
  track.classList.remove('is-retyping');
  void track.offsetWidth;
  track.classList.add('is-retyping');
  retypeTimer = setTimeout(() => track.classList.remove('is-retyping'), 480);
}

function setFontFamily(id) {
  const next = fontFamilies.some(font => font.id === id) ? id : 'sf-pro';
  const changed = next !== fontFamily;
  fontFamily = next;
  const family = fontFamilies.find(font => font.id === fontFamily);
  document.body.style.fontFamily = family.stack;
  // Arabic lyric rows read this as their Latin fallback, so a chosen Serif or
  // Mono keeps the Latin words it shares a line with.
  document.documentElement.style.setProperty('--app-font-family', family.stack);
  frostedDirty = true;
  refreshLyricsMetrics();
  if (changed) {
    pulseLyricsTypography();
  }
  persistSettings();
}

function setLyricsWeight(weight, style = uiStyle) {
  const next = lyricWeights.reduce((best, option) =>
    Math.abs(option.value - weight) < Math.abs(best - weight) ? option.value : best
    , 700);
  const current = style === 'tvos'
    ? tvosLyricsWeight
    : style === 'ipados' ? ipadosLyricsWeight : lyricsWeight;
  const changed = next !== current;
  if (style === 'tvos') tvosLyricsWeight = next;
  else if (style === 'ipados') ipadosLyricsWeight = next;
  else lyricsWeight = next;
  const prop = style === 'tvos'
    ? '--tvos-font-weight'
    : style === 'ipados' ? '--ipados-font-weight' : '--lyrics-font-weight';
  document.documentElement.style.setProperty(prop, String(next));
  refreshLyricsMetrics();
  if (changed) {
    pulseLyricsTypography();
  }
  persistSettings();
}

const lyricsTextCaseOptions = [
  { value: 'original', label: 'Original' },
  { value: 'uppercase', label: 'UPPERCASE' },
  { value: 'lowercase', label: 'lowercase' },
];

function setLyricsTextCase(value) {
  lyricsTextCase = lyricsTextCaseOptions.some(option => option.value === value)
    ? value
    : 'original';
  document.documentElement.style.setProperty(
    '--lyrics-text-transform',
    lyricsTextCase === 'original' ? 'none' : lyricsTextCase
  );
  refreshLyricsMetrics();
  pulseLyricsTypography();
  persistSettings();
}

// The theme is applied by Chromium itself: setting nativeTheme.themeSource in
// main flips prefers-color-scheme for every window, which is exactly what the
// existing sheetview, menuview and alertview light/dark rules already read.
function applyThemeSource() {
  if (window.app && window.app.theme) {
    window.app.theme.set(theme).catch(() => { });
  }
}

function setTheme(next) {
  const value = themeOptions.some(option => option.value === next) ? next : 'system';
  const changed = value !== theme;
  theme = value;
  applyThemeSource();
  if (changed) {
    flashThemeChange();
  }
  persistSettings();
}

// Settings live in localStorage so they survive restarts; saves are debounced
// because slider input fires per frame.
const settingsStorageKey = 'yourlyrics:settings';
let settingsSaveTimer = 0;

function persistSettings(immediate = false) {
  clearTimeout(settingsSaveTimer);
  const write = () => {
    try {
      localStorage.setItem(settingsStorageKey, JSON.stringify({
        stylePreferences,
        backdropPulse,
        classicBackdrop,
        lineBlur,
        lineScale,
        fadeCompletedLines,
        accelerateFill,
        animatedCovers,
        catalogArtworkFallback,
        tapToSeek,
        bleedArtwork,
        lyricsFontVh,
        lyricsOffsetMs,
        lyricsWeight,
        tvosLyricsWeight,
        ipadosLyricsWeight,
        lyricsTextCase,
        fontFamily,
        theme,
        uiStyle,
        uiScale,
        disableSolarium,
        loudnessGain,
        alwaysOnTop: document.body.classList.contains('is-window-pinned'),
        discord: discordSettings,
      }));
    } catch {
      // Storage full or unavailable; settings stay session-only.
    }
  };
  if (immediate) {
    write();
    return;
  }
  settingsSaveTimer = setTimeout(write, 120);
}

function applyPersistedSettings() {
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(settingsStorageKey) || 'null');
  } catch {
    return;
  }
  if (!saved || typeof saved !== 'object') {
    setLineBlur(lineBlur);
    setAccelerateFill(accelerateFill);
    return;
  }
  stylePreferences = readStylePreferences(saved);
  setUiStyle(saved.uiStyle, false);
  if (Number.isFinite(saved.uiScale)) {
    setUiScale(saved.uiScale, false);
  }
  if (typeof saved.disableSolarium === 'boolean') {
    disableSolarium = saved.disableSolarium;
  }
  if (typeof saved.backdropPulse === 'boolean') {
    backdropPulse = saved.backdropPulse;
  }
  if (typeof saved.classicBackdrop === 'boolean') {
    classicBackdrop = saved.classicBackdrop;
  }
  if (typeof saved.animatedCovers === 'boolean') {
    animatedCovers = saved.animatedCovers;
  }
  if (typeof saved.catalogArtworkFallback === 'boolean') {
    catalogArtworkFallback = saved.catalogArtworkFallback;
  }
  if (typeof saved.tapToSeek === 'boolean') {
    tapToSeek = saved.tapToSeek;
  }
  if (typeof saved.alwaysOnTop === 'boolean' && saved.alwaysOnTop) {
    if (typeof window.app?.window?.setAlwaysOnTop === 'function') {
      window.app.window.setAlwaysOnTop(true).catch(() => { });
    }
  }
  if (Number.isFinite(saved.lyricsOffsetMs)) {
    lyricsOffsetMs = Math.min(2000, Math.max(-2000, saved.lyricsOffsetMs));
  }
  if (typeof saved.fontFamily === 'string') {
    setFontFamily(saved.fontFamily);
  }
  if (Number.isFinite(saved.lyricsWeight)) {
    setLyricsWeight(saved.lyricsWeight, 'macos');
  }
  if (Number.isFinite(saved.tvosLyricsWeight)) {
    setLyricsWeight(saved.tvosLyricsWeight, 'tvos');
  }
  if (Number.isFinite(saved.ipadosLyricsWeight)) {
    setLyricsWeight(saved.ipadosLyricsWeight, 'ipados');
  }
  if (typeof saved.lyricsTextCase === 'string') {
    setLyricsTextCase(saved.lyricsTextCase);
  }
  if (typeof saved.theme === 'string') {
    theme = themeOptions.some(option => option.value === saved.theme)
      ? saved.theme
      : 'system';
  }
  if (Number.isFinite(saved.loudnessGain)) {
    loudnessGain = saved.loudnessGain;
    loudnessGainOwned = saved.loudnessGain !== 0.25;
  }
  if (typeof saved.lineScale === 'boolean') {
    setLineScale(saved.lineScale);
  } else {
    setLineScale(lineScale);
  }
  if (typeof saved.fadeCompletedLines === 'boolean') {
    setFadeCompletedLines(saved.fadeCompletedLines);
  }
  if (typeof saved.accelerateFill === 'boolean') {
    setAccelerateFill(saved.accelerateFill);
  } else if (typeof saved.lineRush === 'boolean') {
    // Preserve the previous preference when adopting the new fill pacing.
    setAccelerateFill(saved.lineRush);
  }
  // `duoArtwork` is the pre-rename key; keep honouring it so saved choices survive.
  if (typeof saved.bleedArtwork === 'boolean') {
    setBleedArtwork(saved.bleedArtwork);
  } else if (typeof saved.duoArtwork === 'boolean') {
    setBleedArtwork(saved.duoArtwork);
  }
  discordSettings = readDiscordSettings(saved.discord);
  applyDiscordSettings();
  applyCatalogArtworkFallback();
}

applyPersistedSettings();
solariumDisabledForSession = disableSolarium;
// Apply the saved appearance before the first sheet opens; an unknown or
// missing value stays on 'system'.
applyThemeSource();

function setLyricsLoading(loading) {
  lyricsElement.classList.toggle('is-loading', loading);
  lyricsElement.setAttribute('aria-busy', loading ? 'true' : 'false');
}

function lyricsSourceLabel(source) {
  const labels = {
    lyricsflow: 'LyricsFlow',
    'lyricsflow-community': 'LyricsFlow Community',
    betterlyrics: 'Unison (Better Lyrics)',
    'betterlyrics-qq': 'Better Lyrics QQ',
    unison: 'Unison (Better Lyrics)',
    lrclib: 'LRCLib',
    'amll-ttml-db': 'AMLL TTML DB'
  };
  if (typeof source === 'string' && /^liriqo\s*(?:·|\()\s*unison\b/i.test(source.trim())) {
    return 'Unison (Better Lyrics)';
  }
  return labels[source] || source || 'Unavailable';
}

function refreshLyricsSheetSource() {
  if (lyricsSheet?.isOpen &&
    !lyricsSheet.el.querySelector('.lyrics-search-results')) {
    lyricsSheet.setContent(buildLyricsContent);
  }
}

function setLocalLyrics(lines, name) {
  localLyrics = {
    identity: lyricsIdentityFor(state),
    name,
    lines
  };
  syncedLyricsSource = '';
  syncedLyricsSyncer = '';
  syncedLyricsSyncerUrl = '';
  lyricsRequestKey = lyricsIdentityFor(state);
  lyricsRequestDuration = state.durationSeconds;
  lyricsGeneration += 1;
  lyricsElement.setAttribute('aria-label', `Lyrics from ${name}`);
  setLyricsLoading(false);
  lyricsView.setLyrics(lines, lyricsClockPosition(), state.durationSeconds, state.playing);
  refreshLyricsSheetSource();
  syncBackdropPlayback();
}

function updateLyrics() {
  const key = lyricsIdentityFor(state);
  const duration = state.durationSeconds;

  if (localLyrics && localLyrics.identity !== key) {
    localLyrics = null;
    syncedLyricsSource = '';
  syncedLyricsSyncer = '';
  syncedLyricsSyncerUrl = '';
    lyricsElement.setAttribute('aria-label', 'Lyrics');
  }

  if (localLyrics) {
    if (key === lyricsRequestKey) {
      return;
    }
    lyricsRequestKey = key;
    lyricsRequestDuration = duration;
    lyricsGeneration += 1;
    lyricsView.setLyrics(localLyrics.lines, lyricsClockPosition(), state.durationSeconds, state.playing);
    syncBackdropPlayback();
    return;
  }

  if (key === lyricsRequestKey &&
      (!key || lyricsDurationMatches(lyricsRequestDuration, duration))) {
    return;
  }
  lyricsRequestKey = key;
  lyricsRequestDuration = key ? duration : null;
  const generation = ++lyricsGeneration;
  const keepRows = Boolean(key && key === lyricsRenderedIdentity && lyricsView.lines.length);
  // A better duration can revalidate the match without tearing down the
  // existing words, masks and springs while the same recording is playing.
  if (!keepRows) {
    lyricsView.clear();
    lyricsRenderedIdentity = '';
    lyricsRenderedContent = '';
    syncedLyricsSource = '';
  syncedLyricsSyncer = '';
  syncedLyricsSyncerUrl = '';
  }
  syncBackdropPlayback();
  setLyricsLoading(false);

  if (!key || !window.app || !window.app.lyrics) {
    return;
  }

  setLyricsLoading(!keepRows);
  window.app.lyrics.get({
    title: state.title,
    artist: state.artist,
    album: state.album,
    durationSeconds: state.durationSeconds
  }).then((payload) => {
    if (generation !== lyricsGeneration) {
      return;
    }
    setLyricsLoading(false);
    if (!payload || !payload.text) {
      return;
    }
    syncedLyricsSource = lyricsSourceLabel(payload.source);
    const parsed = parseLyrics(payload.text, '', payload.communityAuthor, payload.communityAuthorUrl);
    syncedLyricsSyncer = parsed.credits?.syncers?.join(', ') || payload.communityAuthor || '';
    syncedLyricsSyncerUrl = parsed.credits?.syncerUrl || payload.communityAuthorUrl || '';
    refreshLyricsSheetSource();
    const content = JSON.stringify([payload.text, payload.communityAuthor, payload.communityAuthorUrl]);
    if (key === lyricsRenderedIdentity && content === lyricsRenderedContent) return;
    lyricsRenderedIdentity = key;
    lyricsRenderedContent = content;
    lyricsView.setLyrics(
      parsed,
      lyricsClockPosition(),
      state.durationSeconds,
      state.playing
    );
    if (!keepRows) void playerPolish.revealLyrics();
    syncBackdropPlayback();
  }).catch(() => {
    if (generation === lyricsGeneration) {
      syncedLyricsSource = '';
  syncedLyricsSyncer = '';
  syncedLyricsSyncerUrl = '';
      setLyricsLoading(false);
    }
  });
}

function showNotice(message) {
  if (!noticeElement || !message) {
    return;
  }
  noticeElement.textContent = message;
  noticeElement.classList.add('is-visible');
  clearTimeout(noticeTimer);
  noticeTimer = window.setTimeout(() => {
    noticeElement.classList.remove('is-visible');
  }, 2800);
}

function applyLocalLyrics(text, name) {
  const label = typeof name === 'string' && name ? name : 'lyrics file';
  let lines = [];
  try {
    lines = parseLyrics(text, label);
  } catch {
    lines = [];
  }
  if (lines.length === 0) {
    showNotice(`No timed lyrics in ${label}.`);
    return;
  }
  setLocalLyrics(lines, label);
  showNotice(`Loaded ${label}.`);
}

async function openLocalLyrics() {
  if (!window.app || !window.app.lyrics ||
    typeof window.app.lyrics.openFile !== 'function') {
    return;
  }
  try {
    const result = await window.app.lyrics.openFile();
    if (!result || result.canceled) {
      return;
    }
    if (result.error) {
      showNotice(result.error);
      return;
    }
    applyLocalLyrics(result.text, result.name);
  } catch {
    showNotice('Could not open lyrics file.');
  }
}

async function runLyricsSearch(input, status, results, button) {
  const query = input.value.trim();
  const identity = lyricsIdentityFor(state);
  if (!identity || !query) {
    status.textContent = identity ? 'Enter a song or artist.' : 'No track is playing.';
    return;
  }
  if (typeof window.app?.lyrics?.search !== 'function') {
    status.textContent = 'Lyrics search is unavailable.';
    return;
  }

  const generation = ++lyricsSearchGeneration;
  button.disabled = true;
  status.textContent = 'Searching…';
  results.replaceChildren();
  try {
    const result = await window.app.lyrics.search({
      title: state.title,
      artist: state.artist,
      album: state.album,
      durationSeconds: state.durationSeconds
    }, query);
    if (generation !== lyricsSearchGeneration) return;
    if (identity !== lyricsIdentityFor(state)) {
      status.textContent = 'Track changed. Search again for this song.';
      return;
    }
    const candidates = Array.isArray(result?.results) ? result.results : [];
    status.textContent = candidates.length
      ? `${candidates.length} results`
      : result?.error ? 'Search failed. Try again.' : 'No lyrics found.';
    for (const candidate of candidates) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'sheet-row lyrics-search-result';
      const name = document.createElement('span');
      name.textContent = `${candidate.title} · ${candidate.artist}`;
      const album = document.createElement('span');
      album.className = 'sheet-row__value';
      album.textContent = candidate.album || 'LRCLIB';
      row.append(name, album);
      row.addEventListener('click', () => {
        if (identity !== lyricsIdentityFor(state)) {
          status.textContent = 'Track changed. Search again for this song.';
          return;
        }
        const lines = parseLyrics(candidate.text, '');
        if (!lines.length) {
          showNotice('That result has no readable timed lyrics.');
          return;
        }
        setLocalLyrics(lines, `LRCLIB · ${candidate.title}`);
        lyricsSearchGeneration += 1;
        void lyricsSheet.dismiss();
        void playerPolish.revealLyrics();
        showNotice('Lyrics updated.');
      });
      results.append(row);
    }
  } catch {
    if (generation === lyricsSearchGeneration) {
      status.textContent = 'Search failed. Try again.';
    }
  } finally {
    if (generation === lyricsSearchGeneration) button.disabled = false;
  }
}

function buildLyricsSearchContent() {
  const root = document.createElement('div');
  const inputRow = sheetTextRow(
    'Search',
    [state.title, state.artist].filter(Boolean).join(' '),
    value => value,
    'Song or artist',
    'search'
  );
  const input = inputRow.querySelector('input');
  const status = document.createElement('p');
  status.className = 'lyrics-search-status';
  status.setAttribute('role', 'status');
  const results = document.createElement('div');
  results.className = 'lyrics-search-results';
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void runLyricsSearch(input, status, results, button);
    }
  });
  root.append(sheetHeading('Search lyrics'), sheetGroup(inputRow, button), status, results);
  return root;
}

async function loadDroppedLyrics(file) {
  if (!file) {
    return;
  }
  if (file.size > maxLocalLyricsBytes) {
    showNotice('Lyrics file is too large.');
    return;
  }
  try {
    applyLocalLyrics(await file.text(), file.name);
  } catch {
    showNotice('Could not read lyrics file.');
  }
}

function hasFiles(event) {
  const types = event.dataTransfer && event.dataTransfer.types;
  return types ? Array.from(types).includes('Files') : false;
}

function resetFileDrag() {
  fileDragDepth = 0;
  document.body.classList.remove('is-file-drag');
}

function applyNowPlaying(next) {
  if (!next || typeof next !== 'object') {
    return;
  }

  const wasPlaying = state.playing;
  const receivedAt = performance.now();
  if (pendingTransport) {
    const sameTrack = pendingTransport.identity === lyricsIdentityFor(next) &&
      pendingTransport.source === next.source;
    if (!sameTrack || next.controlsAvailable === false) {
      pendingTransport = null;
    } else if (next.playing === pendingTransport.playing) {
      // A play confirmation can still carry the paused elapsed sample.
      // Acknowledge it without rewinding time already shown after the press.
      if (next.playing && Math.abs(next.positionSeconds - pendingTransport.position) < 0.001) {
        next = { ...next, positionSeconds: playbackClock.read(receivedAt) };
      }
      pendingTransport = null;
    } else {
      // Metadata can arrive before the requested transport state. Keep the
      // local preview until the command is confirmed or fails.
      next = {
        ...next,
        playing: pendingTransport.playing,
        playbackRate: pendingTransport.playing ? pendingTransport.rate : 0,
        positionSeconds: playbackClock.read(receivedAt)
      };
    }
  }
  const nextTitle = typeof next.title === 'string' ? next.title : state.title;
  const nextArtist = typeof next.artist === 'string' ? next.artist : state.artist;
  const nextAlbum = typeof next.album === 'string' ? next.album : state.album;
  const nextIdentity = lyricsIdentityFor({ title: nextTitle, artist: nextArtist, album: nextAlbum });
  const sameTrack = Boolean(nextIdentity && nextIdentity === lyricsIdentityFor(state));
  const duration = Number.isFinite(next.durationSeconds) &&
    (next.durationSeconds > 0 || !sameTrack)
    ? Math.max(0, next.durationSeconds)
    : state.durationSeconds;
  const nextPosition = Number.isFinite(next.positionSeconds)
    ? Math.max(0, next.positionSeconds)
    : state.positionSeconds;

  state = {
    title: nextTitle,
    artist: nextArtist,
    album: nextAlbum,
    source: typeof next.source === 'string' && (next.source || !sameTrack)
      ? next.source
      : state.source,
    artworkUrl: typeof next.artworkUrl === 'string' &&
      (next.artworkUrl || !sameTrack || next.artworkFallback === false)
      ? next.artworkUrl
      : state.artworkUrl,
    positionSeconds: nextPosition,
    durationSeconds: duration,
    playbackRate: Number.isFinite(next.playbackRate) ? Math.max(0, next.playbackRate) : 1,
    playing: typeof next.playing === 'boolean' ? next.playing : state.playing,
    controlsAvailable: typeof next.controlsAvailable === 'boolean'
      ? next.controlsAvailable
      : state.controlsAvailable
  };

  // Anchor before any metadata or lyric work so that a transport event takes
  // effect in this frame and newly loaded rows see the current clock.
  if (!dragging) {
    playbackClock.update(state, receivedAt);
    position = Math.min(playbackClock.read(receivedAt), duration > 0 ? duration : Infinity);
  }

  playerPolish.metadata(state.title, state.artist, hasPlaybackState);
  const hasMedia = state.playing
    || state.durationSeconds > 0
    || state.title !== idleState.title
    || state.artist !== ''
    || Boolean(state.artworkUrl);
  playerPolish.playback(state.playing);
  hasPlaybackState = hasPlaybackState || hasMedia;
  document.body.classList.toggle('is-paused', !state.playing);
  if (wasPlaying !== state.playing) {
    syncBackdropPlayback();
  }
  updateArtwork();
  updateLyrics();
  updateAnimatedArt();

  lyricsMotionUntil = performance.now() + 1500;
  render();
  scheduleTick();
}

function positionFromPointer(clientX) {
  const rect = progress.getBoundingClientRect();
  const fraction = Math.min(
    Math.max((clientX - rect.left) / rect.width, 0),
    1
  );
  return fraction * state.durationSeconds;
}

function seekTo(seconds) {
  if (window.app && window.app.nowPlaying) {
    window.app.nowPlaying.seek(seconds);
  }
}

progress.addEventListener('pointerdown', (event) => {
  if (!(state.durationSeconds > 0)) {
    return;
  }
  dragging = true;
  progress.setPointerCapture(event.pointerId);
  position = positionFromPointer(event.clientX);
  render();
  scheduleTick();
});

progress.addEventListener('pointermove', (event) => {
  if (!dragging) {
    return;
  }
  position = positionFromPointer(event.clientX);
  render();
});

function endDrag(event) {
  if (!dragging) {
    return;
  }
  dragging = false;
  if (event.type === 'pointerup') {
    position = positionFromPointer(event.clientX);
  }
  if (progress.hasPointerCapture(event.pointerId)) {
    progress.releasePointerCapture(event.pointerId);
  }
  position = Math.min(
    position,
    state.durationSeconds > 0 ? state.durationSeconds : position
  );
  state.positionSeconds = position;
  playbackClock.seek(position, performance.now());
  seekTo(position);
  render();
}

progress.addEventListener('pointerup', endDrag);
progress.addEventListener('pointercancel', endDrag);

progress.addEventListener('keydown', event => {
  if (document.body.dataset.uiStyle !== 'ios' || !(state.durationSeconds > 0) ||
      event.metaKey || event.ctrlKey || event.altKey) return;
  const target = {
    ArrowLeft: position - 5,
    ArrowRight: position + 5,
    Home: 0,
    End: state.durationSeconds
  }[event.key];
  if (target === undefined) return;
  event.preventDefault();
  dragging = false;
  position = Math.min(state.durationSeconds, Math.max(0, target));
  state.positionSeconds = position;
  playbackClock.seek(position, performance.now());
  seekTo(position);
  render();
});

window.addEventListener('dragenter', (event) => {
  if (!hasFiles(event)) {
    return;
  }
  event.preventDefault();
  fileDragDepth += 1;
  document.body.classList.add('is-file-drag');
});

window.addEventListener('dragover', (event) => {
  if (!hasFiles(event)) {
    return;
  }
  event.preventDefault();
  event.dataTransfer.dropEffect = 'copy';
});

window.addEventListener('dragleave', (event) => {
  if (fileDragDepth === 0) {
    return;
  }
  event.preventDefault();
  fileDragDepth = Math.max(0, fileDragDepth - 1);
  if (fileDragDepth === 0) {
    document.body.classList.remove('is-file-drag');
  }
});

window.addEventListener('drop', (event) => {
  if (!hasFiles(event)) {
    return;
  }
  event.preventDefault();
  resetFileDrag();
  void loadDroppedLyrics(event.dataTransfer.files[0]);
});

window.addEventListener('dragend', resetFileDrag);
window.addEventListener('blur', resetFileDrag);

document.addEventListener('keydown', (event) => {
  // This is a player, not a document: Tab never moves focus, in any style, so
  // the app behaves like a native media player instead of a web page.
  if (event.key === 'Tab') {
    event.preventDefault();
  }
  if (!(event.metaKey || event.ctrlKey) ||
    event.altKey ||
    event.shiftKey ||
    event.repeat ||
    event.key.toLowerCase() !== 'o') {
    return;
  }
  event.preventDefault();
  void openLocalLyrics();
});

// Space toggles playback, the way it does in every other player. The chrome
// keeps it for whatever is focused inside it — a switch, a picker row, a menu
// item — so the shortcut stands down while a sheet, menu or alert is up.
async function requestPlaybackControl(action) {
  const control = window.app?.nowPlaying?.control;
  if (typeof control !== 'function') return { ok: false, error: 'playback_unavailable' };
  if (action !== 'play' && action !== 'pause') return control(action);

  const now = performance.now();
  const previous = { ...state, positionSeconds: playbackClock.read(now) };
  const id = ++transportGeneration;
  const playing = action === 'play';
  const rate = previous.playbackRate > 0 ? previous.playbackRate : 1;
  pendingTransport = null;
  // The command starts the visual transport in this frame. Native updates
  // confirm it later, instead of deciding when the pressed timeline wakes.
  applyNowPlaying({ ...state, positionSeconds: previous.positionSeconds, playing, playbackRate: playing ? rate : 0 });
  pendingTransport = {
    id, playing, rate, position: previous.positionSeconds,
    identity: lyricsIdentityFor(state), source: state.source
  };
  const restore = () => {
    if (pendingTransport?.id !== id) return;
    pendingTransport = null;
    const elapsed = previous.playing ? Math.max(0, performance.now() - now) / 1000 * rate : 0;
    applyNowPlaying({ ...previous, positionSeconds: previous.positionSeconds + elapsed });
  };
  try {
    const result = await control(action);
    if (result?.ok !== true) restore();
    return result;
  } catch (error) {
    restore();
    throw error;
  }
}

function togglePlayback() {
  const control = window.app && window.app.nowPlaying
    ? window.app.nowPlaying.control
    : null;
  if (!state.controlsAvailable || typeof control !== 'function') {
    return;
  }
  const action = state.playing ? 'pause' : 'play';
  requestPlaybackControl(action)
    .then(result => {
      if (result?.ok !== true) {
        showNotice(`Could not ${action} playback.`);
      }
    })
    .catch(() => showNotice(`Could not ${action} playback.`));
}

let playbackSpaceHeld = false;

document.addEventListener('keydown', (event) => {
  if (event.code !== 'Space' ||
    event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) {
    return;
  }
  if (event.target instanceof Element && event.target.closest(
    'input, textarea, select, [contenteditable], .sheetview, .menuview, .alertview'
  )) {
    return;
  }
  // Handle the player shortcut before a focused button sees either key event.
  // Otherwise Chromium can expose its old pointer focus as keyboard focus, and
  // the button's own keyboard handler can activate it again on release.
  event.preventDefault();
  event.stopPropagation();
  if (document.body.dataset.uiStyle === 'ios' &&
      document.activeElement?.closest('#app')) {
    document.activeElement.blur();
  }
  if (event.repeat || playbackSpaceHeld) return;
  playbackSpaceHeld = true;
  togglePlayback();
}, true);

document.addEventListener('keyup', event => {
  if (event.code !== 'Space' || !playbackSpaceHeld) return;
  playbackSpaceHeld = false;
  event.preventDefault();
  event.stopPropagation();
}, true);
window.addEventListener('blur', () => { playbackSpaceHeld = false; });

// One lane to amlbg, once per frame. The analyzer does the smoothing; this
// only applies the pulse switch, the gain, and the unit conversion.
function stepLoudness() {
  if (!backdrop) {
    return;
  }
  backdrop.setEnergy(loudnessEnergy());
}

// amlbg's lanes are the raw 0..1 spectrum and its response is cubic (a smoothed
// power, then a squared zoom), so a lane that has only been through the pulse
// gain does nothing: at the default 0.25 gain a typical kick lands near 0.1,
// under a one percent zoom swing. Dividing by that same default is the unit
// conversion — 0.25 gain means "use the analyzer's own levels" — and the
// clamp keeps a raised gain from pinning the frame at full zoom.
const backdropPulseGain = 0.25;

// The reference's guards: the `!(band > 0)` form rejects NaN and negatives in
// one test (every comparison against a NaN is false).
function loudnessLane(level) {
  if (!backdropPulse) {
    return 0;
  }
  const band = level;
  if (!(band > 0)) {
    return 0;
  }
  const energy = (band * loudnessGain) / backdropPulseGain;
  return energy > 1 ? 1 : energy;
}

// amlbg's four lanes are low, mid, high and peak. The analyzer's overall level
// is the 0.5/0.35/0.15 mixture of the other three, which is what the last lane
// wants, so every lane carries its own band instead of one repeated number.
function loudnessEnergy() {
  return [
    loudnessLane(loudnessLevels.low),
    loudnessLane(loudnessLevels.mid),
    loudnessLane(loudnessLevels.high),
    loudnessLane(loudnessLevels.overall)
  ];
}

let tickFrame = 0;
let lyricsMotionUntil = 0;
let artworkVideoPausedForHidden = false;

function shouldTick(now = performance.now()) {
  if (document.hidden) {
    return false;
  }
  if ((state.playing && state.durationSeconds > 0) || dragging || backdropPlaying) {
    return true;
  }
  if (artworkVideo.classList.contains('is-visible') && !artworkVideo.paused) {
    return true;
  }
  return lyricsVisible && now < lyricsMotionUntil;
}

function scheduleTick() {
  if (tickFrame || !shouldTick()) {
    return;
  }
  tickFrame = requestAnimationFrame(tick);
}

function tick(now) {
  tickFrame = 0;
  if (document.hidden) {
    return;
  }
  developerMode.recordFrame(now);
  stepLoudness();
  if (!dragging) {
    if (state.playing && state.durationSeconds > 0) {
      position = Math.min(
        playbackClock.read(now),
        state.durationSeconds
      );
    } else {
      position = playbackClock.read(now);
    }
  }

  render(now);
  if (shouldTick(now)) {
    tickFrame = requestAnimationFrame(tick);
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    if (!artworkVideo.paused) {
      artworkVideoPausedForHidden = true;
      artworkVideo.pause();
    }
    return;
  }
  if (artworkVideoPausedForHidden) {
    artworkVideoPausedForHidden = false;
    if (artworkVideo.classList.contains('is-visible')) {
      void artworkVideo.play().catch(() => { });
    }
  }
  render();
  scheduleTick();
});

const wakeLyricsMotion = () => {
  lyricsMotionUntil = performance.now() + 1500;
  scheduleTick();
};
lyricsElement.addEventListener('wheel', wakeLyricsMotion, { passive: true });
lyricsElement.addEventListener('click', wakeLyricsMotion);

// 0.16 was dybg's resting pace in its own flow units; amlbg counts 1 as the
// reference cadence, so the same pacing is the old value over 0.16. The tvOS
// style keeps its livelier 0.5 (just over three times the resting pace).
const backdropFlowResting = 1.0;

function syncBackdropFlowSpeed() {
  // Saved styles apply before the backdrop and its flow defaults initialize.
  // startBackdrop applies the selected speed once the renderer is ready.
  if (!backdrop) return;
  const flow = document.body.dataset.uiStyle === 'tvos' ? 1.5 : backdropFlowResting;
  backdrop.setParameters({ speed: flow });
}

function createClassicBackdrop() {
  const classic = new ClassicBackdrop(backdropCanvas, {
    blur: 48,
    warp: 1.75,
    preserveDrawingBuffer: true,
    autoStart: false
  });
  return {
    isClassic: true,
    setCover(image) {
      classic.setArtwork(image);
    },
    renderOnce(_dt, immediate = false) {
      if (immediate) {
        classic._crossfadeStart = performance.now() - classic.options.crossfadeDuration;
      }
      classic._render(performance.now());
    },
    setBehindLyrics() { },
    setEnergy() { },
    setParameters({ speed } = {}) {
      if (Number.isFinite(speed)) {
        classic.update({ warp: document.body.dataset.uiStyle === 'tvos' ? 1.75 * 1.5 : 1.75 });
      }
    },
    setForcePortrait() { },
    play() {
      classic.start();
    },
    pause() {
      classic.stop();
    },
    resize() {
      classic.resize();
    },
    destroy() {
      classic.destroy();
    }
  };
}

function createBackdropEngine() {
  if (useClassicBackdrop()) {
    return createClassicBackdrop();
  }
  return new MeshBackdrop(backdropCanvas, {
    // Apple rolls one of the five pinch-mesh pairs per launch, as dybg did
    // with its warp case, so a session keeps one pair at random.
    seed: String(Math.floor(Math.random() * 5)),
    // 'auto' resolves to the isBehindLyrics switch above, so the lyrics
    // toggle alone picks between the lyrics look and the resting one.
    // Cap the ambient mesh at 30 fps and 0.35 renderScale so MacBook Air/Pro
    // GPUs keep headroom for the 60 fps lyric compositor and Liquid Glass.
    parameters: { motion: 'auto', framesPerSecond: 30, renderScale: 0.35 },
    // The iOS layout is portrait by design, so its backdrop keeps the
    // portrait mesh even when the window is resized wider than it is tall.
    // iPadOS lays out in two columns when wide, so it uses the wide mesh.
    forcePortrait: document.body.dataset.uiStyle === 'ios' && !isIpadLandscape(),
    // Glyph-sized frost canvases sample the displayed mesh even while paused.
    preserveDrawingBuffer: true,
    autoStart: false
  });
}

async function syncBackdropEngine() {
  if (!backdrop) return;
  const wantClassic = useClassicBackdrop();
  if (Boolean(backdrop.isClassic) === wantClassic) {
    backdrop.resize?.();
    return;
  }
  backdrop.destroy();
  try {
    backdrop = createBackdropEngine();
  } catch {
    backdrop = null;
    backdropCanvas.remove();
    return;
  }
  syncBackdropFlowSpeed();
  await setBackdropArtwork(backdropArtwork);
  syncBackdropPlayback();
  frostedDirty = true;
}

async function startBackdrop() {
  try {
    backdrop = createBackdropEngine();
  } catch {
    backdropCanvas.remove();
    return;
  }

  syncBackdropFlowSpeed();
  await setBackdropArtwork(backdropArtwork);
  syncBackdropPlayback();
  window.addEventListener('beforeunload', () => backdrop?.destroy());
}

document.body.hidden = false;
updateArtwork();
render();
scheduleTick();
const startupBackdropReady = startBackdrop();

// The backdrop pulses off the now-playing app's own ~40 Hz band, sent from the
// main process's capture of that app's audio. Main already applies the
// freshness rule and the pulse gain, so this side only parses the payload and
// stepLoudness hands the band to amlbg's spectrum.
if (window.app && window.app.loudness &&
  typeof window.app.loudness.onVolume === 'function') {
  window.app.loudness.onVolume((payload) => {
    if (!payload) {
      loudnessLevels = { low: 0, mid: 0, high: 0, overall: 0 };
      return;
    }
    const level = (value, fallback) => {
      const n = Number(value);
      return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : fallback;
    };
    // `band` is the older single value; older mains still send it.
    const overall = level(payload.overall, level(payload.band, 0));
    loudnessLevels = {
      low: level(payload.low, overall),
      mid: level(payload.mid, overall),
      high: level(payload.high, overall),
      overall
    };
    if (Number.isFinite(payload.gain) && !loudnessGainOwned) {
      loudnessGain = payload.gain;
    }
  });
}

function isSheetDark() {
  return Boolean(window.matchMedia?.('(prefers-color-scheme: dark)')?.matches);
}

function captureSheetControlBackground(context, { captureLeft, captureTop, captureWidth, captureHeight }) {
  context.save();
  context.fillStyle = isSheetDark() ? '#2c2c2e' : '#ffffff';
  context.fillRect(captureLeft, captureTop, captureWidth, captureHeight);
  context.restore();
}

function sheetSwitchRow(label, checked, onChange) {
  const row = document.createElement('div');
  row.className = 'sheet-row';
  const name = document.createElement('span');
  name.textContent = label;
  let currentChecked = Boolean(checked);
  let control = null;
  let solariumSwitch = null;

  const mount = () => {
    solariumSwitch?.destroy();
    solariumSwitch = null;
    control?.remove();
    control = null;

    if (!solariumDisabledForSession && solariumModule) {
      solariumSwitch = new solariumModule.LiquidGlassSwitch({
        isOn: currentChecked,
        deferGlass: true,
        onCapture: captureSheetControlBackground,
      });
      solariumSwitch.element.addEventListener('change', () => {
        currentChecked = solariumSwitch.isOn;
        onChange(currentChecked);
      });
      control = solariumSwitch.element;
    } else {
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.className = 'sheet-switch';
      box.checked = currentChecked;
      box.addEventListener('change', () => {
        currentChecked = box.checked;
        onChange(currentChecked);
      });
      control = box;
    }
    control.setAttribute('aria-label', label);
    row.append(control);
  };

  row.append(name);
  mount();
  activeSheetMenus.add({
    row,
    sync: mount,
    destroy: () => {
      solariumSwitch?.destroy();
      solariumSwitch = null;
    },
  });
  if (!solariumDisabledForSession && !solariumModule) {
    void loadSolarium().then(mod => {
      if (mod && !solariumDisabledForSession && row.isConnected) {
        mount();
      }
    });
  }
  return row;
}

function sheetGroup(...rows) {
  const group = document.createElement('div');
  group.className = 'sheet-group';
  group.append(...rows);
  return group;
}

function sheetHeading(text) {
  const heading = document.createElement('div');
  heading.className = 'sheet-heading';
  heading.textContent = text;
  return heading;
}

function sheetButtonRow(label, onClick, danger = false) {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = danger ? 'sheet-row sheet-row--danger' : 'sheet-row';
  row.textContent = label;
  row.addEventListener('click', onClick);
  return row;
}

function sheetValueRow(label, value) {
  const row = document.createElement('div');
  row.className = 'sheet-row';
  const name = document.createElement('span');
  name.textContent = label;
  const val = document.createElement('span');
  val.className = 'sheet-row__value';
  val.textContent = value;
  row.append(name, val);
  return row;
}

function sheetTextRow(label, value, onChange, placeholder = '', inputMode = 'numeric') {
  const row = document.createElement('label');
  row.className = 'sheet-row sheet-row--text';
  const name = document.createElement('span');
  name.textContent = label;
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'sheet-text-input';
  input.value = value;
  input.placeholder = placeholder;
  input.spellcheck = false;
  input.autocomplete = 'off';
  input.inputMode = inputMode;
  input.addEventListener('change', () => {
    const next = onChange(input.value);
    if (typeof next === 'string') input.value = next;
  });
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      event.preventDefault();
      input.blur();
    }
  });
  row.append(name, input);
  return row;
}

// A settings row whose value is picked from one of the app's own menus instead
// of a native <select> popup, so the sheet keeps its iOS-style chrome.
function sheetMenuRow(label, options, value, onChange) {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'sheet-row sheet-menu-row';
  row.setAttribute('aria-haspopup', 'menu');
  row.setAttribute('aria-expanded', 'false');
  const name = document.createElement('span');
  name.textContent = label;
  const current = document.createElement('span');
  current.className = 'sheet-row__value';
  let currentValue = value;
  const paint = next => {
    currentValue = next;
    const option = options.find(item => String(item.value) === String(next));
    current.textContent = option ? option.label : '';
  };
  paint(value);

  // MenuView scales the menu out of the trigger's centre. A row-sized trigger
  // puts that centre left of the narrower, right-aligned menu, so the origin
  // clamps to the menu's left edge and the animation appears to start from the
  // left. A zero-size trigger pinned to the row's trailing edge makes the menu
  // grow out of its value instead, and the same anchor keeps working when the
  // menu flips above the row.
  const anchor = document.createElement('span');
  anchor.className = 'sheet-menu-anchor';
  anchor.setAttribute('aria-hidden', 'true');
  row.append(name, current, anchor);

  let menu = null;
  const buildItems = () => options.map(option => ({
    type: 'action',
    actionKey: String(option.value),
    actionTitle: option.label,
    label: option.label,
    value: option.value,
    menuState: String(option.value) === String(currentValue) ? 'on' : 'off',
  }));

  const mountMenu = () => {
    menu?.destroy();
    const common = {
      items: buildItems(),
      onOpen: () => row.setAttribute('aria-expanded', 'true'),
      onClose: () => {
        row.setAttribute('aria-expanded', 'false');
        row.focus({ preventScroll: true });
      },
      onSelect: item => {
        paint(item.value);
        onChange(item.value);
      },
    };
    if (!solariumDisabledForSession && solariumModule) {
      const { LiquidGlass, MenuView: SolariumMenuView } = solariumModule;
      const source = backdropCanvas?.isConnected ? backdropCanvas : null;
      const sourceBounds = () => backdropCanvas.getBoundingClientRect();
      menu = new SolariumMenuView(anchor, {
        ...common,
        morphSource: current,
        source,
        sourceBounds,
        onCapture: captureSheetMenuScene,
        placement: 'morph-end',
        width: 190,
        deferGlass: true,
        material: LiquidGlass.regular(),
        onMenuWillCreate: () => menu?.setItems(buildItems()),
      });
    } else {
      menu = new MenuView(anchor, {
        ...common,
        placement: 'bottom-end',
        width: 170,
      });
    }
  };

  mountMenu();
  const entry = { row, sync: mountMenu };
  activeSheetMenus.add(entry);
  if (!solariumDisabledForSession && !solariumModule) {
    void loadSolarium().then(mod => {
      if (mod && !solariumDisabledForSession && row.isConnected) {
        mountMenu();
      }
    });
  }

  // Open from the row itself; press-drag-release is the metadata menu's idiom,
  // not a settings row's. While a menu is open its shade swallows the press, so
  // this cannot reopen a menu that a click on the shade just dismissed.
  row.addEventListener('pointerdown', event => {
    if (event.button !== 0 || menu?.isOpen) {
      return;
    }
    menu?.open();
  });
  row.addEventListener('click', event => {
    if (event.detail === 0) {
      menu?.open(true);
    }
  });

  return row;
}

function sheetSliderRow(label, value, min, max, step, onChange, format) {
  const row = document.createElement('div');
  row.className = 'sheet-row sheet-row--slider';
  const name = document.createElement('span');
  name.textContent = label;
  // A slider that sets an exact value (not just a feel) needs to show it.
  const readout = typeof format === 'function' ? document.createElement('span') : null;
  if (readout) {
    readout.className = 'sheet-row__value';
  }
  let currentValue = Number(value);
  let control = null;
  let solariumSlider = null;

  const snapValue = v => {
    const clamped = Math.min(max, Math.max(min, v));
    if (!step) return clamped;
    const steps = Math.round((clamped - min) / step);
    const decimals = (String(step).split('.')[1] || '').length;
    return Number(Math.min(max, Math.max(min, min + steps * step)).toFixed(decimals));
  };

  const paintReadout = numeric => {
    if (readout) {
      readout.textContent = format(numeric);
    }
  };

  const mount = () => {
    solariumSlider?.destroy();
    solariumSlider = null;
    control?.remove();
    control = null;

    if (!solariumDisabledForSession && solariumModule) {
      const host = document.createElement('div');
      host.className = 'solarium-slider-host';
      const dark = isSheetDark();
      solariumSlider = new solariumModule.LiquidGlassSlider({
        minimumValue: min,
        maximumValue: max,
        value: currentValue,
        deferGlass: true,
        onCapture: captureSheetControlBackground,
        minimumTrackTintColor: dark ? '#0a84ff' : '#007aff',
        maximumTrackTintColor: dark ? 'rgba(120, 120, 128, 0.36)' : 'rgba(120, 120, 128, 0.22)',
      });
      solariumSlider.element.addEventListener('input', () => {
        const numeric = snapValue(solariumSlider.currentValue);
        currentValue = numeric;
        paintReadout(numeric);
        onChange(numeric);
      });
      host.append(solariumSlider.element);
      control = host;
      requestAnimationFrame(() => solariumSlider?.layout());
    } else {
      const input = document.createElement('input');
      input.type = 'range';
      input.className = 'sheet-slider';
      input.min = min;
      input.max = max;
      input.step = step;
      input.value = currentValue;
      const paintStandard = () => {
        const numeric = parseFloat(input.value);
        currentValue = numeric;
        const p = ((numeric - min) / (max - min)) * 100;
        input.style.setProperty('--p', `${p}%`);
        paintReadout(numeric);
      };
      input.addEventListener('input', () => {
        paintStandard();
        onChange(parseFloat(input.value));
      });
      paintStandard();
      control = input;
    }

    paintReadout(currentValue);
    if (readout) {
      row.insertBefore(control, readout);
    } else {
      row.append(control);
    }
  };

  row.append(name);
  if (readout) {
    row.append(readout);
  }
  mount();
  activeSheetMenus.add({
    row,
    sync: mount,
    destroy: () => {
      solariumSlider?.destroy();
      solariumSlider = null;
    },
  });
  if (!solariumDisabledForSession && !solariumModule) {
    void loadSolarium().then(mod => {
      if (mod && !solariumDisabledForSession && row.isConnected) {
        mount();
      }
    });
  }
  return row;
}

function openCacheFolder() {
  if (!window.app || !window.app.cache) {
    return;
  }
  window.app.cache.openFolder().catch(() => { });
}

async function clearCache() {
  const ok = await iosConfirm(
    'Clear cache?',
    'Downloaded lyrics and animated covers will be removed.',
    { confirmText: 'Clear', destructive: true }
  );
  if (!ok) {
    return;
  }
  if (!window.app || !window.app.cache) {
    showNotice('Cache unavailable.');
    return;
  }
  try {
    await window.app.cache.clear();
    showNotice('Cache cleared.');
  } catch {
    showNotice('Could not clear cache.');
  }
}

async function resetSettings() {
  const ok = await iosConfirm(
    'Reset settings?',
    'Backdrop, lyrics and artwork settings go back to their defaults.',
    { confirmText: 'Reset', destructive: true }
  );
  if (!ok) {
    return;
  }
  stylePreferences = readStylePreferences();
  applyStylePreferences(uiStyle);
  setLineBlur(true);
  setLineScale(false);
  setFadeCompletedLines(false);
  backdropPulse = true;
  setClassicBackdrop(false);
  tapToSeek = true;
  animatedCovers = true;
  catalogArtworkFallback = true;
  applyCatalogArtworkFallback();
  updateAnimatedArt();
  setBleedArtwork(false);
  loudnessGainOwned = false;
  loudnessGain = 0.25;
  setLyricsOffset(0);
  setTheme('system');
  setUiStyle('macos');
  const solariumResetChanged = disableSolarium !== false;
  setDisableSolarium(false, false, false);
  setFontFamily('sf-pro');
  setLyricsWeight(700, 'macos');
  setLyricsWeight(700, 'tvos');
  setLyricsTextCase('original');
  persistSettings(true);
  settingsSheet.setContent(buildSettingsContent);
  showNotice('Settings reset.');
  if (solariumResetChanged && disableSolarium !== solariumDisabledForSession) {
    promptSolariumRestart();
  }
}

// Update checks and installs run in main (the renderer CSP has no connect-src
// for GitHub, and electron-updater only exists in a packaged build); the
// renderer only decides when to prompt and what to show.
const skippedUpdateKey = 'yourlyrics:update-skipped';
let currentAppVersion = '';
let updatePromptOpen = false;
let updateDownloadStarted = false;
// The last check's result, kept so Settings and the prompt describe the same
// release: `{ version, notes, size, currentVersion }`.
let latestUpdate = null;

function readSkippedUpdate() {
  try {
    return localStorage.getItem(skippedUpdateKey);
  } catch {
    return null;
  }
}

function rememberSkippedUpdate(version) {
  try {
    localStorage.setItem(skippedUpdateKey, version);
  } catch {
    // Storage unavailable; the prompt simply shows again next launch.
  }
}

// The update card's "Learn more…" opens the release page main already holds;
// the renderer never receives the URL itself.
function openUpdatePage() {
  const updates = window.app && window.app.updates;
  if (updates && typeof updates.openRelease === 'function') {
    updates.openRelease().catch(() => { });
  }
}

async function promptUpdate(info) {
  if (updatePromptOpen) {
    return;
  }
  updatePromptOpen = true;
  try {
    // The card shows the notes in full, so there is nothing to flatten here:
    // dismissing the sheet is the "later" answer.
    const choice = await presentUpdate(info, { onLearnMore: openUpdatePage });
    if (choice === 'update') {
      await startUpdate();
    } else {
      rememberSkippedUpdate(info.version);
    }
  } finally {
    updatePromptOpen = false;
  }
}

async function startUpdate() {
  if (!window.app || !window.app.updates || updateDownloadStarted) {
    return;
  }
  try {
    const result = await window.app.updates.install();
    if (result && result.mode === 'download') {
      updateDownloadStarted = true;
      showNotice('Downloading update…');
    }
    // 'browser' mode: main already opened the release page.
  } catch {
    showNotice('Could not start update.');
  }
}

async function checkForUpdates(manual = false) {
  if (!window.app || !window.app.updates) {
    return null;
  }
  try {
    const result = await window.app.updates.check();
    if (!result || !result.ok) {
      if (manual) {
        showNotice('Could not check for updates.');
      }
      return null;
    }
    if (result.currentVersion) {
      currentAppVersion = result.currentVersion;
    }
    // Remembered so Settings can show the same card inline after a manual
    // check, and so a launch prompt does not hide the notes from the sheet.
    latestUpdate = result.updateAvailable ? result : null;
    if (!result.updateAvailable) {
      if (manual) {
        await iosAlert({
          title: "You're up to date",
          message: `yourLyrics ${result.currentVersion} is the latest version.`,
          actions: [{ text: 'OK' }]
        });
      }
      return result;
    }
    if (manual) {
      // A manual check runs from inside Settings, so the card appears in About
      // instead of stacking a second surface over the sheet the user is in.
      if (settingsSheet.isOpen) {
        settingsSheet.setContent(buildSettingsContent);
      }
    } else if (readSkippedUpdate() !== result.version) {
      // The launch check stays quiet for a version already dismissed once.
      await promptUpdate(result);
    }
    return result;
  } catch {
    if (manual) {
      showNotice('Could not check for updates.');
    }
    return null;
  }
}

function buildSettingsContent() {
  const root = document.createElement('div');
  const developerSection = document.createElement('div');
  developerSection.className = 'developer-settings';
  const updateDeveloperSection = (animate = false) => {
    const options = developerMode.state;
    if (options.enabled) {
      // Rebuilding this section must release its old glass controls and menus;
      // recording and preference resets can replace it several times per visit.
      for (const entry of activeSheetMenus) {
        if (developerSection.contains(entry.row)) {
          entry.destroy?.();
          activeSheetMenus.delete(entry);
        }
      }
      const traceButton = sheetButtonRow(developerMode.recording ? 'Stop timing recording' : 'Record timing trace (10 seconds)', () => {
        if (developerMode.recording) developerMode.stopTrace();
        else {
          developerMode.startTrace(performance.now());
          showNotice('Recording timing for 10 seconds. Reproduce the issue, then save the diagnostic report.');
        }
        updateDeveloperSection();
      });
      traceButton.dataset.developerAction = 'trace';
      developerSection.replaceChildren(
        sheetHeading('Developer · Live inspectors'),
        sheetGroup(
          sheetSwitchRow('Show FPS', options.showFps, enabled => developerMode.setOption('showFps', enabled)),
          sheetSwitchRow('Show diagnostics', options.showDiagnostics, enabled => developerMode.setOption('showDiagnostics', enabled)),
          sheetSwitchRow('Playback clock inspector', options.showClock, enabled => developerMode.setOption('showClock', enabled)),
          sheetSwitchRow('Lyric fill inspector', options.showLyrics, enabled => developerMode.setOption('showLyrics', enabled)),
          sheetSwitchRow('Show lyric layout bounds', options.showBounds, enabled => developerMode.setOption('showBounds', enabled))
        ),
        sheetHeading('Overlay'),
        sheetGroup(
          sheetMenuRow('Refresh interval', [100, 250, 500, 1000].map(value => ({ value, label: `${value} ms` })),
            options.refreshMs, value => developerMode.setOption('refreshMs', Number(value))),
          sheetMenuRow('Overlay position', [
            { value: 'top-right', label: 'Top right' }, { value: 'top-left', label: 'Top left' },
            { value: 'bottom-right', label: 'Bottom right' }, { value: 'bottom-left', label: 'Bottom left' }
          ], options.corner, value => developerMode.setOption('corner', value)),
          sheetSwitchRow('Freeze overlay', developerMode.frozen, enabled => developerMode.setFrozen(enabled))
        ),
        sheetHeading('Capture & tools'),
        sheetGroup(
          traceButton,
          sheetButtonRow('Copy diagnostic report', copyDeveloperReport),
          sheetButtonRow('Download diagnostic report', downloadDeveloperReport),
          sheetButtonRow('Reset performance counters', () => { developerMode.resetStats(); showNotice('Performance counters reset.'); }),
          sheetButtonRow('Reset developer preferences', () => { developerMode.resetPreferences(); updateDeveloperSection(); }),
          sheetButtonRow('Disable developer mode', () => { developerMode.disable(); updateDeveloperSection(true); })
        )
      );
    }
    setDeveloperVisibility(developerSection, options.enabled, animate);
  };
  developerMode.resetPresses();
  const versionRow = sheetButtonRow('', () => {
    if (!developerMode.pressVersion()) return;
    updateDeveloperSection(true);
    const enabled = developerMode.state.enabled;
    void iosAlert({
      title: `Developer Mode ${enabled ? 'Enabled' : 'Disabled'}`,
      message: enabled
        ? 'Live inspectors, timing recordings and diagnostic reports are now available in Settings.'
        : 'Developer controls and overlays are now hidden.',
      actions: [{ text: 'OK' }]
    });
  });
  versionRow.dataset.action = 'version';
  const versionLabel = document.createElement('span');
  versionLabel.textContent = 'Version';
  const versionValue = document.createElement('span');
  versionValue.className = 'sheet-row__value';
  versionValue.textContent = currentAppVersion || '…';
  versionRow.append(versionLabel, versionValue);
  updateDeveloperSection();
  const selectedWeight = () => uiStyle === 'tvos'
    ? tvosLyricsWeight
    : uiStyle === 'ipados' ? ipadosLyricsWeight : lyricsWeight;
  const weightRow = sheetMenuRow('Font weight', lyricWeights, selectedWeight(),
    value => setLyricsWeight(Number(value)));
  root.append(
    sheetHeading('Appearance'),
    sheetGroup(
      sheetMenuRow('UI style', uiStyleOptions, uiStyle, value => {
        setUiStyle(value);
        weightRow.querySelector('.sheet-row__value').textContent =
          lyricWeights.find(option => option.value === selectedWeight()).label;
      }),
      sheetMenuRow('UI scale', uiScaleOptions, uiScale, value => setUiScale(Number(value))),
      sheetMenuRow('Font',
        fontFamilies.map(({ id, label }) => ({ value: id, label })),
        fontFamily,
        setFontFamily),
      weightRow,
      sheetMenuRow('Theme', themeOptions, theme, setTheme),
      sheetSwitchRow('Disable Solarium', disableSolarium, setDisableSolarium),
      sheetSwitchRow('Pin window (Always on Top)', document.body.classList.contains('is-window-pinned'), enabled => {
        if (typeof window.app?.window?.setAlwaysOnTop === 'function') {
          window.app.window.setAlwaysOnTop(enabled).catch(() => { });
          persistSettings();
        }
      }),
    ),
    sheetHeading('Backdrop'),
    sheetGroup(
      ...(supportsClassicBackdrop()
        ? [sheetSwitchRow('Old Apple Music backdrop', classicBackdrop, setClassicBackdrop)]
        : []),
      sheetSwitchRow('Backdrop pulse', backdropPulse, enabled => {
        backdropPulse = enabled;
        persistSettings();
      }),
      sheetSliderRow('Pulse amount', loudnessGain, 0, 1, 0.01, v => {
        loudnessGainOwned = true;
        loudnessGain = v;
        persistSettings();
      }),
    ),
    sheetHeading('Artwork'),
    sheetGroup(
      sheetSwitchRow('Animated covers', animatedCovers, enabled => {
        animatedCovers = enabled;
        persistSettings();
        updateAnimatedArt();
      }),
      sheetSwitchRow('Immersive artwork', bleedArtwork, setBleedArtwork),
      sheetSwitchRow('Catalog artwork fallback', catalogArtworkFallback,
        setCatalogArtworkFallback),
    ),
    sheetHeading(`Lyrics · ${uiStyleOptions.find(option => option.value === uiStyle).label}`),
    sheetGroup(
      sheetSwitchRow('Line blur', lineBlur, setLineBlur),
      sheetSwitchRow('Line scale', lineScale, setLineScale),
      sheetSwitchRow('Fade completed lines', fadeCompletedLines, setFadeCompletedLines),
      sheetSwitchRow('Accelerate fill', accelerateFill, setAccelerateFill),
      sheetMenuRow('Lyric case', lyricsTextCaseOptions, lyricsTextCase, setLyricsTextCase),
      sheetSliderRow('Text size', lyricsFontVh, 3.5, 8, 0.01, setLyricsTextSize),
      sheetSliderRow('Line spacing', lyricsSpacing, .5, 1.8, .01, setLyricsSpacing, value => `${Math.round(value * 100)}%`),
      // Positive shows the lines earlier (they run ahead of the audio).
      sheetSliderRow('Lyrics offset', lyricsOffsetMs, -2000, 2000, 50, setLyricsOffset,
        ms => `${ms > 0 ? '+' : ''}${(ms / 1000).toFixed(2)}s`),
      sheetSwitchRow('Tap to seek', tapToSeek, enabled => {
        tapToSeek = enabled;
        persistSettings();
      }),
    ),
    sheetHeading('Discord'),
    sheetGroup(
      sheetSwitchRow('Rich Presence', discordSettings.enabled,
        enabled => setDiscordSettings({ enabled })),
      sheetTextRow('Application ID', discordSettings.clientId,
        value => setDiscordSettings({ clientId: value }).clientId, 'Not set'),
      ...(() => {
        const nameRow = sheetMenuRow('Status name', discordStatusNameOptions,
          discordSettings.displayNameMode, value => {
            setDiscordSettings({ displayNameMode: value });
            paintCustomName();
          });
        const customNameRow = sheetTextRow('Custom name', discordSettings.displayName,
          value => setDiscordSettings({ displayName: value }).displayName,
          'Status text', 'text');
        const paintCustomName = () => {
          customNameRow.style.display =
            discordSettings.displayNameMode === 'custom' ? '' : 'none';
        };
        paintCustomName();
        const statusRow = sheetValueRow('Status', discordStatusText());
        discordStatusElement = statusRow.querySelector('.sheet-row__value');
        return [
          nameRow,
          customNameRow,
          sheetMenuRow('Activity type', discordActivityTypeOptions,
            discordSettings.activityType, value =>
            setDiscordSettings({ activityType: Number(value) })),
          sheetSwitchRow('Show song title', discordSettings.showTitle,
            enabled => setDiscordSettings({ showTitle: enabled })),
          sheetSwitchRow('Show artist', discordSettings.showArtist,
            enabled => setDiscordSettings({ showArtist: enabled })),
          sheetSwitchRow('Show album', discordSettings.showAlbum,
            enabled => setDiscordSettings({ showAlbum: enabled })),
          sheetSwitchRow('Show elapsed time', discordSettings.showTimestamps,
            enabled => setDiscordSettings({ showTimestamps: enabled })),
          sheetSwitchRow('Show artwork', discordSettings.showArtwork,
            enabled => setDiscordSettings({ showArtwork: enabled })),
          sheetSwitchRow('Hide when paused', discordSettings.hideWhenPaused,
            enabled => setDiscordSettings({ hideWhenPaused: enabled })),
          statusRow
        ];
      })()
    ),
    sheetHeading('Cache'),
    sheetGroup(
      sheetButtonRow('Open cache folder', openCacheFolder),
      sheetButtonRow('Clear cache', clearCache, true),
    ),
    sheetHeading('About'),
    // Inline rather than only in the prompt, so a manual check reads as a
    // result in place instead of a modal that reopens what the user is in.
    ...(latestUpdate
      ? [buildUpdateCard(latestUpdate, {
        onUpdate: () => {
          settingsSheet.dismiss();
          startUpdate();
        },
        onLearnMore: openUpdatePage
      })]
      : []),
    sheetGroup(
      versionRow,
      sheetButtonRow('Check for updates', () => {
        checkForUpdates(true);
      }),
    ),
    developerSection,
    sheetGroup(
      sheetButtonRow('Reset settings', resetSettings, true),
    ),
  );
  return root;
}

function lyricsProviderDiscord() {
  if (localLyrics) return null;
  if (syncedLyricsSource === 'LyricsFlow' || syncedLyricsSource === 'LyricsFlow Community') {
    return { name: 'LyricsFlow', url: 'https://discord.gg/zXb7sTJrrq' };
  }
  if (syncedLyricsSource === 'Unison (Better Lyrics)' || syncedLyricsSource === 'Better Lyrics QQ') {
    return { name: 'Better Lyrics', url: 'https://discord.gg/UsHE3d5fWF' };
  }
  return null;
}

function buildLyricsContent(sheet) {
  const root = document.createElement('div');
  const discord = lyricsProviderDiscord();
  const rows = [
    sheetButtonRow('Open file…', () => {
      sheet.dismiss();
      openLocalLyrics();
    }),
    sheetValueRow(
      'Source',
      localLyrics ? localLyrics.name : syncedLyricsSource || 'Unavailable'
    ),
  ];
  if (!localLyrics && syncedLyricsSyncer) {
    if (syncedLyricsSyncerUrl) {
      rows.push(
        sheetButtonRow(`Synced by ${syncedLyricsSyncer}`, () => {
          sheet.dismiss();
          window.app?.openExternal?.(syncedLyricsSyncerUrl);
        })
      );
    } else {
      rows.push(sheetValueRow('Synced by', syncedLyricsSyncer));
    }
  }
  if (discord) {
    rows.push(
      sheetButtonRow(`Join ${discord.name} on Discord`, () => {
        sheet.dismiss();
        window.app?.openExternal?.(discord.url);
      })
    );
  }
  root.append(
    sheetHeading(`Lyrics · ${uiStyleOptions.find(option => option.value === uiStyle).label}`),
    sheetGroup(...rows),
  );
  return root;
}

const sheetBaseOptions = {
  page: '#app',
  grabber: true,
  maxWidth: 420,
  // The window is transparent and rounds its own corners, so the sheet must
  // not paint the document root square behind the scaled page. The app's
  // rounded base layer already provides the dark backdrop.
  backdropColor: 'transparent',
};

let settingsSheet = new SheetView(sheetBaseOptions);
let lyricsSheet = new SheetView({ ...sheetBaseOptions, fitContent: true });
// Share Lyrics sheet (UI + motion only; actions are placeholders).
//
// Matches LyricsBlossom's ShareOverlay decompilation (ShareOverlay::render):
// - openSpring: 0 -> 1, critically damped, response = 0.42 s (dismiss = 0.40 s).
// - Per-line springs: start at 2.0 -> 0.0 with stiffness = 110, damping = 15,
//   retargeted once openProgress > 0.3 with a 40 ms/row outward stagger from the
//   selected range; lines above offset by -10.2 * sp (-20.4 -> 0 px), lines
//   at/below offset by +34.0 * sp (+68 -> 0 px), opacity clamp(3 - 1.5*sp, 0..1).
// - Held line pill morphs on s9 = 1 - (1 - openProgress)^3 from the player line
//   to its target slot in the sheet, sampling the live <canvas class="backdrop">.
// - Selected pills sample the live <canvas class="backdrop"> clipped with 20 px
//   outer corners, 7 px inner corners, and a 2 px hairline between joined rows.
const SHARE_FLY_RESPONSE = 0.3;
const SHARE_LINE_STIFFNESS = 110;
const SHARE_LINE_DAMPING = 15;
const SHARE_REVEAL_AT = 0.4;
const SHARE_ROW_STAGGER_S = 0.04;
const SHARE_OFFSET_ABOVE = -10.2;
const SHARE_OFFSET_BELOW = 34.0;
const SHARE_PILL_GAP = 8;
const SHARE_PILL_EXPAND = 0;
const SHARE_PILL_OUTER_RADIUS = 20;
const SHARE_PILL_INNER_RADIUS = 7;
const SHARE_SELECT_STIFFNESS = 340;
const SHARE_SELECT_DAMPING = 39;
const SHARE_SELECT_STAGGER_S = 0.035;
const SHARE_MAX_CHARS = 300;

let shareLyricsSheet = new SheetView({
  ...sheetBaseOptions,
  title: 'Share Lyrics',
  maxWidth: 440,
});
shareLyricsSheet.el.classList.add('share-lyrics-sheet');

const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a, b, t) => a + (b - a) * t;

function criticalProgress(seconds, response) {
  if (seconds <= 0) return 0;
  const w = (2 * Math.PI) / response;
  return 1 - (1 + w * seconds) * Math.exp(-w * seconds);
}

function makeLineSpring(initial = 2) {
  return {
    x: initial,
    v: 0,
    target: initial,
    k: SHARE_LINE_STIFFNESS,
    c: SHARE_LINE_DAMPING,
    delay: 0,
    triggered: false,
  };
}

function stepDampedSpring(spring, target, k, c, dt) {
  let rest = dt;
  while (rest > 0) {
    const h = Math.min(rest, 1 / 240);
    spring.v += (-k * (spring.x - target) - c * spring.v) * h;
    spring.x += spring.v * h;
    rest -= h;
  }
}

function stepLineSpring(spring, dt) {
  if (spring.delay > 0) {
    spring.delay -= dt;
    if (spring.delay > 0) return;
    dt = -spring.delay;
    spring.delay = 0;
  }
  stepDampedSpring(spring, spring.target, spring.k, spring.c, dt);
}

const springSettled = (spring, target, eps = 0.005) =>
  Math.abs(spring.x - target) < eps && Math.abs(spring.v) < eps * 2;

const lineSpringSettled = spring =>
  spring.delay <= 0 && springSettled(spring, spring.target);

function captureShareBackdropSource() {
  if (!backdropCanvas?.isConnected || !backdropCanvas.width || !backdropCanvas.height) {
    return null;
  }
  if (!backdropPlaying) {
    try { backdrop?.renderOnce?.(null, true); } catch {}
  }
  const snap = document.createElement('canvas');
  snap.width = backdropCanvas.width;
  snap.height = backdropCanvas.height;
  const ctx = snap.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(backdropCanvas, 0, 0);
  return snap;
}

function drawScreenMappedBackdrop(ctx, source, sourceRect, targetRect, radii, alpha = 1) {
  const [tl, tr, br, bl] = radii;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.beginPath();
  ctx.roundRect(0, 0, targetRect.width, targetRect.height, [tl, tr, br, bl]);
  ctx.clip();
  if (source && sourceRect && sourceRect.width > 0 && sourceRect.height > 0) {
    ctx.drawImage(
      source,
      sourceRect.left - targetRect.left,
      sourceRect.top - targetRect.top,
      sourceRect.width,
      sourceRect.height
    );
  } else {
    ctx.fillStyle = '#5e5e66';
    ctx.fillRect(0, 0, targetRect.width, targetRect.height);
  }
  ctx.restore();
}

function buildShareLyricsContent(sheet, initialIndex, sourceEl) {
  const root = document.createElement('div');
  root.className = 'share-lyrics-root';

  // ---- track + selection count group (matches Settings sheet .sheet-group) ----
  const summaryGroup = document.createElement('div');
  summaryGroup.className = 'sheet-group share-lyrics-summary';
  const summaryRow = document.createElement('div');
  summaryRow.className = 'sheet-row share-lyrics-summary-row';
  const cover = document.createElement('div');
  cover.className = 'share-lyrics-cover';
  if (state.artworkUrl) {
    cover.style.backgroundImage = `url("${String(state.artworkUrl).replace(/"/g, '%22')}")`;
  }
  const meta = document.createElement('div');
  meta.className = 'share-lyrics-meta';
  const countEl = document.createElement('div');
  countEl.className = 'share-lyrics-title';
  const charsEl = document.createElement('div');
  charsEl.className = 'share-lyrics-subtitle';
  meta.append(countEl, charsEl);
  summaryRow.append(cover, meta);
  summaryGroup.append(summaryRow);

  // ---- rows ----
  const stageWrap = document.createElement('div');
  stageWrap.className = 'share-lyrics-stage-wrap';
  stageWrap.dataset.sheetviewNodrag = '';

  const stage = document.createElement('div');
  stage.className = 'share-lyrics-stage';
  stage.dataset.sheetviewNodrag = '';

  const stageCanvas = document.createElement('canvas');
  stageCanvas.className = 'share-lyrics-stage-canvas';
  stageCanvas.setAttribute('aria-hidden', 'true');
  const stageCtx = stageCanvas.getContext('2d');
  stage.append(stageCanvas);
  stageWrap.append(stage);

  const selectable = [];
  for (let i = 0; i < lyricsView.lines.length; i += 1) {
    const line = lyricsView.lines[i];
    if (!line || line.isCredit || line.isBackground || !line.text?.trim()) continue;
    const el = lyricsView.lineElements[i];
    selectable.push({
      index: i,
      text: line.text.trim(),
      rtl: el?.dir === 'rtl',
      arabic: Boolean(el?.classList.contains('is-arabic')),
      duet: Boolean(el?.classList.contains('is-duet')),
    });
  }
  const totalChars = selectable.reduce((sum, item) => sum + item.text.length, 0);

  let start = Math.max(0, selectable.findIndex(item => item.index === initialIndex));
  let end = start;
  const anchorPos = start;

  const reduceMotion = Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);

  const lineSprings = selectable.map((_, pos) => (
    pos === anchorPos
      ? { ...makeLineSpring(0), triggered: true }
      : makeLineSpring(2)
  ));
  const selStates = selectable.map((_, pos) => ({
    delay: 0,
    mask: { x: pos === anchorPos ? 1 : 0, v: 0, target: pos === anchorPos ? 1 : 0 },
    topR: { x: SHARE_PILL_OUTER_RADIUS, v: 0, target: SHARE_PILL_OUTER_RADIUS },
    botR: { x: SHARE_PILL_OUTER_RADIUS, v: 0, target: SHARE_PILL_OUTER_RADIUS },
    expTop: { x: 0, v: 0, target: 0 },
    expBot: { x: 0, v: 0, target: 0 },
  }));
  const rowEls = selectable.map((item, pos) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'share-lyrics-line';
    row.dataset.sheetviewNodrag = '';
    if (item.rtl) row.dir = 'rtl';
    if (item.arabic) row.classList.add('is-arabic');
    if (item.duet) row.classList.add('is-duet');
    row.textContent = item.text;
    row.style.opacity = pos === anchorPos ? '1' : '0';
    if (pos === anchorPos) row.style.transform = 'translate3d(0, 0, 0)';
    row.addEventListener('click', () => select(pos));
    stage.append(row);
    return row;
  });

  const limitToast = document.createElement('div');
  limitToast.className = 'share-lyrics-limit-toast';
  limitToast.textContent = `Up to ${SHARE_MAX_CHARS} characters`;
  let limitTimer = 0;

  function showLimitToast() {
    clearTimeout(limitTimer);
    limitToast.classList.add('is-visible');
    limitTimer = window.setTimeout(() => limitToast.classList.remove('is-visible'), 1600);
  }

  // ---- actions (placeholders) ----
  const actions = document.createElement('div');
  actions.className = 'share-lyrics-actions';
  actions.dataset.sheetviewNodrag = '';
  const actionGlasses = [];
  const isSheetDark = () => (typeof sheet._isDark === 'function'
    ? sheet._isDark()
    : Boolean(window.matchMedia?.('(prefers-color-scheme: dark)')?.matches));
  const getUnselectedPillFill = () => {
    const varFill = getComputedStyle(stage).getPropertyValue('--solarium-sheet-group-bg').trim();
    if (varFill) return varFill;
    return isSheetDark() ? 'rgba(120, 120, 128, 0.24)' : 'rgba(120, 120, 128, 0.16)';
  };
  const captureShareActionBackdrop = (context, { captureLeft, captureTop, captureWidth, captureHeight }) => {
    const dark = isSheetDark();
    const unselectedFill = getUnselectedPillFill();
    context.save();
    context.fillStyle = dark ? '#1c1c1e' : '#f2f2f7';
    context.fillRect(captureLeft, captureTop, captureWidth, captureHeight);
    const wrapRect = stageWrap.getBoundingClientRect();
    if (wrapRect.bottom > captureTop && wrapRect.top < captureTop + captureHeight &&
        wrapRect.right > captureLeft && wrapRect.left < captureLeft + captureWidth) {
      context.save();
      context.beginPath();
      context.rect(wrapRect.left, wrapRect.top, wrapRect.width, wrapRect.height);
      context.clip();
      for (const row of rowEls) {
        const r = row.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        if (r.bottom <= captureTop || r.top >= captureTop + captureHeight ||
            r.right <= captureLeft || r.left >= captureLeft + captureWidth) continue;
        const style = getComputedStyle(row);
        const radius = Math.min(Number.parseFloat(style.borderTopLeftRadius) || 0, r.width / 2, r.height / 2);
        context.fillStyle = row.classList.contains('is-selected')
          ? 'rgba(142, 142, 147, 0.45)'
          : unselectedFill;
        context.beginPath();
        context.roundRect(r.left, r.top, r.width, r.height, radius);
        context.fill();
      }
      context.restore();
    }
    context.restore();
  };

  const solarium = !solariumDisabledForSession ? solariumModule : null;
  let actionBusy = false;
  const actionTimers = new Set();

  async function runShareExport(action, button, labelEl, idleLabel) {
    if (actionBusy || !selectable.length) return;
    actionBusy = true;
    button.setAttribute('aria-busy', 'true');
    try {
      await document.fonts?.ready;
      const card = await generateShareLyricsCard({
        lines: selectable.slice(start, end + 1),
        title: state.title,
        artist: state.artist,
        artworkUrl: state.artworkUrl || currentArtworkUrl || fallbackArtwork,
        backdropSeed: backdrop?._seedName ?? '0',
        backdropTime: backdrop?.time ?? 0,
        fallbackBackdrop: activeBackdropSource(),
      });
      if (!card) return;

      if (action === 'copy') {
        let copied = false;
        if (typeof window.app?.share?.copyImage === 'function') {
          const res = await window.app.share.copyImage(card.dataUrl);
          copied = Boolean(res?.ok);
        } else if (navigator.clipboard?.write && typeof ClipboardItem !== 'undefined') {
          const blob = await new Promise(resolve => card.canvas.toBlob(resolve, 'image/png'));
          if (blob) {
            await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
            copied = true;
          }
        }
        if (copied && sheet.state !== 'closed') {
          labelEl.textContent = 'Copied!';
          const timer = window.setTimeout(() => {
            actionTimers.delete(timer);
            labelEl.textContent = idleLabel;
          }, 1400);
          actionTimers.add(timer);
        }
        return;
      }

      if (typeof window.app?.share?.saveImage === 'function') {
        const res = await window.app.share.saveImage(card.dataUrl, card.filename);
        if (res?.ok && sheet.state !== 'closed') {
          labelEl.textContent = 'Saved!';
          const timer = window.setTimeout(() => {
            actionTimers.delete(timer);
            if (sheet.state !== 'closed') sheet.dismiss();
          }, 260);
          actionTimers.add(timer);
        }
      } else {
        const link = document.createElement('a');
        link.href = card.dataUrl;
        link.download = card.filename;
        link.click();
      }
    } finally {
      actionBusy = false;
      button.removeAttribute('aria-busy');
    }
  }

  for (const [label, primary, action] of [
    ['Copy Image', false, 'copy'],
    ['Save Image', true, 'save'],
  ]) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = primary ? 'share-lyrics-btn is-primary' : 'share-lyrics-btn';
    const labelEl = document.createElement('span');
    labelEl.className = 'share-lyrics-btn__label';
    labelEl.textContent = label;
    button.append(labelEl);
    button.dataset.sheetviewNodrag = '';
    button.addEventListener('click', () => {
      void runShareExport(action, button, labelEl, label);
    });

    if (solarium?.LiquidGlass && solarium?.LiquidGlassView) {
      const { LiquidGlass, LiquidGlassView } = solarium;
      const base = LiquidGlass.regular();
      const material = new LiquidGlass({
        uniforms: {
          ...base.uniforms,
          glassThickness: 12,
          refractiveIndex: 1.54,
          dispersionStrength: 6,
          glareDistanceRange: 22,
          glareAngleConvergence: 0.28,
          glareOppositeSideBias: 0.85,
          glareIntensity: primary ? 0.22 : 0.16,
          glareEdgeSharpness: -0.06,
        },
        backgroundTextureSizeCoefficient: 1,
        backgroundTextureScaleCoefficient: 0.3,
        backgroundTextureBlurRadius: 3.0,
        backdropTone: () => (primary
          ? (isSheetDark() ? [1.06, 1.04] : [1.0, 1.02])
          : (isSheetDark() ? [1.24, 1.04] : [1.0, 1.0])),
        tintColor: () => (primary
          ? (isSheetDark() ? [0.02, 0.48, 1.0, 0.82] : [0.0, 0.478, 1.0, 0.86])
          : (isSheetDark() ? [0.18, 0.18, 0.20, 0.56] : [0.96, 0.98, 1.0, 0.58])),
      });
      const glass = new LiquidGlassView(material, {
        onCapture: captureShareActionBackdrop,
        cornerRadius: 23,
        interactive: true,
        pressTransformTarget: button,
        pressScaleAmount: 0.06,
      });
      if (glass.renderer) {
        button.classList.add('is-solarium-glass');
      }
      glass.element.className = 'solarium-share-btn__glass';
      Object.assign(glass.element.style, {
        position: 'absolute',
        inset: '0',
        zIndex: '0',
        pointerEvents: 'none',
      });
      glass.element.setAttribute('aria-hidden', 'true');
      button.prepend(glass.element);
      actionGlasses.push(glass);
    }

    actions.append(button);
  }

  root.append(summaryGroup, stageWrap, limitToast, actions);

  function applySelection(staggerOrigin = null) {
    const count = selectable.length ? end - start + 1 : 0;
    let chars = 0;
    for (let k = start; k <= end; k += 1) chars += selectable[k]?.text.length ?? 0;
    countEl.textContent = count === 1 ? '1 Line Selected' : `${count} Lines Selected`;
    charsEl.textContent = `${chars}/${totalChars} characters`;
    rowEls.forEach((row, pos) => {
      const selected = pos >= start && pos <= end;
      const joinedTop = selected && pos > start;
      const joinedBottom = selected && pos < end;
      row.classList.toggle('is-selected', selected);
      row.classList.toggle('is-joined-top', joinedTop);
      row.classList.toggle('is-joined-bottom', joinedBottom);

      const s = selStates[pos];
      s.mask.target = selected ? 1 : 0;
      s.topR.target = joinedTop ? SHARE_PILL_INNER_RADIUS : SHARE_PILL_OUTER_RADIUS;
      s.botR.target = joinedBottom ? SHARE_PILL_INNER_RADIUS : SHARE_PILL_OUTER_RADIUS;
      s.expTop.target = joinedTop ? SHARE_PILL_EXPAND : 0;
      s.expBot.target = joinedBottom ? SHARE_PILL_EXPAND : 0;
      s.delay = staggerOrigin == null || reduceMotion
        ? 0
        : Math.abs(pos - staggerOrigin) * SHARE_SELECT_STAGGER_S;
      if (reduceMotion) {
        for (const prop of [s.mask, s.topR, s.botR, s.expTop, s.expBot]) {
          prop.x = prop.target;
          prop.v = 0;
        }
      }
    });
  }

  // Matches LyricsBlossom's ShareOverlay::selectLine range logic (0x100262ca4).
  function select(pos) {
    if (pos < 0 || pos >= selectable.length) return;
    const prevStart = start;
    const prevEnd = end;
    let nextStart = start;
    let nextEnd = end;
    if (pos >= start && pos <= end) {
      if (start === end) return;
      if (pos === start) nextStart = start + 1;
      else if (pos === end) nextEnd = end - 1;
      else if (pos - start <= end - pos) nextStart = pos;
      else nextEnd = pos;
    } else {
      nextStart = Math.min(start, pos);
      nextEnd = Math.max(end, pos);
    }

    let nextChars = 0;
    for (let k = nextStart; k <= nextEnd; k += 1) nextChars += selectable[k].text.length;
    if (nextChars > SHARE_MAX_CHARS) {
      showLimitToast();
      return;
    }

    const staggerOrigin = pos > prevEnd
      ? prevEnd
      : pos < prevStart
        ? prevStart
        : pos;
    start = nextStart;
    end = nextEnd;
    applySelection(staggerOrigin);
    kick();
  }

  applySelection();

  // ---- live backdrop sampling & selected pills rendering ----
  const staticBackdrop = captureShareBackdropSource();

  function activeBackdropSource() {
    if (backdropPlaying && backdropCanvas?.isConnected && backdropCanvas.width && backdropCanvas.height) {
      return backdropCanvas;
    }
    return staticBackdrop;
  }

  function renderSelectedBackdropPills() {
    if (!stageCtx) return;
    const dpr = window.devicePixelRatio || 1;
    const width = stage.clientWidth;
    const height = Math.max(stage.clientHeight, stage.scrollHeight);
    if (!width || !height) return;

    const canvasDpr = Math.min(dpr, 12000 / Math.max(1, height));
    const targetW = Math.round(width * canvasDpr);
    const targetH = Math.round(height * canvasDpr);
    if (stageCanvas.width !== targetW || stageCanvas.height !== targetH) {
      stageCanvas.width = targetW;
      stageCanvas.height = targetH;
      stageCanvas.style.width = `${width}px`;
      stageCanvas.style.height = `${height}px`;
    }

    stageCtx.setTransform(canvasDpr, 0, 0, canvasDpr, 0, 0);
    stageCtx.clearRect(0, 0, width, height);

    const stageRect = stage.getBoundingClientRect();
    const bgSource = activeBackdropSource();
    const bgRect = backdropCanvas?.isConnected ? backdropCanvas.getBoundingClientRect() : null;
    const scrollTop = stage.scrollTop;
    const unselectedFill = getUnselectedPillFill();

    for (let pos = 0; pos < rowEls.length; pos += 1) {
      const row = rowEls[pos];
      if (row.classList.contains('is-flying')) continue;
      const sp = lineSprings[pos].x;
      const rowAlpha = pos === anchorPos ? 1 : clamp01(3 - 1.5 * sp);
      if (rowAlpha <= 0.005) continue;

      const s = selStates[pos];
      const maskAlpha = clamp01(s.mask.x);
      const yOffset = pos === anchorPos ? 0 : (pos < anchorPos ? SHARE_OFFSET_ABOVE : SHARE_OFFSET_BELOW) * sp;
      const expandTop = Math.max(0, s.expTop.x);
      const expandBottom = Math.max(0, s.expBot.x);
      const x = row.offsetLeft;
      const y = row.offsetTop + yOffset - expandTop;
      const w = row.offsetWidth;
      const h = row.offsetHeight + expandTop + expandBottom;
      if (y + h <= 0 || y >= height) continue;

      const topRadius = Math.max(0, s.topR.x);
      const bottomRadius = Math.max(0, s.botR.x);
      const radii = [topRadius, topRadius, bottomRadius, bottomRadius];

      stageCtx.save();
      stageCtx.translate(x, y);
      if (maskAlpha < 0.995) {
        stageCtx.save();
        stageCtx.globalAlpha = rowAlpha;
        stageCtx.beginPath();
        stageCtx.roundRect(0, 0, w, h, radii);
        stageCtx.fillStyle = unselectedFill;
        stageCtx.fill();
        stageCtx.restore();
      }
      if (maskAlpha > 0.005) {
        const pillScreenRect = {
          left: stageRect.left + x,
          top: stageRect.top + y - scrollTop,
          width: w,
          height: h,
        };
        drawScreenMappedBackdrop(stageCtx, bgSource, bgRect, pillScreenRect, radii, rowAlpha * maskAlpha);
      }
      stageCtx.restore();
    }
  }

  // ---- held line flying pill (0x100267580..0x100267978) ----
  const sourceText = sourceEl?.querySelector('.lyrics-main-text') ?? sourceEl;
  const anchorRow = rowEls[anchorPos];
  let flight = null;

  function sourceGeometry() {
    if (!sourceText?.isConnected) return null;
    const rect = sourceText.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const base = Number.parseFloat(getComputedStyle(sourceEl).fontSize) || 40;
    const painted = sourceText.offsetWidth ? base * (rect.width / sourceText.offsetWidth) : base;
    return {
      left: rect.left - 14,
      top: rect.top - 4,
      right: rect.right + 14,
      bottom: rect.bottom + 4,
      textLeft: rect.left,
      textTop: rect.top,
      textRight: rect.right,
      fontPx: painted,
    };
  }

  function rowGeometry(row) {
    const rect = row.getBoundingClientRect();
    const style = getComputedStyle(row);
    const padL = Number.parseFloat(style.paddingLeft) || 0;
    const padR = Number.parseFloat(style.paddingRight) || 0;
    const padT = Number.parseFloat(style.paddingTop) || 0;
    return {
      rect,
      textLeft: rect.left + padL,
      textRight: rect.right - padR,
      textTop: rect.top + padT,
      textWidth: rect.width - padL - padR,
      fontPx: Number.parseFloat(style.fontSize) || 17,
      alignRight: style.textAlign === 'right' || style.textAlign === 'end',
    };
  }

  function makeFlyer(row) {
    const style = getComputedStyle(row);
    const wrap = document.createElement('div');
    wrap.className = 'share-lyrics-flyer';

    const canvas = document.createElement('canvas');
    canvas.className = 'share-lyrics-flyer-canvas';
    const textEl = document.createElement('div');
    textEl.className = 'share-lyrics-flyer-text';
    textEl.textContent = row.textContent;
    if (row.dir) textEl.dir = row.dir;
    textEl.style.font = style.font;
    textEl.style.letterSpacing = style.letterSpacing;
    textEl.style.lineHeight = style.lineHeight;
    textEl.style.textAlign = style.textAlign;

    wrap.append(canvas, textEl);
    document.body.append(wrap);
    return { el: wrap, canvas, ctx: canvas.getContext('2d'), textEl };
  }

  function renderFlyer(f, from, toDir, rawProgress) {
    const p = clamp01(rawProgress);
    const target = rowGeometry(f.row);

    const a = toDir === 'row' ? p : 1 - p;
    const pillLeft = lerp(from.left, target.rect.left, a);
    const pillTop = lerp(from.top, target.rect.top, a);
    const pillRight = lerp(from.right, target.rect.right, a);
    const pillBottom = lerp(from.bottom, target.rect.bottom, a);
    const pillW = Math.max(1, pillRight - pillLeft);
    const pillH = Math.max(1, pillBottom - pillTop);
    const radius = lerp(8, SHARE_PILL_OUTER_RADIUS, a);
    const shadowAlpha = lerp(0.47, 0.23, a);
    // share_render.c:3792 -> text crossfade ~ 2.2857 * p (completes by p = 0.4375)
    const textFade = clamp01(p * (20 / 9));

    f.el.style.transform = `translate3d(${pillLeft}px, ${pillTop}px, 0)`;
    f.el.style.width = `${pillW}px`;
    f.el.style.height = `${pillH}px`;
    f.el.style.borderRadius = `${radius}px`;
    f.el.style.boxShadow = `0 12px 32px rgba(0, 0, 0, ${shadowAlpha.toFixed(3)})`;

    if (f.ctx) {
      const dpr = window.devicePixelRatio || 1;
      const cw = Math.round(pillW * dpr);
      const ch = Math.round(pillH * dpr);
      if (f.canvas.width !== cw || f.canvas.height !== ch) {
        f.canvas.width = cw;
        f.canvas.height = ch;
      }
      f.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      f.ctx.clearRect(0, 0, pillW, pillH);
      const bgSource = activeBackdropSource();
      const bgRect = backdropCanvas?.isConnected ? backdropCanvas.getBoundingClientRect() : null;
      drawScreenMappedBackdrop(
        f.ctx,
        bgSource,
        bgRect,
        { left: pillLeft, top: pillTop, width: pillW, height: pillH },
        [radius, radius, radius, radius],
        1
      );
    }

    const s0 = from.fontPx / target.fontPx;
    const scaledW = target.textWidth * s0;
    const startTextX = target.alignRight ? from.textRight - scaledW : from.textLeft;
    const curTextX = lerp(startTextX, target.textLeft, a) - pillLeft;
    const curTextY = lerp(from.textTop, target.textTop, a) - pillTop;
    const curScale = lerp(s0, 1, a);

    f.textEl.style.width = `${target.textWidth}px`;
    f.textEl.style.transform = `translate3d(${curTextX}px, ${curTextY}px, 0) scale(${curScale})`;
    f.textEl.style.opacity = String(textFade);
  }

  function startFlight() {
    if (!anchorRow || reduceMotion) {
      flight = null;
      anchorRow?.classList.remove('is-flying');
      return;
    }
    flight?.el.remove();
    const from = sourceGeometry();
    if (!from) {
      flight = null;
      anchorRow.classList.remove('is-flying');
      return;
    }
    const built = makeFlyer(anchorRow);
    flight = {
      ...built,
      row: anchorRow,
      from,
      t0: performance.now(),
      response: SHARE_FLY_RESPONSE,
      done: false,
    };
    anchorRow.classList.add('is-flying');
    renderFlyer(flight, flight.from, 'row', 0);
  }

  // ---- stagger trigger & frame loop ----
  let revealed = false;
  let raf = 0;
  let last = 0;

  function triggerRowCascade() {
    revealed = true;
    for (let pos = 0; pos < lineSprings.length; pos += 1) {
      if (pos === anchorPos) continue;
      const spring = lineSprings[pos];
      if (reduceMotion) {
        spring.x = 0;
        spring.v = 0;
        spring.target = 0;
        spring.delay = 0;
        const row = rowEls[pos];
        row.style.transform = 'translate3d(0, 0, 0)';
        row.style.opacity = '1';
      } else {
        const dist = pos < start ? start - pos : pos > end ? pos - end : 0;
        spring.target = 0;
        spring.delay = dist * SHARE_ROW_STAGGER_S;
      }
      spring.triggered = true;
    }
  }

  function frame(now) {
    raf = 0;
    const dt = Math.min(0.05, (now - (last || now)) / 1000);
    last = now;
    let busy = sheet._raf !== 0 || backdropPlaying;

    if (revealed) {
      for (let pos = 0; pos < lineSprings.length; pos += 1) {
        if (pos === anchorPos) continue;
        const spring = lineSprings[pos];
        stepLineSpring(spring, dt);
        if (!lineSpringSettled(spring)) busy = true;

        const row = rowEls[pos];
        const yOffset = (pos < anchorPos ? SHARE_OFFSET_ABOVE : SHARE_OFFSET_BELOW) * spring.x;
        const alpha = clamp01(3 - 1.5 * spring.x);
        row.style.transform = Math.abs(yOffset) < 0.05
          ? 'translate3d(0, 0, 0)'
          : `translate3d(0, ${yOffset.toFixed(2)}px, 0)`;
        row.style.opacity = alpha.toFixed(3);
      }
    }

    for (let pos = 0; pos < selStates.length; pos += 1) {
      const s = selStates[pos];
      let stepDt = dt;
      if (s.delay > 0) {
        s.delay -= dt;
        if (s.delay > 0) {
          busy = true;
          continue;
        }
        stepDt = -s.delay;
        s.delay = 0;
      }
      for (const [prop, eps] of [
        [s.mask, 0.004],
        [s.topR, 0.04],
        [s.botR, 0.04],
        [s.expTop, 0.02],
        [s.expBot, 0.02],
      ]) {
        if (!springSettled(prop, prop.target, eps)) {
          stepDampedSpring(prop, prop.target, SHARE_SELECT_STIFFNESS, SHARE_SELECT_DAMPING, stepDt);
          if (!springSettled(prop, prop.target, eps)) {
            busy = true;
          } else {
            prop.x = prop.target;
            prop.v = 0;
          }
        }
      }
    }

    if (flight && !flight.done) {
      const elapsed = (now - flight.t0) / 1000;
      const p = criticalProgress(elapsed, flight.response);
      if (!revealed && p >= SHARE_REVEAL_AT) {
        triggerRowCascade();
      }
      renderFlyer(flight, flight.from, 'row', p);
      if (p > 0.997 || elapsed > 1.5) {
        flight.done = true;
        flight.el.remove();
        anchorRow.classList.remove('is-flying');
      } else {
        busy = true;
      }
    } else if (!revealed) {
      triggerRowCascade();
      busy = true;
    }

    renderSelectedBackdropPills();

    if (busy && sheet.state !== 'closed') raf = requestAnimationFrame(frame);
  }

  function kick() {
    if (!raf) {
      last = 0;
      raf = requestAnimationFrame(frame);
    }
  }

  const redrawActionGlasses = () => {
    for (const glass of actionGlasses) glass.requestDraw();
  };
  const onResize = () => {
    renderSelectedBackdropPills();
    redrawActionGlasses();
  };
  const darkMedia = actionGlasses.length ? window.matchMedia?.('(prefers-color-scheme: dark)') ?? null : null;
  stage.addEventListener('scroll', renderSelectedBackdropPills, { passive: true });
  window.addEventListener('resize', onResize);
  darkMedia?.addEventListener?.('change', redrawActionGlasses);

  const prevOnDismiss = sheet.opts.onDismiss;
  sheet.opts.onDismiss = () => {
    clearTimeout(limitTimer);
    for (const timer of actionTimers) clearTimeout(timer);
    actionTimers.clear();
    cancelAnimationFrame(raf);
    raf = 0;
    window.removeEventListener('resize', onResize);
    darkMedia?.removeEventListener?.('change', redrawActionGlasses);
    for (const glass of actionGlasses) glass.dispose();
    actionGlasses.length = 0;
    flight?.el.remove();
    flight = null;
    sheet.opts.onDismiss = prevOnDismiss ?? null;
    prevOnDismiss?.();
  };

  requestAnimationFrame(() => {
    if (anchorRow) {
      stage.scrollTop = Math.max(
        0,
        anchorRow.offsetTop - (stage.clientHeight - anchorRow.offsetHeight) * 0.5
      );
    }
    renderSelectedBackdropPills();
    redrawActionGlasses();
    startFlight();
    kick();
  });

  return root;
}

function openShareLyricsSheet(lineIndex, _line, sourceEl) {
  if (!lyricsView.lines.length || shareLyricsSheet.state !== 'closed') return;
  if (settingsSheet.state !== 'closed' || lyricsSheet.state !== 'closed') return;
  shareLyricsSheet.setContent(sheet => buildShareLyricsContent(sheet, lineIndex, sourceEl));
  void shareLyricsSheet.present();
}

let solariumSheetStylesheetEl = null;
let solariumAlertStylesheetEl = null;
let solariumUpdateStylesheetEl = null;

function ensureSolariumStylesheet(enabled) {
  if (!enabled) {
    solariumStylesheetEl?.remove();
    solariumStylesheetEl = null;
    solariumSheetStylesheetEl?.remove();
    solariumSheetStylesheetEl = null;
    solariumAlertStylesheetEl?.remove();
    solariumAlertStylesheetEl = null;
    solariumUpdateStylesheetEl?.remove();
    solariumUpdateStylesheetEl = null;
    solariumStylesheetPromise = null;
    return Promise.resolve();
  }
  if (solariumStylesheetEl?.isConnected &&
      solariumSheetStylesheetEl?.isConnected &&
      solariumAlertStylesheetEl?.isConnected &&
      solariumUpdateStylesheetEl?.isConnected &&
      solariumStylesheetPromise) {
    return solariumStylesheetPromise;
  }
  const loadLink = href => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    link.dataset.solariumStylesheet = 'true';
    const ready = new Promise(resolve => {
      const done = () => resolve();
      link.addEventListener('load', done, { once: true });
      link.addEventListener('error', done, { once: true });
    });
    document.head.appendChild(link);
    return { link, ready };
  };
  const menuLink = loadLink('solarium/menuview.css');
  const sheetLink = loadLink('solarium/sheetview.css');
  const alertLink = loadLink('solarium/alertview.css');
  const updateLink = loadLink('solarium/updateview.css');
  solariumStylesheetEl = menuLink.link;
  solariumSheetStylesheetEl = sheetLink.link;
  solariumAlertStylesheetEl = alertLink.link;
  solariumUpdateStylesheetEl = updateLink.link;
  solariumStylesheetPromise = Promise.all([menuLink.ready, sheetLink.ready, alertLink.ready, updateLink.ready]);
  return solariumStylesheetPromise;
}

function requestSolariumGlassDraw() {
  if (metadataMenu?.isOpen && typeof metadataMenu.requestDraw === 'function') {
    metadataMenu.requestDraw();
  }
  lyricsToggleGlass?.requestDraw();
}

function refreshLyricsToggleGlass() {
  if (!lyricsToggleGlass || !lyricsToggle) return;
  const rect = lyricsToggle.getBoundingClientRect();
  if (rect.height > 0) {
    lyricsToggleGlass.setCornerRadius(Math.round(rect.height / 2));
  }
  lyricsToggleGlass.requestDraw();
}

function refreshSolariumMetadataGeometry() {
  refreshLyricsToggleGlass();
  requestSolariumGlassDraw();
}

function createMetadataMenuOptions() {
  return {
    items: [
      { label: 'Resync lyrics' },
      { label: 'Settings' },
      { label: 'Lyrics' },
    ],
    onSelect: item => {
      if (item.label === 'Resync lyrics') {
        if (!window.app?.nowPlaying ||
          typeof window.app.nowPlaying.refresh !== 'function') {
          showNotice('Media resync is unavailable.');
          return;
        }
        window.app.nowPlaying.refresh().then(result => {
          showNotice(result?.ok
            ? 'Playback position resynced.'
            : 'Could not resync playback position.');
        }).catch(() => {
          showNotice('Could not resync playback position.');
        });
      } else if (item.label === 'Settings') {
        try {
          settingsSheet.setContent(buildSettingsContent);
          void settingsSheet.present();
        } catch (error) {
          console.error('[settings] Could not open Settings:', error);
          showNotice('Settings could not be opened.');
        }
      } else if (item.label === 'Lyrics') {
        lyricsSheet.setContent(sheet => buildLyricsContent(sheet));
        lyricsSheet.present();
      }
    },
  };
}

function intersectsRect(a, b) {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

function drawRoundedBox(context, el, captureRect) {
  if (!el || !el.isConnected) return;
  const rect = el.getBoundingClientRect();
  if (!rect.width || !rect.height || !intersectsRect(rect, captureRect)) return;
  const style = getComputedStyle(el);
  const opacity = Number.parseFloat(style.opacity);
  if (!opacity || opacity <= 0.01 || style.display === 'none' || style.visibility === 'hidden') return;
  if (!style.backgroundColor || style.backgroundColor === 'rgba(0, 0, 0, 0)') return;
  const radius = Math.min(Number.parseFloat(style.borderTopLeftRadius) || 0,
    rect.width / 2, rect.height / 2);
  context.save();
  context.globalAlpha = opacity;
  context.fillStyle = style.backgroundColor;
  context.beginPath();
  context.roundRect(rect.left, rect.top, rect.width, rect.height, radius);
  context.fill();
  context.restore();
}

function drawInlineSvg(context, svg, captureRect) {
  const rect = svg.getBoundingClientRect();
  if (!rect.width || !rect.height || !intersectsRect(rect, captureRect)) return;
  const style = getComputedStyle(svg);
  const opacity = Number.parseFloat(style.opacity);
  if (!opacity || opacity <= 0.01 || style.display === 'none' || style.visibility === 'hidden') return;
  const vb = svg.viewBox?.baseVal;
  const vbW = vb && vb.width ? vb.width : rect.width;
  const vbH = vb && vb.height ? vb.height : rect.height;
  context.save();
  context.globalAlpha = opacity;
  context.fillStyle = style.color || '#fff';
  context.translate(rect.left, rect.top);
  context.scale(rect.width / vbW, rect.height / vbH);
  for (const path of svg.querySelectorAll('path')) {
    const d = path.getAttribute('d');
    if (d) context.fill(new Path2D(d));
  }
  context.restore();
}

function drawAeroSkip(context, el, captureRect) {
  const rect = el.getBoundingClientRect();
  if (!rect.width || !rect.height || !intersectsRect(rect, captureRect)) return;
  const style = getComputedStyle(el);
  const btnStyle = el.parentElement ? getComputedStyle(el.parentElement) : style;
  const opacity = (Number.parseFloat(style.opacity) || 1) * (Number.parseFloat(btnStyle.opacity) || 1);
  if (!opacity || opacity <= 0.01 || style.display === 'none' || style.visibility === 'hidden') return;
  const backward = el.dataset.direction === 'backward';
  context.save();
  context.globalAlpha = opacity;
  context.fillStyle = style.color || btnStyle.color || '#fff';
  context.translate(rect.left + rect.width / 2, rect.top + rect.height / 2);
  if (backward) context.scale(-1, 1);
  const hw = rect.width * 0.42;
  const hh = rect.height * 0.36;
  for (const ox of [-hw * 0.48, hw * 0.08]) {
    context.beginPath();
    context.moveTo(ox, -hh);
    context.lineTo(ox + hw * 0.56, 0);
    context.lineTo(ox, hh);
    context.closePath();
    context.fill();
  }
  context.restore();
}

function captureMenuScene(context, { captureLeft, captureTop, captureWidth, captureHeight }) {
  const captureRect = {
    left: captureLeft,
    top: captureTop,
    right: captureLeft + captureWidth,
    bottom: captureTop + captureHeight,
  };

  // Composite album artwork (video or image) beneath the glass menu.
  const artEl = artworkVideo.classList.contains('is-visible') && artworkVideo.readyState >= 2
    ? artworkVideo
    : (artworkImage.complete && artworkImage.naturalWidth > 0 ? artworkImage : null);
  if (artEl) {
    const style = getComputedStyle(artEl);
    const opacity = Number.parseFloat(style.opacity);
    const rect = artEl.getBoundingClientRect();
    if (opacity > 0.01 && style.display !== 'none' && style.visibility !== 'hidden' &&
        rect.width > 0 && rect.height > 0 && intersectsRect(rect, captureRect)) {
      const radius = Math.min(Number.parseFloat(style.borderTopLeftRadius) || 0,
        rect.width / 2, rect.height / 2);
      context.save();
      context.globalAlpha = opacity;
      context.beginPath();
      context.roundRect(rect.left, rect.top, rect.width, rect.height, radius);
      context.clip();
      context.drawImage(artEl, rect.left, rect.top, rect.width, rect.height);
      context.restore();
    }
  }

  // Composite progress track/fill, volume bar, and playback controls.
  drawRoundedBox(context, progress, captureRect);
  drawRoundedBox(context, progress?.querySelector('.progress-fill'), captureRect);
  for (const btn of document.querySelectorAll('.playback-controls button')) {
    drawRoundedBox(context, btn, captureRect);
  }
  for (const svg of document.querySelectorAll('.playback-controls svg, .volume-control svg')) {
    drawInlineSvg(context, svg, captureRect);
  }
  for (const skip of document.querySelectorAll('.playback-controls .aero-skip')) {
    drawAeroSkip(context, skip, captureRect);
  }

  // Composite visible metadata, timestamps, notices and lyric lines behind the glass menu.
  const textTargets = [
    titleLabel,
    artistLabel,
    elapsed,
    remaining,
    noticeElement,
    ...lyricsElement.querySelectorAll('.lyrics-line'),
  ];
  for (const el of textTargets) {
    if (!el || !el.isConnected) continue;
    const rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height || !intersectsRect(rect, captureRect)) continue;
    const lineStyle = getComputedStyle(el);
    const lineOpacity = Number.parseFloat(lineStyle.opacity);
    if (!lineOpacity || lineOpacity <= 0.01 || lineStyle.display === 'none' || lineStyle.visibility === 'hidden') continue;
    const spans = el.classList.contains('lyrics-line')
      ? el.querySelectorAll('.lyrics-word, .lyrics-background-word, .lyrics-translation, .lyrics-romanized')
      : el.querySelectorAll('.marquee-track > span:first-child');
    const nodes = spans.length ? [...spans] : [el];
    const fallbackColor = el === titleLabel
      ? 'rgba(255, 255, 255, 0.92)'
      : el.classList.contains('is-active')
        ? 'rgba(255, 255, 255, 0.92)'
        : 'rgba(255, 255, 255, 0.6)';
    context.save();
    if (lineStyle.filter && lineStyle.filter !== 'none') {
      context.filter = lineStyle.filter;
    }
    for (const node of nodes) {
      const text = node.textContent;
      if (!text || !text.trim()) continue;
      const r = node === el ? rect : node.getBoundingClientRect();
      if (!r.width || !r.height || !intersectsRect(r, captureRect)) continue;
      const style = node === el ? lineStyle : getComputedStyle(node);
      const opacity = (node === el ? lineOpacity : lineOpacity * (Number.parseFloat(style.opacity) || 1));
      if (!opacity || opacity <= 0.01) continue;
      const fill = style.webkitTextFillColor && style.webkitTextFillColor !== 'rgba(0, 0, 0, 0)'
        ? style.webkitTextFillColor
        : (style.color && style.color !== 'rgba(0, 0, 0, 0)' ? style.color : fallbackColor);
      context.globalAlpha = opacity;
      context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      context.fillStyle = fill;
      context.textBaseline = 'middle';
      context.fillText(text, r.left, r.top + r.height / 2, r.width);
    }
    context.restore();
  }
}

function captureSheetMenuScene(context, { captureLeft, captureTop, captureWidth, captureHeight }) {
  const captureRect = {
    left: captureLeft,
    top: captureTop,
    right: captureLeft + captureWidth,
    bottom: captureTop + captureHeight,
  };
  const sheet = document.querySelector('.sheetview');
  if (!sheet) return;
  drawRoundedBox(context, sheet, captureRect);
  for (const group of sheet.querySelectorAll('.sheet-group')) {
    drawRoundedBox(context, group, captureRect);
  }
  for (const el of sheet.querySelectorAll('.sheet-heading, .sheet-row > span')) {
    const rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height || !intersectsRect(rect, captureRect)) continue;
    const style = getComputedStyle(el);
    const opacity = Number.parseFloat(style.opacity);
    if (!opacity || opacity <= 0.01 || style.display === 'none' || style.visibility === 'hidden') continue;
    const text = el.textContent;
    if (!text || !text.trim()) continue;
    context.save();
    context.globalAlpha = opacity;
    context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    context.fillStyle = style.color;
    context.textBaseline = 'middle';
    context.fillText(text, rect.left, rect.top + rect.height / 2, rect.width);
    context.restore();
  }
}

function captureAlertScene(context, capture) {
  captureMenuScene(context, capture);
  if (document.querySelector('.sheetview')) {
    context.save();
    context.fillStyle = 'rgba(0, 0, 0, 0.24)';
    context.fillRect(capture.captureLeft, capture.captureTop, capture.captureWidth, capture.captureHeight);
    context.restore();
    captureSheetMenuScene(context, capture);
  }
  context.save();
  context.fillStyle = isSheetDark() ? 'rgba(0, 0, 0, 0.28)' : 'rgba(0, 0, 0, 0.18)';
  context.fillRect(capture.captureLeft, capture.captureTop, capture.captureWidth, capture.captureHeight);
  context.restore();
}

function solariumAlertOptions(options = {}) {
  if (solariumDisabledForSession || !solariumModule) return null;
  return {
    source: backdropCanvas?.isConnected ? backdropCanvas : null,
    sourceBounds: () => backdropCanvas.getBoundingClientRect(),
    onCapture: captureAlertScene,
    ...options,
  };
}

function iosAlert(options) {
  const solOpts = solariumAlertOptions(options);
  if (solOpts && solariumModule?.alert) {
    return solariumModule.alert(solOpts);
  }
  return baseAlert(options);
}

function iosConfirm(title, message, options = {}) {
  const solOpts = solariumAlertOptions(options);
  if (solOpts && solariumModule?.confirm) {
    return solariumModule.confirm(title, message, solOpts);
  }
  return baseConfirm(title, message, options);
}

function iosPrompt(title, message, options = {}) {
  const solOpts = solariumAlertOptions(options);
  if (solOpts && solariumModule?.prompt) {
    return solariumModule.prompt(title, message, solOpts);
  }
  return basePrompt(title, message, options);
}

function buildUpdateCard(info, handlers = {}) {
  if (!solariumDisabledForSession && solariumModule?.buildUpdateCard) {
    return solariumModule.buildUpdateCard(info, handlers);
  }
  return baseBuildUpdateCard(info, handlers);
}

async function presentUpdate(info, handlers = {}) {
  if (!solariumDisabledForSession && !solariumModule) {
    try {
      await loadSolarium();
    } catch { }
  }
  if (!solariumDisabledForSession && solariumModule?.presentUpdate) {
    return solariumModule.presentUpdate(info, handlers);
  }
  return basePresentUpdate(info, handlers);
}

async function loadSolarium() {
  if (!solariumModulePromise) {
    solariumModulePromise = import('./solarium/index.js').then(mod => {
      solariumModule = mod;
      return mod;
    });
  }
  const [solarium] = await Promise.all([
    solariumModulePromise,
    ensureSolariumStylesheet(true),
  ]);
  return solarium;
}

function syncActiveSheetMenus() {
  for (const entry of activeSheetMenus) {
    if (!entry.row.isConnected) {
      entry.destroy?.();
      activeSheetMenus.delete(entry);
      continue;
    }
    entry.sync();
  }
}
window.matchMedia?.('(prefers-color-scheme: dark)')?.addEventListener?.('change', syncActiveSheetMenus);

function metadataMenuPlacement() {
  if (uiStyle !== 'macos') return 'morph-end';
  return document.body.classList.contains('is-lyrics-hidden') ? 'morph-end' : 'morph-start';
}

function shouldUseSolariumLyricsToggle() {
  if (solariumDisabledForSession || !lyricsToggle) return false;
  const style = document.body.dataset.uiStyle;
  if (style === 'tvos') return false;
  if (style === 'ios') return document.body.classList.contains('is-ipados-landscape');
  return true;
}

function teardownLyricsToggleGlass() {
  lyricsToggleGlass?.dispose();
  lyricsToggleGlass = null;
  lyricsToggle?.classList.remove('is-solarium-glass');
}

function syncSolariumLyricsToggle() {
  if (!shouldUseSolariumLyricsToggle()) {
    teardownLyricsToggleGlass();
    return;
  }
  if (!solariumModule) {
    lyricsToggle.classList.add('is-solarium-glass');
    return;
  }
  if (lyricsToggleGlass) {
    refreshLyricsToggleGlass();
    return;
  }
  mountSolariumLyricsToggle(solariumModule);
}

function lyricsToggleMaterial(LiquidGlass) {
  const base = LiquidGlass.regular();
  return new LiquidGlass({
    uniforms: {
      ...base.uniforms,
      glassThickness: 11,
      refractiveIndex: 1.54,
      dispersionStrength: 6,
      glareDistanceRange: 20,
      glareAngleConvergence: 0.28,
      glareOppositeSideBias: 0.85,
      glareIntensity: 0.16,
      glareEdgeSharpness: -0.06,
    },
    backgroundTextureSizeCoefficient: 1,
    backgroundTextureScaleCoefficient: 0.35,
    backgroundTextureBlurRadius: 2.2,
    backdropTone: () => [1.16, 1.04],
    tintColor: () => [0.06, 0.08, 0.08, 0.12],
  });
}

function mountSolariumLyricsToggle(solarium) {
  teardownLyricsToggleGlass();
  if (!lyricsToggle || !solarium) return;
  const { LiquidGlass, LiquidGlassView } = solarium;
  lyricsToggle.classList.add('is-solarium-glass');
  const rect = lyricsToggle.getBoundingClientRect();
  const radius = Math.round((rect.height || 44) / 2);
  lyricsToggleGlass = new LiquidGlassView(lyricsToggleMaterial(LiquidGlass), {
    source: backdropCanvas?.isConnected ? backdropCanvas : null,
    sourceBounds: () => backdropCanvas.getBoundingClientRect(),
    onCapture: captureMenuScene,
    cornerRadius: radius,
    interactive: true,
    pressTransformTarget: lyricsToggle,
    pressScaleAmount: 0.08,
  });
  lyricsToggleGlass.element.className = 'solarium-lyrics-toggle__glass';
  Object.assign(lyricsToggleGlass.element.style, {
    position: 'absolute',
    inset: '0',
    zIndex: '0',
    pointerEvents: 'none',
  });
  lyricsToggleGlass.element.setAttribute('aria-hidden', 'true');
  lyricsToggle.prepend(lyricsToggleGlass.element);
  lyricsToggleGlass.requestDraw();
}

function teardownMetadataMenu() {
  metadataMenu?.destroy();
  metadataMenu = null;
  metadataMenuToggle.classList.remove('is-solarium-glass');
}

function syncSolariumSheets() {
  const useSolarium = !solariumDisabledForSession && Boolean(solariumModule);
  const SheetCtor = useSolarium ? solariumModule.SheetView : SheetView;
  const swap = (sheet, extra) => {
    const opts = extra ? { ...sheetBaseOptions, ...extra } : sheetBaseOptions;
    if (sheet instanceof SheetCtor && (!useSolarium || sheet.constructor === SheetCtor)) {
      sheet.el.classList.toggle('solarium-sheetview', useSolarium);
      return sheet;
    }
    if (sheet.state !== 'closed') {
      sheet.el.classList.toggle('solarium-sheetview', useSolarium);
      return sheet;
    }
    return new SheetCtor(opts);
  };
  settingsSheet = swap(settingsSheet, { title: 'Settings' });
  lyricsSheet = swap(lyricsSheet, { fitContent: true, title: 'Lyrics' });
  shareLyricsSheet = swap(shareLyricsSheet, { title: 'Share Lyrics', maxWidth: 440 });
  shareLyricsSheet.el.classList.add('share-lyrics-sheet');
}

function mountStandardMetadataMenu() {
  teardownMetadataMenu();
  teardownLyricsToggleGlass();
  ensureSolariumStylesheet(false);
  syncSolariumSheets();
  metadataMenu = new MenuView(metadataMenuToggle, createMetadataMenuOptions());
}

async function syncSolariumMetadataControl() {
  const generation = ++solariumSyncGeneration;
  if (solariumDisabledForSession) {
    mountStandardMetadataMenu();
    return;
  }

  // Hide the resting button background immediately when Solarium is enabled
  // so it never flashes before the Solarium module finishes loading.
  metadataMenuToggle.classList.add('is-solarium-glass');
  syncSolariumLyricsToggle();

  // Mount the standard menu synchronously so the button is interactive right
  // away while Solarium loads, or if Solarium is unavailable in a build.
  if (!metadataMenu) {
    metadataMenu = new MenuView(metadataMenuToggle, createMetadataMenuOptions());
  }

  try {
    const solarium = await loadSolarium();
    if (generation !== solariumSyncGeneration || solariumDisabledForSession) {
      return;
    }

    const { MenuView: SolariumMenuView } = solarium;
    const source = backdropCanvas?.isConnected ? backdropCanvas : null;
    const sourceBounds = () => backdropCanvas.getBoundingClientRect();

    syncSolariumSheets();
    teardownMetadataMenu();
    syncSolariumLyricsToggle();
    // Only the icon is visible on the resting button (like Apple Music);
    // SolariumMenuView morphs out of the button into Liquid Glass on press.
    metadataMenuToggle.classList.add('is-solarium-glass');

    metadataMenu = new SolariumMenuView(metadataMenuToggle, {
      ...createMetadataMenuOptions(),
      source,
      sourceBounds,
      onCapture: captureMenuScene,
      theme: 'dark',
      placement: metadataMenuPlacement(),
      onMenuWillCreate: () => {
        if (metadataMenu?.opts) {
          metadataMenu.opts.placement = metadataMenuPlacement();
        }
      },
    });
  } catch (error) {
    console.warn('[solarium] Falling back to standard MenuView:', error);
    if (generation === solariumSyncGeneration) {
      mountStandardMetadataMenu();
    }
  }
}

function promptSolariumRestart() {
  const message = 'Changing Solarium requires restarting yourLyrics to take effect.';
  if (typeof window.app?.relaunch === 'function') {
    iosConfirm('Restart Required', message, {
      confirmText: 'Restart',
      cancelText: 'Later',
    }).then(ok => {
      if (ok) {
        window.app.relaunch().catch(() => { });
      }
    });
    return;
  }
  iosAlert({
    title: 'Restart Required',
    message,
  });
}

function setDisableSolarium(disabled, persist = true, promptRestart = true) {
  const next = Boolean(disabled);
  const changed = next !== disableSolarium;
  disableSolarium = next;
  if (persist) {
    persistSettings(true);
  }
  if (changed && promptRestart && next !== solariumDisabledForSession) {
    promptSolariumRestart();
  }
}

void syncSolariumMetadataControl();

function syncLyricInteraction() {
  const style = document.body.dataset.uiStyle;
  const idle = (style === 'ios' && document.body.classList.contains('is-ios-idle')) ||
    (style === 'tvos' && document.body.classList.contains('is-tvos-idle'));
  lyricsView.setInteractionEnabled(!idle);
}

tvosControls = createTvosControlsAutoHide(document.body, () =>
  dragging || Boolean(document.querySelector('.sheetview, .menuview, .alertview, .stage.is-ui-switching')) ||
  Boolean(document.activeElement?.matches(':focus-visible') &&
    document.activeElement.closest('.progress, .metadata-menu, .lyrics-toggle')),
  { onIdleChange: syncLyricInteraction }
);
window.addEventListener('beforeunload', () => tvosControls.dispose());

iosControls = createTvosControlsAutoHide(document.body, () =>
  dragging || Boolean(document.querySelector('.sheetview, .menuview, .alertview, .stage.is-ui-switching')) ||
  Boolean(document.activeElement?.matches(':focus-visible') && document.activeElement.closest('button, input, .progress')),
  { style: 'ios', idleClass: 'is-ios-idle', idleMs: 2500,
    // iPadOS keeps its transport visible and its lyric lines interactive in
    // both orientations instead of entering the phone auto-hide idle state.
    enabled: () => lyricsVisible && document.body.dataset.uiVariant !== 'ipados', onIdleChange: syncLyricInteraction }
);
window.addEventListener('beforeunload', () => iosControls.dispose());

if (window.app && window.app.nowPlaying) {
  let receivedMediaEvent = false;
  window.app.nowPlaying.get().then(snapshot => {
    if (!receivedMediaEvent) applyNowPlaying(snapshot);
  }).catch(() => { });
  window.app.nowPlaying.onChanged(snapshot => {
    receivedMediaEvent = true;
    applyNowPlaying(snapshot);
  });
}

// Reveal after local assets are ready. A slow media IPC must not keep a
// usable window black, and warm launches need no mandatory one-second hold.
void (async () => {
  await Promise.race([
    Promise.allSettled([startupBackdropReady, document.fonts.ready]),
    new Promise(resolve => setTimeout(resolve, 1000))
  ]);
  const page = document.querySelector('#app');
  document.body.classList.replace('is-startup-pending', 'is-startup-revealing');
  const finish = event => {
    if (event.target !== page) return;
    if (event.animationName !== 'startup-reveal' &&
      event.animationName !== 'startup-reveal-reduced') return;
    document.body.classList.remove('is-startup-revealing');
    page.removeEventListener('animationend', finish);
  };
  page.addEventListener('animationend', finish);
})();

if (window.app && window.app.updates) {
  window.app.updates.version().then(version => {
    if (version) {
      currentAppVersion = version;
    }
  }).catch(() => { });
  window.app.updates.onProgress(payload => {
    const percent = payload && Number.isFinite(payload.percent)
      ? Math.round(payload.percent)
      : 0;
    showNotice(`Downloading update… ${percent}%`);
  });
  window.app.updates.onDownloaded(() => {
    updateDownloadStarted = false;
    iosConfirm(
      'Update Ready',
      'Restart yourLyrics to finish installing.',
      { confirmText: 'Restart' }
    ).then(ok => {
      if (ok && window.app && window.app.updates) {
        window.app.updates.restart().catch(() => { });
      }
    });
  });
  window.app.updates.onFailed(() => {
    updateDownloadStarted = false;
    showNotice('Update could not be started.');
  });
  // Delayed so the alert never races the initial now-playing and lyrics load.
  window.setTimeout(() => {
    checkForUpdates(false);
  }, 2500);
}
