/* AeroUI player button (MIT). Source:
 * https://nurislamaibekuly.github.io/aeroui/src/components/player-button/player-button.js
 * PressGesture + dual-scale press, symbol replacement, native keyboard/AT input.
 */
import { animate } from '../../core/motion.js';
import { PATTERNS } from '../../core/haptics.js';

const HIDE_DELAY_MS = 200;
const ECHO_GUARD_MS = 600;
const PRESS_SPRING = { duration: 0.9, bounce: 0.6 };

function isDisabled(el) {
  return el.disabled === true || el.hasAttribute('data-disabled');
}

function intervalSec(el) {
  const v = Number(el.dataset.interval);
  return Number.isNaN(v) || v <= 0 ? 0.1 : v;
}

function ensureLabel(el) {
  let label = el.querySelector(':scope > .aero-player-label');
  if (!label) {
    label = document.createElement('span');
    label.className = 'aero-player-label';
    while (el.firstChild) label.append(el.firstChild);
    el.append(label);
  }
  return label;
}

function ensureSymbol(label) {
  let symbol = label.querySelector(':scope > .aero-player-symbol');
  if (!symbol) {
    symbol = document.createElement('span');
    symbol.className = 'aero-player-symbol';
    while (label.firstChild) symbol.append(label.firstChild);
    label.append(symbol);
  }
  return symbol;
}

function emit(el, type, detail) {
  el.dispatchEvent(new CustomEvent(type, { bubbles: true, detail }));
}

function tap(el) {
  const p = el.dataset.haptics;
  if (!p || p === 'off') return;
  if ('vibrate' in navigator) {
    try { navigator.vibrate(PATTERNS[p] ?? PATTERNS.light); } catch { /* noop */ }
  }
}

function reducedMotion() {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

function currentScale(el) {
  try {
    const value = new DOMMatrix(getComputedStyle(el).transform).a;
    return Number.isFinite(value) ? value : 1;
  }
  catch { return 1; }
}

function scaleTo(inst, pressed) {
  const fromBtn = currentScale(inst.el);
  const fromLabel = currentScale(inst.label);
  const toBtn = pressed ? 0.85 : 1;
  const toLabel = pressed ? 0.9 : 1;
  inst._btnAnim?.cancel();
  inst._labelAnim?.cancel();
  if (reducedMotion()) {
    inst.el.style.removeProperty('transform');
    inst.label.style.removeProperty('transform');
    return;
  }
  try {
    inst._btnAnim = animate(inst.el,
      [{ transform: `scale(${fromBtn})` }, { transform: `scale(${toBtn})` }],
      { spring: PRESS_SPRING });
    inst._labelAnim = animate(inst.label,
      [{ transform: `scale(${fromLabel})` }, { transform: `scale(${toLabel})` }],
      { spring: PRESS_SPRING });
  } catch {
    inst.el.style.transform = `scale(${toBtn})`;
    inst.label.style.transform = `scale(${toLabel})`;
  }
}

// Sample a damped spring once; icon changes then run entirely as compositor
// transforms. The outgoing icon clears quickly before the delayed spring-in.
function iconSpring() {
  const mass = 1;
  const stiffness = 260;
  const damping = 20;
  const omega = Math.sqrt(stiffness / mass);
  const zeta = damping / (2 * Math.sqrt(stiffness * mass));
  const damped = omega * Math.sqrt(1 - zeta * zeta);
  const duration = Math.log(500) / (zeta * omega);
  const points = Array.from({ length: 71 }, (_value, index) => {
    const time = index / 70 * duration;
    return Number((1 - Math.exp(-zeta * omega * time) *
      (Math.cos(damped * time) + zeta * omega / damped * Math.sin(damped * time))).toFixed(4));
  });
  points[70] = 1;
  return { duration: duration * 1000, easing: `linear(${points.join(', ')})` };
}
const ICON_SPRING = iconSpring();

function beginPress(inst) {
  const { el } = inst;
  if (isDisabled(el) || inst.held) return false;
  clearTimeout(inst.hideT);
  inst.held = true;
  inst.downT = performance.now();
  el.classList.add('aero-player--pressed', 'aero-player--circle');
  scaleTo(inst, true);
  tap(el);
  emit(el, 'pressstart', {});
  const ms = intervalSec(el) * 1000;
  clearInterval(inst.timer);
  inst.timer = setInterval(() => {
    if (!inst.held) return;
    emit(el, 'pressing', { elapsed: (performance.now() - inst.downT) / 1000 });
  }, ms);
  return true;
}

function endPress(inst, { cancelled = false } = {}) {
  const { el } = inst;
  if (!inst.held) return false;
  inst.held = false;
  clearInterval(inst.timer);
  inst.lastEnd = Date.now();
  const elapsed = (performance.now() - inst.downT) / 1000;
  el.classList.remove('aero-player--pressed');
  if (!cancelled) emit(el, 'pressend', { elapsed });
  // Release begins in the same event, even for a very short tap. A minimum
  // hold would keep the button shrinking after the pointer has already lifted.
  scaleTo(inst, false);
  clearTimeout(inst.hideT);
  inst.hideT = setTimeout(() => el.classList.remove('aero-player--circle'), HIDE_DELAY_MS);
  return true;
}

function initPlayerButton(el) {
  if (el._aeroPlayer) return el._aeroPlayer;
  if (!/^(BUTTON|A)$/.test(el.tagName)) {
    el.setAttribute('role', el.getAttribute('role') || 'button');
    if (!el.hasAttribute('tabindex')) el.tabIndex = isDisabled(el) ? -1 : 0;
  }
  const label = ensureLabel(el);
  const symbol = ensureSymbol(label);
  const inst = {
    el, label, symbol, held: false, downT: 0, timer: null, hideT: null,
    lastEnd: 0, _iconAnimations: [], icons: null, iconName: null,
  };
  el._aeroPlayer = inst;
  // Honour a preference change during a running transition, not just on the
  // next gesture. Cancellation restores the CSS resting state immediately.
  window.matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', event => {
    if (!event.matches) return;
    inst._btnAnim?.cancel();
    inst._labelAnim?.cancel();
    inst._iconAnimations.forEach(animation => animation.cancel());
    inst._iconAnimations = [];
    el.style.removeProperty('transform');
    label.style.removeProperty('transform');
  });
  el.addEventListener('pointerdown', e => {
    if (isDisabled(el)) return;
    if (e.button !== undefined && e.button !== 0) return;
    e.preventDefault();
    try { el.focus({ preventScroll: true, focusVisible: false }); }
    catch { try { el.focus(); } catch { /* noop */ } }
    try { el.setPointerCapture(e.pointerId); } catch { /* noop */ }
    inst._pointerId = e.pointerId;
    beginPress(inst);
  });
  el.addEventListener('pointerup', e => {
    if (inst._pointerId !== undefined && e.pointerId !== inst._pointerId) return;
    inst._pointerId = undefined;
    endPress(inst);
  });
  el.addEventListener('pointercancel', () => {
    inst._pointerId = undefined;
    endPress(inst, { cancelled: true });
  });
  el.addEventListener('lostpointercapture', () => {
    inst._pointerId = undefined;
    endPress(inst, { cancelled: true });
  });
  el.addEventListener('contextmenu', e => {
    if (inst.held) e.preventDefault();
  });
  el.addEventListener('keydown', e => {
    if (isDisabled(el) || e.repeat) return;
    if (e.key !== ' ' && e.key !== 'Enter') return;
    e.preventDefault();
    beginPress(inst);
  });
  el.addEventListener('keyup', e => {
    if (e.key !== ' ' && e.key !== 'Enter') return;
    e.preventDefault();
    endPress(inst);
  });
  el.addEventListener('click', () => {
    if (isDisabled(el) || inst.held) return;
    if (Date.now() - inst.lastEnd < ECHO_GUARD_MS) return;
    if (beginPress(inst)) endPress(inst);
  });
  return inst;
}

