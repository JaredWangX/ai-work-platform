import {teamSync} from './team-sync.mjs';
import {apiUrl} from './api.mjs';
import {databases,workspaceAPI,workspaceToken} from './workspace-client.mjs';
import { putOfficeFiles, getOfficeFile, removeOfficeFile, readOfficeUpload } from './office-files.mjs';
import { refreshWorkspaceMotion, animateEditor } from './workspace-motion.mjs';
import { groups, seed } from './data.js';
import { icon } from './icons.js';
import { examples, exampleFiles, featuredCases, fileText } from './showcase.js';
import { readEvents } from './events.mjs';
import { renderMarkdown } from './markdown.mjs';
import { commandExamples } from './commands.mjs';

const app = document.querySelector('#app');
const dialog = document.querySelector('#dialog');
let account=JSON.parse(localStorage.getItem('workspace-account-info')||'null');
if(!localStorage.getItem('workspace-account-session'))account=null;
const guestKey='workspace-workspace-v1';
const accountKey=info=>guestKey+'/'+info.space+'/'+info.person.id;
const storageKey=account?accountKey(account):guestKey;
let syncController,teamDirectory,preferenceRev=0;
let syncNeedsRender=false;

const pageNames = Object.fromEntries(groups.flatMap(([, links]) => links.map(([key, name]) => [key, name])));
Object.assign(pageNames,{login:'登录',register:'注册'});
const statusNames = ['待开始','进行中','已完成'];
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => (
  {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]
));
const uid = () => crypto.randomUUID();
const byId = (key,id) => state[key].find(item => item.id === id);
const selected = (a,b) => a === b ? ' selected' : '';
const avatar = name => escape(name.trim().slice(0,1) || 'O');
const compactChat = () => innerWidth <= 899;

function load(reset = false) {
  let existing;
  if (!reset) try { existing=JSON.parse(localStorage.getItem(storageKey)); } catch {}
  const workspace=existing || structuredClone(seed);
  for (const key of ['memoryEnabled','preferences','tools','invites']) {
    if (!Object.hasOwn(workspace,key)) workspace[key]=structuredClone(seed[key]);
  }
  if (!workspace.portfolioCases) {
    const samples=examples.map(makeExample);
    const legacyIds=new Set(['weekly','sales']);
    workspace.chats=workspace.chats.filter(chat=>!legacyIds.has(chat.id)||chat.messages.length>2);
    const superseded={report:'case-weekly-doc',channels:'case-sales',refunds:'case-refunds',
      'example-weekly':'case-weekly-doc','example-refunds':'case-refunds','example-sales':'case-sales','example-launch':'case-launch'};
    for (const chat of workspace.chats) {
      for (const message of chat.messages) {
        if (message.files) message.files=message.files.map(id=>superseded[id]||id);
      }
    }
    workspace.files=workspace.files.filter(file=>!Object.hasOwn(superseded,file.id));
    workspace.chats.push(...samples);
    workspace.files.push(...structuredClone(exampleFiles));
    workspace.portfolioCases=true;
  }
  if (!workspace.caseLibraryV2) {
    const additions=new Set(['case-launch-input','case-launch-deck','case-launch-checks','case-research-input','case-evidence']);
    for (const file of exampleFiles) {
      const present=workspace.files.find(item=>item.id===file.id);
      if (!present && additions.has(file.id)) workspace.files.push(structuredClone(file));
      if (present && file.id==='case-research') Object.assign(present,structuredClone(file));
    }
    for (const example of featuredCases) {
      const chat=workspace.chats.find(item=>item.id==='portfolio-'+example.id);
      if (!chat || chat.messages[1]?.mode!=='demo') continue;
      const template=makeExample(example);
      if (example.input) chat.messages[0].attachments=[...new Set([...(chat.messages[0].attachments||[]),example.input])];
      Object.assign(chat.messages[1],structuredClone(example.reply),{files:[...new Set([...(chat.messages[1].files||[]),...example.reply.files])]});
      if (chat.messages.length===2) chat.messages.push(...template.messages.slice(2));
    }
    for (const [id,file] of [['p5','case-launch-checks'],['p6','case-launch-input']]) {
      const task=workspace.projects.find(item=>item.id===id);
      if (task && !Object.hasOwn(task,'file')) task.file=file;
    }
    const researchTask=workspace.tasks.find(item=>item.id==='t2');
    if (researchTask && researchTask.runs.length===0 && researchTask.description===seed.tasks.find(item=>item.id==='t2').description) {
      researchTask.runs=[
        {at:'11/19 10:00',seconds:32,status:'success',example:true,text:'两份报价的安装服务范围不同。甲含上门安装，乙单列安装费。产品运营需取得同地址、同配置的报价后，再比较总价。',logs:['读取调研摘录 R03','对照两种安装条款','登记后续补证人'],files:['case-research-input','case-evidence']},
        {at:'11/18 10:00',seconds:28,status:'success',example:true,text:'12 个样本站点中，5 个附工作日晚间巡检时间。剩余 7 站只记录了地址。下轮调查按站点补录时段和实际等待时间。',logs:['读取样本站点与访谈摘录','区分站点记录和个人反馈'],files:['case-research-input']},
      ];
    }
    workspace.caseLibraryV2=true;
    if (existing) try { localStorage.setItem(storageKey,JSON.stringify(workspace)); } catch {}
  }
  return workspace;
}
function makeExample(example) {
  const messages=[];
  const rounds=[example,...(example.follow?[example.follow]:[])];
  for (const [index,round] of rounds.entries()) {
    const time='2026-11-17T06:0'+index+':';
    messages.push({role:'user',text:round.prompt,at:time+'00Z',attachments:round.input?[round.input]:[]},
      {...structuredClone(round.reply),role:'assistant',mode:'demo',at:time+'01Z',steps:round.steps});
  }
  return {id:'portfolio-'+example.id,example:example.id,title:example.label,updated:messages.at(-1).at,messages};
}
function caseFileIds(example) {
  return [example.input,...example.reply.files,...(example.follow?.reply.files||[])].filter(Boolean);
}

