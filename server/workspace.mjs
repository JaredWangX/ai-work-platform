import {requestAutoDL} from './autodl-bridge.mjs';

const sources={
  sales:'orders(order_id 整数, day 日期, channel 渠道, amount 销售额元, refund 退款元)',
  service:'tickets(ticket_id 整数, day 日期, topic 问题分类, status 处理状态, hours 处理时长小时)',
};
export async function callWorkspace(env, body) {
  const response=await requestAutoDL(env,'workspace',JSON.stringify(body),['saveConnection','mcp','extractText'].includes(body.action)?35000:15000);
  const result=await response.json();
  if(!response.ok) throw Error(result.error||'工作空间服务不可用');
  return result;
}
export async function workspaceRoute(request,env){
  if(request.method!=='POST'||request.headers.get('Origin')&&request.headers.get('Origin')!==new URL(request.url).origin)return Response.json({error:'请求无效'},{status:403});
  if(!request.headers.get('Content-Type')?.startsWith('application/json'))return Response.json({error:'需要 JSON'},{status:415});
  try {
    const reader=request.body.getReader(),decoder=new TextDecoder();let size=0,body='';
    for(;;){const {done,value}=await reader.read();if(done)break;if((size+=value.length)>5400000){await reader.cancel();return Response.json({error:'请求过大'},{status:413});}body+=decoder.decode(value,{stream:true});}
    const input=JSON.parse(body+decoder.decode());
    if(size>100000&&input.action!=='extractText')throw Error('请求过大');
    if(!['extractText','save','remove','list','file','query','connections','saveConnection','activateModel','removeConnection','describe','mcp','register','login','account','logout','members','joinTeam','switchTeam','invite','revokeInvite','removeMember','syncIndex','syncGet','syncPut','syncCommit','recover','getPrefs','setPrefs','changePassword','issueRecovery'].includes(input.action))throw Error('操作无效');
    const workspace=request.headers.get('X-Workspace')||'';
    const {action,task,id,source,sql,config,operation,params}=input;
    return Response.json(await callWorkspace(env,{action,task,id,source,sql,config,operation,params,workspace}),{headers:{'Cache-Control':'private, no-store'}});
  }catch(error){
    const msg=/[一-龥]/.test(error.message)?error.message:'工作空间服务暂时不可用';
    return Response.json({error:msg},{status:400,headers:{'Cache-Control':'no-store'}});
  }
}

export async function addQueryResult(entries,messages,env,ask,model){
  const latest=entries.at(-1);
  const source=latest.resources?.find(item=>item.kind==='database')?.source;
  if(!source){if(latest.resources?.some(r=>r.kind==='database'))throw Error('数据源尚未连接');return;}
  const demo=Object.hasOwn(sources,source);
  const description=demo?null:await callWorkspace(env,{action:'describe',source,internalOwner:env.owner});
  const scope=demo?'SQLite '+sources[source]+'。演示数据时间为 2026 年 11 月 1–21 日，销售净额为 amount-refund。':
    (description.engine==='CSV'?'SQLite':description.engine)+' '+JSON.stringify({table:description.table,columns:description.columns})+'。不要假定单位和时间范围。';
  const prompt='为问题编写一条单表 SELECT，只返回 JSON {"sql":"SELECT ..."}。按问题聚合，仅使用以下表和字段：'+scope;
  const response=await ask(env,'chat',JSON.stringify({model,messages:[{role:'system',content:prompt},{role:'user',content:latest.content}],temperature:0,max_tokens:450,stream:false,response_format:{type:'json_object'},chat_template_kwargs:{enable_thinking:false}}),45000);
  if(!response.ok)throw Error('查询规划失败');
  const sql=JSON.parse((await response.json()).choices[0].message.content.replace(/^```(?:json)?\s*|\s*```$/gi,'')).sql;
  const result=await callWorkspace(env,{action:'query',source,sql,internalOwner:env.owner});
  messages.at(-1).content+='\n\n服务器实际执行的只读查询与返回行\n'+JSON.stringify({sql,...result});
}
