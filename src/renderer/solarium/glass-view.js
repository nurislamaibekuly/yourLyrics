import { LiquidGlass } from './liquid-glass.js';
import { LiquidGlassRenderer } from './renderer.js';
import { clamp, prefersReducedMotion } from './spring.js';

const THEME_QUERY = window.matchMedia('(prefers-color-scheme: dark)');

// Rounding a device-pixel size keeps the canvas backing store from drifting
// half a pixel away from the CSS box, which shows up as a one-pixel transparent
// seam along the glass edge.
function devicePixels(cssPixels) {
  return Math.max(1, Math.round(cssPixels * (window.devicePixelRatio || 1)));
}

export class LiquidGlassView {
  constructor(liquidGlass = LiquidGlass.regular(), options = {}) {
    this.liquidGlass = liquidGlass;
    this.frames = [];
    this.touchPoint = null;
    this.interactive = options.interactive ?? liquidGlass.interactive ?? false;
    this.autoCapture = options.autoCapture !== false;
    this.shapeMergeSmoothness = options.shapeMergeSmoothness
      ?? liquidGlass.uniforms.shapeMergeSmoothness
      // The Swift view overwrites whatever the material says with 0.2.
      ?? 0.2;

    this.source = options.source ?? null;
    this.sourceBounds = options.sourceBounds ?? null;
    this.onCapture = options.onCapture ?? null;
    // Controls add their own track layers here. The page's drawable cannot
    // contain DOM-painted tracks, and the thumb must not capture itself.
    this.backgroundLayers = options.backgroundLayers ?? [];
    this.captureUntil = 0;
    this.rasterSize = null;
    this.captureRasterSize = null;
    this.fixedViewBounds = options.fixedViewBounds ?? null;
    this.staticCapture = options.staticCapture ?? false;
    this._capturedOnce = false;
    this.pressProgress = 0;
    this._pressVelocity = 0;
    this._pressTarget = 0;
    this._pressLastTime = 0;
    this._pressAnimating = false;
    this.pressStretch = [0, 0];
    this._stretchVelocity = [0, 0];
    this._stretchTarget = [0, 0];
    this.pressInflate = options.pressInflate ?? 0;
    this.pressTransformTarget = options.pressTransformTarget ?? null;
    this.pressScaleAmount = options.pressScaleAmount ?? 0.055;
    this.pressTranslateAmount = options.pressTranslateAmount ?? 7.0;
    this._interactiveRect = null;
    this._interactiveOrigin = null;
    this.disposed = false;

    this.element = document.createElement('div');
    // The outer box must not clip. The thumb and lens materials paint a drop
    // shadow outside their pill, and an `overflow: hidden` ancestor cuts it off
    // along the edges it overhangs. Only the surface itself is clipped.
    Object.assign(this.element.style, {
      position: 'relative',
      overflow: 'visible',
      pointerEvents: 'none',
    });

    this.surface = document.createElement('div');
    Object.assign(this.surface.style, {
      position: 'absolute',
      inset: '0',
      overflow: 'hidden',
      pointerEvents: 'none',
    });
    this.element.append(this.surface);

    this.canvas = document.createElement('canvas');
    Object.assign(this.canvas.style, {
      display: 'block',
      width: '100%',
      height: '100%',
    });
    this.surface.append(this.canvas);

    this.captureCanvas = document.createElement('canvas');
    this.captureContext = this.captureCanvas.getContext('2d');

    this.renderer = null;
    if (LiquidGlassRenderer.isSupported()) {
      this.renderer = new LiquidGlassRenderer(this.canvas);
    } else {
      // No WebGL2: the shell stays in the layout so callers do not have to
      // special-case it, and nothing is painted inside it.
      this.element.dataset.solariumFallback = 'true';
    }

    this.shadow = null;
    if (liquidGlass.shadowOverlay) {
      this.createShadowOverlay();
    }

    this.cornerRadius = options.cornerRadius ?? 0;
    if (this.cornerRadius) {
      this.setCornerRadius(this.cornerRadius);
    }

    this._interactivePress = false;
    if (this.interactive) {
      this._bindInteractive();
    }

    this.frameHandle = 0;
  }

