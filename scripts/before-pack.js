'use strict';

const { buildLoudnessTap } = require('./build-loudness');

// The loudness helper lives outside the asar and is spawned as a binary, so it
// is built here before electron-builder copies files into app.asar. A universal
// target needs both slices (see build-loudness.js); off macOS this is a no-op.
module.exports = async function beforePack() {
  buildLoudnessTap({ universal: true });
};
