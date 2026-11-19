'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function run() {
  const { app, BrowserWindow } = require('electron');
  app.setPath('userData', process.env.SOLARIUM_OPTICS_PROFILE);
  await app.whenReady();
  const win = new BrowserWindow({ show: false, width: 480, height: 320,
    webPreferences: { sandbox: true, backgroundThrottling: false } });
  try {
    const fixture = path.join(process.env.SOLARIUM_OPTICS_PROFILE, 'fixture.html');
    fs.writeFileSync(fixture, '<!doctype html><body style="margin:0"></body>');
    await win.loadFile(fixture);
    const url = name => pathToFileURL(path.resolve(__dirname, '../src/renderer/solarium', name)).href;
    const results = await win.webContents.executeJavaScript(`(async () => {
      const { LiquidGlassRenderer } = await import(${JSON.stringify(url('renderer.js'))});
      const { LiquidGlass } = await import(${JSON.stringify(url('liquid-glass.js'))});
      const { createMenuMaterial } = await import(${JSON.stringify(url('menu-material.js'))});
      const canvas = document.createElement('canvas');
      const renderer = new LiquidGlassRenderer(canvas), gl = renderer.gl;
      const source = document.createElement('canvas');
      source.width = 129; source.height = 97;
      const context = source.getContext('2d');
      const rectangle = {x:8,y:8,width:113,height:81,radius:0};
      const base = {...new LiquidGlass().uniforms, resolution:[129,97], contentsScale:1,
        backdropTone:[1,1], materialTint:[0,0,0,0], refractiveIndex:1, dispersionStrength:0,
        glareIntensity:0, fresnelIntensity:0, rectangles:[rectangle]};
      const draw = (changes = {}, blur = 0) => {
        const uniforms = {...base, ...changes};
        renderer.resize(...uniforms.resolution);
        renderer.draw(uniforms, blur);
      };
      const pixel = (x,y) => {
        const value = new Uint8Array(4);
        gl.readPixels(x,canvas.height-1-y,1,1,gl.RGBA,gl.UNSIGNED_BYTE,value);
        return Array.from(value);
      };
      const image = () => {
        const value = new Uint8Array(canvas.width*canvas.height*4);
        gl.readPixels(0,0,canvas.width,canvas.height,gl.RGBA,gl.UNSIGNED_BYTE,value);
        return Array.from(value);
      };
      const solid = color => {
        context.clearRect(0,0,source.width,source.height);
        context.fillStyle=color; context.fillRect(0,0,source.width,source.height);
        renderer.setBackground(source);
      };
      solid('rgba(64,128,192,0.25)'); draw();
      const translucent = pixel(64,48);
      draw({dispersionStrength:10});
      const translucentSpectral = pixel(64,48);
      draw({rectangles:[{...rectangle,x:8.25}]});
      const fractionalEdge = pixel(8,40), outside = pixel(7,40);
      draw({resolution:[258,194],contentsScale:2,rectangles:[{...rectangle,x:8.25}]});
      const retinaEdge = pixel(16,80);
      solid('#4080c0'); draw({},12);
      const constantBlur = [pixel(10,40),pixel(64,48),pixel(118,40)];
      draw({optics:{bg_blurAlpha:[1,1,0,0],bg_blurDistance:[0,0,0,0]}},12);
      const coincidentStops = pixel(64,48);

      // An odd-sized image catches both row inversions and half-texel drift
      // when pyramid levels are sampled at a fractional LOD.
      context.fillStyle='#ff0000'; context.fillRect(0,0,129,48);
      context.fillStyle='#0000ff'; context.fillRect(0,48,129,49);
      renderer.setBackground(source); draw({},4);
      const orientation = [pixel(64,20),pixel(64,76)];
      for (let x=0;x<129;x++) {
        context.fillStyle='rgb('+Math.min(255,x*2)+',0,0)'; context.fillRect(x,0,1,97);
      }
      renderer.setBackground(source); draw();
      const undisplaced = pixel(8,40);
      draw({glassThickness:12,refractiveIndex:1.5});
      const refracted = pixel(8,40);
      draw({glassThickness:12,refractiveIndex:1.5,dispersionStrength:20});
      const dispersed = pixel(8,40);
      draw({optics:{bg_hasOuterRefraction:1,bg_refractionOpacity:1,bg_outerRefractionAmount:6}});
      const outerRefraction = pixel(8,40);

      solid('#282828'); draw();
      const unpressed = pixel(32,40);
      draw({pressProgress:1,touchPoint:[32,40]});
      const pressedLight = {near:pixel(32,40),far:pixel(104,40),outside:pixel(4,40)};
      draw({pressProgress:1,touchPoint:[96,40]});
      const movedLight = {old:pixel(32,40),next:pixel(96,40)};
      draw({pressProgress:0,touchPoint:[96,40]});
      const releasedLight = pixel(96,40);
      // Exercise the real clear-control recipe over the same neutral surface
      // that needs clear refraction without a bright enclosing outline.
      const thumb = {...LiquidGlass.thumb().uniforms,resolution:[129,97],contentsScale:1,
        backdropTone:[1,1],rectangles:[{x:30,y:29,width:58,height:38,radius:19}]};
      draw(thumb);
      const clearThumb = {rim:pixel(57,29),face:pixel(57,40),peak:Math.max(...image().filter((_,index)=>index%4===0))};
      draw({...thumb,pressProgress:1,touchPoint:[57,40]});
      clearThumb.pressedFace=pixel(57,40);
      solid('#000');
      draw({optics:{hl_keyDirection:[0,-1],hl_fillDirection:[0,1],hl_keyHeight:3,
        hl_fillHeight:3,hl_keySpread:0,hl_fillSpread:0,hl_keyAmount:0,hl_fillAmount:0,
        hl_keyColor:[1,0,0,1],hl_fillColor:[0,0,1,1],hl_groupOpacity:1,hl_curvature:1}});
      const highlights = [pixel(64,8),pixel(64,88),pixel(8,48),pixel(64,48)];
      const menuRims = [];
      solid('#404040');
      for (const scale of [1, 2, 3]) {
        const menuMaterial = createMenuMaterial();
        const optics = menuMaterial.resolveOptics(true,
          {width:129,height:97,sourceWidth:129,sourceHeight:97});
        const changes = {...menuMaterial.uniforms,rectangles:[rectangle],resolution:[129*scale,97*scale],contentsScale:scale,optics};
        const sample = (x,y) => pixel(Math.floor(x*scale),Math.floor(y*scale));
        draw(changes);
        const lit = {top:sample(64,8),bottom:sample(64,88),side:sample(8,48),
          shoulder:sample(64,11),interior:sample(64,17),outside:sample(64,6)};
        draw({...changes,optics:{...optics,hl_groupOpacity:0}});
        const unlit = {top:sample(64,8),bottom:sample(64,88),side:sample(8,48),
          shoulder:sample(64,11),interior:sample(64,17),outside:sample(64,6)};
        menuRims.push({lit,unlit});
      }
      const menuRimColors = [];
      for (const color of ['#404040','#67486f','#c0c0c0']) {
        solid(color);
        const menuMaterial = createMenuMaterial();
        const optics = menuMaterial.resolveOptics(true,
          {width:129,height:97,sourceWidth:129,sourceHeight:97});
        const changes = {...menuMaterial.uniforms,resolution:[129,97],contentsScale:1,rectangles:[rectangle],optics};
        draw(changes);
        const rim = pixel(64,8);
        // RGB gain belongs to the source, whose alpha alone drives this
        // destination filter. It must not turn a coverage mask into paint.
        draw({...changes,optics:{...optics,hl_effectiveGroupGain:10,hl_keyColor:[0,0,0,1]}});
        const changedMaskRGB = pixel(64,8);
        draw({...changes,optics:{...optics,hl_groupOpacity:0}});
        menuRimColors.push({rim,changedMaskRGB,face:pixel(64,8)});
      }
      solid('#000');
      draw({optics:{edge_opacity:0.8,edge_width:3,edge_offsetHDR:1}});
      const contrast = [pixel(64,8),pixel(64,48)];
      solid('#ffffff');
      draw({optics:{bg_shadowOpacity:1,bg_shadowFaceOpacity:0.5,bg_shadowInverseRadius:1/3}});
      const shadow = [pixel(7,40),pixel(64,48)];
      draw({rectangles:[{x:24,y:20,width:80,height:56,radius:20}],cornerRoundnessExponent:2});
      const circularCorner = image();
      draw({rectangles:[{x:24,y:20,width:80,height:56,radius:20}],cornerRoundnessExponent:4});
      const continuousCorner = image();
      const cornerDifference = continuousCorner.reduce((peak,value,index)=>
        index%4===3 ? Math.max(peak,Math.abs(value-circularCorner[index])) : peak,0);
      const main = {x:10,y:30,width:60,height:36,radius:18};
      const extra = {x:64,y:30,width:30,height:36,radius:15};
      draw({rectangles:[main]}); const single = image();
      draw({rectangles:[main,{...extra,opacity:0}]}); const absent = image();
      const neck=[];
      for (const opacity of [0,0.5,1]) {
        draw({rectangles:[main,{...extra,opacity}]});
        neck.push(image().reduce((sum,value,index)=>sum+(index%4===3?value:0),0));
      }
      draw({rectangles:[{...main,opacity:0}]}); const empty = image();

      for (let x=0;x<129;x++) {
        context.fillStyle=x%2?'#fff':'#000'; context.fillRect(x,0,1,97);
      }
      renderer.setBackground(source); draw(); const sharp = image();
      draw({},12); const blurred = image();
      const variation = pixels => {
        let sum=0;
        for(let x=20;x<100;x++) {
          const a=(48*129+x)*4,b=a+4;
          sum+=Math.abs(pixels[a]-pixels[b]);
        }
        return sum;
      };
      const errors = [gl.getError()];
      const oldTargets = renderer.pyramidTargets.flatMap(target=>[{...target},{...target.horizontal}]);
      source.width=1; source.height=31;
      context.fillStyle='#30c060';context.fillRect(0,0,1,31);
      renderer.setBackground(source); draw({},6);
      const thin = pixel(64,48);
      errors.push(gl.getError());
      const releasedOnResize = oldTargets.every(({texture,framebuffer})=>
        !gl.isTexture(texture) && !gl.isFramebuffer(framebuffer));
      source.width=1; source.height=1;
      context.fillStyle='#30c060';context.fillRect(0,0,1,1);
      renderer.setBackground(source); draw({},6);
      const onePixel = pixel(64,48);
      errors.push(gl.getError());
      const resources = [renderer.backgroundTexture];
      renderer.dispose();
      const released = resources.every(texture=>!gl.isTexture(texture));
      return {translucent,translucentSpectral,fractionalEdge,retinaEdge,outside,
        unpressed,pressedLight,movedLight,releasedLight,clearThumb,
        constantBlur,coincidentStops,orientation,undisplaced,refracted,dispersed,outerRefraction,shadow,highlights,menuRims,menuRimColors,
        contrast,cornerDifference,absentMatches:single.every((v,i)=>v===absent[i]),
        neck,empty:empty.every(v=>v===0),sharpVariation:variation(sharp),blurVariation:variation(blurred),
        thin,onePixel,errors,releasedOnResize,released};
    })()`);
    const close = (actual, expected, message, tolerance=2) => {
      assert.ok(actual.every((value,index)=>Math.abs(value-expected[index])<=tolerance),
        `${message}: ${JSON.stringify(actual)} vs ${JSON.stringify(expected)}`);
    };
    close(results.translucent,[64,128,192,255],'The face must unpremultiply a translucent backdrop');
    close(results.translucentSpectral,results.translucent,'Spectral weights must preserve a uniform colour');
    close(results.fractionalEdge,[48,96,144,191],'Fractional edge coverage must premultiply RGB');
    close(results.retinaEdge,[32,64,96,128],'Retina coverage must use the output pixel footprint');
    assert.deepEqual(results.outside,[0,0,0,0]);
    for (const value of results.constantBlur) close(value,[64,128,192,255],'Pyramid filtering must preserve DC colour');
    close(results.coincidentStops,[64,128,192,255],'Coincident blur stops must remain finite');
    assert.ok(results.orientation[0][0]>220 && results.orientation[0][2]<35,'Blurred top rows must stay red');
    assert.ok(results.orientation[1][2]>220 && results.orientation[1][0]<35,'Blurred bottom rows must stay blue');
    const amount=-6*(1-Math.sqrt((0.5/12)*(2-0.5/12)));
    close(results.refracted,[Math.round((8-amount)*2),0,0,255],'Refraction must follow the circular height profile');
    assert.ok(results.refracted[0]>results.undisplaced[0]+5,'Refraction must bend the captured image');
    assert.notDeepEqual(results.dispersed,results.refracted,'Dispersion must use independent spectral offsets');
    assert.ok(results.outerRefraction[0]<results.undisplaced[0]-5,'Outer refraction must have its own displacement');
    assert.ok(results.shadow[0][3]>0 && results.shadow[0][0]===0,'The external shadow must retain premultiplied coverage');
    close(results.shadow[1],[255,255,255,255],'The external shadow must not darken the face');
    assert.ok(results.pressedLight.near[0]>results.unpressed[0]+45,'A held press must paint a visible white light');
    assert.ok(results.pressedLight.near[0]>results.pressedLight.far[0]+35,'Press light must stay local to its pointer');
    assert.ok(results.movedLight.next[0]>results.movedLight.old[0]+35,'Moving the pointer must move the light');
    close(results.releasedLight,results.unpressed,'Released glass must return to its backdrop');
    assert.deepEqual(results.pressedLight.outside,[0,0,0,0],'Press light must not paint outside the glass');
    assert.ok(results.clearThumb.peak<90,'Clear-control reflections must not form a bright enclosing border');
    assert.ok(results.clearThumb.face[0]<65,'Clear glass must preserve a dark backdrop rather than filling it grey');
    assert.deepEqual(results.clearThumb.pressedFace,results.clearThumb.face,'Slider and switch materials must not receive the pointer glow');
    assert.ok(results.highlights[0][0]>180 && results.highlights[0][2]===0,'The key lobe must follow its direction');
    assert.ok(results.highlights[1][2]>180 && results.highlights[1][0]===0,'The fill lobe must use its independent direction');
    close(results.highlights[2],[0,0,0,255],'Unlit edges must retain their backdrop');
    close(results.highlights[3],[0,0,0,255],'Specular light must not wash over the face');
    for (const {lit,unlit} of results.menuRims) {
      assert.ok(lit.top[0]>unlit.top[0]+5 && lit.bottom[0]>unlit.bottom[0]+5,
        'Menu reflections must reach both illuminated edges at every display scale');
      assert.ok(lit.shoulder[0]>unlit.shoulder[0] && lit.shoulder[0]<lit.top[0],
        'The narrow rim must decay into its soft shoulder');
      for (const name of ['side','interior','outside']) {
        close(lit[name],unlit[name],'The rim must leave '+name+' samples unchanged');
      }
    }
    const groupMatrix = require('./fixtures/solarium-menu-material.json').highlight.groupColorMatrix;
    for (const {rim,face,changedMaskRGB} of results.menuRimColors) {
      const expected = [0,1,2].map(row => {
        const matrix = groupMatrix.slice(row*5,row*5+5);
        return Math.round(face.slice(0,3).reduce((sum,value,column) =>
          sum + value*matrix[column],255*(matrix[3]+matrix[4])));
      });
      close(rim,[...expected,255],'The rim must transform the material beneath its mask');
      close(changedMaskRGB,rim,'Mask RGB and HDR gain must not become a white outline');
      assert.ok(Math.max(...rim.slice(0,3))<235,'The rim must retain tonal headroom on neutral and coloured surfaces');
    }
    assert.ok(results.contrast[0][0]>results.contrast[1][0]+30,'Contrast must stay at the inner edge');
    assert.ok(results.cornerDifference>30,'Continuous corners must use their analytic profile');
    assert.equal(results.absentMatches,true,'Zero-weight shapes must leave the original field unchanged');
    assert.ok(results.neck[0]<results.neck[1] && results.neck[1]<results.neck[2],'Union membership must interpolate continuously');
    assert.equal(results.empty,true,'An empty shape field must be transparent');
    assert.ok(results.sharpVariation>10000 && results.blurVariation<results.sharpVariation*0.1,
      'Pyramid blur must remove high-frequency backdrop detail');
    close(results.thin,[48,192,96,255],'One-texel-wide captures must have a complete pyramid');
    close(results.onePixel,results.thin,'A one-pixel capture must stay valid at every requested LOD');
    assert.deepEqual(results.errors,[0,0,0]);
    assert.equal(results.releasedOnResize,true,'Resizing must release all old pyramid targets');
    assert.equal(results.released,true,'Disposal must release the backdrop texture');
    console.log('Solarium optics: refraction profile, spectral sampling, premultiplication, Retina coverage, analytic corners, scoped press lighting, blur, union membership, resize and teardown passed.');
  } finally { win.destroy(); }
  app.exit(0);
}

if (process.versions.electron) {
  run().catch(error => { console.error(error); require('electron').app.exit(1); });
} else {
  const { spawnSync } = require('node:child_process');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(),'solarium-optics-'));
  try {
    const env={...process.env,SOLARIUM_OPTICS_PROFILE:profile};
    delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
    const result=spawnSync(require('electron'),[__filename],{env,stdio:'inherit',timeout:30000});
    process.exitCode=result.status??2;
  } finally { fs.rmSync(profile,{recursive:true,force:true,maxRetries:3,retryDelay:100}); }
}
