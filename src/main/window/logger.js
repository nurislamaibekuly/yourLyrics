const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const util = require('node:util');

const maxLogBytes = 2 * 1024 * 1024;
const levels = [
  ['log', 'INFO'],
  ['info', 'INFO'],
  ['warn', 'WARN'],
  ['error', 'ERROR'],
  ['debug', 'DEBUG']
];

function createLogger(options = {}) {
  const maxBytes = Number.isFinite(options.maxBytes) && options.maxBytes > 0
    ? options.maxBytes
    : maxLogBytes;
  let logFilePath = '';
  let logDirPath = '';
  let stream = null;
  let installed = false;
  let readyPromise = null;
  const pendingLines = [];
  const originals = {};

  function formatLine(level, source, args) {
    const timestamp = new Date().toISOString();
    const message = util.format(...args);
    const prefix = source ? `[${timestamp}] [${level}] [${source}]` : `[${timestamp}] [${level}]`;
    return `${prefix} ${message}\n`;
  }

  function writeRaw(line) {
    if (!logFilePath) {
      return;
    }
    if (!stream) {
      // Buffer lines emitted while the log directory and rotation check finish.
      pendingLines.push(line);
      return;
    }
    try {
      stream.write(line);
    } catch {
      // Logging must never crash the app if the disk becomes unavailable.
    }
  }

  async function openStream() {
    try {
      await fsp.mkdir(logDirPath, { recursive: true });
      try {
        const stats = await fsp.stat(logFilePath);
        if (stats.size >= maxBytes) {
          const rotatedPath = path.join(logDirPath, 'yourlyrics.prev.log');
          await fsp.rename(logFilePath, rotatedPath);
        }
      } catch {
        // Missing or unrotatable prior log simply starts a fresh file.
      }
      stream = fs.createWriteStream(logFilePath, { flags: 'a', encoding: 'utf8' });
      stream.on('error', () => {
        stream = null;
      });
      while (pendingLines.length > 0 && stream) {
        stream.write(pendingLines.shift());
      }
    } catch {
      pendingLines.length = 0;
    }
  }

  function init(app) {
    if (installed) {
      return readyPromise;
    }
    installed = true;

    const userData = typeof app?.getPath === 'function' ? app.getPath('userData') : '';
    if (!userData) {
      return Promise.resolve();
    }

    logDirPath = path.join(userData, 'logs');
    logFilePath = path.join(logDirPath, 'yourlyrics.log');

    for (const [method, label] of levels) {
      originals[method] = console[method].bind(console);
      console[method] = (...args) => {
        writeRaw(formatLine(label, 'main', args));
        originals[method](...args);
      };
    }

    process.on('uncaughtException', (error) => {
      writeRaw(formatLine('FATAL', 'main', [error?.stack || error]));
      originals.error?.(error);
    });
    process.on('unhandledRejection', (reason) => {
      writeRaw(formatLine('ERROR', 'main', ['Unhandled rejection:', reason?.stack || reason]));
    });

    const version = typeof app?.getVersion === 'function' ? app.getVersion() : 'unknown';
    writeRaw(formatLine('INFO', 'main', [`yourLyrics ${version} (${process.platform} ${process.arch})`]));
    readyPromise = openStream();
    return readyPromise;
  }

  function attachWindow(win) {
    if (!win?.webContents) {
      return;
    }
    const levelNames = ['DEBUG', 'INFO', 'WARN', 'ERROR'];
    win.webContents.on('console-message', (event, level, message, line, sourceId) => {
      // Support both Electron's legacy positional arguments and the newer
      // single-event-object payload.
      const resolvedMessage = message !== undefined ? message : event?.message;
      const resolvedLevel = level !== undefined ? level : event?.level;
      const resolvedLine = line !== undefined ? line : event?.lineNumber;
      const resolvedSource = sourceId !== undefined ? sourceId : event?.sourceId;
      const label = typeof resolvedLevel === 'string'
        ? resolvedLevel.toUpperCase()
        : (levelNames[resolvedLevel] || 'INFO');
      const location = resolvedSource ? ` (${path.basename(resolvedSource)}:${resolvedLine ?? 0})` : '';
      writeRaw(formatLine(label, 'renderer', [`${resolvedMessage}${location}`]));
    });
    win.webContents.on('render-process-gone', (_event, details) => {
      writeRaw(formatLine('ERROR', 'renderer', ['Render process gone:', details?.reason || 'unknown']));
    });
  }

  async function flush() {
    if (readyPromise) {
      await readyPromise;
    }
    if (!stream) {
      return;
    }
    const active = stream;
    stream = null;
    await new Promise((resolve) => {
      active.end(resolve);
    });
  }

  function getLogPath() {
    return logFilePath;
  }

  return {
    init,
    attachWindow,
    flush,
    getLogPath
  };
}

const defaultLogger = createLogger();

module.exports = {
  createLogger,
  initLogger: defaultLogger.init,
  attachWindowLogs: defaultLogger.attachWindow,
  flushLogs: defaultLogger.flush,
  getLogPath: defaultLogger.getLogPath
};
