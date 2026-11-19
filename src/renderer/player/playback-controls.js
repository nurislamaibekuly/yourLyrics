import { initPlayerButtons, setPlayerIcon } from '../vendor/aeroui/components/player-button/player-button.js';
import { initSkipLabels, playSkip } from '../vendor/aeroui/components/skip-label/skip-label.js';

export function createPlaybackControls(element, { control, onError }) {
  initSkipLabels(element);
  initPlayerButtons(element);
  const buttons = Array.from(element.querySelectorAll('[data-playback]'));
  const toggle = element.querySelector('[data-playback="toggle"]');
  let state = { playing: false, available: false };
  let pending = false;
  let icon = '';
  let pendingPlaying = null;

  function render() {
    const disabled = !state.available || typeof control !== 'function' || pending;
    for (const button of buttons) {
      if (button.disabled !== disabled) button.disabled = disabled;
    }
    const busy = String(pending);
    if (element.getAttribute('aria-busy') !== busy) element.setAttribute('aria-busy', busy);
    const showingPlaying = pendingPlaying ?? state.playing;
    const nextIcon = showingPlaying ? 'pause' : 'play';
    // Media time updates every frame; replace the glyph only on state changes.
    if (nextIcon !== icon) {
      icon = nextIcon;
      setPlayerIcon(toggle, icon);
      toggle.title = showingPlaying ? 'Pause' : 'Play';
    }
  }

  for (const button of buttons) {
    button.addEventListener('pressend', async () => {
      if (button.disabled || pending || !state.available || typeof control !== 'function') return;
      const action = button.dataset.playback === 'toggle'
        ? (pendingPlaying ?? state.playing) ? 'pause' : 'play'
        : button.dataset.playback;
      pending = true;
      // Preview the requested icon immediately on release. The native stream
      // still owns playback state and time, and a failed command restores it.
      if (button.dataset.playback === 'toggle') pendingPlaying = action === 'play';
      render();
      const skip = button.querySelector('.aero-skip');
      if (skip) playSkip(skip);
      try {
        const result = await control(action);
        if (result?.ok !== true) throw new Error('Playback command failed');
        // The native stream confirms the preview without restarting its spring.
      } catch {
        pendingPlaying = null;
        const message = action === 'previous' || action === 'next'
          ? `Could not skip to the ${action} track.`
          : `Could not ${action} playback.`;
        onError?.(message);
      } finally {
        pending = false;
        render();
      }
    });
  }

  render();
  return {
    update(next) {
      const playing = next.playing === true;
      const available = next.available === true;
      if (!available || playing === pendingPlaying) pendingPlaying = null;
      if (state.playing === playing && state.available === available) return;
      state = { playing, available };
      render();
    }
  };
}
