export async function* readLines(body, maxLength = 200_000) {
  const reader = body.pipeThrough(new TextDecoderStream()).getReader();
  let pending = '';
  try {
    for (;;) {
      const {done,value} = await reader.read();
      if (done) break;
      pending += value;
      let boundary;
      while ((boundary = pending.indexOf('\n')) !== -1) {
        if (boundary > maxLength) throw Error('Stream line too long');
        yield pending.slice(0,boundary).replace(/\r$/,'');
        pending = pending.slice(boundary+1);
      }
      if (pending.length > maxLength) throw Error('Stream line too long');
    }
    if (pending) yield pending;
  } finally {
    await reader.cancel().catch(()=>{});
    reader.releaseLock();
  }
}

export async function* readEvents(body) {
  let data = [];
  for await (const line of readLines(body)) {
    if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /,''));
    if (!line && data.length) {
      yield data.join('\n');
      data = [];
    }
  }
}
