import { readLines } from '../dist/events.mjs';

export function decodeHttpChunks(body) {
  let pending = new Uint8Array();
  let size;
  let ended = false;
  const decoder = new TextDecoder();
  return body.pipeThrough(new TransformStream({
    transform(input,controller) {
      if (ended) return;
      const buffer = new Uint8Array(pending.length + input.length);
      buffer.set(pending);
      buffer.set(input,pending.length);
      let offset = 0;
      while (offset < buffer.length) {
        if (size === undefined) {
          const limit = Math.min(buffer.length - 1,offset + 32);
          let end = offset;
          while (end < limit && (buffer[end] !== 13 || buffer[end+1] !== 10)) end++;
          if (end === limit) {
            if (limit-offset >= 32) throw Error('Invalid HTTP chunk length');
            break;
          }
          const length = decoder.decode(buffer.subarray(offset,end)).split(';',1)[0];
          if (!/^[\da-f]{1,8}$/i.test(length)) throw Error('Invalid HTTP chunk length');
          size = parseInt(length,16);
          if (!size) { ended = true; return; }
          if (size > 131_072) throw Error('HTTP chunk too large');
          offset = end + 2;
        }
        if (buffer.length - offset < size + 2) break;
        const end = offset + size;
        if (buffer[end] !== 13 || buffer[end+1] !== 10) throw Error('Invalid HTTP chunk separator');
        controller.enqueue(buffer.subarray(offset,end));
        offset = end + 2;
        size = undefined;
      }
      pending = buffer.subarray(offset);
    },
    flush() {
      if (!ended) throw Error('Incomplete HTTP chunked response');
    },
  }));
}

async function postToPort(url, payload, timeout) {
  const target = new URL(url);
  const {connect} = await import('cloudflare:sockets');
  const socket = connect({hostname:target.hostname, port:Number(target.port)});
  const close = () => socket.close().catch(()=>{});
  const timer = setTimeout(() => { void close(); },timeout);
  socket.closed.catch(() => {});
  let reader;
  try {
    await socket.opened;
    const writer = socket.writable.getWriter();
    try {
      await writer.write(new TextEncoder().encode(
        `POST ${target.pathname} HTTP/1.0\r\nHost: ${target.host}\r\nContent-Type: application/octet-stream\r\nContent-Length: ${payload.length}\r\nConnection: close\r\n\r\n`,
      ));
      await writer.write(payload);
    } finally {
      writer.releaseLock();
    }
    reader = socket.readable.getReader();
    let buffer = new Uint8Array();
    let boundary = -1;
    let chunked = false;
    while (boundary < 0) {
      const {done,value} = await reader.read();
      if (done || buffer.length > 4096 || value.length > 128_000) throw Error('Invalid AutoDL headers');
      const joined = new Uint8Array(buffer.length + value.length);
      joined.set(buffer);
      joined.set(value,buffer.length);
      buffer = joined;
      const head = new TextDecoder().decode(buffer.subarray(0,4096));
      boundary = head.indexOf('\r\n\r\n');
      if (boundary >= 0) {
        if (!/^HTTP\/1\.[01] 200 /u.test(head)) throw Error('AutoDL port rejected the request');
        chunked = /^transfer-encoding:[ \t]*chunked[ \t]*\r?$/im.test(head.slice(0,boundary));
      }
    }
    const finish = () => {
      clearTimeout(timer);
      reader.releaseLock();
      return close();
    };
    const body = new ReadableStream({
      start(controller) {
        const remaining = buffer.subarray(boundary+4);
        if (remaining.length) controller.enqueue(remaining);
      },
      async pull(controller) {
        try {
          const {done,value} = await reader.read();
          if (!done) { controller.enqueue(value); return; }
          controller.close();
        } catch (error) { controller.error(error); }
        await finish();
      },
      async cancel() {
        await reader.cancel().catch(()=>{});
        await finish();
      },
    });
    return new Response(chunked ? decodeHttpChunks(body) : body);
  } catch (error) {
    clearTimeout(timer);
    reader?.releaseLock();
    await close();
    throw error;
  }
}

