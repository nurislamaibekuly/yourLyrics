import { SheetView as BaseSheetView } from '../ui/sheetview.js';
import { LiquidGlass } from './liquid-glass.js';
import { LiquidGlassView } from './glass-view.js';

const RESPONSE_SECONDS = 0.3441442326;
const DAMPING_RATIO = 1;
const HIGH_SPEED_DAMPING_RATIO = 0.8;
const HIGH_SPEED_THRESHOLD = 1000;
const MINIMUM_PROJECTION_SPEED = 250;
const DECELERATION_RATE = 0.99;
const RUBBER_BAND_COEFFICIENT = 0.55;
const INSET_PX = 8;

const clamp = (v, a, b) => Math.min(Math.max(v, a), b);

function rubberBand(excess, extent) {
  if (!excess || extent <= 0) return 0;
  return Math.sign(excess) * extent * (1 - 1 / ((Math.abs(excess) / extent) * RUBBER_BAND_COEFFICIENT + 1));
}

function projectedOffset(offset, velocity) {
  const effective = Math.abs(velocity) < MINIMUM_PROJECTION_SPEED ? 0 : velocity;
  return offset + (effective * DECELERATION_RATE) / (1 - DECELERATION_RATE) / 1000;
}

export class SheetView extends BaseSheetView {
  constructor(options = {}) {
    super({
      sheetRadius: 38,
      dim: 0.24,
      fitContent: false,
      title: '',
      spring: { response: RESPONSE_SECONDS, damping: DAMPING_RATIO },
      ...options,
    });
    this.el.classList.add('solarium-sheetview');
    this._restY = 0;
    this._closeGlass = null;

    // Replace the grabber pill with an iOS 26 header bar: centered title +
    // circular Liquid Glass X close button on the right.
    const grabber = this.el.querySelector('.sheetview__grabber');
    grabber?.remove();

    this._header = document.createElement('div');
    this._header.className = 'solarium-sheetview__header';

    this._titleEl = document.createElement('div');
    this._titleEl.className = 'solarium-sheetview__title';
    this._titleEl.textContent = this.opts.title || '';

    this._closeBtn = document.createElement('button');
    this._closeBtn.type = 'button';
    this._closeBtn.className = 'solarium-sheetview__close';
    this._closeBtn.setAttribute('aria-label', 'Close');
    this._closeBtn.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 6.5 17.5 17.5M17.5 6.5 6.5 17.5" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round"/></svg>';
    this._closeBtn.addEventListener('click', () => this.dismiss());

    this._scrollWrap = document.createElement('div');
    this._scrollWrap.className = 'solarium-sheetview__scrollwrap';
    this.el.insertBefore(this._scrollWrap, this.contentEl);
    this._scrollWrap.append(this.contentEl);

    this._header.append(this._titleEl, this._closeBtn);
    this.el.insertBefore(this._header, this._scrollWrap);

    this.contentEl.addEventListener('scroll', this._onScrollRedraw, { passive: true });
    this._darkMedia = window.matchMedia?.('(prefers-color-scheme: dark)') ?? null;
    this._onThemeChange = () => this._closeGlass?.requestDraw();
    this._darkMedia?.addEventListener?.('change', this._onThemeChange);
  }

  _onScrollRedraw = () => {
    this._closeGlass?.requestDraw();
  };

  _isDark() {
    if (this.opts.theme === 'dark') return true;
    if (this.opts.theme === 'light') return false;
    return Boolean(this._darkMedia?.matches);
  }

