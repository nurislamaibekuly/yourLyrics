'use strict';

// Pure semver-ish helpers for release tags like v1.2.3 or v0.1.0-beta.1.
// Kept free of Electron imports so they can be unit-tested under plain Node.

function parseVersion(raw) {
  const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?/.exec(String(raw || '').trim());
  if (!match) {
    return null;
  }
  return {
    numbers: [Number(match[1]), Number(match[2] || 0), Number(match[3] || 0)],
    prerelease: match[4] || null
  };
}

// Semver prerelease ordering: numeric identifiers compare numerically, and a
// plain release outranks any prerelease of the same base version.
function comparePrerelease(left, right) {
  const leftParts = left.split('.');
  const rightParts = right.split('.');
  for (let i = 0; i < Math.max(leftParts.length, rightParts.length); i++) {
    const a = leftParts[i];
    const b = rightParts[i];
    if (a === undefined) {
      return -1;
    }
    if (b === undefined) {
      return 1;
    }
    if (a === b) {
      continue;
    }
    const aNumeric = /^\d+$/.test(a);
    const bNumeric = /^\d+$/.test(b);
    if (aNumeric && bNumeric) {
      return Number(a) < Number(b) ? -1 : 1;
    }
    if (aNumeric) {
      return -1;
    }
    if (bNumeric) {
      return 1;
    }
    return a < b ? -1 : 1;
  }
  return 0;
}

function compareVersions(candidate, current) {
  const left = parseVersion(candidate);
  const right = parseVersion(current);
  if (!left || !right) {
    return 0;
  }
  for (let i = 0; i < 3; i++) {
    if (left.numbers[i] !== right.numbers[i]) {
      return left.numbers[i] - right.numbers[i];
    }
  }
  if (left.prerelease === right.prerelease) {
    return 0;
  }
  if (left.prerelease === null) {
    return 1;
  }
  if (right.prerelease === null) {
    return -1;
  }
  return comparePrerelease(left.prerelease, right.prerelease);
}

function isNewerVersion(candidate, current) {
  return compareVersions(candidate, current) > 0;
}

module.exports = { parseVersion, compareVersions, isNewerVersion };
