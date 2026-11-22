"""Private workspace service: read-only sample data and durable Beijing schedules."""
import file_reader
import accounts
import connections
import asyncio
import hashlib
import json
import os
import re
import sqlite3
import time
import uuid
from contextlib import closing
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent
DATA = Path(os.environ.get("WORKSPACE_DATA", ROOT / "workspace-data"))
BJ = ZoneInfo("Asia/Shanghai")
SCHEMAS = {"sales":"orders(order_id, day, channel, amount, refund)", "service":"tickets(ticket_id, day, topic, status, hours)"}
FREQUENCIES = {"每天":range(7), "每个工作日":range(5), "每周一":(0,)}


def ledger():
    db = sqlite3.connect(DATA / "tasks.sqlite", timeout=5)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys=ON")
    return db


def initialize():
    DATA.mkdir(mode=0o700, parents=True, exist_ok=True)
    with closing(ledger()) as db, db:
        accounts.setup(db)
        connections.setup(db)
        db.executescript("""
        CREATE TABLE IF NOT EXISTS jobs(owner TEXT,id TEXT,config TEXT,next_at INTEGER,PRIMARY KEY(owner,id));
        CREATE INDEX IF NOT EXISTS due ON jobs(next_at);
        CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,owner TEXT,job TEXT,slot INTEGER,status TEXT,
          prompt TEXT,result TEXT,seconds INTEGER DEFAULT 0,UNIQUE(owner,job,slot),
          FOREIGN KEY(owner,job) REFERENCES jobs(owner,id) ON DELETE CASCADE);
        CREATE TABLE IF NOT EXISTS files(id TEXT PRIMARY KEY,run TEXT REFERENCES runs(id) ON DELETE CASCADE,
          meta TEXT,bytes64 TEXT);
        """)
    for source in SCHEMAS:
        with closing(sqlite3.connect(DATA / (source+".sqlite"))) as db, db:
            if source=="sales":
                db.execute("CREATE TABLE IF NOT EXISTS orders(order_id INTEGER PRIMARY KEY,day TEXT,channel TEXT,amount INTEGER,refund INTEGER)")
                db.executemany("INSERT OR IGNORE INTO orders VALUES(?,?,?,?,?)",[(i+1,f"2026-11-{1+i//3:02}",("直营","电商","经销")[i%3],(i*37%850)+150,35 if i%7==0 else 0) for i in range(63)])
            else:
                db.execute("CREATE TABLE IF NOT EXISTS tickets(ticket_id INTEGER PRIMARY KEY,day TEXT,topic TEXT,status TEXT,hours INTEGER)")
                db.executemany("INSERT OR IGNORE INTO tickets VALUES(?,?,?,?,?)",[(i+1,f"2026-11-{1+i//2:02}",("配送","售后","咨询")[i%3],("已解决","跟进中","待处理","已解决")[i%4],i%9+1) for i in range(42)])


def query(source, sql):
    if source not in SCHEMAS or not isinstance(sql,str) or len(sql)>1800 or not re.match(r"^\s*SELECT\b",sql,re.I):
        raise ValueError("请输入 SELECT 查询")
    table=SCHEMAS[source].split("(")[0]
    allowed={"sum","count","avg","min","max","round","coalesce","date","strftime","substr","lower","upper","abs","nullif","total","like"}
    def authorize(action, first, second, *unused):
        ok=(action==sqlite3.SQLITE_SELECT or (action==sqlite3.SQLITE_READ and first==table)
            or (action==sqlite3.SQLITE_FUNCTION and second in allowed))
        return sqlite3.SQLITE_OK if ok else sqlite3.SQLITE_DENY
    with closing(sqlite3.connect((DATA/(source+".sqlite")).resolve().as_uri()+"?mode=ro",uri=True)) as db:
        db.setlimit(sqlite3.SQLITE_LIMIT_LENGTH,32768)
        db.setlimit(sqlite3.SQLITE_LIMIT_COLUMN,16)
        db.setlimit(sqlite3.SQLITE_LIMIT_COMPOUND_SELECT,4)
        db.set_authorizer(authorize)
        deadline=time.monotonic()+.18
        db.set_progress_handler(lambda: int(time.monotonic()>deadline),500)
        try:
            cur=db.execute(sql)
            rows=cur.fetchmany(51)
            result={"columns":[x[0] for x in cur.description],"rows":rows[:50],"truncated":len(rows)>50}
            if len(json.dumps(result,ensure_ascii=False).encode())>32000:raise ValueError("结果过大，请减少返回列")
            return result
        except sqlite3.Error as err:
            raise ValueError("查询无效，请核对表名、列名及只读 SQL 语法") from err


def next_slot(config, now):
    at=datetime.fromtimestamp(now,BJ)
    h,m=map(int,config["time"].split(":"))
    for offset in range(8):
        candidate=(at+timedelta(days=offset)).replace(hour=h,minute=m,second=0,microsecond=0)
        if candidate.timestamp()>now and candidate.weekday() in FREQUENCIES[config["frequency"]]:
            return int(candidate.timestamp())


