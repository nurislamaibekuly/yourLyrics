import MeshBackdrop from '../vendor/amlbg/amlbg.js';

const CARD_WIDTH = 1024;
const PAD_X = 88;
const PAD_TOP = 68;
const PAD_BOTTOM = 64;
const CONTENT_WIDTH = CARD_WIDTH - PAD_X * 2;
const LYRIC_FONT_SIZE = 54;
const LYRIC_LINE_HEIGHT = 64;
const LYRIC_BLOCK_GAP = 40;
const FOOTER_GAP = 68;
const ARTWORK_SIZE = 112;
const ARTWORK_RADIUS = 18;
const META_GAP = 34;
const TITLE_FONT_SIZE = 32;
const ARTIST_FONT_SIZE = 30;
const FROST_BLUR_PAD = 28;

const BASE_FONT_STACK = '"SF Pro Display", -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif';
const ARABIC_FONT_STACK = `"SF Arabic", ${BASE_FONT_STACK}`;

function lyricFontFor(item) {
  const family = item?.arabic ? ARABIC_FONT_STACK : BASE_FONT_STACK;
  return `800 ${LYRIC_FONT_SIZE}px ${family}`;
}

function wrapTextLines(ctx, text, maxWidth) {
  const words = String(text ?? '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const lines = [];
  let current = '';

  const pushToken = token => {
    if (ctx.measureText(token).width <= maxWidth) {
      current = token;
      return;
    }
    let slice = '';
    for (const ch of token) {
      const next = slice + ch;
      if (slice && ctx.measureText(next).width > maxWidth) {
        lines.push(slice);
        slice = ch;
      } else {
        slice = next;
      }
    }
    current = slice;
  };

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (!current) {
      pushToken(word);
    } else if (ctx.measureText(candidate).width <= maxWidth) {
      current = candidate;
    } else {
      lines.push(current);
      pushToken(word);
    }
  }
  if (current) lines.push(current);
  return lines;
}

function truncateText(ctx, text, maxWidth) {
  const raw = String(text ?? '').trim();
  if (!raw || ctx.measureText(raw).width <= maxWidth) return raw;
  const ellipsis = '…';
  let end = raw.length;
  while (end > 1 && ctx.measureText(`${raw.slice(0, end)}${ellipsis}`).width > maxWidth) {
    end -= 1;
  }
  return `${raw.slice(0, Math.max(1, end))}${ellipsis}`;
}

async function decodeArtworkImage(source) {
  if (!source) return null;
  try {
    const img = new Image();
    if (!/^data:|^blob:/i.test(source)) img.crossOrigin = 'anonymous';
    img.src = source;
    await img.decode();
    return img;
  } catch {
    return null;
  }
}

function drawAmlbgBackdrop(cardCtx, width, height, artworkImage, { seed, time, fallbackSource }) {
  const bgCanvas = document.createElement('canvas');
  bgCanvas.width = width;
  bgCanvas.height = height;
  let engine = null;
  try {
    const dpr = typeof window !== 'undefined' ? (window.devicePixelRatio || 1) : 1;
    engine = new MeshBackdrop(bgCanvas, {
      seed: seed != null ? String(seed) : '0',
      isBehindLyrics: true,
      forcePortrait: false,
      parameters: {
        motion: 'auto',
        renderScale: Math.min(1, 1 / Math.max(1, dpr)),
      },
      preserveDrawingBuffer: true,
      autoStart: false,
    });
    engine.setCover(artworkImage ?? null);
    if (Number.isFinite(time)) engine.time = time;
    engine.pinchProgress = 1;
    engine.renderOnce(0.016, true);
    cardCtx.drawImage(bgCanvas, 0, 0, width, height);
    return;
  } catch {
    // WebGL2 fallback: reuse the current backdrop snapshot or paint a slate backdrop.
  } finally {
    engine?.destroy();
  }

  if (fallbackSource && fallbackSource.width && fallbackSource.height) {
    const scale = Math.max(width / fallbackSource.width, height / fallbackSource.height);
    const drawW = fallbackSource.width * scale;
    const drawH = fallbackSource.height * scale;
    cardCtx.drawImage(fallbackSource, (width - drawW) / 2, (height - drawH) / 2, drawW, drawH);
  } else {
    const grad = cardCtx.createLinearGradient(0, 0, width, height);
    grad.addColorStop(0, '#3a3f4b');
    grad.addColorStop(1, '#1c2a44');
    cardCtx.fillStyle = grad;
    cardCtx.fillRect(0, 0, width, height);
  }
}

