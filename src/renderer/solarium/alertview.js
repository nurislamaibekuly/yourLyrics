import { AlertView as BaseAlertView } from '../ui/alertview.js';
import { LiquidGlass } from './liquid-glass.js';
import { LiquidGlassView } from './glass-view.js';

function alertMaterial(effect = 'regular') {
  const base = effect === 'clear' ? LiquidGlass.clear() : LiquidGlass.regular();
  const uniforms = {
    ...base.uniforms,
    glassThickness: 12,
    refractiveIndex: 1.52,
    dispersionStrength: 5,
    glareDistanceRange: 22,
    glareIntensity: 0.12,
    glareEdgeSharpness: -0.08,
  };
  return new LiquidGlass({
    uniforms,
    backgroundTextureSizeCoefficient: 1,
    backgroundTextureScaleCoefficient: 0.25,
    backgroundTextureBlurRadius: effect === 'clear' ? 2.4 : 4.5,
    backdropTone: isDark => (isDark ? [1.18, 1.04] : [1.0, 1.0]),
    tintColor: isDark => (isDark
      ? [0.11, 0.11, 0.13, 0.56]
      : [0.96, 0.97, 0.99, 0.62]),
  });
}

export class AlertView extends BaseAlertView {
  constructor(options = {}) {
    super(options);
    this.el.classList.add('solarium-alertview');
    this.source = options.source ?? null;
    this.sourceBounds = options.sourceBounds ?? null;
    this.onCapture = options.onCapture ?? null;
    this.effect = options.effect ?? 'regular';
    this.material = options.material ?? alertMaterial(this.effect);
    this._glass = null;
    this._disposeTimer = 0;

    // Wrap the text/input/buttons in a content layer above the WebGL canvas.
    this._contentWrap = document.createElement('div');
    this._contentWrap.className = 'solarium-alertview__content';
    while (this._card.firstChild) {
      this._contentWrap.append(this._card.firstChild);
    }
    this._card.append(this._contentWrap);

    this._darkMedia = window.matchMedia?.('(prefers-color-scheme: dark)') ?? null;
    this._onThemeChange = () => this._glass?.requestDraw();
    this._onResize = () => this._syncGlassGeometry();
    this._onCardPressStart = e => {
      if (e.button === 0 && this.state === 'open') {
        this.el.classList.add('is-settled');
      }
    };
    this._settleTimer = 0;
  }

  _isDark() {
    if (this.opts.theme === 'dark') return true;
    if (this.opts.theme === 'light') return false;
    return Boolean(this._darkMedia?.matches);
  }

  _normalizeActions(actions) {
    const list = super._normalizeActions(actions);
    const hasExplicitProminent = list.some(a => typeof a.prominent === 'boolean');
    if (hasExplicitProminent) return list;

    // iOS 26 / Glasmio: 1 action or the confirming action of a 2-action alert
    // takes the prominent capsule fill; cancel stays neutral frosted pill.
    if (list.length === 1) {
      return [{ ...list[0], prominent: list[0].style !== 'cancel' }];
    }
    if (list.length === 2) {
      const nonCancelIndex = list.findIndex(a => a.style !== 'cancel');
      const primaryIndex = nonCancelIndex !== -1 ? nonCancelIndex : 1;
      return list.map((a, idx) => ({
        ...a,
        prominent: idx === primaryIndex && a.style !== 'cancel',
      }));
    }
    return list.map((a, idx) => ({
      ...a,
      prominent: idx === 0 && a.style === 'default',
    }));
  }

  _buttonFor(action) {
    const button = super._buttonFor(action);
    button.style.color = '';
    if (action.prominent) {
      button.dataset.prominent = 'true';
    }
    return button;
  }

  _settledCardBounds() {
    const width = this._card.offsetWidth || 300;
    const height = this._card.offsetHeight || 160;
    return {
      left: (window.innerWidth - width) / 2,
      top: (window.innerHeight - height) / 2,
      width,
      height,
    };
  }

