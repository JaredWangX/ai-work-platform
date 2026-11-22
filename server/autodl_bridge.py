import asyncio
import base64
import json
import os
import time
import sys
from pathlib import Path

import httpx
from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from fastapi import FastAPI, Request, Response
from fastapi.responses import StreamingResponse


from contextlib import asynccontextmanager
import workspace

@asynccontextmanager
async def lifespan(app):
    workspace.initialize()
    worker=asyncio.create_task(workspace.schedule_loop())
    try:
        yield
    finally:
        worker.cancel()
        await asyncio.gather(worker,return_exceptions=True)

app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
cipher = AESGCM(bytes.fromhex(Path("bridge-key").read_text().strip()))
model_origin=os.environ.get("MODEL_ORIGIN","http://127.0.0.1:8000").rstrip("/")
model_headers = {"Authorization": "Bearer " + Path("api-key").read_text().strip()}
paths = {"models": "/v1/models", "chat": "/v1/chat/completions", "chat-stream": "/v1/chat/completions"}
seen = {}

def seal_event(header, sequence, line):
    nonce = os.urandom(12)
    encrypted = cipher.encrypt(nonce, line, b"\x03" + header + sequence.to_bytes(4, "big"))
    return base64.b64encode(nonce + encrypted) + b"\n"

async def stream_chat(body, header):
    sequence = 0
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(100, connect=5), trust_env=False) as client:
            async with client.stream("POST", model_origin+"/v1/chat/completions",
                                     content=body, headers={**model_headers, "Content-Type": "application/json"}) as upstream:
                upstream.raise_for_status()
                async for line in upstream.aiter_lines():
                    if not line.startswith("data:"):
                        continue
                    yield seal_event(header, sequence, (line + "\n\n").encode())
                    sequence += 1
                    if line == "data: [DONE]":
                        break
    except httpx.HTTPError as error:
        code = error.response.status_code if isinstance(error, httpx.HTTPStatusError) else 503
        data = json.dumps({"error": {"code": code}})
        yield seal_event(header, sequence, (f"data: {data}\n\n").encode())
        sequence += 1
    yield seal_event(header, sequence, b"")

office_slots = asyncio.Semaphore(2)

async def render_office(body):
    base = Path(__file__).resolve().parent / "office-engine"
    if not (base / "office_render.py").is_file():
        base=Path(__file__).resolve().parent
    python=str(base / "py/bin/python") if (base / "py/bin/python").is_file() else sys.executable
    async with office_slots:
        proc = await asyncio.create_subprocess_exec(python, str(base / "office_render.py"),
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
        try:
            data, _ = await asyncio.wait_for(proc.communicate(body.encode()), timeout=24)
        finally:
            if proc.returncode is None:
                proc.kill()
                await proc.wait()
    if proc.returncode != 0:
        return {"status":422, "body":{"error":"文件结构无法渲染"}}
    return {"status":200, "body":json.loads(data)}


@app.post("/workspace-bridge")
async def handle_bridge(request: Request):
    envelope = bytearray()
    async for chunk in request.stream():
        if len(envelope) + len(chunk) > 140_000:
            return Response(status_code=413)
        envelope.extend(chunk)
    if len(envelope) < 36:
        return Response(status_code=400)

    header = bytes(envelope[:20])
    issued = int.from_bytes(header[:8], "big")
    nonce = header[8:]
    now = int(time.time())
    if abs(now - issued) > 60 or nonce in seen:
        return Response(status_code=401)
    try:
        payload = json.loads(cipher.decrypt(nonce, bytes(envelope[20:]), b"\x01" + header))
    except (InvalidTag, ValueError):
        return Response(status_code=401)
    for expired in [value for value, expiry in seen.items() if expiry < now]:
        del seen[expired]
    if len(seen) >= 2048:
        return Response(status_code=429)
    seen[nonce] = issued + 60

    route = payload.get("route") if isinstance(payload, dict) else None
    if not isinstance(route, str) or (route not in paths and route not in ("office","workspace")):
        return Response(status_code=400)
    body = payload.get("body")
    if route != "models" and not isinstance(body, str):
        return Response(status_code=400)
    if route == "chat-stream":
        return StreamingResponse(stream_chat(body, header), media_type="application/octet-stream",
                                 headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"})
    if route == "workspace":
        try:
            result={"status":200,"body":workspace.service(json.loads(body))}
        except (ValueError,KeyError,TypeError) as err:
            result={"status":400,"body":{"error":str(err)[:100]}}
    elif route == "office":
        result = await render_office(body)
    else:
        method = "POST" if route == "chat" else "GET"
        try:
            async with httpx.AsyncClient(base_url=model_origin, timeout=82, trust_env=False) as client:
                upstream = await client.request(method, paths[route], content=body,
                                                headers={**model_headers, "Content-Type": "application/json"})
            result = {"status": upstream.status_code, "body": upstream.json()}
        except (httpx.HTTPError, ValueError):
            result = {"status": 503, "body": {"error": "Model unavailable"}}

    reply_nonce = os.urandom(12)
    reply = cipher.encrypt(reply_nonce, json.dumps(result).encode(), b"\x02" + header)
    return Response(reply_nonce + reply, media_type="application/octet-stream",
                    headers={"Cache-Control": "no-store"})

# Existing installations may retain an internal route during a rolling deployment.
alias_file = Path("bridge-alias")
if alias_file.is_file():
    app.add_api_route(alias_file.read_text().strip(), handle_bridge, methods=["POST"])
