import {apiUrl} from './api.mjs';
export const databases={
  sales:{table:'orders',
    analysis:{title:'核对每日净销售额',description:'按订单日期汇总销售额和退款额。净销售额等于两者之差，金额单位为元。',sql:'SELECT day AS 日期, SUM(amount) AS 销售额, SUM(refund) AS 退款额, SUM(amount-refund) AS 净销售额 FROM orders GROUP BY day ORDER BY day'},
    schema:'order_id 订单号 · day 日期 · channel 渠道 · amount 销售额（元）· refund 退款额（元）',sql:'SELECT channel AS 渠道, COUNT(*) AS 订单数, SUM(amount-refund) AS 净销售额 FROM orders GROUP BY channel ORDER BY 净销售额 DESC'},
  service:{table:'tickets',
    analysis:{title:'定位待跟进工单',description:'按问题分类和当前状态统计未解决工单，优先查看积压量最大的组合，再回到工单明细核对。',sql:"SELECT topic AS 分类, status AS 当前状态, COUNT(*) AS 工单数 FROM tickets WHERE status <> '已解决' GROUP BY topic, status ORDER BY 工单数 DESC, 分类, 当前状态"},
    schema:'ticket_id 工单号 · day 日期 · topic 分类 · status 状态 · hours 处理时长（小时）',sql:'SELECT topic AS 分类, COUNT(*) AS 工单数, ROUND(AVG(hours),1) AS 平均时长 FROM tickets GROUP BY topic'},
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