  _syncGlassGeometry(force = false) {
    if (!this._glass || (!force && this.state === 'closed')) return;
    const bounds = this._settledCardBounds();
    this._glass.fixedViewBounds = bounds;
    this._glass.rasterSize = { width: bounds.width, height: bounds.height };
    this._glass.captureRasterSize = { width: bounds.width, height: bounds.height };
    this._glass.prepareRaster();
    this._glass.draw();
  }

  _captureBackdrop = (context, capture) => {
    if (this.onCapture) {
      this.onCapture(context, capture);
      return;
    }
    const { captureLeft, captureTop, captureWidth, captureHeight } = capture;
    const captureRect = {
      left: captureLeft,
      top: captureTop,
      right: captureLeft + captureWidth,
      bottom: captureTop + captureHeight,
    };
    const dark = this._isDark();
    context.save();
    if (!this.source) {
      context.fillStyle = dark ? '#141416' : '#e5e5ea';
      context.fillRect(captureLeft, captureTop, captureWidth, captureHeight);
    }
    const sheet = document.querySelector('.sheetview');
    if (sheet && sheet.isConnected) {
      const r = sheet.getBoundingClientRect();
      if (r.width && r.height &&
          r.left < captureRect.right && r.right > captureRect.left &&
          r.top < captureRect.bottom && r.bottom > captureRect.top) {
        const s = getComputedStyle(sheet);
        context.fillStyle = s.backgroundColor;
        context.beginPath();
        context.roundRect(r.left, r.top, r.width, r.height, Number.parseFloat(s.borderTopLeftRadius) || 0);
        context.fill();
        for (const group of sheet.querySelectorAll('.sheet-group')) {
          const gr = group.getBoundingClientRect();
          if (!gr.width || !gr.height ||
              gr.left >= captureRect.right || gr.right <= captureRect.left ||
              gr.top >= captureRect.bottom || gr.bottom <= captureRect.top) continue;
          const gs = getComputedStyle(group);
          context.fillStyle = gs.backgroundColor;
          context.beginPath();
          context.roundRect(gr.left, gr.top, gr.width, gr.height, Number.parseFloat(gs.borderTopLeftRadius) || 0);
          context.fill();
        }
        for (const el of sheet.querySelectorAll('.sheet-row > span')) {
          const tr = el.getBoundingClientRect();
          if (!tr.width || !tr.height ||
              tr.left >= captureRect.right || tr.right <= captureRect.left ||
              tr.top >= captureRect.bottom || tr.bottom <= captureRect.top) continue;
          const text = el.textContent;
          if (!text || !text.trim()) continue;
          const ts = getComputedStyle(el);
          context.font = `${ts.fontStyle} ${ts.fontWeight} ${ts.fontSize} ${ts.fontFamily}`;
          context.fillStyle = ts.color;
          context.textBaseline = 'middle';
          context.fillText(text, tr.left, tr.top + tr.height / 2, tr.width);
        }
      }
    }
    context.fillStyle = dark ? 'rgba(0, 0, 0, 0.28)' : 'rgba(0, 0, 0, 0.18)';
    context.fillRect(captureLeft, captureTop, captureWidth, captureHeight);
    context.restore();
  };

  _ensureGlass() {
    if (this._glass) return;
    const mat = Object.assign(Object.create(Object.getPrototypeOf(this.material)), this.material, {
      uniforms: { ...this.material.uniforms },
    });
    if (this.opts.theme !== 'auto') {
      const dark = this.opts.theme === 'dark';
      mat.resolveBackdropTone = () => (typeof this.material.backdropTone === 'function'
        ? this.material.backdropTone(dark)
        : (this.material.backdropTone ?? [1, 1]));
      mat.resolveTint = () => (typeof this.material.tintColor === 'function'
        ? this.material.tintColor(dark)
        : (this.material.tintColor ?? this.material.uniforms.materialTint));
    }
    this._glass = new LiquidGlassView(mat, {
      source: this.source,
      sourceBounds: this.sourceBounds,
      onCapture: this._captureBackdrop,
      cornerRadius: 34,
      interactive: true,
      pressTransformTarget: this._card,
      pressScaleAmount: 0.04,
      autoCapture: true,
      staticCapture: true,
    });
    this._glass.element.className = 'solarium-alertview__glass';
    Object.assign(this._glass.element.style, {
      position: 'absolute',
      inset: '0',
      zIndex: '0',
      pointerEvents: 'none',
    });
    this._glass.element.setAttribute('aria-hidden', 'true');
    this._card.prepend(this._glass.element);
  }