  _captureCloseBackdrop = (context, { captureLeft, captureTop, captureWidth, captureHeight }) => {
    const dark = this._isDark();
    const captureRect = {
      left: captureLeft,
      top: captureTop,
      right: captureLeft + captureWidth,
      bottom: captureTop + captureHeight,
    };
    context.save();
    context.fillStyle = dark ? '#1c1c1e' : '#f2f2f7';
    context.fillRect(captureLeft, captureTop, captureWidth, captureHeight);
    for (const group of this.contentEl.querySelectorAll('.sheet-group')) {
      const r = group.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      if (r.left >= captureRect.right || r.right <= captureRect.left ||
          r.top >= captureRect.bottom || r.bottom <= captureRect.top) continue;
      const style = getComputedStyle(group);
      const radius = Math.min(Number.parseFloat(style.borderTopLeftRadius) || 0, r.width / 2, r.height / 2);
      context.fillStyle = style.backgroundColor;
      context.beginPath();
      context.roundRect(r.left, r.top, r.width, r.height, radius);
      context.fill();
    }
    for (const textEl of this.contentEl.querySelectorAll('.sheet-heading, .sheet-row > span')) {
      const r = textEl.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      if (r.left >= captureRect.right || r.right <= captureRect.left ||
          r.top >= captureRect.bottom || r.bottom <= captureRect.top) continue;
      const text = textEl.textContent;
      if (!text || !text.trim()) continue;
      const style = getComputedStyle(textEl);
      context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      context.fillStyle = style.color;
      context.textBaseline = 'middle';
      context.fillText(text, r.left, r.top + r.height / 2, r.width);
    }
    context.restore();
  };

  _ensureCloseGlass() {
    if (this._closeGlass) return;
    const base = LiquidGlass.regular();
    const material = Object.assign(Object.create(Object.getPrototypeOf(base)), base, {
      uniforms: { ...base.uniforms },
    });
    material.resolveBackdropTone = () => (this._isDark() ? [1.26, 1.03] : [1.0, 1.0]);
    material.resolveTint = () => (this._isDark()
      ? [0.10, 0.10, 0.11, 0.48]
      : [0.96, 0.98, 1.0, 0.48]);
    this._closeGlass = new LiquidGlassView(material, {
      onCapture: this._captureCloseBackdrop,
      cornerRadius: 20,
      interactive: true,
      pressTransformTarget: this._closeBtn,
      pressScaleAmount: 0.08,
    });
    Object.assign(this._closeGlass.element.style, {
      position: 'absolute',
      inset: '0',
      zIndex: '0',
      pointerEvents: 'none',
    });
    this._closeGlass.element.setAttribute('aria-hidden', 'true');
    this._closeBtn.prepend(this._closeGlass.element);
  }

  _mount() {
    super._mount();
    this._ensureCloseGlass();
    this._closeGlass?.requestDraw();
  }

  _unmount() {
    this._closeGlass?.dispose();
    this._closeGlass = null;
    super._unmount();
  }

  _computeDetents() {
    const vh = window.innerHeight || 760;
    const topInset = this.opts.topInset ?? 90;
    const maxH = Math.max(200, vh - topInset);
    this._H = maxH;
    if (this.opts.fitContent) {
      const measured = Math.min(maxH, Math.max(160, (this.contentEl.scrollHeight || 220) + 16));
      this._restY = Math.max(0, maxH - measured);
    } else {
      this._restY = 0;
    }
  }

  setTitle(title) {
    this.opts.title = title;
    if (this._titleEl) {
      this._titleEl.textContent = title || '';
    }
  }

  setContent(content) {
    super.setContent(content);
    if (this.state === 'open') {
      this._computeDetents();
      if (this.opts.fitContent) {
        this._y = this._restY;
        this._apply();
      }
      this._closeGlass?.requestDraw();
    }
  }

  async present() {
    if (this.state !== 'closed') return;
    this._mount();
    this._computeDetents();
    this._y = this._H;
    this._apply();
    this.state = 'open';
    this.opts.onPresent?.();
    await this._animate(this._restY, 0, this.opts.spring);
    this._closeGlass?.requestDraw();
  }

  _onResize = () => {
    if (this.state === 'open') {
      this._computeDetents();
      this._y = this._restY;
      this._apply();
    }
  };

