const preference=matchMedia('(prefers-reduced-motion: reduce)');
let lastView='';
let sequence=0;
let context;
let engine;

function loadMotion() {
  engine??=new Promise(resolve=>{
    const script=document.createElement('script');
    script.src='/vendor/gsap.min.js';
    script.onload=()=>resolve(window.gsap);
    script.onerror=()=>resolve(null);
    document.head.append(script);
  });
  return engine;
}
preference.addEventListener('change',()=>{
  sequence++;
  context?.revert();
});

export async function refreshWorkspaceMotion({route,homeTab,caseFilter,libraryLayout,fileType,overviewStage,scheduleDay}) {
  const host=document.querySelector('[data-display],.case-library');
  const area=host?.dataset.display || (host?'cases':'');
  const stateKey=area==='library'?[caseFilter,libraryLayout,fileType].join('/') :
    area==='project-overview'?overviewStage:area==='task-types'?scheduleDay:area==='cases'?homeTab:'';
  const key=route+'/'+area+'/'+stateKey;
  const old=lastView;
  const tick=++sequence;
  lastView=key;
  context?.revert();
  context=undefined;
  if (!host || old===key || preference.matches) return;
  const gsap=await loadMotion();
  if (!gsap || preference.matches || tick!==sequence || !host.isConnected) return;
  const entering=!old.startsWith(route+'/'+area+'/');
  context=gsap.context(()=>{
    const reveal=(selector,vars={})=>{
      const items=[...host.querySelectorAll(selector)].slice(0,10);
      if (items.length) gsap.from(items,{y:7,opacity:.26,duration:.26,stagger:.024,ease:'power2.out',clearProps:'transform,opacity',...vars});
    };
    if (entering && (area==='library'||area==='cases')) {
      reveal('.dossier-card',{y:10});
      reveal('.folio-face',{y:11,rotation:3,opacity:.9,delay:.07,duration:.38,stagger:.065});
    }
    if(area==='library') reveal('.library-row,.file-tile',{duration:.18,stagger:.014});
    if(area==='project-files') reveal('.file-tile');
    if(area==='project-activity') reveal('.activity-feed article');
    if(area==='project-overview') {
      if(entering) reveal('.pulse-plot .filled',{y:0,scaleY:.15,transformOrigin:'bottom',duration:.35});
      reveal('.stage-items button',{x:4,y:0});
    }
    if(area==='task-types') {
      if(entering) reveal('.week-strip button');
      reveal('.day-agenda button',{y:4});
    }
  },host);
}

export async function animateEditor(dialog) {
  if(preference.matches) return;
  const form=dialog.querySelector('form');
  const gsap=await loadMotion();
  if(!gsap || !dialog.open || !form?.isConnected || preference.matches) return;
  const media=gsap.matchMedia();
  media.add('(prefers-reduced-motion: no-preference)',()=>{
    gsap.from(form,{y:6,opacity:.5,duration:.2,ease:'power2.out',clearProps:'transform,opacity'});
  });
  dialog.addEventListener('close',()=>media.revert(),{once:true});
}
