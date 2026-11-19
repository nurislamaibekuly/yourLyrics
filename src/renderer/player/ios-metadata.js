// Commit the destination layout once, then move its existing layers from their
// current screen rectangles. Individual translate/scale leave the artwork's
// playback transform and the labels' track-change effects independent.
export function createIosMetadataTransition(root, motion) {
  let animations = [];
  let generation = 0;
  const selector = '.artwork, .title, .artist, .metadata-menu';

  function cancel() {
    generation += 1;
    for (const { element, animation } of animations) {
      animation.cancel();
      element.style.removeProperty('will-change');
    }
    animations = [];
    root.classList.remove('is-ios-metadata-moving');
  }

  motion.addEventListener('change', () => { if (motion.matches) cancel(); });
  window.addEventListener('resize', cancel);

  return change => {
    const elements = [...root.querySelectorAll(selector)];
    const enabled = root.dataset.uiStyle === 'ios' &&
      !root.classList.contains('is-ipados-landscape') && !motion.matches &&
      !root.querySelector('.is-ui-switching');
    const before = enabled ? elements.map(element => element.getBoundingClientRect()) : [];
    cancel();
    if (!enabled) { change(); return; }
    const id = generation;
    root.classList.add('is-ios-metadata-moving');
    change();
    // Batch reads before starting any animations so all nodes share one layout
    // flush. Text scales uniformly instead of stretching to its new box width.
    const after = elements.map(element => element.getBoundingClientRect());
    animations = elements.flatMap((element, index) => {
      const first = before[index];
      const last = after[index];
      if (!first.width || !first.height || !last.width || !last.height) return [];
      const scale = first.height / last.height;
      const x = first.x + first.width / 2 - last.x - last.width / 2;
      const y = first.y + first.height / 2 - last.y - last.height / 2;
      // Labels grow from their left edge; artwork remains centered so its
      // independent pause/resume scale can continue during the collapse.
      const label = element.matches('.title, .artist');
      const translateX = label ? first.x - last.x : x;
      element.style.willChange = 'translate, scale';
      const animation = element.animate([
        { translate: `${translateX}px ${y}px`, scale: String(scale) },
        { translate: '0px 0px', scale: '1' }
      ], { duration: 500, easing: 'cubic-bezier(0.32, 0.72, 0, 1)', fill: 'both' });
      return [{ element, animation }];
    });
    Promise.all(animations.map(({ animation }) => animation.finished)).then(() => {
      if (id === generation) cancel();
    }).catch(() => {});
  };
}
