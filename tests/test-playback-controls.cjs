'use strict';

// Real HTML, renderer, preload and IPC; only the native player is synthetic.
// Never starts the app's providers, reads now-playing data, or controls music.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const repo = path.resolve(__dirname, '..');

async function run() {
  const { app, BrowserWindow, ipcMain, session } = require('electron');
  const profile = process.env.YOURLYRICS_CONTROLS_PROFILE;
  if (!profile || !path.basename(profile).startsWith('yourlyrics-controls-')) throw new Error('Missing test profile');
  for (const name of ['userData', 'sessionData', 'logs', 'crashDumps']) app.setPath(name, profile);
  app.commandLine.appendSwitch('disable-background-networking');
  app.commandLine.appendSwitch('disable-component-update');
  const deadline = setTimeout(() => { console.error('UI test timed out'); app.exit(2); }, 65000);
  const results = [];
  const check = (name, ok, details) => results.push({ name, ok: Boolean(ok), details });
  try {
    await app.whenReady();
    const media = require('../src/main/media/now-playing');
    let refreshRequests = 0;
    media.registerNowPlayingIpc(() => {
      refreshRequests += 1;
      media.publishNowPlaying({ positionSeconds: 72 });
      return { ok: true };
    });
    // A cold Windows media helper may be slow. The first usable screen must
    // not wait for it; release the initial snapshot only after verifying that.
    let releaseInitialSnapshot;
    ipcMain.removeHandler('now-playing:get');
    ipcMain.handle('now-playing:get', () => new Promise(resolve => { releaseInitialSnapshot = resolve; }));
    let lyricsProvider = 'lyricsflow';
    let previewLyrics = null;
    let lyricRequests = 0;
    ipcMain.handle('lyrics:get', () => {
      lyricRequests += 1;
      return previewLyrics || {
        text: '[00:30.00]A synthetic preview line\n[00:40.00]Playback controls\n[00:50.00]Below the progress bar',
        source: lyricsProvider
      };
    });
    ipcMain.handle('animated-art:get', () => null);
    ipcMain.handle('lyrics:open-file', () => ({ canceled: true }));
    const isolated = session.fromPartition(`controls-test-${process.pid}`, { cache: false });
    const blocked = [];
    isolated.webRequest.onBeforeRequest((details, callback) => {
      let allowed = details.url.startsWith('data:');
      if (details.url.startsWith('file:')) {
        const file = fileURLToPath(details.url);
        allowed = ['src', 'assets'].some(folder => file.startsWith(path.join(repo, folder) + path.sep)) ||
          file === path.join(repo, 'node_modules/hls.js/dist/hls.mjs');
      }
      if (!allowed) blocked.push(details.url);
      callback({ cancel: !allowed });
    });
    isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    const win = new BrowserWindow({ show: false, width: 1080, height: 800, useContentSize: true,
      webPreferences: { session: isolated, preload: path.join(repo, 'src/preload/index.js'),
        contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    const errors = [];
    win.webContents.on('console-message', event => {
      if (event.level === 'error') errors.push(event.message);
    });
    const js = code => win.webContents.executeJavaScript(code);
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    const until = async code => {
      const end = Date.now() + 5000;
      while (Date.now() < end) {
        if (await (typeof code === 'function' ? code() : js(code))) return;
        await wait(20);
      }
      const state = await js(`({
        title: document.querySelector('.title')?.textContent,
        lyricsBusy: document.querySelector('.lyrics')?.getAttribute('aria-busy'),
        lyricsText: document.querySelector('.lyrics')?.textContent,
        sourceValue: document.querySelector('.sheetview .sheet-row__value')?.textContent,
        sheetText: document.querySelector('.sheetview')?.textContent,
        menuText: document.querySelector('.menuview')?.textContent,
        menuExpanded: document.querySelector('.metadata-menu')?.getAttribute('aria-expanded'),
        notice: document.querySelector('.lyrics-notice')?.textContent
      })`);
      throw new Error(`Timed out waiting for: ${code}; state=${JSON.stringify(state)}; console=${errors.join(' | ')}`);
    };
    const checkPlaybackClock = async () => {
      let clockDuration = 180;
      const progressPosition = () => js(`Number.parseFloat(document.querySelector('.progress').style.getPropertyValue('--progress')) * ${clockDuration} / 100`);
      media.publishNowPlaying({ positionSeconds: 30.25, durationSeconds: 180, playing: true, playbackRate: 0 });
      await wait(250);
      const pendingPosition = await progressPosition();
      await wait(250);
      check('play advances the lyric clock immediately despite a retained zero native rate',
        pendingPosition > 30.4 && await progressPosition() > 30.65, { pendingPosition });
      await until(`document.querySelector('.lyrics-line') && document.querySelector('.lyrics').getAttribute('aria-busy') === 'false'`);
      await js(`(() => {
        window.__clockRows = Array.from(document.querySelectorAll('.lyrics-line'));
        window.__clockRowChanges = 0;
        window.__clockRowObserver = new MutationObserver(records => { window.__clockRowChanges += records.length; });
        window.__clockRowObserver.observe(document.querySelector('.lyrics-track'), { childList: true });
      })()`);
      const beforeCorrection = await progressPosition();
      media.publishNowPlaying({ positionSeconds: beforeCorrection - 0.4, playing: true, playbackRate: 1 });
      await wait(40);
      const afterCorrection = await progressPosition();
      check('a late timestamp correction does not rewind the rendered lyric clock',
        afterCorrection >= beforeCorrection && afterCorrection < beforeCorrection + 0.15,
        { beforeCorrection, afterCorrection });
      const requestsBefore = lyricRequests;
      clockDuration = 184;
      media.publishNowPlaying({ positionSeconds: afterCorrection, durationSeconds: clockDuration, playing: true, playbackRate: 1 });
      await until(() => lyricRequests > requestsBefore);
      await until(`document.querySelector('.lyrics').getAttribute('aria-busy') === 'false'`);
      await wait(40);
      check('duration revalidation preserves the existing lyric rows and fill masks', await js(`
        window.__clockRowChanges === 0 && window.__clockRows.every((row, index) =>
          row.isConnected && row === document.querySelectorAll('.lyrics-line')[index])
      `));
      const pausedPosition = await progressPosition();
      media.publishNowPlaying({ positionSeconds: pausedPosition, playing: false, playbackRate: 0 });
      await wait(40);
      media.publishNowPlaying({ positionSeconds: pausedPosition, playing: true, playbackRate: 0 });
      await wait(120);
      check('resuming starts in the same lyric rows without a renderer refresh',
        await progressPosition() > pausedPosition + 0.06 && await js('window.__clockRowChanges === 0'));
      await js('window.__clockRowObserver.disconnect()');
      clockDuration = 180;
      media.publishNowPlaying({ positionSeconds: 30.75, durationSeconds: clockDuration, playing: true, playbackRate: 1 });
      await wait(300);
      const advancingPosition = await progressPosition();
      check('the renderer advances at the native rate when the elapsed update arrives',
        advancingPosition > 30.8 && advancingPosition < 31.5, { advancingPosition });
      media.publishNowPlaying({ positionSeconds: 31.25, playing: true, playbackRate: 2 });
      await wait(300);
      const fastPosition = await progressPosition();
      check('the renderer preserves non-unit native playback rates',
        fastPosition > 31.65 && fastPosition < 32.2, { fastPosition });
      media.publishNowPlaying({ positionSeconds: fastPosition, playing: true, playbackRate: 1 });
    };
    const checkCommandClock = async () => {
      const sent = [];
      let commandFailure = false;
      media.setPlaybackHandler(async action => {
        sent.push(action);
        return commandFailure ? { ok: false, error: 'unsupported' } : { ok: true };
      });
      media.publishNowPlaying({ positionSeconds: 30.25, durationSeconds: 180, playing: false, playbackRate: 0 });
      await until(`document.body.classList.contains('is-paused') && !document.querySelector('[data-playback="toggle"]').disabled`);
      const position = () => js(`Number.parseFloat(document.querySelector('.progress').style.getPropertyValue('--progress')) * 180 / 100`);
      const press = () => js(`document.querySelector('[data-playback="toggle"]').dispatchEvent(new CustomEvent('pressend', { bubbles: true }))`);
      await js('window.__commandRows = Array.from(document.querySelectorAll(".lyrics-line"))');
      await press();
      await wait(120);
      const firstPosition = await position();
      check('pressing Play advances within the first frames before any native playing notification',
        firstPosition > 30.31 && firstPosition < 30.65 && media.getNowPlaying().playing === false && sent.join(',') === 'play',
        { firstPosition });
      await wait(1000);
      const beforeMetadata = await position();
      media.publishNowPlaying({ artworkPending: false });
      await wait(80);
      const afterMetadata = await position();
      check('the requested timeline keeps moving through a one-second native notification delay',
        beforeMetadata > 31.2 && afterMetadata > beforeMetadata + 0.025 && media.getNowPlaying().playing === false,
        { beforeMetadata, afterMetadata });
      media.publishNowPlaying({ positionSeconds: 30.25, playing: true, playbackRate: 0 });
      await wait(80);
      const afterConfirmation = await position();
      check('a delayed play confirmation carrying the old paused position does not reset the timeline or lyrics',
        afterConfirmation >= afterMetadata && await js(`window.__commandRows.every((row, index) =>
          row.isConnected && row === document.querySelectorAll('.lyrics-line')[index])`),
        { afterMetadata, afterConfirmation });
      await press();
      await until(`document.body.classList.contains('is-paused')`);
      const paused = await position();
      await wait(180);
      check('pressing Pause freezes immediately before the native pause notification',
        Math.abs(await position() - paused) < 0.001 && media.getNowPlaying().playing === true);
      media.publishNowPlaying({ positionSeconds: paused, playing: false, playbackRate: 0 });
      await until(`!document.querySelector('[data-playback="toggle"]').disabled`);
      commandFailure = true;
      await press();
      await until(`document.body.classList.contains('is-paused') && document.querySelector('.lyrics-notice').textContent === 'Could not play playback.'`);
      check('a rejected play command restores the paused clock and lyric position',
        Math.abs(await position() - paused) < 0.001);
      media.setPlaybackHandler(null);
    };
    const button = name => `document.querySelector('[data-playback="${name}"]')`;
    const click = async name => {
      const previousCalls = calls.length;
      const point = await js(`(() => { const r = ${button(name)}.getBoundingClientRect(); return {x: Math.round(r.x+r.width/2), y: Math.round(r.y+r.height/2)}; })()`);
      win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
      await wait(30);
      win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
      // Input injection queues work in Chromium. Wait for the actual command,
      // not an initially-enabled button before its press event has run.
      await until(() => calls.length > previousCalls);
    };
    await win.loadFile(path.join(repo, 'src/renderer/index.html'));
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }]
    });
    check('renderer reveals the app after initialization', await js(`document.body.hidden === false`));
    await until(`!document.body.classList.contains('is-startup-pending')`);
    check('startup reveals without waiting for the initial media response', typeof releaseInitialSnapshot === 'function');
    check('startup avoids full-window blur and allows interaction during reveal', await js(`
      getComputedStyle(document.querySelector('#app')).filter === 'none' &&
      getComputedStyle(document.querySelector('#app')).pointerEvents !== 'none'
    `));
    releaseInitialSnapshot(media.getNowPlaying());
    await until(`${button('toggle')}?._aeroPlayer && document.fonts.status === 'loaded'`);
    check('three native AeroUI buttons are initialized', await js(`document.querySelectorAll('.playback-controls button.aero-player .aero-player-label').length === 3`));
    check('no active player disables every button', await js(`Array.from(document.querySelectorAll('[data-playback]')).every(b => b.disabled)`));
    check('initial toggle has an accessible Play label', await js(`${button('toggle')}.getAttribute('aria-label') === 'Play'`));

    if (process.env.YOURLYRICS_CLOCK_ONLY === '1') {
      await js('window.app.nowPlaying.setArtworkFallback(false)');
      media.publishNowPlaying({ title: 'Synthetic track', artist: 'Clock test', source: 'test-player' });
      await checkPlaybackClock();
      await checkCommandClock();
      check('clock test made no external or private-file requests', blocked.length === 0, blocked);
      check('renderer logged no errors', errors.length === 0, errors);
      for (const result of results) console.log(JSON.stringify(result));
      const failed = results.filter(result => !result.ok);
      console.log(`${results.length - failed.length} clock UI checks passed; ${failed.length} failed`);
      win.destroy();
      app.exit(failed.length ? 1 : 0);
      return;
    }

    await js(`document.querySelector('.metadata-menu').dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }))`);
    await until(`document.querySelector('.menuview')`);
    await js(`Array.from(document.querySelectorAll('.menuview__item')).find(item => item.textContent.trim() === 'Settings').click()`);
    await until(`document.querySelector('.sheetview') && document.querySelector('.sheetview').textContent.includes('Discord')`);
    check('metadata menu opens the Settings sheet with Discord controls',
      await js(`document.querySelector('.sheetview')?.textContent.includes('Rich Presence')`));
    await js(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await until(`!document.querySelector('.sheetview')`);

    const calls = [];
    let mode = 'normal';
    let finishPending;
    const handler = async action => {
      calls.push(action);
      if (mode === 'failure') return { ok: false, error: 'unsupported' };
      if (mode === 'pending') return new Promise(resolve => { finishPending = resolve; });
      if (action === 'play' || action === 'pause') media.publishNowPlaying({ playing: action === 'play' });
      return { ok: true };
    };
    media.setPlaybackHandler(handler);
    await wait(40);
    check('available provider without a song still disables controls', await js(`${button('toggle')}.disabled`));
    media.publishNowPlaying({ title: 'Synthetic track', artist: 'UI test', durationSeconds: 180,
      positionSeconds: 42, playing: true, source: 'test-player' });
    await until(`!${button('toggle')}.disabled && ${button('toggle')}.getAttribute('aria-label') === 'Pause'`);
    const backdropBrightness = async () => js(
      `Number(getComputedStyle(document.querySelector('.backdrop')).filter.match(/brightness\\(([^)]+)\\)/)?.[1])`
    );
    const backdropSaturation = async () => js(
      `Number(getComputedStyle(document.querySelector('.backdrop')).filter.match(/saturate\\(([^)]+)\\)/)?.[1])`
    );
    const sourceCases = [
      ['lyricsflow', 'LyricsFlow', 'Synthetic track'],
      ['betterlyrics', 'Better Lyrics', 'Synthetic Better Lyrics track'],
      ['lrclib', 'LRCLib', 'Synthetic LRCLib track'],
      ['amll-ttml-db', 'AMLL TTML DB', 'Synthetic AMLL track']
    ];
    for (const [provider, label, title] of sourceCases) {
      lyricsProvider = provider;
      if (title !== 'Synthetic track') {
        media.publishNowPlaying({ title, artist: 'UI test', durationSeconds: 180,
          positionSeconds: 42, playing: true, source: 'test-player' });
        await until(`document.querySelector('.title').textContent === ${JSON.stringify(title)}`);
        await until(`document.querySelector('.lyrics').getAttribute('aria-busy') === 'false'`);
      } else {
        await until(`document.querySelector('.lyrics').children.length > 0`);
      }
      await until(async () =>
        Math.abs((await backdropBrightness()) - 0.82) < 0.001 &&
        Math.abs((await backdropSaturation()) - 0.85) < 0.001
      );
      check(`visible ${label} lyrics enable the mesh scrim`,
        await js(`document.body.classList.contains('has-lyric-scrim')`) &&
        Math.abs((await backdropBrightness()) - 0.82) < 0.001 &&
        Math.abs((await backdropSaturation()) - 0.85) < 0.001);
      check(`visible ${label} lyrics avoid row-wide additive blending`, await js(
        `(() => { const s = getComputedStyle(document.querySelector('.lyrics-line')); ` +
        `return s.color === 'rgb(255, 255, 255)' && s.mixBlendMode === 'normal'; })()`
      ));
      check('moving the mouse restores the cursor', await js(`getComputedStyle(document.body).cursor !== 'none' && getComputedStyle(document.querySelector('.lyrics-line')).cursor !== 'none'`));
    await js(`document.querySelector('.metadata-menu').dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }))`);
      await until(`document.querySelector('.menuview')`);
      await js(`Array.from(document.querySelectorAll('.menuview__item')).find(item => item.textContent.trim() === 'Lyrics').click()`);
      await until(`document.querySelector('.sheetview .sheet-row__value')?.textContent === ${JSON.stringify(label)}`);
      check(`lyrics sheet displays ${label} as the source`,
        await js(`document.querySelector('.sheetview .sheet-row__value')?.textContent === ${JSON.stringify(label)}`));
      await js(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
      await until(`!document.querySelector('.sheetview')`);
    }
    await js(`document.querySelector('.lyrics-toggle').click()`);
    await until(`document.body.classList.contains('is-lyrics-hidden')`);
    let dimmingOutFrame = 0.82;
    let desaturatingOutFrame = 0.85;
    await until(async () => {
      dimmingOutFrame = await backdropBrightness();
      desaturatingOutFrame = await backdropSaturation();
      return dimmingOutFrame > 0.82 && dimmingOutFrame < 1 &&
        desaturatingOutFrame > 0.85 && desaturatingOutFrame < 1;
    });
    check('hiding lyrics animates the mesh back to full brightness',
      dimmingOutFrame > 0.82 && dimmingOutFrame < 1, dimmingOutFrame);
    check('hiding lyrics animates the mesh back to full saturation',
      desaturatingOutFrame > 0.85 && desaturatingOutFrame < 1, desaturatingOutFrame);
    await until(async () =>
      Math.abs((await backdropBrightness()) - 1) < 0.001 &&
      Math.abs((await backdropSaturation()) - 1) < 0.001
    );
    check('hiding lyrics removes the mesh scrim',
      !await js(`document.body.classList.contains('has-lyric-scrim')`) &&
      Math.abs((await backdropBrightness()) - 1) < 0.001 &&
      Math.abs((await backdropSaturation()) - 1) < 0.001);
    await js(`document.querySelector('.lyrics-toggle').click()`);
    await until(`document.body.classList.contains('has-lyric-scrim')`);
    let dimmingInFrame = 1;
    let desaturatingInFrame = 1;
    await until(async () => {
      dimmingInFrame = await backdropBrightness();
      desaturatingInFrame = await backdropSaturation();
      return dimmingInFrame > 0.82 && dimmingInFrame < 1 &&
        desaturatingInFrame > 0.85 && desaturatingInFrame < 1;
    });
    check('showing lyrics animates the mesh down to scrim brightness',
      dimmingInFrame > 0.82 && dimmingInFrame < 1, dimmingInFrame);
    check('showing lyrics animates the mesh down to scrim saturation',
      desaturatingInFrame > 0.85 && desaturatingInFrame < 1, desaturatingInFrame);
    await until(async () =>
      Math.abs((await backdropBrightness()) - 0.82) < 0.001 &&
      Math.abs((await backdropSaturation()) - 0.85) < 0.001
    );
    await js(`document.querySelector('.metadata-menu').dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }))`);
    await until(`document.querySelector('.menuview')`);
    await js(`Array.from(document.querySelectorAll('.menuview__item')).find(item => item.textContent.trim() === 'Resync lyrics').click()`);
    await until(() => refreshRequests === 1);
    await until(`document.querySelector('.lyrics-notice').textContent === 'Playback position resynced.'`);
    check('metadata menu refreshes the tracked playback position',
      refreshRequests === 1 && await js(`document.querySelector('.time-elapsed').textContent === '1:12'`));

    await js(`document.querySelector('.metadata-menu').dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }))`);
    await until(`document.querySelector('.menuview')`);
    await js(`Array.from(document.querySelectorAll('.menuview__item')).find(item => item.textContent.trim() === 'Settings').click()`);
    await until(`document.querySelector('.sheetview')`);
    const chooseUiStyle = async label => {
      await js(`Array.from(document.querySelectorAll('.sheet-row')).find(row => row.firstElementChild?.textContent === 'UI style').click()`);
      await until(`document.querySelector('.menuview')`);
      await js(`Array.from(document.querySelectorAll('.menuview__item')).find(item => item.textContent.trim() === ${JSON.stringify(label)}).click()`);
      await until(`document.body.dataset.uiStyle === '${label.toLowerCase()}' && !document.querySelector('.stage').classList.contains('is-ui-switching')`);
    };
    check('existing macOS UI is the default', await js(`(document.body.dataset.uiStyle || 'macos') === 'macos'`));
    const macArtistFontSize = await js(`getComputedStyle(document.querySelector('.artist')).fontSize`);
    const setStyleSetting = async (label, value) => js(`(() => {
      const input = Array.from(document.querySelectorAll('.sheet-row')).find(row => row.firstElementChild?.textContent === ${JSON.stringify(label)}).querySelector('input');
      if (input.type === 'checkbox') { input.checked = ${JSON.stringify(value)}; input.dispatchEvent(new Event('change', { bubbles: true })); }
      else { input.value = ${JSON.stringify(String(value))}; input.dispatchEvent(new Event('input', { bubbles: true })); }
    })()`);
    await setStyleSetting('Text size', 4.4);
    await setStyleSetting('Line spacing', .8);
    await setStyleSetting('Line blur', false);
    await chooseUiStyle('tvOS');
    await until(`document.querySelector('.title').classList.contains('frost-ready')`);
    check('tvOS starts with independent text size, spacing and blur', await js(`
      document.documentElement.style.getPropertyValue('--lyrics-font-base') === '5.83vh' &&
      document.documentElement.style.getPropertyValue('--lyrics-spacing-scale') === '1' &&
      !document.querySelector('.lyrics').classList.contains('is-line-blur-off')
    `));
    await setStyleSetting('Text size', 6);
    await setStyleSetting('Line spacing', 1.2);
    await setStyleSetting('Line blur', true);
    // Restore the default TV geometry for the existing reference checks.
    await setStyleSetting('Text size', 5.83);
    await setStyleSetting('Line spacing', 1);

    const beforePolish = media.getNowPlaying();
    const coverA = await js(`(() => { const c=document.createElement('canvas');c.width=c.height=64;const x=c.getContext('2d');x.fillStyle='#b84b73';x.fillRect(0,0,64,64);return c.toDataURL(); })()`);
    const coverB = await js(`(() => { const c=document.createElement('canvas');c.width=c.height=64;const x=c.getContext('2d');x.fillStyle='#3e85b6';x.fillRect(0,0,64,64);return c.toDataURL(); })()`);
    media.publishNowPlaying({ title: 'Polish track one', artist: 'Test artist', artworkUrl: coverA });
    await until(`document.querySelector('.title').textContent === 'Polish track one' && document.querySelector('.artwork:not(.artwork-outgoing)').src === ${JSON.stringify(coverA)}`);
    await wait(700);
    media.publishNowPlaying({ title: 'Polish track two', artworkUrl: coverB });
    await until(`document.querySelector('.artwork-outgoing') && document.querySelector('.artwork:not(.artwork-outgoing)').src === ${JSON.stringify(coverB)}`);
    check('song changes crossfade a decoded cover over the previous cover', await js(`
      document.querySelector('.artwork-outgoing').getAnimations().some(a => a.playState === 'running') &&
      document.querySelector('.artwork:not(.artwork-outgoing)').naturalWidth > 0
    `));
    check('title and artist leave together before revealing the new metadata', await js(`
      ['.title','.artist'].every(selector => document.querySelector(selector).getAnimations().some(a => a.effect.getKeyframes().some(k => k.filter?.includes('blur'))))
    `));
    await until(`document.querySelector('.title').textContent === 'Polish track two'`);
    await wait(700);
    await until(`!document.querySelector('.artwork-outgoing') && getComputedStyle(document.querySelector('.lyrics-mask')).opacity === '1'`);
    check('song transition settles without a lingering cover or hidden lyrics', await js(`
      !document.querySelector('.artwork-outgoing') && getComputedStyle(document.querySelector('.lyrics-mask')).opacity === '1'
    `));
    check('tvOS artwork has no glow', await js(`getComputedStyle(document.querySelector('.artwork:not(.artwork-outgoing)')).boxShadow === 'none'`));
    const artistCrop = await js(`(() => {
      const range=document.createRange();range.selectNodeContents(document.querySelector('.artist'));
      const r=range.getBoundingClientRect();return {x:Math.floor(r.x)-2,y:Math.floor(r.y)-2,width:Math.ceil(r.width)+4,height:Math.ceil(r.height)+4};
    })()`);
    const artistContrast = image => {
      const {width,height}=image.getSize();const bytes=image.toBitmap();let edges=0;
      for(let y=1;y<height-1;y++) for(let x=2;x<width-2;x++) {
        const at=(y*width+x)*4;
        const delta=Math.abs(bytes[at]-(bytes[at-8]+bytes[at+8])/2)+Math.abs(bytes[at+1]-(bytes[at-7]+bytes[at+9])/2)+Math.abs(bytes[at+2]-(bytes[at-6]+bytes[at+10])/2);
        if(delta>24)edges++;
      }
      return edges;
    };
    const artistBeforeTilt = artistContrast(await win.webContents.capturePage(artistCrop));
    await js(`(() => { const art=document.querySelector('.artwork');const r=art.getBoundingClientRect();art.dispatchEvent(new PointerEvent('pointermove',{clientX:r.right-1,clientY:r.top+1})); })()`);
    await wait(260);
    const artistDuringTilt = artistContrast(await win.webContents.capturePage(artistCrop));
    check('frosted artist text stays rendered while the artwork tilts', artistBeforeTilt > 20 && artistDuringTilt > artistBeforeTilt * .7,
      {before:artistBeforeTilt,during:artistDuringTilt});
    check('tvOS pointer tilt stays separate from the artwork scale', await js(`document.querySelector('.album-group').style.getPropertyValue('--cover-tilt') !== '0 1 0 0deg'`));
    await js(`document.querySelector('.artwork').dispatchEvent(new PointerEvent('pointerleave'))`);
    check('leaving the artwork resets its tilt', await js(`document.querySelector('.album-group').style.getPropertyValue('--cover-tilt') === '0 1 0 0deg'`));
    media.publishNowPlaying({ title: 'Interrupted one', artworkUrl: coverA });
    await wait(30);
    media.publishNowPlaying({ title: 'Interrupted two', artworkUrl: coverB });
    await until(`document.querySelector('.title').textContent === 'Interrupted two'`);
    await wait(700);
    check('rapid track changes keep only the latest metadata and cover', await js(`
      document.querySelector('.title').textContent === 'Interrupted two' &&
      document.querySelector('.artwork:not(.artwork-outgoing)').src === ${JSON.stringify(coverB)} &&
      !document.querySelector('.artwork-outgoing')
    `));
    media.publishNowPlaying(beforePolish);
    await until(`document.querySelector('.title').textContent === ${JSON.stringify(beforePolish.title)}`);
    await wait(700);
    const beforeLongTitle = media.getNowPlaying();
    const longTitle = 'A Long Song Title With Every Word Kept Visible Instead Of Being Replaced By Dots';
    media.publishNowPlaying({ title: longTitle, artworkUrl: require('node:url').pathToFileURL(path.join(repo, 'assets/fallback.png')).href });
    await until(`document.querySelector('.title').textContent === ${JSON.stringify(longTitle)} && document.querySelector('.title').classList.contains('frost-ready')`);
    await wait(150);
    const wrappedTitle = await js(`(async () => {
      const title = document.querySelector('.title');
      const range = document.createRange(); range.selectNodeContents(title);
      const image = new Image(); image.src = title.style.getPropertyValue('--frost-mask').slice(5, -2); await image.decode();
      return { text: title.textContent, lines: range.getClientRects().length,
        overflow: getComputedStyle(title).textOverflow, width: title.clientWidth, scrollWidth: title.scrollWidth,
        maskHeight: image.naturalHeight, expectedHeight: Math.round((title.offsetHeight + 4) * devicePixelRatio) };
    })()`);
    check('long tvOS song titles wrap completely instead of ending in ellipsis',
      wrappedTitle.text === longTitle && wrappedTitle.lines > 1 && wrappedTitle.overflow === 'clip' && wrappedTitle.scrollWidth <= wrappedTitle.width + 4, wrappedTitle);
    check('frosted title mask includes every wrapped line and glyph padding', wrappedTitle.maskHeight === wrappedTitle.expectedHeight, wrappedTitle);
    media.publishNowPlaying(beforeLongTitle);
    await until(`document.querySelector('.title').textContent === ${JSON.stringify(beforeLongTitle.title)}`);
    await wait(100);
    check('tvOS title is frosted with a stronger tint than the artist', await js(`(() => {
      const titleLabel = document.querySelector('.title');
      const title = getComputedStyle(titleLabel, '::after');
      const artist = getComputedStyle(document.querySelector('.artist'), '::after');
      const alpha = value => Number(value.match(/[\\d.]+(?=\\))/)?.[0] || 1);
      return title.content !== 'none' && getComputedStyle(titleLabel).maskImage.startsWith('url(') && alpha(title.backgroundColor) > alpha(artist.backgroundColor);
    })()`));
    check('tvOS frosted labels reveal the backdrop without a flat text fill or blend isolation', await js(`
      ['.title', '.artist'].every(selector => {
        const label = document.querySelector(selector);
        const style = getComputedStyle(label);
        const glass = getComputedStyle(label, '::after');
        return label.classList.contains('frost-ready') && style.color === 'rgba(0, 0, 0, 0)' &&
          style.mixBlendMode === 'normal' && glass.backdropFilter.includes('blur(12px)') && style.maskImage.startsWith('url(');
      })
    `));
    check('tvOS now-playing indicator has four frosted animated bars before the title', await js(`(() => {
      const indicator = document.querySelector('.now-playing-indicator');
      const bars = Array.from(indicator.children);
      return indicator.getAttribute('aria-hidden') === 'true' && bars.length === 4 &&
        indicator.getBoundingClientRect().right < document.querySelector('.title').getBoundingClientRect().left &&
        bars.every(bar => getComputedStyle(bar).backdropFilter.includes('blur') && bar.getAnimations().some(animation => animation.playState === 'running'));
    })()`));
    media.publishNowPlaying({ playing: false });
    await until(`document.body.classList.contains('is-paused')`);
    check('now-playing bars pause with playback', await js(`Array.from(document.querySelector('.now-playing-indicator').children).every(bar => bar.getAnimations().every(animation => animation.playState === 'paused'))`));
    media.publishNowPlaying({ playing: true });
    await until(`!document.body.classList.contains('is-paused')`);
    check('tvOS artist frost is confined to the label instead of covering the album', await js(`(() => {
      const artist = document.querySelector('.artist');
      const mask = getComputedStyle(artist, '::after');
      return artist.classList.contains('frost-ready') && getComputedStyle(artist).position === 'relative' &&
        Math.abs(Number.parseFloat(mask.height) - artist.clientHeight) < 1;
    })()`));
    check('tvOS uses the reference bold weight and reports it in Settings', await js(`
      getComputedStyle(document.querySelector('.lyrics-line')).fontWeight === '700' &&
      Array.from(document.querySelectorAll('.sheet-row')).find(row => row.firstElementChild?.textContent === 'Font weight').querySelector('.sheet-row__value').textContent === 'Bold'
    `));
    check('tvOS keeps a smaller album column left of the lyrics', await js(`(() => {
      const art = document.querySelector('.artwork').getBoundingClientRect();
      const lyrics = document.querySelector('.lyrics').getBoundingClientRect();
      return art.right < lyrics.left && art.width < innerWidth * 0.3;
    })()`));
    check('tvOS keeps the timeline and only the menu and lyrics buttons', await js(`(() => {
      const progress = document.querySelector('.progress').getBoundingClientRect();
      const menu = document.querySelector('.metadata-menu').getBoundingClientRect();
      const lyrics = document.querySelector('.lyrics-toggle').getBoundingClientRect();
      return progress.width > document.querySelector('#app').getBoundingClientRect().width * 0.8 &&
        getComputedStyle(document.querySelector('.playback-controls')).display === 'none' &&
        menu.width > 0 && lyrics.width > 0 && menu.top > progress.bottom && lyrics.top > progress.bottom &&
        Math.abs(menu.top - lyrics.top) < 1 && lyrics.right < menu.left;
    })()`));
    check('fade completed lines starts disabled', await js(`!document.querySelector('.lyrics').classList.contains('is-fade-completed')`));
    const lineSetting = async label => js(`Array.from(document.querySelectorAll('.sheet-row')).find(row => row.firstElementChild?.textContent === ${JSON.stringify(label)}).querySelector('input').click()`);
    check('tvOS respects enabled line blur', await js(`Number.parseFloat(getComputedStyle(document.querySelector('.lyrics-line:not(.is-active)')).getPropertyValue('--line-blur')) > 0`));
    await lineSetting('Line blur');
    check('tvOS users can disable line blur', await js(`Number.parseFloat(getComputedStyle(document.querySelector('.lyrics-line:not(.is-active)')).getPropertyValue('--line-blur')) === 0`));
    await lineSetting('Line blur');
    await lineSetting('Fade completed lines');
    await wait(1050);
    check('optional completed-line fade hides previous lines and preserves the current line', await js(`(() => {
      const completed = document.querySelector('.lyrics-line.is-completed');
      return completed && Number(getComputedStyle(completed).opacity) === 0 &&
        Number(getComputedStyle(document.querySelector('.lyrics-line.is-active')).opacity) === 1;
    })()`));
    check('completed-line fade is saved', await js(`JSON.parse(localStorage.getItem('yourlyrics:settings')).fadeCompletedLines === true`));
    await lineSetting('Fade completed lines');
    check('UI style selection is saved', await js(`JSON.parse(localStorage.getItem('yourlyrics:settings')).uiStyle === 'tvos'`));
    check('layout switching leaves no animation or input lock behind', await js(`!document.querySelector('.stage').inert && document.querySelector('.stage').getAnimations().length === 0`));
    for (const [width, height] of [[560, 480], [1440, 1000], [1080, 800]]) {
      win.setContentSize(width, height);
      await wait(150);
      check(`tvOS ${width}x${height}: artwork, lyrics and transport fit`, await js(`(() => {
        const art = document.querySelector('.artwork').getBoundingClientRect();
        const lyrics = document.querySelector('.lyrics').getBoundingClientRect();
        return art.left >= 0 && art.right < lyrics.left && lyrics.right <= innerWidth &&
          Array.from(document.querySelectorAll('[data-playback]')).every(button => {
            const r = button.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight;
          });
      })()`));
    }
    await js(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await until(`!document.querySelector('.sheetview')`);
    const visibleLyricsHeight = await js(`document.querySelector('.lyrics').getBoundingClientRect().height`);
    const centering = await js(`(async () => {
      const rect = selector => document.querySelector(selector).getBoundingClientRect();
      const initial = rect('.artwork');
      const initialGroup = rect('.album-group');
      const titleGap = rect('.title-row').top - initial.bottom;
      const artistGap = rect('.artist').top - initial.bottom;
      let drift = 0;
      let verticalDrift = 0;
      let groupCenterError = Math.abs(initialGroup.y + initialGroup.height / 2 - innerHeight / 2);
      const sample = async () => {
        const until = performance.now() + 600;
        while (performance.now() < until) {
          await new Promise(requestAnimationFrame);
          const art = rect('.artwork'), title = rect('.title-row'), artist = rect('.artist');
          const center = art.x + art.width / 2;
          const group = rect('.album-group');
          verticalDrift = Math.max(verticalDrift, Math.abs(art.top - initial.top));
          groupCenterError = Math.max(groupCenterError, Math.abs(group.y + group.height / 2 - innerHeight / 2));
          drift = Math.max(drift, Math.abs(title.x + title.width / 2 - center),
            Math.abs(artist.x + artist.width / 2 - center),
            Math.abs(title.top - art.bottom - titleGap), Math.abs(artist.top - art.bottom - artistGap));
        }
      };
      document.querySelector('.lyrics-toggle').click();
      await sample();
      const centered = rect('.album-group');
      const centerError = Math.max(Math.abs(centered.x + centered.width / 2 - innerWidth / 2),
        Math.abs(centered.y + centered.height / 2 - innerHeight / 2));
      document.querySelector('.lyrics-toggle').click();
      await sample();
      const returned = rect('.artwork');
      return { drift, verticalDrift, groupCenterError, centerError, returnError: Math.max(Math.abs(returned.left - initial.left), Math.abs(returned.top - initial.top)) };
    })()`);
    check('tvOS artwork, title and artist move together throughout both transitions', centering.drift < 0.5, centering);
    check('tvOS artwork and both labels are vertically centered as one group in both modes', centering.groupCenterError < 1, centering);
    check('toggling tvOS lyrics never changes the album vertical position', centering.verticalDrift < 0.5, centering);
    check('hiding tvOS lyrics centers the complete album group horizontally', centering.centerError < 1, centering);
    check('showing tvOS lyrics restores the original album position', centering.returnError < 1, centering);
    await js(`document.activeElement?.blur(); window.dispatchEvent(new Event('pointermove'))`);
    await wait(3600);
    check('tvOS bottom chrome fades away after three seconds without input', await js(`
      document.body.classList.contains('is-tvos-idle') &&
      ['.progress', '.time', '.metadata-menu', '.lyrics-toggle'].every(selector =>
        getComputedStyle(document.querySelector(selector)).visibility === 'hidden' &&
        Number(getComputedStyle(document.querySelector(selector)).opacity) === 0)
    `));
    check('tvOS hides the cursor over the whole player when controls are hidden', await js(`
      ['body', '.artwork', '.title', '.lyrics', '.lyrics-line'].every(selector =>
        getComputedStyle(document.querySelector(selector)).cursor === 'none')
    `));
    check('idle tvOS disables hover and pointer input on the player', await js(`
      ['.lyrics', '.lyrics-line', '.artwork', '.progress'].every(selector =>
        getComputedStyle(document.querySelector(selector)).pointerEvents === 'none')
    `));
    check('idle tvOS clears lyric hover highlights', await js(`document.querySelectorAll('.lyrics-line.is-hovered').length === 0`));
    check('idle tvOS lyrics use the full window height', await js(`(() => {
      const height = document.querySelector('.lyrics').getBoundingClientRect().height;
      return Math.abs(height - innerHeight) < 1 && height > ${visibleLyricsHeight} * 1.1;
    })()`));
    await js(`window.dispatchEvent(new Event('pointermove'))`);
    await wait(400);
    await until(`getComputedStyle(document.querySelector('.progress')).opacity === '1'`);
    check('moving the mouse restores tvOS controls', await js(`
      !document.body.classList.contains('is-tvos-idle') &&
      getComputedStyle(document.querySelector('.metadata-menu')).visibility === 'visible' &&
      Number(getComputedStyle(document.querySelector('.progress')).opacity) === 1
    `));
    await js(`document.querySelector('.metadata-menu').dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }))`);
    await until(`document.querySelector('.menuview')`);
    await js(`Array.from(document.querySelectorAll('.menuview__item')).find(item => item.textContent.trim() === 'Settings').click()`);
    await until(`document.querySelector('.sheetview')`);
    if (process.env.YOURLYRICS_TVOS_PREVIEW) {
      await js(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
      await until(`!document.querySelector('.sheetview')`);
      const beforePreview = media.getNowPlaying();
      previewLyrics = {
        text: `<tt xmlns="http://www.w3.org/ns/ttml"><body><div>
          <p begin="50s" end="70s"><span begin="50s" end="58s">I didn't know love could</span> <span begin="60s" end="70s">feel like that</span></p>
          <p begin="75s" end="85s">I ran right through them</p>
        </div></body></tt>`, source: 'lyricsflow'
      };
      media.publishNowPlaying({ title: 'Red Flags', artist: 'Brittany Howard', album: 'What Now', durationSeconds: 266, positionSeconds: 58, playing: true });
      win.setContentSize(1920, 1080);
      await until(`document.querySelector('.title').textContent === 'Red Flags' && document.querySelector('.lyrics').getAttribute('aria-busy') === 'false'`);
      await wait(700);
      const referenceGeometry = await js(`(() => {
        const art = document.querySelector('.artwork').getBoundingClientRect();
        const group = document.querySelector('.album-group').getBoundingClientRect();
        const main = document.querySelector('.lyrics-line.is-active .lyrics-main-text').getBoundingClientRect();
        const progress = document.querySelector('.progress').getBoundingClientRect();
        return { artLeft: art.left / innerWidth, groupCenter: (group.top + group.height / 2) / innerHeight, artWidth: art.width / innerWidth,
          lyricLeft: main.left / innerWidth, lyricCenter: (main.top + main.height / 2) / innerHeight,
          progressLeft: progress.left / innerWidth, progressWidth: progress.width / innerWidth };
      })()`);
      check('widescreen tvOS geometry matches the supplied reference',
        Math.abs(referenceGeometry.artLeft - 0.078) < 0.003 &&
        Math.abs(referenceGeometry.groupCenter - 0.5) < 0.003 &&
        Math.abs(referenceGeometry.artWidth - 0.2725) < 0.003 &&
        Math.abs(referenceGeometry.lyricLeft - 0.4375) < 0.003 &&
        Math.abs(referenceGeometry.lyricCenter - 0.435) < 0.005 &&
        Math.abs(referenceGeometry.progressLeft - 0.042) < 0.003 &&
        Math.abs(referenceGeometry.progressWidth - 0.916) < 0.003, referenceGeometry);
      fs.writeFileSync(process.env.YOURLYRICS_TVOS_PREVIEW, (await win.webContents.capturePage()).toPNG());
      await js(`document.querySelector('.lyrics-toggle').click()`);
      await wait(600);
      fs.writeFileSync(process.env.YOURLYRICS_TVOS_PREVIEW.replace(/\.png$/, '-centered.png'), (await win.webContents.capturePage()).toPNG());
      await js(`document.querySelector('.lyrics-toggle').click()`);
      await wait(600);
      await js(`document.activeElement?.blur(); window.dispatchEvent(new Event('pointermove'))`);
      await wait(3600);
      fs.writeFileSync(process.env.YOURLYRICS_TVOS_PREVIEW.replace(/\.png$/, '-idle.png'), (await win.webContents.capturePage()).toPNG());
      const metadataCrop = await js(`(() => {
        const group = document.querySelector('.album-group').getBoundingClientRect();
        const title = document.querySelector('.title-row').getBoundingClientRect();
        const artist = document.querySelector('.artist').getBoundingClientRect();
        return { x: Math.floor(group.left) - 8, y: Math.floor(title.top) - 6, width: Math.ceil(group.width) + 16, height: Math.ceil(artist.bottom - title.top) + 12 };
      })()`);
      fs.writeFileSync(process.env.YOURLYRICS_TVOS_PREVIEW.replace(/\.png$/, '-metadata.png'), (await win.webContents.capturePage(metadataCrop)).toPNG());
      await js(`window.dispatchEvent(new Event('pointermove'))`);
      previewLyrics = null;
      media.publishNowPlaying(beforePreview);
      win.setContentSize(1080, 800);
      await wait(200); // MenuView dismisses open menus on native resize events.
      await js(`document.querySelector('.metadata-menu').dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }))`);
      await until(`document.querySelector('.menuview')`);
      await js(`Array.from(document.querySelectorAll('.menuview__item')).find(item => item.textContent.trim() === 'Settings').click()`);
      await until(`document.querySelector('.sheetview')`);
    }
    await chooseUiStyle('macOS');
    check('returning to macOS restores its own size, spacing and blur', await js(`
      document.documentElement.style.getPropertyValue('--lyrics-font-base') === '4.4vh' &&
      document.documentElement.style.getPropertyValue('--lyrics-spacing-scale') === '0.8' &&
      document.querySelector('.lyrics').classList.contains('is-line-blur-off') &&
      Array.from(document.querySelectorAll('.sheet-row')).find(row => row.firstElementChild?.textContent === 'Text size').querySelector('input').value === '4.4'
    `));
    await setStyleSetting('Text size', 5.83);
    await setStyleSetting('Line spacing', 1);
    await setStyleSetting('Line blur', true);

    check('macOS title remains plain and its now-playing bars stay hidden', await js(`
      !document.querySelector('.title').classList.contains('frost-ready') &&
      getComputedStyle(document.querySelector('.now-playing-indicator')).display === 'none'
    `));
    check('returning from tvOS preserves the macOS artist font size', await js(`getComputedStyle(document.querySelector('.artist')).fontSize === ${JSON.stringify(macArtistFontSize)}`));
    const artistMaskSize = await js(`(async () => {
      const artist = document.querySelector('.artist');
      const value = artist.style.getPropertyValue('--frost-mask');
      const image = new Image();
      image.src = value.slice(5, -2);
      await image.decode();
      return { width: image.naturalWidth, height: image.naturalHeight,
        expectedWidth: Math.round(artist.offsetWidth * devicePixelRatio),
        expectedHeight: Math.round(artist.offsetHeight * devicePixelRatio) };
    })()`);
    check('artist text mask uses unscaled font geometry during sheet and UI transitions',
      artistMaskSize.width === artistMaskSize.expectedWidth && artistMaskSize.height === artistMaskSize.expectedHeight, artistMaskSize);
    check('macOS uses the default bold lyric weight', await js(`getComputedStyle(document.querySelector('.lyrics-line')).fontWeight === '700'`));
    check('macOS restores its original progress geometry', await js(`(() => {
      const art = document.querySelector('.artwork').getBoundingClientRect();
      const progress = document.querySelector('.progress').getBoundingClientRect();
      return Math.abs(art.width - progress.width) < 1;
    })()`));
    const developerChecks = await js(`(async () => {
      const version = document.querySelector('[data-action="version"]');
      const section = () => document.querySelector('.developer-settings');
      const overlay = document.querySelector('.developer-overlay');
      const results = [];
      const check = (name, ok) => results.push({ name, ok });
      const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
      const dismissModeAlert = async title => {
        check(title + ' alert appears', document.querySelector('.alertview__title')?.textContent === title);
        document.querySelector('.alertview button').click();
        await wait(250);
      };
      check('version is an accessible button', version?.tagName === 'BUTTON');
      check('developer controls start hidden', section().children.length === 0 && overlay.hidden);
      for (let i = 0; i < 7; i++) version.click();
      check('seven version presses do not enable developer mode', section().children.length === 0);
      version.click();
      check('eighth version press reveals developer controls', section().querySelectorAll('input').length === 6);
      const entrance = section().getAnimations()[0]?.effect.getKeyframes();
      check('developer controls enter from scale 1.2 with blur and opacity', entrance?.[0].transform === 'scale(1.2)' && entrance[0].opacity === '0' && entrance[0].filter === 'blur(12px)');
      await dismissModeAlert('Developer Mode Enabled');
      const toggle = label => Array.from(section().querySelectorAll('label')).find(row => row.textContent === label).querySelector('input').click();
      toggle('Show FPS');
      await new Promise(resolve => setTimeout(resolve, 700));
      check('FPS switch displays measured frames and frame time', !overlay.hidden && /\\d+ FPS.*ms\\/frame/.test(overlay.textContent));
      toggle('Show diagnostics');
      await new Promise(resolve => setTimeout(resolve, 600));
      check('diagnostics include frame stalls and playback details', /Slow frames/.test(overlay.textContent) && /Source: test-player/.test(overlay.textContent));
      check('developer options are saved', JSON.parse(localStorage.getItem('yourlyrics:developer')).showDiagnostics === true);
      toggle('Show FPS');
      toggle('Show diagnostics');
      await wait(750);
      await Promise.all(overlay.getAnimations().map(a => a.finished.catch(() => {})));
      check('switches hide all telemetry when off', overlay.hidden);
      toggle('Show FPS');
      for (let i = 0; i < 7; i++) version.click();
      check('seven more presses keep developer mode enabled', section().children.length > 0);
      version.click();
      check('developer controls cannot be used during exit', section().inert);
      const exit = section().getAnimations()[0]?.effect.getKeyframes();
      check('developer controls exit toward scale 1.2 with blur and opacity', exit?.at(-1).transform === 'scale(1.2)' && exit.at(-1).opacity === '0' && exit.at(-1).filter === 'blur(12px)');
      await dismissModeAlert('Developer Mode Disabled');
      await wait(750);
      check('eight more presses disable developer mode and hide telemetry after exit', section().hidden && overlay.hidden);
      return results;
    })()`);
    for (const result of developerChecks) check(result.name, result.ok);
    if (process.env.YOURLYRICS_DEVELOPER_PREVIEW) {
      await js(`(() => {
        const version = document.querySelector('[data-action="version"]');
        for (let i = 0; i < 8; i++) version.click();
        document.querySelector('.alertview button').click();
        Array.from(document.querySelectorAll('.developer-settings label')).find(row => row.textContent === 'Show diagnostics').querySelector('input').click();
        document.querySelector('.developer-settings').scrollIntoView({ block: 'center' });
      })()`);
      await wait(700);
      fs.writeFileSync(process.env.YOURLYRICS_DEVELOPER_PREVIEW, (await win.webContents.capturePage()).toPNG());
      await js(`(() => { const version = document.querySelector('[data-action="version"]'); for (let i = 0; i < 8; i++) version.click(); document.querySelector('.alertview button').click(); })()`);
      await wait(750);
    }
    for (const [label, transform] of [
      ['UPPERCASE', 'uppercase'],
      ['lowercase', 'lowercase'],
      ['Original', 'none']
    ]) {
      await js(`Array.from(document.querySelectorAll('.sheet-row')).find(row => row.firstElementChild?.textContent === 'Lyric case').click()`);
      await until(`document.querySelector('.menuview')`);
      await js(`Array.from(document.querySelectorAll('.menuview__item')).find(item => item.textContent.trim() === ${JSON.stringify(label)}).click()`);
      await until(`getComputedStyle(document.querySelector('.lyrics-track')).textTransform === ${JSON.stringify(transform)}`);
      check(`lyrics settings apply ${label.toLowerCase()} text`, await js(
        `getComputedStyle(document.querySelector('.lyrics-track')).textTransform === ${JSON.stringify(transform)}`
      ));
    }
    await js(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await until(`!document.querySelector('.sheetview')`);
    check('playing state shows the AeroUI pause glyph', await js(`${button('toggle')}.querySelector('[data-icon="pause"]').classList.contains('is-current') && ${button('toggle')}.querySelectorAll('[data-icon="pause"] rect').length === 2`));
    await click('toggle');
    await until(`${button('toggle')}.getAttribute('aria-label') === 'Play' && !${button('toggle')}.disabled`);
    await wait(180);
    check('pointer pause sends exactly one native command', JSON.stringify(calls) === '["pause"]', calls.slice());
    check('confirmed pause updates artwork state too', await js(`document.body.classList.contains('is-paused')`));
    const pausedMutations = await js(`new Promise(resolve => {
      let count = 0;
      const observer = new MutationObserver(records => { count += records.length; });
      for (const selector of ['.progress', '.time-elapsed', '.time-remaining']) {
        observer.observe(document.querySelector(selector), {
          attributes: true, attributeFilter: ['aria-valuenow', 'aria-valuetext', 'aria-disabled', 'style', 'class'],
          childList: true, characterData: true, subtree: true
        });
      }
      setTimeout(() => { observer.disconnect(); resolve(count); }, 400);
    })`);
    check('paused progress and clocks perform no redundant DOM writes', pausedMutations === 0, { mutations: pausedMutations });
    await js(`${button('toggle')}.focus()`);
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
    await until(`${button('toggle')}.getAttribute('aria-label') === 'Pause' && !${button('toggle')}.disabled`);
    check('keyboard Enter resumes through the same IPC path', JSON.stringify(calls) === '["pause","play"]', calls.slice());
    const clockMutations = await js(`new Promise(resolve => {
      let textWrites = 0;
      let progressWrites = 0;
      const clocks = new MutationObserver(records => { textWrites += records.length; });
      for (const selector of ['.time-elapsed', '.time-remaining']) {
        clocks.observe(document.querySelector(selector), { childList: true, characterData: true, subtree: true });
      }
      const bar = new MutationObserver(records => { progressWrites += records.length; });
      bar.observe(document.querySelector('.progress'), { attributes: true, attributeFilter: ['style'] });
      setTimeout(() => {
        clocks.disconnect(); bar.disconnect(); resolve({ textWrites, progressWrites });
      }, 1100);
    })`);
    check('playing clocks change only at second boundaries while progress stays smooth',
      clockMutations.textWrites >= 2 && clockMutations.textWrites <= 6 && clockMutations.progressWrites > 10,
      clockMutations);
    await checkPlaybackClock();
    await click('previous');
    await until(`!${button('previous')}.disabled`);
    await click('next');
    await until(`!${button('next')}.disabled`);
    check('skip buttons dispatch previous and next once each', JSON.stringify(calls) === '["pause","play","previous","next"]', calls.slice());
    check('skip glyphs use a three-triangle handoff', await js(`document.querySelectorAll('.aero-skip-arrow').length === 6`));

    mode = 'pending';
    await click('next');
    await until(`document.querySelector('.playback-controls').getAttribute('aria-busy') === 'true'`);
    const pendingCount = calls.length;
    check('pending command disables all controls', await js(`Array.from(document.querySelectorAll('[data-playback]')).every(b => b.disabled)`));
    await js(`${button('previous')}.dispatchEvent(new CustomEvent('pressend', {bubbles:true}))`);
    check('pending command cannot be duplicated', calls.length === pendingCount);
    finishPending({ ok: true });
    await until(`!${button('next')}.disabled`);
    mode = 'failure';
    await click('toggle');
    await until(`document.querySelector('.lyrics-notice').textContent === 'Could not pause playback.'`);
    check('failure keeps the actual playing state and restores controls', await js(`!${button('toggle')}.disabled && ${button('toggle')}.getAttribute('aria-label') === 'Pause'`));
    mode = 'pending';
    await click('next');
    await until(`document.querySelector('.playback-controls').getAttribute('aria-busy') === 'true'`);
    media.setPlaybackHandler(null);
    await until(`document.querySelector('.playback-controls').getAttribute('aria-busy') === 'false'`);
    check('provider loss keeps controls disabled after pending work settles', await js(`Array.from(document.querySelectorAll('[data-playback]')).every(b => b.disabled)`));
    finishPending({ ok: true });
    mode = 'normal';
    media.setPlaybackHandler(handler);
    await until(`!${button('toggle')}.disabled`);

    const beforeCancel = calls.length;
    await js(`(() => { const b = ${button('next')}; b.dispatchEvent(new PointerEvent('pointerdown', {button:0, pointerId:7})); b.dispatchEvent(new PointerEvent('pointercancel', {pointerId:7})); })()`);
    await wait(100);
    check('cancelled press does not skip a track', calls.length === beforeCancel);

    await js(`${button('toggle')}.focus()`);
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' });
    await until(`${button('toggle')}.getAttribute('aria-label') === 'Play' && !${button('toggle')}.disabled`);
    check('keyboard Space also toggles playback', calls.at(-1) === 'pause');
    media.publishNowPlaying({ playing: true });
    await until(`${button('toggle')}.getAttribute('aria-label') === 'Pause'`);

    // Measure resting hit targets after AeroUI's 0.9s release spring, not
    // during its intentional pressed-scale animation.
    await wait(1000);

    for (const [width, height] of [[1080, 800], [560, 480], [1440, 1000]]) {
      win.setContentSize(width, height);
      await wait(120);
      const geometry = await js(`(() => {
        const p = document.querySelector('.progress').getBoundingClientRect();
        const g = document.querySelector('.playback-controls').getBoundingClientRect();
        const times = Array.from(document.querySelectorAll('.time')).map(e => e.getBoundingClientRect().bottom);
        const buttons = Array.from(document.querySelectorAll('[data-playback]')).map(e => {
          const r = e.getBoundingClientRect(); return {left:r.left, right:r.right, top:r.top, bottom:r.bottom, width:r.width, height:r.height};
        });
        return {top:g.top, bottom:g.bottom, left:g.left, right:g.right, center:g.x+g.width/2,
          progressCenter:p.x+p.width/2, progressBottom:p.bottom, timeBottom:Math.max(...times), buttons,
          labels:Array.from(document.querySelectorAll('[data-playback]')).map(b => b.getAttribute('aria-label'))};
      })()`);
      check(`${width}x${height}: controls centered below progress and times`,
        Math.abs(geometry.center - geometry.progressCenter) < 1 &&
        geometry.top > Math.max(geometry.progressBottom, geometry.timeBottom), geometry);
      check(`${width}x${height}: buttons stay visible with usable hit targets`,
        geometry.buttons.every(b => b.left >= 0 && b.right <= width && b.bottom <= height && b.width >= 43.9 && b.height >= 43.9) &&
        geometry.buttons[0].right <= geometry.buttons[1].left && geometry.buttons[1].right <= geometry.buttons[2].left);
    }
    win.setContentSize(1080, 800);
    await wait(950);
    if (process.env.PLAYBACK_CONTROLS_SCREENSHOT) {
      await until(`!document.querySelector('.lyrics-notice').classList.contains('is-visible')`);
      await wait(350);
      fs.writeFileSync(process.env.PLAYBACK_CONTROLS_SCREENSHOT, (await win.capturePage()).toPNG());
    }
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }]
    });
    const beforeReduced = calls.length;
    await click('previous');
    await until(`!${button('previous')}.disabled`);
    check('reduced motion retains button functionality', calls.length === beforeReduced + 1 && calls.at(-1) === 'previous');
    check('reduced motion avoids the skip sweep', await js(`${button('previous')}.querySelector('.aero-skip')._aeroSkip.animations.length === 0`));
    await js(`document.querySelector('.metadata-menu').dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }))`);
    await until(`document.querySelector('.menuview')`);
    await js(`Array.from(document.querySelectorAll('.menuview__item')).find(item => item.textContent.trim() === 'Settings').click()`);
    await until(`document.querySelector('.sheetview')`);
    await chooseUiStyle('tvOS');
    check('reduced motion keeps now-playing bars static', await js(`Array.from(document.querySelector('.now-playing-indicator').children).every(bar => bar.getAnimations().length === 0)`));
    check('reduced motion changes UI without scale or blur animations', await js(`document.querySelector('.stage').getAnimations().length === 0 && !document.querySelector('.stage').inert`));
    await lineSetting('Fade completed lines');
    check('completed-line opacity has one animation owner under reduced motion', await js(`(() => {
      const style = getComputedStyle(document.querySelector('.lyrics-line.is-completed'));
      return style.transitionProperty === 'none' && Number.isFinite(Number.parseFloat(style.getPropertyValue('--completed-opacity')));
    })()`));
    await wait(150);
    await win.reload();
    await until(`document.body.dataset.uiStyle === 'tvos' && document.body.hidden === false`);
    check('saved tvOS style is restored after reload without a switching animation', await js(`document.querySelector('.stage').getAnimations().length === 0 && !document.querySelector('.stage').inert`));
    check('completed-line fade preference survives reload', await js(`document.querySelector('.lyrics').classList.contains('is-fade-completed')`));
    check('UI test made no external or private-file requests', blocked.length === 0, blocked);
    check('renderer logged no errors', errors.length === 0, errors);
    media.setPlaybackHandler(null);
    for (const result of results) console.log(JSON.stringify(result));
    const failed = results.filter(result => !result.ok);
    console.log(`${results.length - failed.length} UI checks passed; ${failed.length} failed`);
    win.destroy();
    app.exit(failed.length ? 1 : 0);
  } finally {
    clearTimeout(deadline);
  }
}

if (process.versions.electron) {
  run().catch(error => { console.error(error); require('electron').app.exit(2); });
} else {
  const { spawnSync } = require('node:child_process');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'yourlyrics-controls-'));
  try {
    const env = { ...process.env, YOURLYRICS_CONTROLS_PROFILE: profile };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.NODE_OPTIONS;
    const result = spawnSync(require('electron'), [__filename], {
      env, stdio: 'inherit', timeout: 70000, killSignal: 'SIGKILL'
    });
    if (result.error) console.error(result.error);
    process.exitCode = result.status ?? 2;
  } finally {
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}
