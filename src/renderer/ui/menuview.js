/*! menuview: iOS 18-style pull-down menu for the web. MIT.
 *  Spring-driven open/close, press-drag-release selection, keyboard + a11y.
 *  Pair with menuview.css.
 */

const clamp = (v, a, b) => Math.min(Math.max(v, a), b);
const prefersReducedMotion = () => !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

// SwiftUI-style spring (response, dampingFraction) -> CSS linear() easing.
const springCache = new Map();
function spring(response, zeta) {
    const key = `${response}|${zeta}`;
    if (springCache.has(key)) return springCache.get(key);
    const w = 2 * Math.PI / response;
    const f = zeta < 1
        ? t => { const wd = w * Math.sqrt(1 - zeta * zeta); return 1 - Math.exp(-zeta * w * t) * (Math.cos(wd * t) + (zeta * w / wd) * Math.sin(wd * t)); }
        : t => 1 - Math.exp(-w * t) * (1 + w * t);
    let last = 0;
    for (let i = 0; i < 2000; i++) if (Math.abs(1 - f(i / 1000)) > 0.002) last = i / 1000;
    const duration = Math.min(1.2, Math.max(0.2, last + 0.02));
    const pts = Array.from({ length: 49 }, (_, i) => f((i / 48) * duration).toFixed(4));
    const out = { easing: `linear(${pts.join(',')})`, duration: duration * 1000 };
    springCache.set(key, out);
    return out;
}

const ICONS = {
    doc: '<svg viewBox="0 0 24 24"><path d="M7 3h7l5 5v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M14 3v5h5"/></svg>',
    folder: '<svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
    copy: '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h8"/></svg>',
    share: '<svg viewBox="0 0 24 24"><path d="M12 15V4M8 8l4-4 4 4"/><path d="M5 12v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6"/></svg>',
    trash: '<svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>',
    ellipsisCircle: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9.5"/><circle cx="7.6" cy="12" r="1.15" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.15" fill="currentColor" stroke="none"/><circle cx="16.4" cy="12" r="1.15" fill="currentColor" stroke="none"/></svg>',
};

const DEFAULTS = {
    items: [],                 // [{label, icon?, onSelect?, destructive?, disabled?} | {separator:true}]
    placement: 'bottom-end',   // 'bottom'|'top' + '-start'|'-end'; flips vertically if it doesn't fit
    trigger: 'press',          // 'press' opens on pointerdown (iOS), 'click' toggles on click
    width: 150,
    gap: 8,                    // space between trigger and menu
    edge: 8,                   // minimum distance from the container edge
    radius: 14,
    startScale: 0.3,
    spring: { response: 0.38, damping: 0.78 },
    slowMo: 1,                 // >1 slows animations down, for tuning
    holdMs: 300,               // press-drag-release only selects after this long (or after moving)
    container: null,           // element to mount into (must be positioned); default: document.body
    theme: 'auto',             // 'auto' | 'light' | 'dark'
    onSelect: null,            // (item) => void, called after the menu has closed
    onOpen: null,
    onClose: null,
};

export class MenuView {
    static icons = ICONS;