let state = load();
let modelConnections=[];
let connectionCatalogError='';
let connection = {available:false,checking:true};
let activeChat;
let activeNote = state.knowledge[0]?.id;
let noteView = 'read';
let graphNeighborhood = false;
let historyOpen = !compactChat();
let spaceOpen = false;
let mobileMenu = false;
let navCollapsed = false;
let themeMenu = false;
let commandLanguage = 'zh';
let commandIndex = 27;
let commandTimer;
let promptGroup = 'office';
let morePrompts = false;
let archivedChats = false;
let spaceMenu = '';
let spaceGrid = false;
const beijingWeekday=()=>['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].indexOf(new Intl.DateTimeFormat('en-US',{timeZone:'Asia/Shanghai',weekday:'short'}).format(new Date()));
let scheduleDay=beijingWeekday();
let fileType = 'all';
let loading = new Set();
const liveReplies = new Map();
let selectedSkill = '';
let selectedNote = '';
let selectedDatabase = '';
let picker = '';
const draftAttachments=new Map();
function filesForDraft(route=page+'/'+routeDetail) {
  if (!draftAttachments.has(route)) draftAttachments.set(route,[]);
  return draftAttachments.get(route);
}
let workspaceScope = 'current';
let spaceSource = 'artifact';
let spaceType = 'all';
let spaceSort = 'newest';
let spaceGrouping = 'turns';
let spaceSearch = '';
let toastTimer;
let page;
let routeDetail='';
let taskSearch='';
let taskStatus='all';
let taskTag='all';
let runFilter='all';
let runIndex=0;
let overviewStage='进行中';
let activeStaff='';
let activeTeam='';
let staffTab='own';

let personalTab='memory';
let showConversationStart = false;
let homeTab=state.chats.some(chat=>!chat.example || chat.messages.some(m=>m.mode==='live'))?'recent':'cases';
let caseFilter='all';
let fileQuery='';
let libraryLayout='list';
let replay;
let replayTimer;
let previewParent;
const drafts=new Map();
let focusComposer=false;

function toast(text) {
  const node = document.querySelector('#toast');
  node.textContent = text;
  node.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('visible'), 3600);
}
function save() {
  try { localStorage.setItem(storageKey, JSON.stringify(state));syncController?.changed();return true; }
  catch { toast('浏览器存储空间不足，请删除一些文件后再试。'); return false; }
}
function go(key, options) {
  mobileMenu = false;
  if (key !== page) picker='';
  if (location.hash !== '#'+key) {
    picker='';themeMenu=false;spaceMenu='';
    location.hash=key;
  }
  render(options);
}
function button(label, action, options = {}) {
  const {glyph, primary, id, extra = '', title, disabled} = options;
  return `<button type="button" class="button${primary ? ' primary' : ''}${title ? ' icon-button' : ''}" data-action="${action}"${id ? ` data-id="${escape(id)}"` : ''}${title ? ` aria-label="${escape(title)}" title="${escape(title)}"` : ''}${disabled ? ' disabled' : ''} ${extra}>${glyph ? icon(glyph) : ''}${escape(label)}</button>`;
}
function link(label, key, glyph, primary = false) {
  return `<a href="#${key}" class="button${primary ? ' primary' : ''}">${glyph ? icon(glyph) : ''}${escape(label)}</a>`;
}
const badge = (text, kind = '') => `<span class="badge ${kind}">${escape(text)}</span>`;
const empty = text => `<p class="empty">${escape(text)}</p>`;
function heading(title, description, actions = '') {
  const glyph=page!=='home'&&groups.flatMap(([,links])=>links).find(([key])=>key===page)?.[2];
  return `<div class="section-head"><div class="page-identity">${glyph?`<span class="page-symbol" aria-hidden="true">${icon(glyph)}</span>`:''}<div><h1>${escape(title)}</h1><p>${escape(description)}</p></div></div>${actions}</div>`;
}
function nav() {
  const sections=groups.map(([group,links]) => `<div class="nav-group" role="group" aria-label="${group}">
    <p aria-hidden="true">${group==='工作台'?'工作空间':group}</p>
    ${links.map(([key,name,glyph]) => `<a href="#${key}" class="nav-link" title="${name}" ${page===key?'aria-current="page"':''}>${icon(glyph)}<span>${name}</span></a>`).join('')}</div>`);
  return `<aside class="sidebar${mobileMenu ? ' open' : ''}" id="navigation">
    <div class="brand-row"><a class="brand" href="#home" aria-label="${escape(brandName())} 工作台"><img src="${escape(brandImage('logo'))}" width="154" height="51" alt="${escape(brandName())}"><img class="brand-mark" src="${escape(brandImage('icon'))}" width="29" height="29" alt=""></a>
      ${button('','fold-nav',{glyph:'panel-left',title:'收起主导航'})}</div>
    <nav aria-label="工作空间" class="navigation">${sections.join('')}</nav>
    <a class="account" href="#settings" aria-label="个人设置"><span class="account-mark">${icon('user-round')}</span><span><strong>${escape(state.profile.name)}</strong><small>团队工作空间</small></span></a>
  </aside>`;
}
const brandName = () => state.profile.brandName || 'AI 工作平台';
const brandImage = kind => {
  const value=state.profile[kind];
  return typeof value==='string' && /^data:image\/(png|jpeg|webp);base64,[a-z0-9+/=]+$/i.test(value)
    ? value : kind==='logo'?'assets/logo.png':'assets/favicon.png';
};
function beijingTime(value, full = false, seconds = false) {
  if (!value) return '';
  return new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',...(full ? {hour:'2-digit',minute:'2-digit',hourCycle:'h23'} : {}),...(seconds?{second:'2-digit'}:{})}).format(new Date(value)).replaceAll('/','-');
}
function chatFiles(chat) {
  return [...new Set((chat?.messages||[]).flatMap(message=>message.files||[]))].map(id=>byId('files',id)).filter(Boolean);
}
function dossierCover(example) {
  const file=byId('files',example.reply.files[0]);
  const source=file?.sections?.find(section=>section.table)?.table;
  let face=`<span class="folio-blank">${icon(example.icon)}</span>`;
  if (example.id==='operations' && source) {
    face=`<span class="folio-sheet"><b>${escape(file.title)}</b>${source.rows.slice(0,3).map(row=>`<span><i>${escape(row[0])}</i><strong>${escape(row[2])}</strong></span>`).join('')}</span>`;
  } else if (example.id==='launch' && byId('files','case-launch-deck')) {
    face='<img class="folio-slide" src="assets/deliverables/launch-slide-1.webp" alt="">';
  } else if (file) {
    face=`<span class="folio-note"><b>${escape(file.title)}</b>${(source?.rows||[]).slice(0,3).map(row=>`<span><i>${escape(row[0])}</i><u></u></span>`).join('')}</span>`;
  }
  return `<span class="dossier-art art-${example.id}" aria-hidden="true"><span class="folder-back"></span><span class="folio-behind"></span><span class="folio-face">${face}</span><span class="folder-front">${icon(example.icon)}</span></span>`;
}
function dossierCard(example,library=false) {
  const count=caseFileIds(example).filter(id=>byId('files',id)).length;
  return `<button type="button" class="panel dossier-card${library?' library-folder':' case-card'}" data-action="${library?'file-case':'open-example'}" data-id="${example.id}" ${library?`aria-pressed="${caseFilter===example.id}"`:''}>
    ${dossierCover(example)}<span class="dossier-caption"><strong>${escape(example.label)}</strong><small>${escape(example.summary)}</small></span>
    <span class="dossier-count">${count} 份文件</span></button>`;
}
function dashboard() {
  const tasks=state.tasks.slice(0,2);
  const recent=state.chats.filter(item=>!item.archived).toSorted((a,b)=>new Date(b.updated)-new Date(a.updated)).slice(0,3);
  return `<div class="page home">
    ${heading('你好，'+state.profile.name,'发起一项新工作，或继续处理最近的任务。',link('查看团队文件','files','folder-open'))}
    <div class="home-grid"><div class="home-main">
      <section class="panel home-compose" aria-label="发起一项工作">
        <form data-form="home">
          <label class="sr-only" for="home-input">输入你的需求</label>
          <textarea id="home-input" name="prompt" required maxlength="4000" placeholder="把需要完成的工作告诉 AI 工作平台…"></textarea>
          ${resourceChips()}
          <div class="compose-footer"><div class="composer-tools">${uploadControl('添加资料')}${button('选择技能','resource-picker',{id:'skills',glyph:'wand-sparkles',extra:`aria-expanded="${picker==='skills'}"`})}</div><button class="button primary" type="submit">${icon('arrow-up')}开始对话</button></div>
          ${picker ? resourceMenu() : ''}
        </form>
      </section>
      <div class="subhead case-heading"><div class="home-views" role="group" aria-label="选择工作列表">${[['cases','参考案例'],['recent','最近的工作']].map(([id,label])=>button(label,'home-tab',{id,extra:`aria-pressed="${homeTab===id}"`})).join('')}</div>${link('会话历史','chat')}</div>
      ${homeTab==='cases'?`<section class="case-library" aria-label="参考案例">${featuredCases.map(example=>dossierCard(example)).join('')}</section>`:`
      <div class="panel rows">${recent.map(item => `<button class="list-link recent-work" data-action="open-chat" data-id="${item.id}">${icon('messages-square')}<strong>${escape(item.title)}</strong><span>${escape(chatFiles(item)[0]?.name || '')}</span><time>${beijingTime(item.updated)}</time></button>`).join('') || empty('暂无对话')}</div>`}
      <div class="subhead"><h2>我的 AI 员工</h2>${link('查看全部 '+state.staff.length+' 位','staff')}</div>
      <div class="staff-grid">${state.staff.slice(0,3).map(person => `<article class="panel staff-card"><span class="staff-symbol" aria-hidden="true">${staffGlyph(person.id)}</span><h3><button class="card-name" data-action="staff-detail" data-id="${escape(person.id)}" title="${escape(person.name)}">${escape(person.name)}</button></h3><p>${escape(person.description)}</p>
         ${button('发起对话 →','staff-chat',{id:person.id})}</article>`).join('') || empty('暂无 AI 员工')}</div>

    </div><aside class="home-side">
      <section class="panel side-card"><div class="side-title"><h2>定时任务</h2>${link('全部 '+state.tasks.length+' 项','tasks')}</div>
        ${tasks.map(item => `<div class="side-row"><small>${escape(item.time)} · 北京时间</small><strong>${escape(item.name)}</strong><div class="side-row-footer">${badge(item.runs[0] ? (item.runs[0].status==='failed'?'执行失败':'执行成功') : (item.enabled?'等待执行':'已下线'),item.runs[0]?.status==='failed'?'danger':item.runs.length?'success':'')}${button('查看记录','runs',{id:item.id})}</div></div>`).join('') || empty('暂无定时任务')}
      </section>
      <section class="panel side-card"><div class="side-title"><h2>进行中的项目</h2>${icon('kanban')}</div><div class="project-snippet"><strong>新品发布协作</strong><p>发布方案、渠道素材与客户反馈</p></div>
        <div class="stats project-stats">${statusNames.map(status => `<div><strong>${state.projects.filter(item => item.status === status).length}</strong><small>${status}</small></div>`).join('')}</div>${link('打开任务看板 →','projects')}</section>
    </aside></div></div>`;
}
function dataTable(columns,rows) {
  return `<div class="data-table" role="region" aria-label="数据表"><table role="table"><thead><tr>${columns.map(cell => `<th scope="col">${escape(cell)}</th>`).join('')}</tr></thead>
    <tbody role="rowgroup">${rows.map(row => `<tr role="row">${row.map((cell,index) => `<td role="cell"><span class="table-field" aria-hidden="true">${escape(columns[index])}</span>${escape(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}
function answerBody(message) {
  return `<article class="panel answer">${message.title ? `<h2>${escape(message.title)}</h2>` : ''}
    <div class="formatted-text">${renderMarkdown(message.text)}</div>
    ${message.truncated ? '<p class="reply-notice">本次回复已达到长度上限，可继续追问。</p>' : ''}
    ${message.interruption ? `<p class="reply-notice">${escape(message.interruption)}</p>` : ''}
    ${message.rows ? dataTable(message.columns,message.rows) : ''}
    ${message.chart ? `<figure class="sales-chart"><canvas data-values="${escape(JSON.stringify(message.chart))}" role="img" aria-label="上半年销售折线图，单位万元。1 月 42、2 月 48、3 月 45、4 月 62、5 月 68、6 月 84"></canvas><details><summary>查看月度数值</summary>${dataTable(['月份','销售额（万元）'],message.chart)}</details></figure>` : ''}
    ${message.conclusion ? `<div class="answer-next"><h3>下一步</h3><p>${escape(message.conclusion)}</p></div>` : ''}</article>`;
}
function paintCharts() {
  document.querySelectorAll('canvas[data-values]').forEach(canvas=>{
    const values=JSON.parse(canvas.dataset.values);
    const width=canvas.clientWidth;
    if (!width) return;
    const height=canvas.clientHeight;
    const ratio=Math.min(devicePixelRatio,2);
    canvas.width=width*ratio;
    canvas.height=height*ratio;
    const ctx=canvas.getContext('2d');
    ctx.scale(ratio,ratio);
    const style=getComputedStyle(canvas);
    const color=token=>style.getPropertyValue(token);
    const left=36,right=18,top=30,bottom=33;
    const x=index=>left+(width-left-right)*index/(values.length-1);
    const y=value=>top+(height-top-bottom)*(100-value)/100;
    ctx.font='12px system-ui';
    ctx.lineWidth=1;
    ctx.fillStyle=color('--dim');ctx.fillText('万元',6,15);
    for (const value of [0,25,50,75,100]) {
      ctx.fillText(String(value),6,y(value)+4);
      ctx.strokeStyle=color('--line');ctx.beginPath();ctx.moveTo(left,y(value));ctx.lineTo(width-right,y(value));ctx.stroke();
    }
    ctx.beginPath();ctx.moveTo(x(0),y(0));
    values.forEach(([,value],index)=>ctx.lineTo(x(index),y(value)));
    ctx.lineTo(x(values.length-1),y(0));ctx.closePath();ctx.fillStyle=color('--soft');ctx.fill();
    ctx.beginPath();values.forEach(([,value],index)=>index ? ctx.lineTo(x(index),y(value)) : ctx.moveTo(x(index),y(value)));
    ctx.strokeStyle=color('--focus');ctx.lineWidth=2;ctx.stroke();
    ctx.textAlign='center';
    values.forEach(([month,value],index)=>{
      ctx.fillStyle=color('--dim');ctx.fillText(month,x(index),height-10);
      ctx.fillStyle=color('--ink');ctx.fillText(String(value),x(index),y(value)-10);
      ctx.beginPath();ctx.arc(x(index),y(value),4,0,2*Math.PI);
      ctx.fillStyle=color('--panel');ctx.fill();ctx.stroke();
    });
  });
}
function fileFormat(file) {
  return file.name.match(/\.([a-z0-9]{1,8})$/i)?.[1].toUpperCase() || file.type || '文件';
}
function fileBadge(file) {
  const ext=fileFormat(file);
  return `<span class="file-format ${file.type==='表格'?'spreadsheet':''}" aria-hidden="true">${escape(ext.slice(0,4))}</span>`;
}
const exampleAssetSizes = {'weekly-report.docx':39526,'channel-breakdown.xlsx':7622,'channel-source.xlsx':6668,'launch-plan.docx':39372,'monthly-sales.xlsx':8112,'launch-brief.pptx':30008};
function fileSize(file) {
  const asset = exampleFiles.find(item=>item.id===file.id)?.asset;
  const size = file.size ?? exampleAssetSizes[asset] ?? (file.content ? new TextEncoder().encode(file.content).byteLength : 0);
  return size ? (size/1024).toFixed(size<10240?1:0)+' KB' : '';
}
function fileButton(file, details=false) {
  return `<button type="button" class="file-chip" data-action="file-preview" data-id="${file.id}">${fileBadge(file)}<span><strong>${escape(file.name)}</strong>${details===true&&fileSize(file)?`<small>${fileSize(file)}</small>`:''}</span></button>`;
}
function uploadControl(label,kind='attachment',compact=false) {
  return `<label class="button upload-button${compact?' icon-upload':''}" title="${label}">${icon(kind==='attachment'?'paperclip':'upload')}${compact?'':label}<input type="file" data-upload="${kind}" aria-label="${label}" title="PDF 和图片在对话中引用时将由服务器提取文字" accept=".txt,.md,.csv,.pdf,.png,.jpg,.jpeg,.webp,.xlsx,.docx,.pptx"></label>`;
}
const resourceLabels={models:'模型',skills:'技能',knowledge:'知识库',database:'数据库'};
function resourceMenu() {
  const list=picker==='models' ? [{id:'platform',name:'平台模型',description:!modelConnections.some(x=>x.active)?'当前默认':'切换为工作空间默认'},...modelConnections.map(x=>({...x,description:x.model+(x.active?' · 当前默认':'')}))] : state[picker];
  return `<section class="resource-picker" aria-label="选择对话资源"><header>
    <div class="segments" role="group" aria-label="资源类型">${Object.entries(resourceLabels).map(([key,label])=>button(label,'resource-tab',{id:key,extra:`aria-pressed="${key===picker}"`})).join('')}</div>
    ${button('','resource-close',{glyph:'x',title:'关闭资源选择'})}
    </header>
    <input type="search" placeholder="搜索${resourceLabels[picker]}" aria-label="搜索${resourceLabels[picker]}" data-filter="#resource-list">
    <div id="resource-list">${list.map(item=>`<button class="resource-option" type="button" data-action="resource-pick" data-id="${item.id}" data-search="${escape(item.name+' '+(item.description||''))}"><strong>${escape(item.name)}</strong><small>${escape(item.description || '')}</small></button>`).join('') || empty(picker==='models'?modelLabel():'暂无资源')}</div>
    ${picker==='database'?'<p class="picker-note">选择数据源后，助手会执行只读查询，并把查询结果发送给当前模型。</p>':''}
  </section>`;
}
function resourceChips() {
  const resources=[['skills',selectedSkill],['knowledge',selectedNote],['database',selectedDatabase]];
  const chip=(name,action,id)=>`<button type="button" class="button" data-action="${action}" data-id="${escape(id)}" title="${escape(name)}" aria-label="移除 ${escape(name)}">${icon('x')}<span>${escape(name)}</span></button>`;
  return `<div class="resource-chips">${resources.map(([key,id])=>byId(key,id)?chip(byId(key,id).name,'remove-resource',key):'').join('')}
    ${filesForDraft().map(id=>byId('files',id)).filter(Boolean).map(file=>chip(file.name,'remove-attachment',file.id)).join('')}</div>`;
}
function attachedFiles(chat) {
  const ids=[...(chat?.attachments||[]),...(chat?.messages||[]).flatMap(message=>message.attachments||[])];
  return [...new Set(ids)].map(id=>byId('files',id)).filter(Boolean);
}
const spaceTypes=[['all','全部类型','boxes','neutral'],['文档','文档','file-text','blue'],['表格','表格','grid','green'],['幻灯片','幻灯片','layout-dashboard','gold'],['PDF','PDF','file-text','red'],['图片','图片','layout-dashboard','gold'],['Markdown','Markdown','file-text','cyan'],['其他','其他','folder','neutral']];
const fileTypes=spaceTypes.slice(1).map(([id])=>id);
const fileCategory=file=>({pdf:'PDF',md:'Markdown',ppt:'幻灯片',pptx:'幻灯片'}[file.name.split('.').at(-1).toLowerCase()]||file.type);
function spaceFilter(key, options, active, glyph, title) {
  const option=options.find(item=>item[0]===active) || options[0];
  return `<div class="space-filter">
    <button class="button filter-trigger" type="button" data-action="space-menu" data-id="${key}" data-testid="${key}-filter" aria-haspopup="menu" aria-expanded="${spaceMenu===key}">
      <span class="filter-icon">${icon(glyph)}</span><span>${option[1]}</span>${icon('chevron-down')}</button>
    ${spaceMenu===key?`<div class="control-menu filter-menu" role="menu" aria-label="${title}"><strong>${title}</strong>
      ${options.map(([id,label,iconName,tone])=>`<button class="filter-item" type="button" role="menuitemradio" aria-checked="${id===active}" data-action="space-filter" data-filter-key="${key}" data-id="${id}">
        <span class="filter-item-icon ${tone||''}">${icon(iconName)}</span><span>${label}</span>${id===active?icon('check'):''}</button>`).join('')}</div>`:''}</div>`;
}
function spaceResults(chat) {
  const chosen=workspaceScope==='current' ? [chat].filter(Boolean) : state.chats;
  const matching=file=>(spaceType==='all'||fileCategory(file)===spaceType)&&file.name.toLowerCase().includes(spaceSearch.toLowerCase().trim());
  const seen=new Set();
  const groups=[];
  for (const session of chosen) {
    let turn=0;
    const add=(label,ids)=>{
      const files=(ids||[]).map(id=>byId('files',id)).filter(file=>file&&matching(file)&&!seen.has(file.id));
      files.forEach(file=>seen.add(file.id));
      if (files.length) groups.push({label:workspaceScope==='all'?session.title+' · '+label:label,files,updated:session.updated});
    };
    for (const message of session.messages) {
      if (message.role==='user') turn++;
      add('第 '+turn+' 轮',spaceSource==='artifact'?message.files:message.attachments);
    }
    if (spaceSource==='attached') add('会话上传',session.attachments);
  }
  if (spaceGrouping==='folders' && groups.length) {
    const all=groups.splice(0).flatMap(group=>group.files);
    const folders=Object.groupBy(all,file=>file.type==='表格'?'数据表':file.type==='文档'?'文档':'其他文件');
    for (const [label,files] of Object.entries(folders)) groups.push({label,files});
  }
  if (spaceSort==='newest') groups.sort((a,b)=>new Date(b.updated||0)-new Date(a.updated||0));
  const sort=files=>spaceSort==='name' ? files.toSorted((a,b)=>a.name.localeCompare(b.name,'zh-CN')) : files.toSorted((a,b)=>new Date(b.at||0)-new Date(a.at||0));
  if (!groups.length) return `<div class="space-empty"><span class="tile-icon">${icon('folder-open')}</span><strong>${spaceSearch || spaceType!=='all' ? '没有匹配的文件' : '暂无文件'}</strong><p>${spaceSearch || spaceType!=='all' ? '可以调整类型或搜索词。' : '会话中生成或上传的文件会显示在这里。'}</p></div>`;
  return groups.map(group=>`<section class="space-group"><h3>${icon('chevron-down')} <span title="${escape(group.label)}">${escape(group.label)}</span> <small>${group.files.length} 个文件</small></h3>
    ${sort(group.files).map(file=>`<div class="space-file">${fileButton(file)}<small class="space-file-meta">${fileSize(file)}${fileSize(file)&&group.updated?' · ':''}${beijingTime(group.updated||file.at,true)}</small>
      <div class="space-file-actions">${button('','download',{id:file.id,glyph:'download',title:'下载 '+file.name})}${button('','delete',{id:file.id,glyph:'trash',title:'删除 '+file.name,extra:'data-collection="files"'})}</div></div>`).join('')}</section>`).join('');
}
function spaceView(chat) {
  if (workspaceScope==='current' && !chat) workspaceScope='all';
  const chats=workspaceScope==='current'?[chat]:state.chats;
  const count=select=>new Set(chats.flatMap(select).map(file=>file.id)).size;
  const artifacts=count(chatFiles);
  const related=count(attachedFiles);
  return `<aside class="chat-space" id="chat-space" aria-label="会话空间">
    <header class="drawer-head space-head"><h2>会话空间 <small>${artifacts+related}</small></h2>
      <div class="segments space-scope" role="group" aria-label="文件范围">${[['current','本会话'],['all','全部会话']].map(([id,label])=>button(label,'space-scope',{id,disabled:id==='current'&&!chat,extra:`aria-pressed="${workspaceScope===id}"`})).join('')}</div>
      <div>${uploadControl('上传','space',true)}${button('','space',{glyph:'x',title:'关闭会话空间'})}</div></header>
    <div class="space-controls">
      <label class="search-field">${icon('search')}<input type="search" placeholder="搜索文件…" aria-label="搜索会话文件" id="space-search" value="${escape(spaceSearch)}"></label>
      <div class="space-filters">${spaceFilter('type',spaceTypes,spaceType,'filter','文件类型')}
        ${spaceFilter('sort',[['newest','最新优先','sort'],['name','按名称排序','list']],spaceSort,'sort','排序方式')}</div>
      <div class="space-modes"><div class="segments space-source" role="group" aria-label="文件来源">${[['artifact','产物 '+artifacts,'boxes'],['attached','关联文件 '+related,'paperclip']].map(([id,label,glyph])=>button(label,'space-source',{id,glyph,extra:`aria-pressed="${spaceSource===id}"`})).join('')}</div>
      <div class="segments space-grouping">${[['turns','按轮次','list'],['folders','按文件夹','folder']].map(([id,label,glyph])=>button(label,'space-grouping',{id,glyph,extra:`aria-pressed="${spaceGrouping===id}"`})).join('')}</div>
      ${button('', 'space-grid',{glyph:spaceGrid?'list':'grid',title:spaceGrid?'切换列表视图':'切换网格视图',extra:`aria-pressed="${spaceGrid}"`})}</div>
    </div><div id="space-results" class="space-results${spaceGrid?' grid-view':''}">${spaceResults(chat)}</div>
    <footer><a class="button" href="#files">${icon('folder')} 打开完整工作空间 ${icon('arrow-right')}</a></footer></aside>`;
}
function themeControl(compact=false) {
  const dark=state.profile.theme==='dark';
  return `<div class="theme-control${compact?' compact':''}">
    <button class="button theme-trigger" type="button" data-action="theme-menu" data-testid="theme-toggle" aria-expanded="${themeMenu}" aria-label="选择主题">
      ${compact ? '' : icon(dark?'moon':'sun')+'<span>主题</span>'}<span>${dark?'深色':'浅色'}${compact?'主题':''}</span>${compact?'':icon('chevron-down')}
    </button>
    ${themeMenu?`<div class="control-menu theme-options" role="group" aria-label="主题选项">
      ${[['light','浅色主题','sun'],['dark','深色主题','moon']].map(([id,label,glyph])=>button(label,'theme-set',{id,glyph,extra:`aria-pressed="${state.profile.theme===id}"`})).join('')}
    </div>`:''}</div>`;
}
function conversationHistory() {
  const archived=state.chats.filter(item=>item.archived);
  const visible=state.chats.filter(item=>Boolean(item.archived)===archivedChats);
  return `<aside class="chat-history" id="chat-history"><header class="drawer-head"><h2>会话历史 <small>${state.chats.length}</small></h2><div>
    ${button('','new-chat',{title:'新对话',glyph:'plus'})}${button('','history',{title:'关闭会话历史',glyph:'arrow-left'})}</div></header>
    <label class="history-filter search-field">${icon('search')}<input id="chat-search" aria-label="搜索会话" type="search" placeholder="搜索会话" data-filter="#chat-list"></label>
    <div class="history-label"><span>${archivedChats?'已归档':'最近会话'}</span><small>${visible.length}</small></div>
    <div id="chat-list">${visible.map(item=>`<div class="history-row${item.id===activeChat?' active':''}" data-search="${escape(item.title)}">
      <button type="button" data-action="open-chat" data-id="${item.id}" aria-pressed="${item.id===activeChat}"><span><strong>${escape(item.title)}</strong><small>${beijingTime(item.updated,true,true)}</small></span></button>
      <div class="history-actions">${button('','archive-chat',{glyph:archivedChats?'refresh-cw':'archive',id:item.id,title:archivedChats?'恢复会话':'归档会话'})}
      ${button('','delete',{glyph:'trash',id:item.id,title:'删除会话',extra:'data-collection="chats"'})}</div></div>`).join('')||empty(archivedChats?'暂无归档会话':'暂无会话')}
      ${visible.length?'<p class="history-end">没有更多了</p>':''}</div>
    <footer>${button('已归档 '+archived.length,'toggle-archived',{glyph:'archive',extra:`aria-pressed="${archivedChats}"`})}
      <a class="button" href="#files">工作空间 ${icon('chevron-right')}</a></footer></aside>`;
}
const promptGroups = {
  office:['制作一份 AI 发展趋势的演示文稿大纲','生成一份新能源汽车市场调研报告','写一份低空经济行业的研究报告，包含市场规模与竞争格局','做一份项目排期表模板，列出负责人和交付物','拟定一项定时任务：工作日早上 9 点汇总昨日数据','整理会议记录并列出后续行动','按渠道整理本周经营情况','根据数据对比月度销售表现','生成一份客户反馈摘要'],
  design:['为产品首页写一份原型说明','整理品牌素材，提炼配色与字体规范','列出移动端页面的验收清单','起草新品发布页面的文案','为用户访谈设计问题'],
  development:['根据接口说明整理调用示例','找出日志中需要优先排查的问题','梳理错误状态和重试流程','编写一组表单校验用例','整理本次版本的更新说明'],
};
function welcomeHeading(person) {
  return `<div class="chat-welcome"><h1>你好，我是 <em>${escape(person?.name||brandName())}</em></h1>
    ${person?`<p>${escape(person.description)}</p>`:`<p class="welcome-command" data-welcome-command><span>${escape(commandExamples[commandIndex][commandLanguage])}</span><i aria-hidden="true"></i></p>`}
    <div class="prompt-groups segments" role="group" aria-label="示例分类">${[['office','办公','clipboard-list'],['design','设计','wand-sparkles'],['development','开发','workflow']].map(([id,label,glyph])=>button(label,'prompt-group',{id,glyph,extra:`aria-pressed="${promptGroup===id}"`})).join('')}</div></div>`;
}
function welcomePrompts() {
  const prompts = promptGroups[promptGroup];
  return `<div class="chat-examples"><div class="prompt-suggestions" aria-label="可输入的示例任务">${prompts.slice(0,morePrompts?prompts.length:5).map((prompt,id)=>
    `<button class="button" type="button" data-action="fill-prompt" data-id="${id}">${escape(prompt)}${icon('arrow-up-right')}</button>`).join('')}
    ${prompts.length>5?button(morePrompts?'收起任务':'更多任务（'+(prompts.length-5)+'）','more-prompts',{extra:`aria-expanded="${morePrompts}"`}):''}</div>
    <p class="shortcut-legend"><span><kbd>@</kbd> 选择资源</span><span><kbd>Enter</kbd> 发送</span><span><kbd>Shift + Enter</kbd> 换行</span></p></div>`;
}
function startWelcomeCommand() {
  clearTimeout(commandTimer);
  const line=document.querySelector('[data-welcome-command]');
  if (!line || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const next=()=>{
    if (document.hidden) { commandTimer=setTimeout(next,1000); return; }
    commandIndex=(commandIndex+17)%commandExamples.length;
    const glyphs=Array.from(commandExamples[commandIndex][commandLanguage]);
    let index=0;
    const write=()=>{
      line.firstElementChild.textContent=glyphs.slice(0,++index).join('');
      commandTimer=setTimeout(index===glyphs.length?next:write,index===glyphs.length?8000:commandLanguage==='zh'?120:60);
    };
    write();
  };
  commandTimer=setTimeout(next,8000);
}
function executionView(message) {
  if (!message.steps?.length) return '';
  const summary=message.mode==='live'?'提交请求 → 接收回复':message.steps.some(step=>step.startsWith('读取'))?'读取文件 → 写入文件':'核对资料 → 整理产物';
  return `<details class="execution" data-testid="execution-summary"><summary><span class="execution-icon">${icon('workflow')}</span>
    <span class="execution-label"><strong>执行过程</strong><small>${summary}</small></span><span class="execution-status">${icon('check')}已结束</span>
    <span class="execution-toggle">${icon('chevron-down')}</span></summary>
    <ol>${message.steps.map(step=>`<li>${icon('check')}${escape(step)}</li>`).join('')}</ol></details>`;
}
function chatView() {
  const chat=byId('chats',activeChat);
  const person=byId('staff',chat?.staff || activeStaff);
  const busy=loading.has(activeChat);
  const messages=chat?.messages||[];
  const live=liveReplies.get(activeChat);
  return `<div class="chat-page">
    <div class="chat-toolbar"><div>${button('会话历史','history',{glyph:'list',extra:`aria-expanded="${historyOpen}" aria-controls="chat-history"`})}${historyOpen?'':button('新对话','new-chat',{glyph:'plus'})}</div>
      <div>${button('会话空间','space',{glyph:'folder',extra:`aria-expanded="${spaceOpen}" aria-controls="chat-space" data-testid="chat-space-toggle"`})}${themeControl()}</div></div>
    <div class="chat-layout${historyOpen?' history-open':''}${spaceOpen?' space-open':''}">
    ${historyOpen ? conversationHistory() : ''}
    ${historyOpen || spaceOpen ? `<button class="chat-scrim" type="button" aria-label="关闭会话面板" data-action="close-panels"></button>`:''}
    <section class="conversation${messages.length?'':' welcome-conversation'}" aria-label="当前对话"><div class="messages">
      ${messages.length ? messages.map((message,index)=> {
        const attached=(message.attachments||[]).map(id=>byId('files',id)).filter(Boolean);
        const files=(message.files||[]).map(id=>byId('files',id)).filter(Boolean);
        return message.role==='user'
          ? `<div class="user-message"><time>${beijingTime(message.at,true,true)}</time><p>${escape(message.text)}</p>${attached.length?`<div class="message-attachments">${attached.map(fileButton).join('')}</div>`:''}${button('','copy-message',{id:String(index),glyph:'copy',title:'复制消息'})}</div>`
          : `<div class="reply"><span class="tile-icon reply-avatar">${icon('bot')}</span><div class="reply-main"><div class="reply-meta">${message.at?`<time>${beijingTime(message.at,true,true)}</time>` : ''} ${badge(message.mode==='live'?(message.failed?'发送失败':message.model||'模型回复'):'案例回放')}</div>
            ${executionView(message)}
            ${answerBody(message)}
            ${files.length?`<div class="response-files"><small>${icon('file-text')}产物</small>${files.map(file=>fileButton(file,true)).join('')}</div>`:''}
            ${message.mode==='demo' && index===messages.length-1 && examples.find(item=>item.id===chat.example)?.next?`<div class="row-actions trace-actions">${button('试着追问','case-follow',{id:chat.example,glyph:'messages-square'})}</div>`:''}
            ${message.failed&&index===messages.length-1?button('重试这条消息','retry-chat',{id:chat.id,glyph:'refresh-cw',disabled:busy}):''}
            ${message.mode==='live'&&!message.failed?button('导出文件','export-reply',{id:String(index),glyph:'download',disabled:busy}):''}</div></div>`;
      }).join('') : ''}
      ${live?`<div class="reply live-reply"><span class="tile-icon reply-avatar">${icon('bot')}</span><div class="reply-main">
        <div class="thinking" role="status"><span></span><strong>${escape(live.status||(live.text?'正在生成回复…':'正在连接模型…'))}</strong></div>
        <article class="panel answer" ${live.text?'':'hidden'}><div class="formatted-text">${renderMarkdown(live.text)}</div></article>
      </div></div>`:''}
      </div>
      ${messages.length?'':welcomeHeading(person)}
      <form class="composer panel" data-form="chat"><label class="sr-only" for="message">输入你的需求</label>
       <textarea id="message" name="prompt" placeholder="输入你的需求，或 @ 选择技能、知识库、数据库…" maxlength="4000" required ${busy?'disabled':''}></textarea>
       ${resourceChips()}
       <div class="compose-footer"><div class="composer-tools">
       ${[['models','模型','boxes'],['skills','技能','wand-sparkles'],['database','数据库','database']].map(([id,label,glyph])=>`<button type="button" class="button" data-action="resource-picker" data-id="${id}" aria-expanded="${picker===id}">${icon(glyph)}${label}${icon('chevron-down')}</button>`).join('')}
       </div><div class="composer-actions">${uploadControl('附件','attachment',true)}${button('','composer-settings',{glyph:'settings',title:'对话设置'})}<button type="submit" class="button primary icon-button send-button" aria-label="发送" title="发送" ${busy?'disabled':''}>${icon('send')}</button></div></div>
       ${picker ? resourceMenu() : ''}
      </form>
      ${messages.length?'':welcomePrompts()}
    </section>
    ${spaceOpen ? spaceView(chat) : ''}</div></div>`;
}
function projects() {
  const files=[...new Set(state.projects.map(item=>item.file).filter(Boolean))].map(id=>byId('files',id)).filter(Boolean);
  const comments=state.projects.flatMap(item=>(item.comments||[]).map(comment=>({item,...comment})));
  const board=`<div class="board">${statusNames.map((status,index) => `<section class="board-column"><h2><span class="lane-dot lane-${index}"></span>${status}${badge(state.projects.filter(item=>item.status===status).length)}</h2>
    ${state.projects.filter(item=>item.status===status).map(item=>`<article class="panel board-card"><h3><button class="plain project-detail-link" title="${escape(item.name)}" data-action="project-detail" data-id="${item.id}">${escape(item.name)}</button></h3><p>${escape(item.description)}</p><div class="board-bottom"><span>${escape(item.owner || '待分配')}</span><span class="board-evidence">${byId('files',item.file)?`<span title="有关联文件" aria-label="有关联文件">${icon('paperclip')}</span>`:''}${item.comments?.length?`<span aria-label="${item.comments.length} 条讨论" title="${item.comments.length} 条讨论">${icon('message-square')}${item.comments.length}</span>`:''}</span>${badge(status==='已完成'?'已完成':item.due||status)}</div></article>`).join('') || empty('暂无任务')}</section>`).join('')}</div>`;
  const tabs=[['overview','概览'],['board','任务看板'],['files','项目文件'],['activity','活动记录']];
  const projectTab=tabs.some(([key])=>key===routeDetail)?routeDetail:'board';
  let content=board;
  if (projectTab==='overview') content=projectOverview(files);
  if (projectTab==='files') content=`<section class="project-subview" data-display="project-files"><div class="view-heading"><h2>关联文件</h2><span>${files.length} 份文件</span></div><div class="file-gallery">${files.map(file=>fileTile(file)).join('')||empty('任务关联的文件会显示在这里。')}</div></section>`;
  if (projectTab==='activity') content=`<section class="project-subview" data-display="project-activity"><div class="view-heading"><h2>任务讨论</h2><span>${comments.length} 条记录</span></div><div class="panel activity-feed">${comments.map(({item,author,text})=>`<article><span class="person-stamp">${avatar(author)}</span><div><header><strong>${escape(author)}</strong><button type="button" data-action="project-detail" data-id="${escape(item.id)}">${escape(item.name)} ${icon('chevron-right')}</button></header><p>${escape(text)}</p></div></article>`).join('')||empty('打开任务添加讨论后，可在这里查看。')}</div></section>`;
  return `<div class="page projects-page">${heading('新品发布协作','产品团队 · 发布方案、渠道素材与客户反馈',button('新建任务','edit',{primary:true,glyph:'plus',extra:'data-collection="projects"'}))}
    <div class="page-tabs" role="group" aria-label="项目视图">${tabs.map(([id,label])=>button(label,'project-tab',{id,extra:`aria-pressed="${projectTab===id}"`})).join('')}</div>${content}</div>`;
}
function projectOverview(files) {
  const tasks=state.projects;
  const total=tasks.length;
  const finished=tasks.filter(item=>item.status==='已完成').length;
  const current=tasks.filter(item=>item.status===overviewStage);
  const percent=total?Math.round(100*finished/total):0;
  return `<section class="project-overview" data-display="project-overview">
    <div class="project-pulse"><div class="pulse-copy"><h2>发布进度</h2><p>产品页、渠道素材与首批用户反馈</p>
      <div class="pulse-number">${percent}<small>%</small></div><p>已完成 ${finished} 项，共 ${total} 项任务</p></div>
      <div class="pulse-plot" aria-hidden="true">${Array.from({length:24},(_,i)=>`<i class="${i<Math.round(percent*24/100)?'filled':''}"></i>`).join('')}</div></div>
    <div class="overview-columns"><div class="panel stage-panel"><div class="view-heading"><h2>按状态跟进</h2>${button('打开看板','project-tab',{id:'board'})}</div>
    <div class="stage-filters" role="group" aria-label="选择任务状态">${statusNames.map((status,i)=>`<button type="button" data-action="overview-stage" data-id="${status}" aria-pressed="${overviewStage===status}"><i class="lane-dot lane-${i}"></i>${status} <b>${tasks.filter(t=>t.status===status).length}</b></button>`).join('')}</div>
    <div class="stage-items">${current.map(item=>`<button type="button" data-action="project-detail" data-id="${escape(item.id)}"><span><strong>${escape(item.name)}</strong><small>${escape(item.owner||'待分配')}${item.due?' · '+escape(item.due):''}</small></span>${icon('chevron-right')}</button>`).join('')||empty('此状态下暂无任务')}</div></div>
    <div class="panel project-deliveries"><div class="view-heading"><h2>项目文件</h2>${button('查看全部','project-tab',{id:'files'})}</div>
    ${files.slice(0,3).map(file=>fileButton(file,true)).join('')||empty('暂无关联文件')}</div></div></section>`;
}
function projectDetail(item) {
  const file=byId('files',item.file);
  modal(item.name,`<form class="edit-form" data-form="project-detail" data-id="${item.id}">
    <div class="host-fields"><label>负责人<input name="owner" value="${escape(item.owner||'')}" maxlength="70"></label>
      <label>状态<select name="status">${statusNames.map(status=>`<option${selected(status,item.status)}>${status}</option>`).join('')}</select></label></div>
    <label>任务说明<textarea name="description" rows="3" maxlength="2000">${escape(item.description||'')}</textarea></label>
    ${file?`<div class="detail-block"><h3>相关文件</h3>${fileButton(file)}</div>`:''}
    <div class="detail-block"><h3>讨论记录</h3>${(item.comments||[]).map(comment=>`<article class="project-comment"><strong>${escape(comment.author)}</strong><p class="preserve-lines">${escape(comment.text)}</p></article>`).join('') || '<p>暂无讨论</p>'}</div>
    <label>补充说明<textarea name="comment" rows="2" maxlength="800" placeholder="补充说明或提及同事…"></textarea></label>
    <div class="dialog-footer">${button('更多设置','edit',{id:item.id,extra:'data-collection="projects"'})}${button('取消','close')}<button class="button primary" type="submit">保存修改</button></div>
  </form>`);
}
function taskRunBadge(run) {
  if(run?.status==='running')return badge('正在执行');
  return run ? badge(run.status==='failed'?'执行失败':'执行成功',run.status==='failed'?'danger':'success') : badge('尚未执行');
}
function tasks() {
  const task=byId('tasks',routeDetail);
  if (task) return taskHistory(task);
  const tags=[...new Set(state.tasks.map(item=>item.tag).filter(Boolean))];
  const filters=`<div class="task-filters"><label class="search-field">${icon('search')}<input type="search" id="task-search" aria-label="搜索任务" placeholder="搜索任务名称…" value="${escape(taskSearch)}"></label>
    <select id="task-status" aria-label="任务状态"><option value="all">全部状态</option>${[['enabled','已上线'],['disabled','已下线'],['failed','执行失败']].map(([id,label])=>`<option value="${id}"${selected(id,taskStatus)}>${label}</option>`).join('')}</select>
    <select id="task-tag" aria-label="任务类型"><option value="all">全部类型</option>${tags.map(tag=>`<option${selected(tag,taskTag)}>${escape(tag)}</option>`).join('')}</select>
    ${button('新建任务','edit',{primary:true,glyph:'plus',extra:'data-collection="tasks"'})}</div>`;
  const taskView=routeDetail==='types'?'types':'list';
  const tabs=`<div class="page-tabs" role="group" aria-label="任务视图">${[['list','任务列表 '+state.tasks.length],['types','任务类型 '+tags.length]].map(([id,label])=>button(label,'task-view',{id,extra:`aria-pressed="${taskView===id}"`})).join('')}</div>`;
  if(taskView==='types') return `<div class="page tasks-page">${heading('自动化任务','让重复工作，按计划完成。')}${tabs}${taskSchedule(tags)}</div>`;
  return `<div class="page tasks-page">${heading('自动化任务','让重复工作，按计划完成。')}${tabs}
    <div class="metrics panel task-metrics">${[['全部任务',state.tasks.length],['执行中',state.tasks.filter(item=>loading.has(item.id)).length],['已下线',state.tasks.filter(item=>!item.enabled).length],['最近成功',state.tasks.filter(item=>item.runs[0]?.status==='success').length],['最近失败',state.tasks.filter(item=>item.runs[0]?.status==='failed').length]].map(([label,value])=>`<div><span>${label}</span><strong>${value}</strong></div>`).join('')}</div>
    ${filters}<div class="panel table"><table class="responsive-table"><thead><tr><th scope="col">任务 / 类型</th><th scope="col">触发规则</th><th scope="col">调度</th><th scope="col">最近执行</th><th scope="col">操作</th></tr></thead><tbody id="task-rows">${taskRows()}</tbody></table></div>
    <p class="footnote">共 ${state.tasks.length} 项任务 · 北京时间（UTC+8） · 保存并启用任务后，服务器会按计划执行</p></div>`;
}
function taskSchedule(tags) {
  const week=['一','二','三','四','五','六','日'];
  const scheduled=(task,day)=>task.enabled && (task.frequency==='每天'||(task.frequency==='每个工作日' && day<5)||(task.frequency==='每周一' && day===0));
  const counts=week.map((_,day)=>state.tasks.filter(task=>scheduled(task,day)).length);
  const dayTasks=state.tasks.filter(task=>scheduled(task,scheduleDay)).sort((a,b)=>String(a.time).localeCompare(String(b.time)));
  return `<section data-display="task-types" class="schedule-view"><div class="panel schedule-board"><div class="view-heading"><h2>一周调度</h2><span>北京时间</span></div>
    <div class="week-strip" role="group" aria-label="查看某天的计划">${week.map((label,i)=>`<button type="button" data-action="schedule-day" data-id="${i}" aria-pressed="${scheduleDay===i}" aria-label="周${label}，${counts[i]} 项计划"><span>周${label}</span><strong>${counts[i]}</strong><span class="day-ticks" aria-hidden="true">${Array.from({length:Math.min(counts[i],6)},()=>'<i></i>').join('')}</span></button>`).join('')}</div>
    <div class="day-agenda"><h3>周${week[scheduleDay]}的计划${scheduleDay===beijingWeekday()?' · 今天':''}</h3>${dayTasks.map(task=>`<button type="button" data-action="runs" data-id="${escape(task.id)}"><time>${escape(task.time)}</time><span>${escape(task.name)}</span>${icon('chevron-right')}</button>`).join('')||empty('这一天没有启用的计划。')}</div></div>
    <div class="schedule-types"><div class="view-heading"><h2>任务分类</h2><span>${tags.length} 类</span></div><div class="type-grid">${tags.map(tag=>{
      const items=state.tasks.filter(item=>item.tag===tag);
      return `<button type="button" class="panel type-card" title="${escape(tag)}" data-action="task-by-type" data-id="${escape(tag)}"><span class="type-symbol">${icon(({'经营分析':'chart-no-axes-combined','内容运营':'file-text','数据处理':'database'})[tag]||'folder')}</span><span><strong>${escape(tag)}</strong><small>${items.length} 项任务 · ${items.filter(t=>t.enabled).length} 项已启用</small></span>${icon('chevron-right')}</button>`;}).join('')||empty('暂无分类')}</div></div></section>`;
}
function taskRows() {
  const visible=state.tasks.filter(item=>item.name.toLowerCase().includes(taskSearch.trim().toLowerCase()) &&
    (taskTag==='all'||item.tag===taskTag) &&
    (taskStatus==='all'||(taskStatus==='enabled'&&item.enabled)||(taskStatus==='disabled'&&!item.enabled)||(taskStatus==='failed'&&item.runs[0]?.status==='failed')));
  return visible.map(item=>`<tr><td data-label="任务"><div class="task-identity"><span class="tile-icon">${icon('bot')}</span><div><strong>${escape(item.name)}</strong><small>AI 自动化 ${item.tag?badge(item.tag):''}</small></div></div></td>
    <td data-label="触发规则">${escape(item.frequency)} ${escape(item.time)}<small>北京时间 · UTC+8</small></td>
    <td data-label="调度"><span class="task-schedule${item.enabled?' is-enabled':''}">${item.scheduled?(item.enabled?'后台已启用':'后台已暂停'):'本地示例'}</span></td>
    <td data-label="最近执行">${taskRunBadge(item.runs[0])}<small>${escape(item.runs[0]?.at || '—')}</small></td>
    <td data-label="操作"><div class="row-actions">${button(loading.has(item.id)?'执行中':'执行','run',{glyph:'play',id:item.id,disabled:loading.has(item.id)})}${button('记录','runs',{id:item.id})}${button('编辑','edit',{id:item.id,extra:'data-collection="tasks"'})}</div></td></tr>`).join('') || '<tr><td colspan="5"><p class="empty">没有匹配的任务。</p></td></tr>';
}
function taskHistory(task) {
  const executions=task.runs;
  const average=executions.length ? Math.round(executions.reduce((total,item)=>total+(item.seconds||0),0)/executions.length) : 0;
  const successes=executions.filter(item=>item.status==='success').length;
  const visible=executions.map((run,index)=>({run,index})).filter(({run})=>runFilter==='all' || run.status===runFilter);
  const current=visible.find(item=>item.index===runIndex)||visible[0];
  return `<div class="page task-history-page"><a href="#tasks" class="back-link">返回任务列表</a>
    ${heading(task.name,'AI 自动化 · '+task.frequency+' '+task.time+' · 北京时间',button(loading.has(task.id)?'执行中':'执行任务','run',{id:task.id,glyph:'play',primary:true,disabled:loading.has(task.id)}))}
    <div class="metrics panel history-metrics">${[['执行次数',executions.length],['成功率',executions.length?Math.round(successes/executions.length*100)+'%':'—'],['平均耗时',average ? average+' 秒':'—'],['最近执行',executions[0]?.at || '—']].map(([label,value])=>`<div><span>${label}</span><strong>${escape(value)}</strong></div>`).join('')}</div>
    <div class="panel task-history"><aside>
      <div class="segments" role="group" aria-label="按结果筛选">${[['all','全部'],['success','成功'],['failed','失败']].map(([id,label])=>button(label,'run-filter',{id,extra:`aria-pressed="${runFilter===id}"`})).join('')}</div>
      ${visible.map(({run,index})=>`<button class="execution-item" type="button" data-action="run-detail" data-id="${index}" aria-pressed="${current.index===index}">
        <strong>第 ${executions.length-index} 次执行</strong>${taskRunBadge(run)}<small>${escape(run.at)}${run.seconds?' · '+run.seconds+' 秒':''}</small></button>`).join('')||empty('当前没有运行记录')}
    </aside><article>${current?`<header class="run-summary"><div><h2>第 ${executions.length-current.index} 次执行</h2><small>${escape(current.run.at)} · 北京时间</small></div>${taskRunBadge(current.run)}</header>
      <details><summary>本次任务指令</summary><p>${escape(current.run.prompt||task.description)}</p></details>
      <div class="run-result"><h3>${current.run.example?'案例执行结果':'执行结果'}</h3><div class="formatted-text">${renderMarkdown(current.run.text)}</div>${current.run.files?`<div class="response-files">${current.run.files.map(id=>byId('files',id)).filter(Boolean).map(file=>fileButton(file)).join('')}</div>`:''}</div>
      ${current.run.logs?.length?`<details><summary>过程日志 · ${current.run.logs.length} 行</summary><ol>${current.run.logs.map(log=>`<li>${escape(log)}</li>`).join('')}</ol></details>`:''}`:
      empty('执行一次任务后，可以在这里查看结果与处理记录。')}</article></div></div>`;
}
const graphTones=['blue','teal','violet','gold','slate','cyan'];
function knowledgeGraph(note) {
  const categories=[...new Set(state.knowledge.map(item=>item.description||'其他'))];
  const tone=item=>graphTones[categories.indexOf(item.description||'其他')%graphTones.length];
  const nearby=item=>item.id===note.id || item.related===note.id || item.id===note.related;
  const slots=[4,0,7,2,8,3,6,1,5];
  const placed=state.knowledge.map((item,index)=>({item,slot:slots[index]??index}));
  const rows=Math.max(3,Math.ceil(placed.length/3));
  const visible=graphNeighborhood?placed.filter(({item})=>nearby(item)):placed;
  const bySlot=new Map(visible.map(({item,slot})=>[slot,item]));
  const point=slot=>[Math.round((slot%3+.5)*1000/3),Math.round((Math.floor(slot/3)+.5)*1000/rows)];
  const edges=visible.flatMap(({item,slot})=>{
    const target=visible.find(node=>node.item.id===item.related);
    if (!target || target.item.id===item.id || (target.item.related===item.id&&slot>target.slot)) return [];
    const [x1,y1]=point(slot),[x2,y2]=point(target.slot);
    return [`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" class="${item.id===note.id||target.item.id===note.id?'related-line':''}"/>`];
  });
  return `<div class="vault-graph" aria-label="笔记关联图谱"><div class="graph-tools">${button('只看邻域','graph-neighborhood',{extra:`aria-pressed="${graphNeighborhood}"`})}${button('重置选中','graph-reset')}</div>
    <div class="graph-map">
      <svg viewBox="0 0 1000 1000" preserveAspectRatio="none" aria-hidden="true">${edges.join('')}</svg>
      ${Array.from({length:rows*3},(_,slot)=>{
        const item=bySlot.get(slot);
        return item?`<button type="button" class="graph-node ${tone(item)}" data-action="note" data-id="${escape(item.id)}" aria-pressed="${item.id===note.id}"><i aria-hidden="true"></i><span>${escape(item.name)}</span></button>`:'<span aria-hidden="true"></span>';
      }).join('')}
    </div><div class="graph-legend"><small>按分类着色</small><div>${categories.map((label,index)=>`<span class="${graphTones[index%graphTones.length]}"><i></i>${escape(label)}</span>`).join('')}</div></div></div>`;
}
function knowledge() {
  const note=byId('knowledge',activeNote)||state.knowledge[0];
  const paragraphs=note?.body.split(/\n\n+/)||[];
  const outline=paragraphs.flatMap((part,index)=>part.includes('\n')?[button(part.split('\n')[0],'note-section',{id:String(index)})]:[]);
  const outgoing=note ? state.knowledge.filter(item=>item.id===note.related) : [];
  const incoming=note ? state.knowledge.filter(item=>item.related===note.id) : [];
  const groups=Object.groupBy(state.knowledge,item=>item.description||'其他');
  const noteButton=item=>button(item.name,'note',{id:item.id,glyph:'file-text'});
  return `<div class="page vault-page"><div class="panel vault">
    <header class="vault-header"><div class="vault-title"><span class="tile-icon">${icon('book-open')}</span><div><h1>团队业务资料</h1><small>${state.knowledge.length} 篇笔记 · 团队共享</small></div></div>
      <label class="search-field">${icon('search')}<input id="note-search" aria-label="搜索笔记" type="search" placeholder="搜索笔记、标签、内容…" data-filter="#notes"></label>
      <div class="segments" role="group" aria-label="知识库模式">${[['read','阅读','book-open'],['graph','图谱','workflow']].map(([id,label,glyph])=>button(label,'note-view',{id,glyph,extra:`aria-pressed="${noteView===id}"`})).join('')}</div>
      ${button('新建笔记','edit',{primary:true,glyph:'plus',extra:'data-collection="knowledge"'})}</header>
    <div class="vault-body"><aside class="vault-tree"><details class="note-index"${innerWidth>720?' open':''}><summary>笔记目录 <small>${state.knowledge.length} 篇</small>${icon('chevron-down')}</summary>
      <div id="notes">${Object.entries(groups).map(([label,items],index)=>`<details class="note-folder ${graphTones[index%graphTones.length]}" open><summary>${icon('chevron-down')}<i></i>${escape(label)}<small>${items.length}</small></summary>${items.map(item=>`<div data-search="${escape(item.name+' '+item.description+' '+item.body)}"><button class="note-link${item.id===note?.id?' active':''}" data-action="note" data-id="${item.id}" aria-pressed="${item.id===note?.id}">${icon('file-text')}${escape(item.name)}</button></div>`).join('')}</details>`).join('')||empty('暂无笔记')}</div></details></aside>
    <article class="vault-reader">${!note ? empty('选择一篇笔记查看内容。') : noteView==='graph' ? knowledgeGraph(note):
      `<header class="note-heading"><div><p>${escape(note.description || '笔记')}</p><h2>${escape(note.name)}</h2></div><div class="row-actions">${button('编辑','edit',{id:note.id,extra:'data-collection="knowledge"'})}${button('删除','delete',{id:note.id,extra:'data-collection="knowledge"'})}</div></header>
        <div class="note-body">${paragraphs.map((paragraph,index)=>{const [title,...lines]=paragraph.split('\n');return lines.length?`<section><h3 id="note-section-${index}" tabindex="-1">${escape(title)}</h3><p class="preserve-lines">${escape(lines.join('\n'))}</p></section>`:`<p>${escape(title)}</p>`;}).join('')}</div>`}</article>
    <aside class="vault-links">${noteView==='read'&&outline.length?`<div class="article-outline"><h3>本文目录</h3>${outline.join('')}</div>`:''}<div><h3>引用的笔记 <small>${outgoing.length}</small></h3>${outgoing.map(noteButton).join('') || '<p>暂无引用</p>'}</div><div><h3>引用本文的笔记 <small>${incoming.length}</small></h3>${incoming.map(noteButton).join('') || '<p>暂无反向引用</p>'}</div>
      ${note&&noteView==='graph'?button('阅读当前笔记','note-view',{id:'read',glyph:'book-open'}):''}</aside>
    </div></div></div>`;
}
function files() {
  const chosen=featuredCases.find(example=>example.id===caseFilter);
  return `<div class="page files-page" data-display="library">${heading('文件管理','按案例查找资料，打开文件后可以直接引用到对话。',`<div class="library-actions">${button('案例演示','start-replay',{glyph:'play',primary:true})}${uploadControl('上传文件','files')}</div>`)}
    <nav class="dossier-shelf" aria-label="按案例查看文件">${featuredCases.map(example=>dossierCard(example,true)).join('')}</nav>
    <section class="library-panel panel"><div class="view-heading library-heading"><div><h2>${escape(chosen?.label||'全部文件')}</h2><span id="file-count">${visibleFiles().length} 份文件</span></div>
    <div class="library-links">${chosen?button('全部文件','file-case',{id:'all'})+button('查看案例对话','open-example',{id:chosen.id,glyph:'messages-square'}):''}</div></div>
    <div class="library-controls"><label class="search-field">${icon('search')}<input id="file-search" type="search" aria-label="搜索文件" placeholder="搜索文件名称…" value="${escape(fileQuery)}"></label>
      <select id="file-type" aria-label="文件类型"><option value="all">全部类型</option>${fileTypes.map(type=>`<option${selected(type,fileType)}>${type}</option>`).join('')}</select>
      <div class="view-switch" role="group" aria-label="文件显示方式">${[['list','列表','list'],['grid','预览','grid']].map(([id,name,glyph])=>button(name,'library-layout',{id,glyph,extra:`aria-pressed="${libraryLayout===id}"`})).join('')}</div></div>
    <div id="workspace-files">${fileResults()}</div></section></div>`;
}
function visibleFiles() {
  const chosen=featuredCases.find(example=>example.id===caseFilter);
  const ids=chosen?caseFileIds(chosen):null;
  const query=fileQuery.trim().toLowerCase();
  return state.files.filter(file=>(!ids||ids.includes(file.id))&&(fileType==='all'||fileType===fileCategory(file))&&file.name.toLowerCase().includes(query));
}
function fileTile(file,actions=false) {
  const table=file.sections?.find(section=>section.table)?.table;
  const ext=fileFormat(file);
  let face='';
  let kind='document';
  if (file.asset==='launch-brief.pptx') {
    kind='slides';face='<img alt="" src="assets/deliverables/launch-slide-1.webp">';
  } else if(file.type==='图片' && /^data:image\/(png|jpeg|webp);base64,/i.test(file.thumbnail||file.data)) {
    kind='image';face=`<img alt="" src="${escape(file.thumbnail||file.data)}">`;
  } else if (file.type==='表格' && table) {
    kind='sheet';
    face=`<span class="mini-grid">${[table.columns,...table.rows.slice(0,3)].map(row=>`<span>${row.slice(0,3).map(cell=>`<i>${escape(cell)}</i>`).join('')}</span>`).join('')}</span>`;
  } else {
    const excerpt=file.sections?.[0]?.text||file.content;
    face=excerpt?`<span class="mini-page"><b>${escape(file.title||file.name)}</b><span>${escape(excerpt.slice(0,110))}</span></span>`:`<span class="format-cover">${icon('file-text')}${escape(ext)}</span>`;
  }
  return `<article class="file-tile"><button type="button" data-action="file-preview" data-id="${escape(file.id)}" aria-label="预览 ${escape(file.name)}"><span class="file-art file-art-${kind}" aria-hidden="true">${face}</span>
    <span class="tile-caption"><strong title="${escape(file.name)}">${escape(file.name)}</strong><small>${escape(ext)}${fileSize(file)?' · '+escape(fileSize(file)):''}</small></span></button>
    ${actions?`<div class="tile-tools">${libraryFileActions(file)}</div>`:''}</article>`;
}
function libraryFileActions(file) {
  return button('','download',{glyph:'download',id:file.id,title:'下载 '+file.name})+button('','delete',{glyph:'trash',id:file.id,title:'删除 '+file.name,extra:'data-collection="files"'});
}
function fileResults() {
  const visible=visibleFiles();
  if (!visible.length) return `<div class="library-empty">${icon('search')}<h3>没有匹配的文件</h3>${fileQuery||fileType!=='all'||caseFilter!=='all'?button('清除筛选','file-case',{id:'all'}):''}</div>`;
  if(libraryLayout==='grid') return `<div class="file-gallery">${visible.map(file=>fileTile(file,true)).join('')}</div>`;
  return `<div class="library-list">${visible.map(file => `<div class="library-row"><button type="button" class="library-open" data-action="file-preview" data-id="${escape(file.id)}">${fileBadge(file)}<span><strong>${escape(file.name)}</strong><small>${escape(file.hint||fileCategory(file))}</small></span></button>
    <span class="library-size">${escape(fileSize(file))}</span><div class="row-actions">${libraryFileActions(file)}</div></div>`).join('')}</div>`;
}
const collections = {
  staff:['AI 员工','配置团队的 AI 助手，按任务分配工作。','创建员工'],
  teams:['专家团队','编辑团队的职责与协作分工。','添加团队'],
  users:['用户管理','查看和调整演示工作空间的成员记录。','添加成员'],
  skills:['我的技能','整理和复用团队常用的工作方法。','添加技能'],
  market:['技能市场','将常用工具添加到我的技能。',''],
};
const marketStaff=[
  {id:'market-feedback',name:'客户反馈助手',specialty:'客服运营',description:'按产品问题、使用建议与售后咨询归类反馈，保留原话并整理回访记录。'},
  {id:'market-meeting',name:'会议纪要助手',specialty:'会议纪要',description:'提取会议决定、负责人和截止日期，单列尚未决定的事项。'},
];
const marketRecipes={
  meeting:{output:'会议决定与行动清单',example:'把这份会议记录整理为已决定事项、负责人、截止日期和待确认问题。'},
  sheet:{output:'问题行与复核清单',example:'检查这份表格，逐行标出缺失字段、重复记录和格式不一致的值。'},
  format:{output:'分级标题与交付清单',example:'整理这份报告的标题层级，把需要跟进的事项汇总为清单。'},
};
const staffGlyph=id=>icon(({s1:'chart-no-axes-combined',s2:'search',s3:'file-text'})[id]||'bot');
function cardExcerpt(label,text) {
  return `<div class="card-excerpt"><small>${escape(label)}</small><p>${escape(text)}</p></div>`;
}
function bindingLine(label,value) {
  return `<div class="binding-line"><span>${escape(label)}</span><strong title="${escape(value)}">${escape(value)}</strong></div>`;
}
function collection(key) {
  const [title, description, action] = collections[key];
  const options = button(action,'edit',{primary:true,glyph:'plus',extra:`data-collection="${key}"`});
  const staffControls=key==='staff'?`<div class="segments" role="group" aria-label="员工来源">${[['own','我的员工',state.staff.length,'users-round'],['market','员工市场',marketStaff.length,'store']].map(([id,label,count,glyph])=>`<button type="button" class="button" data-action="staff-tab" data-id="${id}" aria-pressed="${staffTab===id}">${icon(glyph)}${label}<small>${count}</small></button>`).join('')}</div>`:'';
  const marketList=key==='staff'&&staffTab==='market';
  const items=marketList?marketStaff:state[key];
  return `<div class="page collection-page">${heading(title,description,action ? options : '')}
    <div class="collection-toolbar">${staffControls}<label class="list-search search-field">${icon('search')}<input type="search" aria-label="搜索${title}" placeholder="${key==='staff'?(marketList?'搜索员工市场':'搜索我的员工'):'搜索名称或说明…'}" data-filter="#collection-list"></label></div>
    <div class="cards-grid" id="collection-list">${items.map(item => {
    const installed = state.skills.some(skill=>skill.marketId === item.id);
    const hired=marketList&&!!byId('staff',item.id);
    let binding='',context='';
    if(key==='staff'&&!marketList){
      const names=(item.skills||[]).map(id=>byId('skills',id)?.name).filter(Boolean);
      binding=bindingLine('已绑技能',names.join('、')||'尚未配置');
      const sources=[item.vault?'团队业务资料':'',byId('database',item.database)?.name].filter(Boolean);
      context=bindingLine('可用资料',sources.join('、')||'可在对话中添加附件');
    }else if(key==='skills'){
      const people=state.staff.filter(person=>person.skills?.includes(item.id));
      binding=bindingLine('使用员工',people.map(person=>person.name).join('、')||'可在对话中单独使用');
      if(item.instructions)context=cardExcerpt('执行要求',item.instructions);
    }else if(key==='market'&&marketRecipes[item.id]){
      binding=bindingLine('交付内容',marketRecipes[item.id].output);
      context=cardExcerpt('示例指令',marketRecipes[item.id].example);
    }
    const glyph=key==='staff'?staffGlyph(item.id):icon(groups.flatMap(([,links])=>links).find(([name])=>name===key)[2]);
    return `<article class="panel collection-card${key==='staff'?' employee-card':''}" data-search="${escape(item.name+' '+item.description)}"><header><span class="tile-icon" aria-hidden="true">${glyph}</span><h2 title="${escape(item.name)}">${escape(item.name)}</h2></header><p>${escape(item.description)}</p>
    ${context}${binding}<div class="collection-footer"><div class="card-meta">${item.specialty ? badge(item.specialty) : ''}</div>
    <div class="row-actions">${marketList ? button(hired?'已加入':'聘用','hire-staff',{id:item.id,disabled:hired,primary:!hired}) : key==='market' ? button('预览','market-preview',{id:item.id})+button(installed?'已添加':'安装','install',{id:item.id,disabled:installed,primary:!installed})
     : `${key==='staff'?button('对话','staff-chat',{id:item.id,primary:true})+button('','staff-detail',{id:item.id,glyph:'settings',title:'能力配置'}):''}${key==='skills'?button('查看详情','skill-detail',{id:item.id,primary:true}):''}${button('编辑','edit',{id:item.id,extra:`data-collection="${key}"`})}${button('','delete',{id:item.id,glyph:'trash',title:'删除 '+item.name,extra:`data-collection="${key}"`})}`}</div></div></article>`;
  }).join('') || empty('暂无条目')}</div><p class="empty search-empty" role="status" hidden>没有匹配的条目，试试其他名称或说明。</p></div>`;
}
function staffDetail(person) {
  const tasks = state.tasks.filter(task => task.assignee === person.id);
  const resources=[['技能',person.skills?.map(id=>byId('skills',id)?.name).filter(Boolean).join('、')],['知识库',person.vault?'团队业务资料':''],['数据库',byId('database',person.database)?.name],['模型',connection.available?connection.name:modelLabel()]];
  modal(person.name,`<dl class="record-facts"><div><dt>擅长方向</dt><dd>${escape(person.specialty || '通用')}</dd></div><div><dt>工作职责</dt><dd>${escape(person.description || '暂无说明')}</dd></div></dl>
    <div class="detail-block"><h3>能力绑定</h3><dl class="record-facts">${resources.map(([label,value])=>`<div><dt>${label}</dt><dd>${escape(value||'未配置')}</dd></div>`).join('')}</dl></div>
    ${tasks.length ? `<div class="detail-block"><h3>已分配的定时任务</h3><ul>${tasks.map(task=>`<li>${escape(task.name)}</li>`).join('')}</ul>${link('查看定时任务','tasks','clock')}</div>` : ''}
    <footer class="dialog-footer">${button('编辑助手','edit',{id:person.id,extra:'data-collection="staff"'})}${button('与助手对话','staff-chat',{id:person.id,primary:true,glyph:'messages-square'})}</footer>`,false,'side');
}
function skillDetail(skill) {
  modal('技能详情',`<div class="detail-block"><h3>${escape(skill.name)}</h3><p>${escape(skill.description)}</p></div>
    <dl class="record-facts"><div><dt>版本</dt><dd>${escape(skill.version||'1.0.0')}</dd></div><div><dt>类型</dt><dd>${escape(skill.specialty||'通用')}</dd></div></dl>
    ${skill.instructions?`<div class="detail-block"><h3>执行要求</h3><p class="preserve-lines">${escape(skill.instructions)}</p></div>`:''}
    <footer class="dialog-footer">${button('关闭','close')}${button('试一试','try-skill',{id:skill.id,primary:true,glyph:'wand-sparkles'})}</footer>`);
}
function teams() {
  const team=byId('teams',activeTeam)||state.teams[0];
  const members=(team?.members||[]).map(id=>byId('staff',id)).filter(Boolean);
  const file=byId('files',team?.file);
  return `<div class="page">${heading('专家团队','查看不同专长的助手怎样分工，并继续处理产物。',button('创建团队','edit',{primary:true,glyph:'plus',extra:'data-collection="teams"'}))}
    <div class="team-layout"><aside>${state.teams.map(item=>`<button class="team-select panel" type="button" data-action="select-team" data-id="${item.id}" aria-pressed="${item.id===team?.id}"><strong>${escape(item.name)}</strong><small>${(item.members||[]).filter(id=>byId('staff',id)).length} 位成员 · ${escape(item.specialty)}</small></button>`).join('')||empty('暂无团队')}</aside>
    <section class="panel team-detail">${team?`<div class="side-title"><h2>${escape(team.name)}</h2>${button('管理成员','edit',{id:team.id,extra:'data-collection="teams"'})}</div><p>${escape(team.description)}</p>
      <div class="subhead team-subhead"><h3>团队分工</h3><small>${members.length} 位成员</small></div>
      <div class="team-members">${members.map(person=>`<button type="button" data-action="staff-detail" data-id="${escape(person.id)}"><span class="tile-icon">${icon('bot')}</span><strong>${escape(person.name)}</strong><small>${escape(person.specialty||'通用')}</small><p>${escape(person.description)}</p></button>`).join('')||empty('请选择团队成员')}</div>
      ${file?`<div class="team-output"><h3>协作产物</h3><p>${escape(file.hint||'可打开并继续补充。')}</p>${fileButton(file)}</div>`:''}`:empty('创建团队后配置成员。')}</section></div></div>`;
}
function database() {
  const cards=state.database.map(item=>{
    const source=Object.hasOwn(databases,item.source)?databases[item.source]:null;
    const fields=source?source.schema.split(/\s*·\s*/).map(field=>{const split=field.indexOf(' ');return [field.slice(0,split),field.slice(split+1)];}):item.columns||[];
    const structure=fields.length
      ? `<dl class="schema-fields">${fields.map(([name,type])=>`<div><dt><code>${escape(name)}</code></dt><dd>${escape(type)}</dd></div>`).join('')}</dl>`
      : `<dl class="schema-fields"><div><dt>主机</dt><dd>${escape(item.host||'—')}</dd></div><div><dt>端口</dt><dd>${escape(item.port||'—')}</dd></div></dl>`;
    return `<article class="panel database-connection source-card">
      <header><span class="tile-icon">${icon('database')}</span><div><h2>${escape(item.name)}</h2><p>${escape(item.description)}</p></div></header>
      <div class="schema-caption"><code>${escape(source?.table||item.table||item.database||'—')}</code><small>${fields.length?fields.length+' 个字段':'待连接'}</small></div>
      ${structure}<footer><small>${escape(item.engine)}</small><div class="row-actions">${item.source?button('查询数据','query-db',{id:item.id,glyph:'database'}):''}${source?'':button(item.engine==='CSV'?'替换数据':item.remoteConnection?'编辑':'连接',item.engine==='CSV'?'import-csv':'edit',{id:item.id,extra:'data-collection="database"'})+button('删除','delete',{id:item.id,extra:'data-collection="database"'})}</div></footer>
    </article>`;
  });
  return `<div class="page database-page">${heading('数据库','查看数据源的字段和口径，打开查询即可核对实际记录。','<div class="row-actions">'+button('导入 CSV','import-csv',{glyph:'upload'})+button('新增连接','edit',{primary:true,glyph:'plus',extra:'data-collection="database"'})+'</div>')}
    <div class="view-heading"><h2>数据源</h2><span>${cards.length} 个连接</span></div>
    <div class="sources-grid">${cards.join('')||empty('暂无连接配置')}</div>
    <p class="footnote">支持 PostgreSQL、MySQL 的只读表或视图。服务器验证 TLS 和访问权限后，对话与定时任务即可使用。</p></div>`;
}
function connectionForm(kind,item={}) {
  const input=(key,label,options={})=>`<label>${label}<input name="${key}" value="${escape(item[key]??options.value??'')}" type="${options.type||'text'}" maxlength="${options.length||160}" ${options.optional?'':'required'} autocomplete="${key==='secret'?'new-password':'off'}" placeholder="${escape(options.hint||'')}"></label>`;
  const model=kind==='model',tool=kind==='tool';
  return `<form class="edit-form" data-form="connection" data-kind="${kind}" data-id="${escape(item.id||'')}">
    ${input('name','连接名称',{length:80,hint:model?'如：团队推理模型':'如：门店订单'})}
    ${tool?input('url','MCP Streamable HTTP 地址',{type:'url',length:1000,hint:'https://域名/mcp'}):model?input('endpoint','模型接口地址',{type:'url',length:1000,hint:'https://域名/v1 或完整聊天接口'})+input('model','模型 ID',{hint:'填写服务商提供的模型标识'}):
      `<label>数据库类型<select name="engine"><option${selected('PostgreSQL',item.engine)}>PostgreSQL</option><option${selected('MySQL',item.engine)}>MySQL</option></select></label>
       <div class="host-fields">${input('host','主机',{length:253})}${input('port','端口',{value:'5432',length:5})}</div>
       <div class="host-fields">${input('database','数据库名')}${input('schema','模式（PostgreSQL）',{optional:true,hint:'public'})}</div>
       ${input('table','可读取的表或视图')}${input('username','只读用户名')}${input('description','用途说明',{optional:true})}`}
    ${input('secret',tool?'Bearer Token':model?'API Key':'数据库密码',{type:'password',optional:true,length:4000,hint:item.remoteConnection||item.kind?'留空沿用原凭据':'无鉴权服务可留空'})}
    ${(item.remoteConnection||item.kind)?'<label class="check-row"><input name="clearSecret" type="checkbox"> 清除原有凭据</label>':''}
    <p class="footnote">${tool?'保存时会读取服务目录。可以查看文本资源，也可以核对工具参数后发起调用。':model?'保存时会向该模型发送一条简短测试消息。设为默认后，对话、引用的资料和后台任务都会使用它。':'请使用只读账号。保存时会验证 TLS 并读取这张表的字段，查询结果可用于对话和后台任务。'} 凭据由服务器加密保存。</p>
    <output role="status" class="connection-status"></output>
    <footer class="dialog-footer">${button('取消','close')}<button class="button primary" type="submit">验证并保存</button></footer></form>`;
}
async function syncConnections(){
  const {items}=await workspaceAPI('connections');
  modelConnections=items.filter(item=>item.kind==='model');
  const dbs=items.filter(item=>item.kind==='database');
  const live=new Set(dbs.map(item=>item.id));
  state.database=[...state.database.filter(item=>!item.remoteConnection&&!live.has(item.id)),...dbs.map(item=>({...item,remoteConnection:true,source:item.id}))];
  const tools=items.filter(item=>item.kind==='tool'),ids=new Set(tools.map(item=>item.id));
  state.tools=[...state.tools.filter(item=>!item.remoteConnection&&!ids.has(item.id)),...tools.map(item=>({...item,remoteConnection:true}))];
  connectionCatalogError='';save();
}
async function activateModel(id){
  await workspaceAPI('activateModel',{id:id==='platform'?'':id});
  await syncConnections();
  connection=await modelStatus();
  render({bottom:false});
}
let mcpDirectory;
let mcpResult;
async function openMcp(id){
  const item=byId('tools',id);
  modal(item.name,'<p role="status">正在读取服务目录…</p>');
  const ticket=mcpDirectory={id};
  try{
    const catalog=await workspaceAPI('mcp',{id,operation:'list'});
    if(!dialog.open||mcpDirectory!==ticket)return;
    Object.assign(ticket,catalog);
    modal(item.name,`<h3>资源</h3>${catalog.resources.map((r,i)=>button(r.name||r.uri,'read-mcp',{id:String(i),glyph:'file-text'})).join(' ')||empty('服务没有列出资源')}
    <h3>工具</h3>${catalog.tools.map((t,i)=>`<div class="connection-row"><div><strong>${escape(t.name)}</strong><small>${escape(t.description)}</small></div>${button('填写参数','prepare-mcp',{id:String(i)})}</div>`).join('')||empty('服务没有列出工具')}`);
  }catch(error){if(dialog.open&&mcpDirectory===ticket)modal(item.name,`<p role="alert">${escape(error.message)}</p>`);}
}
async function runMcp(operation,params,label){
  const directory=mcpDirectory;
  modal(label,'<p role="status">等待 MCP 服务返回结果…</p>');
  try{
    const result=await workspaceAPI('mcp',{id:directory.id,operation,params});
    if(!dialog.open||directory!==mcpDirectory)return;
    mcpResult={name:label,text:result.text};
    modal(result.isError?'工具返回错误':label,`<pre class="mcp-result">${escape(result.text)}</pre>${result.truncated?'<p>已显示前 12,000 字。</p>':''}<footer class="dialog-footer">${button('关闭','close')}${result.isError?'':button('整理为笔记','mcp-note')}</footer>`);
  }catch(error){if(dialog.open&&directory===mcpDirectory)modal(label,`<p role="alert">${escape(error.message)}</p>`);}
}
function accountPanel(){
  if(!account)return `<div class="panel account-panel"><div><h2>个人工作空间</h2><p>登录后可跨设备同步自己的内容，也可邀请同事共享。</p></div>${link('登录','login')}${link('创建账号','register','plus',true)}</div>`;
  const space=account.spaces.find(x=>x.id===account.space);
  return `<section class="panel account-panel"><div><h2>${escape(space?.name)}</h2><p>${escape(account.person.display)} · ${account.role==='admin'?'管理员':'成员'} · <span data-sync-status>${escape(syncController?.status||'正在连接')}</span></p></div>
    ${button('立即同步','sync-now')}${button('团队与账号','account-options')}${syncController?.conflicts.length?button('处理冲突','sync-conflicts',{primary:true}):''}</section>`;
}
function teamPage(){
  const members=teamDirectory?.members||[],invites=teamDirectory?.invites||[];
  return `<div class="page">${heading('团队成员','管理这个工作空间的成员、权限和邀请。',account.role==='admin'?button('邀请成员','team-invite',{primary:true,glyph:'plus'}):'')}${accountPanel()}
  <section class="panel connection-list"><h2>成员</h2>${members.map(m=>`<div class="connection-row"><div><strong>${escape(m.display)}</strong><small>${escape(m.login)}</small></div>${badge(m.role==='admin'?'管理员':'成员')}${account.role==='admin'&&m.role==='member'?button('移除','team-remove',{id:m.id}):''}</div>`).join('')||'<p>正在加载成员…</p>'}</section>
  ${account.role==='admin'?`<section class="panel connection-list"><h2>邀请码</h2>${invites.map(i=>`<div class="connection-row"><div><strong>${escape(i.note||'团队邀请')}</strong><small>有效至 ${beijingTime(i.expires*1000,true)}</small></div>${badge(i.used===1?'已使用':i.used===2?'已撤销':i.expires*1000<Date.now()?'已过期':'待使用')}${!i.used&&i.expires*1000>Date.now()?button('撤销','team-revoke',{id:i.id}):''}</div>`).join('')||empty('还没有发出邀请')}</section>`:''}</div>`;
}
async function refreshTeam(){
  if(!account)return;
  teamDirectory=await workspaceAPI('members');if(page==='users'&&!dialog.open)render();
}
async function switchAccount(result,adopt=false){
  const blobs=[];
  if(adopt)for(const f of state.files.filter(f=>f.storedOffice)){
    const blob=await getOfficeFile(f.id);if(blob)blobs.push({id:f.id,blob});
  }
  const {session,...info}=result;
  if(!info.signedIn||!session)throw Error('没有取得登录会话');
  const personal=info.spaces.find(sp=>sp.role==='admin');
  if(adopt&&personal){localStorage.setItem(accountKey({...info,space:personal.id}),JSON.stringify(state));localStorage.removeItem(guestKey);localStorage.removeItem('workspace-task-owner');}
  localStorage.setItem('workspace-account-info',JSON.stringify(info));
  localStorage.setItem('workspace-account-session',session);
  localStorage.setItem('workspace-office-scope','/'+info.space+'/'+info.person.id);
  if(blobs.length&&personal)await putOfficeFiles(blobs,'/'+personal.id+'/'+info.person.id);
  location.replace(location.pathname+location.search+'#home');location.reload();
}
function accountOptions(){
  modal('团队与账号',`<p>${escape(account.person.login)}</p><div class="connection-row"><div><strong>切换工作空间</strong></div></div>${account.spaces.map(sp=>sp.id===account.space?badge(sp.name,'success'):button(sp.name,'switch-team',{id:sp.id})).join(' ')}
  <form class="edit-form" data-form="join-team"><label>加入其他团队<input name="code" maxlength="120" placeholder="输入管理员发给你的邀请码" required></label><output role="status"></output><button class="button" type="submit">加入团队</button></form>
  <footer class="dialog-footer">${button('修改密码','change-password')}${button('生成找回码','issue-recovery')}${button('退出登录','signout')}${button('关闭','close')}</footer>`);
}
async function beforeLeave(){
  if(loading.size)throw Error('请等待当前任务完成');
  if(syncController){await syncController.flush();if(syncController.conflicts.length)throw Error('请先处理同步冲突');}
}
function modelLabel() {
  return connection.checking ? '检测模型中' : connection.available ? (connection.verifiedAtSave?'保存时已验证':'模型已连接') : '模型连接异常';
}
function models() {
  const active=modelConnections.find(item=>item.active);
  const samples=['case-weekly-doc','case-weekly-sheet','case-launch-deck'].map(id=>byId('files',id)).filter(Boolean);
  return `<div class="page models-page">${heading('模型管理','连接自己的模型，为对话、文档和后台任务选择默认服务。',button('添加模型','edit-model',{glyph:'plus',primary:true}))}
    <section class="model-connection panel"><span class="model-symbol">${icon('boxes')}</span><div><small>对话模型</small><h2>${escape(connection.available?connection.name:'实时模型')}</h2></div>
    ${badge(modelLabel(),connection.available?'success':connection.checking?'':'danger')}</section>
    <section class="panel connection-list"><div class="view-heading"><h2>模型连接</h2>${button('检测当前模型','refresh-model',{glyph:'refresh-cw',disabled:connection.checking})}</div>
    <div class="connection-row"><div><strong>平台模型</strong><small>工作台提供的默认服务</small></div>${active?button('设为默认','activate-model',{id:'platform'}):badge('当前默认','success')}</div>
    ${modelConnections.map(item=>`<div class="connection-row"><div><strong>${escape(item.name)}</strong><small>${escape(item.model)} · ${escape(item.endpoint)}</small></div><div class="row-actions">${item.active?badge('当前默认','success'):button('设为默认','activate-model',{id:item.id})}${button('编辑','edit-model',{id:item.id})}${button('删除','remove-model',{id:item.id})}</div></div>`).join('')}
    ${connectionCatalogError?`<p role="alert">${escape(connectionCatalogError)} ${button('重试','reload-connections')}</p>`:''}</section>
    <div class="model-paths">
      <a class="panel entry-link" href="#chat"><span class="tile-icon">${icon('messages-square')}</span><span><strong>发起对话</strong><small>引用资料，分析数据，生成可编辑文件。</small></span>${icon('arrow-up-right')}</a>
      <a class="panel entry-link" href="#tasks"><span class="tile-icon">${icon('clock')}</span><span><strong>安排定时任务</strong><small>设置执行时间，按计划生成结果。</small></span>${icon('arrow-up-right')}</a>
    </div>
    ${samples.length?`<section class="panel delivery-samples"><div class="view-heading"><h2>案例交付物</h2>${link('查看文件','files')}</div><div>${samples.map(file=>fileButton(file,true)).join('')}</div></section>`:''}
  </div>`;
}
function users() {
  if(account)return teamPage();
  return `<div class="page">${heading('团队成员','登录后可邀请同事，共享文件、知识笔记、会话和工作资源。')}${accountPanel()}</div>`;
}
async function savePreferences(text,enabled){
  if(account){
    try{const result=await workspaceAPI('setPrefs',{params:{rev:preferenceRev,preferences:text,enabled}});preferenceRev=result.rev;}
    catch(e){toast(e.message);return;}
  }
  state.preferences=text;state.memoryEnabled=enabled;save();render();toast('偏好已保存');
}

