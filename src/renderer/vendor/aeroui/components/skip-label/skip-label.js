/* AeroUI animated skip label (MIT). See ../../LICENSE.
 * Fixed-size triangles exchange places using independent insertion/removal
 * transforms, so the sweep never recalculates layout during a click.
 */
const SKIP_GLYPH = '<svg viewBox="4 3 16 18" fill="currentColor" aria-hidden="true"><path d="M4 6.8 4 17.2Q4 21 7.31 19.14L18.26 12.98Q20 12 18.26 11.02L7.31 4.86Q4 3 4 6.8Z"/></svg>';
const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function reset(inst) {
  for (const animation of inst.animations) animation.cancel();
  inst.animations = [];
  inst.running = false;
  inst.el.classList.remove('aero-skip--animating');
}

function initSkipLabel(el) {
  if (el._aeroSkip) return el._aeroSkip;
  const inst = { el, animations: [], running: false, parts: {} };
  el._aeroSkip = inst;
  el.classList.toggle('aero-skip--backward', el.dataset.direction === 'backward');
  const size = Number(el.dataset.size);
  if (size > 0) el.style.setProperty('--skip-size', `${size}px`);
  el.textContent = '';
  for (const phase of ['exit-left', 'exit-right', 'enter-left']) {
    const arrow = document.createElement('span');
    arrow.className = 'aero-skip-arrow';
    arrow.dataset.phase = phase;
    arrow.innerHTML = SKIP_GLYPH;
    el.append(arrow);
    inst.parts[phase] = arrow;
  }
  window.matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', event => {
    if (event.matches) reset(inst);
  });
  return inst;
}

function playSkip(el, options = {}) {
  const inst = el._aeroSkip || initSkipLabel(el);
  if (reduceMotion()) { reset(inst); return; }
  // Ignore another visual trigger until the existing handoff settles. Playback
  // commands remain independent, and no delayed sweep runs after a rapid click.
  if (inst.running) return;
  inst.running = true;
  el.classList.add('aero-skip--animating');
  const duration = Math.max(0.1, Number(options.duration ?? el.dataset.duration) || 0.6) * 1000;
  const handoff = { duration, easing: 'cubic-bezier(0.4, 1.51, 0.4, 1)', fill: 'both' };
  inst.animations = [
    inst.parts['exit-left'].animate([
      { transform: 'translateX(0%)' },
      { transform: 'translateX(100%)' }
    ], handoff),
    inst.parts['exit-right'].animate([
      { transform: 'scale(1)', opacity: 1 },
      { transform: 'scale(0)', opacity: 0 }
    ], { duration: duration / 3, easing: 'ease-out', fill: 'both' }),
    inst.parts['enter-left'].animate([
      { transform: 'scale(0) translateX(-37.5%)', opacity: 0 },
      { transform: 'scale(1) translateX(0%)', opacity: 1 }
    ], handoff)
  ];
  Promise.all(inst.animations.map(animation => animation.finished)).then(() => {
    reset(inst);
  }).catch(() => {});
}

function initSkipLabels(root = document) {
  root.querySelectorAll('.aero-skip').forEach(initSkipLabel);
}

document.addEventListener('DOMContentLoaded', () => initSkipLabels());
export { initSkipLabels, initSkipLabel, playSkip };
