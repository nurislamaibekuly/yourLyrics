function stripBom(text) {
  return String(text).replace(/^\uFEFF/, '');
}

function parseTimestamp(body) {
  const fields = body.split(':');
  if (fields.length === 2) {
    if (!/^\d+$/.test(fields[0]) || !/^\d+(?:\.\d+)?$/.test(fields[1])) {
      return null;
    }
    return Number(fields[0]) * 60 + Number(fields[1]);
  }
  if (fields.length === 3) {
    if (!/^\d+$/.test(fields[0]) ||
        !/^\d+$/.test(fields[1]) ||
        !/^\d+(?:\.\d+)?$/.test(fields[2])) {
      return null;
    }
    return Number(fields[0]) * 3600 +
      Number(fields[1]) * 60 +
      Number(fields[2]);
  }
  return null;
}

function parseTtmlTimestamp(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const source = value.trim();
  if (!source) {
    return null;
  }

  const offset = source.match(/^(\d+(?:\.\d+)?)(h|ms|m|s)$/i);
  if (offset) {
    const amount = Number(offset[1]);
    const unit = offset[2].toLowerCase();
    if (unit === 'h') {
      return amount * 3600;
    }
    if (unit === 'm') {
      return amount * 60;
    }
    if (unit === 's') {
      return amount;
    }
    return amount / 1000;
  }

  const fields = source.split(':');
  if (fields.length === 1) {
    return /^\d+(?:\.\d+)?$/.test(fields[0]) ? Number(fields[0]) : null;
  }
  if (fields.length === 2) {
    if (!/^\d+$/.test(fields[0]) || !/^\d+(?:\.\d+)?$/.test(fields[1])) {
      return null;
    }
    return Number(fields[0]) * 60 + Number(fields[1]);
  }
  if (fields.length === 3) {
    if (!/^\d+$/.test(fields[0]) ||
        !/^\d+$/.test(fields[1]) ||
        !/^\d+(?:\.\d+)?$/.test(fields[2])) {
      return null;
    }
    return Number(fields[0]) * 3600 +
      Number(fields[1]) * 60 +
      Number(fields[2]);
  }
  return null;
}

function ttmlRole(node) {
  return node.getAttributeNS(
    'http://www.w3.org/ns/ttml#metadata',
    'role'
  ) || node.getAttribute('ttm:role');
}

function ttmlNodeText(node, includeBackground = true) {
  let text = '';
  for (const child of node.childNodes) {
    if (child.nodeType === 3) {
      text += child.nodeValue;
    } else if (child.nodeType === 1) {
      if (child.localName === 'br') {
        text += ' ';
        continue;
      }
      const role = ttmlRole(child);
      if (role === 'x-bg') {
        if (!includeBackground) {
          continue;
        }
        if (text && !/\s$/.test(text)) {
          text += ' ';
        }
        text += ttmlNodeText(child, true);
        text += ' ';
      } else {
        text += ttmlNodeText(child, includeBackground);
      }
    }
  }
  return text;
}

function ttmlSegments(
  node,
  inheritedBegin = null,
  inheritedEnd = null,
  explicitWord = false,
  background = false
) {
  const segments = [];
  for (const child of node.childNodes) {
    if (child.nodeType === 3) {
      if (child.nodeValue) {
        segments.push({
          text: child.nodeValue,
          time: inheritedBegin,
          end: inheritedEnd,
          word: explicitWord,
          background
        });
      }
      continue;
    }
    if (child.nodeType !== 1) {
      continue;
    }
    if (child.localName === 'br') {
      segments.push({ text: ' ', time: null, end: null, word: false });
      continue;
    }

    const begin = parseTtmlTimestamp(child.getAttribute('begin'));
    const end = parseTtmlTimestamp(child.getAttribute('end'));
    const hasTiming = begin !== null || end !== null;
    const childBackground = background || ttmlRole(child) === 'x-bg';
    segments.push(
      ...ttmlSegments(
        child,
        begin ?? inheritedBegin,
        end ?? inheritedEnd,
        explicitWord || hasTiming,
        childBackground
      )
    );
  }
  return segments;
}

function ttmlBackgroundNodes(node, inheritedBackground = false) {
  const nodes = [];
  for (const child of node.childNodes) {
    if (child.nodeType !== 1) {
      continue;
    }
    const background = inheritedBackground || ttmlRole(child) === 'x-bg';
    if (background) {
      nodes.push(child);
      continue;
    }
    nodes.push(...ttmlBackgroundNodes(child, false));
  }
  return nodes;
}