  // UIGlassEffect.isInteractive: a press held inside the view's bounds feeds
  // the material a touch point. The element itself never receives pointer
  // events, so the press is watched on the document and the move/up pair only
  // exists for the duration of the touch.
  _bindInteractive() {
    if (this._interactiveBound) return;
    this._interactiveBound = true;
    this._onInteractiveDown = event => {
      if (event.button !== 0 || !this.interactive) return;
      const rect = this.element.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right ||
          event.clientY < rect.top || event.clientY > rect.bottom) return;
      this._interactivePress = true;
      this._interactiveRect = rect;
      this._interactiveOrigin = [event.clientX, event.clientY];
      const lx = event.clientX - rect.left;
      const ly = event.clientY - rect.top;
      this.setPressed(true, [lx, ly], [0, 0]);
      window.addEventListener('pointermove', this._onInteractiveMove, true);
      window.addEventListener('pointerup', this._onInteractiveEnd, true);
      window.addEventListener('pointercancel', this._onInteractiveEnd, true);
    };
    this._onInteractiveMove = event => {
      if (this._interactivePress) this._setInteractivePoint(event);
    };
    this._onInteractiveEnd = () => {
      if (!this._interactivePress) return;
      this._interactivePress = false;
      this._interactiveRect = null;
      this._interactiveOrigin = null;
      window.removeEventListener('pointermove', this._onInteractiveMove, true);
      window.removeEventListener('pointerup', this._onInteractiveEnd, true);
      window.removeEventListener('pointercancel', this._onInteractiveEnd, true);
      this.setPressed(false, null, [0, 0]);
    };
    document.addEventListener('pointerdown', this._onInteractiveDown, true);
  }

  _unbindInteractive() {
    if (!this._interactiveBound) return;
    this._interactiveBound = false;
    document.removeEventListener('pointerdown', this._onInteractiveDown, true);
    if (this._interactivePress) this._onInteractiveEnd();
  }

  get isPressed() {
    return this._pressTarget === 1 || this._interactivePress;
  }

  setInteractive(enabled) {
    this.interactive = !!enabled;
    if (this.interactive) {
      this._bindInteractive();
    } else {
      this._unbindInteractive();
      this.setPressed(false, null, [0, 0]);
    }
  }

  setPressed(pressed, point = null, stretch = null) {
    if (point) {
      this.setTouchPoint(point);
    }
    const target = pressed ? 1 : 0;
    const nextStretch = pressed
      ? (stretch ?? this._stretchTarget)
      : [0, 0];
    if (
      this._pressTarget === target &&
      this._stretchTarget[0] === nextStretch[0] &&
      this._stretchTarget[1] === nextStretch[1] &&
      !this._pressAnimating &&
      this.pressProgress === target
    ) {
      return;
    }
    this._pressTarget = target;
    this._stretchTarget = [nextStretch[0], nextStretch[1]];
    if (prefersReducedMotion()) {
      this.pressProgress = target;
      this._pressVelocity = 0;
      this.pressStretch = [0, 0];
      this._stretchVelocity = [0, 0];
      this._pressAnimating = false;
      this._applyPressTransform();
      this.requestDraw();
      return;
    }
    if (!this._pressAnimating) {
      this._pressLastTime = 0;
      this._pressAnimating = true;
    }
    this.requestDraw();
  }

  _stepPress(now = performance.now()) {
    if (!this._pressAnimating) return false;
    const dt = this._pressLastTime ? Math.min((now - this._pressLastTime) / 1000, 0.05) : 1 / 60;
    this._pressLastTime = now;
    const pressResp = this._pressTarget ? 0.25 : 0.36;
    const pressZeta = this._pressTarget ? 0.56 : 0.44;
    const stretchResp = this._pressTarget ? 0.23 : 0.38;
    const stretchZeta = this._pressTarget ? 0.58 : 0.42;

    const pOmega = (2 * Math.PI) / pressResp;
    const pK = pOmega * pOmega;
    const pC = 2 * pressZeta * pOmega;
    const sOmega = (2 * Math.PI) / stretchResp;
    const sK = sOmega * sOmega;
    const sC = 2 * stretchZeta * sOmega;

    const substeps = 4;
    const h = dt / substeps;
    for (let i = 0; i < substeps; i += 1) {
      const pAccel = -pK * (this.pressProgress - this._pressTarget) - pC * this._pressVelocity;
      this._pressVelocity += pAccel * h;
      this.pressProgress += this._pressVelocity * h;

      for (let axis = 0; axis < 2; axis += 1) {
        const sAccel = -sK * (this.pressStretch[axis] - this._stretchTarget[axis]) - sC * this._stretchVelocity[axis];
        this._stretchVelocity[axis] += sAccel * h;
        this.pressStretch[axis] += this._stretchVelocity[axis] * h;
      }
    }
    this.pressProgress = clamp(this.pressProgress, -0.05, 1.35);
    this.pressStretch[0] = clamp(this.pressStretch[0], -1.35, 1.35);
    this.pressStretch[1] = clamp(this.pressStretch[1], -1.35, 1.35);

    this._applyPressTransform();

    const pSettled = Math.abs(this._pressTarget - this.pressProgress) < 0.002 && Math.abs(this._pressVelocity) < 0.01;
    const sSettled =
      Math.abs(this._stretchTarget[0] - this.pressStretch[0]) < 0.002 &&
      Math.abs(this._stretchTarget[1] - this.pressStretch[1]) < 0.002 &&
      Math.abs(this._stretchVelocity[0]) < 0.01 &&
      Math.abs(this._stretchVelocity[1]) < 0.01;

    if (pSettled && sSettled) {
      this.pressProgress = this._pressTarget;
      this._pressVelocity = 0;
      this.pressStretch = [this._stretchTarget[0], this._stretchTarget[1]];
      this._stretchVelocity = [0, 0];
      this._pressAnimating = false;
      this._applyPressTransform();
      if (this._pressTarget === 0) {
        this.touchPoint = null;
      }
      return false;
    }
    return true;
  }

  _applyPressTransform() {
    const target = this.pressTransformTarget;
    if (!target) return;
    const p = this.pressProgress;
    const sx = this.pressStretch[0];
    const sy = this.pressStretch[1];
    const mag = Math.hypot(sx, sy);
    if (Math.abs(p) < 0.001 && mag < 0.001) {
      target.style.transform = '';
      return;
    }
    const w = Math.max(target.offsetWidth || 120, 24);
    const h = Math.max(target.offsetHeight || 34, 24);
    // Calibrate press expansion and rubber-band stretch in physical CSS pixels (~5-9px),
    // so large panels (#panel-card), effect cards (div.row), and menus flex crisply without bloating.
    const uniformScaleBoost = Math.min(this.pressScaleAmount, 8.0 / Math.max(w, h));
    const baseScale = 1 + uniformScaleBoost * p;
    const ax = Math.min(Math.abs(sx), 1.25);
    const ay = Math.min(Math.abs(sy), 1.25);
    const gainX = Math.min(0.068, 11.0 / w);
    const gainY = Math.min(0.068, 11.0 / h);
    const scaleX = baseScale * (1 + gainX * ax - gainY * 0.35 * ay);
    const scaleY = baseScale * (1 + gainY * ay - gainX * 0.35 * ax);
    const tx = sx * this.pressTranslateAmount;
    const ty = sy * this.pressTranslateAmount;
    target.style.transformOrigin = '50% 50%';
    target.style.willChange = 'transform';
    target.style.backfaceVisibility = 'hidden';
    target.style.transform = `translate3d(${tx.toFixed(2)}px, ${ty.toFixed(2)}px, 0) scale3d(${scaleX.toFixed(4)}, ${scaleY.toFixed(4)}, 1)`;
  }

  _setInteractivePoint(event) {
    const rect = this._interactiveRect ?? this.element.getBoundingClientRect();
    const ox = this._interactiveOrigin ? this._interactiveOrigin[0] : event.clientX;
    const oy = this._interactiveOrigin ? this._interactiveOrigin[1] : event.clientY;
    const dx = event.clientX - ox;
    const dy = event.clientY - oy;
    const limitX = 48;
    const limitY = 36;
    const rx = Math.abs(dx) < 0.001 ? 0 : dx / (Math.abs(dx) + limitX);
    const ry = Math.abs(dy) < 0.001 ? 0 : dy / (Math.abs(dy) + limitY);
    this.setPressed(true, [event.clientX - rect.left, event.clientY - rect.top], [rx, ry]);
  }

  // The Swift ShadowView casts a multiply-blended shadow from a ring around the
  // pill, so the glass itself is never darkened. A transparent element with a
  // box-shadow paints outside the same way.
  createShadowOverlay() {
    const shadow = document.createElement('div');
    Object.assign(shadow.style, {
      position: 'absolute',
      inset: '0',
      borderRadius: '0',
      boxShadow: '0 5.5px 3.5px rgba(0, 0, 0, 0.2)',
      mixBlendMode: 'multiply',
      pointerEvents: 'none',
    });
    this.element.append(shadow);
    this.shadow = shadow;
  }

  // The radius lives on the clipped surface, on the shadow's own outline and in
  // the shader. The surface clips the canvas to the same pill, which hides any
  // anti-aliased fringing the distance field leaves at the very edge, while the
  // shadow keeps the matching silhouette without being clipped itself.
  setCornerRadius(radius) {
    this.cornerRadius = radius;
    this.surface.style.borderRadius = `${radius}px`;
    if (this.shadow) {
      this.shadow.style.borderRadius = `${radius}px`;
    }
  }

  // Rects are in the view's own CSS pixels with an upper-left origin, exactly
  // like the `frames` array in the Swift view. An empty list falls back to the
  // view bounds.
  setFrames(frames) {
    this.frames = frames;
    this.requestDraw();
  }

  // Allocates the fixed backing from the stored raster size without waiting
  // for a draw. The menu morph starts from a zero-size box, so the first
  // visible frame would otherwise find the canvas still at its default
  // 300x150 allocation (and the capture canvas at its own default) and report
  // two distinct sizes to the tests — as well as doing a needless
  // reallocation at that.
  prepareRaster() {
    this._capturedOnce = false;
    if (!this.renderer || !this.rasterSize) return;
    this.renderer.resize(devicePixels(this.rasterSize.width),
      devicePixels(this.rasterSize.height));
    if (!this.captureRasterSize) return;
    const sizeCoefficient = this.liquidGlass.backgroundTextureSizeCoefficient;
    const scaleCoefficient = this.liquidGlass.backgroundTextureScaleCoefficient;
    this.captureCanvas.width = devicePixels(this.captureRasterSize.width * sizeCoefficient * scaleCoefficient);
    this.captureCanvas.height = devicePixels(this.captureRasterSize.height * sizeCoefficient * scaleCoefficient);
  }

  setBackgroundSource(source, sourceBounds = null) {
    this.source = source;
    this.sourceBounds = sourceBounds;
    this._capturedOnce = false;
    this.requestDraw();
  }

  setTouchPoint(point) {
    if (this.touchPoint?.[0] === point?.[0] && this.touchPoint?.[1] === point?.[1]) return;
    this.touchPoint = point;
    // A held press can finish its spring while the pointer keeps moving.
    // Updating the light must still invalidate that otherwise idle surface.
    this.requestDraw();
  }

  // Coalesces every invalidation in a frame into one draw. The Swift view is an
  // unpaused MTKView and redraws continuously; here the caller decides the
  // cadence, which keeps an idle panel from holding the GPU awake.
  requestDraw() {
    if (this.disposed || this.frameHandle || !this.renderer) {
      return;
    }
    this.frameHandle = requestAnimationFrame(now => {
      this.frameHandle = 0;
      this.draw(now);
      if (this._pressAnimating || performance.now() < this.captureUntil) this.requestDraw();
    });
  }

  // CSS track colours keep changing after their target style is assigned.
  // Capture those intermediate colours even when the backdrop itself is still.
  requestDrawFor(milliseconds) {
    this.captureUntil = Math.max(this.captureUntil, performance.now() + milliseconds);
    this.requestDraw();
  }

  draw(now = performance.now()) {
    // A frame owner can draw immediately after updating its geometry. Cancel
    // the deferred copy so it cannot repaint the previous geometry next frame.
    if (this.frameHandle) {
      cancelAnimationFrame(this.frameHandle);
      this.frameHandle = 0;
    }
    if (this.disposed || !this.renderer || (!this.source && !this.backgroundLayers.length && !this.onCapture)) {
      // Without a named backdrop there is nothing to refract; leaving the
      // canvas untouched keeps the control transparent instead of painting a
      // black rectangle.
      return;
    }

    if (this._pressAnimating) {
      this._stepPress(now);
    }

    if (this.autoCapture) {
      this.captureBackground();
    }

    const uniforms = this.buildUniforms();
    if (!uniforms) {
      return;
    }

    const blurSigma = this.liquidGlass.backgroundTextureBlurRadius * (window.devicePixelRatio || 1);
    this.renderer.draw(uniforms, blurSigma);
  }

  buildUniforms() {
    let width;
    let height;
    if (this.fixedViewBounds) {
      width = this.fixedViewBounds.width;
      height = this.fixedViewBounds.height;
    } else {
      const style = getComputedStyle(this.element);
      width = Number.parseFloat(style.width) || this.element.clientWidth;
      height = Number.parseFloat(style.height) || this.element.clientHeight;
    }
    if (!width || !height) {
      return null;
    }

    const dpr = window.devicePixelRatio || 1;
    // Keep lens storage large enough for its full deformation range. Logical
    // geometry still changes every frame; its texture allocation need not.
    this.renderer.resize(devicePixels(this.rasterSize?.width ?? width),
      devicePixels(this.rasterSize?.height ?? height));

    const uniforms = this.liquidGlass.uniforms;
    return {
      ...uniforms,
      resolution: [width * dpr, height * dpr],
      contentsScale: dpr,
      touchPoint: this.touchPoint ?? [width / 2, height / 2],
      pressProgress: this.pressProgress,
      pressStretch: this.pressStretch,
      pressInflate: this.pressInflate,
      cornerRadius: this.cornerRadius,
      cornerRoundnessExponent: uniforms.cornerRoundnessExponent,
      shapeMergeSmoothness: this.shapeMergeSmoothness || 0.0001,
      optics: this.liquidGlass.resolveOptics(THEME_QUERY.matches, {
        width, height,
        sourceWidth: this.renderer.backgroundWidth,
        sourceHeight: this.renderer.backgroundHeight,
      }),
      materialTint: this.liquidGlass.resolveTint(THEME_QUERY.matches),
      backdropTone: this.liquidGlass.resolveBackdropTone(THEME_QUERY.matches),
      rectangles: this.frames.length
        ? this.frames
        : [{ x: 0, y: 0, width, height }],
    };
  }

  // Draws the part of the backdrop the glass covers, expanded by the material's
  // size coefficient and scaled by its capture coefficient. For the lens the
  // expansion is what magnifies the content; for the regular material the
  // downscale is the cheap frost.
  captureBackground() {
    const source = this.source;
    if (!this.captureContext) return;
    if (this.staticCapture && this._capturedOnce) return;
    const sourceBounds = this.resolveSourceBounds();

    // The on-screen rect (transforms included) is used here, unlike the shader
    // geometry, because a squashed lens is still sampling what is really behind
    // it. Fixed-surface menus supply `fixedViewBounds` to skip synchronous
    // DOM layout reads during spring frames.
    const viewRect = this.fixedViewBounds ?? this.element.getBoundingClientRect();
    if (!viewRect.width || !viewRect.height) {
      return;
    }

    const sizeCoefficient = this.liquidGlass.backgroundTextureSizeCoefficient;
    const scaleCoefficient = this.liquidGlass.backgroundTextureScaleCoefficient;
    const dpr = window.devicePixelRatio || 1;

    const captureWidth = viewRect.width * sizeCoefficient;
    const captureHeight = viewRect.height * sizeCoefficient;
    const captureLeft = viewRect.left + (viewRect.width - captureWidth) / 2;
    const captureTop = viewRect.top + (viewRect.height - captureHeight) / 2;

    const sourcePixelWidth = source && (source.naturalWidth || source.videoWidth || source.width);
    const sourcePixelHeight = source && (source.naturalHeight || source.videoHeight || source.height);
    const pixelWidth = devicePixels((this.captureRasterSize?.width ?? viewRect.width) * sizeCoefficient * scaleCoefficient);
    const pixelHeight = devicePixels((this.captureRasterSize?.height ?? viewRect.height) * sizeCoefficient * scaleCoefficient);
    if (this.captureCanvas.width !== pixelWidth) {
      this.captureCanvas.width = pixelWidth;
    }
    if (this.captureCanvas.height !== pixelHeight) {
      this.captureCanvas.height = pixelHeight;
    }

    const context = this.captureContext;
    context.clearRect(0, 0, pixelWidth, pixelHeight);
    if (sourcePixelWidth && sourcePixelHeight && sourceBounds?.width && sourceBounds?.height) {
      const scaleX = sourcePixelWidth / sourceBounds.width;
      const scaleY = sourcePixelHeight / sourceBounds.height;
      context.drawImage(source,
        (captureLeft - sourceBounds.left) * scaleX,
        (captureTop - sourceBounds.top) * scaleY,
        captureWidth * scaleX, captureHeight * scaleY,
        0, 0, pixelWidth, pixelHeight);
    }

    // Composite scene elements beneath the control first, then paint the
    // control's own backgroundLayers (track/fill) on top before refraction.
    context.save();
    context.setTransform(pixelWidth / captureWidth, 0, 0, pixelHeight / captureHeight,
      -captureLeft * pixelWidth / captureWidth, -captureTop * pixelHeight / captureHeight);
    this.onCapture?.(context, {
      captureLeft,
      captureTop,
      captureWidth,
      captureHeight,
      pixelWidth,
      pixelHeight,
    });
    for (const layer of this.backgroundLayers) {
      const style = getComputedStyle(layer);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      const rect = layer.getBoundingClientRect();
      if (!rect.width || !rect.height) continue;
      context.globalAlpha = Number.parseFloat(style.opacity) || 0;
      context.fillStyle = style.backgroundColor;
      const radius = Math.min(Number.parseFloat(style.borderTopLeftRadius) || 0,
        rect.width / 2, rect.height / 2);
      context.beginPath();
      context.roundRect(rect.left, rect.top, rect.width, rect.height, radius);
      context.fill();
    }
    context.restore();

    this.renderer.setBackground(this.captureCanvas);
    this._capturedOnce = true;
  }

  resolveSourceBounds() {
    if (typeof this.sourceBounds === 'function') {
      return this.sourceBounds();
    }
    if (this.sourceBounds) {
      return this.sourceBounds;
    }
    if (this.source && typeof this.source.getBoundingClientRect === 'function') {
      return this.source.getBoundingClientRect();
    }
    return null;
  }

  appendTo(parent) {
    parent.append(this.element);
    return this;
  }

  remove() {
    this.element.remove();
  }

  dispose() {
    this.disposed = true;
    this._unbindInteractive();
    if (this.pressTransformTarget) {
      this.pressTransformTarget.style.transform = '';
    }
    if (this.frameHandle) {
      cancelAnimationFrame(this.frameHandle);
      this.frameHandle = 0;
    }
    if (this.renderer) {
      this.renderer.dispose();
      this.renderer = null;
    }
    this.element.remove();
  }
}