    constructor(trigger, options = {}) {
        this.trigger = typeof trigger === 'string' ? document.querySelector(trigger) : trigger;
        if (!this.trigger) throw new Error('MenuView: trigger element not found');
        this.opts = { ...DEFAULTS, ...options, spring: { ...DEFAULTS.spring, ...options.spring } };
        this.state = 'closed'; // 'closed' | 'open' | 'closing'
        this._press = null;
        this._items = [];
        this._viaKeyboard = false;

        this._onTriggerDown = e => {
            if (this.opts.trigger !== 'press' || e.button !== 0) return;
            if (this.state === 'open') { this.close(); return; }
            this.open();
            this._press = { t: performance.now(), x: e.clientX, y: e.clientY };
            window.addEventListener('pointermove', this._onMove);
            window.addEventListener('pointerup', this._onUp);
            window.addEventListener('pointercancel', this._endPress);
        };
        this._onTriggerClick = e => {
            if (e.detail === 0) { this.state === 'open' ? this.close({ restoreFocus: true }) : this.open(true); } // Enter / Space
            else if (this.opts.trigger === 'click') this.toggle();
        };
        this._onMove = e => { if (this._press && this._menu) this._highlight(this._itemAt(e.clientX, e.clientY)); };
        this._onUp = e => {
            if (!this._press) return;
            const { t, x, y } = this._press; this._endPress();
            if (this.state !== 'open') return;
            const held = performance.now() - t > this.opts.holdMs || Math.hypot(e.clientX - x, e.clientY - y) > 10;
            if (!held) return; // quick tap: leave the menu open
            const el = this._itemAt(e.clientX, e.clientY);
            el ? this._select(el) : this.close();
        };
        this._endPress = () => {
            this._press = null;
            window.removeEventListener('pointermove', this._onMove);
            window.removeEventListener('pointerup', this._onUp);
            window.removeEventListener('pointercancel', this._endPress);
        };
        this._onKey = e => {
            if (e.key === 'Escape') { e.preventDefault(); this.close({ restoreFocus: true }); }
        };
        this._onResize = () => this.close();
        this._onScroll = e => { if (!this._menu?.contains(e.target)) this.close(); };

        this._prevTouchAction = this.trigger.style.touchAction;
        if (this.opts.trigger === 'press') this.trigger.style.touchAction = 'none';
        this.trigger.setAttribute('aria-haspopup', 'menu');
        this.trigger.setAttribute('aria-expanded', 'false');
        this.trigger.addEventListener('pointerdown', this._onTriggerDown);
        this.trigger.addEventListener('click', this._onTriggerClick);
    }

    get isOpen() { return this.state === 'open'; }
    setItems(items) { this.opts.items = items; }
    toggle() { return this.state === 'open' ? this.close() : this.open(); }

