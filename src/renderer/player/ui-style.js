export const uiStyleOptions = [
  { value: 'macos', label: 'macOS' },
  { value: 'tvos', label: 'tvOS' },
  { value: 'ios', label: 'iOS' },
  { value: 'ipados', label: 'iPadOS' }
];

// iPadOS is the iOS player in a freely resizable window. Its layout rules are
// the iOS ones, so the body keeps that style and a variant marks the tablet
// behaviour (two columns once the window is wider than it is tall).
export const uiStyleLayout = value => value === 'ipados' ? 'ios' : value;

export const normalizeUiStyle = value => uiStyleOptions.some(option => option.value === value) ? value : 'macos';

// Animate the live player as a group; keep its clock, video and lyric DOM alive.
export function createUiStyleSwitcher(element, apply, motion = window.matchMedia('(prefers-reduced-motion: reduce)')) {
  let generation = 0;
  let animation = null;
  let desired = 'macos';
  const expanded = { opacity: 0, filter: 'blur(12px)', transform: 'scale(1.2)' };
  const resting = { opacity: 1, filter: 'blur(0px)', transform: 'scale(1)' };
  const timing = { duration: 700, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', fill: 'both' };

  function settle() {
    generation += 1;
    animation?.cancel();
    animation = null;
    const applied = apply(desired, false);
    element.inert = false;
    element.classList.remove('is-ui-switching');
    return applied;
  }

  motion.addEventListener('change', () => {
    if (motion.matches && animation) settle();
  });

  return async (value, animate = true) => {
    desired = normalizeUiStyle(value);
    if (!animate || motion.matches) { await settle(); return; }
    const id = ++generation;
    const style = animation ? getComputedStyle(element) : null;
    const from = style
      ? { opacity: style.opacity, filter: style.filter, transform: style.transform }
      : resting;
    animation?.cancel();
    element.inert = true;
    element.classList.add('is-ui-switching');
    animation = element.animate([from, expanded], timing);
    try {
      await animation.finished;
      if (id !== generation) return;
      await apply(desired, true);
      if (id !== generation) return;
      const exit = animation;
      animation = element.animate([expanded, resting], timing);
      exit.cancel();
      await animation.finished;
      if (id !== generation) return;
      animation.cancel();
      animation = null;
      element.inert = false;
      element.classList.remove('is-ui-switching');
    } catch {
      // A newer selection or a motion preference change owns the next frame.
      if (id === generation) settle();
    }
  };
}
