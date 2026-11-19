# AeroUI playback components

Vendored from `https://nurislamaibekuly.github.io/aeroui/` on October 24, 2026.
Upstream repository: `https://github.com/nurislamaibekuly/aeroui`.
Upstream HEAD at retrieval: `93f5cbc383a3fdc84ebed08d0452115e90562c60`.
See `LICENSE` for the MIT license and copyright notice.

Only the player-button, skip-label, motion, and haptics modules are included.
Comments/formatting are condensed; glyphs, spring settings and press events
are retained. Imports stay local, so
the application does not load remote code or weaken its Content Security Policy.

Application layout overrides live in `../../styles.css`; native playback wiring
lives in `../../playback-controls.js`, outside the vendored components.

Local integration fixes: the player symbol has its own inner wrapper, keeping
symbol-replacement animation separate from the press/release transform.
Changing to reduced motion also cancels transitions already in flight.
Local icon-size/content-height styling is preserved rather than reset to the
upstream defaults. Busy-command coloring is handled by the app stylesheet.
