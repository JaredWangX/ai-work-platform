import { timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { modelRoute } from './model.mjs';

const port = Number(process.env.WORKSPACE_RELAY_PORT || 5093);
const target = process.env.WORKSPACE_RELAY_UPSTREAM;
const bridge = process.env.WORKSPACE_RELAY_BRIDGE_URL;
if (!bridge && !target?.endsWith('/v1/chat/completions')) throw Error('Set an workspace relay upstream.');
const input = createInterface({input:process.stdin});
const secretInput = Promise.race([once(input,'line'),once(input,'close').then(()=>[])]);
console.log('Waiting for the relay credential on stdin.');
const [credentials] = await secretInput;
input.close();
const [secret, bridgeKey] = (credentials || '').trim().split(/\s+/);
if (!/^[0-9a-f]{64}$/.test(secret || '')) throw Error('Missing relay credential.');
if (bridge && !/^[0-9a-f]{64}$/.test(bridgeKey || '')) throw Error('Missing AutoDL bridge key.');
const modelEnv = bridge ? {MODEL_BRIDGE_URL:bridge,MODEL_BRIDGE_KEY:bridgeKey} : {MODEL_CHAT_URL:target};
const expected = Buffer.from('Bearer '+secret);
const maxRequests = 4;
const maxBytes = 62_000;
let activeRequests = 0;

function authenticated(header) {
  const supplied = Buffer.from(header || '');
  return supplied.length === expected.length && timingSafeEqual(supplied,expected);
}

function reply(response,status,body) {
  response.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});
  response.end(JSON.stringify(body));
}

const relay = createServer(async (request,response) => {
  const isHealth = request.method==='GET' && request.url==='/v1/models';
  const isChat = request.method==='POST' && request.url==='/v1/chat/completions';
  if (!isHealth && !isChat) return reply(response,404,{error:'Not found'});
  if (!authenticated(request.headers.authorization)) return reply(response,401,{error:'Unauthorized'});
  if (isHealth) {
    const result = await modelRoute(new Request('http://localhost/api/model'),modelEnv);
    const {available,name} = await result.json();
    return reply(response,available ? 200 : 503,{data:available ? [{id:name}] : []});
  }
  if (activeRequests>=maxRequests) return reply(response,429,{error:'Relay busy'});
  activeRequests++;
  try {
    const chunks = [];
    let bytes = 0;
    for await (const chunk of Readable.toWeb(request)) {
      bytes += chunk.byteLength;
      if (bytes>maxBytes) return reply(response,413,{error:'Request too large'});
      chunks.push(chunk);
    }
    let messages;
    try { ({messages} = JSON.parse(Buffer.concat(chunks))); }
    catch { return reply(response,400,{error:'Invalid message body'}); }
    if (!Array.isArray(messages)) return reply(response,400,{error:'Missing messages'});
    // modelRoute applies the same system prompt and limits at the model boundary.
    const history = messages[0]?.role==='system' ? messages.slice(1) : messages;
    const result = await modelRoute(new Request('http://localhost/api/chat',{
      method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({messages:history}),
    }),modelEnv);
    const data = await result.json();
    if (!result.ok) return reply(response,result.status,{error:data.error});
    return reply(response,200,{model:data.model,choices:[{message:{role:'assistant',content:data.text}}]});
  } catch {
    return reply(response,503,{error:'Relay unavailable'});
  } finally {
    activeRequests--;
  }
});
relay.listen(port,'127.0.0.1',()=>console.log('Model relay listening on 127.0.0.1:'+port));