function initPlayerButtons(root = document) {
  root.querySelectorAll('.aero-player').forEach(initPlayerButton);
}

document.addEventListener('DOMContentLoaded', () => initPlayerButtons());

const PLAYER_ICONS = {
  play: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M4 6.8 4 17.2Q4 21 7.31 19.14L18.26 12.98Q20 12 18.26 11.02L7.31 4.86Q4 3 4 6.8Z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="5.27" y="3" width="5.45" height="18" rx="1.3"/><rect x="13.28" y="3" width="5.45" height="18" rx="1.3"/></svg>',
};

function setPlayerIcon(el, name) {
  const inst = el._aeroPlayer ?? initPlayerButton(el);
  const next = name === 'pause' ? 'pause' : 'play';
  el.setAttribute('aria-label', next === 'pause' ? 'Pause' : 'Play');
  el.setAttribute('aria-pressed', String(next === 'pause'));
  if (inst.iconName === next) return;
  if (!inst.icons) {
    inst.symbol.classList.add('aero-player-symbol--toggle');
    inst.symbol.innerHTML = PLAYER_ICONS.play + PLAYER_ICONS.pause;
    inst.icons = Object.fromEntries(['play', 'pause'].map((key, index) => {
      const icon = inst.symbol.children[index];
      icon.classList.add('aero-player-icon');
      icon.dataset.icon = key;
      return [key, icon];
    }));
  }
  // Read both layers before cancelling a previous swap, so quick reversals
  // continue from the scales currently visible rather than jumping to 0 or 1.
  const from = Object.fromEntries(Object.entries(inst.icons).map(([key, icon]) =>
    [key, currentScale(icon)]
  ));
  inst._iconAnimations.forEach(animation => animation.cancel());
  inst._iconAnimations = [];
  const previous = inst.iconName;
  inst.iconName = next;
  for (const [key, icon] of Object.entries(inst.icons)) {
    icon.classList.toggle('is-current', key === next);
  }
  if (!previous || reducedMotion()) return;
  inst._iconAnimations = [
    inst.icons[previous].animate([
      { transform: `scale(${from[previous]})` }, { transform: 'scale(0)' }
    ], { duration: 130, easing: 'cubic-bezier(0.4, 0, 1, 1)', fill: 'both' }),
    inst.icons[next].animate([
      { transform: `scale(${from[next]})` }, { transform: 'scale(1)' }
    ], { ...ICON_SPRING, delay: 70, fill: 'both' })
  ];
  const animations = inst._iconAnimations;
  Promise.all(animations.map(animation => animation.finished)).then(() => {
    if (inst._iconAnimations !== animations) return;
    animations.forEach(animation => animation.cancel());
    inst._iconAnimations = [];
  }).catch(() => {});
}

export { initPlayerButtons, initPlayerButton, PLAYER_ICONS, setPlayerIcon };