function ttmlWords(segments, lineEnd) {
  if (!segments.some((segment) =>
    segment.word && Number.isFinite(segment.time) &&
    segment.text.replace(/\s+/g, '')
  )) {
    return null;
  }

  const words = [];
  let leading = '';
  for (const segment of segments) {
    const text = segment.text.replace(/\s+/g, ' ');
    if (!text) {
      continue;
    }

    if (
      segment.word &&
      Number.isFinite(segment.time) &&
      text.trim()
    ) {
      const previous = words[words.length - 1];
      if (
        previous &&
        previous.time === segment.time &&
        previous.end === segment.end
      ) {
        previous.text += text;
      } else {
        words.push({
          time: segment.time,
          end: segment.end,
          text: leading + text
        });
      }
      leading = '';
      continue;
    }

    if (words.length > 0) {
      words[words.length - 1].text += text;
    } else {
      leading += text;
    }
  }

  if (words.length === 0) {
    return null;
  }

  for (const word of words) {
    word.text = word.text.replace(/\s+/g, ' ');
  }
  words[0].text = words[0].text.replace(/^\s+/, '');
  words[words.length - 1].text = words[words.length - 1].text.replace(/\s+$/, '');
  const result = words.filter((word) => word.text.length > 0);
  if (result.length === 0) {
    return null;
  }

  for (let index = 0; index < result.length; index += 1) {
    const word = result[index];
    const next = result[index + 1];
    if (!(word.end > word.time)) {
      word.end = next && next.time > word.time
        ? next.time
        : lineEnd > word.time
          ? lineEnd
          : word.time + 0.5;
    }
  }

  return result;
}

// TTML names the voice that sings a line (`ttm:agent`), usually on the
// paragraph but sometimes inherited from its <div> or <body>. That is the only
// reliable duet signal, so it is carried through to the renderer.
function ttmlAgent(node) {
  for (
    let current = node;
    current && current.nodeType === 1;
    current = current.parentNode
  ) {
    const attributes = current.attributes ?? [];
    for (let index = 0; index < attributes.length; index += 1) {
      const attribute = attributes[index];
      if (attribute.localName === 'agent') {
        return attribute.value;
      }
    }
  }
  return null;
}

function ttmlCredits(doc) {
  const writers = new Set();
  const syncers = new Set();
  const metadata = doc.getElementsByTagNameNS('*', 'head')[0];
  for (const node of metadata?.getElementsByTagNameNS('*', '*') ?? []) {
    const name = node.localName.toLowerCase();
    const key = (node.getAttribute('key') || node.getAttribute('name') || '').toLowerCase();
    const writer = /^(songwriters?|writers?|composers?|lyricists?)$/.test(name) ||
      /^(songwriters?|writers?|composers?|lyricists?|writtenby)$/.test(key);
    const syncer = /^(ttmlauthor|lyricsauthor|syncedby)$/.test(key);
    if (!writer && !syncer) continue;
    // Container elements are handled by their individual name elements.
    if (node.children.length && name !== 'meta') continue;
    const value = node.getAttribute('value') || node.textContent || '';
    for (const part of value.split(/[;\n]/)) {
      const cleaned = part.replace(/\s+/g, ' ').trim();
      if (cleaned) (writer ? writers : syncers).add(cleaned);
    }
  }
  return { writers: [...writers], syncers: [...syncers] };
}

