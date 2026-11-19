import { MenuView as BaseMenuView } from '../ui/menuview.js';
import { createMenuMaterial } from './menu-material.js';
import { LiquidGlassView } from './glass-view.js';
import { clamp, prefersReducedMotion } from './spring.js';
import { normalizeMenuConfig } from './context-menu.js';

const MENU_WIDTH = 200;
const MENU_RADIUS = 32;

const lerp = (a, b, t) => a + (b - a) * t;

/** Closed-form damped harmonic oscillator matching Apple Music's Spring. */
class AnalyticalSpring {
  constructor(value = 0, target = 0, response = 0.35, dampingRatio = 1) {
    this.value = value;
    this.velocity = 0;
    this.target = target;
    this.configure(response, dampingRatio);
  }

  configure(response, dampingRatio) {
    this.response = Math.max(response, 0.001);
    this.zeta = clamp(dampingRatio, 0, 2);
    const omega = (2 * Math.PI) / this.response;
    this.stiffness = omega * omega;
    this.damping = 2 * this.zeta * omega;
    this.elapsed = 0;
    this.x0 = this.value;
    this.v0 = this.velocity;
  }

  retarget(target, response, dampingRatio) {
    this.target = target;
    this.configure(response, dampingRatio);
  }

  snap(target) {
    this.value = target;
    this.target = target;
    this.velocity = 0;
    this.x0 = target;
    this.v0 = 0;
    this.elapsed = 0;
  }

  step(dt) {
    if (dt <= 0) return;
    this.elapsed += dt;
    const t = this.elapsed;
    const dx0 = this.x0 - this.target;
    if (this.zeta < 1 - 1e-6) {
      const gamma = this.damping * 0.5;
      const wd = 0.5 * Math.sqrt(Math.max(0, 4 * this.stiffness - this.damping * this.damping));
      const a = dx0;
      const b = wd > 1e-6 ? (this.v0 + gamma * dx0) / wd : 0;
      const decay = Math.exp(-gamma * t);
      const cos = Math.cos(wd * t);
      const sin = Math.sin(wd * t);
      this.value = this.target + decay * (a * cos + b * sin);
      this.velocity = decay * ((b * wd - gamma * a) * cos - (a * wd + gamma * b) * sin);
    } else {
      const w0 = Math.sqrt(this.stiffness);
      const decay = Math.exp(-w0 * t);
      const a = dx0;
      const b = this.v0 + w0 * dx0;
      this.value = this.target + decay * (a + b * t);
      this.velocity = decay * (b - w0 * (a + b * t));
    }
  }

  isSettled(posEps = 0.01, velEps = 0.02) {
    return Math.abs(this.target - this.value) <= posEps && Math.abs(this.velocity) <= velEps;
  }
}

class LiquidSpring {
  constructor(dampingRatio, stiffness, value = 0) {
    this.dampingRatio = dampingRatio;
    this.stiffness = stiffness;
    this.threshold = 0.001;
    this.value = value;
    this.velocity = 0;
    this.target = value;
  }

  step(dt) {
    if (this.value === this.target && this.velocity === 0) return false;
    const substeps = 8;
    const h = dt / substeps;
    const damping = 2 * this.dampingRatio * Math.sqrt(this.stiffness);
    for (let i = 0; i < substeps; i++) {
      const acceleration = -this.stiffness * (this.value - this.target) - damping * this.velocity;
      this.velocity += acceleration * h;
      this.value += this.velocity * h;
    }
    if (Math.abs(this.value - this.target) < this.threshold &&
      Math.abs(this.velocity) < this.threshold * 10) {
      this.value = this.target;
      this.velocity = 0;
      return false;
    }
    return true;
  }
}

let nextMenuId = 0;

export class MenuView extends BaseMenuView {
  constructor(trigger, options = {}) {
    const menuConfig = normalizeMenuConfig(
      options.menuConfig ?? options.items ?? options.menuItems ?? []);
    super(trigger, {
      ...options,
      items: menuConfig.items,
      title: options.title ?? menuConfig.title,
      width: options.width ?? MENU_WIDTH,
      radius: options.radius ?? MENU_RADIUS,
      placement: options.placement ?? 'morph',
      trigger: options.trigger ?? 'press',
      edge: options.edge ?? 12,
      gap: options.gap ?? 0,
      onOpen: null,
    });
    this.source = options.source ?? null;
    this.sourceBounds = options.sourceBounds ?? null;
    this.onCapture = options.onCapture ?? null;
    this.backgroundLayers = options.backgroundLayers ?? [];
    this.live = options.live !== false;
    this.effect = options.effect ?? options.style ?? 'regular';
    this.material = options.material ?? createMenuMaterial(this.effect);
    this.morphSource = options.morphSource ?? this.trigger;
    if (typeof this.morphSource === 'string') {
      this.morphSource = document.querySelector(this.morphSource) ?? this.trigger;
    }
    this._baseThickness = this.material.uniforms.glassThickness;
    this._baseDispersion = this.material.uniforms.dispersionStrength;
    this._groupAnimations = new Map();
    this._onOpenGlass = options.onOpen ?? null;
    this.glass = null;
    this._content = null;
    this._face = null;
    this._progress = 0;
    this._contentAlpha = 0;
    this._morph = null;
    this._morphState = null;
    this._visual = null;
    this._lastFrameTime = 0;
    this._closing = false;
    this._awaitingDidShow = false;
    this._closeRestoreFocus = false;
    this._frameHandle = 0;
    this._selectionTimer = 0;
    this._closePromise = null;
    this._resolveClose = null;
    this._destroyed = false;
    this._menuId = `solarium-menu-${++nextMenuId}`;
    this._didSelectItem = false;
    this._suppressCancel = false;
    this._previewCommit = null;
    this._sourceOpacity = this.morphSource.style.opacity;
    this._sourceBaseOpacity = Number(getComputedStyle(this.morphSource).opacity);
    this._glassPressing = false;
    this._pressAnchor = null;
    this._pressingItem = null;
    this._onGlassPointerMove = event => this._updateGlassPress(event);
    this._onGlassPointerUp = () => this._clearGlassPress();
    this._onMenuPointerDown = event => {
      if (event.button !== 0 || this.state !== 'open') return;
      this._beginGlassPress(event);
    };
    this._onContextMenu = event => { event.preventDefault(); this.open(); };
    this.trigger.addEventListener('contextmenu', this._onContextMenu);
    this.trigger.removeEventListener('pointerdown', this._onTriggerDown);
    this._onTriggerPress = event => {
      if (this.opts.trigger !== 'press' || event.button !== 0) return;
      if (this.state === 'open') { this._commitPreview(); return; }
      this.open();
      this._beginGlassPress(event);
      this._press = { t: performance.now(), x: event.clientX, y: event.clientY };
      window.addEventListener('pointermove', this._onMove);
      window.addEventListener('pointerup', this._onUp);
      window.addEventListener('pointercancel', this._endPress);
    };
    this.trigger.addEventListener('pointerdown', this._onTriggerPress);
    this._previousControls = this.trigger.getAttribute('aria-controls');
    this.trigger.setAttribute('aria-controls', this._menuId);
    if (!this.opts.deferGlass) {
      const prepare = () => {
        this._warmupHandle = null;
        if (!this._destroyed) this._ensureGlass();
      };
      this._warmupHandle = window.requestIdleCallback
        ? window.requestIdleCallback(prepare, { timeout: 500 })
        : setTimeout(prepare, 0);
    }
  }

  setItems(items) {
    const config = normalizeMenuConfig(items);
    this.opts.items = config.items;
    if (config.title != null) this.opts.title = config.title;
  }

