'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function run() {
  const { app, BrowserWindow } = require('electron');
  app.setPath('userData', process.env.HELLO_SETUP_PROFILE);
  await app.whenReady();
  const win = new BrowserWindow({ show: false, width: 800, height: 650,
    webPreferences: { sandbox: true, backgroundThrottling: false } });
  const js = source => win.webContents.executeJavaScript(source);
  const url = file => pathToFileURL(path.resolve(__dirname, '../src/renderer', file)).href;
  try {
    const fixture = path.join(process.env.HELLO_SETUP_PROFILE, 'fixture.html');
    fs.writeFileSync(fixture, `<!doctype html><link rel="stylesheet" href="${url('ui/hello-screen.css')}">
      <style>body{margin:0;font-family:system-ui;background:radial-gradient(ellipse at 10% 90%,#9c796e,transparent 65%),radial-gradient(ellipse at 90% 10%,#5c598b,transparent 70%),#242333}#app{position:fixed;inset:0}</style><div id="app"></div>`);
    await win.loadFile(fixture);
    await js(`(async () => {
      const { createSetupFlow } = await import(${JSON.stringify(url('ui/setup-flow.js'))});
      window.results = [];
      window.flow = createSetupFlow({ initialSettings: {uiStyle:'macos',theme:'system'}, onComplete: value => results.push(value) });
      document.querySelector('#app').append(flow.element); flow.focus();
    })()`);
    assert.equal(await js('document.activeElement.id'), 'hello-setup-title');
    assert.equal(await js('document.querySelectorAll("input").length'), 4);
    const click = async selector => {
      await js(`document.querySelector(${JSON.stringify(selector)}).click()`);
      await js(`new Promise(resolve => {
        const check=()=>document.querySelector('.hello-setup')?.dataset.transitioning==='true'
          ?requestAnimationFrame(check):resolve(); check();
      })`);
    };
    const screenshot = async name => {
      if (!process.env.HELLO_SETUP_SCREENSHOTS) return;
      await js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      fs.writeFileSync(`/tmp/hello-setup-${name}.png`, (await win.webContents.capturePage()).toPNG());
    };
    const next = () => click('.hello-setup__next');
    const back = () => click('.hello-setup__back');
    const fits = () => js(`(() => {
      const rect=document.querySelector('.hello-setup__panel').getBoundingClientRect();
      return rect.top >= 0 && rect.bottom <= innerHeight && rect.left >= 0 && rect.right <= innerWidth;
    })()`);
    await new Promise(resolve => setTimeout(resolve, 450));
    assert.equal(await fits(), true, 'Interface choices fit the minimum desktop window');
    await screenshot('interface');
    await click('input[value="ipados"]');
    await next();
    assert.equal(await js('document.querySelector("input:checked").value'), 'system');
    await click('input[value="dark"]');
    await screenshot('theme');
    await back();
    assert.equal(await js('document.querySelector("input:checked").value'), 'ipados');
    await next();
    assert.equal(await js('document.querySelector("input:checked").value'), 'dark');
    await next();
    assert.equal(await js('results.length'), 0, 'Continue never completes setup early');
    await click('input[value="true"]');
    assert.equal(await fits(), true);
    await screenshot('effects');
    await back(); await next();
    assert.equal(await js('document.querySelector("input:checked").value'), 'true');
    await next(); await next();
    assert.deepEqual(await js('results'), [{uiStyle:'ipados',theme:'dark',disableSolarium:true}]);

    // Compact windows retain reachable choices and navigation on every step.
    win.setContentSize(360, 640);
    await js(`(() => {
      flow.destroy();
      document.querySelector('#app').replaceChildren();
    })()`);
    await js(`(async () => {
      const {createSetupFlow}=await import(${JSON.stringify(url('ui/setup-flow.js'))});
      window.small=createSetupFlow({initialSettings:{uiStyle:'ios'}});
      document.querySelector('#app').append(small.element);
    })()`);
    await new Promise(resolve => setTimeout(resolve, 450));
    for (let step=0;step<3;step++) {
      const reachable = await js(`(() => {
        const panel=document.querySelector('.hello-setup__panel').getBoundingClientRect();
        const scroller=document.querySelector('.hello-setup');
        const button=document.querySelector('.hello-setup__next');
        button.scrollIntoView({block:'nearest'});
        const bounds=button.getBoundingClientRect();
        const result=panel.left>=0 && panel.right<=innerWidth && bounds.top>=0 && bounds.bottom<=innerHeight;
        scroller.scrollTop=0;
        return result;
      })()`);
      assert.equal(reachable,true,'Setup navigation remains reachable in a compact window');
      if (step<2) await next();
    }
    win.setContentSize(800, 622);

    // Exercise the real Hello handoff, focus containment and native Space key.
    await js(`(async () => {
      small.destroy();
      document.querySelector('#app').replaceChildren();
      const {createHelloScreen} = await import(${JSON.stringify(url('ui/hello-screen.js'))});
      window.saved=[];window.dismissals=0;
      window.hello=createHelloScreen({onSetupComplete:value=>saved.push(value),onDismiss:()=>dismissals++});
      await hello.ready; hello.start();
    })()`);
    // Reveal may use the full GPU intro or the fallback depending on the host.
    for (let tries = 0; tries < 100; tries++) {
      if (await js('document.querySelector(".hello-screen__footer").classList.contains("is-visible")')) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    await click('.hello-get-started');
    assert.equal(await js('dismissals'), 0, 'Get Started opens setup without marking Hello seen');
    assert.equal(await js('document.activeElement.id'), 'hello-setup-title');
    win.webContents.sendInputEvent({type:'keyDown', keyCode:'Tab'});
    win.webContents.sendInputEvent({type:'keyUp', keyCode:'Tab'});
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(await js('document.activeElement.matches("input:checked")'), true);
    await click('input[value="ios"]');
    await js(`document.querySelector('input[value="ios"]').focus()`);
    win.webContents.sendInputEvent({type:'keyDown', keyCode:'Space'});
    win.webContents.sendInputEvent({type:'keyUp', keyCode:'Space'});
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(await js('document.querySelector(".hello-setup").dataset.step'), 'uiStyle', 'Space on a radio does not skip setup');
    await next(); await click('input[value="light"]'); await next(); await next();
    assert.deepEqual(await js('saved'), [{uiStyle:'ios',theme:'light',disableSolarium:false}]);
    assert.equal(await js('dismissals'), 1);
    await js('hello.destroy()');
    assert.equal(await js('document.querySelector(".hello-screen")'), null);
    console.log('Hello setup: navigation, retained choices, completion, layout, keyboard and cleanup passed.');
  } finally { win.destroy(); }
  app.exit(0);
}
if (process.versions.electron) {
  run().catch(error => {console.error(error);require('electron').app.exit(1);});
} else {
  const {spawnSync} = require('node:child_process');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hello-setup-'));
  try {
    const env = {...process.env, HELLO_SETUP_PROFILE:profile};
    delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
    const result = spawnSync(require('electron'), [__filename], {env,stdio:'inherit',timeout:45000});
    process.exitCode = result.status ?? 2;
  } finally {fs.rmSync(profile,{recursive:true,force:true,maxRetries:3,retryDelay:100});}
}
