/*! updateview: the software-update card, laid out like iOS Settings.
 *  App icon and version at the top, the release notes as the description, a
 *  "Learn more…" link to the release page, and the actions as sheet rows at
 *  the bottom of the card — the same 44pt tinted row the rest of Settings
 *  uses, rather than a filled block that would be the only one in the app.
 *  renderer.js uses it both inline (Settings > About) and as the launch
 *  prompt (a sheet). Pair with updateview.css.
 */

import { SheetView } from './sheetview.js';

// The app's own icon — the same file the dock, the window and the installers
// use — so the card does not need a second artwork variant to keep in sync.
const appIcon = new URL('../../assets/icon.png', import.meta.url).href;

// The asset total from the release; GitHub reports bytes per asset.
function downloadSize(info) {
  const bytes = Number(info && info.size);
  if (!(bytes > 0)) {
    return '';
  }
  const mb = bytes / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${Math.max(1, Math.round(mb))} MB`;
}

// Release bodies are markdown. The card shows prose, not markup, so inline
// emphasis, backticks, links and stray HTML are reduced to their text: a
// GitHub release is authored for a web page and would otherwise print its own
// syntax at the reader.
function cleanInline(text) {
  return text
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_`~]{1,3}([^*_`~]+)[*_`~]{1,3}/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Headings and list items keep their shape without a markdown renderer. Release
// bodies are hard-wrapped, so a line that does not open a new block continues
// the one above it: without that, moving a bullet's second line would print as
// a paragraph of its own, and a wrapped sentence would break mid-phrase.
function noteBlocks(notes) {
  const blocks = [];
  let open = null;   // block that a plain line may still extend
  let afterBlank = true;   // a blank line closes the paragraph before it
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
    // Markdown rules, images and comments carry no sentence, so drop them.
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
    // A release published without notes still gets a description, so the card
    // never reads as a blank update.
    blocks.push({
      kind: 'text',
      text: 'This update includes new features, improvements and bug fixes.'
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

// The card plus its buttons, as one block both surfaces can drop anywhere.
export function buildUpdateCard(info, handlers = {}) {
  const block = document.createElement('div');
  block.className = 'update-block';

  const card = document.createElement('div');
  card.className = 'update-card';

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
  subtitle.textContent = downloadSize(info) || 'Version ' + info.version;
  meta.append(title, subtitle);
  header.append(icon, meta);
  card.append(header, notesElement(info.notes));

  const learn = document.createElement('button');
  learn.type = 'button';
  learn.className = 'update-card__link';
  learn.textContent = 'Learn more…';
  learn.addEventListener('click', () => handlers.onLearnMore?.());
  card.append(learn);

  // Actions are rows in the same group: a hairline separates them from the
  // notes, exactly like "Open cache folder" under the Cache heading.
  const actions = document.createElement('div');
  actions.className = 'update-card__actions';
  const update = document.createElement('button');
  update.type = 'button';
  update.className = 'update-action update-action--primary';
  update.textContent = 'Update Now';
  update.addEventListener('click', () => handlers.onUpdate?.());
  actions.append(update);

  if (handlers.onLater) {
    const later = document.createElement('button');
    later.type = 'button';
    later.className = 'update-action';
    later.textContent = 'Remind Me Later';
    later.addEventListener('click', () => handlers.onLater?.());
    actions.append(later);
  }

  card.append(actions);
  block.append(card);
  return block;
}

// The launch prompt: the same card in a sheet, so swiping it away means
// "later" the way dismissing an iOS sheet does.
export function presentUpdate(info, handlers = {}) {
  return new Promise(resolve => {
    let settled = false;
    const finish = choice => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(choice);
    };
    const sheet = new SheetView({
      page: '#app',
      grabber: true,
      maxWidth: 460,
      // See the settings sheet: the window rounds itself, so the document root
      // stays transparent behind the scaled page.
      backdropColor: 'transparent',
      onDismiss: () => finish('later')
    });
    sheet.setContent(buildUpdateCard(info, {
      onUpdate: () => {
        finish('update');
        sheet.dismiss();
      },
      onLater: () => sheet.dismiss(),
      onLearnMore: handlers.onLearnMore
    }));
    sheet.present();
  });
}