  setBackgroundSource(source, bounds = null) {
    this.source = source;
    this.sourceBounds = bounds;
    if (this.glass) {
      this.glass._capturedOnce = false;
      this.glass.setBackgroundSource(source, bounds);
    }
    this._syncFallback();
    this.requestDraw();
    return this;
  }

  requestDraw() {
    if (!this._frameHandle && this._menu && !this._destroyed) {
      this._frameHandle = requestAnimationFrame(now => this._frame(now));
    }
  }

  _build() {
    const menu = super._build();
    menu.classList.add('solarium-menuview');
    menu.id = this._menuId;
    this._rowIndex = 0;
    this._decorateItems(this._items.slice());
    if (this.opts.title) {
      const title = document.createElement('div');
      title.className = 'solarium-menuview__title';
      title.textContent = this.opts.title;
      menu.prepend(title);
    }
    menu.style.width = `${Math.min(this.opts.width, innerWidth - this.opts.edge * 2)}px`;
    const content = document.createElement('div');
    content.className = 'solarium-menuview__content';
    content.setAttribute('role', 'presentation');
    content.append(...menu.children);
    menu.style.maxHeight = `${Math.max(44, innerHeight - this.opts.edge * 2)}px`;
    menu.setAttribute('aria-label', this.opts.label ?? this.trigger.getAttribute('aria-label') ?? 'Actions');

    this._ensureGlass();
    if (this.glass) {
      this.glass.element.classList.add('solarium-menuview__glass');
      Object.assign(this.glass.element.style, {
        position: 'absolute',
        left: '0px',
        top: '0px',
        zIndex: '0',
      });
      menu.append(this.glass.element);
    }

    const face = this.morphSource.cloneNode(true);
    face.classList.add('solarium-menuview__face');
    face.setAttribute('aria-hidden', 'true');
    face.removeAttribute('id');
    face.querySelectorAll('[id]').forEach(node => node.removeAttribute('id'));
    face.querySelectorAll('canvas').forEach(node => node.remove());
    face.style.background = 'transparent';
    face.style.border = '0';
    face.style.boxShadow = 'none';
    this._face = face;

    const clip = document.createElement('div');
    clip.className = 'solarium-menuview__clip';
    clip.setAttribute('role', 'presentation');
    clip.append(face, content);
    menu.append(clip);
    menu.addEventListener('pointerdown', this._onMenuPointerDown);
    menu.addEventListener('pointermove', event => {
      if (this.state !== 'open') return;
      const row = event.target instanceof Element ? event.target.closest('.menuview__item') : null;
      if (row && !row.classList.contains('is-disabled')) {
        const r = row.getBoundingClientRect();
        row.style.setProperty('--menu-px', `${(event.clientX - r.left).toFixed(1)}px`);
        row.style.setProperty('--menu-py', `${(event.clientY - r.top).toFixed(1)}px`);
      }
    });
    if (this.glass) {
      this.glass.pressTransformTarget = menu;
      this.glass.pressScaleAmount = 0.036;
      this.glass.pressTranslateAmount = 10;
    }
    this._clip = clip;
    this._content = content;
    return menu;
  }

  _decorateItems(entries, parent = null) {
    for (const entry of entries) {
      const { el, item } = entry;
      entry.parent = parent;
      if (item.hidden) {
        el.hidden = true;
        el.style.display = 'none';
      }
      if (item.size === 'small') el.classList.add('is-small');
      else if (item.size === 'large') el.classList.add('is-large');
      el.style.setProperty('--i', String(this._rowIndex++));
      const label = el.querySelector('.menuview__label');
      label.textContent = item.label ?? item.title ?? item.actionTitle ?? item.menuTitle ?? '';
      if (label.textContent.includes('\n')) el.classList.add('has-multiline');
      if (item.subtitle ?? item.actionSubtitle) {
        const subtitle = document.createElement('span');
        subtitle.className = 'solarium-menuview__subtitle';
        subtitle.textContent = item.subtitle ?? item.actionSubtitle;
        label.append(subtitle);
        el.classList.add('has-subtitle');
      }
      const state = item.state ?? (typeof item.checked === 'boolean' ? (item.checked ? 'on' : 'off') : undefined);
      if (state && !item.children?.length) {
        el.setAttribute('role', 'menuitemcheckbox');
        el.setAttribute('aria-checked', state === 'mixed' ? 'mixed' : String(state === 'on'));
        if (state !== 'off') {
          const check = document.createElement('span');
          check.className = 'solarium-menuview__accessory';
          check.setAttribute('aria-hidden', 'true');
          check.textContent = state === 'on' ? '✓' : '–';
          el.append(check);
        }
      }
      if (!item.children?.length) continue;
      const group = document.createElement('div');
      group.className = 'solarium-menuview__group';
      group.id = `${this._menuId}-group-${this._items.indexOf(entry)}`;
      group.setAttribute('role', 'group');
      group.setAttribute('aria-label', item.label ?? item.title ?? '');
      entry.group = group;
      entry.inline = !!item.inline;
      el.after(group);
      if (entry.inline) {
        el.hidden = true;
        const heading = document.createElement('div');
        heading.className = 'solarium-menuview__title';
        heading.textContent = item.label ?? item.title ?? '';
        group.append(heading);
      } else {
        group.hidden = true;
        el.setAttribute('aria-expanded', 'false');
        el.setAttribute('aria-controls', group.id);
        const chevron = document.createElement('span');
        chevron.className = 'solarium-menuview__accessory solarium-menuview__chevron';
        chevron.setAttribute('aria-hidden', 'true');
        chevron.textContent = '›';
        el.append(chevron);
      }
      const builder = { opts: { ...this.opts, items: item.children }, _items: [] };
      const children = BaseMenuView.prototype._build.call(builder);
      const childItems = builder._items;
      this._items.splice(this._items.indexOf(entry) + 1, 0, ...childItems);
      group.append(...children.children);
      this._decorateItems(childItems, entry);
    }
  }

  _focusable() {
    return this._items.filter(entry => !entry.item.disabled && !entry.el.hidden &&
      !entry.el.closest('[hidden], [inert]') && !this._hasDisabledParent(entry)).map(entry => entry.el);
  }

  _hasDisabledParent(entry) {
    for (let parent = entry.parent; parent; parent = parent.parent) {
      if (parent.item.disabled) return true;
    }
    return false;
  }

  _setGroupExpanded(entry, expanded) {
    const group = entry.group;
    const from = group.hidden ? 0 : group.getBoundingClientRect().height;
    group.hidden = false;
    group.style.height = '';
    const height = group.getBoundingClientRect().height;
    group.inert = !expanded;
    entry.el.setAttribute('aria-expanded', String(expanded));
    const spring = new LiquidSpring(expanded ? 0.85 : 1, expanded ? 400 : 500);
    spring.target = 1;
    this._groupAnimations.set(entry, { from, to: expanded ? height : 0, spring, last: 0 });
    group.style.height = `${expanded ? height : 0}px`;
    group.style.opacity = expanded ? '1' : '0';
    group.hidden = !expanded;
  }

  _toggleSubmenu(entry, expanded = entry.el.getAttribute('aria-expanded') !== 'true') {
    if (!entry.group || entry.inline || entry.item.disabled) return;
    for (const sibling of this._items) {
      if (sibling !== entry && sibling.parent === entry.parent && sibling.group && !sibling.inline &&
        sibling.el.getAttribute('aria-expanded') === 'true') this._setGroupExpanded(sibling, false);
    }
    this._setGroupExpanded(entry, expanded);
    const from = { ...this._morph.to };
    this._content.style.height = 'auto';
    const measured = this._measure();
    const spring = new LiquidSpring(0.85, 220);
    spring.target = 1;
    this._layoutTransition = { from, to: measured.to, spring, last: 0 };
    this._morph = measured;
    if (this.glass) {
      this.glass.fixedViewBounds = measured.viewportSurface;
      this.glass._capturedOnce = false;
    }
    if (prefersReducedMotion()) {
      this._layoutTransition = null;
      this._prepareGlassSurface(measured.surface);
      this._snapMorphToTarget(1);
      this._applyVisual(1);
    } else {
      this._morph.to = from;
    }
    this._stepGroups(0);
    this._syncGroupDimming();
    this.requestDraw();
  }

