/*! sheetview: iOS 18-style modal sheet for the web. MIT.
 *  The page behind scales back and rounds off; the sheet is spring-driven and
 *  follows your finger, with velocity-aware dismiss. Pair with sheetview.css.
 */

const clamp = (v, a, b) => Math.min(Math.max(v, a), b);
const reduceMotion = () => !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const INTERACTIVE = 'button,a,input,textarea,select,summary,label,[contenteditable],[data-sheetview-nodrag]';
const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select,textarea,[tabindex]:not([tabindex="-1"])';

const DEFAULTS = {
  content: null,            // string (trusted HTML) | Element | (sheet) => Element
  page: null,               // element (or selector) that scales back; give it a full-height app root
  grabber: false,
  topInset: 90,             // gap between the viewport top and the sheet (px)
  sheetRadius: 12,
  pageScale: 0.92,
  pageTop: 8,               // how far the scaled page moves down (px)
  pageRadius: 12,
  dim: 0.3,                 // how dark the page gets (0..1)
  maxWidth: 640,            // sheet width cap on wide screens (px); null = full width
  backdropColor: '#000',    // what shows around the scaled page
  dismissOnTap: false,      // tap the dimmed page to dismiss (iOS full sheets don't)
  interactiveDismiss: true, // drag down / Esc to dismiss
  spring: { response: 0.5, damping: 0.9 },
  theme: 'auto',            // 'auto' | 'light' | 'dark'
  onPresent: null,
  onDismiss: null,
};

export class SheetView {
  constructor(options = {}) {
    this.opts = { ...DEFAULTS, ...options, spring: { ...DEFAULTS.spring, ...options.spring } };
    const o = this.opts;
    this.page = typeof o.page === 'string' ? document.querySelector(o.page) : o.page;
    this.state = 'closed'; // 'closed' | 'open' | 'closing'
    this._y = 0; this._H = 1; this._raf = 0; this._res = null; this._g = null;

    this.el = document.createElement('div');
    this.el.className = 'sheetview';
    this.el.setAttribute('role', 'dialog');
    this.el.setAttribute('aria-modal', 'true');
    this.el.tabIndex = -1;
    this.el.style.setProperty('--sheetview-top', o.topInset + 'px');
    this.el.style.setProperty('--sheetview-radius', o.sheetRadius + 'px');
    this.el.style.setProperty('--sheetview-max', o.maxWidth ? o.maxWidth + 'px' : '100%');
    if (o.theme !== 'auto') this.el.dataset.theme = o.theme;

    if (o.grabber) {
      const g = document.createElement('div');
      g.className = 'sheetview__grabber'; g.setAttribute('aria-hidden', 'true');
      this.el.append(g);
    }
    this.contentEl = document.createElement('div');
    this.contentEl.className = 'sheetview__scroll';
    this.el.append(this.contentEl);
    if (o.content) this.setContent(o.content);

    this._hit = document.createElement('div');   // catches taps outside the sheet; doubles as the shade when there's no page
    this._hit.className = 'sheetview__hit';
    this._hit.addEventListener('click', () => { if (o.dismissOnTap) this.dismiss(); });
    this._dim = document.createElement('div');   // dims the scaled page
    this._dim.className = 'sheetview__dim';

    // gestures
    this._onTouchStart = e => this._gStart(e.touches.length === 1 ? e.touches[0].clientY : null, e.target, false);
    this._onTouchMove = e => { if (this._g && this._gMove(e.touches[0].clientY)) e.preventDefault(); };
    this._onTouchEnd = () => this._gEnd();
    this._onPointerDown = e => {
      if (e.pointerType === 'touch' || e.button !== 0 || e.target.closest(INTERACTIVE)) return;
      this._gStart(e.clientY, e.target, e.pointerId);
    };
    this._onPointerMove = e => { if (this._g?.pid === e.pointerId) this._gMove(e.clientY); };
    this._onPointerUp = e => { if (this._g?.pid === e.pointerId) this._gEnd(); };
    this._onKey = e => {
      if (e.key === 'Escape' && o.interactiveDismiss && !document.querySelector('.menuview, .solarium-menuview, .alertview--open')) {
        e.preventDefault();
        this.dismiss();
      }
    };
    this._onResize = () => { if (this.state === 'open') { this._H = this.el.offsetHeight || 1; this._apply(); } };

    this.el.addEventListener('touchstart', this._onTouchStart, { passive: true });
    this.el.addEventListener('touchmove', this._onTouchMove, { passive: false });
    this.el.addEventListener('touchend', this._onTouchEnd);
    this.el.addEventListener('touchcancel', this._onTouchEnd);
    this.el.addEventListener('pointerdown', this._onPointerDown);
    this.el.addEventListener('pointermove', this._onPointerMove);
    this.el.addEventListener('pointerup', this._onPointerUp);
    this.el.addEventListener('pointercancel', this._onPointerUp);
  }

  get isOpen() { return this.state === 'open'; }

  setContent(c) {
    if (typeof c === 'function') c = c(this);
    this.contentEl.replaceChildren();
    if (typeof c === 'string') this.contentEl.innerHTML = c; // trusted, developer-supplied
    else if (c) this.contentEl.append(c);
  }

  present() {
    if (this.state === 'open') return Promise.resolve();
    if (this.state === 'closing') this._cancelAnim(); else this._mount();
    this.state = 'open';
    return this._animate(0, 0, this.opts.spring).then(ok => { if (ok) this.opts.onPresent?.(); });
  }

  dismiss(v0 = 0) {
    if (this.state !== 'open') return Promise.resolve();
    this.state = 'closing';
    return this._animate(this._H, v0, { response: 0.4, damping: 1 }).then(ok => {
      if (ok) this._unmount();
    });
  }

