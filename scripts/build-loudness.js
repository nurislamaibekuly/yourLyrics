'use strict';

// Compiles vendor/loudness-tap into vendor/loudness-tap/build/loudness-tap.
//
// A plain clang++ invocation rather than a package manager's toolchain: the
// helper is one Objective-C++ file plus four system frameworks, and adding
// node-gyp for that would be a build system in search of a job. The binary is
// stale-checked against its sources, so `npm start` only pays for a compile
// when the capture code actually changed.

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const sourceDir = path.join(root, 'vendor', 'loudness-tap');
const outputDir = path.join(sourceDir, 'build');
const outputPath = path.join(outputDir, 'loudness-tap');
const addonOutputPath = path.join(outputDir, 'loudness-tap.node');

const sources = ['main.mm'].map((name) => path.join(sourceDir, name));

// The tap API itself arrives in 14.2; building for anything older would need
// availability guards around every call for a machine that could not use them.
const deploymentTarget = '14.2';

const frameworks = [
  'Foundation',
  'AppKit',
  'CoreAudio',
  'Accelerate'
].flatMap((name) => ['-framework', name]);

function isStale(targetPath) {
  let built;
  try {
    built = fs.statSync(targetPath).mtimeMs;
  } catch {
    return true;
  }
  const dependencies = [...sources, path.join(root, 'vendor/loudness-common/analyzer.h')];
  return dependencies.some((source) => fs.statSync(source).mtimeMs > built);
}

// A universal package needs a helper that carries both slices: the file is
// spawned, never loaded by Electron, so nothing about its fat-ness is checked
// at load time -- and a single-slice helper in a universal app would fail to
// launch on whichever half of the machine it was not built for.
function hasAllArchitectures(targetPath, required) {
  const probe = spawnSync('lipo', ['-archs', targetPath], { encoding: 'utf8' });
  if (probe.error || probe.status !== 0) {
    return false;
  }
  const present = new Set(probe.stdout.split(/\s+/).filter(Boolean));
  return required.every((arch) => present.has(arch));
}

function findNodeIncludeDir() {
  const candidates = [
    path.resolve(path.dirname(process.execPath), '..', 'include', 'node'),
    '/opt/homebrew/include/node',
    '/usr/local/include/node'
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'node_api.h'))) {
      return dir;
    }
  }
  throw new Error('loudness-tap: node_api.h not found');
}

function compileBinary({ targetPath, architectures, extraArgs = [], mode = 0o755 }) {
  const args = [
    '-std=c++20',
    '-fobjc-arc',
    '-O2',
    '-Wall',
    `-mmacosx-version-min=${deploymentTarget}`,
    ...architectures.flatMap((arch) => ['-arch', arch]),
    ...extraArgs,
    ...sources,
    '-o',
    targetPath,
    ...frameworks
  ];
  const result = spawnSync('clang++', args, { stdio: 'inherit' });
  if (result.error) {
    throw new Error(`loudness-tap: clang++ unavailable: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error('loudness-tap: build failed');
  }
  fs.chmodSync(targetPath, mode);
}

function buildLoudnessTap({ force = false, universal = false } = {}) {
  if (process.platform !== 'darwin') {
    // Loudness capture is macOS-only; Windows has no provider in the native
    // app either, and the parent skips the whole pipeline there.
    return null;
  }
  const architectures = universal ? ['arm64', 'x86_64'] : [];
  const binaryNeedsBuild =
    force ||
    isStale(outputPath) ||
    (architectures.length > 0 && !hasAllArchitectures(outputPath, architectures));
  const addonNeedsBuild =
    force ||
    isStale(addonOutputPath) ||
    (architectures.length > 0 && !hasAllArchitectures(addonOutputPath, architectures));

  if (!binaryNeedsBuild && !addonNeedsBuild) {
    return outputPath;
  }

  fs.mkdirSync(outputDir, { recursive: true });
  if (binaryNeedsBuild) {
    compileBinary({ targetPath: outputPath, architectures });
  }
  if (addonNeedsBuild) {
    const nodeIncludeDir = findNodeIncludeDir();
    compileBinary({
      targetPath: addonOutputPath,
      architectures,
      extraArgs: [
        '-DLOUDNESS_TAP_ADDON',
        '-DNODE_GYP_MODULE_NAME=loudness_tap',
        `-I${nodeIncludeDir}`,
        '-bundle',
        '-undefined',
        'dynamic_lookup'
      ],
      mode: 0o755
    });
  }
  return outputPath;
}

if (require.main === module) {
  try {
    const force = process.argv.includes('--force');
    const universal = process.argv.includes('--universal');
    const output = buildLoudnessTap({ force, universal });
    console.log(output ? `loudness-tap: ${output}` : 'loudness-tap: not built on this platform');
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

module.exports = { buildLoudnessTap };
