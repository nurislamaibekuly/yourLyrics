// Animate only overflowing text, leaving the label's position and collapse
// transforms independent. The endpoints pause so both ends remain readable.
export function createMetadataMarquee(labels, motion, onChange = () => {}) {
  const states = new Map();
  let frame = 0;
  const observer = new MutationObserver(schedule);
  const resize = new ResizeObserver(schedule);

  function reset(label, state) {
    state?.animation.cancel();
    if (label.classList.contains('is-marquee')) {
      const text = label.textContent;
      label.classList.remove('is-marquee');
      label.textContent = text;
      onChange();
    }
    states.delete(label);
  }

  function refresh() {
    frame = 0;
    for (const label of labels) {
      const text = label.textContent || '';
      const style = getComputedStyle(label);
      const width = label.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0);
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d');
      context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      const naturalWidth = context.measureText(text).width + Math.max(0, text.length - 1) * (parseFloat(style.letterSpacing) || 0);
      const state = states.get(label);
      const key = JSON.stringify([text, width, context.font, style.letterSpacing, style.direction]);
      if (document.body.dataset.uiStyle === 'tvos' || motion.matches || width <= 0 || naturalWidth <= width + 1 || !text.trim()) {
        reset(label, state);
        continue;
      }
      if (state?.key === key && label.contains(state.content)) continue;
      reset(label, state);
      label.classList.add('is-marquee');
      const content = document.createElement('span');
      content.className = 'metadata-marquee-text';
      content.textContent = text;
      const viewport = document.createElement('span');
      viewport.className = 'metadata-marquee-viewport';
      viewport.append(content);
      label.replaceChildren(viewport);
      // The viewport extends left while its content starts at the original
      // label position. Keep the final word inside the stationary right fade.
      const distance = Math.max(0, content.offsetWidth + 10 - width);
      const travel = Math.max(1800, distance / 28 * 1000);
      const duration = travel * 2 + 2800;
      const pause = 1400 / duration;
      const turn = (1400 + travel) / duration;
      const end = style.direction === 'rtl' ? distance : -distance;
      const animation = content.animate([
        { transform: 'translate3d(0, 0, 0)', offset: 0 },
        { transform: 'translate3d(0, 0, 0)', offset: pause },
        { transform: `translate3d(${end}px, 0, 0)`, offset: turn },
        { transform: `translate3d(${end}px, 0, 0)`, offset: turn + pause },
        { transform: 'translate3d(0, 0, 0)', offset: 1 }
      ], { duration, iterations: Infinity, easing: 'linear' });
      states.set(label, { key, animation, content });
      onChange();
    }
    // Ignore our own span replacement; metadata changes still schedule a new
    // measurement, including track updates that replace the span entirely.
    observer.takeRecords();
  }

  function schedule() {
    if (!frame) frame = requestAnimationFrame(refresh);
  }
  for (const label of labels) {
    observer.observe(label, { childList: true, characterData: true, subtree: true });
    resize.observe(label);
  }
  const appearance = new MutationObserver(schedule);
  appearance.observe(document.body, { attributes: true, attributeFilter: ['class', 'data-ui-style', 'style'] });
  motion.addEventListener('change', schedule);
  document.fonts.ready.then(schedule);
  schedule();
  return { refresh: schedule, dispose() {
    cancelAnimationFrame(frame);
    observer.disconnect();
    appearance.disconnect();
    resize.disconnect();
    motion.removeEventListener('change', schedule);
    for (const label of labels) reset(label, states.get(label));
  } };
}