export function parseTtml(text) {
  const doc = new DOMParser().parseFromString(
    stripBom(text),
    'application/xml'
  );
  if (!doc ||
      doc.documentElement?.localName !== 'tt' ||
      doc.getElementsByTagName('parsererror').length > 0) {
    return [];
  }

  const parsed = [];
  const paragraphs = doc.getElementsByTagNameNS('*', 'p');
  for (let index = 0; index < paragraphs.length; index += 1) {
    const paragraph = paragraphs[index];
    const begin = parseTtmlTimestamp(paragraph.getAttribute('begin'));
    if (begin === null) {
      continue;
    }
    const paragraphBackground = ttmlRole(paragraph) === 'x-bg';
    const backgroundNodes = paragraphBackground
      ? []
      : ttmlBackgroundNodes(paragraph);
    const lyric = (paragraphBackground
      ? ''
      : ttmlNodeText(paragraph, false)
    ).replace(/\s+/g, ' ').trim();
    const backgroundText = (paragraphBackground
      ? ttmlNodeText(paragraph, true)
      : backgroundNodes.map((node) => ttmlNodeText(node, true)).join(' ')
    ).replace(/\s+/g, ' ').trim()
      .replace(/^[\(（]+/, '')
      .replace(/[\)）]+$/, '')
      .trim();
    const displayText = lyric || backgroundText;
    const isBackground = paragraphBackground || !lyric;
    if (!displayText) {
      continue;
    }

    let end = parseTtmlTimestamp(paragraph.getAttribute('end'));
    if (end === null || end <= begin) {
      end = null;
    }
    const segments = ttmlSegments(
      paragraph,
      Math.max(0, begin),
      end,
      false,
      paragraphBackground
    );
    const words = ttmlWords(
      segments.filter((segment) => !segment.background),
      end
    );
    const backgroundWords = ttmlWords(
      segments.filter((segment) => segment.background),
      end
    );
    // Strip outer parentheses that wrap a backing phrase from its words so
    // well as its text; otherwise the karaoke spans would spell "(oh oh oh)".
    if (backgroundWords?.length) {
      backgroundWords[0].text = backgroundWords[0].text
        .replace(/^[\(（]+/, '')
        .trimStart();
      const lastBackgroundWord = backgroundWords[backgroundWords.length - 1];
      lastBackgroundWord.text = lastBackgroundWord.text
        .replace(/[\)）]+$/, '')
        .trimEnd();
    }
    // Place a backing phrase above the lead when its first word starts
    // before the lead's first word, and below otherwise. Compute that while
    // both word lists are still available.
    const backgroundBefore = Boolean(
      !isBackground &&
      backgroundWords?.length &&
      words?.length &&
      backgroundWords[0].time < words[0].time - 0.001
    );
    parsed.push({
      time: Math.max(0, begin),
      end: end === null ? null : Math.max(0, end),
      text: displayText,
      words,
      backgroundText: isBackground ? null : backgroundText || null,
      backgroundWords,
      backgroundBefore,
      isBackground,
      order: index,
      voice: ttmlAgent(paragraph)
    });
  }

  // Group while the paragraphs are still in document order: a backing
  // paragraph follows its lead there even when its first word starts earlier,
  // and time-sorting first would strand it as an unrelated lyric.
  const grouped = groupBackgroundLines(parsed);
  grouped.sort((left, right) =>
    left.time - right.time || left.order - right.order
  );
  const result = grouped.map((line) => {
    const result = { time: line.time, text: line.text };
    if (line.end !== null) {
      result.end = line.end;
    }
    if (Number.isFinite(line.leadEnd) && line.leadEnd !== line.end) {
      result.leadEnd = line.leadEnd;
    }
    if (line.words?.length) {
      result.words = line.words;
    }
    if (line.backgroundText) {
      result.backgroundText = line.backgroundText;
    }
    if (line.backgroundWords?.length) {
      result.backgroundWords = line.backgroundWords;
    }
    if (line.backgroundBefore) {
      result.backgroundBefore = true;
    }
    if (line.isBackground) {
      result.isBackground = true;
    }
    if (line.voice) {
      result.voice = line.voice;
    }
    return result;
  });
  result.credits = ttmlCredits(doc);
  return result;
}

function decodeXmlEntities(value) {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi,
    (entity, body) => {
      const name = body.toLowerCase();
      if (name === 'amp') return '&';
      if (name === 'lt') return '<';
      if (name === 'gt') return '>';
      if (name === 'quot') return '"';
      if (name === 'apos') return "'";
      const code = name.startsWith('#x')
        ? Number.parseInt(name.slice(2), 16)
        : Number.parseInt(name.slice(1), 10);
      return code >= 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : entity;
    });
}

// QQ's XML wrapper is malformed often enough that DOMParser rejects the whole
// document: lyric text keeps raw ampersands and quotes inside LyricContent.
// Recover the attribute directly and decode only complete entity references,
// leaving ordinary lyric punctuation untouched.
function qrcLyricContent(text) {
  const start = text.search(/<Lyric_1\b/i);
  if (start < 0) {
    return '';
  }
  const end = text.indexOf('</LyricInfo>', start);
  const section = text.slice(start, end === -1 ? text.length : end);
  const match = section.match(/LyricContent\s*=\s*"([\s\S]*)"\s*\/?>/i) ||
    section.match(/LyricContent\s*=\s*'([\s\S]*)'\s*\/?>/i);
  return match ? decodeXmlEntities(match[1]) : '';
}

