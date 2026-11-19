const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const source = fs.readFileSync(require('node:path').join(__dirname, '../src/renderer/player/style-preferences.js'), 'utf8');
const load = () => import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
test('legacy font size and blur migrate to both styles without sharing mutable settings', async () => {
  const { readStylePreferences } = await load();
  const profiles = readStylePreferences({ lyricsFontVh: 6, lineBlur: false });
  assert.deepEqual(profiles.macos, { textSize: 6, spacing: 1, lineBlur: false });
  profiles.tvos.textSize = 7;
  assert.equal(profiles.macos.textSize, 6);
});
test('separate saved preferences survive reload and invalid fields use safe defaults', async () => {
  const { readStylePreferences } = await load();
  const profiles = readStylePreferences({ stylePreferences: {
    macos: { textSize: 4, spacing: .8, lineBlur: false },
    tvos: { textSize: 7, spacing: 1.3, lineBlur: true }
  } });
  assert.deepEqual(readStylePreferences(JSON.parse(JSON.stringify({ stylePreferences: profiles }))), profiles);
  assert.deepEqual(readStylePreferences({ stylePreferences: { tvos: { textSize: 100, spacing: -1 } } }).tvos,
    { textSize: 8, spacing: .5, lineBlur: true });
});

test('iOS keeps the desktop lyric typography, including edits and reloads', async () => {
  const { readStylePreferences } = await load();
  const profiles = readStylePreferences({ lyricsFontVh: 8 });
  assert.equal(profiles.ios.textSize, 8);
  assert.equal(profiles.ios, profiles.macos);
  Object.assign(profiles.ios, { textSize: 4.2, spacing: .8, lineBlur: false });
  const restored = readStylePreferences({ stylePreferences: profiles });
  assert.deepEqual(restored.ios, profiles.ios);
  assert.equal(restored.macos.textSize, 4.2);
  assert.equal(restored.ios, restored.macos);
  restored.ios.spacing = 1.4;
  assert.equal(restored.tvos.spacing, 1);
  assert.equal(readStylePreferences({ stylePreferences: {
    macos: { textSize: 6 }, ios: { textSize: 3.8 }
  } }).ios.textSize, 6);
});
