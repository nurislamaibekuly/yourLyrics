'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');

// Keep Electron and electron-builder downloads in a project-local cache so
// repeated builds reuse them instead of re-downloading. Explicit env values
// still win.
const cacheRoot = path.resolve(__dirname, '..', '.cache');
const env = {
  ...process.env,
  ELECTRON_CACHE: process.env.ELECTRON_CACHE || path.join(cacheRoot, 'electron'),
  ELECTRON_BUILDER_CACHE:
    process.env.ELECTRON_BUILDER_CACHE || path.join(cacheRoot, 'electron-builder')
};

const bin = require.resolve('electron-builder/cli.js');
const result = spawnSync(process.execPath, [bin, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env
});
process.exit(result.status ?? 1);
