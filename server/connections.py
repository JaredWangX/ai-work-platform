"""Private, per-workspace model and database connections."""
import csv
import io
import sqlite3
import time
import hashlib
import hmac
import http.client
import ipaddress
import json
import os
import re
import socket
import ssl
from contextlib import closing, contextmanager
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

from cryptography.hazmat.primitives.ciphers.aead import AESGCM


def setup(db):
    db.execute("""CREATE TABLE IF NOT EXISTS connections(
        owner TEXT, id TEXT, kind TEXT, summary TEXT NOT NULL, sealed BLOB NOT NULL,
        active INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(owner,id))""")
    db.execute("CREATE UNIQUE INDEX IF NOT EXISTS active_model ON connections(owner) WHERE active=1")


def crypt():
    key = bytes.fromhex(Path("bridge-key").read_text().strip())
    return AESGCM(hmac.digest(key, b"ai-work-platform/connections/v1", hashlib.sha256))


def credentials(db, owner, cid, kind):
    row = db.execute("SELECT sealed FROM connections WHERE owner=? AND id=? AND kind=?", (owner,cid,kind)).fetchone()
    if not row:
        raise ValueError("该连接已移除或不属于当前工作空间")
    blob = row[0]
    return json.loads(crypt().decrypt(blob[:12], blob[12:], f"{owner}/{cid}/{kind}".encode()))


def field(raw, key, limit, required=True, strip=True):
    value = raw.get(key, "")
    if not isinstance(value,str) or len(value)>limit or any(ord(c)<32 for c in value):
        raise ValueError("连接字段格式或长度无效")
    value = value.strip() if strip else value
    if required and not value:
        raise ValueError("请补全必填的连接信息")
    return value


def address(host, port):
    # Connect to the checked IP directly. TLS still authenticates the original hostname.
    if not re.fullmatch(r"[a-zA-Z0-9.:-]{1,253}", host) or "%" in host:
        raise ValueError("请输入有效的主机名")
    private_hosts = set(os.getenv("WORKSPACE_PRIVATE_HOSTS","").lower().split(","))
    infos = socket.getaddrinfo(host,port,type=socket.SOCK_STREAM)
    ips = [ipaddress.ip_address(info[4][0]) for info in infos]
    if not ips or (host.lower() not in private_hosts and any(not ip.is_global or ip.is_multicast or ip.version==6 and (ip.sixtofour or ip.teredo or ip.ipv4_mapped or ip in ipaddress.ip_network("64:ff9b::/96")) for ip in ips)):
        raise ValueError("公共部署需要可公开访问的地址，内网服务可在自建部署中授权")
    return str(next((ip for ip in ips if ip.version==4),ips[0]))


def endpoint(value):
    url = urlsplit(value)
    if url.scheme!="https" or not url.hostname or url.username is not None or url.password is not None or url.query or url.fragment or "\\" in value:
        raise ValueError("请输入 HTTPS 接口地址，密钥请填写在单独的字段")
    path = url.path.rstrip("/")
    if not path.endswith("/chat/completions"):
        path += "/chat/completions"
    return urlunsplit(("https",url.netloc,path,"",""))


@contextmanager
def https_request(url_string,method,body,headers):
    url=urlsplit(url_string)
    host,port=url.hostname,url.port or 443
    ip=address(host,port)
    context=ssl.create_default_context()
    conn=http.client.HTTPSConnection(host,port,timeout=6,context=context)
    try:
        with socket.create_connection((ip,port),timeout=5) as sock:
            conn.sock=context.wrap_socket(sock,server_hostname=host)
            conn.sock.settimeout(65)
            conn.request(method,url.path or "/",body,headers)
            with conn.getresponse() as response:yield response
    finally:
        conn.close()


@contextmanager
def model_response(config, body):
    headers={"Content-Type":"application/json","Accept-Encoding":"identity"}
    if config["secret"]: headers["Authorization"]="Bearer "+config["secret"]
    payload={k:v for k,v in body.items() if k not in ("chat_template_kwargs","response_format")}
    payload["model"]=config["model"]
    with https_request(config["endpoint"],"POST",json.dumps(payload).encode(),headers) as response:
        if response.status!=200:raise ValueError(f"模型接口返回 HTTP {response.status}，请核对地址、模型名和凭据")
        yield response


def model_json(config, body):
    with model_response(config,body) as response:
        data=response.read(2_000_001)
        if len(data)>2_000_000: raise ValueError("模型响应过大")
        try: return json.loads(data)
        except (ValueError,UnicodeError): raise ValueError("模型接口没有返回兼容的 JSON") from None


