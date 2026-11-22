// The illustration runs independently of the sign-in form, including while a request is pending.
const reduced=matchMedia('(prefers-reduced-motion: reduce)');
const compact=matchMedia('(max-width: 720px)');
const durations=[1350,2100,7400];
let scene=0,phase=0,remaining=durations[0],paused=false;
class BusinessStory extends HTMLElement {
  connectedCallback(){
    this.controller=new AbortController();
    const options={signal:this.controller.signal};
    this.listen=()=>{
      this.stop();
      this.paint();
      const visible=!compact.matches||this.closest('section')?.classList.contains('story-expanded');
      if(!paused&&!document.hidden&&!reduced.matches&&visible&&!this.querySelector('[data-story-slide] :focus')){
        this.started=performance.now();
        this.timer=setTimeout(()=>{
          this.started=null;
          if(phase===2){scene=(scene+1)%3;phase=0;}else phase++;
          remaining=durations[phase];this.listen();
        },remaining);
      }
    };
    this.addEventListener('click',event=>{
      const control=event.target.closest('[data-scene],[data-play-story]');
      if(!control)return;
      this.stop();
      if(control.hasAttribute('data-scene')){scene=Number(control.dataset.scene);phase=paused?2:0;remaining=durations[phase];}
      else paused=!paused;
      this.listen();
    },options);
    document.addEventListener('visibilitychange',this.listen,options);
    this.addEventListener('focusin',this.listen,options);
    this.addEventListener('focusout',()=>queueMicrotask(()=>{if(this.isConnected)this.listen();}),options);
    reduced.addEventListener('change',this.listen,options);
    compact.addEventListener('change',this.listen,options);
    this.listen();
  }
  stop(){
    if(this.started!=null)remaining=Math.max(0,remaining-(performance.now()-this.started));
    this.started=null;clearTimeout(this.timer);
  }
  disconnectedCallback(){this.stop();this.controller.abort();}
  paint(){
    const step=reduced.matches?2:phase;
    this.querySelectorAll('[data-story-slide]').forEach((el,i)=>{
      el.hidden=i!==scene;el.inert=i!==scene;
      for(const item of el.querySelectorAll('[data-reveal]')){
        const visible=Number(item.dataset.reveal)<=step;item.inert=!visible;item.setAttribute('aria-hidden',String(!visible));item.classList.toggle('story-revealed',visible);
      }
    });
    this.querySelectorAll('[data-scene]').forEach((el,i)=>el.setAttribute('aria-pressed',String(i===scene)));
    const toggle=this.querySelector('[data-play-story]');
    toggle.hidden=reduced.matches;toggle.setAttribute('aria-label',paused?toggle.dataset.play:toggle.dataset.pause);
    toggle.title=toggle.getAttribute('aria-label');
    toggle.querySelector('[data-playing]').hidden=paused;toggle.querySelector('[data-paused]').hidden=!paused;
  }
}
customElements.define('business-story',BusinessStory);