function drawBackdropVignette(cardCtx, width, height) {
  cardCtx.save();
  const radius = Math.hypot(width, height) * 0.52;
  const aspectY = height / width;
  cardCtx.translate(width / 2, height / 2);
  cardCtx.scale(1, aspectY);
  const radial = cardCtx.createRadialGradient(0, 0, radius * 0.22, 0, 0, radius / aspectY);
  radial.addColorStop(0, 'rgba(0, 0, 0, 0)');
  radial.addColorStop(0.55, 'rgba(0, 0, 0, 0.08)');
  radial.addColorStop(1, 'rgba(0, 0, 0, 0.28)');
  cardCtx.fillStyle = radial;
  cardCtx.fillRect(-width / 2, -width / 2, width, width);
  cardCtx.restore();

  cardCtx.save();
  const vertical = cardCtx.createLinearGradient(0, 0, 0, height);
  vertical.addColorStop(0, 'rgba(0, 0, 0, 0.04)');
  vertical.addColorStop(0.5, 'rgba(0, 0, 0, 0)');
  vertical.addColorStop(1, 'rgba(0, 0, 0, 0.14)');
  cardCtx.fillStyle = vertical;
  cardCtx.fillRect(0, 0, width, height);
  cardCtx.restore();
}

function drawFrostedText(cardCtx, cardCanvas, {
  text,
  x,
  y,
  font,
  align = 'left',
  baseline = 'middle',
  tint = 'rgba(255, 255, 255, 0.38)',
  glowAlpha = 0.24,
  maxWidth = Infinity,
}) {
  const content = String(text ?? '').trim();
  if (!content) return;

  cardCtx.save();
  cardCtx.font = font;
  cardCtx.textAlign = align;
  cardCtx.textBaseline = baseline;
  const label = Number.isFinite(maxWidth) ? truncateText(cardCtx, content, maxWidth) : content;
  const metrics = cardCtx.measureText(label);
  cardCtx.restore();

  const textWidth = Math.max(1, Math.ceil(metrics.width));
  const ascent = Math.ceil(metrics.actualBoundingBoxAscent || FROST_BLUR_PAD);
  const descent = Math.ceil(metrics.actualBoundingBoxDescent || 12);
  const padX = 8;
  const padY = 8;
  const maskW = textWidth + padX * 2;
  const maskH = Math.max(1, ascent + descent + padY * 2);

  let boxLeft = x - padX;
  if (align === 'right' || align === 'end') boxLeft = x - textWidth - padX;
  else if (align === 'center') boxLeft = x - textWidth / 2 - padX;
  const boxTop = baseline === 'middle'
    ? Math.round(y - maskH / 2)
    : Math.round(y - ascent - padY);

  const maskCanvas = document.createElement('canvas');
  maskCanvas.width = maskW;
  maskCanvas.height = maskH;
  const maskCtx = maskCanvas.getContext('2d');
  if (!maskCtx) return;
  maskCtx.font = font;
  maskCtx.textAlign = align;
  maskCtx.textBaseline = baseline;
  maskCtx.fillStyle = '#fff';
  const localX = align === 'right' || align === 'end'
    ? maskW - padX
    : align === 'center'
      ? maskW / 2
      : padX;
  const localY = baseline === 'middle' ? maskH / 2 : ascent + padY;
  maskCtx.fillText(label, localX, localY);

  const patchW = maskW + FROST_BLUR_PAD * 2;
  const patchH = maskH + FROST_BLUR_PAD * 2;
  const patchCanvas = document.createElement('canvas');
  patchCanvas.width = patchW;
  patchCanvas.height = patchH;
  const patchCtx = patchCanvas.getContext('2d');
  const frostCanvas = document.createElement('canvas');
  frostCanvas.width = maskW;
  frostCanvas.height = maskH;
  const frostCtx = frostCanvas.getContext('2d');
  if (!patchCtx || !frostCtx) return;

  const srcX = Math.max(0, Math.min(cardCanvas.width - 1, boxLeft - FROST_BLUR_PAD));
  const srcY = Math.max(0, Math.min(cardCanvas.height - 1, boxTop - FROST_BLUR_PAD));
  const srcR = Math.max(srcX + 1, Math.min(cardCanvas.width, boxLeft + maskW + FROST_BLUR_PAD));
  const srcB = Math.max(srcY + 1, Math.min(cardCanvas.height, boxTop + maskH + FROST_BLUR_PAD));
  patchCtx.drawImage(
    cardCanvas,
    srcX, srcY, srcR - srcX, srcB - srcY,
    0, 0, patchW, patchH
  );

  frostCtx.save();
  frostCtx.filter = 'blur(16px) saturate(180%) brightness(1.26)';
  frostCtx.drawImage(patchCanvas, -FROST_BLUR_PAD, -FROST_BLUR_PAD);
  frostCtx.restore();

  frostCtx.fillStyle = tint;
  frostCtx.fillRect(0, 0, maskW, maskH);
  frostCtx.globalCompositeOperation = 'destination-in';
  frostCtx.drawImage(maskCanvas, 0, 0);

  cardCtx.save();
  cardCtx.drawImage(frostCanvas, boxLeft, boxTop);
  if (glowAlpha > 0) {
    cardCtx.globalCompositeOperation = 'lighter';
    cardCtx.globalAlpha = glowAlpha;
    cardCtx.drawImage(frostCanvas, boxLeft, boxTop);
  }
  cardCtx.restore();
}

