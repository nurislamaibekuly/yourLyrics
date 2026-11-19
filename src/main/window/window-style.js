// Keep the user's desktop bounds separately: a portrait resize must never
// become the bounds restored when they return to a wide layout.
function createWindowStyleController(screen, platform = process.platform) {
  const windows = new WeakMap();

  function setMaximumSize(win, width, height) {
    if (platform === 'darwin' && (!width || !height)) {
      // Electron updates its cached maximum to zero without clearing the old
      // NSWindow limit. First apply a finite ceiling far beyond desktop sizes
      // so manual resizing is released too, then restore the zero sentinel.
      win.setMaximumSize(width || 1000000, height || 1000000);
    }
    win.setMaximumSize(width, height);
  }

  function transition(win, event, change) {
    return new Promise(resolve => {
      const done = () => {
        win.removeListener(event, done);
        win.removeListener('closed', done);
        resolve();
      };
      win.once(event, done);
      win.once('closed', done);
      change();
    });
  }

  async function resize(win, bounds, animate) {
    if (!animate) {
      win.setBounds(bounds);
      return;
    }
    const start = win.getBounds();
    const startedAt = performance.now();
    // Interpolate all four edges together on every platform. Native constraint
    // changes are deferred until this finishes so they cannot snap the first
    // frame to the portrait width before the transition has begun.
    await new Promise(resolve => {
      const step = () => {
        if (win.isDestroyed()) { resolve(); return; }
        const progress = Math.min(1, (performance.now() - startedAt) / 320);
        const eased = 1 - Math.pow(1 - progress, 3);
        const next = {};
        for (const key of ['x', 'y', 'width', 'height']) {
          next[key] = Math.round(start[key] + (bounds[key] - start[key]) * eased);
        }
        win.setBounds(next);
        if (progress < 1) setTimeout(step, 16);
        else resolve();
      };
      step();
    });
  }

  async function apply(win, state, style, animate) {
    if (win.isDestroyed()) return { ok: false };
    const portrait = style === 'ios';
    if (portrait === state.portrait) return { ok: true };
    if (portrait) {
      state.desktop = {
        bounds: win.getNormalBounds(),
        minimum: win.getMinimumSize(),
        maximum: win.getMaximumSize(),
        maximized: win.isMaximized(),
        fullscreen: win.isFullScreen()
      };
      // macOS exits a fullscreen Space asynchronously. Resizing before its
      // completion would leave the portrait bounds applied to the wrong Space.
      if (win.isFullScreen()) {
        await transition(win, 'leave-full-screen', () => win.setFullScreen(false));
      }
      if (win.isDestroyed()) return { ok: false };
      if (win.isMaximized()) {
        await transition(win, 'unmaximize', () => win.unmaximize());
      }
      if (win.isDestroyed()) return { ok: false };
      const desktop = state.desktop.bounds;
      const area = screen.getDisplayMatching(desktop).workArea;
      const height = Math.min(844, area.height);
      const width = Math.min(390, area.width, Math.round(height * 390 / 844));
      // Clear the outgoing constraints before changing the minimum: a saved
      // desktop maximum may be smaller than the portrait minimum.
      setMaximumSize(win, 0, 0);
      const start = win.getBounds();
      win.setMinimumSize(Math.min(360, width, start.width), Math.min(600, height, start.height));
      // The initial size and resize limit are separate, so the player can grow
      // taller without stretching the portrait layout into a wide window.
      await resize(win, {
        x: Math.round(Math.max(area.x, Math.min(area.x + area.width - width, desktop.x + (desktop.width - width) / 2))),
        y: Math.round(Math.max(area.y, Math.min(area.y + area.height - height, desktop.y + (desktop.height - height) / 2))),
        width,
        height
      }, animate);
      if (win.isDestroyed()) return { ok: false };
      win.setMinimumSize(Math.min(360, width), Math.min(600, height));
      // No maximum size: every iOS measurement is proportional to the window,
      // so dragging wider on a widescreen scales the layout up instead of
      // hitting a portrait cap.
    } else {
      const { bounds, minimum, maximum, maximized, fullscreen } = state.desktop;
      // The display may have been disconnected while the portrait player was
      // open, so restore the wide window inside the nearest current work area.
      const area = screen.getDisplayMatching(bounds).workArea;
      const width = Math.min(bounds.width, area.width);
      const height = Math.min(bounds.height, area.height);
      // Release the portrait cap before restoring the wider desktop minimum.
      setMaximumSize(win, 0, 0);
      const start = win.getBounds();
      win.setMinimumSize(Math.min(minimum[0], width, start.width), Math.min(minimum[1], height, start.height));
      await resize(win, {
        x: Math.max(area.x, Math.min(bounds.x, area.x + area.width - width)),
        y: Math.max(area.y, Math.min(bounds.y, area.y + area.height - height)),
        width,
        height
      }, animate);
      if (win.isDestroyed()) return { ok: false };
      win.setMinimumSize(Math.min(minimum[0], width), Math.min(minimum[1], height));
      setMaximumSize(win, ...maximum);
      if (maximized) win.maximize();
      if (fullscreen) await transition(win, 'enter-full-screen', () => win.setFullScreen(true));
    }
    state.portrait = portrait;
    return { ok: true };
  }

  return {
    set(win, style, options = {}) {
      // iPadOS adapts to whatever shape the window has, so it restores the
      // desktop bounds like macOS instead of forcing the portrait phone size.
      if (!win || !['macos', 'tvos', 'ios', 'ipados'].includes(style)) return Promise.resolve({ ok: false });
      let state = windows.get(win);
      if (!state) {
        state = { portrait: false, pending: Promise.resolve() };
        windows.set(win, state);
      }
      // Rapid selections are serialized so the last requested layout owns
      // the final bounds, including switches during a fullscreen transition.
      state.pending = state.pending.catch(() => {}).then(() => apply(win, state, style, options?.animate === true));
      return state.pending;
    }
  };
}

module.exports = { createWindowStyleController };
