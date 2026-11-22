import {requestAutoDL} from './autodl-bridge.mjs';

const sources={
  sales:'orders(order_id 整数, day 日期, channel 渠道, amount 销售额元, refund 退款元)',
  service:'tickets(ticket_id 整数, day 日期, topic 问题分类, status 处理状态, hours 处理时长小时)',
};
async function callWorkspace(env, body) {
  const response=await requestAutoDL(env,'workspace',JSON.stringify(body),12000);
  const result=await response.json();
  if(!response.ok) throw Error(result.error||'工作空间服务不可用');
  return result;
}
export async function workspaceRoute(request,env){
  if(request.method!=='POST'||request.headers.get('Origin')&&request.headers.get('Origin')!==new URL(request.url).origin)return Response.json({error:'请求无效'},{status:403});
  if(!request.headers.get('Content-Type')?.startsWith('application/json'))return Response.json({error:'需要 JSON'},{status:415});
  try {
    const reader=request.body.getReader(),decoder=new TextDecoder();let size=0,body='';
    for(;;){const {done,value}=await reader.read();if(done)break;if((size+=value.length)>12000){await reader.cancel();return Response.json({error:'请求过大'},{status:413});}body+=decoder.decode(value,{stream:true});}
    const input=JSON.parse(body+decoder.decode());
    if(!['save','remove','list','file','query'].includes(input.action))throw Error('操作无效');
    const workspace=request.headers.get('X-Workspace')||'';
    return Response.json(await callWorkspace(env,{...input,workspace}),{headers:{'Cache-Control':'private, no-store'}});
  }catch(error){
    const msg=/[一-龥]/.test(error.message)?error.message:'工作空间服务暂时不可用';
    return Response.json({error:msg},{status:400,headers:{'Cache-Control':'no-store'}});
  }
}

export async function addQueryResult(entries,messages,env,ask,model){
  const latest=entries.at(-1);
  const source=latest.resources?.find(item=>item.kind==='database' && Object.hasOwn(sources,item.source))?.source;
  if(!source)return;
  const prompt='为用户问题编写一条 SQLite SELECT，直接返回 JSON {"sql":"SELECT ..."}。唯一可查询的表为 '+sources[source]+'。样本数据时间为 2026 年 11 月 1–21 日。按问题聚合并保留字段单位；销售净额是 amount-refund。不得编造列名。';
  const response=await ask(env,'chat',JSON.stringify({model,messages:[{role:'system',content:prompt},{role:'user',content:latest.content}],temperature:0,max_tokens:450,stream:false,response_format:{type:'json_object'},chat_template_kwargs:{enable_thinking:false}}),45000);
  if(!response.ok)throw Error('查询规划失败');
  const sql=JSON.parse((await response.json()).choices[0].message.content).sql;
  const result=await callWorkspace(env,{action:'query',source,sql});
  messages.at(-1).content+='\n\n服务器实际执行的演示库只读查询与返回行（金额单位元）\n'+JSON.stringify({sql,...result});
}
