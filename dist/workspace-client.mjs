import {apiUrl} from './api.mjs';
export const databases={
  sales:{table:'orders',schema:'order_id 订单号 · day 日期 · channel 渠道 · amount 销售额（元）· refund 退款额（元）',sql:'SELECT channel AS 渠道, COUNT(*) AS 订单数, SUM(amount-refund) AS 净销售额 FROM orders GROUP BY channel ORDER BY 净销售额 DESC'},
  service:{table:'tickets',schema:'ticket_id 工单号 · day 日期 · topic 分类 · status 状态 · hours 处理时长（小时）',sql:'SELECT topic AS 分类, COUNT(*) AS 工单数, ROUND(AVG(hours),1) AS 平均时长 FROM tickets GROUP BY topic'},
};
const session=localStorage.getItem('workspace-account-session');
export function workspaceToken(){
  if(session)return session;
  let token=localStorage.getItem('workspace-task-owner');
  if(!token){token=Array.from(crypto.getRandomValues(new Uint8Array(32)),x=>x.toString(16).padStart(2,'0')).join('');localStorage.setItem('workspace-task-owner',token);}
  return token;
}
export async function workspaceAPI(action,fields={}){
  const token=workspaceToken();
  const resp=await fetch(apiUrl('/api/workspace'),{method:'POST',headers:{'Content-Type':'application/json','X-Workspace':token},body:JSON.stringify({action,...fields}),signal:AbortSignal.timeout(['saveConnection','mcp','extractText'].includes(action)?42000:22000)});
  const data=await resp.json();if(!resp.ok)throw Error(data.error||'后台服务暂时不可用');
  return data;
}
