import {workspaceAPI} from './workspace-client.mjs';
import {getOfficeFile,putOfficeFiles} from './office-files.mjs';

const collections=['projects','tasks','knowledge','skills','staff','teams','files','chats'];
const encoder=new TextEncoder(),decoder=new TextDecoder();
const equal=(a,b)=>JSON.stringify(a||[])===JSON.stringify(b||[]);
const b64=bytes=>btoa(String.fromCharCode(...bytes));
const unb64=s=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));

async function parallel(items,fn,limit=4){
  let index=0;
  await Promise.all(Array.from({length:Math.min(limit,items.length)},async()=>{
    while(index<items.length){const item=items[index++];await fn(item);}
  }));
}
async function hash(bytes){
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),n=>n.toString(16).padStart(2,'0')).join('');
}

export function teamSync({scope,read,persist,notify,canApply}){
  const baseKey=scope+'/sync-index';
  let base=JSON.parse(localStorage.getItem(baseKey)||'null'),pending,again=false,first=true;
  const cache=new Map();
  let conflicts=[];
  const setStatus=(text)=>{const el=document.querySelector('[data-sync-status]');if(el)el.textContent=text;controller.status=text;};
  function collect(){
    const state=read(),out=new Map();
    for(const group of collections){
      for(const item of state[group]){
        // Scheduler records and their downloaded binary cache have their own server ledger.
        if(group==='tasks'&&item.scheduled||group==='files'&&item.remote)continue;
        out.set(group+'/'+item.id,JSON.stringify(item));
        if(group==='files'&&item.storedOffice)out.set('office/'+item.id,item.id);
      }
    }
    const {theme,...brand}=state.profile;
    out.set('settings/profile',JSON.stringify(brand));
    return out;
  }
  async function encode(key,value){
    const last=cache.get(key);
    if(last&&last.value===value)return last;
    const binary=key.startsWith('office/');
    const blob=binary?await getOfficeFile(value):null;
    if(binary&&!blob)throw Error('本机缺少文件原件，请从保有原件的设备同步');
    const bytes=binary?new Uint8Array(await blob.arrayBuffer()):encoder.encode(value);
    const parts=[],blocks=[];
    for(let i=0;i<bytes.length;i+=40000){
      const piece=bytes.subarray(i,i+40000);
      blocks.push(piece);parts.push(await hash(piece));
    }
    const result={value,parts,blocks};cache.set(key,result);return result;
  }
  async function receive(key,parts){
    if(!parts.length)return null;
    const blocks=[];
    for(const digest of parts){
      const {data}=await workspaceAPI('syncGet',{params:{hash:digest}});
      const bytes=unb64(data);
      if(await hash(bytes)!==digest)throw Error('同步内容校验失败');
      blocks.push(bytes);
    }
    const blob=new Blob(blocks);
    if(key.startsWith('office/'))return blob;
    return JSON.parse(decoder.decode(await blob.arrayBuffer()));
  }
  function apply(key,item){
    const state=read(),[group,id]=key.split('/');
    if(group==='settings'){if(item)for(const field of ['name','brandName','icon','logo']){if(typeof item[field]==='string')state.profile[field]=item[field];else if(field!=='name')delete state.profile[field];}return;}
    if(!collections.includes(group))return;
    const idx=state[group].findIndex(r=>r.id===id);
    if(item){if(item.id!==id)throw Error('记录标识不一致');if(idx<0)state[group].unshift(item);else state[group][idx]=item;}
    else if(idx>=0)state[group].splice(idx,1);
  }
  async function cycle(force){
    const remote=(await workspaceAPI('syncIndex')).records;
    const snapshot=collect(),keys=new Set([...Object.keys(base||{}),...snapshot.keys(),...Object.keys(remote)]);
    const downloads=[],uploads=[],updates=[],same=[],collisions=[];
    const restore=base===null&&Object.keys(remote).length>0;
    for(const key of keys){
      const old=base?.[key]||[],server=remote[key]||[],value=snapshot.get(key);
      if(restore){downloads.push(key);continue;}
      const current=value===undefined?[]:(await encode(key,value)).parts;
      if(equal(current,server)){same.push(key);continue;}
      if(!equal(server,old)&&!equal(current,old)&&force?.[key]!=='remote'&&force?.[key]!=='local'){
        collisions.push(key);continue;
      }
      if(force?.[key]==='remote'||!equal(server,old)&&force?.[key]!=='local'){downloads.push(key);continue;}
      uploads.push(key);updates.push({key,parts:current,base:server});
    }
    const checkpoint={...base};
    for(const key of same){if(remote[key])checkpoint[key]=remote[key];else delete checkpoint[key];}
    const known=new Set(Object.values(remote).flat()),blocks=new Map();
    for(const key of uploads){
      const item=cache.get(key);if(!snapshot.has(key)||!item)continue;
      item.parts.forEach((part,i)=>{if(!known.has(part))blocks.set(part,item.blocks[i]);});
    }
    await parallel([...blocks],([digest,bytes])=>workspaceAPI('syncPut',{params:{hash:digest,data:b64(bytes)}}));
    while(updates.length){
      const changes=updates.splice(0,80),r=await workspaceAPI('syncCommit',{params:{changes}});
      if(r.conflict){again=true;return;}
      for(const {key,parts} of changes){if(parts.length)checkpoint[key]=parts;else delete checkpoint[key];}
      localStorage.setItem(baseKey,JSON.stringify(checkpoint));
      base={...checkpoint};
    }
    const incoming=new Map();
    await parallel(downloads,async key=>incoming.set(key,await receive(key,remote[key]||[])));
    const now=collect(),binary=[];
    for(const key of downloads){
      const item=incoming.get(key);
      if(now.get(key)!==snapshot.get(key)){again=true;continue;}
      if(key.startsWith('office/')&&item)binary.push({id:key.slice(7),blob:item});
    }
    if(binary.length)await putOfficeFiles(binary);
    const latest=collect();
    for(const key of downloads){
      const item=incoming.get(key);
      if(latest.get(key)!==snapshot.get(key)){again=true;continue;}
      if(!key.startsWith('office/'))apply(key,item);
      if(remote[key])checkpoint[key]=remote[key];else delete checkpoint[key];
      cache.delete(key);
    }
    const conflictsChanged=!equal(conflicts,collisions);
    conflicts=collisions;controller.conflicts=collisions;
    if(incoming.size){if(!persist())throw Error('设备存储空间不足，无法保存同步内容');notify();}
    if(conflictsChanged&&!incoming.size)notify();
    localStorage.setItem(baseKey,JSON.stringify(checkpoint));
    base=checkpoint;first=false;
    setStatus(collisions.length?'有 '+collisions.length+' 项同时修改，请选择版本':'已同步');
  }
  const controller={status:'正在同步',conflicts:[],async flush(force){
    if(pending){again=true;await pending;if(force)return controller.flush(force);return;}
    pending=(async()=>{
      do{
        again=false;setStatus('正在同步…');await cycle(force);force=null;
      }while(again);
    })();
    try{await pending;}catch(error){setStatus(error.message||'暂时无法同步');throw error;}finally{pending=null;}
  },changed(){
    if(!first)setStatus('待同步');
    clearTimeout(controller.timer);
    controller.timer=setTimeout(()=>{if(!first)controller.flush().catch(()=>{});},180);
  }};
  const tick=()=>{if(!document.hidden&&canApply()&&!pending)controller.flush().catch(()=>{});};
  window.addEventListener('online',tick);window.addEventListener('focus',tick);
  document.addEventListener('visibilitychange',tick);setInterval(tick,25000);
  return controller;
}