function settings() {
  return `<div class="page">${heading('个人设置','管理对话偏好和工具配置。')}
    ${accountPanel()}<div class="page-tabs" role="group" aria-label="个人设置视图">${[['memory','记忆'],['mcp','MCP 工具']].map(([id,label])=>button(label,'personal-tab',{id,extra:`aria-pressed="${personalTab===id}"`})).join('')}</div>
    ${personalTab==='memory'?`<section class="panel personal-panel"><div class="side-title"><h2>对话记忆</h2>${button(state.memoryEnabled?'已开启':'已关闭','memory-toggle',{extra:`aria-pressed="${state.memoryEnabled}"`})}</div><p>在此编辑会用于后续实时对话的偏好。</p>
      <form class="edit-form" data-form="memory"><label>表达与交付偏好<textarea name="preferences" rows="4" maxlength="800">${escape(state.preferences)}</textarea></label>
      <fieldset class="preference-examples"><legend>插入常用偏好</legend>${[['结论优先','先写结论，再列出支撑结论的事实。'],['标注来源','引用数据时注明来源、单位和统计周期。'],['明确分工','列出行动项时写清负责人和交付时间。']].map(([label,text])=>button(label,'insert-preference',{glyph:'plus',id:text})).join('')}</fieldset>
      <div class="row-actions"><button class="button primary" type="submit">保存偏好</button></div></form></section>`
    : `<section class="panel database-list tool-directory"><div class="database-header"><h2>MCP 服务器列表</h2>${button('新增','edit',{glyph:'plus',extra:'data-collection="tools"'})}</div>
      ${state.tools.map(tool=>`<article class="database-record"><span class="tile-icon">${icon('workflow')}</span><div class="database-info"><h3>${escape(tool.name)}</h3><p>${escape(tool.description)}</p><code>${escape(tool.url)}</code></div>${tool.remoteConnection?button('打开服务','open-mcp',{id:tool.id}):''}${button(tool.remoteConnection?'编辑':'连接','edit',{id:tool.id,extra:'data-collection="tools"'})}${button('删除','delete',{id:tool.id,extra:'data-collection="tools"'})}</article>`).join('')||empty('暂无工具配置')}</section><p class="footnote">连接自己的 MCP 服务后，可读取资源，并在确认参数后运行工具。</p>`}</div>`;
}
function systemSettings() {
  return `<div class="page system-page">${heading('系统设置','配置工作空间名称、应用标识和浏览器图标。')}
    <div class="brand-layout"><section class="panel brand-editor"><h2>基本信息</h2><form class="edit-form" data-form="system">
    <div class="host-fields"><label>应用名称<input name="brandName" maxlength="35" required value="${escape(brandName())}"></label>
      <label>工作空间名称<input name="name" maxlength="35" required value="${escape(state.profile.name)}"></label></div>
    <div class="brand-uploads">${[['logo','应用 Logo'],['icon','浏览器图标']].map(([id,label])=>`<label>${label}<span class="brand-image-sample"><img data-current-image="${id}" src="${escape(brandImage(id))}" alt=""></span><input type="file" name="${id}" accept="image/png,image/jpeg,image/webp"></label>`).join('')}</div>
    <small>支持 PNG、JPG 或 WebP，每张图片最多 200 KB。</small>
    <div class="row-actions">${button('恢复示例数据','reset')}<button class="button primary" type="submit">保存设置</button></div>
    </form></section>
    <aside class="panel brand-preview"><div class="view-heading"><h2>外观预览</h2></div>
      <figure><figcaption>浏览器标签</figcaption><div class="tab-preview"><img data-brand-preview="icon" src="${escape(brandImage('icon'))}" alt=""><span data-brand-preview="brandName">工作台 · ${escape(brandName())}</span></div></figure>
      <figure><figcaption>工作空间侧栏</figcaption><div class="sidebar-preview"><img data-brand-preview="logo" src="${escape(brandImage('logo'))}" alt=""><div>${icon('layout-dashboard')} 工作台</div><p>${icon('user-round')} <strong data-brand-preview="name">${escape(state.profile.name)}</strong></p></div></figure>
      ${link('预览登录与注册','login','arrow-up-right')}
    </aside></div></div>`;
}
function authPreview(register) {
  const en=commandLanguage==='en';
  const t=(zh,english)=>en?english:zh;
  const title=register?t('创建账号','Create an account'):t('欢迎回来','Welcome back');
  const sheet=byId('files','case-weekly-sheet')?.sections?.find(section=>section.table)?.table;
  const channelRows=(sheet?.rows||[]).filter(row=>row[0]!=='合计'&&typeof row[2]==='number');
  const largest=Math.max(1,...channelRows.map(row=>row[2]));
  const channelNames={'官网':'Website','平台旗舰店':'Flagship store','分销':'Distribution'};
  return `<main class="auth-preview" id="workspace"><section class="auth-story">
    <a class="auth-logo" href="#home"><img src="${escape(brandImage('logo'))}" alt="${escape(brandName())}"></a>
    <div class="auth-copy"><p>${t('对话 · 协作 · 自动化','Chat · Collaboration · Automation')}</p><h1>${t('团队的 AI 工作空间','An AI workspace for teams')}</h1>
      <div>${t('让 AI 整理资料、分析数据、生成文档。','Organize research, analyze data and draft documents.')}</div><div>${t('任务、讨论和交付文件，在同一处继续。','Keep tasks, discussions and deliverables together.')}</div>
      <article class="panel auth-report"><header><strong>${icon('messages-square')}${t('经营数据周报','Weekly operations report')}</strong>${badge(t('已完成','Completed'),'success')}</header>
       <blockquote>${t('整理本周经营情况，','Summarize this week’s operations,')}<br>${t('列出需要跟进的问题。','and flag issues that need follow-up.')}</blockquote>
       <p>${t('周报与渠道明细已整理。退款问题已列入待跟进事项，可继续追问核对顺序。','The report and channel breakdown are ready. Ask a follow-up about checking refunds.')}</p>
       ${channelRows.length?`<figure class="auth-channel-chart"><figcaption>${t('本周渠道销售额 · 万元','Weekly channel sales · CNY 10k')}</figcaption>${channelRows.map(([label,,value])=>`<div><span>${escape(en?(channelNames[label]||label):label)}</span><progress aria-hidden="true" max="${largest}" value="${Math.max(0,value)}"></progress><strong>${escape(value.toFixed(1))}</strong></div>`).join('')}</figure>`:''}
       <div>${['case-weekly-doc','case-weekly-sheet'].map(id=>byId('files',id)).filter(Boolean).map(fileButton).join('')}</div>
      </article><div class="auth-capabilities">${[['book-open','团队资料','Team knowledge'],['bot','AI 员工','AI teammates'],['clock','定时任务','Scheduled tasks']].map(([glyph,zh,eng])=>`<span>${icon(glyph)}${t(zh,eng)}</span>`).join('')}</div>
    </div></section><section class="auth-form-side">
      <div class="auth-tools">${button(t('EN','中文'),'command-language',{extra:'aria-label="切换预览语言"'})}${themeControl()}</div>
      <div class="auth-form"><nav aria-label="${t('账号界面','Account screens')}"><a href="#login" aria-current="${register?'false':'page'}">${t('登录','Sign in')}</a><a href="#register" aria-current="${register?'page':'false'}">${t('注册','Register')}</a></nav>
        <h2>${title}</h2><p>${register?t('创建自己的工作空间，或使用邀请码加入团队。','Create a workspace, or join a team with an invite.'):t('登录账号，继续处理团队任务。','Sign in to continue your team’s work.')}</p>
        <form class="auth-real-form" data-form="${register?'register':'login'}"><div class="auth-fields">
          <label>${t('账号','Username')}<input name="login" autocomplete="username" required maxlength="64" placeholder="${t('输入账号','Username')}"></label>
          ${register?`<label>${t('显示名称（选填）','Display name (optional)')}<input name="display" autocomplete="nickname" maxlength="40"></label>`:''}
          <label>${t('密码','Password')}<input type="password" name="password" autocomplete="${register?'new-password':'current-password'}" required ${register?'minlength="10"':''} maxlength="180" placeholder="${register?t('至少 10 个字符','At least 10 characters'):''}"></label>
          ${register?`<label>${t('确认密码','Confirm password')}<input type="password" name="again" autocomplete="new-password" required></label><label>${t('团队邀请码（选填）','Team invite (optional)')}<input name="invite" maxlength="120"></label>`:''}</div>
          <output role="status" class="connection-status"></output><button type="submit" class="button primary">${register?t('创建账号','Create account'):t('登录','Sign in')}</button></form>
        <p class="auth-note">${register?'':button(t('使用找回码','Recover account'),'recover-account')} <a href="#home">${t('直接试用工作台','Explore as a guest')}</a></p>
      </div></section></main>`;
}
const views = {home:dashboard,chat:chatView,projects,tasks,knowledge,files,database,models,settings,system:systemSettings,teams,users};
function render({keepDraft = true, bottom = true} = {}) {
  const draft = keepDraft ? document.querySelector('#message, #home-input') : null;
  const draftFocused = draft === document.activeElement;
  const previousPage = page;
  const oldRoute=page+'/'+routeDetail;
  if (draft) { if(draft.value) drafts.set(oldRoute,draft.value); else drafts.delete(oldRoute); }
  const scrollTop = document.querySelector('#workspace')?.scrollTop || 0;
  const previousChatScroll = document.querySelector('.messages')?.scrollTop || 0;
  const openedExecutions = [...document.querySelectorAll('.execution')].map(details=>details.open);
  const navScroll = document.querySelector('.navigation')?.scrollTop || 0;
  const [key,detail] = location.hash.slice(1).split('/');
  routeDetail=detail || '';
  page = Object.hasOwn(pageNames,key) ? key : 'home';
  const route=page+'/'+routeDetail;
  if (page==='chat') activeChat=routeDetail?byId('chats',routeDetail)?.id:undefined;
  const sameRoute=oldRoute===route;
  if (!sameRoute && page==='chat') showConversationStart=Boolean(byId('chats',activeChat)?.example);
  if (!sameRoute && dialog.open) dialog.close();
  document.documentElement.dataset.theme = state.profile.theme;
  document.title = pageNames[page] + ' · ' + brandName();
  document.querySelector('link[rel=icon]').href=brandImage('icon');
  if(page==='login'||page==='register'){
    app.innerHTML=authPreview(page==='register');startWelcomeCommand();return;
  }
  const view = views[page] || (() => collection(page));
  app.innerHTML = `<div class="shell${navCollapsed?' nav-collapsed':''}">${nav()}${mobileMenu ? '<button class="mobile-scrim" aria-label="关闭导航" data-action="menu"></button>' : ''}
    <header class="topbar"><div class="topbar-left">${button('','menu',{glyph:'menu',title:'切换导航',extra:`aria-expanded="${mobileMenu}" aria-controls="navigation"`})}
      ${navCollapsed?button('','fold-nav',{glyph:'panel-left',title:'展开主导航'}):''}
      ${page==='chat'?`<a href="#home" class="mobile-logo"><img src="${escape(brandImage('logo'))}" alt="${escape(brandName())}"></a>`:''}<strong>${pageNames[page]}</strong></div>
    <div class="topbar-right">${account?button(account.person.display,'account-options'):link('登录','login')}${page==='chat'?'<span class="current-theme">'+(state.profile.theme==='dark'?'深色主题':'浅色主题')+'</span>':themeControl(true)}
      ${page==='chat'?button(commandLanguage==='zh'?'中文':'EN','command-language',{extra:'aria-label="切换指令示例语言"'}):'<span class="workspace-language">中文</span>'}</div></header>
    <main id="workspace" tabindex="-1" class="workspace">${view()}</main></div>`;
  document.querySelector('.navigation').scrollTop = navScroll;
  if (page === previousPage) document.querySelector('#workspace').scrollTop = scrollTop;
  const nextInput=document.querySelector('#message,#home-input');
  if (nextInput) {
    nextInput.value=drafts.get(route)||'';
    if ((sameRoute && draftFocused && draft) || focusComposer) {
      nextInput.focus({preventScroll:true});
      if (sameRoute && draft) nextInput.setSelectionRange(draft.selectionStart,draft.selectionEnd);
    }
    focusComposer=false;
  }
  const stream = document.querySelector('.messages');
  if (stream) {
    if (!bottom) {
      document.querySelectorAll('.execution').forEach((details,index)=>{details.open=!!openedExecutions[index];});
      stream.scrollTop=previousChatScroll;
    } else if (!showConversationStart) stream.scrollTop=stream.scrollHeight;
  }
  refreshWorkspaceMotion({
    route, homeTab, caseFilter, libraryLayout, fileType, overviewStage, scheduleDay
  });
  paintCharts();
  startWelcomeCommand();
  showConversationStart = false;
}

