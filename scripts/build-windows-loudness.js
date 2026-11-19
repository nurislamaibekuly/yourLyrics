'use strict';

// Compiles vendor/windows-loudness into vendor/windows-loudness/build/loudness-tap.exe.
//
// Windows counterpart of scripts/build-loudness.js: one C++ file plus the
// WASAPI/COM libraries, no build system. MSVC is located through vswhere (or
// an already-provisioned cl on PATH, which is how CI's dev shell and an
// interactive "x64 Native Tools" prompt both present it), and the binary is
// stale-checked against its sources.

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const sourceDir = path.join(root, 'vendor', 'windows-loudness');
const outputDir = path.join(sourceDir, 'build');
const outputPath = path.join(outputDir, 'loudness-tap.exe');

const sources = ['main.cpp'].map((name) => path.join(sourceDir, name));

function isStale() {
  let built;
  try {
    built = fs.statSync(outputPath).mtimeMs;
  } catch {
    return true;
  }
  const dependencies = [...sources, path.join(root, 'vendor/loudness-common/analyzer.h')];
  return dependencies.some((source) => fs.statSync(source).mtimeMs > built);
}

function findVsWhere() {
  const local = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const candidate = path.join(local, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
  return fs.existsSync(candidate) ? candidate : null;
}

// Locate the newest VS install that carries the x64 C++ toolset. Returns the
// install path, or null when vswhere is absent / nothing matches.
function findVsInstall() {
  const vswhere = findVsWhere();
  if (!vswhere) {
    return null;
  }
  const probe = spawnSync(
    vswhere,
    [
      '-latest',
      '-products', '*',
      '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
      '-property', 'installationPath'
    ],
    { encoding: 'utf8' }
  );
  if (probe.status !== 0) {
    return null;
  }
  const install = probe.stdout.trim();
  return install || null;
}

function findMingw() {
  const candidates = [
    process.env.CXX,
    'g++',
    ...['ucrt64', 'mingw64'].map((prefix) =>
      path.join(process.env.SystemDrive || 'C:', 'msys64', prefix, 'bin', 'g++.exe'))
  ].filter(Boolean);
  for (const compiler of candidates) {
    const env = { ...process.env };
    if (path.isAbsolute(compiler)) {
      env.PATH = `${path.dirname(compiler)}${path.delimiter}${env.PATH || ''}`;
    }
    const probe = spawnSync(compiler, ['-dumpmachine'], { encoding: 'utf8', env });
    // MSYS/Cygwin g++ produces executables requiring its POSIX runtime.
    if (probe.status === 0 && /x86_64-w64-mingw32/.test(probe.stdout)) {
      return { compiler, env };
    }
  }
  return null;
}

function compile() {
  const vsInstall = findVsInstall();
  const clProbe = vsInstall ? null : spawnSync('cl', [], { stdio: 'ignore' });
  if (!vsInstall && clProbe.error) {
    const mingw = findMingw();
    if (!mingw) {
      throw new Error('loudness-tap (win): install MSVC C++ tools or MinGW-w64 g++');
    }
    const result = spawnSync(mingw.compiler, [
      '-std=c++17', '-O2', '-Wall', '-DUNICODE', '-D_UNICODE',
      ...sources, '-o', outputPath,
      // Ship a standalone helper without MinGW runtime DLL dependencies.
      '-static', '-lole32', '-luuid'
    ], { stdio: 'inherit', env: mingw.env });
    if (result.error || result.status !== 0) {
      throw new Error(`loudness-tap (win): MinGW build failed${result.error ? `: ${result.error.message}` : ''}`);
    }
    return;
  }
  const vcvars = 'vcvars64.bat';
  const flags =
    '/nologo /std:c++17 /O2 /W4 /EHsc /DUNICODE /D_UNICODE ' +
    sources.map((s) => `"${s}"`).join(' ') +
    // Forward slash on /Fo: a trailing backslash inside quotes escapes the
    // closing quote under MSVC's argv parsing.
    ` /Fo"${outputDir}/" /link /OUT:"${outputPath}" ole32.lib uuid.lib`;
  // Run through the VS developer environment: cl is not on a plain shell's
  // PATH, but every CI/dev-machine install exposes it via vcvars64.bat.
  const command = vsInstall
    ? `call "${path.join(vsInstall, 'VC\\Auxiliary\\Build', vcvars)}" && cl ${flags}`
    : `cl ${flags}`;
  const result = spawnSync(command, {
    shell: true,
    stdio: 'inherit',
    windowsVerbatimArguments: false
  });
  if (result.error) {
    throw new Error(`loudness-tap (win): compiler unavailable: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error('loudness-tap (win): build failed');
  }
}

function buildLoudnessTapWin({ force = false } = {}) {
  if (process.platform !== 'win32') {
    return null;
  }
  if (!force && !isStale()) {
    return outputPath;
  }
  fs.mkdirSync(outputDir, { recursive: true });
  compile();
  return outputPath;
}

if (require.main === module) {
  try {
    const force = process.argv.includes('--force');
    const output = buildLoudnessTapWin({ force });
    console.log(
      output
        ? `loudness-tap (win): ${output}`
        : 'loudness-tap (win): not built on this platform'
    );
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

module.exports = { buildLoudnessTapWin };