  destroy() { this._cancelAnim(); if (this.state !== 'closed') this._unmount(); }

  // ---- mounting ----

  _mount() {
    const o = this.opts, root = document.documentElement;
    this._prevFocus = document.activeElement;
    this._saved = { bg: root.style.backgroundColor, overflow: root.style.overflow };
    this.el.style.transform = 'translate3d(0,100%,0)';
    document.body.append(this._hit, this.el);
    this._H = this.el.offsetHeight || 1;
    this._y = this._H;

    if (this.page) {
      const p = this.page, s = p.style;
      this._pageSaved = { transform: s.transform, transformOrigin: s.transformOrigin, borderRadius: s.borderRadius,
        overflow: s.overflow, position: s.position, willChange: s.willChange };
      if (getComputedStyle(p).position === 'static') s.position = 'relative';
      s.transformOrigin = '50% 0'; s.overflow = 'hidden'; s.willChange = 'transform';
      p.append(this._dim);
      p.inert = true; p.setAttribute('aria-hidden', 'true');
      root.style.backgroundColor = o.backdropColor;
      this._hit.style.background = 'transparent';
    } else {
      this._hit.style.background = '#000';
    }
    root.style.overflow = 'hidden';
    this._apply();
    this.el.focus({ preventScroll: true });
    window.addEventListener('keydown', this._onKey);
    window.addEventListener('resize', this._onResize);
  }

  _unmount() {
    const root = document.documentElement;
    window.removeEventListener('keydown', this._onKey);
    window.removeEventListener('resize', this._onResize);
    this._hit.remove(); this.el.remove(); this._dim.remove();
    this.el.style.transform = '';
    if (this.page) {
      const p = this.page;
      Object.assign(p.style, this._pageSaved);
      p.inert = false; p.removeAttribute('aria-hidden');
    }
    root.style.backgroundColor = this._saved.bg;
    root.style.overflow = this._saved.overflow;
    this.state = 'closed';
    this._prevFocus?.focus?.({ preventScroll: true });
    this.opts.onDismiss?.();
  }

  // ---- rendering: everything is a function of the sheet's y offset ----

  _apply() {
    const o = this.opts, y = this._y, p = clamp(1 - y / this._H, 0, 1);
    this.el.style.transform = `translate3d(0,${y}px,0)`;
    if (this.page) {
      const s = this.page.style;
      s.transform = p ? `translateY(${o.pageTop * p}px) scale(${1 - (1 - o.pageScale) * p})` : '';
      s.borderRadius = `${o.pageRadius * p}px`;
      this._dim.style.opacity = o.dim * p;
    } else {
      this._hit.style.opacity = o.dim * p;
    }
  }

  // Spring physics on y, so a flick keeps its velocity (px/s) into the animation.
  _animate(to, v0, sp) {
    this._cancelAnim();
    if (reduceMotion()) { this._y = to; this._apply(); return Promise.resolve(true); }
    const w = 2 * Math.PI / sp.response, k = w * w, c = 2 * sp.damping * w;
    let x = this._y, v = v0, last = performance.now();
    return new Promise(res => {
      this._res = res;
      const tick = now => {
        let dt = Math.min(0.05, (now - last) / 1000); last = now;
        while (dt > 0) { const h = Math.min(dt, 1 / 240); v += (-k * (x - to) - c * v) * h; x += v * h; dt -= h; }
        this._y = x; this._apply();
        if (Math.abs(x - to) < 0.3 && Math.abs(v) < 10) {
          this._y = to; this._apply(); this._raf = 0; this._res = null; res(true);
        } else this._raf = requestAnimationFrame(tick);
      };
      this._raf = requestAnimationFrame(tick);
    });
  }

  _cancelAnim() {
    cancelAnimationFrame(this._raf); this._raf = 0;
    this._res?.(false); this._res = null;
  }

  // ---- gestures ----

  _atTop(target) {
    for (let el = target; el && el !== this.el; el = el.parentElement) {
      const cs = getComputedStyle(el);
      if (/(auto|scroll)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight && el.scrollTop > 0) return false;
    }
    return true;
  }

  _gStart(y, target, pid) {
    if (!this.opts.interactiveDismiss || y == null || this.state !== 'open') return;
    this._g = { y0: y, startY: y, base: 0, drag: false, pid, top: this._atTop(target), samples: [[performance.now(), y]] };
  }

  // returns true while a drag is in progress (so touchmove can preventDefault)
  _gMove(y) {
    const g = this._g;
    if (!g.drag) {
      if (!(g.top && y - g.y0 > 6)) return false;
      g.drag = true; this._cancelAnim();
      g.startY = y; g.base = this._y;
      if (g.pid !== false && g.pid != null) { try { this.el.setPointerCapture(g.pid); } catch {} }
      this.el.classList.add('is-dragging');
    }
    const raw = g.base + (y - g.startY);
    this._y = raw < 0 ? raw / 6 : raw; // rubber-band when pulled up
    this._apply();
    const now = performance.now();
    g.samples.push([now, y]);
    while (g.samples.length > 2 && now - g.samples[0][0] > 120) g.samples.shift();
    return true;
  }

  _gEnd() {
    const g = this._g; this._g = null;
    if (!g?.drag) return;
    this.el.classList.remove('is-dragging');
    const [t0, y0] = g.samples[0], [t1, y1] = g.samples[g.samples.length - 1];
    const v = t1 > t0 ? (y1 - y0) / ((t1 - t0) / 1000) : 0; // px/s, + = downward
    const close = v > 700 || (this._y > this._H * 0.3 && v > -300);
    if (close) this.dismiss(Math.max(v, 0)); else this._animate(0, v, this.opts.spring);
  }
}

export default SheetView;