export function sanitizeShareFilename(title, artist) {
  const parts = [title, artist].map(v => String(v ?? '').trim()).filter(Boolean);
  const raw = parts.length ? parts.join(' - ') : 'yourLyrics';
  const clean = raw.replace(/[<>:"/\\|?*\u0000-\u001F]/g, '').replace(/\s+/g, ' ').trim();
  return `${clean || 'yourLyrics'}.png`;
}

export async function generateShareLyricsCard({
  lines,
  title,
  artist,
  artworkUrl,
  backdropSeed,
  backdropTime,
  fallbackBackdrop,
}) {
  const selected = Array.isArray(lines) ? lines.filter(item => item?.text?.trim()) : [];
  if (!selected.length) return null;

  const measureCanvas = document.createElement('canvas');
  const measureCtx = measureCanvas.getContext('2d');
  if (!measureCtx) return null;

  const blocks = selected.map(item => {
    const font = lyricFontFor(item);
    measureCtx.font = font;
    const wrapped = wrapTextLines(measureCtx, item.text, CONTENT_WIDTH);
    const alignRight = Boolean((item.rtl && !item.duet) || (!item.rtl && item.duet));
    return { item, font, wrapped, alignRight };
  });

  let lyricsHeight = 0;
  blocks.forEach((block, idx) => {
    lyricsHeight += block.wrapped.length * LYRIC_LINE_HEIGHT;
    if (idx < blocks.length - 1) lyricsHeight += LYRIC_BLOCK_GAP;
  });

  const footerY = PAD_TOP + lyricsHeight + FOOTER_GAP;
  const cardHeight = footerY + ARTWORK_SIZE + PAD_BOTTOM;

  const cardCanvas = document.createElement('canvas');
  cardCanvas.width = CARD_WIDTH;
  cardCanvas.height = cardHeight;
  const cardCtx = cardCanvas.getContext('2d');
  if (!cardCtx) return null;

  const artworkImage = await decodeArtworkImage(artworkUrl);
  drawAmlbgBackdrop(cardCtx, CARD_WIDTH, cardHeight, artworkImage, {
    seed: backdropSeed,
    time: backdropTime,
    fallbackSource: fallbackBackdrop,
  });
  drawBackdropVignette(cardCtx, CARD_WIDTH, cardHeight);

  // Render lyrics
  let cursorY = PAD_TOP;
  blocks.forEach((block, idx) => {
    cardCtx.save();
    cardCtx.font = block.font;
    cardCtx.globalCompositeOperation = 'lighter';
    cardCtx.fillStyle = 'rgba(255, 255, 255, 0.92)';
    cardCtx.textBaseline = 'middle';
    if (block.alignRight) {
      cardCtx.textAlign = 'right';
      cardCtx.direction = block.item.rtl ? 'rtl' : 'ltr';
    } else {
      cardCtx.textAlign = 'left';
      cardCtx.direction = block.item.rtl ? 'rtl' : 'ltr';
    }
    const textX = block.alignRight ? CARD_WIDTH - PAD_X : PAD_X;
    for (const line of block.wrapped) {
      cardCtx.fillText(line, textX, cursorY + LYRIC_LINE_HEIGHT / 2);
      cursorY += LYRIC_LINE_HEIGHT;
    }
    cardCtx.restore();
    if (idx < blocks.length - 1) cursorY += LYRIC_BLOCK_GAP;
  });

  // Artwork thumbnail with opaque caster so Canvas 2D shadow renders at full opacity
  for (const [color, blur, offsetY] of [
    ['rgba(0, 0, 0, 0.42)', 28, 10],
    ['rgba(0, 0, 0, 0.22)', 10, 3],
  ]) {
    cardCtx.save();
    cardCtx.shadowColor = color;
    cardCtx.shadowBlur = blur;
    cardCtx.shadowOffsetY = offsetY;
    cardCtx.fillStyle = artworkImage ? '#141416' : '#2c2c2e';
    cardCtx.beginPath();
    cardCtx.roundRect(PAD_X, footerY, ARTWORK_SIZE, ARTWORK_SIZE, ARTWORK_RADIUS);
    cardCtx.fill();
    cardCtx.restore();
  }

  cardCtx.save();
  cardCtx.beginPath();
  cardCtx.roundRect(PAD_X, footerY, ARTWORK_SIZE, ARTWORK_SIZE, ARTWORK_RADIUS);
  cardCtx.clip();
  if (artworkImage) {
    const iw = artworkImage.naturalWidth || artworkImage.width || ARTWORK_SIZE;
    const ih = artworkImage.naturalHeight || artworkImage.height || ARTWORK_SIZE;
    const scale = Math.max(ARTWORK_SIZE / iw, ARTWORK_SIZE / ih);
    const dw = iw * scale;
    const dh = ih * scale;
    cardCtx.drawImage(
      artworkImage,
      PAD_X + (ARTWORK_SIZE - dw) / 2,
      footerY + (ARTWORK_SIZE - dh) / 2,
      dw,
      dh
    );
  } else {
    cardCtx.fillStyle = 'rgba(255, 255, 255, 0.16)';
    cardCtx.fillRect(PAD_X, footerY, ARTWORK_SIZE, ARTWORK_SIZE);
  }
  cardCtx.restore();

  // Track title & frosted artist text
  const metaX = PAD_X + ARTWORK_SIZE + META_GAP;
  const metaMaxW = Math.max(120, CARD_WIDTH - PAD_X - metaX);
  const midY = footerY + ARTWORK_SIZE / 2;
  const hasArtist = Boolean(String(artist ?? '').trim());
  const titleY = hasArtist ? midY - 19 : midY;
  const artistY = midY + 21;

  if (String(title ?? '').trim()) {
    cardCtx.save();
    cardCtx.font = `700 ${TITLE_FONT_SIZE}px ${BASE_FONT_STACK}`;
    cardCtx.fillStyle = '#ffffff';
    cardCtx.textAlign = 'left';
    cardCtx.textBaseline = 'middle';
    cardCtx.shadowColor = 'rgba(0, 0, 0, 0.28)';
    cardCtx.shadowBlur = 12;
    cardCtx.shadowOffsetY = 2;
    cardCtx.fillText(truncateText(cardCtx, title, metaMaxW), metaX, titleY);
    cardCtx.restore();
  }

  if (hasArtist) {
    drawFrostedText(cardCtx, cardCanvas, {
      text: artist,
      x: metaX,
      y: artistY,
      font: `500 ${ARTIST_FONT_SIZE}px ${BASE_FONT_STACK}`,
      align: 'left',
      baseline: 'middle',
      tint: 'rgba(255, 255, 255, 0.36)',
      glowAlpha: 0.28,
      maxWidth: metaMaxW,
    });
  }

  const dataUrl = cardCanvas.toDataURL('image/png');
  return {
    canvas: cardCanvas,
    dataUrl,
    filename: sanitizeShareFilename(title, artist),
  };
}
