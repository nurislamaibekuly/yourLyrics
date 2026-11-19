const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');
const { createArtworkDecoder } = require('../src/main/media/player-artwork');
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]);
const tiff = Buffer.from('II*\x00native-artwork').toString('base64');
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

test('supported native images pass through without conversion', () => {
  const decode = createArtworkDecoder({ convert: () => assert.fail('Unnecessary conversion') });
  assert.equal(decode(png.toString('base64')).url, `data:image/png;base64,${png.toString('base64')}`);
  assert.equal(decode(Buffer.from([255, 216, 255, 224]).toString('base64')).pending, false);
  assert.equal(decode('not-an-image').url, '');
});

test('repeated timeline updates share one pending conversion and its result', async () => {
  let finish, conversions = 0, notifications = 0;
  const decode = createArtworkDecoder({
    convert: () => { conversions++; return new Promise(resolve => { finish = resolve; }); },
    onReady: value => { assert.equal(value, tiff); notifications++; }
  });
  const first = decode(tiff);
  assert.equal(first.pending, true);
  for (let i = 0; i < 50; i++) assert.equal(decode(tiff), first);
  await flush();
  assert.equal(conversions, 1);
  finish('data:image/png;base64,converted');
  await flush();
  assert.equal(decode(tiff).url, 'data:image/png;base64,converted');
  assert.equal(first.pending, false);
  assert.equal(notifications, 1);
});

test('macOS conversion uses sips once with literal paths and removes temporary files', async () => {
  const module = { exports: {} };
  let calls = 0, temporaryDirectory;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/main/media/player-artwork.js'), 'utf8'), {
    module, Buffer, process: { platform: 'darwin' }, console,
    require(name) {
      if (name !== 'node:child_process') return require(name);
      return { execFile(executable, args, options, callback) {
        calls++;
        assert.equal(executable, '/usr/bin/sips');
        assert.equal(options.shell, undefined);
        assert.equal(options.timeout, 10000);
        temporaryDirectory = path.dirname(args.at(-1));
        fsp.writeFile(args.at(-1), png).then(() => callback(null), callback);
      } };
    }
  });
  let ready;
  const complete = new Promise(resolve => { ready = resolve; });
  const decode = module.exports.createArtworkDecoder({ onReady: ready });
  decode(tiff);
  await complete;
  assert.equal(decode(tiff).url, `data:image/png;base64,${png.toString('base64')}`);
  assert.equal(calls, 1);
  assert.equal(fs.existsSync(temporaryDirectory), false);
});
