// Individual scale preserves each player's own positioning transform.
export async function revealPlayerFromSetup({ container = document, reducedMotion = false } = {}) {
  const candidates = [...container.querySelectorAll('.stage, .lyrics-pill, .lyrics-toggle, .ios-translate-toggle, .ios-bottom-action, .ios-airplay-label, .macos-volume-control')];
  const targets = candidates.filter(el => !candidates.some(parent => parent !== el && parent.contains(el)));
  const animations = targets.filter(el => el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden')
    .map(el => el.animate(reducedMotion
      ? [{ opacity: 0 }, { opacity: 1 }]
      : [{ opacity: 0, scale: '0.94', filter: 'blur(18px)' }, { opacity: 1, scale: '1', filter: 'blur(0px)' }],
    { duration: reducedMotion ? 180 : 900, delay: reducedMotion ? 0 : 140,
      easing: 'cubic-bezier(.16,1,.3,1)', fill: 'both' }));
  try { await Promise.all(animations.map(animation => animation.finished.catch(() => {}))); }
  finally { for (const animation of animations) animation.cancel(); }
}