    open(viaKeyboard = false) {
        if (this.state === 'open') return;
        if (this.state === 'closing') this._teardown();

        const o = this.opts;
        const mount = o.container ?? document.body;
        const fixed = mount === document.body;
        const pos = fixed ? 'fixed' : 'absolute';

        const shade = document.createElement('div');
        shade.className = 'menuview__shade';
        shade.style.position = pos;

        const blur = document.createElement('div');
        blur.className = 'menuview__blur';
        blur.style.position = pos;
        blur.style.pointerEvents = 'none';

        const menu = this._build();
        menu.style.position = pos;

        if (o.theme !== 'auto') {
            shade.dataset.theme = o.theme;
            blur.dataset.theme = o.theme;
            menu.dataset.theme = o.theme;
        }

        mount.append(shade, blur, menu);

        // Force Chromium to register the initial opacity before transitioning.
        void blur.offsetWidth;

        requestAnimationFrame(() => {
            blur.classList.add('is-active');
        });

        // Calculate geometry relative to the mount.
        const tr = this.trigger.getBoundingClientRect();

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

        const t = {
            l: tr.left - ox,
            r: tr.right - ox,
            t: tr.top - oy,
            b: tr.bottom - oy,
        };

        const w = o.width;
        const h = menu.offsetHeight;

        const [vert, align = 'end'] = o.placement.split('-');

        let above = vert === 'top';

        const fitsBelow = t.b + o.gap + h <= bh - o.edge;
        const fitsAbove = t.t - o.gap - h >= o.edge;

        if (!above && !fitsBelow && fitsAbove) {
            above = true;
        } else if (above && !fitsAbove && fitsBelow) {
            above = false;
        }

        const left = clamp(
            align === 'start' ? t.l : t.r - w,
            o.edge,
            Math.max(o.edge, bw - w - o.edge)
        );

        const top = clamp(
            above ? t.t - o.gap - h : t.b + o.gap,
            o.edge,
            Math.max(o.edge, bh - h - o.edge)
        );

        // Position both layers identically.
        // Keep the menu at its calculated position.
        menu.style.position = pos;
        menu.style.left = `${left}px`;
        menu.style.top = `${top}px`;
        menu.style.width = `${w}px`;
        menu.style.height = `${h}px`;

        // Expand the blur around the menu.
        const blurW = Math.min(bw, Math.max(w * 3, 700));
        const blurH = Math.min(bh, Math.max(h * 4, 500));

        const blurLeft = clamp(
            left + w / 2 - blurW / 2,
            0,
            Math.max(0, bw - blurW)
        );

        const blurTop = clamp(
            top + h / 2 - blurH / 2,
            0,
            Math.max(0, bh - blurH)
        );

        blur.style.position = pos;
        blur.style.left = `${blurLeft}px`;
        blur.style.top = `${blurTop}px`;
        blur.style.width = `${blurW}px`;
        blur.style.height = `${blurH}px`;

        // Grow out of the trigger's centre.
        menu.style.transformOrigin =
            `${clamp((t.l + t.r) / 2 - left, 0, w)}px ${(t.t + t.b) / 2 - top}px`;

        // Animations.
        const reduce = prefersReducedMotion();
        const sp = spring(o.spring.response, o.spring.damping);
        const spd = reduce
            ? { duration: 1, easing: 'linear' }
            : sp;

        const anims = [
            shade.animate(
                [{ opacity: 0 }, { opacity: 1 }],
                {
                    duration: reduce ? 1 : 220,
                    easing: 'ease-out',
                    fill: 'both',
                }
            ),

            menu.animate(
                [
                    { transform: `scale(${o.startScale})` },
                    { transform: 'scale(1)' },
                ],
                { ...spd, fill: 'both' }
            ),

            menu.animate(
                [
                    { borderRadius: `${o.radius / o.startScale}px` },
                    { borderRadius: `${o.radius}px` },
                ],
                { ...spd, fill: 'both' }
            ),

            menu.animate(
                [{ opacity: 0 }, { opacity: 1 }],
                {
                    duration: reduce ? 1 : 120,
                    easing: 'ease-out',
                    fill: 'both',
                }
            ),

            ...[...menu.querySelectorAll('.menuview__item')].map(el =>
                el.animate(
                    [{ opacity: 0 }, { opacity: 1 }],
                    {
                        duration: reduce ? 1 : 180,
                        delay: reduce ? 0 : 60,
                        easing: 'ease-out',
                        fill: 'both',
                    }
                )
            ),
        ];

        anims.forEach(a => {
            a.playbackRate = 1 / o.slowMo;
        });

        this._shade = shade;
        this._blur = blur;
        this._menu = menu;
        this._anims = anims;
        this._viaKeyboard = viaKeyboard;

        this.state = 'open';
        this.trigger.setAttribute('aria-expanded', 'true');

        shade.addEventListener('pointerdown', e => {
            e.preventDefault();
            this.close();
        });

        shade.addEventListener('contextmenu', e => {
            e.preventDefault();
            this.close();
        });

        menu.addEventListener('click', e => {
            const el = e.target.closest('.menuview__item');
            if (el) this._select(el);
        });

        menu.addEventListener('keydown', e => this._onMenuKey(e));

        window.addEventListener('keydown', this._onKey);
        window.addEventListener('resize', this._onResize);
        window.addEventListener('scroll', this._onScroll, true);

        if (viaKeyboard) {
            this._focusable()[0]?.focus({ preventScroll: true });
        }

        o.onOpen?.();
    }

    close({ restoreFocus = false } = {}) {
        if (this.state !== 'open') return Promise.resolve();
        this.state = 'closing';
        const {
            _menu: menu,
            _shade: shade,
            _blur: blur
        } = this;
        this._anims.forEach(a => a.cancel());
        this._endPress();
        window.removeEventListener('keydown', this._onKey);
        window.removeEventListener('resize', this._onResize);
        window.removeEventListener('scroll', this._onScroll, true);
        this.trigger.setAttribute('aria-expanded', 'false');

        const reduce = prefersReducedMotion(), d = reduce ? 1 : 200, ease = 'cubic-bezier(.2,.8,.2,1)';
        const done = [
            menu.animate(
                [
                    { transform: 'scale(1)', opacity: 1 },
                    { transform: 'scale(.6)', opacity: 0 }
                ],
                { duration: d, easing: ease, fill: 'forwards' }
            ),

            shade.animate(
                [{ opacity: 1 }, { opacity: 0 }],
                { duration: d, easing: ease, fill: 'forwards' }
            ),

            ...(blur ? [
                blur.animate(
                    [
                        { opacity: 1 },
                        { opacity: 0 }
                    ],
                    { duration: d, easing: ease, fill: 'forwards' }
                )
            ] : [])
        ];
        done.forEach(a => { a.playbackRate = 1 / this.opts.slowMo; });
        return Promise.all(done.map(a => a.finished))
            .then(() => this._teardown())
            .catch(() => { }) // a re-open mid-close tears down early; nothing left to do
            .then(() => {
                if (restoreFocus) this.trigger.focus({ preventScroll: true });
                this.opts.onClose?.();
            });
    }

