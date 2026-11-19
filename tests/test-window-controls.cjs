const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repo = path.resolve(__dirname, '..');
const htmlSource = fs.readFileSync(path.join(repo, 'src/renderer/index.html'), 'utf8');
const cssSource = fs.readFileSync(path.join(repo, 'src/renderer/styles/styles.css'), 'utf8');
const mainSource = fs.readFileSync(path.join(repo, 'src/main/index.js'), 'utf8');
const preloadSource = fs.readFileSync(path.join(repo, 'src/preload/index.js'), 'utf8');
const rendererSource = fs.readFileSync(path.join(repo, 'src/renderer/renderer.js'), 'utf8');

test('index.html contains close, minimize, maximize, and pin window controls', () => {
  assert.ok(htmlSource.includes('class="window-controls"'), 'window-controls container present');
  assert.ok(htmlSource.includes('data-window-action="close"'), 'close button present');
  assert.ok(htmlSource.includes('data-window-action="minimize"'), 'minimize button present');
  assert.ok(htmlSource.includes('data-window-action="maximize"'), 'maximize button present');
  assert.ok(htmlSource.includes('data-window-action="pin"'), 'pin button present');
  assert.ok(htmlSource.includes('window-control--pin'), 'window-control--pin class present');
});

test('styles.css hides traffic lights by default and reveals them when hovered or focused', () => {
  // Check default opacity is 0 and pointer-events is none
  const defaultControl = cssSource.match(/\.window-control\s*\{([^}]+)\}/);
  assert.ok(defaultControl, '.window-control rule found in styles.css');
  assert.match(defaultControl[1], /opacity:\s*0/, 'traffic lights default to opacity: 0');
  assert.match(defaultControl[1], /pointer-events:\s*none/, 'hidden traffic lights ignore pointer events');

  // Check hover and focus reveal rules
  assert.ok(
    cssSource.includes('.window-controls:hover .window-control'),
    'hovering window-controls reveals the buttons'
  );
  assert.ok(
    cssSource.includes('.window-controls:focus-within .window-control'),
    'keyboard focus reveals the buttons'
  );
  assert.ok(
    cssSource.includes('.window-controls.is-hovered .window-control'),
    'pointerenter hover class reveals the buttons'
  );
  assert.ok(
    cssSource.includes('.window-controls:hover .window-control::after'),
    'hovering reveals button symbols'
  );
});

test('styles.css styles the pin button and active/pinned state', () => {
  assert.ok(cssSource.includes('.window-control--pin'), 'pin button rule present');
  assert.ok(
    cssSource.includes('window-pin.png'),
    'window-pin icon mapped to --window-symbol'
  );
  assert.ok(
    cssSource.includes('body.is-window-pinned .window-control--pin') ||
    cssSource.includes('.window-control--pin.is-active'),
    'pinned active accent state defined'
  );
  assert.ok(
    fs.existsSync(path.join(repo, 'assets/icons/window-pin.png')),
    'assets/icons/window-pin.png file exists on disk'
  );
});

test('main process hides native macOS buttons and registers pin IPC', () => {
  assert.ok(
    mainSource.includes('win.setWindowButtonVisibility(false)'),
    'native macOS titlebar buttons hidden in favor of custom controls'
  );
  assert.ok(
    mainSource.includes("ipcMain.handle('window:toggle-pin'"),
    'window:toggle-pin IPC handler registered'
  );
  assert.ok(
    mainSource.includes("ipcMain.handle('window:set-always-on-top'"),
    'window:set-always-on-top IPC handler registered'
  );
  assert.ok(
    mainSource.includes("ipcMain.handle('window:is-pinned'"),
    'window:is-pinned IPC handler registered'
  );
  assert.ok(
    mainSource.includes('alwaysOnTop: win.isAlwaysOnTop()'),
    'alwaysOnTop state broadcast to renderer'
  );
});

test('preload exposes always-on-top and pin APIs', () => {
  assert.ok(preloadSource.includes('isAlwaysOnTop:'), 'preload exposes isAlwaysOnTop');
  assert.ok(preloadSource.includes('setAlwaysOnTop:'), 'preload exposes setAlwaysOnTop');
  assert.ok(preloadSource.includes('togglePin:'), 'preload exposes togglePin');
  assert.ok(preloadSource.includes('onAlwaysOnTopChange:'), 'preload exposes onAlwaysOnTopChange');
  assert.ok(preloadSource.includes('alwaysOnTop: result?.alwaysOnTop === true'), 'getState returns alwaysOnTop');
});

test('renderer unhides window controls across all platforms and handles pin toggles', () => {
  // Confirm darwin is no longer excluded
  assert.ok(
    !rendererSource.includes("window.app.platform === 'darwin'"),
    'darwin platform no longer excludes custom window controls'
  );
  assert.ok(
    rendererSource.includes("querySelector('[data-window-action=\"pin\"]')"),
    'renderer queries and wires the pin button'
  );
  assert.ok(
    rendererSource.includes("controls.classList.add('is-hovered')"),
    'pointerenter adds is-hovered class'
  );
  assert.ok(
    rendererSource.includes("controls.classList.remove('is-hovered')"),
    'pointerleave removes is-hovered class'
  );
  assert.ok(
    rendererSource.includes('is-window-pinned'),
    'renderer manages is-window-pinned state class'
  );
  assert.ok(
    rendererSource.includes('Pin window (Always on Top)'),
    'Settings includes Pin window toggle'
  );
  assert.ok(
    mainSource.includes("ipcMain.handle('window:set-ui-scale'") &&
    mainSource.includes('setZoomFactor'),
    'main process registers window:set-ui-scale and applies zoom factor'
  );
  assert.ok(
    preloadSource.includes('setUiScale:') && preloadSource.includes('getUiScale:'),
    'preload exposes setUiScale and getUiScale'
  );
  assert.ok(
    rendererSource.includes("sheetMenuRow('UI scale'"),
    'Settings includes UI scale selector'
  );
});
