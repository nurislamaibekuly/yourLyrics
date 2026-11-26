import { normalizeUiStyle, uiStyleOptions } from '../player/ui-style.js';
import { LiquidGlassView } from '../solarium/glass-view.js';
import { createMenuMaterial } from '../solarium/menu-material.js';

const ICONS = {
  macos: '<rect x="3" y="4" width="26" height="18" rx="2"/><path d="M12 27h8m-4-5v5"/>',
  tvos: '<rect x="2" y="5" width="28" height="19" rx="3"/><path d="M11 28h10"/>',
  ios: '<rect x="9" y="2" width="14" height="28" rx="4"/><path d="M14 5h4m-4 22h4"/>',
  ipados: '<rect x="3" y="5" width="26" height="22" rx="3"/><path d="M6 14v4"/>',
  system: '<circle cx="16" cy="16" r="12"/><path d="M16 4a12 12 0 0 1 0 24Z" fill="currentColor" stroke="none"/>',
  light: '<circle cx="16" cy="16" r="6"/><path d="M16 2v3m0 22v3M2 16h3m22 0h3M6 6l2 2m16 16 2 2M6 26l2-2M24 8l2-2"/>',
  dark: '<path d="M27 20A12 12 0 0 1 12 5a12 12 0 1 0 15 15Z"/>',
  glass: '<path d="M7 9c0-4 4-6 9-6s9 2 9 6v14c0 4-4 6-9 6s-9-2-9-6Z"/><ellipse cx="16" cy="9" rx="9" ry="6"/><path d="M11 19v4"/>',
  simple: '<rect x="4" y="7" width="24" height="18" rx="6"/><path d="M10 16h12"/>',
  back: '<path d="m19 7-9 9 9 9"/>',
  check: '<path d="m7 16 6 6L26 9"/>',
};
const STEPS = [
  {key:'uiStyle', title:'Interface Style', description:'Choose how your player is arranged.', icon:'macos'},
  {key:'theme', title:'Appearance', description:'Choose a light or dark appearance, or match your system.', icon:'system'},
  {key:'disableSolarium', title:'Liquid Glass', description:'Use Solarium for glass controls that respond to your artwork.', icon:'glass'},
];
const DETAILS = {macos:'The classic desktop experience', tvos:'A spacious, cinematic view', ios:'Compact and familiar', ipados:'More room for your music and lyrics'};
function node(tag, className, text) {
  const el=document.createElement(tag);
  if(className) el.className=className;
  if(text) el.textContent=text;
  return el;
}
function icon(name) {
  const el=document.createElementNS('http://www.w3.org/2000/svg','svg');
  el.setAttribute('viewBox','0 0 32 32');
  el.setAttribute('fill','none');
  el.setAttribute('stroke','currentColor');
  el.setAttribute('stroke-width','1.7');
  el.setAttribute('stroke-linecap','round');
  el.setAttribute('stroke-linejoin','round');
  el.setAttribute('aria-hidden','true');
  el.innerHTML=ICONS[name];
  return el;
}

