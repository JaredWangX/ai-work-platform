import http from 'node:http';
import { Readable } from 'node:stream';
import worker from '../dist/server/index.js';

const port = Number(process.env.PORT || 5091);
const server = http.createServer(async (request,response) => {
  try {
    const body = ['GET','HEAD'].includes(request.method) ? undefined : Readable.toWeb(request);
    const result = await worker.fetch(new Request('http://127.0.0.1:'+port+request.url, {
      method:request.method,headers:request.headers,body,...(body ? {duplex:'half'} : {}),
    }),process.env);
    response.writeHead(result.status,Object.fromEntries(result.headers));
    if (result.body) Readable.fromWeb(result.body).pipe(response);
    else response.end();
  } catch {
    response.writeHead(500).end();
  }
});
server.listen(port,'127.0.0.1',()=>console.log('http://127.0.0.1:'+port));