  _stepGroups(now) {
    for (const [entry, animation] of this._groupAnimations) {
      const dt = Math.min(animation.last ? (now - animation.last) / 1000 : 1 / 60, 1 / 30) /
        Math.max(this.opts.slowMo, 0.001);
      animation.last = now;
      const moving = !prefersReducedMotion() && animation.spring.step(dt);
      const progress = moving ? animation.spring.value : 1;
      if (moving) entry.group.hidden = false;
      entry.group.style.height = `${Math.max(0, lerp(animation.from, animation.to, progress))}px`;
      entry.group.style.opacity = String(clamp(animation.to ? progress : 1 - progress, 0, 1));
      if (!moving) {
        entry.group.hidden = animation.to === 0;
        entry.group.style.height = '';
        entry.group.style.opacity = '';
        this._groupAnimations.delete(entry);
      }
    }
  }

  _syncGroupDimming() {
    for (const entry of this._items) {
      const siblings = this._items.filter(other => other.parent === entry.parent);
      const active = siblings.find(other => other.el.getAttribute('aria-expanded') === 'true');
      entry.el.classList.toggle('is-dimmed', !!active && active !== entry);
    }
  }

  _ensureGlass() {
    if (this.effect === 'none') return;
    if (!this.glass) {
      const material = Object.assign(Object.create(Object.getPrototypeOf(this.material)), this.material);
      const resolveTint = this.material.resolveTint.bind(this.material);
      const resolveTone = this.material.resolveBackdropTone.bind(this.material);
      const resolveOptics = this.material.resolveOptics.bind(this.material);
      material.resolveOptics = (dark, geometry) => resolveOptics(this.opts.theme === 'dark' ? true
        : this.opts.theme === 'light' ? false : dark, geometry);
      material.resolveBackdropTone = dark => resolveTone(this.opts.theme === 'dark' ? true
        : this.opts.theme === 'light' ? false : dark);
      material.resolveTint = dark => resolveTint(this.opts.theme === 'dark' ? true
        : this.opts.theme === 'light' ? false : dark);
      this.glass = new LiquidGlassView(material, {
        source: this.source,
        sourceBounds: this.sourceBounds,
        onCapture: this.onCapture,
        backgroundLayers: this.backgroundLayers,
        cornerRadius: this.opts.radius,
        pressInflate: 0,
      });
      Object.assign(this.glass.element.style, { position: 'absolute', left: '0px', top: '0px', zIndex: '0' });
      this.glass.element.setAttribute('aria-hidden', 'true');
    }
  }

  _syncFallback() {
    if (!this._menu) return;
    const reducedTransparency = window.matchMedia('(prefers-reduced-transparency: reduce)').matches;
    if (reducedTransparency) {
      this._menu.dataset.reducedTransparency = 'true';
    } else {
      delete this._menu.dataset.reducedTransparency;
    }
    const canRenderGlass = !reducedTransparency && this.glass?.renderer && (this.source || this.backgroundLayers.length);
    this._menu.dataset.glass = canRenderGlass ? 'rendered' : 'fallback';
    if (this.glass) {
      this.glass.element.style.display = canRenderGlass ? '' : 'none';
    }
  }

  _computeGlassSurface(from, to) {
    const padX = Math.max(20, (to.left - from.left) + 12, (from.left + from.width) - (to.left + to.width) + 12);
    const padY = Math.max(36, (to.top - from.top) + 12, (from.top + from.height) - (to.top + to.height) + 12);
    return {
      left: to.left - padX,
      top: to.top - padY,
      width: Math.max(1, Math.ceil(to.width + padX * 2)),
      height: Math.max(1, Math.ceil(to.height + padY * 2)),
    };
  }

  _prepareGlassSurface(surface) {
    if (!this.glass || !surface) return;
    const rasterWidth = Math.max(1, Math.ceil(surface.width));
    const rasterHeight = Math.max(1, Math.ceil(surface.height));
    this.glass.setCornerRadius(0);
    Object.assign(this.glass.element.style, {
      left: '0px',
      top: '0px',
      width: `${rasterWidth}px`,
      height: `${rasterHeight}px`,
    });
    this.glass.rasterSize = { width: rasterWidth, height: rasterHeight };
    this.glass.captureRasterSize = this.glass.rasterSize;
    this.glass.prepareRaster();
  }

  open(viaKeyboard = false) {
    if (this._destroyed || this.state === 'open') return;
    this.opts.onMenuWillCreate?.();
    super.open(viaKeyboard);
    if (!this._menu || this._destroyed) return;
    this._anims.forEach(animation => animation.cancel());
    this._anims = [];
    this._blur?.classList.add('solarium-menuview__blur');
    this._shade.classList.add('solarium-menuview__shade');
    this._sourceBaseOpacity = Number(getComputedStyle(this.morphSource).opacity);
    this._morph = this._measure();
    if (this.glass) {
      this.glass.fixedViewBounds = this._morph.viewportSurface;
      this.glass.staticCapture = !this.live;
      this.glass._capturedOnce = false;
    }
    this._prepareGlassSurface(this._morph.surface);
    this._progress = prefersReducedMotion() ? 1 : 0;
    this._contentAlpha = prefersReducedMotion() ? 1 : 0;
    this._closing = false;
    this._didSelectItem = false;
    this._suppressCancel = false;
    this._previewCommit = null;
    this._syncFallback();
    this.opts.onMenuWillShow?.();
    this._animateTo(1);
    this.requestDraw();
    this._onOpenGlass?.();
  }

  close({ restoreFocus = false } = {}) {
    if (this.state === 'closing') return this._closePromise;
    if (this.state !== 'open') return Promise.resolve(false);
    this._layoutTransition = null;
    this.state = 'closing';
    this.trigger.setAttribute('aria-expanded', 'false');
    this._endPress();
    window.removeEventListener('keydown', this._onKey);
    window.removeEventListener('resize', this._onResize);
    window.removeEventListener('scroll', this._onScroll, true);
    this._closePromise = new Promise(resolve => { this._resolveClose = resolve; });
    const promise = this._closePromise;
    this.opts.onMenuWillHide?.();
    if (!this._didSelectItem && !this._suppressCancel) this.opts.onMenuWillCancel?.();
    this._animateTo(0, restoreFocus);
    this.requestDraw();
    return promise;
  }

  _commitPreview() {
    this._previewCommit = this.opts.commitStyle ?? 'dismiss';
    this._suppressCancel = true;
    if (this._previewCommit === 'dismiss') this.opts.onPressMenuPreview?.();
    this.close();
  }