function unwrapModelStream(body, key, header) {
  const lines = readLines(body,200_000);
  let sequence = 0;
  return new ReadableStream({
    async pull(controller) {
      try {
        const {done,value} = await lines.next();
        if (done || !value) throw Error('Incomplete encrypted stream');
        const frame = Uint8Array.from(atob(value),char=>char.charCodeAt(0));
        if (frame.length < 28) throw Error('Invalid encrypted frame');
        const index = new Uint8Array(4);
        new DataView(index.buffer).setUint32(0,sequence++);
        const decoded = await crypto.subtle.decrypt({
          name:'AES-GCM',iv:frame.subarray(0,12),additionalData:Uint8Array.of(3,...header,...index),
        },key,frame.subarray(12));
        if (decoded.byteLength) { controller.enqueue(new Uint8Array(decoded)); return; }
        controller.close();
      } catch (error) { controller.error(error); }
      await lines.return();
    },
    cancel() { return lines.return(); },
  });
}

export async function requestAutoDL(env, route, body, timeout) {
  const secret = env.MODEL_BRIDGE_KEY;
  if (!/^[0-9a-f]{64}$/.test(secret || '')) throw Error('Invalid bridge key');
  const keyBytes = Uint8Array.from(secret.match(/../g), octet => parseInt(octet, 16));
  const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt','decrypt']);
  const header = crypto.getRandomValues(new Uint8Array(20));
  new DataView(header.buffer).setBigUint64(0, BigInt(Math.floor(Date.now() / 1000)));
  const request = new TextEncoder().encode(JSON.stringify({route,body}));
  // Authenticate the timestamp and bind each reply to the request that produced it.
  const ciphertext = await crypto.subtle.encrypt({
    name:'AES-GCM', iv:header.subarray(8), additionalData:Uint8Array.of(1,...header),
  },key,request);
  const envelope = new Uint8Array(header.length + ciphertext.byteLength);
  envelope.set(header);
  envelope.set(new Uint8Array(ciphertext),header.length);
  const bridgeURL=new URL('/workspace-bridge',env.MODEL_BRIDGE_URL).href;
  const response = env.MODEL_BRIDGE_TCP === 'true'
    ? await postToPort(bridgeURL,envelope,timeout)
    : await fetch(bridgeURL,{
    method:'POST', redirect:'error', signal:AbortSignal.timeout(timeout),
    headers:{'Content-Type':'application/octet-stream'}, body:envelope,
  });
  if (!response.ok) throw Error('Bridge transport failed');
  if (route === 'chat-stream') {
    if (!response.body) throw Error('Missing encrypted stream');
    return new Response(unwrapModelStream(response.body,key,header),{
      headers:{'Content-Type':'text/event-stream','X-Workspace-Model-Link':'fixed'},
    });
  }
  const reader = response.body?.getReader();
  if (!reader) throw Error('Missing bridge reply');
  const reply = new Uint8Array(['office','workspace'].includes(route) ? 960_000 : 100_000);
  let size = 0;
  for (;;) {
    const {done,value} = await reader.read();
    if (done) break;
    if (size + value.length > reply.length) {
      await reader.cancel();
      throw Error('Bridge reply is too large');
    }
    reply.set(value, size);
    size += value.length;
  }
  if (size < 28) throw Error('Incomplete bridge reply');
  const plaintext = await crypto.subtle.decrypt({
    name:'AES-GCM', iv:reply.subarray(0,12), additionalData:Uint8Array.of(2,...header),
  },key,reply.subarray(12,size));
  const {status,body:result} = JSON.parse(new TextDecoder().decode(plaintext));
  return Response.json(result,{status,headers:{'X-Workspace-Model-Link':'fixed'}});
}
