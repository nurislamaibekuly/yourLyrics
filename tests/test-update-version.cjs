'use strict';

// Version comparison for release tags, no Electron required.
const { parseVersion, compareVersions, isNewerVersion } = require('../src/main/updates/update-version');

const checks = [];
const check = (name, ok, details) => checks.push({ name, ok: Boolean(ok), details });

check('plain patch ordering', isNewerVersion('1.0.1', '1.0.0') && !isNewerVersion('1.0.0', '1.0.1'));
check('minor outranks patch', isNewerVersion('1.1.0', '1.0.9'));
check('major outranks minor', isNewerVersion('2.0.0', '1.9.9'));
check('equal versions are not newer', !isNewerVersion('1.0.0', '1.0.0'));
check('v prefix is accepted', isNewerVersion('v1.0.1', '1.0.0') && isNewerVersion('1.0.1', 'v1.0.0'));
check('short versions compare as zero-padded', isNewerVersion('1.0.1', '1.0') && !isNewerVersion('1.0', '1.0.0'));
check('unparseable versions never trigger', !isNewerVersion('latest', '1.0.0') && !isNewerVersion('', '1.0.0'));

// The shipped releases use tags like v0.1.0-beta.1.
check('beta is older than its release', isNewerVersion('0.1.0', '0.1.0-beta.1') && !isNewerVersion('0.1.0-beta.1', '0.1.0'));
check('beta is newer than the previous base', isNewerVersion('0.2.0-beta.1', '0.1.0'));
check('beta compares numerically, not lexically',
  isNewerVersion('0.1.0-beta.10', '0.1.0-beta.2') && !isNewerVersion('0.1.0-beta.2', '0.1.0-beta.10'));
check('numeric identifiers outrank alphanumeric',
  compareVersions('0.1.0-beta.2', '0.1.0-beta.alpha') < 0);
check('longer prerelease outranks prefix', compareVersions('0.1.0-beta.1.1', '0.1.0-beta.1') > 0);
check('parse keeps prerelease intact',
  parseVersion('v0.1.0-beta.1')?.prerelease === 'beta.1' &&
  parseVersion('v0.1.0-beta.1')?.numbers.join('.') === '0.1.0');
check('real release tag compares below package version',
  !isNewerVersion('0.1.0-beta.1', '1.0.0') && isNewerVersion('1.0.0', '0.1.0-beta.1'));

const failed = checks.filter(entry => !entry.ok);
for (const entry of checks) {
  console.log(JSON.stringify({ name: entry.name, ok: entry.ok, details: entry.details }));
}
console.log(`${checks.length - failed.length} passed; ${failed.length} failed`);
process.exitCode = failed.length === 0 ? 0 : 1;