  _measure() {
    const o = this.opts;
    const mount = o.container ?? document.body;
    const fixed = mount === document.body;
    let ox = 0;
    let oy = 0;
    let bw = innerWidth;
    let bh = innerHeight;
    if (!fixed) {
      const cr = mount.getBoundingClientRect();
      ox = cr.left + mount.clientLeft;
      oy = cr.top + mount.clientTop;
      bw = mount.clientWidth;
      bh = mount.clientHeight;
    }
    const rect = this.morphSource.getBoundingClientRect();
    const trigger = {
      left: rect.left - ox,
      top: rect.top - oy,
      width: rect.width,
      height: rect.height,
    };

    const width = Math.min(o.width, Math.max(1, bw - o.edge * 2));
    const menu = this._menu;
    menu.style.width = `${width}px`;
    menu.style.height = 'auto';
    if (this._content) {
      this._content.style.width = `${width}px`;
      this._content.style.height = 'auto';
      this._content.style.maxHeight = `${Math.max(44, bh - o.edge * 2)}px`;
    }
    const height = Math.max(1, this._content ? this._content.offsetHeight : menu.offsetHeight);
    menu.style.height = `${height}px`;

    const placement = typeof o.placement === 'function' ? o.placement() : o.placement;
    const [direction, alignment = direction === 'morph' ? 'end' : 'center'] = placement.split('-');
    const aboveSpace = trigger.top;
    const belowSpace = bh - trigger.top - trigger.height;
    let above = direction === 'top' || (direction === 'auto' && aboveSpace > belowSpace);
    if (above && trigger.top - height - o.gap < o.edge && belowSpace > aboveSpace) above = false;
    if (!above && trigger.top + trigger.height + height + o.gap > bh - o.edge && aboveSpace > belowSpace) above = true;
    const preferredLeft = alignment === 'start' ? trigger.left
      : alignment === 'end' ? trigger.left + trigger.width - width
      : trigger.left + (trigger.width - width) / 2;
    let left = clamp(preferredLeft, o.edge, Math.max(o.edge, bw - width - o.edge));
    let top = clamp(above ? trigger.top - height - o.gap : trigger.top + trigger.height + o.gap,
      o.edge, Math.max(o.edge, bh - height - o.edge));
    if (direction === 'morph') {
      const panelHeight = Math.min(height, bh - o.edge * 2);
      const morphLeft = alignment === 'start'
        ? trigger.left
        : alignment === 'center'
          ? trigger.left + (trigger.width - width) / 2
          : trigger.left + trigger.width - width;
      left = clamp(morphLeft, o.edge, Math.max(o.edge, bw - width - o.edge));
      top = trigger.top;
      if (top + panelHeight > bh - o.edge) {
        top = Math.max(o.edge, trigger.top + trigger.height - panelHeight);
      }
      above = top < trigger.top;
    }

    const to = { left, top, width, height: Math.min(height, bh - o.edge * 2), radius: o.radius };
    const pillRadius = parseFloat(getComputedStyle(this.morphSource).borderTopLeftRadius) ||
      Math.min(trigger.width, trigger.height) / 2;
    const fromW = clamp(trigger.width, Math.min(24, to.width), to.width);
    const fromH = clamp(trigger.height, Math.min(24, to.height), Math.min(50, to.height));
    const fromX = direction === 'morph'
      ? clamp(trigger.left + (trigger.width - fromW) / 2, to.left, to.left + to.width - fromW)
      : alignment === 'end'
        ? clamp(trigger.left + trigger.width - fromW, to.left, to.left + to.width - fromW)
        : alignment === 'start'
          ? clamp(trigger.left, to.left, to.left + to.width - fromW)
          : clamp(trigger.left + (trigger.width - fromW) / 2, o.edge, Math.max(o.edge, bw - fromW - o.edge));
    const fromY = direction === 'morph'
      ? (above
        ? clamp(trigger.top + trigger.height - fromH, to.top, to.top + to.height - fromH)
        : clamp(trigger.top + (trigger.height - fromH) / 2, to.top, to.top + to.height - fromH))
      : trigger.top + (trigger.height - fromH) / 2;
    const from = {
      left: fromX,
      top: fromY,
      width: fromW,
      height: fromH,
      radius: Math.min(pillRadius, fromW / 2, fromH / 2),
    };

    if (this._content) {
      this._content.style.width = `${width}px`;
      this._content.style.height = `${to.height}px`;
    }
    menu.dataset.morph = above ? 'up' : 'down';
    const surface = this._computeGlassSurface(from, to);
    const viewportSurface = {
      left: surface.left + ox,
      top: surface.top + oy,
      width: surface.width,
      height: surface.height,
    };
    return {
      to,
      from,
      trigger,
      surface,
      viewportSurface,
      offsetX: ox,
      offsetY: oy,
      above,
      alignment,
      direction,
    };
  }

  _initMorphState(target, fromScratch = false) {
    const { from, to } = this._morph;
    const fromCX = from.left + from.width * 0.5;
    const fromCY = from.top + from.height * 0.5;
    const toCX = to.left + to.width * 0.5;
    const toCY = to.top + to.height * 0.5;
    const minFromDim = Math.min(from.width, from.height);
    const auxInset = 0.125 * minFromDim;
    const auxAxisTarget = (fc, tc, lo, hi) => {
      const p = fc + 0.25 * (tc - fc);
      const a = lo + auxInset;
      const b = hi - auxInset;
      return a > b ? tc : clamp(p, a, b);
    };
    const auxTargetCX = auxAxisTarget(fromCX, toCX, to.left, to.left + to.width);
    const auxTargetCY = auxAxisTarget(fromCY, toCY, to.top, to.top + to.height);
    const auxTargetSize = 0.25 * minFromDim;
    const capsuleR = 0.5 * Math.min(to.width, to.height);
    const menuR = Math.min(to.radius, capsuleR);
    const dirSign = to.height > 0
      ? clamp(2 * ((fromCY - to.top) / to.height) - 1, -1, 1)
      : 0;
    const heightFactor = clamp((to.height - 60) / 140, 0.5, 1);

    let s = this._morphState;
    if (!s || fromScratch) {
      s = {
        elapsed: 0,
        opening: target === 1,
        dirSign,
        heightFactor,
        auxTargetCX,
        auxTargetCY,
        auxTargetSize,
        capsuleR,
        menuR,
        released: false,
        staged788: false,
        staged848: false,
        staged908: false,
        staged608: false,
        platterCX: new AnalyticalSpring(fromCX, toCX, 0.36, 0.62),
        platterCY: new AnalyticalSpring(fromCY, toCY, 0.36, 0.62),
        platterW: new AnalyticalSpring(10, to.width, 0.36, 0.62),
        platterH: new AnalyticalSpring(10, to.height, 0.36, 0.62),
        platterR: new AnalyticalSpring(5, capsuleR, 0.36, 0.62),
        auxCX: new AnalyticalSpring(fromCX, auxTargetCX, 0.36, 0.62),
        auxCY: new AnalyticalSpring(fromCY, auxTargetCY, 0.36, 0.62),
        auxSize: new AnalyticalSpring(from.width, auxTargetSize, 0.36, 0.62),
        auxArcY: new AnalyticalSpring(0, 0, 0.36, 0.62),
        smoothK: new AnalyticalSpring(0, 1, 0.07, 1),
        unionOpacity: new AnalyticalSpring(1, 0, 0.36, 0.62),
        platterKickY: new AnalyticalSpring(0, 1, 0.14, 0.72),
        progress: new AnalyticalSpring(0, 1, 0.28, 1),
        lens: new AnalyticalSpring(0, 1, 0.14, 1),
        contentBlur: new AnalyticalSpring(4, 4, 0.315, 0.8),
      };
      this._morphState = s;
      return s;
    }

    s.elapsed = 0;
    s.opening = target === 1;
    s.dirSign = dirSign;
    s.heightFactor = heightFactor;
    s.auxTargetCX = auxTargetCX;
    s.auxTargetCY = auxTargetCY;
    s.auxTargetSize = auxTargetSize;
    s.capsuleR = capsuleR;
    s.menuR = menuR;
    s.staged788 = false;
    s.staged848 = false;
    s.staged908 = false;
    s.staged608 = false;

    if (s.opening) {
      s.released = false;
      s.platterCX.retarget(toCX, 0.36, 0.62);
      s.platterCY.retarget(toCY, 0.36, 0.62);
      s.platterW.retarget(to.width, 0.36, 0.62);
      s.platterH.retarget(to.height, 0.36, 0.62);
      s.platterR.retarget(capsuleR, 0.36, 0.62);
      s.auxCX.retarget(auxTargetCX, 0.36, 0.62);
      s.auxCY.retarget(auxTargetCY, 0.36, 0.62);
      s.auxSize.retarget(auxTargetSize, 0.36, 0.62);
      s.auxArcY.retarget(0, 0.36, 0.62);
      s.smoothK.retarget(1, 0.07, 1);
      s.unionOpacity.retarget(0, 0.36, 0.62);
      s.platterKickY.retarget(1, 0.14, 0.72);
      s.progress.retarget(1, 0.28, 1);
      s.lens.retarget(1, 0.14, 1);
      s.contentBlur.retarget(4, 0.315, 0.8);
    } else {
      s.released = true;
      // Exact reverse liquid-droplet close (matching Apple Music):
      // menu rounds into a spherical orb collapsing into (fromCX, fromCY, 10x10)
      // while aux swells from the anchor bubble back into the full trigger pill,
      // bridged continuously by smoothK and unionOpacity = 1.
      s.platterCX.retarget(fromCX, 0.36, 0.76);
      s.platterCY.retarget(fromCY, 0.36, 0.76);
      s.platterW.retarget(10, 0.32, 0.80);
      s.platterH.retarget(10, 0.32, 0.80);
      s.platterR.retarget(capsuleR, 0.18, 0.92);
      s.auxCX.retarget(fromCX, 0.34, 0.86);
      s.auxCY.retarget(fromCY, 0.34, 0.86);
      s.auxSize.retarget(minFromDim, 0.32, 0.86);
      s.auxArcY.retarget(1, 0.28, 0.85);
      s.smoothK.retarget(1, 0.035, 1);
      s.unionOpacity.retarget(1, 0.14, 0.95);
      s.platterKickY.retarget(1, 0.12, 1);
      s.progress.retarget(0, 0.28, 0.92);
      s.lens.retarget(1, 0.14, 1);
      s.contentBlur.retarget(4, 0.14, 1.0);
    }
    return s;
  }

