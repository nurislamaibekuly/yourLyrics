'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
async function run() {
  const {app, BrowserWindow, ipcMain, nativeTheme, screen, session} = require('electron');
  app.setPath('userData', process.env.HELLO_PLAYER_PROFILE);
  await app.whenReady();
  const {createWindowStyleController} = require('../src/main/window/window-style');
  const controller = createWindowStyleController(screen);
  const noop = () => ({ok:true});
  const handlers = {
    'now-playing:get': () => ({title:'Your music',artist:'yourLyrics',album:'Welcome',playing:false,positionSeconds:30,durationSeconds:180}),
    'now-playing:refresh': noop, 'now-playing:set-artwork-fallback': noop,
    'lyrics:get': () => ({text:'[00:00.00]Your music\n[00:20.00]Your lyrics\n[00:45.00]Just the way you like it',source:'local'}),
    'animated-art:get': () => null,
    'theme:set': (_event, value) => {nativeTheme.themeSource=value;return {ok:true};},
    'discord:status': () => ({state:'disabled'}), 'discord:set-settings': noop,
    'updates:check': () => ({}), 'updates:version': () => '0.4.6',
    'window:set-ui-style': (event,style,options) => controller.set(BrowserWindow.fromWebContents(event.sender),style,options),
    'window:set-ui-scale': () => ({ok:true,scale:1}), 'window:get-ui-scale': () => ({ok:true,scale:1}),
    'window:is-maximized': () => ({maximized:false}), 'window:is-pinned': () => ({alwaysOnTop:false}),
    'window:get-state': () => ({maximized:false,fullscreen:false,alwaysOnTop:false}),
    'app:hostname': () => 'Mac', 'app:bluetooth-device': () => null,
  };
  for(const [name,handler] of Object.entries(handlers)) ipcMain.handle(name,handler);
  const isolated=session.fromPartition(`hello-player-${process.pid}`,{cache:false});
  isolated.webRequest.onBeforeRequest((details,callback)=>callback({cancel:!/^(file|data):/.test(details.url)}));
  const win=new BrowserWindow({show:false,width:1000,height:720,minWidth:800,minHeight:600,
    webPreferences:{preload:path.join(root,'src/preload/index.js'),additionalArguments:['--yourlyrics-dev'],
      session:isolated,nodeIntegration:false,contextIsolation:true,sandbox:true,backgroundThrottling:false}});
  const js = source => win.webContents.executeJavaScript(source);
  const wait = ms => new Promise(resolve=>setTimeout(resolve,ms));
  const errors=[];
  win.webContents.on('console-message',event=>{if(event.level==='error') errors.push(event.message);});
  const until=async source=>{for(let i=0;i<160;i++){if(await js(source))return;await wait(50);}throw new Error(`Timed out: ${source}`);};
  const next=async()=>{
    await js(`document.querySelector('.hello-setup__next').click()`);
    await until(`document.querySelector('.hello-setup')?.dataset.transitioning!=='true'`);
  };
  const capture=async name=>{if(process.env.HELLO_SETUP_SCREENSHOTS)fs.writeFileSync(`/tmp/hello-player-${name}.png`,(await win.webContents.capturePage()).toPNG());};
  try {
    await win.loadFile(path.join(root,'src/renderer/index.html'));
    await until(`document.querySelector('.hello-screen__footer')?.classList.contains('is-visible')`);
    await js(`document.querySelector('.hello-get-started').click()`);
    await wait(900);
    assert.equal(await js(`document.querySelector('.hello-setup').dataset.renderer`),'solarium');
    assert.equal(await js(`document.querySelectorAll('.hello-setup canvas').length`),3);
    assert.equal(await js(`getComputedStyle(document.querySelector('.hello-setup__group')).backgroundColor`),'rgba(0, 0, 0, 0)');
    await capture('interface');
    await js(`document.querySelector('input[value="ios"]').click()`);
    await next(); await capture('appearance');
    await js(`document.querySelector('input[value="dark"]').click()`);
    await next(); await capture('glass');
    assert.equal(await js(`localStorage.getItem('yourlyrics:hello-seen')`),null);
    await js(`document.querySelector('.hello-setup__next').click()`);
    await until(`Boolean(document.querySelector('.stage').getAnimations().length)`);
    await wait(210);
    const mid=await js(`(() => {
      const stage=getComputedStyle(document.querySelector('.stage'));
      const hello=getComputedStyle(document.querySelector('.hello-screen'));
      return {playerOpacity:parseFloat(stage.opacity),playerFilter:stage.filter,
        setupOpacity:parseFloat(hello.opacity),layout:document.body.dataset.uiStyle};
    })()`);
    assert.equal(mid.layout,'ios');
    assert.ok(mid.playerOpacity>0 && mid.playerOpacity<1,`Player must visibly animate: ${JSON.stringify(mid)}`);
    assert.ok(mid.setupOpacity>0 && mid.setupOpacity<1,'Setup must fade while the player enters');
    assert.notEqual(mid.playerFilter,'none');
    await capture('transition');
    await until(`!document.querySelector('.hello-screen')`);
    assert.equal(await js(`getComputedStyle(document.querySelector('.stage')).opacity`),'1');
    assert.equal(await js(`document.querySelector('.stage').getAnimations().length`),0);
    assert.equal(await js(`document.body.classList.contains('is-hello-active')`),false);
    const saved=await js(`JSON.parse(localStorage.getItem('yourlyrics:settings'))`);
    assert.equal(saved.uiStyle,'ios');assert.equal(saved.theme,'dark');assert.equal(saved.disableSolarium,false);
    assert.equal(await js(`localStorage.getItem('yourlyrics:hello-seen')`),'1');
    assert.ok(win.getBounds().width<win.getBounds().height,'Selected layout resizes the native window before reveal');
    await capture('finished');
    // Completion survives a real reload, including development launches.
    const reloaded = new Promise(resolve => win.webContents.once('did-finish-load', resolve));
    win.reload();
    await reloaded;
    await until(`!document.body.classList.contains('is-startup-pending')`);
    assert.equal(await js(`document.querySelector('.hello-screen')`),null,'Completed setup must not reopen on launch');
    assert.equal(await js(`localStorage.getItem('yourlyrics:hello-seen')`),'1');
    assert.equal(await js(`document.body.dataset.uiStyle`),'ios');

    // Explicitly reset only the test profile to exercise a second first launch.
    await js(`localStorage.removeItem('yourlyrics:hello-seen')`);
    // The standard-control choice also applies during setup, with no restart,
    // and reduced motion uses a short dissolve throughout.
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{
      features:[{name:'prefers-reduced-motion',value:'reduce'}]
    });
    win.reload();
    await until(`document.querySelector('.hello-screen__footer')?.classList.contains('is-visible')`);
    await js(`document.querySelector('.hello-get-started').click()`);
    await js(`document.querySelector('input[value="macos"]').click()`);
    await next();
    await js(`document.querySelector('input[value="light"]').click()`);
    await next();
    await js(`document.querySelector('input[value="true"]').click()`);
    assert.equal(await js(`document.querySelector('.hello-setup').dataset.glass`),'false');
    assert.equal(await js(`getComputedStyle(document.querySelector('.hello-setup__glass')).visibility`),'hidden');
    await js(`document.querySelector('.hello-setup__next').click()`);
    await until(`!document.querySelector('.hello-screen')`);
    const standard=await js(`JSON.parse(localStorage.getItem('yourlyrics:settings'))`);
    assert.equal(standard.disableSolarium,true);
    assert.equal(standard.uiStyle,'macos');
    assert.equal(standard.theme,'light');
    assert.equal(await js(`document.querySelectorAll('.solarium-lyrics-toggle__glass, .solarium-macos-volume__glass').length`),0);
    assert.deepEqual(errors.filter(message=>!/ERR_BLOCKED_BY_CLIENT|Autofill/.test(message)),[]);
    console.log('Hello player: real Solarium, saved settings, completion remembered across reload, native resize and transitions passed.');
  } finally {win.destroy();}
  app.exit(0);
}
if(process.versions.electron)run().catch(error=>{console.error(error);require('electron').app.exit(1);});
else {
  const profile=fs.mkdtempSync(path.join(os.tmpdir(),'hello-player-'));
  try {
    const env={...process.env,HELLO_PLAYER_PROFILE:profile};delete env.ELECTRON_RUN_AS_NODE;delete env.NODE_OPTIONS;
    const result=require('node:child_process').spawnSync(require('electron'),[__filename],{env,stdio:'inherit',timeout:40000});
    process.exitCode=result.status??2;
  } finally {fs.rmSync(profile,{recursive:true,force:true,maxRetries:3,retryDelay:100});}
}
