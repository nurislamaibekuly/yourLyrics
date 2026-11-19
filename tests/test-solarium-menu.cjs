'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function run() {
  const { app, BrowserWindow } = require('electron');
  app.setPath('userData', process.env.SOLARIUM_MENU_PROFILE);
  await app.whenReady();
  const win = new BrowserWindow({ show: false, width: 640, height: 480,
    webPreferences: { sandbox: true, backgroundThrottling: false } });
  const js = source => win.webContents.executeJavaScript(source);
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  try {
    const url = file => pathToFileURL(path.resolve(__dirname, '../src/renderer', file)).href;
    const fixture = path.join(process.env.SOLARIUM_MENU_PROFILE, 'fixture.html');
    fs.writeFileSync(fixture, `<!doctype html>
      <link rel="stylesheet" href="${url('ui/menuview.css')}">
      <link rel="stylesheet" href="${url('solarium/menuview.css')}">
      <style>body{margin:0}#trigger{position:absolute;right:20px;top:20px;width:80px;height:36px}</style>
      <button id="trigger" type="button">Actions</button>`);
    await win.loadFile(fixture);
    const physics=await js(`(async()=>{
      const {computeMenuMorph,MenuMorphSpring}=await import(${JSON.stringify(url('solarium/menu-morph.js'))});
      return {mid:computeMenuMorph(.5,80,80),close:computeMenuMorph(-.2,80,160,true),
        start:new MenuMorphSpring(1,0).sample(0),end:new MenuMorphSpring(0,1).sample(2)};
    })()`);
    assert.equal(physics.mid.path,1.1875,'The reference back-out path must overshoot at mid-flight');
    assert.equal(physics.mid.driftY,8,'The standard path must cap anchor drift at 8px');
    assert.equal(physics.close.scale,.89,'Closing undershoot must use the reference squeeze');
    assert.equal(physics.start.velocity,-2.5,'Dismissal must start with the reference velocity');
    assert.equal(physics.end.value,1);
    assert.equal(physics.end.done,true);
    await js(`(async () => {
      const { MenuView } = await import(${JSON.stringify(url('solarium/menuview.js'))});
      const source=document.createElement('canvas');source.width=640;source.height=480;
      source.getContext('2d').fillStyle='#00d040';source.getContext('2d').fillRect(0,0,640,480);
      window.calls=[];window.closes=0;
      window.menu=new MenuView('#trigger',{source,sourceBounds:{left:0,top:0,width:640,height:480},
        theme:'dark',live:true,onSelect:item=>calls.push(item.label),onClose:()=>closes++,
        items:[{label:'First'},{label:'Disabled',disabled:true},{separator:true},
          {label:'Delete',destructive:true,icon:MenuView.icons.trash}]});
      menu.open(true);
      window.motionFrames=[];
      const started=performance.now();
      const sample=now=>{
        if(!menu._menu)return;
        const style=getComputedStyle(menu._menu);
        const contentStyle=getComputedStyle(menu._content);
        const triggerStyle=getComputedStyle(menu.trigger);
        motionFrames.push({time:now-started,x:menu._visual.x,y:menu._visual.y,width:Number.parseFloat(style.width),
          height:Number.parseFloat(style.height),left:Number.parseFloat(style.left),
          top:Number.parseFloat(style.top),radius:Number.parseFloat(style.borderRadius),
          contentOpacity:Number(contentStyle.opacity),
          panelOpacity:Number(style.opacity),
          contentFilter:contentStyle.filter,
          menuFilter:style.filter,
          triggerOpacity:Number(triggerStyle.opacity),
          triggerTransform:triggerStyle.transform,
          contentWidth:menu._content.clientWidth,
          canvasWidth:menu.glass.canvas.width,canvasHeight:menu.glass.canvas.height,
          captureWidth:menu.glass.captureCanvas.width,captureHeight:menu.glass.captureCanvas.height});
        if(now-started<1200)requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    })()`);
    await wait(1300);
    const initial = await js(`(() => {
      menu.glass.draw();const gl=menu.glass.renderer.gl,pixel=new Uint8Array(4);
      gl.readPixels(Math.floor(menu.glass.canvas.width/2),Math.floor(menu.glass.canvas.height/2),1,1,
        gl.RGBA,gl.UNSIGNED_BYTE,pixel);
      const r=menu._menu.getBoundingClientRect();
      return {state:menu.state,focus:document.activeElement.textContent,expanded:menu.trigger.getAttribute('aria-expanded'),
        role:menu._menu.getAttribute('role'),pixel:Array.from(pixel),error:gl.getError(),
        right:r.right,bottom:r.bottom,viewport:[innerWidth,innerHeight]};
    })()`);
    const motion=await js('motionFrames');
    assert.ok(motion.length>3,'Opening must animate over multiple display frames');
    assert.ok(Math.abs(motion.at(-1).width-200)<1,
      'The panel must settle at its final width');
    assert.ok(Math.abs(motion.at(-1).height-174)<1.5,
      'The menu must settle at its natural content size with 12px insets and 2px row gaps');
    assert.ok(motion.every(frame=>frame.width<=200.01),
      'The reference clamps opening size overshoot even while its spring overshoots');
    assert.ok(motion.every((frame,index)=>!index || frame.contentOpacity>=motion[index-1].contentOpacity),
      'The surface must fade in continuously');
    assert.ok(Math.abs(motion.at(-1).contentOpacity-1)<0.01,
      'The crossfade must complete before the entrance ends');
    assert.ok(motion.find(frame=>frame.time>380).contentOpacity>0.99,
      'The entrance must finish without a long settling tail');
    assert.ok(motion.every(frame=>frame.contentWidth===200),
      'Labels must keep their layout while the silhouette animates');
    const allocations=motion.filter(frame=>frame.canvasWidth>1 && frame.captureWidth>1);
    assert.ok(allocations.length>3);
    assert.equal(new Set(allocations.map(frame=>`${frame.canvasWidth}x${frame.canvasHeight}`)).size,1,
      'Opening must reuse a fixed drawing surface');
    assert.equal(new Set(allocations.map(frame=>`${frame.captureWidth}x${frame.captureHeight}`)).size,1,
      'Opening must reuse a fixed backdrop texture');

    // The morph is a droplet growing out of the trigger on two springs: the
    // rows must stay hidden until the drop has grown around them, the drop
    // must be at full strength by the time they show, and the trigger must
    // hand over by fading under the drop instead of being squeezed into a
    // label-sized shape.
    const firstContent=motion.find(frame=>frame.contentOpacity>0.02);
    assert.ok(firstContent,'The rows must appear during the entrance');
    assert.ok(motion[0].contentOpacity<0.02,
      'The entrance must not start with the rows visible');
    assert.ok(firstContent.height>54,
      'The rows must only appear once the round drop has grown past the trigger');
    assert.equal(firstContent.panelOpacity,1,
      'The drop must be full strength before the rows show through it');
    const last=motion.at(-1);
    assert.ok(last.triggerOpacity<0.02,
      'The trigger must be gone while the menu is up, as the drop takes its place');
    assert.ok(motion.every(frame=>frame.triggerTransform==='none'),
      'The trigger must fade beneath the drop rather than being squeezed');

    const earlyBlur=motion.find(frame=>/blur\(/.test(frame.contentFilter));
    assert.ok(earlyBlur,'The rows must go soft while the glass is still travelling');
    assert.ok(!/blur\(/.test(last.contentFilter),
      'The rows must be sharp once the menu has landed');
    assert.ok(motion.every(frame=>frame.menuFilter==='none'),
      'The glass edge must stay a crisp pill instead of blurring with the rows');
    const material=await js(`({tint:menu.glass.liquidGlass.resolveTint(true),
      optics:menu.glass.buildUniforms().optics,top:menu._morph.to.top,
      right:menu._morph.to.left+menu._morph.to.width,
      triggerRight:menu.trigger.getBoundingClientRect().right,
      rowBorder:getComputedStyle(menu._items[1].el).borderTopWidth})`);
    assert.equal(material.tint[3],0,'The resolved menu colour matrix must not receive a second white tint');
    assert.equal(material.optics.bg_blurFillEnabled,1,'The actual menu must use its broad blur-fill layer');
    assert.equal(material.optics.bg_blurFillLightenOpacity,0,'An explicit dark menu must retain dark appearance');
    assert.equal(material.optics.bg_faceCM[3],0.125,'The menu must use its decoded dark colour matrix');
    assert.equal(material.top,20,'The menu must grow over the trigger, without a detached gap');
    assert.equal(material.right,material.triggerRight,'The nearest trigger edge must remain the anchor');
    assert.equal(material.rowBorder,'0px','Ordinary menu rows must not have separators');
    const layout=await js(`(() => {
      const item=menu._items.at(-1).el;
      const icon=item.querySelector('.menuview__icon').getBoundingClientRect();
      const label=item.querySelector('.menuview__label').getBoundingClientRect();
      const panel=menu._menu.getBoundingClientRect();
      return {iconRight:icon.right,labelLeft:label.left,inset:icon.left-panel.left};
    })()`);
    assert.ok(layout.iconRight<layout.labelLeft,'Symbols must precede labels');
    assert.ok(layout.inset>=16,'Symbols should remain inset from the glass edge');
    assert.equal(initial.state,'open');
    assert.equal(initial.role,'menu');
    assert.equal(initial.focus,'First');
    assert.equal(initial.expanded,'true');
    assert.ok(initial.pixel[1]>initial.pixel[0]+20,'The menu must render its supplied green backdrop');
    assert.equal(initial.error,0);
    const purple=await js(`(()=>{
      const context=menu.source.getContext('2d');
      context.fillStyle='#67486f';context.fillRect(0,0,640,480);menu.glass.draw();
      const gl=menu.glass.renderer.gl,pixel=new Uint8Array(4);
      gl.readPixels(Math.floor(menu.glass.canvas.width/2),Math.floor(menu.glass.canvas.height/2),
        1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);
      context.fillStyle='#00d040';context.fillRect(0,0,640,480);menu.glass.draw();
      return Array.from(pixel);
    })()`);
    // A uniform scene isolates the decoded colour transfer from spatial
    // filtering. Compare it with the shader's independently recovered matrix.
    const packet=require('./fixtures/solarium-menu-material.json').appearances.dark;
    const color=[103,72,111].map(channel=>channel/255);
    const luminance=color[0]*0.2126+color[1]*0.7152+color[2]*0.0722;
    const complement=1-luminance*0.4;
    const graded=color.map(channel=>complement*luminance+
      complement*(channel-luminance)*(1+0.3*(1-complement)));
    const expectedColor=[0,1,2].map(row=>Math.round(255*(packet['faceCM'+row].slice(0,3)
      .reduce((sum,value,index)=>sum+value*graded[index],0)+packet['faceCM'+row][3])));
    assert.ok(purple.slice(0,3).every((channel,index)=>Math.abs(channel-expectedColor[index])<=2),
      `The actual menu must preserve the decoded colour transfer: ${purple} vs ${expectedColor}`);

    assert.ok(initial.right<=initial.viewport[0]-7 && initial.bottom<=initial.viewport[1]-7);
    win.webContents.sendInputEvent({type:'keyDown',keyCode:'Down'});
    await wait(30);
    assert.equal(await js('document.activeElement.textContent'),'Delete','Keyboard navigation must skip disabled items');
    win.webContents.sendInputEvent({type:'keyDown',keyCode:'Return'});
    win.webContents.sendInputEvent({type:'keyUp',keyCode:'Return'});
    await wait(800);
    assert.deepEqual(await js('calls'),['Delete']);
    assert.equal(await js('closes'),1);
    assert.equal(await js('document.activeElement.id'),'trigger');
    assert.equal(await js('menu._frameHandle'),0,'Closed menus must stop rendering');
    assert.equal(await js('document.querySelectorAll(".solarium-menuview").length'),0);
    assert.equal(await js('menu.trigger.style.transform'),'','The trigger transform must be restored');
    assert.equal(await js('menu.trigger.style.opacity'),'','The trigger opacity must be restored');

    await js('menu.open()');
    await wait(40);
    await js('window.firstClose=menu.close(); menu.open()');
    assert.equal(await js('firstClose'),false,'Reopening must cancel the old close without tearing down the new menu');
    await wait(260);
    assert.equal(await js('menu.state'),'open');
    assert.equal(await js('document.querySelectorAll(".solarium-menuview").length'),1);
    await js('menu._select(menu._items[1].el)');
    await wait(100);
    assert.deepEqual(await js('calls'),['Delete'],'Disabled actions must never fire');
    await js('menu._shade.dispatchEvent(new PointerEvent("pointerdown",{bubbles:true}))');
    await wait(800);
    assert.equal(await js('menu.state'),'closed');

    win.webContents.sendInputEvent({type:'mouseDown',x:580,y:38,button:'left',clickCount:1});
    await wait(480);
    const target=await js(`(() => {const r=menu._items[0].el.getBoundingClientRect();return {x:Math.round(r.left+20),y:Math.round(r.top+r.height/2)};})()`);
    win.webContents.sendInputEvent({type:'mouseMove',x:target.x,y:target.y,modifiers:['leftButtonDown']});
    win.webContents.sendInputEvent({type:'mouseUp',x:target.x,y:target.y,button:'left',clickCount:1});
    await wait(800);
    assert.deepEqual(await js('calls'),['Delete','First'],'Press-drag-release must select the hovered action once');

    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{
      features:[{name:'prefers-reduced-motion',value:'reduce'},{name:'prefers-reduced-transparency',value:'reduce'}]
    });
    await js('menu.open(true)');
    await wait(30);
    const reduced=await js('({progress:menu._progress,bg:getComputedStyle(menu._menu).backgroundColor})');
    assert.equal(reduced.progress,1);
    assert.equal(reduced.bg,'rgb(41, 41, 45)');
    await js('menu.destroy()');
    assert.equal(await js('menu.glass'),null);
    assert.equal(await js('document.querySelectorAll(".menuview__shade,.solarium-menuview").length'),0);
    assert.equal(await js('menu.trigger.hasAttribute("aria-expanded")'),false);
    assert.equal(await js('menu.trigger.hasAttribute("aria-controls")'),false);
    assert.equal(await js('menu.trigger.style.transform'),'','The trigger transform must be restored');
    await js(`trigger.style.left='120px';trigger.style.right='auto';
      window.special=new menu.constructor(trigger,{width:180,radius:16,gap:12,placement:'bottom-start',
        items:[{label:'A long label that must remain readable'}]});special.open()`);
    await wait(1300);
    const custom=await js(`(() => {const r=special._menu.getBoundingClientRect();return {
      left:r.left,top:r.top,width:r.width,radius:Number.parseFloat(getComputedStyle(special._menu).borderRadius)};})()`);
    assert.equal(custom.width,180);
    assert.equal(custom.left,120,'The requested alignment must be respected');
    assert.equal(custom.top,68,'The requested gap must be respected');
    assert.equal(custom.radius,16,'The caller must be able to choose the corner radius');
    await js('special.destroy()');
    await js(`window.nestedCalls=[];
      window.nested=new menu.constructor(trigger,{title:'Playback',live:false,items:[
        {title:'Quality',subtitle:'Choose playback quality',children:[
          {title:'Standard',checked:true,onPress:()=>nestedCalls.push('standard')},
          {title:'Unavailable',disabled:true},
          {title:'Advanced',children:[{title:'Lossless',checked:false}]}
        ]},
        {title:'Output',children:[{title:'Speakers'}]},
        {title:'Actions',inline:true,children:[{title:'Copy'}]}
      ]});nested.open(true)`);
    assert.equal(await js('document.activeElement.querySelector(".menuview__label").firstChild.textContent'),'Quality');
    assert.equal(await js('nested._focusable().length'),3,'Collapsed children and inline headings must be skipped');
    assert.equal(await js('nested._content.querySelector(".solarium-menuview__title").textContent'),'Playback');
    const collapsedHeight=await js('nested._morph.to.height');
    win.webContents.sendInputEvent({type:'keyDown',keyCode:'Right'});
    await wait(30);
    assert.equal(await js('document.activeElement.textContent'),'Standard✓');
    assert.equal(await js('document.activeElement.getAttribute("aria-checked")'),'true');
    assert.ok(await js('nested._morph.to.height')>collapsedHeight,'The platter must resize to reveal children');
    assert.equal(await js('nested.state'),'open','Expanding must not dismiss the menu');
    assert.equal(await js('nested._focusable().length'),5,'Disabled and collapsed descendants must be skipped');
    win.webContents.sendInputEvent({type:'keyDown',keyCode:'Left'});
    await wait(30);
    assert.equal(await js('document.activeElement.getAttribute("aria-expanded")'),'false');
    assert.equal(await js('nested._morph.to.height'),collapsedHeight,'Collapsing must restore the natural height');
    await js(`nested._select(nested._items.find(e=>e.item.title==='Quality').el);
      nested._select(nested._items.find(e=>e.item.title==='Output').el)`);
    assert.equal(await js(`nested._items.find(e=>e.item.title==='Quality').group.hidden`),true,
      'Opening a sibling must collapse the previous branch');
    assert.deepEqual(await js('nestedCalls'),[],'Submenu parents must not dispatch actions');
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[]});
    await js(`nested._select(nested._items.find(e=>e.item.title==='Quality').el)`);
    assert.ok(await js('!!nested._layoutTransition'),'Submenu resizing must use a spring when motion is enabled');
    const reveal=await js(`(() => {const group=nested._items.find(e=>e.item.title==='Quality').group;
      return {height:group.getBoundingClientRect().height,natural:group.scrollHeight,opacity:Number(group.style.opacity)};})()`);
    assert.ok(reveal.height<reveal.natural && reveal.opacity<1,
      'Submenu rows must expand and fade rather than appearing at their final size');
    for (let attempt=0;attempt<60 && await js('!!nested._layoutTransition');attempt++) await wait(50);
    assert.equal(await js('nested._layoutTransition'),null,'The resize spring must settle');
    await js(`nested._items.find(e=>e.item.title==='Standard').el.focus()`);
    win.webContents.sendInputEvent({type:'keyDown',keyCode:'Return'});
    win.webContents.sendInputEvent({type:'keyUp',keyCode:'Return'});
    await wait(800);
    assert.deepEqual(await js('nestedCalls'),['standard'],'Nested actions must dispatch once after dismissal');
    assert.equal(await js('nested.state'),'closed');
    await js('nested.destroy()');
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{
      features:[{name:'prefers-reduced-motion',value:'reduce'}]
    });
    const sharedSource=await js(`(() => {
      const capsule=document.createElement('div');
      Object.assign(capsule.style,{position:'absolute',left:'300px',bottom:'24px',width:'120px',height:'44px',opacity:'.6'});
      const button=document.getElementById('trigger');
      button.replaceWith(capsule);capsule.append(button);
      button.style.position='static';
      window.bare=new menu.constructor(button,{morphSource:capsule,items:[{label:'Share'},{label:'Copy'}]});
      bare.open();
      const rect=capsule.getBoundingClientRect();
      return {width:bare._morph.trigger.width,top:bare._morph.to.top,bottom:rect.bottom,
        height:bare._morph.to.height,opacity:capsule.style.opacity};
    })()`);
    assert.equal(sharedSource.width,120,'A menu inside a capsule must morph the whole capsule');
    assert.equal(sharedSource.top+sharedSource.height,sharedSource.bottom,
      'A menu near the bottom must grow upward from the capsule bottom');
    assert.equal(sharedSource.opacity,'0');
    await js('bare.destroy()');
    assert.equal(await js('trigger.parentElement.style.opacity'),'0.6','Destroy must restore the capsule opacity');
    console.log('Solarium menu: glass pixels, droplet morph, placement, keyboard selection, disabled actions, reopen races, dismissal, accessibility and cleanup passed.');
  } finally { win.destroy(); }
  app.exit(0);
}

if (process.versions.electron) {
  run().catch(error => { console.error(error); require('electron').app.exit(1); });
} else {
  const { spawnSync } = require('node:child_process');
  const profile=fs.mkdtempSync(path.join(os.tmpdir(),'solarium-menu-'));
  try {
    const env={...process.env,SOLARIUM_MENU_PROFILE:profile};
    delete env.ELECTRON_RUN_AS_NODE;delete env.NODE_OPTIONS;
    const result=spawnSync(require('electron'),[__filename],{env,stdio:'inherit',timeout:30000});
    process.exitCode=result.status??2;
  } finally { fs.rmSync(profile,{recursive:true,force:true,maxRetries:3,retryDelay:100}); }
}