  _snapMorphToTarget(target) {
    if (!this._morph) return;
    const s = this._initMorphState(target, !this._morphState);
    const { from, to } = this._morph;
    const fromCX = from.left + from.width * 0.5;
    const fromCY = from.top + from.height * 0.5;
    const toCX = to.left + to.width * 0.5;
    const toCY = to.top + to.height * 0.5;
    s.released = true;
    s.staged788 = true;
    s.staged848 = true;
    s.staged908 = true;
    s.staged608 = true;
    if (target === 1) {
      s.platterCX.snap(toCX);
      s.platterCY.snap(toCY);
      s.platterW.snap(to.width);
      s.platterH.snap(to.height);
      s.platterR.snap(s.menuR);
      s.auxCX.snap(s.auxTargetCX);
      s.auxCY.snap(s.auxTargetCY);
      s.auxSize.snap(s.auxTargetSize);
      s.auxArcY.snap(0);
      s.smoothK.snap(0);
      s.unionOpacity.snap(0);
      s.platterKickY.snap(0);
      s.progress.snap(1);
      s.lens.snap(0);
      s.contentBlur.snap(0);
    } else {
      s.platterCX.snap(fromCX);
      s.platterCY.snap(fromCY);
      s.platterW.snap(from.width);
      s.platterH.snap(from.height);
      s.platterR.snap(from.radius);
      s.auxCX.snap(fromCX);
      s.auxCY.snap(fromCY);
      s.auxSize.snap(Math.min(from.width, from.height));
      s.auxArcY.snap(0);
      s.smoothK.snap(0);
      s.unionOpacity.snap(0);
      s.platterKickY.snap(0);
      s.progress.snap(0);
      s.lens.snap(0);
      s.contentBlur.snap(0);
    }
  }

  _applyMorphBreakpoints(s) {
    const { to } = this._morph;
    if (s.opening) {
      if (!s.released && s.elapsed >= 0.07) {
        s.released = true;
        s.platterCX.retarget(to.left + to.width * 0.5, 0.35, 0.75);
        s.platterCY.retarget(to.top + to.height * 0.5, 0.35, 0.75);
        s.platterW.retarget(to.width, 0.35, 0.75);
        s.platterH.retarget(to.height, 0.35, 0.75);
        s.platterR.retarget(s.menuR, 0.35, 0.75);
      }
      if (!s.staged788 && s.elapsed >= 0.07) {
        s.staged788 = true;
        s.platterKickY.retarget(0, 0.35, 0.75);
      }
      if (!s.staged848 && s.elapsed >= 0.084) {
        s.staged848 = true;
        s.lens.retarget(0, 0.42, 1);
        s.contentBlur.retarget(0, 0.21, 1);
      }
      if (!s.staged908 && s.elapsed >= 0.21) {
        s.staged908 = true;
        s.smoothK.retarget(0, 0.42, 1);
      }
    } else {
      if (!s.staged788 && s.elapsed >= 0.065) {
        s.staged788 = true;
        s.platterKickY.retarget(0, 0.30, 0.84);
      }
      if (!s.staged848 && s.elapsed >= 0.065) {
        s.staged848 = true;
        // Settle lens distortion early so close handoff to morphSource has zero 1-frame pop.
        s.lens.retarget(0, 0.14, 1);
        s.contentBlur.retarget(0, 0.18, 1);
      }
      if (!s.staged608 && s.elapsed >= 0.095) {
        s.staged608 = true;
        s.auxArcY.retarget(0, 0.26, 0.90);
      }
      if (!s.staged908 && s.elapsed >= 0.17) {
        s.staged908 = true;
        s.smoothK.retarget(0, 0.24, 1);
      }
    }
  }

  _stepMorphState(dt) {
    const s = this._morphState;
    if (!s) return true;
    const events = s.opening
      ? [0.07, 0.084, 0.21]
      : [0.065, 0.095, 0.17];
    const targetTime = s.elapsed + Math.max(0, dt);
    const stepAll = slice => {
      if (slice <= 0) return;
      s.platterCX.step(slice);
      s.platterCY.step(slice);
      s.platterW.step(slice);
      s.platterH.step(slice);
      s.platterR.step(slice);
      s.auxCX.step(slice);
      s.auxCY.step(slice);
      s.auxSize.step(slice);
      s.auxArcY.step(slice);
      s.smoothK.step(slice);
      s.unionOpacity.step(slice);
      s.platterKickY.step(slice);
      s.progress.step(slice);
      s.lens.step(slice);
      s.contentBlur.step(slice);
    };

    for (const bp of events) {
      if (bp > s.elapsed && bp <= targetTime) {
        stepAll(bp - s.elapsed);
        s.elapsed = bp;
        this._applyMorphBreakpoints(s);
      }
    }
    if (targetTime > s.elapsed) {
      stepAll(targetTime - s.elapsed);
      s.elapsed = targetTime;
      this._applyMorphBreakpoints(s);
    }

    const stagesDone = s.staged788 && s.staged848 && s.staged908 && (s.opening || s.staged608) && s.released;
    if (!stagesDone) return false;
    if (!s.opening) {
      const { from } = this._morph;
      const fromCX = from.left + from.width * 0.5;
      const fromCY = from.top + from.height * 0.5;
      const platterTucked =
        Math.abs(s.platterCX.value - fromCX) < 3.5 &&
        Math.abs(s.platterCY.value - fromCY) < 3.5 &&
        s.platterW.value <= Math.max(18, from.height * 0.6) &&
        s.platterH.value <= Math.max(18, from.height * 0.6);
      return (
        s.elapsed >= 0.28 &&
        platterTucked &&
        s.auxCX.isSettled(0.6, 6) &&
        s.auxCY.isSettled(0.6, 6) &&
        s.auxSize.isSettled(0.6, 6) &&
        s.lens.isSettled(0.03, 0.2)
      );
    }
    return (
      s.platterCX.isSettled(0.35, 3) &&
      s.platterCY.isSettled(0.35, 3) &&
      s.platterW.isSettled(0.35, 3) &&
      s.platterH.isSettled(0.35, 3) &&
      s.platterR.isSettled(0.35, 3) &&
      s.auxCX.isSettled(0.5, 5) &&
      s.auxCY.isSettled(0.5, 5) &&
      s.auxSize.isSettled(0.5, 5) &&
      s.auxArcY.isSettled(0.02, 0.05) &&
      s.smoothK.isSettled(0.008, 0.04) &&
      s.unionOpacity.isSettled(0.01, 0.05) &&
      s.platterKickY.isSettled(0.02, 0.05) &&
      s.progress.isSettled(0.002, 0.02) &&
      s.lens.isSettled(0.02, 0.06) &&
      s.contentBlur.isSettled(0.05, 0.2)
    );
  }