const schema = {
  projects:[['name','任务名称'],['owner','负责人'],['description','任务说明','textarea'],['status','状态',statusNames],['file','关联文件','files']],
  tasks:[['name','任务名称'],['description','任务指令','textarea'],['assignee','执行助手','staff'],['tag','任务类型',['经营分析','内容运营','数据处理']],['frequency','执行频率',['每天','每个工作日','每周一']],['time','执行时间（北京时间）','time'],['enabled','任务状态',['已启用','已暂停']]],
  knowledge:[['name','笔记标题'],['description','分类'],['body','正文','textarea'],['related','关联笔记','relationship']],
  database:[['name','连接名称'],['description','用途说明'],['engine','类型',['PostgreSQL','MySQL']],['host','主机'],['port','端口','number'],['database','数据库名']],
  tools:[['name','服务器名称'],['description','连接方式',['Streamable HTTP','SSE']],['url','服务地址','url']],
  users:[['name','显示名称'],['description','用户名'],['specialty','角色',['成员','管理员']]],
};
const simpleFields = [['name','名称'],['description','说明','textarea'],['specialty','分类或角色']];
const formTitles = {projects:'任务',tasks:'定时任务',knowledge:'笔记',database:'数据库连接',staff:'助手',teams:'团队',users:'成员',skills:'技能',tools:' MCP 服务器'};
function editForm(key,id) {
  const existing = byId(key,id);
  const fields = schema[key] || simpleFields;
  const item = existing || (key==='tasks' ? {time:'08:30',enabled:true} : key==='database' ? {port:'5432'} : {});
  const controls=fields.map(([name,label,type]) => {
    let value = item[name] || '';
    if (name==='enabled') value = item.enabled ? '已启用' : '已暂停';
    if (Array.isArray(type)) return `<label>${label}<select name="${name}">${type.map(option=>`<option${selected(option,value)}>${option}</option>`).join('')}</select></label>`;
    if (['relationship','staff','files'].includes(type)) {
      const options = state[type === 'relationship' ? 'knowledge' : type];
      const placeholder = type === 'staff' ? '通用助手' : '无';
      return `<label>${label}<select name="${name}"><option value="">${placeholder}</option>${options.filter(option=>option.id!==id).map(option=>`<option value="${option.id}"${selected(option.id,value)}>${escape(option.name)}</option>`).join('')}</select></label>`;
    }
    if (type==='textarea') return `<label>${label}<textarea name="${name}" rows="4" maxlength="4000"${name==='body'||key==='tasks'?' required':''}>${escape(value)}</textarea></label>`;
    return `<label>${label}<input name="${name}" type="${type||'text'}" value="${escape(value)}" maxlength="180" ${['name','time','host','database','port','url'].includes(name)?'required':''} ${type==='number'?'min="1" max="65535"':''}></label>`;
  });
  const deleteAction=existing && ['projects','tasks'].includes(key) ? button('删除','delete',{id,extra:`data-collection="${key}"`}) : '';
  const footer=(extras='',save='保存')=>`<footer class="dialog-footer">${button('取消','close')}${extras}<button class="button primary" type="submit">${save}</button></footer>`;
  let content=controls.join('')+footer(deleteAction);
  const choose=(field,label,collection)=>`<label>${label}<select name="${field}"><option value="">无</option>${state[collection].filter(row=>collection!=='files'||fileText(row)).map(row=>`<option value="${escape(row.id)}"${selected(row.id,item[field])}>${escape(row.name)}</option>`).join('')}</select></label>`;
  if(key==='skills')content=controls.join('')+`<label>执行要求<textarea name="instructions" rows="5" maxlength="4000" placeholder="写下处理步骤、输出格式和需要核对的事项">${escape(item.instructions||'')}</textarea></label>`+footer();
  if(key==='staff')content=controls.join('')+`<fieldset class="form-section"><legend>工作资源</legend>${state.skills.map(skill=>`<label class="check-row"><input type="checkbox" name="skills" value="${escape(skill.id)}"${item.skills?.includes(skill.id)?' checked':''}>${escape(skill.name)}</label>`).join('')}${choose('note','默认参考笔记','knowledge')}${choose('database','默认数据库','database')}</fieldset>`+footer();
  if(key==='knowledge')content=(id?'':choose('importNote','从已有文件填入正文','files'))+controls.join('')+footer();
  if (key==='tasks') content=`<ol class="wizard-steps"><li>AI 自动化</li><li aria-current="step">配置任务</li><li>设定调度</li></ol>
    <section data-task-step="config"><h3>告诉助手要完成什么</h3><p>描述任务与交付要求，再选择负责执行的助手。</p>
      <div class="form-section">${controls.slice(0,4).join('')}${choose('skillId','执行技能','skills')}${choose('noteId','参考笔记','knowledge')}${choose('fileId','参考文件','files')}</div><p class="footnote">保存时会把所选资料的文字节选存入该后台计划。修改资料后，重新保存计划即可更新。</p>
      <footer class="dialog-footer">${button('取消','close')}${deleteAction}${button('设置调度','task-step',{id:'schedule',primary:true})}</footer></section>
    <section data-task-step="schedule" hidden><h3>安排执行时间</h3><p>保存到服务器后，即使关闭网页，也会按北京时间执行。</p>
      <div class="form-section">${controls.slice(4).join('')}<label>查询数据库<select name="source"><option value="">无</option>${state.database.filter(db=>db.source).map(db=>`<option value="${db.source}"${selected(db.source,item.source)}>${escape(db.name)}</option>`).join('')}</select></label></div>
      ${footer(button('上一步','task-step',{id:'config'}),'保存调度')}</section>`;
  if (key==='teams') content=controls.join('')+`<fieldset class="form-section"><legend>选择成员</legend>
    ${state.staff.map(person=>`<label class="check-row"><input type="checkbox" name="members" value="${person.id}"${item.members?.includes(person.id)?' checked':''}>${escape(person.name)}</label>`).join('')}</fieldset>`+footer();
  return `<form class="edit-form ${['tasks','database'].includes(key)?'':'editor-fields'}" data-form="edit" data-collection="${key}" data-id="${id||''}">${content}</form>`;
}
function modal(title, content, wide = false, position = '') {
  dialog.classList.toggle('wide',wide);
  dialog.classList.toggle('side',position==='side');
  dialog.innerHTML = `<header class="dialog-header"><h2 id="dialog-title">${escape(title)}</h2>${button('','close',{glyph:'x',title:'关闭'})}</header><div class="dialog-body">${content}</div>`;
  const entering=!dialog.open;
  if (entering) dialog.showModal();
  if (entering && dialog.querySelector('[data-form="edit"]:not([data-collection="tasks"],[data-collection="database"]),[data-form="invite"]')) animateEditor(dialog);
}
function taskStep(form,step) {
  const sections=[...form.querySelectorAll('[data-task-step]')];
  if (step==='schedule') {
    const invalid=sections[0].querySelector(':invalid');
    if (invalid) {invalid.reportValidity();return;}
  }
  sections.forEach(section=>{section.hidden=section.dataset.taskStep!==step;});
  const steps=form.querySelectorAll('.wizard-steps li');
  steps.forEach(item=>item.removeAttribute('aria-current'));
  steps[step==='schedule'?2:1].setAttribute('aria-current','step');
  sections.find(section=>!section.hidden).querySelector('input,select')?.focus();
}
async function modelStatus(verify=false) {
  try {
    const response = await fetch(apiUrl('/api/model'+(verify?'?verify=1':'')),{cache:'no-store',headers:{'X-Workspace':workspaceToken()}});
    if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) return {available:false};
    const info = await response.json();
    return {available:info.available===true,name:String(info.name||''),verifiedAtSave:info.verifiedAtSave===true};
  } catch { return {available:false}; }
}
async function answer(messages, onProgress = () => {}) {
  const history=messages.filter((message,index)=>message.role==='assistant'
    ? !message.failed
    : index===messages.length-1 || (messages[index+1]?.role==='assistant'&&!messages[index+1].failed));
  const turns=history.slice(-11).map(({role,text,context,resources,mode,files,attachments})=>{
    const content=!resources && context ? text+'\n\n'+context : text;
    if (role==='assistant' && files?.length) {
      const linked=files.map(id=>byId('files',id)).filter(Boolean);
      const source=linked.map(file=>file.name+'\n'+fileText(file)).join('\n\n');
      const label=mode==='demo'?'案例附件':'本轮 Office 文件';
      return {role,content:(content.slice(0,1000)+'\n\n'+label+'\n'+source).slice(0,5000),officeFormats:linked.filter(f=>f.storedOffice).map(f=>f.name.split('.').at(-1))};
    }
    const inputs=role==='user' && !resources ? (attachments||[]).map(id=>byId('files',id)).filter(Boolean).map(file=>({kind:'attachment',name:file.name,text:fileText(file).slice(0,4000)})):undefined;
    return {role,content:content.slice(0,5000),resources:resources||inputs};
  });
  const encoder=new TextEncoder();
  while (encoder.encode(JSON.stringify({messages:turns})).byteLength>58_000) {
    if (turns.length>1) { turns.splice(0,Math.min(2,turns.length-1)); continue; }
    if (!turns[0].resources?.length) break;
    turns[0].resources=turns[0].resources.slice(0,-1);
  }
  let response;
  try {
    response=await fetch(apiUrl('/api/chat'),{
      method:'POST',headers:{'Content-Type':'application/json','Accept':'text/event-stream','X-Workspace':workspaceToken()},
      signal:AbortSignal.timeout(175_000),body:JSON.stringify({messages:turns}),
    });
  } catch (error) {
    connection={...connection,available:false,checking:false};
    throw Error(error.name==='TimeoutError' ? '模型响应超时，可以重试这条消息。' : '暂时无法连接模型，可以重试这条消息。');
  }
  if (response.ok && response.headers.get('content-type')?.startsWith('text/event-stream') && response.body) {
    let text='',pending;
    const staged=[];
    try {
      for await (const data of readEvents(response.body)) {
        const event=JSON.parse(data);
        if(event.type==='tool_status') onProgress('',event.text);
        if(event.type==='artifact_start'){
          if(pending || staged.length>=3)throw Error('文件传输顺序无效。');
          pending={meta:event.file,chunks:[]};
        }
        if(event.type==='artifact_chunk'){
          if(!pending)throw Error('缺少文件信息。');
          pending.chunks.push(Uint8Array.from(atob(event.data),c=>c.charCodeAt(0)));
        }
        if(event.type==='artifact_end'){
          const blob=new Blob(pending.chunks,{type:pending.meta.mime});
          if(blob.size!==pending.meta.size)throw Error('文件传输不完整。');
          staged.push({id:uid(),meta:pending.meta,blob});
          pending=null;
        }
        if (event.type==='message_delta') {
          text+=event.delta;
          onProgress(text);
        }
        if (event.type==='run_error') throw Error(event.error);
        if (event.type==='run_end' && text.trim()) {
          if(pending)throw Error('文件传输中断。');
          if(staged.length) {
            try {await putOfficeFiles(staged);}
            catch {throw Error('无法保存生成文件，请检查浏览器存储空间后重试。');}
            const items=staged.map(({id,meta})=>({...meta,id,storedOffice:true,at:new Date().toISOString()}));
            state.files.unshift(...items);
            if(!save()){
              state.files=state.files.filter(f=>!items.some(i=>i.id===f.id));
              await Promise.all(items.map(f=>removeOfficeFile(f.id)));
              throw Error('文件索引未能保存，请清理浏览器存储后重试。');
            }
          }
          connection={available:true,name:event.model,checking:false};
          return {role:'assistant',text,mode:'live',model:event.model,truncated:event.truncated,
            files:staged.map(f=>f.id),steps:staged.length?['读取本轮请求与引用资料','编排文件内容','生成并校验 Office 文件']:['已提交模型请求',event.truncated?'已接收模型返回内容':'已接收完整回复']};
        }
      }
    } catch (error) {
      if (error.name==='AbortError' || error.name==='TimeoutError') throw Error('模型响应超时，可以重试这条消息。');
      throw error;
    }
    throw Error('回复中断，可以重新发送。');
  }
  const result=await response.json().catch(()=>null);
  if (!response.ok || typeof result?.text!=='string' || !result.text.trim()) {
    if (response.status>=500) connection={...connection,available:false,checking:false};
    throw Error(result?.error || '模型没有返回可用的回复，可以重试这条消息。');
  }
  connection={available:true,name:result.model || connection.name};
  return {role:'assistant',text:result.text,mode:'live',model:result.model};
}
function needsExtraction(file){
  return file&&!file.content&&(file.storedOffice||typeof file.data==='string')&&/\.(pdf|png|jpe?g|webp)$/i.test(file.name);
}
async function extractFile(file){
  const blob=file.storedOffice?await getOfficeFile(file.id):null;
  const url=blob?await readDataUrl(blob):file.data;
  if(!url)throw Error('本机缺少文件原件，请先完成同步');
  const {text,method}=await workspaceAPI('extractText',{params:{data:url.split(',')[1]}});
  file.content=text;file.extraction=method;save();return text;
}
function referenceText(text,question){
  const value=String(text||'');
  if(value.length<=4000)return value;
  const terms=new Set((question.toLowerCase().match(/[a-z0-9_]{2,}|[\u3400-\u9fff]{2,}/g)||[]).flatMap(t=>/^[\u3400-\u9fff]/.test(t)?Array.from({length:t.length-1},(_,i)=>t.slice(i,i+2)):[t]));
  const sections=Array.from({length:Math.ceil(value.length/720)},(_,i)=>{
    const part=value.slice(i*720,(i+1)*720),normalized=part.toLowerCase();
    return {i,part,score:[...terms].filter(term=>normalized.includes(term)).length};
  });
  return sections.sort((a,b)=>b.score-a.score||a.i-b.i).slice(0,5).sort((a,b)=>a.i-b.i).map(s=>'【节选 '+(s.i+1)+'】'+s.part).join('\n');
}
let extractingForChat=false;
async function send(prompt, existingId, replySource) {
  if(extractingForChat)return;
  const originRoute=page+'/'+routeDetail;
  const toRead=filesForDraft().map(id=>byId('files',id)).filter(needsExtraction);
  if(toRead.length){
    extractingForChat=true;toast('正在提取所选 PDF 或图片中的文字…');
    try{for(const file of toRead)await extractFile(file);}
    catch(e){toast(e.message);return;}finally{extractingForChat=false;}
    if(page+'/'+routeDetail!==originRoute)return;
  }
  const chat = byId('chats',existingId);
  if (chat && loading.has(chat.id)) return;
  const target = chat || {id:uid(),title:prompt.slice(0,30),messages:[]};
  if (!chat && activeStaff) target.staff=activeStaff;
  if (!chat) { state.chats.unshift(target); archivedChats=false; }
  const skill = byId('skills',selectedSkill);
  const person=byId('staff',target.staff);
  const note = byId('knowledge',selectedNote);
  const database = byId('database',selectedDatabase);
  const at=new Date().toISOString();
  const attachments=filesForDraft().filter(id=>byId('files',id));
  const resource=(kind,item,text) => item && {
    kind,name:item.name.slice(0,160),text:referenceText(text,prompt),
  };
  const resources = [
    resource('staff',person,person?.description),
    resource('skill',skill,skill?.instructions||skill?.description),
    resource('knowledge',note,note?.body),
    database && {...resource('database',database,''),source:database.source},
    resource('attachment',replySource && {name:'所选回复'},replySource),
    ...attachments.slice(0,6).map(id=>{
      const file=byId('files',id);
      return resource('attachment',file,fileText(file) || '这份附件没有可用的文本内容。');
    }),
    state.memoryEnabled && state.preferences && resource('preference',{name:'回复偏好'},state.preferences),
  ].filter(Boolean);
  drafts.delete(page+'/'+routeDetail);
  const submitted=document.querySelector('#message,#home-input');
  if (submitted) submitted.value='';
  target.messages.push({role:'user',text:prompt,resources,at,attachments});
  target.updated=at;
  activeChat = target.id;
  draftAttachments.delete(page+'/'+routeDetail);
  picker='';
  if (compactChat()) historyOpen=false;
  go('chat/'+target.id);
  await completeChat(target);
}
async function completeChat(target, {keepDraft = false} = {}) {
  if (loading.has(target.id)) return;
  loading.add(target.id);
  const live={text:'',frame:0};
  liveReplies.set(target.id,live);
  save();
  render({keepDraft});
  try {
    const result=await answer(target.messages,(text,status)=>{
      live.status=status||'';
      live.text=text;
      if (live.frame || page!=='chat' || activeChat!==target.id) return;
      live.frame=requestAnimationFrame(()=>{
        live.frame=0;
        if (page!=='chat' || activeChat!==target.id) return;
        const container=document.querySelector('.messages');
        const panel=container?.querySelector('.live-reply .answer');
        if (!panel) return;
        const stick=container.scrollHeight-container.scrollTop-container.clientHeight<80;
        panel.hidden=!live.text;
        panel.firstElementChild.innerHTML=renderMarkdown(live.text);
        container.querySelector('.live-reply .thinking strong').textContent=live.status||'正在生成回复…';
        if (stick) container.scrollTop=container.scrollHeight;
      });
    });
    target.messages.push({...result,at:new Date().toISOString()});
  }
  catch (error) {
    const text = error instanceof Error ? error.message : '模型调用失败';
    target.messages.push({role:'assistant',title:live.text?'回复中断':'本次未收到回复',
      text:live.text||text,interruption:live.text?text:'',mode:'live',failed:true,at:new Date().toISOString()});
    toast(text);
  } finally {
    cancelAnimationFrame(live.frame);
    liveReplies.delete(target.id);
    loading.delete(target.id);
    save();
    if(page==='chat' && activeChat===target.id) {
      const messages=document.querySelector('.messages');
      render({bottom:!messages || messages.scrollHeight-messages.scrollTop-messages.clientHeight<80});
    }
  }
}
async function runTask(task) {
  if (loading.has(task.id)) return;
  loading.add(task.id);
  render();
  const start = performance.now();
  let run;
  try {
    const staff = byId('staff',task.assignee);
    const resources=staff?[{kind:'staff',name:staff.name.slice(0,160),text:(staff.description||'').slice(0,4000)}]:[];
    resources.push(...(task.references||[]));
    if(task.source)resources.push({kind:'database',source:task.source,name:'任务数据源',text:''});
    const result = await answer([{role:'user',text:task.description||task.name,resources}]);
    run={status:'success',mode:result.mode,text:result.text,files:result.files,logs:result.steps||[]};
  } catch (error) { run={status:'failed',text:error.message,logs:['读取任务指令','模型调用未完成']}; }
  task.runs.unshift({...run,prompt:task.description||task.name,at:beijingTime(new Date(),true),seconds:Math.max(1,Math.round((performance.now()-start)/1000))});
  if (routeDetail===task.id) {runFilter='all';runIndex=0;}
  save();
  toast(run.status==='failed'?'执行失败，已保存记录':'已保存执行记录');
  loading.delete(task.id);
  if (page==='tasks') render();
}
function openExample(id) {
  const example = examples.find(item => item.id === id);
  let chat = byId('chats','portfolio-'+id);
  if (!chat) {
    chat = makeExample(example);
    state.chats.unshift(chat);
    state.files.unshift(...structuredClone(exampleFiles.filter(file=>caseFileIds(example).includes(file.id) && !byId('files',file.id))));
    save();
  }
  openChat(chat.id);
}
function openChat(id) {
  activeChat=id;
  activeStaff='';
  picker='';
  showConversationStart=!!byId('chats',id)?.example;
  if(compactChat())historyOpen=false;
  go('chat/'+id);
}
const replayLabels=['原始资料','主要产物','后续跟进'];
function openReplay(id) {
  const example=featuredCases.find(item=>item.id===id)||featuredCases[0];
  replay={example,step:0,playing:!matchMedia('(prefers-reduced-motion: reduce)').matches && !document.hidden};
  modal('案例演示',`<div class="case-replay"><div class="replay-top"><label>选择案例<select data-replay-case>${featuredCases.map(item=>`<option value="${item.id}"${selected(example.id,item.id)}>${escape(item.label)}</option>`).join('')}</select></label></div>
    <div class="replay-steps" role="group" aria-label="演示步骤">${replayLabels.map((label,i)=>`<button type="button" data-action="replay-step" data-id="${i}"><i aria-hidden="true"></i>${label}</button>`).join('')}</div>
    <div class="replay-scene"></div><footer><span class="replay-position"></span><button type="button" class="button" data-action="replay-play"></button></footer></div>`,true);
  paintReplay();
}
function setReplayTimer() {
  clearTimeout(replayTimer);
  const control=dialog.querySelector('[data-action=replay-play]');
  if(!replay||!control) return;
  control.textContent=replay.playing?'暂停播放':replay.step===2?'重新播放':'继续播放';
  if (replay.playing) replayTimer=setTimeout(()=>{
    if(!dialog.open || !dialog.querySelector('.replay-scene')) return;
    replay.step++;
    if (replay.step===2) replay.playing=false;
    paintReplay();
  },7500);
}
function pauseReplay() {
  if(replay) {replay.playing=false;setReplayTimer();}
}
function paintReplay() {
  const {example,step}=replay;
  const ids=[[example.input],example.reply.files,example.follow.reply.files][step];
  const items=ids.map(id=>byId('files',id)).filter(Boolean);
  const file=items[0];
  const table=file?.sections?.find(section=>section.table)?.table;
  const heading=file?.sections?.[0]?.title || '';
  const excerpt=file?.sections?.[0]?.text || '';
  const handoff={
    operations:'负责人用 Word 周报看本周变化，运营用 Excel 明细定位到渠道和商品。要查清具体原因，可以切到下一步的退款核对清单。',
    launch:'产品和运营用 Word 方案确认日期与负责人。启动会上用四页演示稿说明安排，渠道和客服再用验收表逐项确认。',
    research:'评审时先读简报中的判断。遇到关于样本范围或报价口径的问题，打开下一步的证据台账，按材料编号回查出处。'
  };
  const context=[example.prompt,handoff[example.id],example.follow.prompt][step];
  const scene=dialog.querySelector('.replay-scene');
  const paper=table && file?.type==='表格'? dataTable(table.columns.slice(0,3),table.rows.slice(0,4).map(row=>row.slice(0,3))) :
    `<h4>${escape(heading)}</h4><p>${escape(excerpt)}</p>`;
  scene.innerHTML=`<div class="replay-frame"><div class="replay-paper">${file?`<header>${fileBadge(file)}<strong>${escape(file.name)}</strong></header>${paper}`:empty('这一步的文件已从当前工作空间删除。')}</div></div>
    <div class="replay-notes"><h3>${['任务要求','怎么使用这份交付','团队接着问'][step]}</h3><div class="formatted-text">${renderMarkdown(context)}</div>
    <div class="replay-links">${items.map(item=>button(item.name,'file-preview',{id:item.id,glyph:'file-text'})).join('')}</div></div>`;
  dialog.querySelectorAll('[data-action=replay-step]').forEach((node,i)=>node.setAttribute('aria-pressed',String(i===step)));
  dialog.querySelector('.replay-position').textContent=`第 ${step+1} / 3 步`;
  setReplayTimer();
}
document.addEventListener('visibilitychange',()=>{if(document.hidden)pauseReplay();});
matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change',event=>{if(event.matches)pauseReplay();});
dialog.addEventListener('focusin',event=>{if(event.target.closest('.replay-scene'))pauseReplay();});
function restorePreviewParent() {
  if (!previewParent || !dialog.dataset.file) return false;
  const {nodes,className,scroll,focus}=previewParent;
  previewParent=undefined;
  delete dialog.dataset.file;
  dialog.className=className;
  dialog.replaceChildren(...nodes);
  dialog.scrollTop=scroll;
  focus.focus({preventScroll:true});
  return true;
}
dialog.addEventListener('cancel',event=>{if (restorePreviewParent()) event.preventDefault();});
dialog.addEventListener('close',()=>{clearTimeout(replayTimer);replay=undefined;previewParent=undefined;delete dialog.dataset.file;});
async function fetchScheduledFile(file){
  if(!file?.remote || file.storedOffice)return true;
  try {
    const {base64,...meta}=await workspaceAPI('file',{id:file.id});
    const blob=new Blob([Uint8Array.from(atob(base64),c=>c.charCodeAt(0))],{type:meta.mime});
    await putOfficeFiles([{id:file.id,blob}]);Object.assign(file,meta,{storedOffice:true});save();return true;
  }catch(e){toast(e.message);return false;}
}
async function preview(file, chosenSheet = 0) {
  if (!file || !await fetchScheduledFile(file)) return;
  const footer=`<footer class="dialog-footer file-preview-actions">${previewParent?button(previewParent.label,'close',{glyph:'arrow-left'}):''}${button('下载文件','download',{id:file.id,glyph:'download'})}${file.sections||file.content||needsExtraction(file)?button('引用到对话','ask-file',{id:file.id,primary:true,glyph:'messages-square'}):''}</footer>`;
  dialog.dataset.file=file.id;
  if (file.sections) {
    if (file.asset==='launch-brief.pptx') {
      const section=file.sections[chosenSheet]||file.sections[0];
      const tabs=file.sections.map(({title},i)=>button(String(i+1),'preview-sheet',{id:file.id,extra:`data-sheet="${i}" aria-label="第 ${i+1} 页 ${escape(title)}" aria-pressed="${i===chosenSheet}"`})).join('');
      modal(file.name,`<img class="slide-preview" src="assets/deliverables/launch-slide-${chosenSheet+1}.webp" alt="${escape(section.title+'。'+section.text)}"><div class="slide-controls"><span>第 ${chosenSheet+1} / ${file.sections.length} 页</span><div class="segments sheet-tabs" role="group" aria-label="幻灯片页码">${tabs}</div></div><details class="slide-transcript" ${matchMedia('(max-width:600px)').matches?'open':''}><summary>本页文字</summary><h3>${escape(section.title)}</h3><p>${escape(section.text)}</p></details>`+footer,true);
      return;
    }
    const book=file.type==='表格' && file.sections.length>1;
    const sections=book ? [file.sections[chosenSheet] || file.sections[0]] : file.sections;
    const controls=book ? `<div class="segments sheet-tabs" role="group" aria-label="工作表">${file.sections.map((section,index)=>button(section.title,'preview-sheet',{id:file.id,extra:`data-sheet="${index}" aria-pressed="${index===chosenSheet}"`})).join('')}</div>` : '';
    const body=`<div class="file-preview-head">${fileBadge(file)}<div><h3>${escape(file.title)}</h3><p>${escape(file.hint)}</p></div></div>${controls}<div class="file-preview-content">${sections.map(section=>`<section><h4>${escape(section.title)}</h4><p>${escape(section.text)}</p>${section.table ? dataTable(section.table.columns,section.table.rows) : ''}</section>`).join('')}</div>`;
    modal(file.name,body+footer,true);
    return;
  }
  const imageBlob=file.type==='图片'&&file.storedOffice?await getOfficeFile(file.id):null;
  const imageURL=imageBlob?await readDataUrl(imageBlob):file.data;
  const text = file.content ? (/\.md$/i.test(file.name) || file.mime==='text/markdown'
    ? `<div class="formatted-text">${renderMarkdown(file.content)}</div>`
    : `<pre class="preview-text">${escape(file.content)}</pre>`)
    : file.type==='图片' ? `<img class="preview-image" src="${escape(/^data:image\/(png|jpeg|webp);base64,/i.test(imageURL)?imageURL:'')}" alt="${escape(file.name)}">`
    : '<p>可以下载此文件，在本地应用中打开。</p>';
  const extraction=needsExtraction(file)?`<p class="footnote">服务器可临时读取这份文件，提取中文和英文文字。图片内容以识别出的文字引用。</p>${button('提取文字','extract-text',{id:file.id})}`:'';
  modal(file.name,text+extraction+footer);
}
async function download(file) {
  if (!file || !await fetchScheduledFile(file)) return;
  const storedAsset=exampleFiles.find(entry=>entry.id===file.id)?.asset;
  let storedBlob;
  if(file.storedOffice){
    try {storedBlob=await getOfficeFile(file.id);} catch {}
    if(!storedBlob){toast('此浏览器缺少文件内容，请在原对话重新生成。');return;}
  }
  const url = storedBlob ? URL.createObjectURL(storedBlob) : storedAsset ? 'assets/deliverables/'+storedAsset : (typeof file.data==='string'&&/^data:[^,;]*;base64,[a-z0-9+/=]+$/i.test(file.data)?file.data:'') || URL.createObjectURL(new Blob([file.content],{type:file.mime}));
  const anchor = Object.assign(document.createElement('a'),{href:url,download:file.name});
  anchor.click();
  if (url.startsWith('blob:')) setTimeout(()=>URL.revokeObjectURL(url),1000);
}
function readDataUrl(file) {
  return new Promise((resolve,reject)=>{
    const reader=new FileReader();
    reader.onload=()=>resolve(reader.result);
    reader.onerror=reject;
    reader.readAsDataURL(file);
  });
}
async function saveSystemSettings(values) {
  const name=values.name.trim();
  const product=values.brandName.trim();
  if(!name||!product) {toast('请填写应用和工作空间名称');return;}
  const previous=state.profile;
  const next={...previous,name,brandName:product};
  for(const field of ['logo','icon']){
    const file=values[field];
    if(!file.size) continue;
    if(!validBrandAsset(file)) {
      toast('请选择 200 KB 以内的 PNG、JPG 或 WebP 图片');return;
    }
    next[field]=await readDataUrl(file);
  }
  state.profile=next;
  if(!save()){state.profile=previous;return;}
  render();toast('设置已保存');
}
function validBrandAsset(file) {
  return ['image/png','image/jpeg','image/webp'].includes(file.type)&&file.size<=200_000;
}
async function previewBrandAsset(input) {
  const file=input.files[0];
  const accepted=!file||validBrandAsset(file);
  input.setCustomValidity(accepted?'':'请选择 200 KB 以内的 PNG、JPG 或 WebP 图片');
  if(!accepted)input.reportValidity();
  let src=brandImage(input.name);
  if(file&&accepted){
    try {src=await readDataUrl(file);} catch {toast('读取图片失败');}
  }
  if(!input.isConnected||file!==input.files[0])return;
  for(const image of document.querySelectorAll(`[data-brand-preview="${input.name}"],[data-current-image="${input.name}"]`))image.src=src;
}
async function upload(file, target, forChat) {
  const attachmentRoute=page+'/'+routeDetail;
  if(!file.size||file.size>4_000_000){toast('请选择非空且不超过 4 MB 的文件');return;}
  const suffix = file.name.toLowerCase().split('.').at(-1);
  const text = ['md','csv','txt'].includes(suffix);
  const type = ['csv','xlsx'].includes(suffix) ? '表格' : ['png','jpg','jpeg','webp'].includes(suffix)?'图片': ['txt','md','pdf','docx'].includes(suffix)?'文档':'其他';
  const item = {id:uid(),name:file.name,type,mime:file.type,size:file.size,at:new Date().toISOString(),storedOffice:true,content:text ? (await file.text()).slice(0,24000) : null};
  if(type==='图片'){
    try{
      const bitmap=await createImageBitmap(file),scale=Math.min(1,180/Math.max(bitmap.width,bitmap.height));
      const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(bitmap.width*scale));canvas.height=Math.max(1,Math.round(bitmap.height*scale));
      canvas.getContext('2d').drawImage(bitmap,0,0,canvas.width,canvas.height);bitmap.close();
      item.thumbnail=canvas.toDataURL('image/webp',.72);
    }catch{}
  }
  await putOfficeFiles([{id:item.id,blob:file}]);
  if(['docx','xlsx','pptx'].includes(suffix)){
    try {item.content=await readOfficeUpload(file,suffix);} catch {}
    if(suffix==='pptx')item.type='幻灯片';
    if(!item.content)toast('文件可下载，当前无法提取文字。');
  }
  state.files.unshift(item);
  let chat=byId('chats',forChat);
  const newChat=target==='space' && !chat;
  if (newChat) {
    chat={id:uid(),title:'会话资料',messages:[],updated:new Date().toISOString()};
    state.chats.unshift(chat);
  }
  if (target==='space') chat.attachments=[...(chat.attachments||[]),item.id];
  if (!save()) {
    state.files=state.files.filter(f=>f.id!==item.id);await removeOfficeFile(item.id);
    if (newChat) state.chats.shift();
    else if (target==='space') chat.attachments.pop();
    return;
  }
  if (target==='attachment') filesForDraft(attachmentRoute).push(item.id);
  if (target==='space') {workspaceScope='current';spaceSource='attached';spaceType='all';spaceSearch='';if (newChat && page==='chat') go('chat/'+chat.id);}
  fileType='all';caseFilter='all';fileQuery='';
  render({bottom:false});
  toast('文件已保存');
}

