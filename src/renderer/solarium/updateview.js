import { SheetView } from './sheetview.js';

const appIcon = new URL('../../../assets/icon.png', import.meta.url).href;

function downloadSize(info) {
  const bytes = Number(info && info.size);
  if (!(bytes > 0)) return '';
  const mb = bytes / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${Math.max(1, Math.round(mb))} MB`;
}

function cleanInline(text) {
  return text
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_`~]{1,3}([^*_`~]+)[*_`~]{1,3}/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function noteBlocks(notes) {
  const blocks = [];
  let open = null;
  let afterBlank = true;
  const lines = String(notes || '').replace(/\r\n?/g, '\n').split('\n');
  const push = (kind, text) => {
    open = { kind, text };
    blocks.push(open);
    afterBlank = false;
  };
  const append = text => {
    open.text = `${open.text} ${text}`.trim();
  };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      open = null;
      afterBlank = true;
      continue;
    }
    const heading = line.match(/^#{1,6}\s+(.*)$/);
    if (heading) {
      push('heading', cleanInline(heading[1]));
      continue;
    }
    const bullet = line.match(/^[-*+]\s+(.*)$/);
    if (bullet) {
      push('bullet', cleanInline(bullet[1]));
      continue;
    }
    if (/^(-{3,}|\*{3,}|={3,})$/.test(line) || /^!\[/.test(line)) {
      continue;
    }
    const text = cleanInline(line.replace(/^>\s?/, ''));
    if (open && !afterBlank && open.kind !== 'heading') {
      append(text);
    } else {
      push('text', text);
    }
  }
  return blocks.filter(block => block.text);
}

function notesElement(notes) {
  const element = document.createElement('div');
  element.className = 'update-card__notes';
  const blocks = noteBlocks(notes);
  if (!blocks.length) {
    blocks.push({
      kind: 'text',
      text: 'This update includes new features, improvements and bug fixes.',
    });
  }
  for (const block of blocks) {
    const node = document.createElement('p');
    node.className = `update-card__note update-card__note--${block.kind}`;
    node.textContent = block.text;
    element.append(node);
  }
  return element;
}

export function buildUpdateCard(info, handlers = {}) {
  const block = document.createElement('div');
  block.className = 'update-block solarium-update-block';

  const card = document.createElement('div');
  card.className = 'update-card solarium-update-card';

  const header = document.createElement('div');
  header.className = 'update-card__header';
  const icon = document.createElement('img');
  icon.className = 'update-card__icon';
  icon.src = appIcon;
  icon.alt = '';
  icon.draggable = false;

  const meta = document.createElement('div');
  meta.className = 'update-card__meta';
  const title = document.createElement('div');
  title.className = 'update-card__title';
  title.textContent = `yourLyrics ${info.version}`;
  const subtitle = document.createElement('div');
  subtitle.className = 'update-card__subtitle';
  subtitle.textContent = downloadSize(info) || `Version ${info.version}`;
  meta.append(title, subtitle);
  header.append(icon, meta);

  card.append(header, notesElement(info.notes));

  const actions = document.createElement('div');
  actions.className = 'update-card__actions solarium-update-card__actions';

  const update = document.createElement('button');
  update.type = 'button';
  update.className = 'update-action update-action--primary solarium-update-pill';
  update.textContent = 'Update Now';
  update.addEventListener('click', () => handlers.onUpdate?.());
  actions.append(update);

  if (handlers.onLater) {
    const later = document.createElement('button');
    later.type = 'button';
    later.className = 'update-action solarium-update-text-action';
    later.textContent = 'Remind Me Later';
    later.addEventListener('click', () => handlers.onLater?.());
    actions.append(later);
  }

  const learn = document.createElement('button');
  learn.type = 'button';
  learn.className = 'update-card__link solarium-update-text-action';
  learn.textContent = 'Learn More';
  learn.addEventListener('click', () => handlers.onLearnMore?.());
  actions.append(learn);

  card.append(actions);
  block.append(card);
  return block;
}

export function presentUpdate(info, handlers = {}) {
  return new Promise(resolve => {
    let settled = false;
    const finish = choice => {
      if (settled) return;
      settled = true;
      resolve(choice);
    };
    const sheet = new SheetView({
      page: '#app',
      title: 'Software Update',
      maxWidth: 420,
      backdropColor: 'transparent',
      onDismiss: () => finish('later'),
    });
    sheet.setContent(buildUpdateCard(info, {
      onUpdate: () => {
        finish('update');
        sheet.dismiss();
      },
      onLater: () => sheet.dismiss(),
      onLearnMore: handlers.onLearnMore,
    }));
    sheet.present();
  });
}