def model_lines(config, body):
    with model_response(config,body) as response:
        if "text/event-stream" not in (response.getheader("Content-Type") or ""):
            raise ValueError("所选模型接口未返回流式响应")
        size=0
        while line:=response.readline(128001):
            size+=len(line)
            if len(line)>128000 or size>2_000_000:raise ValueError("模型响应过大")
            if line.startswith(b"data:"):
                yield line.rstrip(b"\r\n")+b"\n\n"
                if line.strip()==b"data: [DONE]":return


@contextmanager
def database_session(config):
    host,port=config["host"],int(config["port"])
    ip=address(host,port)
    if config["engine"]=="PostgreSQL":
        import psycopg
        import certifi
        con=psycopg.connect(host=host,hostaddr=ip,port=port,user=config["username"],password=config["secret"],
            dbname=config["database"],sslmode="verify-full",sslrootcert=os.getenv("SSL_CERT_FILE") or certifi.where(),
            connect_timeout=5,options="-c default_transaction_read_only=on -c statement_timeout=5000",
            gssencmode="disable",passfile=os.devnull,autocommit=False)
    else:
        import pymysql
        con=pymysql.connect(host=host,port=port,user=config["username"],password=config["secret"],
            database=config["database"],ssl=ssl.create_default_context(),defer_connect=True,
            local_infile=False,read_timeout=7,write_timeout=5,connect_timeout=5)
        sock=socket.create_connection((ip,port),timeout=5)
        try:
            con.connect(sock)
            with con.cursor() as cur:
                cur.execute("SET SESSION MAX_EXECUTION_TIME=5000")
                cur.execute("START TRANSACTION READ ONLY")
        except BaseException:
            sock.close()
            if con.open:con.close()
            raise
    try:
        yield con
    finally:
        con.close()


def schema(config):
    if config["engine"]=="CSV":return config["columns"]
    with database_session(config) as conn, conn.cursor() as cur:
        cur.execute("SELECT column_name,data_type FROM information_schema.columns WHERE table_schema=%s AND table_name=%s ORDER BY ordinal_position LIMIT 81",
                    (config["schema"],config["table"]))
        cols=cur.fetchall()
        if not cols:raise ValueError("没有读到目标表，请检查表名、模式和只读权限")
        if len(cols)>80:raise ValueError("请选择最多 80 列的表或视图")
        return [[str(n),str(t)] for n,t in cols]


def sql_for(config, sql):
    import sqlglot
    from sqlglot import exp
    if not isinstance(sql,str) or not 1<=len(sql)<=1800:raise ValueError("请输入不超过 1800 字的 SELECT")
    dialect={"PostgreSQL":"postgres","MySQL":"mysql","CSV":"sqlite"}[config["engine"]]
    try: trees=sqlglot.parse(sql,read=dialect)
    except sqlglot.errors.SqlglotError:raise ValueError("SQL 语法无效") from None
    if len(trees)!=1 or not isinstance(trees[0],exp.Select):raise ValueError("只支持单条 SELECT")
    tree=trees[0]
    safe=set("select from table identifier column alias tablealias literal star where group order ordered limit offset and or not eq neq gt gte lt lte is null boolean between in like paren add sub mul div mod neg count sum avg min max round coalesce distinct case if nullif lower upper having".split())
    if any(node.key not in safe for node in tree.walk()) or len(list(tree.find_all(exp.Select)))!=1:
        raise ValueError("只支持单表只读查询、筛选、分组及常见聚合")
    tables=list(tree.find_all(exp.Table))
    if len(tables)!=1 or tables[0].name!=config["table"] or tables[0].catalog or tables[0].db not in ("",config["schema"]):
        raise ValueError("只能查询此连接所选的表或视图")
    tables[0].set("db",exp.to_identifier(config["schema"]))
    return tree.sql(dialect=dialect,identify=True,comments=False)


def csv_data(raw):
    data=raw.get("csv")
    if not isinstance(data,str) or len(data.encode())>64000:raise ValueError("CSV 最大为 64 KB")
    reader=csv.reader(io.StringIO(data.lstrip("\ufeff")),strict=True)
    try:
        names=[name.strip() for name in next(reader,[])]
        rows=[r for r in reader if r]
    except csv.Error:raise ValueError("CSV 格式无效") from None
    if not 1<=len(names)<=32 or len(set(n.casefold() for n in names))!=len(names) or any(not n or len(n)>80 or any(ord(c)<32 for c in n) for n in names):
        raise ValueError("CSV 首行需包含 1–32 个不重复的列名")
    if not 1<=len(rows)<=500 or any(len(r)!=len(names) for r in rows):raise ValueError("CSV 需包含 1–500 行，且各行列数一致")
    columns=[]
    for index,name in enumerate(names):
        values=[r[index] for r in rows if r[index]!=""]
        kind="TEXT"
        if values and all(re.fullmatch(r"-?(0|[1-9][0-9]{0,13})",v) for v in values):kind="INTEGER"
        elif values and all(re.fullmatch(r"-?(0|[1-9][0-9]{0,13})(\.\d{1,12})?",v) for v in values):kind="REAL"
        columns.append([name,kind])
    return columns,rows


