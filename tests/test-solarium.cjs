'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function run() {
  const { app, BrowserWindow } = require('electron');
  app.setPath('userData', process.env.SOLARIUM_TEST_PROFILE);
  await app.whenReady();
  const win = new BrowserWindow({ show: false, width: 640, height: 480,
    webPreferences: { sandbox: true, backgroundThrottling: false } });
  const js = source => win.webContents.executeJavaScript(source);
  const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
  try {
    const fixture = path.join(process.env.SOLARIUM_TEST_PROFILE, 'fixture.html');
    fs.writeFileSync(fixture, '<!doctype html><body style="margin:0"></body>');
    await win.loadFile(fixture);
    const moduleURL = pathToFileURL(path.resolve(__dirname, '../src/renderer/solarium/index.js')).href;
    const nativeSprings = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/solarium-uikit-springs.json'), 'utf8'));
    const springURL = pathToFileURL(path.resolve(__dirname, '../src/renderer/solarium/spring.js')).href;
    const results = await js(`(async () => {
      const { LiquidGlassSwitch, LiquidGlassSlider, LiquidLensView } = await import(${JSON.stringify(moduleURL)});
      const { springProgress } = await import(${JSON.stringify(springURL)});
      const source = document.createElement('canvas'); source.width=640; source.height=480;
      const context=source.getContext('2d'); context.fillStyle='#282828'; context.fillRect(0,0,640,480);
      const bounds={left:0,top:0,width:640,height:480};
      const toggle=new LiquidGlassSwitch({source, sourceBounds:bounds, isOn:true, onTintColor:'#00e040'});
      Object.assign(toggle.element.style,{position:'absolute',left:'100px',top:'80px'});
      toggle.appendTo(document.body);
      const slider=new LiquidGlassSlider({source,sourceBounds:bounds,value:0.5,
        minimumTrackTintColor:'#ff2200',maximumTrackTintColor:'#0044ff'});
      Object.assign(slider.element.style,{position:'absolute',left:'100px',top:'180px',width:'300px'});
      slider.appendTo(document.body);
      toggle.thumb.expand(false); toggle.glass.draw();
      const capture=toggle.glass.captureCanvas;
      const trackPixel=Array.from(toggle.glass.captureContext.getImageData(
        Math.floor(capture.width/2),Math.floor(capture.height/2),1,1).data);
      const gl=toggle.glass.renderer.gl;
      const glassPixel=new Uint8Array(4);
      gl.readPixels(Math.floor(toggle.glass.canvas.width/2),Math.floor(toggle.glass.canvas.height/2),1,1,
        gl.RGBA,gl.UNSIGNED_BYTE,glassPixel);
      slider.thumb.expand(false); slider.glass.draw();
      const strip=slider.glass.captureCanvas;
      const sample=(x)=>Array.from(slider.glass.captureContext.getImageData(
        Math.floor(strip.width/2+x*(devicePixelRatio||1)),Math.floor(strip.height/2),1,1).data);
      const filled=sample(-10), unfilled=sample(10);
      const before=toggle.glass.captureCanvas.width;
      toggle.thumb.expanded=false; toggle.thumb.applyMorph(0.5);
      await new Promise(requestAnimationFrame);
      const during=toggle.glass.captureCanvas.width;
      const riseTime = (duration, damping) => {
        const progress = springProgress(duration, damping);
        for (let ms=0; ms<=duration*1000; ms++) if (progress(ms/(duration*1000)) >= 0.9) return ms;
      };
      let nativeError = 0;
      for (const curve of ${JSON.stringify(nativeSprings.curves)}) {
        const actual = springProgress(curve.duration,curve.ratio);
        for (const [time,value] of curve.samples) nativeError=Math.max(nativeError,Math.abs(actual(time)-value));
      }
      const pacing = { expand:riseTime(0.4,0.6), contract:riseTime(0.6,0.7), position:riseTime(0.5,1) };
      const lens = new LiquidLensView({ source, sourceBounds:bounds });
      Object.assign(lens.element.style, {position:'absolute',left:'100px',top:'280px',width:'140px',height:'38px'});
      lens.element.tabIndex=0;
      lens.appendTo(document.body); lens.setDraggable();
      lens.setLifted(true,{animated:false});
      // These numeric frames come directly from the reference's acceleration
      // coefficient, 30% clamp and centred-frame formula for 140x38 bounds.
      const lensFrames=[];
      for (const acceleration of [6000,-6000,0]) {
        lens.applyAccelerationSize(acceleration);
        lens.glass.draw();
        const host=lens.element.getBoundingClientRect(), glass=lens.glass.element.getBoundingClientRect();
        lensFrames.push({width:glass.width,height:glass.height,
          offsetX:glass.left-host.left,offsetY:glass.top-host.top,
          transform:lens.glass.element.style.transform,
          bufferWidth:lens.glass.canvas.width,ratio:devicePixelRatio||1});
      }
      lens.deviation=0; lens.deviationVelocity=0; lens.targetDeviation=0.3;
      lens.stepDeformation(1/60);
      const firstDeviation=lens.deviation;
      const firstVelocity=lens.deviationVelocity;
      lens.targetDeviation=-0.3;
      lens.stepDeformation(1/60);
      const reversedDeviation=lens.deviation;
      const advance=hz=>{lens.deviation=0;lens.deviationVelocity=0;lens.targetDeviation=0.3;
        for(let i=0;i<hz/10;i++)lens.stepDeformation(1/hz);return lens.deviation;};
      const smoothMotion={firstDeviation,firstVelocity,reversedDeviation,at60:advance(60),at120:advance(120)};
      lens.setLifted(false,{animated:false});
      const restoredLens={width:lens.glass.element.style.width,height:lens.glass.element.style.height};
      lens.captureCount=0; lens.maxDeformation=0;
      const captureLens=lens.glass.captureBackground.bind(lens.glass);
      lens.glass.captureBackground=()=>{lens.captureCount++;captureLens();};
      const deformLens=lens.applyAccelerationSize.bind(lens);
      lens.applyAccelerationSize=acceleration=>{lens.maxDeformation=Math.max(lens.maxDeformation,
        Math.min(Math.abs(acceleration*0.00005),0.3));deformLens(acceleration);};
      lens.paintError=0; lens.paintSamples=0; lens.lastRenderedWidth=null;
      const renderLens=lens.glass.renderer.draw.bind(lens.glass.renderer);
      lens.glass.renderer.draw=(uniforms,sigma)=>{
        lens.lastRenderedWidth=uniforms.resolution[0]/(devicePixelRatio||1);
        renderLens(uniforms,sigma);
      };
      const observePaint=()=>{
        if(lens.lifted && lens.lastRenderedWidth!=null){
          lens.paintError=Math.max(lens.paintError,Math.abs(lens.lastRenderedWidth-parseFloat(lens.glass.element.style.width)));
          lens.paintSamples++;
        }
        lens.paintProbeFrame=requestAnimationFrame(observePaint);
      };
      requestAnimationFrame(observePaint);
      window.controls={toggle,slider,lens};
      return {trackPixel,glassPixel:Array.from(glassPixel),filled,unfilled,before,during,
        springA:springProgress(0.4,0.6)(0.25),springB:springProgress(0.8,0.6)(0.25),pacing,lensFrames,restoredLens,smoothMotion,nativeError,error:gl.getError()};
    })()`);
    assert.ok(results.trackPixel[1] > results.trackPixel[0] + 100, 'The green parent track must enter the captured backdrop');
    assert.ok(results.glassPixel[1] > results.glassPixel[0] + 60, 'The rendered glass must show the green parent track');
    assert.ok(results.filled[0] > results.filled[2] + 100, 'The slider must capture its coloured fill');
    assert.ok(results.unfilled[2] > results.unfilled[0] + 100, 'The slider must capture its unfilled track');
    assert.ok(results.during < results.before, 'Contraction must refresh the capture after its transform changes');
    assert.ok(Math.abs(results.springA - results.springB) < 1e-9, 'Normalised spring timing must be independent of duration');
    assert.equal(results.error, 0);
    assert.ok(results.nativeError<0.002, `Spring curves must agree with measured UIKit parameters: ${results.nativeError}`);
    assert.ok(results.pacing.expand <= 100, `Expansion should respond promptly: ${results.pacing.expand}ms`);
    assert.ok(results.pacing.contract <= 180, `Contraction should not linger: ${results.pacing.contract}ms`);
    assert.ok(results.pacing.position <= 230, `Position should move before its settling tail: ${results.pacing.position}ms`);

    const expectedLensFrames=[[182,26.6,-21,5.7],[98,49.4,21,-5.7],[140,38,0,0]];
    for (const [index, frame] of results.lensFrames.entries()) {
      const expected=expectedLensFrames[index];
      for (const [field, value] of Object.entries({width:expected[0],height:expected[1],
        offsetX:expected[2],offsetY:expected[3]})) {
        assert.ok(Math.abs(frame[field]-value)<0.03, `Lens frame ${index} ${field}: ${frame[field]} vs ${value}`);
      }
      assert.equal(frame.transform,'none','Lens deformation must resize its frame, not scale rendered pixels');
      assert.equal(frame.bufferWidth,Math.round(182*frame.ratio),'The raster allocation must stay stable while logical geometry changes');
    }
    assert.deepEqual(results.restoredLens,{width:'140px',height:'38px'});
    assert.ok(results.smoothMotion.firstDeviation>0 && results.smoothMotion.firstDeviation<0.1,
      'An acceleration spike must not snap straight to the maximum deformation');
    assert.ok(Math.abs(results.smoothMotion.reversedDeviation-results.smoothMotion.firstDeviation)<0.1,
      'A direction reversal must preserve deformation continuity');
    assert.ok(Math.abs(results.smoothMotion.at60-results.smoothMotion.at120)<1e-9,
      'Deformation filtering must be independent of display refresh rate');

    // Real pointer events exercise capture and the tap-vs-drag decision. A tap
    // must start moving from the old centre rather than snapping before springing.
    await js('controls.toggle.thumb.contract(false); controls.toggle.setOn(true,false)');
    win.webContents.sendInputEvent({ type:'mouseDown', x:140, y:94, button:'left', clickCount:1 });
    await wait(20);
    win.webContents.sendInputEvent({ type:'mouseUp', x:140, y:94, button:'left', clickCount:1 });
    await wait(80);
    const tap = await js('({on:controls.toggle.isOn,center:controls.toggle.thumb.centerX,morph:controls.toggle.thumb.morph})');
    assert.equal(tap.on, false);
    assert.ok(tap.center > 20.5 && tap.center < 42.5, `The toggle must animate between ends: ${JSON.stringify(tap)}`);
    await wait(850);
    assert.equal(await js('controls.toggle.thumb.morph'), 0);

    await js(`controls.toggle.setOn(false,false); window.changes=0;
      controls.toggle.element.addEventListener('change',()=>window.changes++)`);
    win.webContents.sendInputEvent({ type:'mouseDown', x:121, y:94, button:'left', clickCount:1 });
    win.webContents.sendInputEvent({ type:'mouseMove', x:150, y:94, modifiers:['leftButtonDown'] });
    await wait(20);
    win.webContents.sendInputEvent({ type:'mouseUp', x:150, y:94, button:'left', clickCount:1 });
    await wait(30);
    const drag = await js('({on:controls.toggle.isOn,changes:window.changes})');
    assert.equal(drag.on, true, 'A quick drag reaching the on edge must not toggle back as a tap');
    assert.equal(drag.changes, 1, 'An edge toggle must emit one state change');

    await wait(650);
    await js(`controls.slider.setValue(0.5,false); window.sliderChanges=0;
      controls.slider.element.addEventListener('change',()=>window.sliderChanges++)`);
    win.webContents.sendInputEvent({ type:'mouseDown', x:350, y:194, button:'left', clickCount:1 });
    await wait(20);
    win.webContents.sendInputEvent({ type:'mouseUp', x:350, y:194, button:'left', clickCount:1 });
    await wait(80);
    const slide = await js(`({center:controls.slider.thumb.centerX,
      fill:parseFloat(controls.slider.fill.style.width),changes:window.sliderChanges})`);
    assert.ok(slide.center > 150 && slide.center < 250, 'A slider tap must animate to its new value');
    assert.ok(Math.abs(slide.fill-slide.center) < 0.01, 'The fill must follow every animated thumb position');
    assert.equal(slide.changes, 1, 'A slider tap must commit its value once');
    win.webContents.sendInputEvent({ type:'mouseDown', x:Math.round(100+slide.center), y:194,
      button:'left', clickCount:1 });
    await wait(20);
    assert.equal(await js('controls.slider.positionAnimation === null'), true,
      'Grabbing an animating slider must stop its old position spring');
    win.webContents.sendInputEvent({ type:'mouseUp', x:Math.round(100+slide.center), y:194,
      button:'left', clickCount:1 });

    await js('controls.lens.setLifted(true,{animated:false})');
    assert.equal(await js("controls.lens.glass.element.style.opacity"),'1');
    await js('controls.lens.setLifted(false,{animated:false})');
    assert.equal(await js("controls.lens.glass.element.style.visibility"),'hidden');
    win.webContents.sendInputEvent({ type:'mouseDown', x:170, y:299, button:'left', clickCount:1 });
    for (let i=1;i<=6;i++) {
      win.webContents.sendInputEvent({type:'mouseMove',x:170+Math.round(80*(i/6)**2),
        y:299+Math.round(20*(i/6)**2),modifiers:['leftButtonDown']});
      await wait(25);
    }
    await wait(100);
    const lensDrag=await js(`(() => {const lens=controls.lens;const r=lens.element.getBoundingClientRect();
      return {left:r.left,top:r.top,lifted:lens.lifted,captures:lens.captureCount,deformation:lens.maxDeformation,paintError:lens.paintError,paintSamples:lens.paintSamples};})()`);
    assert.equal(lensDrag.left,180);
    assert.equal(lensDrag.top,300);
    assert.equal(lensDrag.lifted,true);
    assert.ok(lensDrag.paintSamples>2);
    assert.ok(lensDrag.paintError<0.02,'Every painted frame must use pixels rendered for its current glass geometry');
    assert.ok(lensDrag.captures>2,'A lens moving over a still source must refresh its backdrop');
    assert.ok(lensDrag.deformation>0.01,'Pointer acceleration must reach the lens squash/stretch');
    win.webContents.sendInputEvent({type:'mouseUp',x:250,y:319,button:'left',clickCount:1});
    await wait(30);
    assert.equal(await js('controls.lens.lifted'),false);
    assert.equal(await js('controls.lens.element.getBoundingClientRect().left'),180,
      'A dropped lens must keep its new position');

    await js("void controls.lens.setDraggable(true,{axis:'x'})");
    win.webContents.sendInputEvent({type:'mouseDown',x:170,y:299,button:'left',clickCount:1});
    win.webContents.sendInputEvent({type:'mouseMove',x:200,y:319,modifiers:['leftButtonDown']});
    await wait(30);
    assert.equal(await js('controls.lens.element.getBoundingClientRect().top'),280,'An x-only lens must not move vertically');
    win.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});
    await wait(20);
    assert.equal(await js('controls.lens.element.getBoundingClientRect().left'),100,'Escape must cancel the current movement');
    win.webContents.sendInputEvent({type:'mouseUp',x:200,y:319,button:'left',clickCount:1});
    win.webContents.sendInputEvent({type:'keyDown',keyCode:'Right'});
    await wait(20);
    assert.equal(await js('controls.lens.element.getBoundingClientRect().left'),110,'Arrow keys must move a focused lens');
    win.webContents.sendInputEvent({type:'keyUp',keyCode:'Right'});
    await js('void controls.lens.setDraggable(false)');
    assert.equal(await js('controls.lens.element.style.cursor'),'');
    assert.equal(await js('controls.lens.element.style.transform'),'');

    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
      features:[{name:'prefers-reduced-motion',value:'reduce'}]
    });
    const reduced = await js(`(() => {
      controls.toggle.thumb.expand(); controls.toggle.setOn(false,true);
      return {morph:controls.toggle.thumb.morph,center:controls.toggle.thumb.centerX,
        transition:controls.toggle.track.style.transition};
    })()`);
    assert.equal(reduced.morph, 1);
    assert.equal(reduced.center, 20.5);
    assert.equal(reduced.transition, 'none');
    win.webContents.debugger.detach();

    // Cancel during a morph and destroy while callbacks are still pending.
    await js(`controls.slider.thumb.expand(); controls.slider.destroy(); controls.toggle.destroy(); cancelAnimationFrame(controls.lens.paintProbeFrame); controls.lens.dispose()`);
    await wait(100);
    console.log('Solarium: parent track pixels, refraction, contraction capture, spring timing, tap motion, quick drag, lens movement, keyboard, cancellation and teardown passed.');
  } finally { win.destroy(); }
  app.exit(0);
}

if (process.versions.electron) {
  run().catch(error => { console.error(error); require('electron').app.exit(1); });
} else {
  const { spawnSync } = require('node:child_process');
  const profile=fs.mkdtempSync(path.join(os.tmpdir(),'solarium-test-'));
  try {
    const env={...process.env,SOLARIUM_TEST_PROFILE:profile};
    delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
    const result=spawnSync(require('electron'),[__filename],{env,stdio:'inherit',timeout:30000});
    process.exitCode=result.status??2;
  } finally { fs.rmSync(profile,{recursive:true,force:true,maxRetries:3,retryDelay:100}); }
}