// QRC XML stores the decoded lyric body in an attribute. Read that attribute
// without treating lyric text as markup or attempting to unpack encrypted QQ
// download files.
export function parseQrc(text) {
  let body = stripBom(text).trim();
  if (/<QrcInfos(?:\s|>)/i.test(body)) {
    body = qrcLyricContent(body);
    if (!body) {
      return [];
    }
  }
  const offset = Number(body.match(/\[offset:([+-]?\d+)\]/i)?.[1] || 0) / 1000;
  const lines = [];
  for (const raw of body.split(/\r?\n/)) {
    const match = raw.trim().match(/^\[(\d+),(\d+)\](.*)$/);
    if (!match) continue;
    const time = Math.max(0, Number(match[1]) / 1000 + offset);
    const duration = Number(match[2]) / 1000;
    const rest = match[3];
    const words = [];
    let cursor = 0;
    for (const token of rest.matchAll(/\((\d+),(\d+)\)/g)) {
      const text = rest.slice(cursor, token.index);
      const start = Math.max(0, Number(token[1]) / 1000 + offset);
      if (text) words.push({ text, time: start, end: start + Number(token[2]) / 1000 });
      cursor = token.index + token[0].length;
    }
    const tail = rest.slice(cursor);
    if (tail && words.length) words[words.length - 1].text += tail;
    const text = (words.length ? words.map(word => word.text).join('') : rest).trim();
    if (!text) continue;
    const line = { time, text };
    if (duration > 0) line.end = time + duration;
    if (words.length) line.words = words;
    lines.push(line);
  }
  lines.sort((left, right) => left.time - right.time);
  finishWordTiming(lines);
  return lines;
}

// Enhanced LRC supplies word starts, often with an empty final timestamp for
// the last word's end. Only infer missing ends; QRC's explicit gaps stay intact.
function finishWordTiming(lines) {
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.words?.length) continue;
    for (let wordIndex = 0; wordIndex < line.words.length; wordIndex += 1) {
      const word = line.words[wordIndex];
      if (!(word.end > word.time)) {
        const nextTime = line.words[wordIndex + 1]?.time ?? line.end ?? lines[index + 1]?.time;
        word.end = nextTime > word.time ? nextTime : word.time + 0.5;
      }
    }
  }
}

function lyricsFormat(text, fileName) {
  const name = typeof fileName === 'string' ? fileName.toLowerCase() : '';
  const head = stripBom(text).trimStart();
  // Inspect QRC before the .xml extension, since both QRC and TTML use XML.
  if (name.endsWith('.qrc') || /<QrcInfos(?:\s|>)/i.test(head) ||
      /^\[\d+,\d+\]/m.test(head)) return 'qrc';
  if (name.endsWith('.ttml') || name.endsWith('.xml') || /<tt(?:\s|>)/i.test(head)) return 'ttml';
  return 'lrc';
}

export function parseLyrics(text, fileName = '', communityAuthor = '') {
  const source = stripBom(text);
  const format = lyricsFormat(source, fileName);
  const lines = format === 'ttml' ? parseTtml(source)
    : format === 'qrc' ? parseQrc(source) : parseLrc(source);
  if (typeof communityAuthor === 'string' && communityAuthor.trim() &&
      !lines.credits?.syncers.length) {
    lines.credits = { writers: lines.credits?.writers ?? [], syncers: [communityAuthor.trim()] };
  }
  return lines;
}