  _apply() {
    const o = this.opts;
    const y = this._y;
    const H = Math.max(1, this._H);
    const rest = this._restY;
    const topInset = o.topInset ?? 90;
    const fitted = Boolean(o.fitContent);
    const inset = fitted ? INSET_PX : 0;
    const radius = o.sheetRadius ?? 38;
    const bottomRadius = fitted ? radius : 0;
    const p = rest < H
      ? clamp((H - y) / Math.max(1, H - rest), 0, 1)
      : 1;

    const translation = y - rest;
    const widthCap = o.maxWidth ? Math.min(window.innerWidth || o.maxWidth, o.maxWidth) : (window.innerWidth || 640);
    const scale = fitted ? Math.max(0.01, (widthCap - inset * 2) / Math.max(1, widthCap)) : 1;
    this.el.style.top = `${(topInset + rest).toFixed(2)}px`;
    this.el.style.bottom = `${fitted ? inset : -80}px`;
    this.el.style.borderRadius = `${radius}px ${radius}px ${bottomRadius}px ${bottomRadius}px`;
    this.el.style.transformOrigin = '50% 100%';
    this.el.style.transform = `translate3d(0, ${translation.toFixed(2)}px, 0) scale(${scale.toFixed(4)})`;

    if (this.page) {
      const s = this.page.style;
      s.transform = p ? `translateY(${(o.pageTop * p).toFixed(2)}px) scale(${(1 - (1 - o.pageScale) * p).toFixed(4)})` : '';
      s.borderRadius = `${(o.pageRadius * p).toFixed(2)}px`;
      this._dim.style.opacity = String(o.dim * p);
    } else {
      this._hit.style.opacity = String(o.dim * p);
    }
  }

  _gMove(y) {
    const g = this._g;
    if (!g.drag) {
      if (!(g.top && y - g.y0 > 6)) return false;
      g.drag = true;
      this._cancelAnim();
      g.startY = y;
      g.base = this._y;
      if (g.pid !== false && g.pid != null) {
        try { this.el.setPointerCapture(g.pid); } catch {}
      }
      this.el.classList.add('is-dragging');
    }
    const raw = g.base + (y - g.startY);
    const extent = Math.max(120, this._H * 0.25);
    this._y = raw < this._restY ? this._restY + rubberBand(raw - this._restY, extent) : raw;
    this._apply();
    const now = performance.now();
    g.samples.push([now, y]);
    while (g.samples.length > 2 && now - g.samples[0][0] > 120) g.samples.shift();
    return true;
  }

  _gEnd() {
    const g = this._g;
    this._g = null;
    if (!g?.drag) return;
    this.el.classList.remove('is-dragging');
    const [t0, y0] = g.samples[0];
    const [t1, y1] = g.samples[g.samples.length - 1];
    const v = t1 > t0 ? (y1 - y0) / ((t1 - t0) / 1000) : 0;
    const projected = projectedOffset(this._y, v);
    const damping = Math.abs(v) >= HIGH_SPEED_THRESHOLD ? HIGH_SPEED_DAMPING_RATIO : DAMPING_RATIO;
    const spring = { response: RESPONSE_SECONDS, damping };

    const dismissThreshold = this._restY + (this._H - this._restY) * 0.35;
    if (v > 750 || (projected > dismissThreshold && v > -250)) {
      this.dismiss(Math.max(v, 0));
    } else {
      this._animate(this._restY, v, spring);
    }
  }

  destroy() {
    this.contentEl.removeEventListener('scroll', this._onScrollRedraw);
    this._darkMedia?.removeEventListener?.('change', this._onThemeChange);
    this._cancelAnim();
    if (this.state !== 'closed') {
      this._unmount();
    } else {
      this._closeGlass?.dispose();
      this._closeGlass = null;
    }
  }
}

export { SheetView as LiquidGlassSheetView };
export default SheetView;
