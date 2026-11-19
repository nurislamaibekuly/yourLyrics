'use strict';

const assert = require('node:assert/strict');
const { spawn, execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

async function checkPackaged(executable, arch = process.arch, {
  timeout = 45000,
  spawnApp = spawn,
  softwareRendering = process.env.YOURLYRICS_SMOKE_SOFTWARE_GL === '1'
} = {}) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'yourlyrics-packaged-'));
  const env = { ...process.env, YOURLYRICS_SMOKE_PROFILE: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  let output = '';
  try {
    await new Promise((resolve, reject) => {
      // Hosted runners can lack a WebGL-capable GPU. This opt-in applies only
      // to the isolated startup check, whose page blocks external content.
      const args = softwareRendering
        ? ['--use-gl=angle', '--use-angle=swiftshader-webgl', '--enable-unsafe-swiftshader', '--smoke-test']
        : ['--smoke-test'];
      const child = spawnApp(path.resolve(executable), args, {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        detached: process.platform !== 'win32'
      });
      let timedOut = false;
      const deadline = setTimeout(() => {
        timedOut = true;
        // Kill only the test's process tree, including a stuck renderer. A
        // hung startup must fail the release instead of leaving CI waiting.
        if (!Number.isInteger(child.pid)) {
          child.kill('SIGKILL');
        } else if (process.platform === 'win32') {
          execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => {});
        } else {
          try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
        }
      }, timeout);
      const capture = chunk => { output = (output + chunk.toString()).slice(-65536); };
      child.stdout?.on('data', capture);
      child.stderr?.on('data', capture);
      child.once('error', error => { clearTimeout(deadline); reject(error); });
      child.once('close', (code, signal) => {
        clearTimeout(deadline);
        if (timedOut) return reject(new Error('Packaged startup timed out'));
        if (code !== 0) {
          let detail = '';
          try { detail = JSON.parse(fs.readFileSync(path.join(profile, 'result.json'), 'utf8')).error || ''; } catch {}
          return reject(new Error(`Packaged app exited with ${signal || code}${detail ? `: ${detail}` : ''}`));
        }
        resolve();
      });
    });

    // An exit code alone can accept an app that exits before its entry point
    // runs. Require proof from the packaged main process and renderer too.
    const report = JSON.parse(fs.readFileSync(path.join(profile, 'result.json'), 'utf8'));
    assert.equal(report.ok, true, report.error || 'Packaged startup failed');
    assert.equal(report.packaged, true, 'The check must run the packaged application');
    assert.equal(report.platform, process.platform, 'Packaged platform does not match the runner');
    assert.equal(report.arch, arch, 'Packaged architecture does not match the release target');
    assert.equal(report.electron, require('electron/package.json').version, 'Packaged Electron version does not match the bytecode compiler');
    assert.equal(report.version, require('../package.json').version, 'Packaged version does not match this release');
    assert.equal(report.checks?.preload, true, 'Preload did not start');
    assert.equal(report.checks?.renderer, true, 'Renderer did not start');
    assert.equal(report.checks?.ipc, true, 'Preload IPC did not work');
    assert.ok(['animated', 'fallback'].includes(report.checks?.backdrop), 'Backdrop startup state was not reported');
    return report;
  } catch (error) {
    if (output) error.message += `\n${output}`;
    throw error;
  } finally {
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

module.exports = { checkPackaged };

if (require.main === module) {
  const [executable, arch] = process.argv.slice(2);
  if (!executable) {
    console.error('Usage: npm run test:packaged -- <packaged executable> [architecture]');
    process.exitCode = 1;
  } else {
    checkPackaged(executable, arch).then(report => {
      console.log(`Packaged startup passed: ${report.platform}/${report.arch}, Electron ${report.electron}, version ${report.version}, backdrop ${report.checks.backdrop}.`);
    }).catch(error => {
      console.error(error);
      process.exitCode = 1;
    });
  }
}
