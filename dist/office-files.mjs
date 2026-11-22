function openOfficeStore() {
  return new Promise((resolve,reject)=>{
    const request=indexedDB.open('workspace-office-files',1);
    request.onupgradeneeded=()=>request.result.createObjectStore('files');
    request.onsuccess=()=>resolve(request.result);
    request.onerror=()=>reject(request.error);
  });
}
async function officeTransaction(mode, action) {
  const db=await openOfficeStore();
  try {
    return await new Promise((resolve,reject)=>{
      const tx=db.transaction('files',mode);
      const request=action(tx.objectStore('files'));
      tx.oncomplete=()=>resolve(request?.result);
      tx.onabort=tx.onerror=()=>reject(tx.error||Error('文件存储不可用'));
    });
  } finally {db.close();}
}
export function putOfficeFiles(files) {
  return officeTransaction('readwrite',store=>{for(const {id,blob} of files)store.put(blob,id);});
}
export function getOfficeFile(id) {return officeTransaction('readonly',store=>store.get(id));}
export function removeOfficeFile(id) {return officeTransaction('readwrite',store=>id?store.delete(id):store.clear());}

// Office uploads stay in the browser. Read only the text-bearing XML parts, with
// expanded-size limits before and during decompression.
async function officeParts(file) {
  const raw=new Uint8Array(await file.arrayBuffer());
  const view=new DataView(raw.buffer);
  const u16=i=>view.getUint16(i,true), u32=i=>view.getUint32(i,true);
  let end=raw.length-22;
  while(end>=Math.max(0,raw.length-65557)&&u32(end)!==0x06054b50)end--;
  if(end<0||u32(end)!==0x06054b50||u16(end+10)>2500)throw Error('无法识别文件目录');
  const parts=new Map();
  let total=0;
  for(let n=0,pos=u32(end+16);n<u16(end+10);n++) {
    if(u32(pos)!==0x02014b50)throw Error('文件目录不完整');
    const size=u32(pos+24), packed=u32(pos+20), local=u32(pos+42), method=u16(pos+10);
    const name=new TextDecoder().decode(raw.subarray(pos+46,pos+46+u16(pos+28)));
    pos+=46+u16(pos+28)+u16(pos+30)+u16(pos+32);
    if(!/^(word\/document|ppt\/(slides\/slide\d+|presentation|_rels\/presentation.xml.rels)|xl\/(sharedStrings|workbook|worksheets\/sheet\d+|_rels\/workbook.xml.rels))(\.xml)?$/.test(name))continue;
    if(size>3_000_000||(total+=size)>7_000_000||parts.size>=140||u32(local)!==0x04034b50)throw Error('文件超出预览范围');
    const start=local+30+u16(local+26)+u16(local+28);
    if(start+packed>raw.length||![0,8].includes(method))throw Error('文件压缩内容无效');
    let stream=new Blob([raw.subarray(start,start+packed)]).stream();
    if(method===8)stream=stream.pipeThrough(new DecompressionStream('deflate-raw'));
    const reader=stream.getReader(),chunks=[];
    let length=0;
    for(;;) {
      const {done,value}=await reader.read();
      if(done)break;
      if((length+=value.length)>size){await reader.cancel();throw Error('文件内容超限');}
      chunks.push(value);
    }
    if(length!==size)throw Error('文件内容不完整');
    const xml=await new Blob(chunks).text();
    if(/<!DOCTYPE/i.test(xml))throw Error('不支持此 XML 文档');
    const doc=new DOMParser().parseFromString(xml,'application/xml');
    if(doc.getElementsByTagName('parsererror').length)throw Error('文件 XML 不完整');
    parts.set(name,doc);
  }
  return parts;
}
const tags=(el,name)=>Array.from(el?.getElementsByTagNameNS('*',name)||[]);
const words=el=>tags(el,'t').map(t=>t.textContent).join('');
export async function readOfficeUpload(file,ext) {
  const parts=await officeParts(file);
  if(ext==='docx')return tags(parts.get('word/document.xml'),'p').map(words).filter(Boolean).join('\n').slice(0,24000);
  const base=ext==='xlsx'?'xl':'ppt', main=ext==='xlsx'?'workbook':'presentation';
  const relationNodes=tags(parts.get(base+'/_rels/'+main+'.xml.rels'),'Relationship');
  const paths=new Map(relationNodes.map(r=>[r.getAttribute('Id'),new URL(r.getAttribute('Target'),'https://office.invalid/'+base+'/').pathname.slice(1)]));
  const document=parts.get(base+'/'+main+'.xml');
  const items=tags(document,ext==='xlsx'?'sheet':'sldId');
  const shared=tags(parts.get('xl/sharedStrings.xml'),'si').map(words);
  const paragraphs=[];
  for(const [i,item] of items.entries()){
    const path=paths.get(item.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships','id'));
    const doc=parts.get(path);
    if(!doc)continue;
    if(ext==='pptx')paragraphs.push('第 '+(i+1)+' 页',...tags(doc,'p').map(words).filter(Boolean));
    else {
      paragraphs.push(item.getAttribute('name'));
      for(const row of tags(doc,'row').slice(0,250)){
        paragraphs.push(tags(row,'c').map(c=>{
          const val=tags(c,'v')[0]?.textContent||'', ref=c.getAttribute('r')||'';
          const formula=tags(c,'f')[0]?.textContent;
          const value=formula?'='+formula:c.getAttribute('t')==='s'?shared[Number(val)]:c.getAttribute('t')==='inlineStr'?words(c):val;
          return ref+' '+(value||'');
        }).join(' | '));
      }
    }
    if(paragraphs.join('\n').length>24000)break;
  }
  return paragraphs.join('\n').trim().slice(0,24000);
}