  _applyVisual(rawProgress = this._progress) {
    if (!this._menu || !this._morph) return;
    const { to, from, trigger, surface, above, alignment, direction } = this._morph;
    const s = this._morphState;
    const progress = clamp(s ? s.progress.value : rawProgress, 0, 1);

    let curCX, curCY, curW, curH, curR;
    let auxCX, auxCY, auxSize, auxW, auxH, auxR, unionWeight, smoothPx, lensVal, blurPx;
    if (s) {
      curW = this._closing
        ? Math.max(10, s.platterW.value)
        : clamp(s.platterW.value, 10, to.width);
      curH = Math.max(10, s.platterH.value);
      curCX = s.platterCX.value;
      const kickScale = this._closing ? 36 : 80;
      const arcScale = this._closing ? 12 : 40;
      curCY = s.platterCY.value - kickScale * s.platterKickY.value * s.dirSign * s.heightFactor;
      curR = Math.min(Math.max(0, s.platterR.value), curW * 0.5, curH * 0.5);
      auxCX = s.auxCX.value;
      auxCY = s.auxCY.value + arcScale * s.auxArcY.value * s.dirSign * s.heightFactor;
      auxSize = Math.max(0, s.auxSize.value);
      if (this._closing) {
        const minFromDim = Math.max(1, Math.min(from.width, from.height));
        const auxStart = 0.25 * minFromDim;
        const auxGrow = clamp((auxSize - auxStart) / Math.max(1, minFromDim - auxStart), 0, 1);
        auxW = lerp(auxSize, from.width, Math.pow(auxGrow, 1.15));
        auxH = auxSize;
        auxR = Math.min(lerp(auxSize * 0.5, from.radius, auxGrow), auxW * 0.5, auxH * 0.5);
      } else {
        auxW = auxSize;
        auxH = auxSize;
        auxR = auxSize * 0.5;
      }
      unionWeight = clamp(s.unionOpacity.value, 0, 1);
      smoothPx = (this._closing ? 22 : 20) * clamp(s.smoothK.value, 0, 1);
      lensVal = clamp(s.lens.value, 0, 1.5);
      blurPx = (1 - progress) * 4;
    } else {
      curW = lerp(from.width, to.width, progress);
      curH = lerp(from.height, to.height, progress);
      curCX = lerp(from.left + from.width * 0.5, to.left + to.width * 0.5, progress);
      curCY = lerp(from.top + from.height * 0.5, to.top + to.height * 0.5, progress);
      curR = Math.min(lerp(from.radius, to.radius, progress), curW * 0.5, curH * 0.5);
      auxCX = curCX;
      auxCY = curCY;
      auxSize = 0;
      auxW = 0;
      auxH = 0;
      auxR = 0;
      unionWeight = 0;
      smoothPx = 0;
      lensVal = 0;
      blurPx = (1 - progress) * 4;
    }

    const fromCX = from.left + from.width * 0.5;
    const fromCY = from.top + from.height * 0.5;
    const toCX = to.left + to.width * 0.5;
    const toCY = to.top + to.height * 0.5;
    const fullSpan = Math.max(
      1,
      Math.abs(to.width - from.width),
      Math.abs(to.height - from.height),
      Math.hypot(toCX - fromCX, toCY - fromCY)
    );
    const curSpan = this._closing
      ? Math.max(
        Math.abs(curW - 10),
        Math.abs(curH - 10),
        Math.hypot(curCX - fromCX, curCY - fromCY)
      )
      : Math.max(
        Math.abs(curW - from.width),
        Math.abs(curH - from.height),
        Math.hypot(curCX - fromCX, curCY - fromCY)
      );
    const travelFrac = clamp(curSpan / Math.max(1, this._closing ? Math.max(to.width - 10, to.height - 10, fullSpan) : fullSpan), 0, 1);

    const platterX = curCX - curW * 0.5;
    const platterY = curCY - curH * 0.5;
    const curX = this._closing && auxW > 0.5
      ? Math.min(platterX, auxCX - auxW * 0.5)
      : platterX;
    const curY = this._closing && auxH > 0.5
      ? Math.min(platterY, auxCY - auxH * 0.5)
      : platterY;
    // GPU-accelerated menu morph:
    // Keep fixed to.left/top/width/height on both open and close so zero CSS
    // layout reflows happen per frame; all droplet motion runs purely in
    // WebGL2 + GPU compositor transforms/clip-path/opacity.
    const hostLeft = to.left;
    const hostTop = to.top;
    const hostW = to.width;
    const hostH = to.height;

    const menuStyle = {
      left: `${hostLeft}px`,
      top: `${hostTop}px`,
      width: `${hostW}px`,
      height: `${hostH}px`,
      borderRadius: `${this._transition ? 0 : to.radius}px`,
      opacity: '1',
      filter: 'none',
      boxShadow: this._transition ? 'none' : '',
    };
    const pressActive = Boolean(
      !this._closing &&
      (this._glassPressing ||
        this.glass?._pressAnimating ||
        this.glass?.isPressed ||
        Math.abs(this.glass?.pressProgress || 0) > 0.001 ||
        Math.hypot(...(this.glass?.pressStretch || [0, 0])) > 0.001)
    );
    if (this._transition && !pressActive) {
      menuStyle.transform = 'translateZ(0)';
    } else if (!pressActive) {
      menuStyle.transform = '';
    }
    Object.assign(this._menu.style, menuStyle);

    let contentAlpha = 1;
    if (this._content) {
      let shrinkFrac = 0;
      if (this._closing) {
        shrinkFrac = clamp((to.height - curH) / Math.max(24, (to.height - 10) * 0.42), 0, 1);
        contentAlpha = Math.pow(1 - shrinkFrac, 1.5);
      } else if (progress >= 0.995) {
        contentAlpha = 1;
      } else if (curH <= 54) {
        contentAlpha = 0;
      } else {
        const span = Math.max(40, (to.height - 54) * 0.65);
        const linear = clamp((curH - 54) / span, 0, 1);
        const eased = 1 - (1 - linear) * (1 - linear);
        contentAlpha = Math.max(this._contentAlpha, eased);
      }
      this._contentAlpha = contentAlpha;

      const alignShift = alignment === 'end'
        ? curW - to.width
        : alignment === 'start' ? 0 : (curW - to.width) * 0.5;
      const refX = this._closing ? platterX : curX;
      const refY = this._closing ? platterY : curY;
      const contentLeft = (refX - hostLeft) + alignShift;
      const contentTop = (refY - hostTop) + (above ? curH - to.height : 0);
      const originX = alignment === 'end'
        ? to.width - from.width * 0.5
        : alignment === 'start' ? from.width * 0.5 : to.width * 0.5;
      const originY = above ? to.height - from.height * 0.5 : from.height * 0.5;
      const contentScale = this._closing
        ? lerp(1, 0.62, shrinkFrac)
        : lerp(0.86, 1, contentAlpha);
      const effectiveBlur = contentAlpha >= 0.995 ? 0 : Math.max(blurPx, (1 - contentAlpha) * 3.8);
      const quantizedBlur = effectiveBlur <= 0.05 ? 0 : Math.round(effectiveBlur * 2) / 2;
      const isSettled = contentAlpha >= 0.999 && Math.abs(contentLeft) < 0.05 && Math.abs(contentTop) < 0.05;

      Object.assign(this._content.style, {
        opacity: String(contentAlpha),
        filter: quantizedBlur === 0 ? 'none' : `blur(${quantizedBlur.toFixed(1)}px)`,
        transformOrigin: `${originX}px ${originY}px`,
        transform: isSettled
          ? 'none'
          : `translate3d(${contentLeft.toFixed(2)}px, ${contentTop.toFixed(2)}px, 0) scale3d(${contentScale.toFixed(4)}, ${contentScale.toFixed(4)}, 1)`,
      });
    }

    if (this._clip) {
      this._clip.style.boxShadow = this._transition ? 'none' : '';
      if (this._transition) {
        const clipX = this._closing ? platterX : curX;
        const clipY = this._closing ? platterY : curY;
        const insetTop = Math.max(0, clipY - hostTop);
        const insetLeft = Math.max(0, clipX - hostLeft);
        const insetRight = Math.max(0, (hostLeft + hostW) - (clipX + curW));
        const insetBottom = Math.max(0, (hostTop + hostH) - (clipY + curH));
        this._clip.style.clipPath = `inset(${insetTop.toFixed(1)}px ${insetRight.toFixed(1)}px ${insetBottom.toFixed(1)}px ${insetLeft.toFixed(1)}px round ${curR.toFixed(1)}px)`;
      } else {
        this._clip.style.clipPath = '';
      }
    }

    // Crossfade the trigger icon cleanly inside the growing aux pill during late close.
    const triggerFade = this._closing
      ? clamp((0.32 - travelFrac) / 0.22, 0, 1)
      : clamp(1 - progress / 0.24, 0, 1);
    if (this._face) {
      const showFace = triggerFade > 0.01 && !prefersReducedMotion();
      Object.assign(this._face.style, {
        display: showFace ? '' : 'none',
        left: '0px',
        top: '0px',
        width: `${trigger.width}px`,
        height: `${trigger.height}px`,
        opacity: String(triggerFade * this._sourceBaseOpacity),
        transform: showFace
          ? `translate3d(${(trigger.left - hostLeft).toFixed(2)}px, ${(trigger.top - hostTop).toFixed(2)}px, 0)`
          : 'none',
      });
    }
    this.morphSource.style.opacity = String(
      this._closing
        ? 0
        : this._sourceBaseOpacity * clamp(1 - progress / 0.18, 0, 1)
    );

    if (this.glass) {
      this.glass.element.style.transform = `translate3d(${(surface.left - hostLeft).toFixed(2)}px, ${(surface.top - hostTop).toFixed(2)}px, 0)`;
      this.glass.liquidGlass.uniforms.glassThickness = lerp(this._baseThickness, this._baseThickness + 8, lensVal);
      this.glass.liquidGlass.uniforms.dispersionStrength = lerp(this._baseDispersion, 0.25, lensVal);
      this.glass.shapeMergeSmoothness = Math.max(0.0001, smoothPx / Math.max(1, surface.height));

      const frames = [{
        x: platterX - surface.left,
        y: platterY - surface.top,
        width: curW,
        height: curH,
        radius: curR,
        opacity: 1,
      }];
      if (auxSize > 0.5 && unionWeight > 0.005) {
        frames.push({
          x: auxCX - auxW * 0.5 - surface.left,
          y: auxCY - auxH * 0.5 - surface.top,
          width: auxW,
          height: auxH,
          radius: auxR,
          opacity: unionWeight,
        });
      }
      this.glass.setFrames(frames);
    }

    this._visual = { x: curX, y: curY, width: curW, height: curH, radius: curR, progress };
  }