@contextmanager
def csv_session(config):
    with closing(sqlite3.connect(":memory:")) as db:
        columns=",".join('"'+name.replace('"','""')+'" '+kind for name,kind in config["columns"])
        db.execute("CREATE TABLE records("+columns+")")
        marks=",".join("?" for _ in config["columns"])
        db.executemany("INSERT INTO records VALUES("+marks+")",([v if v!="" else None for v in row] for row in config["rows"]))
        db.execute("PRAGMA query_only=ON")
        end=time.monotonic()+1
        db.set_progress_handler(lambda:int(time.monotonic()>end),1000)
        yield db


def select_rows(config, sql):
    statement=sql_for(config,sql)
    session=csv_session if config["engine"]=="CSV" else database_session
    with session(config) as conn,closing(conn.cursor()) as cur:
        cur.execute("SELECT * FROM ("+statement+") AS workspace_result LIMIT 51")
        cols=[str(c[0]) for c in cur.description]
        rows=cur.fetchmany(51)
        if len(cols)>80:raise ValueError("请选择较少的列")
        result={"columns":cols,"rows":rows[:50],"truncated":len(rows)>50}
        data=json.dumps(result,default=str,ensure_ascii=False)
        if len(data.encode())>32000:raise ValueError("结果过大，请减少返回的行或列")
        return json.loads(data)


def save(db,owner,raw):
    kind=raw.get("kind")
    cid=field(raw,"id",64)
    if kind not in ("model","database","tool") or not re.fullmatch(r"[a-z0-9_-]{1,64}",cid) or cid in ("sales","service"):
        raise ValueError("连接标识无效")
    if db.execute("SELECT kind FROM connections WHERE owner=? AND id=?",(owner,cid)).fetchone() is not None:
        previous=credentials(db,owner,cid,kind)
    else: previous={}
    info={"id":cid,"kind":kind,"name":field(raw,"name",80)}
    secret=field(raw,"secret",4000,False,False)
    if kind=="model":
        info.update(endpoint=endpoint(field(raw,"endpoint",1000)),model=field(raw,"model",160))
        identity=["endpoint"]
    elif kind=="tool":
        url=field(raw,"url",1000)
        endpoint(url)  # Apply the same HTTPS and credential-in-URL checks.
        info.update(url=url,description="Streamable HTTP")
        identity=["url"]
    elif raw.get("engine")=="CSV":
        columns,rows=csv_data(raw)
        info.update(engine="CSV",table="records",schema="main",columns=columns,rowCount=len(rows),description=field(raw,"description",180,False))
        identity=[]
    else:
        engine=raw.get("engine")
        if engine not in ("PostgreSQL","MySQL"):raise ValueError("数据库类型无效")
        port=field(raw,"port",5)
        if not port.isdigit() or not 0<int(port)<65536:raise ValueError("端口无效")
        info.update(engine=engine,host=field(raw,"host",253),port=port,database=field(raw,"database",100),
                    username=field(raw,"username",100),table=field(raw,"table",100),
                    description=field(raw,"description",180,False))
        if any(c in info["database"] for c in "=:/\\"):raise ValueError("请填写数据库名，连接地址应填在主机字段")
        info["schema"]=(field(raw,"schema",100,False) or "public") if engine=="PostgreSQL" else info["database"]
        identity=["engine","host","port","database","username"]
    config={**info,"secret":secret}
    if not secret and not raw.get("clearSecret") and previous and all(previous.get(k)==info[k] for k in identity):
        config["secret"]=previous["secret"]
    if info.get("engine")=="CSV":config["rows"]=rows
    if kind=="model":
        result=model_json(config,{"messages":[{"role":"user","content":"Reply OK."}],"max_tokens":32,"stream":False})
        if not isinstance(result.get("choices"),list) or not result["choices"] or not isinstance(result["choices"][0].get("message"),dict):
            raise ValueError("接口响应不符合聊天协议")
    elif kind=="tool":
        catalog=mcp(config,"list",{})
        info.update(toolCount=len(catalog["tools"]),resourceCount=len(catalog["resources"]))
    else:info["columns"]=schema(config)
    nonce=os.urandom(12)
    blob=nonce+crypt().encrypt(nonce,json.dumps(config).encode(),f"{owner}/{cid}/{kind}".encode())
    db.execute("BEGIN IMMEDIATE")
    if db.execute("SELECT count(*) FROM connections WHERE owner=? AND id<>?",(owner,cid)).fetchone()[0]>=16:
        raise ValueError("每个工作空间最多可保存 16 项连接")
    db.execute("""INSERT INTO connections(owner,id,kind,summary,sealed) VALUES(?,?,?,?,?)
      ON CONFLICT(owner,id) DO UPDATE SET summary=excluded.summary,sealed=excluded.sealed""",
      (owner,cid,kind,json.dumps(info),blob))
    return info


