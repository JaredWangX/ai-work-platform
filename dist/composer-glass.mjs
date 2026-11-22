// One reusable reflection surface for both composers, created on first pointer interaction.
const reducedMotion=matchMedia('(prefers-reduced-motion: reduce)');
let surface;
function createSurface(){
  const canvas=document.createElement('canvas');
  canvas.className='glass-reflection';canvas.setAttribute('aria-hidden','true');
  let composer;
  const gl=canvas.getContext('webgl',{alpha:true,premultipliedAlpha:false,antialias:false,depth:false,powerPreference:'low-power'});
  const fallback=gl?null:canvas.getContext('2d');
  const maxWaves=12,waveUniforms=new Float32Array(maxWaves*4);
  let program=null,uniforms=null,waves=[],waterFrame=0,lastPaint=0,waterWidth=0,waterHeight=0,lastPointer=null,lastEmission=0;
  let contextLost=false,fallbackImage=null;
  function initWater(){
    if(!gl)return;
    const vertex='attribute vec2 aPosition;void main(){gl_Position=vec4(aPosition,0.0,1.0);}';
    const fragment=[
      'precision highp float;',
      'uniform vec2 uResolution;uniform vec2 uSize;uniform vec4 uWaves[12];uniform float uDark;',
      'float lightField(vec2 uv){',
      'float a=(uv.x*0.72+uv.y*0.43-0.27)*2.7;',
      'float b=(uv.x*0.88-uv.y*0.31-0.39)*7.0;',
      'return exp(-a*a)*0.6+exp(-b*b)*0.22;}',
      'void main(){',
      'vec2 uv=vec2(gl_FragCoord.x/uResolution.x,1.0-gl_FragCoord.y/uResolution.y);',
      'vec2 p=uv*uSize;vec2 slope=vec2(0.0);float curvature=0.0;',
      'for(int i=0;i<12;i++){',
      'vec4 w=uWaves[i];if(w.z<0.0)continue;',
      'vec2 delta=p-w.xy;float r=max(length(delta),0.8);float radius=w.z*176.0;',
      'float spread=16.0+w.z*8.0;float q=r-radius;float s2=spread*spread;',
      'float envelope=exp(-q*q/s2)*exp(-w.z*1.3)/sqrt(1.0+radius*0.012);',
      'float phase=q*0.215;float si=sin(phase);float co=cos(phase);',
      'float amp=w.w*envelope;float derivative=amp*(0.215*co-2.0*q/s2*si);',
      'slope+=delta/r*derivative;',
      'curvature+=amp*((4.0*q*q/(s2*s2)-2.0/s2-0.046225)*si-0.86*q/s2*co)+derivative/r;}',
      'float refraction=lightField(uv+slope*0.07)-lightField(uv);',
      'float tone=dot(slope,vec2(-0.62,0.87))*1.48+curvature*1.7+refraction*0.85;',
      'float opacity=clamp(abs(tone)*0.78,0.0,0.32);',
      'vec3 shadow=mix(vec3(0.36,0.49,0.65),vec3(0.31,0.48,0.70),uDark);',
      'vec3 reflection=mix(vec3(1.0),vec3(0.78,0.89,1.0),uDark);',
      'vec3 color=mix(shadow,reflection,smoothstep(-0.015,0.015,tone));',
      'gl_FragColor=vec4(color,opacity);}'
    ].join('\n');
    const compile=(type,source)=>{const shader=gl.createShader(type);gl.shaderSource(shader,source);gl.compileShader(shader);if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS)){gl.deleteShader(shader);return null;}return shader;};
    const vs=compile(gl.VERTEX_SHADER,vertex),fs=compile(gl.FRAGMENT_SHADER,fragment);
    if(!vs||!fs){canvas.dataset.waterRenderer='unavailable';return;}
    program=gl.createProgram();gl.attachShader(program,vs);gl.attachShader(program,fs);gl.linkProgram(program);
    if(!gl.getProgramParameter(program,gl.LINK_STATUS)){program=null;canvas.dataset.waterRenderer='unavailable';return;}
    gl.useProgram(program);const buffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,1,1]),gl.STATIC_DRAW);
    const position=gl.getAttribLocation(program,'aPosition');gl.enableVertexAttribArray(position);gl.vertexAttribPointer(position,2,gl.FLOAT,false,0,0);
    uniforms={resolution:gl.getUniformLocation(program,'uResolution'),size:gl.getUniformLocation(program,'uSize'),waves:gl.getUniformLocation(program,'uWaves[0]'),dark:gl.getUniformLocation(program,'uDark')};
    gl.deleteShader(vs);gl.deleteShader(fs);canvas.dataset.waterRenderer='webgl';gl.clearColor(0,0,0,0);
  }
  function resizeWater(){
    const rect=composer.getBoundingClientRect();if(rect.width<1||rect.height<1)return;
    waterWidth=rect.width;waterHeight=rect.height;const density=gl?Math.min(devicePixelRatio||1,1.4):Math.min(.42,220/rect.width);
    const width=Math.max(1,Math.round(rect.width*density)),height=Math.max(1,Math.round(rect.height*density));
    if(canvas.width===width&&canvas.height===height)return;
    canvas.width=width;canvas.height=height;waves=[];
    if(gl&&!contextLost)gl.viewport(0,0,width,height);
    if(fallback)fallbackImage=fallback.createImageData(width,height);
  }
  function clearWater(){if(gl&&!contextLost)gl.clear(gl.COLOR_BUFFER_BIT);else fallback?.clearRect(0,0,canvas.width,canvas.height);}
  function paintWater(now){
    waves=waves.filter(wave=>now-wave.at<3100);waveUniforms.fill(-1);
    waves.forEach((wave,index)=>waveUniforms.set([wave.x*waterWidth,wave.y*waterHeight,(now-wave.at)/1000,wave.amplitude],index*4));
    if(gl&&program&&!contextLost){
      gl.useProgram(program);gl.uniform2f(uniforms.resolution,canvas.width,canvas.height);gl.uniform2f(uniforms.size,waterWidth,waterHeight);gl.uniform4fv(uniforms.waves,waveUniforms);gl.uniform1f(uniforms.dark,document.documentElement.dataset.theme==='dark'?1:0);gl.drawArrays(gl.TRIANGLE_STRIP,0,4);
    }else if(fallback&&fallbackImage){
      const pixels=fallbackImage.data;pixels.fill(0);
      for(let y=0;y<canvas.height;y++)for(let x=0;x<canvas.width;x++){
        const px=x/canvas.width*waterWidth,py=y/canvas.height*waterHeight;let sx=0,sy=0;
        for(const wave of waves){const age=(now-wave.at)/1000,dx=px-wave.x*waterWidth,dy=py-wave.y*waterHeight,r=Math.max(.8,Math.hypot(dx,dy)),radius=age*176,q=r-radius,spread=16+age*8,s2=spread*spread,amp=wave.amplitude*Math.exp(-q*q/s2-age*1.3)/Math.sqrt(1+radius*.012),d=amp*(.215*Math.cos(q*.215)-2*q/s2*Math.sin(q*.215));sx+=dx/r*d;sy+=dy/r*d;}
        const tone=(-sx*.62+sy*.87)*1.48,highlight=tone>0,index=(y*canvas.width+x)*4;pixels[index]=highlight?255:92;pixels[index+1]=highlight?255:125;pixels[index+2]=highlight?255:166;pixels[index+3]=Math.min(82,Math.abs(tone)*199);
      }
      fallback.putImageData(fallbackImage,0,0);
    }
  }
  function animateWater(now){
    waterFrame=0;if(document.hidden||!composer.isConnected||reducedMotion.matches||contextLost)return;
    if(now-lastPaint>(gl?15:32)){paintWater(now);lastPaint=now;}
    if(waves.length)waterFrame=requestAnimationFrame(animateWater);else clearWater();
  }
  function runWater(){if(!waterFrame&&!document.hidden&&!reducedMotion.matches&&!contextLost)waterFrame=requestAnimationFrame(animateWater);}
  function disturbWater(event,click=false){
    if(reducedMotion.matches||(!program&&!fallback))return;
    const rect=composer.getBoundingClientRect(),x=(event.clientX-rect.left)/rect.width,y=(event.clientY-rect.top)/rect.height;
    if(x<0||x>1||y<0||y>1)return;
    const now=performance.now(),previous=lastPointer,distance=previous?Math.hypot((x-previous.x)*rect.width,(y-previous.y)*rect.height):20;
    if(!click&&previous&&(distance<18||now-lastEmission<65))return;
    const speed=previous?distance/Math.max(16,now-previous.at):.25;
    const amplitude=click?1.25:Math.min(.64,.28+speed*.16),steps=click||!previous?1:Math.min(3,Math.max(1,Math.floor(distance/32)));
    for(let step=1;step<=steps;step++){const blend=step/steps;waves.push({x:previous&&!click?previous.x+(x-previous.x)*blend:x,y:previous&&!click?previous.y+(y-previous.y)*blend:y,at:now-(steps-step)*14,amplitude:amplitude*(.94+blend*.06)});}
    if(waves.length>maxWaves)waves.splice(0,waves.length-maxWaves);
    lastPointer={x,y,at:now};lastEmission=now;runWater();
  }

  initWater();
  if(fallback)canvas.dataset.waterRenderer='canvas';
  const reset=()=>{cancelAnimationFrame(waterFrame);waterFrame=0;waves=[];lastPointer=null;clearWater();};
  reducedMotion.addEventListener('change',reset);
  document.addEventListener('visibilitychange',()=>{if(document.hidden)reset();});
  canvas.addEventListener('webglcontextlost',event=>{event.preventDefault();contextLost=true;reset();});
  canvas.addEventListener('webglcontextrestored',()=>{contextLost=false;initWater();});
  return (host,event)=>{
    if(host!==composer){
      reset();composer=host;composer.prepend(canvas);resizeWater();
    }else if(Math.abs(canvas.clientWidth-waterWidth)>3||Math.abs(canvas.clientHeight-waterHeight)>3)resizeWater();
    disturbWater(event,event.type==='pointerdown');
  };
}
for(const type of ['pointermove','pointerdown']){
  document.addEventListener(type,event=>{
    if(event.pointerType!=='mouse'||reducedMotion.matches)return;
    const host=event.target.closest?.('.home-compose,.composer.panel');
    if(!host)return;
    surface??=createSurface();surface(host,event);
  },{passive:true});
}