  _frame(now) {
    this._frameHandle = 0;
    if (!this._menu || this._destroyed) return;
    this._stepGroups(now);
    if (this._layoutTransition) {
      const layout = this._layoutTransition;
      const dt = Math.min(layout.last ? (now - layout.last) / 1000 : 1 / 60, 0.05) /
        Math.max(this.opts.slowMo, 0.001);
      layout.last = now;
      const moving = !prefersReducedMotion() && layout.spring.step(dt);
      const progress = moving ? layout.spring.value : 1;
      this._morph.to = {
        ...layout.to,
        top: lerp(layout.from.top, layout.to.top, progress),
        height: lerp(layout.from.height, layout.to.height, progress),
      };
      this._morph.surface = this._computeGlassSurface(this._morph.from, this._morph.to);
      this._morph.viewportSurface = {
        left: this._morph.surface.left + (this._morph.offsetX || 0),
        top: this._morph.surface.top + (this._morph.offsetY || 0),
        width: this._morph.surface.width,
        height: this._morph.surface.height,
      };
      if (this.glass) {
        this.glass.fixedViewBounds = this._morph.viewportSurface;
        this.glass._capturedOnce = false;
      }
      this._snapMorphToTarget(1);
      this._prepareGlassSurface(this._morph.surface);
      this._applyVisual(this._progress);
      if (!moving) this._layoutTransition = null;
    }
    if (this._transition) {
      if (prefersReducedMotion()) this._finishTransition();
      else this._stepTransition(now);
    }
    if (!this._menu) return;
    if (this._menu.dataset.glass === 'rendered') {
      if (!this._closing) {
        this.glass.pressTransformTarget = this._menu;
        this.glass.pressScaleAmount = 0.036;
        this.glass.pressTranslateAmount = 10;
      } else {
        this.glass.pressTransformTarget = null;
      }
      this.glass.draw(now);
    }
    if (this._transition || this._layoutTransition || this._groupAnimations.size ||
      this.glass?._pressAnimating ||
      (this.state === 'open' && this.live && (this.source || this.backgroundLayers.length))) {
      this.requestDraw();
    }
  }

  _animateTo(target, restoreFocus = false) {
    this._restoreFocus = restoreFocus;
    this._closing = target === 0;
    const fromScratch = target === 1 && !this._transition;
    this._initMorphState(target, fromScratch);
    this._lastFrameTime = 0;
    this._transition = { target };
    this._awaitingDidShow = target === 1;
    if (prefersReducedMotion()) {
      this._finishTransition();
      return;
    }
    this._applyVisual(this._progress);
  }

  _stepTransition(now) {
    if (!this._morphState) {
      this._finishTransition();
      return;
    }
    const slow = Math.max(this.opts.slowMo ?? 1, 0.001);
    const dt = (this._lastFrameTime ? Math.min((now - this._lastFrameTime) / 1000, 0.05) : 1 / 60) / slow;
    this._lastFrameTime = now;
    const done = this._stepMorphState(dt);
    this._progress = clamp(this._morphState.progress.value, 0, 1);
    this._applyVisual(this._progress);
    if (done) this._finishTransition();
  }