export function createSetupFlow({initialSettings={}, backdropCanvas=null, isBackdropPlaying=()=>false, onComplete=()=>{}}={}) {
  const settings={uiStyle:normalizeUiStyle(initialSettings.uiStyle),
    theme:['system','light','dark'].includes(initialSettings.theme)?initialSettings.theme:'system',
    disableSolarium:Boolean(initialSettings.disableSolarium)};
  const motion=window.matchMedia('(prefers-reduced-motion: reduce)');
  const appearance=window.matchMedia('(prefers-color-scheme: dark)');
  let step=0, completed=false, disposed=false, changing=false, frame=0;
  const views=[];
  const animations=new Set();
  const element=node('section','hello-setup');
  const panel=node('div','hello-setup__panel');
  const content=node('div','hello-setup__content');
  const symbol=node('div','hello-setup__symbol');
  const heading=node('h1','hello-setup__title');
  heading.id='hello-setup-title'; heading.tabIndex=-1;
  element.setAttribute('aria-labelledby',heading.id);
  const description=node('p','hello-setup__description');
  const group=node('div','hello-setup__group');
  const choices=node('fieldset','hello-setup__choices');
  group.append(choices);
  const hint=node('p','hello-setup__hint','You can change these anytime in Settings.');
  const navigation=node('div','hello-setup__navigation');
  const back=node('button','hello-setup__back');
  back.append(icon('back')); back.setAttribute('aria-label','Back');
  const next=node('button','hello-setup__next');
  const nextLabel=node('span','','Continue'); next.append(nextLabel);
  back.type=next.type='button';
  const progress=node('ol','hello-setup__progress');
  progress.setAttribute('aria-label','Setup progress');
  const dots=STEPS.map((s,index)=>{
    const item=node('li'); item.setAttribute('aria-label',`Step ${index+1}: ${s.title}`);
    progress.append(item); return item;
  });
  navigation.append(back,progress,next);
  content.append(symbol,heading,description,group,hint);
  panel.append(content,navigation); element.append(panel);
  const dark=()=>settings.theme==='dark'||(settings.theme==='system'&&appearance.matches);

  function redraw(milliseconds=0) {
    for(const view of views) milliseconds?view.requestDrawFor(milliseconds):view.requestDraw();
  }
  function mountGlass(host,radius,interactive=false) {
    const material=createMenuMaterial('regular');
    const optics=material.resolveOptics.bind(material);
    material.resolveOptics=(_dark,geometry)=>optics(dark(),geometry);
    const view=new LiquidGlassView(material,{
      source:backdropCanvas,
      sourceBounds:()=>backdropCanvas.getBoundingClientRect(),
      onCapture:backdropCanvas?null:(context,{captureLeft,captureTop,captureWidth,captureHeight})=>{
        context.fillStyle='#54515e'; context.fillRect(captureLeft,captureTop,captureWidth,captureHeight);
      },
      cornerRadius:radius, interactive, pressTransformTarget:interactive?host:null, pressScaleAmount:.04,
    });
    view.element.className='hello-setup__glass';
    Object.assign(view.element.style,{position:'absolute',inset:'0',zIndex:'0'});
    view.element.setAttribute('aria-hidden','true');
    host.prepend(view.element); views.push(view);
    return view;
  }
  // Use the identical renderer and recovered regular material as MenuView.
  mountGlass(group,28);
  mountGlass(back,24,true);
  mountGlass(next,24,true);
  element.dataset.renderer=views.every(view=>Boolean(view.renderer))?'solarium':'fallback';

  function updateAppearance() {
    element.dataset.materialTheme=dark()?'dark':'light';
    element.dataset.glass=String(!settings.disableSolarium);
    redraw(400);
  }
  function render(focus=true) {
    const current=STEPS[step]; element.dataset.step=current.key;
    symbol.replaceChildren(icon(current.icon));
    heading.textContent=current.title; description.textContent=current.description;
    dots.forEach((item,index)=>index===step?item.setAttribute('aria-current','step'):item.removeAttribute('aria-current'));
    choices.replaceChildren(node('legend','hello-setup__sr-only',current.title));
    const options=step===0?uiStyleOptions.map(o=>({...o,detail:DETAILS[o.value],icon:o.value}))
      :step===1?[{value:'system',label:'Automatic',detail:'Match your system appearance',icon:'system'},
        {value:'light',label:'Light',detail:'A bright appearance',icon:'light'},
        {value:'dark',label:'Dark',detail:'An appearance for darker spaces',icon:'dark'}]
        :[{value:false,label:'Liquid Glass',detail:'Refracted glass with Solarium',icon:'glass'},
          {value:true,label:'Standard',detail:'Simple controls without glass effects',icon:'simple'}];
    for(const option of options) {
      const row=node('label','hello-setup__option');
      const input=node('input'); input.type='radio'; input.name=`hello-${current.key}`;
      input.value=String(option.value); input.checked=settings[current.key]===option.value;
      input.addEventListener('change',()=>{settings[current.key]=option.value;updateAppearance();});
      const copy=node('span','hello-setup__option-copy');
      copy.append(node('strong','',option.label),node('span','hello-setup__detail',option.detail));
      const mark=node('span','hello-setup__check'); mark.append(icon('check'));
      row.append(input,icon(option.icon),copy,mark); choices.append(row);
    }
    back.disabled=step===0;
    nextLabel.textContent=step===STEPS.length-1?'Start Listening':'Continue';
    updateAppearance();
    if(focus) heading.focus({preventScroll:true});
  }
  async function animate(target,keyframes,options) {
    const animation=target.animate(keyframes,{...options,fill:'both'}); animations.add(animation);
    try {await animation.finished;} catch {} finally {animation.cancel();animations.delete(animation);}
  }
  async function go(direction) {
    if(changing||completed||disposed) return;
    changing=true; content.inert=true; element.dataset.transitioning='true';
    if(!motion.matches) await animate(content,[{opacity:1,transform:'none',filter:'blur(0px)'},
      {opacity:0,transform:`translateX(${-direction*24}px)`,filter:'blur(6px)'}],{duration:180,easing:'ease-in'});
    if(disposed) return;
    step+=direction; render(false);
    // Keep the new step hidden while its refracted backdrop is redrawn.
    if(!motion.matches) await animate(content,[{opacity:0,transform:`translateX(${direction*24}px)`,filter:'blur(6px)'},
      {opacity:1,transform:'none',filter:'blur(0px)'}],{duration:420,easing:'cubic-bezier(.16,1,.3,1)'});
    content.inert=false; changing=false; element.dataset.transitioning='false';
    if(!disposed) heading.focus({preventScroll:true});
  }
  back.addEventListener('click',()=>{if(step>0) void go(-1);});
  next.addEventListener('click',async()=>{
    if(changing||completed||disposed) return;
    if(step<STEPS.length-1) {void go(1);return;}
    completed=true; next.disabled=back.disabled=true;
    nextLabel.textContent='Opening…';
    try {await onComplete({...settings});}
    catch {completed=false; next.disabled=false;back.disabled=false;nextLabel.textContent='Try Again';}
  });
  function tick() {
    if(disposed) return;
    if(isBackdropPlaying()) redraw();
    frame=requestAnimationFrame(tick);
  }
  const observer=new ResizeObserver(()=>redraw(500));
  observer.observe(group); observer.observe(next); observer.observe(element);
  appearance.addEventListener('change',updateAppearance);
  render(false); frame=requestAnimationFrame(tick);
  return {element, focus:()=>heading.focus({preventScroll:true}),
    destroy() {
      if(disposed) return;
      disposed=true;cancelAnimationFrame(frame);observer.disconnect();
      appearance.removeEventListener('change',updateAppearance);
      for(const animation of animations) animation.cancel();
      for(const view of views) view.dispose();
    }};
}
