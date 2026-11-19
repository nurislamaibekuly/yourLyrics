const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');

function imageMime(bytes) {
  const ascii = (start, end) => bytes.toString('latin1', start, end);
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) return 'image/png';
  if (ascii(0, 3) === 'GIF') return 'image/gif';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  if (ascii(4, 8) === 'ftyp' && /^(?:avif|avis)$/.test(ascii(8, 12))) return 'image/avif';
  return '';
}

function needsMacConversion(bytes) {
  const magic = bytes.toString('latin1', 0, 4);
  return magic === 'II*\x00' || magic === 'MM\x00*' ||
    (bytes.toString('latin1', 4, 8) === 'ftyp' &&
      /^(?:heic|heix|hevc|hevx|mif1|msf1)$/.test(bytes.toString('latin1', 8, 12)));
}

async function convertMacArtwork(bytes) {
  if (process.platform !== 'darwin') return '';
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'yourlyrics-artwork-'));
  try {
    const input = path.join(directory, 'source');
    const output = path.join(directory, 'cover.png');
    await fs.writeFile(input, bytes);
    await new Promise((resolve, reject) => {
      execFile('/usr/bin/sips', ['-s', 'format', 'png', '-Z', '2048', input, '--out', output],
        { timeout: 10000, maxBuffer: 128 * 1024, windowsHide: true },
        error => error ? reject(error) : resolve());
    });
    const png = await fs.readFile(output);
    return png.length <= 12 * 1024 * 1024 && imageMime(png) === 'image/png'
      ? `data:image/png;base64,${png.toString('base64')}` : '';
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

// Cache successes, failures and pending conversions. Timeline-only updates
// must never launch another converter or discard artwork from the browser.
function createArtworkDecoder({ convert = convertMacArtwork, onReady = () => {} } = {}) {
  const cache = new Map();
  return function decode(base64) {
    if (typeof base64 !== 'string' || !base64 || base64.length > 16 * 1024 * 1024) {
      return { url: '', pending: false };
    }
    if (cache.has(base64)) return cache.get(base64);
    const bytes = Buffer.from(base64, 'base64');
    const mime = imageMime(bytes);
    const entry = { url: mime ? `data:${mime};base64,${base64}` : '', pending: false };
    if (cache.size >= 8) cache.delete(cache.keys().next().value);
    cache.set(base64, entry);
    if (!mime && needsMacConversion(bytes)) {
      entry.pending = true;
      Promise.resolve().then(() => convert(bytes)).then(url => {
        entry.url = url || '';
      }).catch(error => {
        console.error(`[player-artwork] Native artwork conversion failed: ${error.message}`);
      }).finally(() => {
        entry.pending = false;
        onReady(base64);
      });
    }
    return entry;
  };
}

module.exports = { createArtworkDecoder, imageMime };