export function parseLrc(text) {
  const lines = [];
  const offset = Number(stripBom(text).match(/\[offset:([+-]?\d+)\]/i)?.[1] || 0) / 1000;

  for (const raw of stripBom(text).split(/\r?\n/)) {
    const source = raw.trim();
    if (!source.startsWith('[')) {
      continue;
    }

    let index = 0;
    let isMetadata = false;
    const times = [];

    while (index < source.length && source[index] === '[') {
      const close = source.indexOf(']', index);
      if (close === -1) {
        break;
      }
      const body = source.slice(index + 1, close);

      if (index === 0) {
        const colon = body.indexOf(':');
        const tag = colon > 0 ? body.slice(0, colon) : '';
        if (/^[a-z]+$/i.test(tag)) {
          isMetadata = true;
          break;
        }
      }

      const time = parseTimestamp(body);
      if (time === null) {
        break;
      }
      times.push(time);
      index = close + 1;
    }

    if (isMetadata || times.length === 0) {
      continue;
    }

    const content = source.slice(index);
    const tags = [...content.matchAll(/<(\d+:\d+(?::\d+)?(?:\.\d+)?)>/g)]
      .map(match => ({ index: match.index, length: match[0].length, time: parseTimestamp(match[1]) }))
      .filter(tag => tag.time !== null);
    const lyric = content.replace(/<[^>]*>/g, '').trim();
    if (!lyric) continue;

    for (const time of times) {
      const line = { time: Math.max(0, time + offset), text: lyric };
      if (tags.length) {
        const shift = time - times[0] + offset;
        const words = [];
        const prefix = content.slice(0, tags[0].index);
        if (prefix.trim()) words.push({ text: prefix, time: line.time, end: Math.max(0, tags[0].time + shift) });
        for (let tagIndex = 0; tagIndex < tags.length; tagIndex += 1) {
          const tag = tags[tagIndex];
          const next = tags[tagIndex + 1];
          const wordText = content.slice(tag.index + tag.length, next?.index ?? content.length);
          if (wordText) words.push({
            text: wordText, time: Math.max(0, tag.time + shift),
            end: next ? Math.max(0, next.time + shift) : null
          });
        }
        if (words.length) {
          line.words = words;
          const last = tags[tags.length - 1];
          if (!content.slice(last.index + last.length).trim()) line.end = Math.max(0, last.time + shift);
        }
      }
      lines.push(line);
    }
  }

  lines.sort((left, right) => left.time - right.time);
  finishWordTiming(lines);
  return lines;
}

// or consecutive backing phrase to a normal line. Mirroring that here keeps the
// backing vocal visually attached to the line it answers, and stops the scroll
// from ever settling on a lone background phrase.
export function groupBackgroundLines(lines) {
  const grouped = [];
  let previousMain = null;
  let attached = false;

  for (const line of lines) {
    if (!line.isBackground) {
      // Preserve the lead's end before an attached x-bg paragraph extends it.
      const main = { ...line, leadEnd: line.leadEnd ?? line.end };
      grouped.push(main);
      previousMain = main;
      attached = false;
      continue;
    }

    if (previousMain && !attached) {
      const text = (line.backgroundText ?? line.text ?? '')
        .replace(/\s+/g, ' ')
        .trim();
      const words = line.backgroundWords ?? [];
      if (text) {
        previousMain.backgroundText = [
          previousMain.backgroundText,
          text
        ].filter(Boolean).join(' ');
      }
      if (words.length) {
        previousMain.backgroundWords = [
          ...(previousMain.backgroundWords ?? []),
          ...words
        ];
      }

      const mainWords = previousMain.words ?? [];
      const firstMain = mainWords[0]?.time ?? previousMain.time;
      const firstBackground = words[0]?.time ?? line.time;
      if (firstBackground < firstMain - 0.001) {
        previousMain.backgroundBefore = true;
      }

      // Sync the pair to the earliest start and the latest end so a
      // backing phrase that begins before the lead is not clipped by the
      // lead's activation window.
      const backgroundStart = Math.min(
        line.time,
        ...words.map((word) => word.time)
      );
      if (backgroundStart < previousMain.time) {
        previousMain.time = backgroundStart;
      }

      const mainEnd = previousMain.end ?? previousMain.time;
      const backgroundEnd = Math.max(
        line.end ?? line.time,
        ...words.map((word) => word.end)
      );
      if (backgroundEnd > mainEnd) {
        previousMain.end = backgroundEnd;
      }
      attached = true;
      continue;
    }

    // No lead line to attach to, or a second consecutive backing phrase:
    // promote it to a normal lyric instead of dropping it.
    // convertExcessiveBackgroundLines behaviour).
    const main = { ...line };
    delete main.isBackground;
    delete main.backgroundText;
    if (!main.words?.length && main.backgroundWords?.length) {
      main.words = main.backgroundWords;
    }
    delete main.backgroundWords;
    grouped.push(main);
    previousMain = main;
    attached = false;
  }

  return grouped;
}
