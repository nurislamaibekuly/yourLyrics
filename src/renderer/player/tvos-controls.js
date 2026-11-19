export function createTvosControlsAutoHide(root, isBlocked, {
  idleMs = 3000,
  style = 'tvos',
  idleClass = 'is-tvos-idle',
  enabled = () => true,
  onIdleChange = () => {},
  schedule = setTimeout,
  cancel = clearTimeout
} = {}) {
  const view = root.ownerDocument.defaultView;
  let timer = null;
  const events = ['pointermove', 'pointerdown', 'pointerup', 'pointercancel', 'wheel', 'keydown', 'focusin', 'focusout', 'resize'];

  function refresh() {
    if (timer !== null) cancel(timer);
    timer = null;
    if (root.classList.contains(idleClass)) {
      root.classList.remove(idleClass);
      onIdleChange(false);
    }
    if (root.dataset.uiStyle !== style || !enabled()) return;
    timer = schedule(() => {
      timer = null;
      if (root.dataset.uiStyle !== style || !enabled()) return;
      // Don't fade a timeline being scrubbed or controls used by a keyboard,
      // and keep chrome visible while a menu, sheet or alert is open.
      if (root.ownerDocument.hidden || isBlocked()) { refresh(); return; }
      root.classList.add(idleClass);
      onIdleChange(true);
    }, idleMs);
  }

  for (const event of events) view.addEventListener(event, refresh, { passive: true });
  refresh();
  return {
    refresh,
    dispose() {
      if (timer !== null) cancel(timer);
      for (const event of events) view.removeEventListener(event, refresh);
      root.classList.remove(idleClass);
      onIdleChange(false);
    }
  };
}