def mcp(config, operation, fields):
    headers={"Accept":"application/json, text/event-stream","Content-Type":"application/json"}
    if config["secret"]:headers["Authorization"]="Bearer "+config["secret"]
    sequence=0
    def rpc(method,params,notification=False):
        nonlocal sequence
        sequence+=1
        msg={"jsonrpc":"2.0","method":method,"params":params}
        if not notification:msg["id"]=sequence
        with https_request(config["url"],"POST",json.dumps(msg).encode(),headers) as response:
            if not 200<=response.status<300:raise ValueError(f"MCP 服务返回 HTTP {response.status}")
            if method=="initialize" and response.getheader("Mcp-Session-Id"):
                headers["Mcp-Session-Id"]=response.getheader("Mcp-Session-Id")
            if notification:return {}
            if "text/event-stream" in (response.getheader("Content-Type") or ""):
                size=0
                data=[]
                while line:=response.readline(128001):
                    size+=len(line)
                    if size>320000:raise ValueError("MCP 响应超出上限")
                    if line.startswith(b"data:"):data.append(line[5:].strip())
                    if not line.strip() and data:
                        reply=json.loads(b"\n".join(data));data=[]
                        if reply.get("id")==sequence:break
                else:raise ValueError("MCP 响应中断")
            else:
                data=response.read(320001)
                if len(data)>320000:raise ValueError("MCP 响应超出上限")
                reply=json.loads(data)
            if reply.get("id")!=sequence or not isinstance(reply.get("result"),dict):raise ValueError("MCP 服务拒绝了本次请求")
            return reply["result"]

    hello=rpc("initialize",{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"AI Work Platform","version":"1.0"}})
    headers["MCP-Protocol-Version"]=hello.get("protocolVersion","2025-06-18")
    try:
        rpc("notifications/initialized",{},True)
        caps=hello.get("capabilities",{})
        def entries(kind):
            if kind not in caps:return []
            options={};result=[]
            while len(result)<80:
                page=rpc(kind+"/list",options);result.extend(page.get(kind,[]))
                cursor=page.get("nextCursor")
                if not cursor:break
                if options.get("cursor")==cursor or not page.get(kind):raise ValueError("MCP 分页无效")
                options={"cursor":cursor}
            return result[:80]
        if operation=="list":
            return {"tools":[{k:t.get(k) for k in ("name","description","inputSchema")} for t in entries("tools")],
                    "resources":[{k:r.get(k) for k in ("uri","name","mimeType")} for r in entries("resources")]}
        if operation=="read":
            uri=field(fields,"uri",2000)
            if not any(r.get("uri")==uri for r in entries("resources")):raise ValueError("请选择服务列出的资源")
            result=rpc("resources/read",{"uri":uri})
            blocks=result.get("contents",[])
        elif operation=="call":
            name=field(fields,"name",160);args=fields.get("arguments")
            if not isinstance(args,dict) or not any(t.get("name")==name for t in entries("tools")):raise ValueError("工具参数或工具名称无效")
            result=rpc("tools/call",{"name":name,"arguments":args})
            blocks=result.get("content",[])
        else:raise ValueError("MCP 操作无效")
        text="\n".join(b["text"] for b in blocks if isinstance(b.get("text"),str))
        if not text and "structuredContent" in result:text=json.dumps(result["structuredContent"],ensure_ascii=False)
        if not text:raise ValueError("该资源或结果没有可显示的文本")
        return {"text":text[:12000],"truncated":len(text)>12000,"isError":bool(result.get("isError"))}
    finally:
        if "Mcp-Session-Id" in headers:
            try:
                with https_request(config["url"],"DELETE",None,headers):pass
            except (OSError,ValueError,http.client.HTTPException):pass
