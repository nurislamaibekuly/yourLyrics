const browserSource = /(?:chrome|chromium|msedge|firefox|safari|webkit|brave|opera|vivaldi|yandex|browser|librewolf|floorp|epiphany|zen\.(?:app|browser))/i;
const isBrowserSource = source => typeof source === 'string' && browserSource.test(source);
const videoLabel = /\s*[([]\s*(?:official\s+)?(?:music\s+video|video|audio|lyric(?:s|\s+video)?|visuali[sz]er)(?:\s*[,|/-]?\s*(?:official|hd|4k))*\s*[)\]]\s*$/i;
const compact = value => value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

// Browser media sessions often expose video labels and uploader credits in
// place of catalog song metadata. Keep this cleanup outside native players.
function normalizeBrowserMetadata(frame) {
  if (!isBrowserSource(frame.source)) return frame;
  let title = typeof frame.title === 'string' ? frame.title.trim() : '';
  let artist = typeof frame.artist === 'string' ? frame.artist.trim() : '';
  const originalTitle = title;
  title = title.replace(/\s+[-–—|]\s+YouTube(?:\s+Music)?$/i, '');
  let previous;
  do { previous = title; title = title.replace(videoLabel, '').trim(); } while (title !== previous);
  const channelCredit = /(?:\s+-\s+Topic|VEVO)$/i.test(artist);
  const songArtist = artist.replace(/\s+-\s+Topic$/i, '').replace(/VEVO$/i, '').trim();
  const parts = title.match(/^(.+?)\s+[-–—]\s+(.+)$/u);
  if (parts) {
    const performer = parts[1].trim();
    // A real artist credit wins over a guessed split. An uploader is only
    // replaced when the title carries an explicit video label or agrees with
    // its channel credit; song names such as "Song - Live" stay intact.
    if (!artist || compact(performer) === compact(songArtist) ||
        (channelCredit && originalTitle !== title)) {
      artist = performer;
      title = parts[2].trim();
    }
  } else if (channelCredit) {
    artist = songArtist;
  }
  return { ...frame, title: title || frame.title, artist };
}

module.exports = { normalizeBrowserMetadata, isBrowserSource };