  _teardownGlass() {
    clearTimeout(this._disposeTimer);
    clearTimeout(this._settleTimer);
    this._disposeTimer = 0;
    this._settleTimer = 0;
    this._darkMedia?.removeEventListener?.('change', this._onThemeChange);
    window.removeEventListener('resize', this._onResize);
    this._card.removeEventListener('pointerdown', this._onCardPressStart, true);
    this.el.classList.remove('is-settled');
    if (this._glass) {
      this._glass.dispose();
      this._glass = null;
    }
  }

  present() {
    const alreadyOpen = this.state !== 'closed';
    if (!alreadyOpen) {
      clearTimeout(this._disposeTimer);
      clearTimeout(this._settleTimer);
      this.el.classList.remove('is-settled');
      document.body.append(this.el);
      this._ensureGlass();
      this._syncGlassGeometry(true);
    }
    const promise = super.present();
    if (!alreadyOpen && this.state === 'open') {
      this._darkMedia?.addEventListener?.('change', this._onThemeChange);
      window.addEventListener('resize', this._onResize);
      this._card.addEventListener('pointerdown', this._onCardPressStart, true);
      this._settleTimer = setTimeout(() => {
        if (this.state === 'open') this.el.classList.add('is-settled');
      }, 500);
    }
    return promise;
  }

  dismiss() {
    if (this.state !== 'open') return;
    clearTimeout(this._settleTimer);
    this._settleTimer = 0;
    this.el.classList.remove('is-settled');
    if (this._glass) {
      this._glass.setPressed(false, null, [0, 0]);
    }
    super.dismiss();
    const cleanup = () => this._teardownGlass();
    const onEnd = e => {
      if (e.target !== this._card || e.propertyName !== 'opacity') return;
      this._card.removeEventListener('transitionend', onEnd);
      cleanup();
    };
    this._card.addEventListener('transitionend', onEnd);
    this._disposeTimer = setTimeout(() => {
      this._card.removeEventListener('transitionend', onEnd);
      cleanup();
    }, 550);
  }
}

export const LiquidGlassAlertView = AlertView;

export function alert(options) {
  return new AlertView(options).present();
}

export function confirm(title, message, options = {}) {
  const {
    confirmText = 'OK',
    cancelText = 'Cancel',
    destructive = false,
    ...rest
  } = options;
  return alert({
    ...rest,
    title,
    message,
    actions: [
      { text: cancelText, style: 'cancel', value: false },
      { text: confirmText, style: destructive ? 'destructive' : 'default', value: true, prominent: true },
    ],
  }).then(value => value === true);
}

export function prompt(title, message, options = {}) {
  const {
    placeholder = '',
    defaultValue = '',
    confirmText = 'OK',
    ...rest
  } = options;
  return new Promise(resolve => {
    let input;
    const view = new AlertView({
      ...rest,
      title,
      message,
      actions: [
        { text: 'Cancel', style: 'cancel', value: null },
        { text: confirmText, style: 'default', value: '__ok__', prominent: true },
      ],
    });
    input = document.createElement('input');
    input.className = 'alertview__input';
    input.type = 'text';
    input.placeholder = placeholder;
    input.value = defaultValue;
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') view._resolve('__ok__');
    });
    const textWrap = view._card.querySelector('.alertview__text');
    if (textWrap) textWrap.append(input);
    view.present().then(v => resolve(v === '__ok__' ? input.value : null));
  });
}