    destroy() {
        this._endPress();
        this._teardown();
        window.removeEventListener('keydown', this._onKey);
        window.removeEventListener('resize', this._onResize);
        window.removeEventListener('scroll', this._onScroll, true);
        this.trigger.removeEventListener('pointerdown', this._onTriggerDown);
        this.trigger.removeEventListener('click', this._onTriggerClick);
        this.trigger.style.touchAction = this._prevTouchAction;
        this.trigger.removeAttribute('aria-haspopup');
        this.trigger.removeAttribute('aria-expanded');
    }

    // ---- internals ----

    _build() {
        const menu = document.createElement('div');
        menu.className = 'menuview';
        menu.setAttribute('role', 'menu');
        menu.style.width = this.opts.width + 'px';
        menu.style.setProperty('--menuview-radius', this.opts.radius + 'px');
        this._items = [];
        for (const it of this.opts.items) {
            if (it.separator) {
                const gap = document.createElement('div');
                gap.className = 'menuview__gap'; gap.setAttribute('role', 'separator');
                menu.append(gap); continue;
            }
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'menuview__item' + (it.destructive ? ' is-destructive' : '') + (it.disabled ? ' is-disabled' : '');
            b.setAttribute('role', 'menuitem');
            if (it.disabled) b.setAttribute('aria-disabled', 'true');
            const label = document.createElement('span');
            label.className = 'menuview__label'; label.textContent = it.label;
            b.append(label);
            if (it.icon) {
                const ic = document.createElement('span');
                ic.className = 'menuview__icon'; ic.setAttribute('aria-hidden', 'true');
                if (typeof it.icon === 'string') ic.innerHTML = it.icon; // icon markup is developer-supplied
                else ic.append(it.icon.cloneNode(true));
                b.append(ic);
            }
            this._items.push({ el: b, item: it });
            menu.append(b);
        }
        return menu;
    }

    _focusable() { return this._items.filter(x => !x.item.disabled).map(x => x.el); }

    _itemAt(x, y) {
        const el = document.elementFromPoint(x, y)?.closest?.('.menuview__item');
        return el && this._menu?.contains(el) ? el : null;
    }

    _highlight(el) {
        this._items.forEach(x => x.el.classList.toggle('is-active', x.el === el && !x.item.disabled));
    }

    _select(el) {
        const entry = this._items.find(x => x.el === el);
        if (!entry || entry.item.disabled || this.state !== 'open') return;
        el.classList.add('is-active');
        setTimeout(() => {
            this.close({ restoreFocus: this._viaKeyboard }).then(() => {
                entry.item.onSelect?.(entry.item);
                this.opts.onSelect?.(entry.item);
            });
        }, prefersReducedMotion() ? 0 : 90);
    }

    _onMenuKey(e) {
        const list = this._focusable(), i = list.indexOf(document.activeElement);
        const go = n => { list[(n + list.length) % list.length]?.focus(); e.preventDefault(); };
        if (e.key === 'ArrowDown') go(i + 1);
        else if (e.key === 'ArrowUp') go(i < 0 ? -1 : i - 1);
        else if (e.key === 'Home') go(0);
        else if (e.key === 'End') go(-1);
        else if (e.key === 'Tab') { e.preventDefault(); this.close({ restoreFocus: true }); }
    }

    _teardown() {
        this._shade?.remove();
        this._blur?.remove();
        this._menu?.remove();

        this._shade = this._blur = this._menu = null;
        this._items = [];
        this.state = 'closed';
    }
}

export default MenuView;