document.addEventListener('click',async event=>{
  if(event.target.closest('.skip-link')) {event.preventDefault();document.querySelector('#workspace')?.focus();return;}
  if(event.target.closest('.sidebar a')) mobileMenu=false;
  if (themeMenu && !event.target.closest('.theme-control')) {
    themeMenu=false;
    document.querySelector('.theme-options')?.remove();
    document.querySelector('.theme-trigger')?.setAttribute('aria-expanded','false');
  }
  if (spaceMenu && !event.target.closest('.space-filter')) {
    spaceMenu='';
    document.querySelector('.filter-menu')?.remove();
    document.querySelector('.filter-trigger[aria-expanded=true]')?.setAttribute('aria-expanded','false');
  }
  const control = event.target.closest('[data-action]');
  if(!control) return;
  const {action,id,collection:key} = control.dataset;
  switch(action) {
    case 'menu': mobileMenu=!mobileMenu;render();break;
    case 'fold-nav': navCollapsed=!navCollapsed;render({bottom:false});break;
    case 'theme-menu':
      themeMenu=!themeMenu;render({bottom:false});
      if (themeMenu) document.querySelector('.theme-options [aria-pressed=true]')?.focus();
      break;
    case 'theme-set':
      themeMenu=false;state.profile.theme=id;save();render({bottom:false});document.querySelector('.theme-trigger')?.focus();break;
    case 'command-language': commandLanguage=commandLanguage==='zh'?'en':'zh';render({bottom:false});break;
    case 'history':
      historyOpen=!historyOpen;
      if(historyOpen&&innerWidth<1540)spaceOpen=false;
      render({bottom:false});break;
    case 'space':
      spaceOpen=!spaceOpen;
      if(spaceOpen&&innerWidth<1540)historyOpen=false;
      render({bottom:false});break;
    case 'close-panels': historyOpen=false;spaceOpen=false;render({bottom:false});break;
    case 'space-scope': workspaceScope=id;render({bottom:false});break;
    case 'space-source': spaceSource=id;render({bottom:false});break;
    case 'space-grouping': spaceGrouping=id;render({bottom:false});break;
    case 'space-grid': spaceGrid=!spaceGrid;render({bottom:false});break;
    case 'space-menu':
      spaceMenu=spaceMenu===id?'':id;render({bottom:false});
      if(spaceMenu) document.querySelector('.filter-menu [aria-checked=true]')?.focus();
      break;
    case 'space-filter': {
      const filter=control.dataset.filterKey;
      if(filter==='type')spaceType=id;else spaceSort=id;
      spaceMenu='';render({bottom:false});document.querySelector(`[data-testid="${filter}-filter"]`)?.focus();break;
    }
    case 'toggle-archived': archivedChats=!archivedChats;render({bottom:false});break;
    case 'archive-chat': {
      const chat=byId('chats',id);
      chat.archived=!chat.archived;save();render({bottom:false});toast(chat.archived?'会话已归档':'会话已恢复');break;
    }
    case 'copy-message': {
      const message=byId('chats',activeChat)?.messages[Number(id)];
      if(message)try{await navigator.clipboard.writeText(message.text);toast('已复制消息');}catch{toast('复制失败，请手动选择文字');}
      break;
    }
    case 'prompt-group': promptGroup=id;morePrompts=false;render({bottom:false});break;
    case 'more-prompts': morePrompts=!morePrompts;render({bottom:false});break;
    case 'fill-prompt': {
      const input=document.querySelector('#message');
      input.value=promptGroups[promptGroup][Number(id)]||'';input.focus();break;
    }
    case 'composer-settings':
      modal('对话设置',`<div class="detail-block"><h3>当前模型</h3><p>${escape(connection.name||modelLabel())}</p></div>
      <footer class="dialog-footer">${link('打开个人设置','settings','settings')}${button('完成','close',{primary:true})}</footer>`);break;
    case 'prompt': await send(id);break;
    case 'home-tab': homeTab=id;render({bottom:false});break;
    case 'start-replay': openReplay(caseFilter);break;
    case 'replay-step': replay.step=Number(id);replay.playing=false;paintReplay();break;
    case 'replay-play':
      if(replay.step===2) {replay.step=0;replay.playing=true;paintReplay();}
      else {replay.playing=!replay.playing;setReplayTimer();}
      break;
    case 'file-case': caseFilter=id;fileType='all';fileQuery='';render({bottom:false});break;
    case 'library-layout': libraryLayout=id;render({bottom:false});break;
    case 'case-follow': {
      const input=document.querySelector('#message');
      if (!input.value.trim()) input.value=examples.find(item=>item.id===id).next;
      input.focus();
      break;
    }
    case 'retry-chat': {
      const chat=byId('chats',id);
      if (!chat || loading.has(chat.id) || !chat.messages.at(-1)?.failed) break;
      chat.messages.pop();
      await completeChat(chat,{keepDraft:true});
      break;
    }
    case 'resource-picker':
      picker=picker===id?'':id;
      render({bottom:false});
      if (picker) document.querySelector('.resource-picker input').focus();
      break;
    case 'resource-tab':
      picker=id;render({bottom:false});document.querySelector('.resource-picker input').focus();break;
    case 'resource-close': picker='';render({bottom:false});break;
    case 'resource-pick': {
      if(picker==='models'){
        try{await activateModel(id);}catch(error){toast(error.message);break;}
      }
      if (picker==='skills') selectedSkill=id;
      if (picker==='knowledge') selectedNote=id;
      if (picker==='database') selectedDatabase=id;
      const target=document.querySelector('#message,#home-input');
      const caret=target.selectionStart;
      const head=target.value.slice(0,caret);
      target.value=head.replace(/(?:^|(?<=\s))@[^\s@]*$/,'')+target.value.slice(caret);
      picker='';render({bottom:false});document.getElementById(target.id)?.focus();
      break;
    }
    case 'remove-resource':
      if (id==='skills') selectedSkill='';
      if (id==='knowledge') selectedNote='';
      if (id==='database') selectedDatabase='';
      render({bottom:false});break;
    case 'remove-attachment': draftAttachments.set(page+'/'+routeDetail,filesForDraft().filter(item=>item!==id));render({bottom:false});break;
    case 'open-example': openExample(id); break;
    case 'open-chat': openChat(id);break;
    case 'new-chat': drafts.delete('chat/');activeChat=undefined;activeStaff='';picker='';draftAttachments.delete('chat/');go('chat',{keepDraft:page!=='chat'||Boolean(routeDetail)});document.querySelector('#message')?.focus();break;
    case 'staff-detail': staffDetail(byId('staff',id));break;
    case 'staff-chat': {
      const person = byId('staff',id);
      dialog.close();
      activeStaff=id;
      activeChat=undefined;
      draftAttachments.delete('chat/');drafts.delete('chat/');
      selectedSkill=person.skills?.find(skill=>byId('skills',skill))||'';
      selectedNote=person.note||'';
      selectedDatabase=person.database||'';
      go('chat',{keepDraft:page!=='chat'||Boolean(routeDetail)});document.querySelector('#message')?.focus();
      break;
    }
    case 'staff-tab': staffTab=id;render();break;
    case 'hire-staff':
      if(!byId('staff',id)){state.staff.push({...marketStaff.find(person=>person.id===id)});save();render();toast('已加入我的员工');}
      break;
    case 'skill-detail': skillDetail(byId('skills',id));break;
    case 'market-preview': {
      const skill=byId('market',id),recipe=marketRecipes[id];
      const installed=state.skills.find(item=>item.marketId===id);
      modal(skill.name,`<div class="detail-block"><h3>适用任务</h3><p>${escape(skill.description)}</p></div>
        ${recipe?`<div class="detail-block"><h3>示例指令</h3><blockquote class="prompt-sample">${escape(recipe.example)}</blockquote></div>`:''}
        <footer class="dialog-footer">${button('关闭','close')}${installed?button('在对话中使用','try-skill',{id:installed.id,primary:true}):button('安装技能','install',{id,primary:true})}</footer>`);
      break;
    }
    case 'try-skill':
      selectedSkill=id;activeChat=undefined;activeStaff='';draftAttachments.delete('chat/');drafts.delete('chat/');dialog.close();go('chat',{keepDraft:page!=='chat'||Boolean(routeDetail)});document.querySelector('#message')?.focus();break;
    case 'select-team': activeTeam=id;render();break;
    case 'note': activeNote=id;render();break;
    case 'note-section': {
      const section=document.getElementById('note-section-'+id);
      section?.focus({preventScroll:true});section?.scrollIntoView({block:'start'});break;
    }
    case 'insert-preference': {
      const field=control.form.elements.preferences;
      const next=field.value+(field.value&&!field.value.endsWith('\n')?'\n':'')+id;
      if(next.length>field.maxLength){toast('偏好已达到字数上限');break;}
      field.value=next;field.focus();field.setSelectionRange(next.length,next.length);break;
    }
    case 'note-view': noteView=id;render();break;
    case 'graph-neighborhood': graphNeighborhood=!graphNeighborhood;render({bottom:false});break;
    case 'graph-reset': graphNeighborhood=false;activeNote=state.knowledge[0]?.id;render({bottom:false});break;
    case 'project-detail': projectDetail(byId('projects',id));break;
    case 'project-tab': go(id==='board'?'projects':'projects/'+id);break;
    case 'overview-stage': overviewStage=id;render({bottom:false});break;
    case 'task-view': go(id==='types'?'tasks/types':'tasks');break;
    case 'schedule-day': scheduleDay=Number(id);render({bottom:false});break;
    case 'task-by-type': taskTag=id;taskSearch='';taskStatus='all';go('tasks');break;
    case 'query-db': {
      const item=byId('database',id),quote=item.engine==='MySQL'?String.fromCharCode(96):'"';
      const quoted=quote+String(item.table).replaceAll(quote,quote+quote)+quote;
      const db=databases[item.source]||{schema:(item.columns||[]).map(c=>c.join(' ')).join(' · '),sql:'SELECT * FROM '+quoted+' LIMIT 20'};
      modal(item.name,'<form class="edit-form" data-form="db-query" data-source="'+item.source+'"><p>'+escape(db.schema)+'</p><label>只读 SQL<textarea name="sql" rows="4" maxlength="1800" required>'+escape(db.sql)+'</textarea></label><button class="button primary" type="submit">运行查询</button><output aria-live="polite"></output></form>',true);
      dialog.querySelector('form').requestSubmit();break;
    }
    case 'personal-tab': personalTab=id;render();break;
    case 'memory-toggle': await savePreferences(state.preferences,!state.memoryEnabled);break;

    case 'change-password': case 'issue-recovery': case 'recover-account':{
      const recovery=action==='recover-account',issue=action==='issue-recovery';
      modal(issue?'生成一次性找回码':recovery?'找回账号':'修改密码',`<form class="edit-form" data-form="account-security" data-operation="${issue?'issueRecovery':recovery?'recover':'changePassword'}">
      ${recovery?'<label>账号<input name="login" autocomplete="username" required></label><label>找回码<input name="code" required></label>':'<label>当前密码<input name="current" type="password" autocomplete="current-password" required></label>'}
      ${issue?'<p>新码生成后，旧码即失效。请将新码保存在自己的密码管理器中。</p>':'<label>新密码<input name="password" type="password" minlength="10" maxlength="180" required autocomplete="new-password"></label>'}
      <output role="status"></output><button type="submit" class="button primary">${issue?'生成找回码':'更新密码'}</button></form>`);break;
    }
    case 'account-options':accountOptions();break;
    case 'sync-now':try{await syncController.flush();render();toast(syncController.status);}catch(e){toast(e.message);}break;
    case 'sync-conflicts':{
      const names={chats:'会话',files:'文件',office:'文件内容',knowledge:'笔记',staff:'员工',teams:'团队',skills:'技能',projects:'项目',tasks:'任务',settings:'设置'};
      modal('处理同步冲突',`<p>同一条内容在两台设备上都被修改。请选择要保留的版本。</p>${syncController.conflicts.map(key=>{const [group,id]=key.split('/');const record=state[group]?.find?.(r=>r.id===id);return `<div class="connection-row"><strong>${escape(record?.name||record?.title||names[group])}</strong>${button('保留本机','sync-local',{id:key})}${button('使用云端','sync-remote',{id:key})}</div>`;}).join('')}`);break;
    }
    case 'sync-local':case 'sync-remote':try{await syncController.flush({[id]:action==='sync-local'?'local':'remote'});dialog.close();render();toast(syncController.status);}catch(e){toast(e.message);}break;
    case 'team-invite':modal('邀请成员',`<form class="edit-form" data-form="team-invite"><label>邀请备注<input name="note" maxlength="120"></label><p>邀请码可使用一次，7 天内有效。对方可在注册时填写，已有账号可从「团队与账号」加入。</p><output role="status"></output><button type="submit" class="button primary">生成邀请码</button></form>`);break;
    case 'team-revoke':try{await workspaceAPI('revokeInvite',{params:{id}});await refreshTeam();}catch(e){toast(e.message);}break;
    case 'team-remove':modal('移除团队成员',`<p>移除后，该成员将失去这个工作空间的访问权限。</p><footer class="dialog-footer">${button('取消','close')}${button('确认移除','team-remove-confirm',{id})}</footer>`);break;
    case 'team-remove-confirm':try{await workspaceAPI('removeMember',{params:{id}});dialog.close();await refreshTeam();}catch(e){toast(e.message);}break;
    case 'switch-team':try{await beforeLeave();await switchAccount(await workspaceAPI('switchTeam',{params:{space:id}}));}catch(e){toast(e.message);}break;
    case 'signout':try{
      await beforeLeave();await workspaceAPI('logout');await removeOfficeFile();
      localStorage.removeItem(storageKey);localStorage.removeItem(storageKey+'/sync-index');
      for(const key of ['workspace-account-info','workspace-account-session','workspace-office-scope'])localStorage.removeItem(key);
      location.replace(location.pathname+location.search+'#login');location.reload();
    }catch(e){toast(e.message);}break;
    case 'extract-text':{
      const file=byId('files',id);control.disabled=true;
      try{await extractFile(file);await preview(file);toast('文字已提取，可在笔记、对话和任务中引用');}catch(e){toast(e.message);control.disabled=false;}break;
    }
    case 'open-mcp': await openMcp(id);break;
    case 'read-mcp': {const r=mcpDirectory.resources[Number(id)];await runMcp('read',{uri:r.uri},r.name||r.uri);break;}
    case 'prepare-mcp': {
      const t=mcpDirectory.tools[Number(id)];
      modal(t.name,`<p>${escape(t.description)}</p><details><summary>参数格式</summary><pre class="mcp-result">${escape(JSON.stringify(t.inputSchema,null,2))}</pre></details>
      <form class="edit-form" data-form="run-mcp" data-index="${Number(id)}"><label>参数（JSON 对象）<textarea name="args" rows="5" maxlength="8000" required>{}</textarea></label><p>确认后，远端服务会执行该工具定义的操作。</p><output role="status"></output><footer class="dialog-footer">${button('取消','close')}<button type="submit" class="button primary">确认调用</button></footer></form>`);break;
    }
    case 'mcp-note':{
      modal('整理为笔记',editForm('knowledge'));
      const fields=dialog.querySelector('form').elements;
      fields.name.value=mcpResult.name;fields.description.value='MCP 资源';fields.body.value=mcpResult.text.slice(0,4000);break;
    }
    case 'import-csv': {
      const db=byId('database',id);
      modal(db?'替换表数据':'导入自己的 CSV',`<form data-form="connection" data-kind="database" data-id="${id||''}" class="edit-form"><input type="hidden" name="engine" value="CSV">
        <label>数据源名称<input name="name" required maxlength="80" value="${escape(db?.name||'')}"></label>
        <label>CSV 文件<input name="csvFile" type="file" accept=".csv,text/csv" required></label>
        <p class="footnote">使用带表头的 UTF-8 CSV，最多 64 KB、500 行。数据会加密保存到当前工作空间，可用于只读查询、对话和后台任务。</p>
        <output role="status" class="connection-status"></output><footer class="dialog-footer">${button('取消','close')}<button type="submit" class="button primary">导入数据</button></footer></form>`);break;
    }
    case 'edit-model': modal(id?'编辑模型连接':'添加模型连接',connectionForm('model',modelConnections.find(item=>item.id===id)));break;
    case 'activate-model': try{await activateModel(id);toast('默认模型已更新');}catch(error){toast(error.message);}break;
    case 'reload-connections': try{await syncConnections();render();}catch(error){toast(error.message);}break;
    case 'remove-model': {
      const item=modelConnections.find(item=>item.id===id);
      modal('删除模型连接',`<p>确定删除「${escape(item.name)}」及其凭据？删除后不可恢复。${item.active?'后续请求将使用平台模型。':''}</p><footer class="dialog-footer">${button('取消','close')}${button('确认删除','confirm-remove-model',{id})}</footer>`);break;
    }
    case 'confirm-remove-model': try{await workspaceAPI('removeConnection',{id});await syncConnections();connection=await modelStatus();dialog.close();render();}catch(error){toast(error.message);}break;
    case 'edit': if(key==='tools'){modal(id?'配置 MCP 服务':'连接 MCP 服务',connectionForm('tool',byId(key,id)));break;}if(key==='database'){modal(id?'编辑数据库连接':'新增数据库连接',connectionForm('database',byId(key,id)));break;}modal(id ? '编辑'+formTitles[key] : collections[key]?.[2] || '新建'+formTitles[key],editForm(key,id));break;
    case 'close': if (!restorePreviewParent()) dialog.close();break;
    case 'delete': {
      const item = byId(key,id);
      modal('确认删除',`<p>确定删除「${escape(item.name || item.title)}」？删除后不可恢复。</p><footer class="dialog-footer">${button('取消','close')}${button('确认删除','confirm-delete',{id,extra:`data-collection="${key}"`})}</footer>`);
      break;
    }
    case 'confirm-delete': {
      if(['database','tools'].includes(key)&&byId(key,id)?.remoteConnection){
        try{await workspaceAPI('removeConnection',{id});}catch(error){toast(error.message);break;}
      }
      if(key==='tasks' && byId(key,id)?.scheduled){
        try {await workspaceAPI('remove',{id});}catch(error){toast(error.message);break;}
      }
      const stored=key==='files' && byId('files',id)?.storedOffice;
      state[key]=state[key].filter(item=>item.id!==id);
      if (key==='chats'&&id===activeChat) activeChat=state.chats[0]?.id;
      if(save() && stored) await removeOfficeFile(id).catch(()=>{});
      dialog.close();render();toast('已删除');break;
    }
    case 'file-preview':
      if (dialog.open && !dialog.dataset.file) {
        pauseReplay();
        previewParent={nodes:[...dialog.childNodes],className:dialog.className,focus:control,scroll:dialog.scrollTop,label:dialog.querySelector('.case-replay')?'返回演示':'返回任务'};
      }
      preview(byId('files',id));break;
    case 'ask-file': {
      const file=byId('files',id);
      if (!file) break;
      const current=page==='chat'?byId('chats',activeChat):null;
      const owner=current || state.chats.find(chat=>chat.example && chat.messages.some(m=>m.files?.includes(id)||m.attachments?.includes(id)));
      dialog.close();
      if (!current) {activeStaff='';selectedSkill='';selectedNote='';selectedDatabase='';}
      const attached=filesForDraft('chat/'+(owner?.id||''));
      if(!attached.includes(id))attached.push(id);
      focusComposer=true;spaceOpen=false;picker='';
      if(compactChat())historyOpen=false;
      go(owner?'chat/'+owner.id:'chat');
      break;
    }
    case 'preview-sheet': preview(byId('files',id),Number(control.dataset.sheet));dialog.querySelector('.sheet-tabs [aria-pressed=true]')?.focus({preventScroll:true});break;
    case 'export-reply':
      modal('导出这条回复','<div class="row-actions">'+['Word','PowerPoint','Excel'].map((name,i)=>button(name,'export-office',{id,extra:'data-format="'+['docx','pptx','xlsx'][i]+'"'})).join('')+button('Markdown','save-reply',{id})+'</div>');
      break;
    case 'export-office': {
      const chat=byId('chats',activeChat), message=chat?.messages[Number(id)];
      const label={docx:'Word',pptx:'PowerPoint',xlsx:'Excel'}[control.dataset.format];
      if(!message || !label || loading.has(chat.id))break;
      dialog.close();
      await send('将所选回复导出为 '+label+' 文件。',chat.id,message.text);
      break;
    }
    case 'save-reply': {
      dialog.close();
      const chat = byId('chats',activeChat);
      const message = chat?.messages[Number(id)];
      if (!message || message.savedFile && byId('files',message.savedFile)) { toast('这条回复已保存到文件管理'); break; }
      const item = {id:uid(),name:chat.title+'.md',type:'文档',mime:'text/markdown',content:message.text,at:new Date().toISOString()};
      message.savedFile = item.id;
      message.files = [...(message.files || []),item.id];
      state.files.unshift(item);
      save();render();toast('已保存，可在会话空间中查看');
      break;
    }
    case 'download': download(byId('files',id));break;
    case 'install': {
      if(state.skills.some(item=>item.marketId===id))break;
      const skill=byId('market',id);
      state.skills.unshift({...skill,instructions:skill.instructions||marketRecipes[id]?.example||'',id:uid(),marketId:id});
      save();if(dialog.open)dialog.close();render();toast('已添加到我的技能');break;
    }
    case 'run': await runTask(byId('tasks',id));break;
    case 'runs': runFilter='all';runIndex=0;go('tasks/'+id);break;
    case 'run-filter': runFilter=id;runIndex=0;render();break;
    case 'run-detail': runIndex=Number(id);render();break;
    case 'task-step': taskStep(control.closest('form'),id);break;
    case 'refresh-model':
      connection.checking=true;render();
      connection=await modelStatus(true);
      if(page==='models'){render();toast(modelLabel());}
      break;
    case 'reset': if(account){toast('已登录的共享工作空间请逐项管理数据');break;}modal('恢复示例数据',`<p>当前浏览器中的编辑和上传会被替换为初始示例。</p><footer class="dialog-footer">${button('取消','close')}${button('确认恢复','confirm-reset',{primary:true})}</footer>`);break;
    case 'confirm-reset': drafts.clear();draftAttachments.clear();caseFilter='all';fileQuery='';homeTab='cases';state=load(true);activeChat=state.chats[0]?.id;activeNote=state.knowledge[0]?.id;if(save())await removeOfficeFile().catch(()=>{});dialog.close();render();break;
  }
  if (['file-case','library-layout','schedule-day','overview-stage','task-view','project-tab'].includes(action)) {
    const target=app.querySelector(`[data-action="${action}"][data-id="${CSS.escape(id)}"]`) || app.querySelector('.library-controls input');
    target?.focus({preventScroll:true});
  }
});
document.addEventListener('submit',async event=>{
  const form=event.target;
  if(form.dataset.form==='db-query'){
    event.preventDefault();const field=form.querySelector('output'),seq=String(Number(form.dataset.querySeq||0)+1);form.dataset.querySeq=seq;field.textContent='正在查询…';
    try {const r=await workspaceAPI('query',{source:form.dataset.source,sql:form.elements.sql.value});
      if(form.dataset.querySeq!==seq)return;field.innerHTML='<p>'+r.rows.length+' 行'+(r.truncated?' · 仅展示前 50 行':'')+'</p>'+dataTable(r.columns,r.rows);
    }catch(e){if(form.dataset.querySeq===seq)field.textContent=e.message;}return;
  }
  if(!form.dataset.form)return;
  event.preventDefault();
  const values=Object.fromEntries(new FormData(form));
  if (form.dataset.form==='chat' || form.dataset.form==='home') {
    const prompt=values.prompt?.trim();
    if(prompt) void send(prompt,form.dataset.form==='chat'?activeChat:undefined);
  } else if(form.dataset.form==='account-security'){
    try{const result=await workspaceAPI(form.dataset.operation,{params:values});
      if(result.code)modal('一次性找回码',`<p>请妥善保存，关闭后无法再次查看。</p><input aria-label="找回码" readonly value="${escape(result.code)}">${button('完成','close')}`);
      else{dialog.close();toast('密码已更新');}
    }catch(e){form.querySelector('output').textContent=e.message;}
  } else if(['login','register','team-invite','join-team'].includes(form.dataset.form)){
    const action=form.dataset.form,status=form.querySelector('output'),submit=form.querySelector('[type=submit]');
    if(submit.disabled)return;submit.disabled=true;
    try{
      if(action==='register'&&values.again!==values.password)throw Error('两次输入的密码不一致');
      if(action==='login'||action==='register'){
        status.textContent='正在连接…';
        const {login,password,display,invite}=values;
        const result=await workspaceAPI(action,{params:{login,password,display,invite}});
        await switchAccount(result,action==='register');
      }else if(action==='join-team'){await beforeLeave();await switchAccount(await workspaceAPI('joinTeam',{params:{code:values.code}}));}
      else{
        const {code}=await workspaceAPI('invite',{params:{note:values.note}});
        modal('团队邀请码',`<p>把这个一次性邀请码交给要加入的成员。</p><label class="edit-form">邀请码<input readonly value="${escape(code)}" aria-label="团队邀请码"></label><footer class="dialog-footer">${button('完成','close')}</footer>`);
        await refreshTeam();render();
      }
    }catch(e){status.textContent=e.message;}finally{submit.disabled=false;}
  } else if(form.dataset.form==='run-mcp'){
    const tool=mcpDirectory.tools[Number(form.dataset.index)];
    try{
      const args=JSON.parse(values.args);
      if(!args||typeof args!=='object'||Array.isArray(args))throw Error();
      await runMcp('call',{name:tool.name,arguments:args},tool.name);
    }catch{form.querySelector('output').textContent='请输入有效的 JSON 对象';}
  } else if(form.dataset.form==='connection'){
    if(form.dataset.saving)return;
    const submit=form.querySelector('[type=submit]'),status=form.querySelector('output');
    form.dataset.saving='true';submit.disabled=true;status.textContent='正在验证连接…';
    const config={...values,kind:form.dataset.kind,id:form.dataset.id||uid()};
    form.dataset.id=config.id;
    try{
      if(config.csvFile){
        if(config.csvFile.size>64000)throw Error('CSV 最大为 64 KB');
        config.csv=await config.csvFile.text();delete config.csvFile;
      }
      await workspaceAPI('saveConnection',{config});
      await syncConnections();
      if(form.isConnected){dialog.close();render();toast(config.kind==='model'?'模型已验证，可设为默认':config.kind==='tool'?'MCP 服务已连接':'数据库已连接');}
    }catch(error){status.textContent=error.message;}
    finally{delete form.dataset.saving;submit.disabled=false;}
  } else if (form.dataset.form==='system') {
    void saveSystemSettings(values).catch(()=>toast('图标读取失败，请重新选择'));
  } else if (form.dataset.form==='memory') {
    await savePreferences(values.preferences.trim(),state.memoryEnabled);
  } else if (form.dataset.form==='invite') {
    const note=values.note.trim();
    if(!note)return;
    const id=uid();
    state.invites.unshift({id,code:'DEMO-'+id.slice(0,6).toUpperCase(),note,status:'未使用'});
    save();dialog.close();render();toast('已生成演示邀请码');
  } else if (form.dataset.form==='project-detail') {
    const item=byId('projects',form.dataset.id);
    const comment=values.comment.trim();
    if(!item) return;
    Object.assign(item,{owner:values.owner.trim(),status:values.status,description:values.description.trim()});
    if(comment)item.comments=[...(item.comments || []),{author:state.profile.name,text:comment}];
    save();dialog.close();render();toast('任务已保存');
  } else if (form.dataset.form==='edit') {
    const {collection:key,id}=form.dataset;
    if(key==='tasks'&&!form.querySelector('[data-task-step="config"]').hidden){taskStep(form,'schedule');return;}
    const existing=byId(key,id);
    const name=values.name.trim();
    if(!name) {toast('请输入名称');return;}
    const record={...existing,...values,name,id:id||uid()};
    if (key==='tasks') {
      if(form.dataset.saving)return;
      record.enabled=values.enabled==='已启用';record.runs=existing?.runs||[];
      const {id,name,time,tag,description,frequency,enabled,assignee,source,skillId,noteId,fileId}=record;
      const refs=[['skill',byId('skills',skillId)],['knowledge',byId('knowledge',noteId)],['attachment',byId('files',fileId)]];
      record.references=refs.filter(([,item])=>item).map(([kind,item])=>({kind,name:item.name.slice(0,160),text:String(kind==='attachment'?fileText(item):item.body||item.instructions||item.description||'').slice(0,3000)}));
      form.dataset.saving='true';
      try {
        const instructions=(byId('staff',assignee)?.description||'').slice(0,700);
        const saved=await workspaceAPI('save',{task:{id,name,time,tag,description,frequency,enabled,assignee,source,instructions,skillId,noteId,fileId,references:record.references}});
        record.scheduled=true;record.next=saved.next;
      } catch(error){toast(error.message);return;}finally{delete form.dataset.saving;}
    }
    if(key==='staff'){record.skills=new FormData(form).getAll('skills');record.vault=Boolean(record.note);}
    if(key==='knowledge')delete record.importNote;
    if (key==='teams') record.members=new FormData(form).getAll('members');
    if(existing) Object.assign(existing,record);
    else state[key].unshift(record);
    if(key==='knowledge') activeNote=record.id;
    save();dialog.close();render();toast('已保存');
  }
});
document.addEventListener('input',event=>{
  const target=event.target;
  if(target.form?.dataset.form==='system'&&['brandName','name'].includes(target.name)){
    document.querySelector(`[data-brand-preview="${target.name}"]`).textContent=target.name==='brandName'?'工作台 · '+target.value:target.value;
  }
  if(target.id==='note-search'&&target.value.trim())document.querySelector('.note-index').open=true;
  if(target.id==='file-search'){fileQuery=target.value;document.querySelector('#workspace-files').innerHTML=fileResults();document.querySelector('#file-count').textContent=visibleFiles().length+' 份文件';}
  if(target.id==='task-search'){taskSearch=target.value;document.querySelector('#task-rows').innerHTML=taskRows();}
  if(target.id==='space-search'){
    spaceSearch=target.value;
    document.querySelector('#space-results').innerHTML=spaceResults(byId('chats',activeChat));
  }
  if(target.id==='message'&&!event.isComposing){
    const head=target.value.slice(0,target.selectionStart);
    if(!picker&&/(?:^|\s)@$/.test(head)){picker='skills';render({bottom:false});document.querySelector('.resource-picker input')?.focus();}
  }
  const query=event.target.dataset.filter;
  if(query) document.querySelectorAll(query+' [data-search]').forEach(row=>{
    row.hidden=!row.dataset.search.toLowerCase().includes(event.target.value.trim().toLowerCase());
  });
  if(query==='#collection-list'){
    document.querySelector('.search-empty').hidden=!target.value.trim()||!!document.querySelector('#collection-list [data-search]:not([hidden])');
  }
});
document.addEventListener('change',event=>{
  const target=event.target;
  if(target.form?.dataset.form==='system'&&target.type==='file')void previewBrandAsset(target);
  if(target.hasAttribute('data-replay-case')){openReplay(target.value);dialog.querySelector('[data-replay-case]').focus();}
  if(target.id==='task-status'||target.id==='task-tag'){
    if(target.id==='task-status')taskStatus=target.value;
    else taskTag=target.value;
    document.querySelector('#task-rows').innerHTML=taskRows();
  }
  if(target.name==='importNote'&&target.value){
    const file=byId('files',target.value),form=target.form;
    if(file){form.elements.body.value=fileText(file).slice(0,4000);if(!form.elements.name.value)form.elements.name.value=file.name;if(!form.elements.description.value)form.elements.description.value='文件资料';}
  }
  if(target.name==='engine'&&target.form?.dataset.kind==='database'){
    const port=target.form.elements.port;
    if(['','3306','5432'].includes(port.value))port.value=target.value==='MySQL'?'3306':'5432';
  }
  if(target.dataset.project){byId('projects',target.dataset.project).status=target.value;save();render();}
  if(target.id==='file-type'){fileType=target.value;render({bottom:false});document.querySelector('#file-type')?.focus({preventScroll:true});}
  if((target.dataset.upload||target.id==='file-upload')&&target.files[0])void upload(target.files[0],target.dataset.upload,activeChat).catch(()=>toast('文件读取失败，请重试。'));
});
document.addEventListener('keydown',event=>{
  if(event.key==='Escape'&&(themeMenu||spaceMenu)&&!dialog.open){
    const selector=themeMenu?'.theme-trigger':`[data-testid="${spaceMenu}-filter"]`;
    themeMenu=false;spaceMenu='';render({bottom:false});document.querySelector(selector)?.focus();return;
  }
  const filter=event.target.closest?.('.filter-menu');
  if(filter&&['ArrowDown','ArrowUp','Home','End'].includes(event.key)){
    event.preventDefault();
    const buttons=[...filter.querySelectorAll('button')];
    const index=buttons.indexOf(document.activeElement);
    buttons[event.key==='Home'?0:event.key==='End'?buttons.length-1:(index+(event.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length]?.focus();
  }
  if(event.key==='Escape'&&picker&&!dialog.open){picker='';render({bottom:false});document.querySelector('#message,#home-input')?.focus();}
  if(event.target.id==='message'&&event.key==='Enter'&&!event.shiftKey&&!event.isComposing){
    event.preventDefault();
    event.target.form.requestSubmit();
  }
});
window.addEventListener('storage',event=>{if(event.key==='workspace-account-session')location.reload();});
document.addEventListener('focusout',()=>{if(syncNeedsRender)setTimeout(()=>{if(!dialog.open&&!loading.size&&!document.activeElement?.matches('input,textarea,select')){syncNeedsRender=false;render({bottom:false});}},0);});
window.addEventListener('hashchange',()=>{
  picker='';themeMenu=false;spaceMenu='';
  const [key,detail='']=location.hash.slice(1).split('/');
  if ((key||'home')!==page || detail!==routeDetail) render();
  if(key==='tasks')void refreshSchedule();
  if(key==='users'&&account)refreshTeam().catch(e=>toast(e.message));
});
window.addEventListener('resize',paintCharts);
async function boot(){
  if(account){
    try{
      account=await workspaceAPI('account');if(!account.signedIn)throw Error('请登录');
      const pref=await workspaceAPI('getPrefs');preferenceRev=pref.rev;
      if(pref.value){state.preferences=pref.value.preferences;state.memoryEnabled=pref.value.enabled;}
      syncController=teamSync({scope:storageKey,read:()=>state,persist:()=>{try{localStorage.setItem(storageKey,JSON.stringify(state));return true;}catch{return false;}},
        canApply:()=>!dialog.open&&!loading.size&&!document.activeElement?.matches('input,textarea,select'),
        notify:()=>{if(!dialog.open&&!loading.size&&!document.activeElement?.matches('input,textarea,select'))render({bottom:false});else syncNeedsRender=true;}});
      await syncController.flush();
      if(location.hash==='#users')await refreshTeam();
    }catch(e){
      if(/过期|请登录|访问权限/.test(e.message)){
        for(const key of ['workspace-account-session','workspace-account-info','workspace-office-scope'])localStorage.removeItem(key);
        location.replace(location.pathname+location.search+'#login');location.reload();return;
      }
      toast('同步暂时不可用：'+e.message);
    }
  }
render();
void syncConnections().then(()=>{if(['models','database','settings'].includes(page)&&!dialog.open)render({bottom:false});}).catch(()=>{connectionCatalogError='暂时无法载入已保存的连接';if(page==='models'&&!dialog.open)render({bottom:false});});
void modelStatus().then(result=>{
  if (!connection.checking) return;
  connection=result;
  if (page==='models'||picker==='models') render({bottom:false});
});

}
void boot();
let refreshingSchedule=false;
async function refreshSchedule(){
  if(refreshingSchedule || document.hidden || page!=='tasks')return;
  refreshingSchedule=true;
  try {
    const {jobs}=await workspaceAPI('list');let changed=false;
    for(const {config,next,runs} of jobs){
      let task=byId('tasks',config.id);
      if(!task){task={...config,runs:[]};state.tasks.unshift(task);changed=true;}
      const previous=JSON.stringify(task);
      const scheduled=runs.map(({id,slot,status,seconds,text,prompt,files})=>{
        for(const f of files)if(!byId('files',f.id))state.files.unshift({...f,remote:true,at:new Date(slot*1000).toISOString(),type:f.name.endsWith('.xlsx')?'表格':f.name.endsWith('.pptx')?'幻灯片':'文档'});
        return {scheduledId:id,at:beijingTime(new Date(slot*1000),true),status,seconds,text,prompt,files:files.map(f=>f.id),logs:['服务器按北京时间触发']};
      });
      const allRuns=[...scheduled,...task.runs.filter(r=>!r.scheduledId)].sort((a,b)=>String(b.at).localeCompare(String(a.at)));
      Object.assign(task,config,{next,scheduled:true,runs:allRuns});
      if(previous!==JSON.stringify(task))changed=true;
    }
    if(changed){save();if(!dialog.open && page==='tasks')render({bottom:false});}
  }catch(error){if(page==='tasks' && !dialog.open){const note=document.querySelector('.tasks-page .footnote');if(note)note.textContent='暂时无法刷新服务器执行记录。';}}
  finally{refreshingSchedule=false;}
}
window.addEventListener('storage',event=>{if(event.key==='workspace-account-session')location.reload();});
document.addEventListener('focusout',()=>{if(syncNeedsRender)setTimeout(()=>{if(!dialog.open&&!loading.size&&!document.activeElement?.matches('input,textarea,select')){syncNeedsRender=false;render({bottom:false});}},0);});
window.addEventListener('hashchange',refreshSchedule);
document.addEventListener('visibilitychange',refreshSchedule);
setInterval(refreshSchedule,15000);
void refreshSchedule();
