import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeHttpChunks } from './autodl-bridge.mjs';

const body = (...parts) => ReadableStream.from(parts.map(part=>new TextEncoder().encode(part)));

test('proxy chunk lengths and separators can arrive across socket reads', async () => {
  const decoded = decodeHttpChunks(body('4\r','\ndat','a\r','\n2\r\n',':\n\r\n','0\r\n\r\n'));
  assert.equal(await new Response(decoded).text(),'data:\n');
});

test('an interrupted proxy response is not considered complete', async () => {
  const decoded = decodeHttpChunks(body('4\r\nab'));
  await assert.rejects(new Response(decoded).text(),/Incomplete HTTP chunked response/);
});
