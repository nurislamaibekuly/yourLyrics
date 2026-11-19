/*! alertview: iOS UIAlertController-style alert for the web. MIT.
 *  Centered frosted card, tinted action buttons, spring pop-in. Pair with alertview.css.
 */

const reduceMotion = () => !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

const STYLE_COLORS = {
  default: 'var(--alertview-tint)',
  cancel: 'var(--alertview-tint)',
  destructive: '#ff3b30'
};

let openCount = 0;

export class AlertView {
  constructor(options = {}) {
    this.opts = {
      title: '',
      message: '',
      actions: null,
      theme: 'auto',
      ...options
    };
    this.state = 'closed';
    this._res = null;

    this.el = document.createElement('div');
    this.el.className = 'alertview';
    this.el.setAttribute('role', 'alertdialog');
    this.el.setAttribute('aria-modal', 'true');
    this.el.tabIndex = -1;
    if (this.opts.theme !== 'auto') this.el.dataset.theme = this.opts.theme;

    this._backdrop = document.createElement('div');
    this._backdrop.className = 'alertview__backdrop';

    this._card = document.createElement('div');
    this._card.className = 'alertview__card';

    const textWrap = document.createElement('div');
    textWrap.className = 'alertview__text';
    if (this.opts.title) {
      const title = document.createElement('div');
      title.className = 'alertview__title';
      title.textContent = this.opts.title;
      textWrap.append(title);
    }
    if (this.opts.message) {
      const message = document.createElement('div');
      message.className = 'alertview__message';
      message.textContent = this.opts.message;
      textWrap.append(message);
    }
    if (textWrap.childNodes.length) this._card.append(textWrap);

    const actions = this._normalizeActions(this.opts.actions);
    const stack = document.createElement('div');
    stack.className =
      actions.length > 2 ? 'alertview__stack' : 'alertview__row';
    for (const action of actions) {
      stack.append(this._buttonFor(action));
    }
    this._card.append(stack);

    this.el.append(this._backdrop, this._card);
    this._onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        const cancel = actions.find((a) => a.style === 'cancel');
        if (cancel) this._resolve(cancel.value ?? null);
      } else if (e.key === 'Tab') {
        e.preventDefault();
      }
    };
  }

  _normalizeActions(actions) {
    if (!actions || !actions.length) {
      return [{ text: 'OK', style: 'default' }];
    }
    return actions.map((a) =>
      typeof a === 'string' ? { text: a, style: 'default' } : { style: 'default', ...a }
    );
  }

  _buttonFor(action) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'alertview__action';
    button.dataset.style = action.style;
    button.textContent = action.text;
    if (action.style === 'cancel' || action.style === 'destructive') {
      button.style.color = STYLE_COLORS[action.style];
    } else {
      button.style.color = STYLE_COLORS.default;
    }
    button.addEventListener('click', () => this._resolve(action.value ?? null));
    return button;
  }

  present() {
    if (this.state !== 'closed') return this._promise();
    this.state = 'open';
    openCount += 1;
    this._prevFocus = document.activeElement;
    document.body.append(this.el);
    document.addEventListener('keydown', this._onKey, true);
    this.el.getBoundingClientRect();
    this.el.classList.add('alertview--open');
    if (reduceMotion()) {
      this.el.classList.add('alertview--no-motion');
    }
    const first =
      this._card.querySelector('.alertview__input') ||
      this._card.querySelector('.alertview__action');
    (first ?? this.el).focus({ preventScroll: true });
    return this._promise();
  }

  dismiss() {
    if (this.state !== 'open') return;
    this.state = 'closing';
    this.el.classList.remove('alertview--open');
    this.el.classList.add('alertview--closing');
    document.removeEventListener('keydown', this._onKey, true);
    openCount = Math.max(0, openCount - 1);
    const done = () => {
      this.el.remove();
      this.state = 'closed';
      if (this._prevFocus?.focus) {
        this._prevFocus.focus({ preventScroll: true });
      }
    };
    if (reduceMotion()) {
      done();
    } else {
      const onEnd = e => {
        if (e.target !== this._card || e.propertyName !== 'opacity') return;
        this._card.removeEventListener('transitionend', onEnd);
        done();
      };
      this._card.addEventListener('transitionend', onEnd);
    }
  }

  _promise() {
    if (!this._promiseObj) {
      this._promiseObj = new Promise((resolve) => {
        this._res = resolve;
      });
    }
    return this._promiseObj;
  }

  _resolve(value) {
    if (this.state !== 'open') return;
    this.dismiss();
    if (this._res) {
      const resolve = this._res;
      this._res = null;
      resolve(value);
    }
  }
}

export function alert(options) {
  return new AlertView(options).present();
}

export function confirm(title, message, options = {}) {
  const { confirmText = 'OK', cancelText = 'Cancel', destructive = false } = options;
  return alert({
    title,
    message,
    actions: [
      { text: cancelText, style: 'cancel', value: false },
      { text: confirmText, style: destructive ? 'destructive' : 'default', value: true }
    ]
  }).then((value) => value === true);
}

export function prompt(title, message, options = {}) {
  const { placeholder = '', defaultValue = '', confirmText = 'OK' } = options;
  return new Promise((resolve) => {
    let input;
    const view = new AlertView({
      title,
      message,
      actions: [
        { text: 'Cancel', style: 'cancel', value: null },
        { text: confirmText, style: 'default', value: '__ok__' }
      ]
    });
    input = document.createElement('input');
    input.className = 'alertview__input';
    input.type = 'text';
    input.placeholder = placeholder;
    input.value = defaultValue;
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') view._resolve('__ok__');
    });
    const textWrap = view._card.querySelector('.alertview__text');
    textWrap.append(input);
    view.present().then((value) => {
      resolve(value === '__ok__' ? input.value : null);
    });
  });
}

export { openCount as alertOpenCount };
