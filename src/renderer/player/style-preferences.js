const clamp = (value, low, high, fallback) => Number.isFinite(value) ? Math.min(high, Math.max(low, value)) : fallback;
export function readStylePreferences(saved = {}) {
  const profiles = {};
  for (const style of ['macos', 'tvos']) {
    const profile = saved.stylePreferences?.[style] || {};
    profiles[style] = {
      textSize: clamp(profile.textSize, 3.5, 8, clamp(saved.lyricsFontVh, 3.5, 8, 5.83)),
      spacing: clamp(profile.spacing, .5, 1.8, 1),
      lineBlur: typeof profile.lineBlur === 'boolean' ? profile.lineBlur : saved.lineBlur !== false
    };
  }
  // Portrait changes the player layout, while lyric typography remains the
  // user's desktop choice. Share the object so edits in either view stay in sync.
  profiles.ios = profiles.macos;
  profiles.ipados = profiles.macos;
  return profiles;
}