def settings(raw):
    keys={"id":80,"name":100,"description":2400,"time":5,"frequency":10,"tag":90,"assignee":90,"instructions":700,"source":64,"skillId":80,"noteId":80,"fileId":80}
    cfg={k:raw.get(k,"") for k in keys}
    if any(not isinstance(v,str) or len(v)>keys[k] for k,v in cfg.items()):raise ValueError("任务字段无效")
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,80}",cfg["id"]) or not cfg["name"].strip() or not cfg["description"].strip():raise ValueError("请填写任务名称和指令")
    if cfg["frequency"] not in FREQUENCIES or not re.fullmatch(r"(?:[01]\d|2[0-3]):[0-5]\d",cfg["time"]) or type(raw.get("enabled")) is not bool:raise ValueError("调度设置无效")
    refs=raw.get("references",[])
    if not isinstance(refs,list) or len(refs)>3:raise ValueError("任务资料过多")
    cfg["references"]=[]
    for ref in refs:
        if not isinstance(ref,dict) or ref.get("kind") not in ("skill","knowledge","attachment") or not isinstance(ref.get("text"),str) or len(ref["text"])>3000 or not isinstance(ref.get("name"),str) or not 1<=len(ref["name"])<=160:raise ValueError("任务资料格式无效")
        cfg["references"].append({k:ref[k] for k in ("kind","text","name")})
    cfg["enabled"]=raw["enabled"]
    return cfg


def service(payload):
    action=payload.get("action")
    if action=="query" and payload.get("source") in SCHEMAS:return query(payload.get("source"),payload.get("sql"))
    token=payload.get("workspace","")
    now=int(time.time())
    with closing(ledger()) as db, db:
        if action in ("register","login","recover"):
            return accounts.sign(db,action,payload.get("params") or {},token)
        internal=payload.get("internalOwner")
        if internal and re.fullmatch(r"[a-f0-9]{64}",internal):
            who={"owner":internal,"role":"internal","person":None}
        else:who=accounts.identity(db,token)
        owner=who["owner"]
        if action in ("account","logout","members","joinTeam","switchTeam","invite","revokeInvite","removeMember","getPrefs","setPrefs","changePassword","issueRecovery"):
            return accounts.team(db,who,action,payload.get("params") or {},token)
        if action in ("syncIndex","syncPut","syncGet","syncCommit"):
            return accounts.cloud(db,who,action,payload.get("params") or {})
        if action=="runtime":
            row=db.execute("SELECT summary FROM connections WHERE owner=? AND active=1",(owner,)).fetchone()
            return {"owner":owner,**(json.loads(row[0]) if row else {})}
        if who["role"]=="member" and action in ("saveConnection","removeConnection","activateModel"):
            raise ValueError("连接由工作空间管理员管理")
        if action=="extractText":return file_reader.extract(payload.get("params") or {})
        if action=="connections":
            return {"items":[dict(json.loads(row["summary"]),active=bool(row["active"])) for row in db.execute("SELECT summary,active FROM connections WHERE owner=? ORDER BY rowid",(owner,))]}
        if action=="saveConnection":
            return connections.save(db,owner,payload["config"])
        if action=="activateModel":
            cid=payload.get("id","")
            db.execute("BEGIN IMMEDIATE")
            if cid:connections.credentials(db,owner,cid,"model")
            db.execute("UPDATE connections SET active=0 WHERE owner=? AND active=1",(owner,))
            if cid:db.execute("UPDATE connections SET active=1 WHERE owner=? AND id=?",(owner,cid))
            return {"ok":True}
        if action=="mcp":
            config=connections.credentials(db,owner,payload.get("id"),"tool")
            return connections.mcp(config,payload.get("operation"),payload.get("params") or {})
        if action=="activeModel":
            row=db.execute("SELECT summary FROM connections WHERE owner=? AND active=1",(owner,)).fetchone()
            return json.loads(row[0]) if row else {}
        if action=="removeConnection":
            cid=payload.get("id")
            db.execute("BEGIN IMMEDIATE")
            if any(json.loads(j[0]).get("source")==cid for j in db.execute("SELECT config FROM jobs WHERE owner=?",(owner,))):
                raise ValueError("请先从定时任务中移除此数据源")
            db.execute("DELETE FROM connections WHERE owner=? AND id=?",(owner,cid))
            return {"ok":True}
        if action in ("describe","query"):
            source=payload.get("source")
            config=connections.credentials(db,owner,source,"database")
            if action=="query":return connections.select_rows(config,payload.get("sql"))
            return {"engine":config["engine"],"table":config["table"],"columns":connections.schema(config)}
        if action=="save":
            cfg=settings(payload["task"])
            db.execute("BEGIN IMMEDIATE")
            if cfg["source"] and cfg["source"] not in SCHEMAS:connections.credentials(db,owner,cfg["source"],"database")
            prev=db.execute("SELECT config,next_at FROM jobs WHERE owner=? AND id=?",(owner,cfg["id"])).fetchone()
            if not prev and (db.execute("SELECT count(*) FROM jobs WHERE owner=?",(owner,)).fetchone()[0]>=8 or db.execute("SELECT count(*) FROM jobs").fetchone()[0]>=256):raise ValueError("服务器调度名额已满")
            next_at=next_slot(cfg,now) if cfg["enabled"] else None
            if prev and all(json.loads(prev["config"])[k]==cfg[k] for k in ("time","frequency","enabled")):next_at=prev["next_at"]
            db.execute("INSERT INTO jobs VALUES(?,?,?,?) ON CONFLICT(owner,id) DO UPDATE SET config=excluded.config,next_at=excluded.next_at",(owner,cfg["id"],json.dumps(cfg),next_at))
            return {"next":next_at}
        if action=="remove":
            db.execute("DELETE FROM jobs WHERE owner=? AND id=?",(owner,payload.get("id")))
            return {"ok":True}
        if action=="list":
            jobs=[]
            for job in db.execute("SELECT * FROM jobs WHERE owner=?",(owner,)):
                runs=[]
                for r in db.execute("SELECT * FROM runs WHERE owner=? AND job=? ORDER BY slot DESC LIMIT 8",(owner,job["id"])):
                    files=[dict(id=f["id"],name=json.loads(f["meta"])["name"]) for f in db.execute("SELECT id,meta FROM files WHERE run=?",(r["id"],))]
                    runs.append(dict(id=r["id"],slot=r["slot"],seconds=r["seconds"],status=r["status"],files=files,text=(r["result"] or "")[:1800],prompt=r["prompt"][:500]))
                jobs.append(dict(config=json.loads(job["config"]),next=job["next_at"],runs=runs))
            return {"jobs":jobs}
        if action=="file":
            file=db.execute("SELECT f.* FROM files f JOIN runs r ON f.run=r.id WHERE f.id=? AND r.owner=?",(payload.get("id"),owner)).fetchone()
            if not file:raise ValueError("找不到该文件")
            return {**json.loads(file["meta"]),"base64":file["bytes64"]}
    raise ValueError("未知操作")