  _finishTransition() {
    const transition = this._transition;
    if (!transition) return;
    this._transition = null;
    this._lastFrameTime = 0;
    if (transition.target === 1) {
      this._progress = 1;
      this._closing = false;
      this._snapMorphToTarget(1);
      this._applyVisual(1);
      if (this._awaitingDidShow) {
        this._awaitingDidShow = false;
        this.opts.onMenuDidShow?.();
      }
      return;
    }
    const restore = this._restoreFocus;
    const resolveClose = this._resolveClose;
    this._resolveClose = null;
    this._closePromise = null;
    this._teardown();
    resolveClose?.(true);
    this.opts.onClose?.();
    if (restore) this.trigger.focus({ preventScroll: true });
  }

  _onMenuKey(event) {
    const entry = this._items.find(item => item.el === document.activeElement);
    if (event.key === 'ArrowRight' && entry?.group && !entry.inline && !entry.item.disabled) {
      event.preventDefault();
      this._toggleSubmenu(entry, true);
      this._focusable().find(el => entry.group.contains(el))?.focus({ preventScroll: true });
      return;
    }
    if (event.key === 'ArrowLeft' && entry) {
      const parent = entry.group && entry.el.getAttribute('aria-expanded') === 'true' && !entry.inline ? entry : entry.parent;
      if (parent && !parent.inline) {
        event.preventDefault();
        this._toggleSubmenu(parent, false);
        parent.el.focus({ preventScroll: true });
        return;
      }
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      this._select(document.activeElement);
      return;
    }
    super._onMenuKey(event);
  }

  _select(element) {
    const entry = this._items.find(item => item.el === element);
    if (!entry || entry.item.disabled || this._hasDisabledParent(entry) || element.closest('[hidden], [inert]') ||
      this.state !== 'open' || this._selectionTimer) return;
    if (entry.group) {
      this._toggleSubmenu(entry);
      return;
    }
    element.classList.add('is-active');
    this._didSelectItem = true;
    if (entry.item.keepsMenuPresented) {
      setTimeout(() => element.classList.remove('is-active'),
        prefersReducedMotion() ? 0 : 160);
      (entry.item.onSelect ?? entry.item.onPress)?.(entry.item);
      this.opts.onSelect?.(entry.item);
      return;
    }
    this._selectionTimer = setTimeout(() => {
      this._selectionTimer = 0;
      this.close({ restoreFocus: this._viaKeyboard }).then(closed => {
        if (!closed || this._destroyed) return;
        (entry.item.onSelect ?? entry.item.onPress)?.(entry.item);
        this.opts.onSelect?.(entry.item);
      });
    }, prefersReducedMotion() ? 0 : 60);
  }

  _beginGlassPress(event) {
    if (!this._menu || !this._morph?.viewportSurface) return;
    this._glassPressing = true;
    this._pressAnchor = [event.clientX, event.clientY];
    this._updateGlassPress(event);
    window.addEventListener('pointermove', this._onGlassPointerMove);
    window.addEventListener('pointerup', this._onGlassPointerUp);
    window.addEventListener('pointercancel', this._onGlassPointerUp);
  }

  _updateGlassPress(event) {
    if (!this._glassPressing || !this._morph?.viewportSurface) return;
    const vs = this._morph.viewportSurface;
    const pt = [
      clamp(event.clientX - vs.left, 0, vs.width),
      clamp(event.clientY - vs.top, 0, vs.height),
    ];
    let stretch;
    if (this._pressAnchor) {
      const dx = event.clientX - this._pressAnchor[0];
      const dy = event.clientY - this._pressAnchor[1];
      stretch = [
        Math.abs(dx) < 0.001 ? 0 : dx / (Math.abs(dx) + 32),
        Math.abs(dy) < 0.001 ? 0 : dy / (Math.abs(dy) + 26),
      ];
    } else {
      stretch = [0, 0];
    }
    this.glass?.setPressed(true, pt, stretch);
    this._setPressingItem(event);
    this.requestDraw();
  }

  _clearGlassPress() {
    if (!this._glassPressing) return;
    this._glassPressing = false;
    this._pressAnchor = null;
    window.removeEventListener('pointermove', this._onGlassPointerMove);
    window.removeEventListener('pointerup', this._onGlassPointerUp);
    window.removeEventListener('pointercancel', this._onGlassPointerUp);
    this._pressingItem?.classList.remove('is-pressing');
    this._pressingItem = null;
    this.glass?.setPressed(false, null, [0, 0]);
    this.requestDraw();
  }

  _setPressingItem(event) {
    let target = event.target instanceof Element && this._menu?.contains(event.target)
      ? event.target
      : null;
    if (!target && event.clientX != null && event.clientY != null) {
      const hit = document.elementFromPoint(event.clientX, event.clientY);
      if (hit && this._menu?.contains(hit)) target = hit;
    }
    const row = target?.closest?.('.menuview__item');
    const valid = row && this._menu?.contains(row) && !row.classList.contains('is-disabled') && !row.hidden
      ? row
      : null;
    if (valid && event.clientX != null && event.clientY != null) {
      const r = valid.getBoundingClientRect();
      valid.style.setProperty('--menu-px', `${(event.clientX - r.left).toFixed(1)}px`);
      valid.style.setProperty('--menu-py', `${(event.clientY - r.top).toFixed(1)}px`);
    }
    if (this._pressingItem === valid) return;
    this._pressingItem?.classList.remove('is-pressing');
    this._pressingItem = valid;
    valid?.classList.add('is-pressing');
  }

  _teardown() {
    this._clearGlassPress();
    const wasPresented = this.state !== 'closed';
    if (wasPresented) {
      if (this._previewCommit === 'pop') this.opts.onPressMenuPreview?.();
      this.opts.onMenuDidHide?.();
      if (!this._didSelectItem && !this._suppressCancel) this.opts.onMenuDidCancel?.();
    }
    this._previewCommit = null;
    this._suppressCancel = false;
    if (this._frameHandle) cancelAnimationFrame(this._frameHandle);
    this._frameHandle = 0;
    clearTimeout(this._selectionTimer);
    this._selectionTimer = 0;
    this._transition = null;
    this._layoutTransition = null;
    this._morphState = null;
    this._lastFrameTime = 0;
    this._groupAnimations.clear();
    this._morph = null;
    this._visual = null;
    this.morphSource.style.opacity = this._sourceOpacity;
    if (this.glass) {
      this.glass.liquidGlass.uniforms.glassThickness = this._baseThickness;
      this.glass.liquidGlass.uniforms.dispersionStrength = this._baseDispersion;
      this.glass.shapeMergeSmoothness = 0.0001;
      this.glass.fixedViewBounds = null;
      this.glass.staticCapture = false;
      this.glass._capturedOnce = false;
      this.glass.pressTransformTarget = null;
      this.glass.setPressed(false, null, [0, 0]);
      if (this._menu) this._menu.style.transform = '';
      if (this.glass.frameHandle) cancelAnimationFrame(this.glass.frameHandle);
      this.glass.frameHandle = 0;
      this.glass.captureUntil = 0;
      this.glass.remove();
      if (this.opts.deferGlass) {
        this.glass.dispose();
        this.glass = null;
      }
    }
    this._resolveClose?.(false);
    this._resolveClose = null;
    this._closePromise = null;
    super._teardown();
  }

  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    this.trigger.removeEventListener('pointerdown', this._onTriggerPress);
    if (this._warmupHandle != null) {
      if (window.cancelIdleCallback) window.cancelIdleCallback(this._warmupHandle);
      else clearTimeout(this._warmupHandle);
      this._warmupHandle = null;
    }
    this.trigger.removeEventListener('contextmenu', this._onContextMenu);
    super.destroy();
    this.glass?.dispose();
    this.glass = null;
    if (this._previousControls == null) this.trigger.removeAttribute('aria-controls');
    else this.trigger.setAttribute('aria-controls', this._previousControls);
  }
}

export { MenuView as LiquidGlassMenuView };
export default MenuView;