def claim(now):
    with closing(ledger()) as db,db:
        db.execute("BEGIN IMMEDIATE")
        db.execute("UPDATE runs SET status='failed',result='服务器执行中断' WHERE status='running' AND slot<?",(now-900,))
        job=db.execute("SELECT * FROM jobs WHERE next_at<=? ORDER BY next_at LIMIT 1",(now,)).fetchone()
        if not job:return
        cfg=json.loads(job["config"])
        rid=str(uuid.uuid4())
        db.execute("UPDATE jobs SET next_at=? WHERE owner=? AND id=?",(next_slot(cfg,now),job["owner"],job["id"]))
        db.execute("INSERT INTO runs(id,owner,job,slot,status,prompt) VALUES(?,?,?,?,?,?)",(rid,job["owner"],job["id"],job["next_at"],"running",cfg["description"]))
        db.execute("DELETE FROM runs WHERE owner=? AND job=? AND id NOT IN (SELECT id FROM runs WHERE owner=? AND job=? ORDER BY slot DESC LIMIT 8)",(job["owner"],job["id"],job["owner"],job["id"]))
        return rid,{**cfg,"owner":job["owner"]}


async def execute(rid,cfg):
    start=time.monotonic()
    files=[]
    try:
        node=next((ROOT/"office-engine"/"py"/"lib").glob("python*/site-packages/nodejs_wheel/bin/node"),"node")
        runner=ROOT/"job-runtime"/"server"/"job-run.mjs"
        if not runner.is_file():runner=ROOT/"job-run.mjs"
        proc=await asyncio.create_subprocess_exec(str(node),str(runner),stdin=asyncio.subprocess.PIPE,stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.DEVNULL)
        try:
            data,_=await asyncio.wait_for(proc.communicate(json.dumps(cfg).encode()),200)
        finally:
            if proc.returncode is None:proc.kill();await proc.wait()
        if proc.returncode:raise ValueError()
        response=json.loads(data)
        if not response.get("text"):raise ValueError()
        result,status,files=response["text"],"success",response.get("files",[])
    except (OSError,ValueError,TimeoutError):
        result,status="模型或文件生成服务未完成本次任务。","failed"
    with closing(ledger()) as db,db:
        if not db.execute("UPDATE runs SET status=?,result=?,seconds=? WHERE id=? AND status='running'",(status,result,int(time.monotonic()-start),rid)).rowcount:return
        for file in files:
            raw=file.pop("base64")
            db.execute("INSERT INTO files VALUES(?,?,?,?)",(str(uuid.uuid4()),rid,json.dumps(file,ensure_ascii=False),raw))


async def schedule_loop():
    while True:
        try:
            entry=claim(int(time.time()))
            if entry:await execute(*entry);continue
        except (sqlite3.Error,OSError,ValueError):
            import logging
            logging.exception("Scheduled execution failed")
        await asyncio.sleep(3)
