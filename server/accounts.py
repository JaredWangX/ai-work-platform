"""Accounts, team memberships and versioned encrypted workspace records."""
import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import time

import connections


def setup(db):
    db.executescript("""
    CREATE TABLE IF NOT EXISTS people(id TEXT PRIMARY KEY, login TEXT UNIQUE, display TEXT, salt BLOB, verifier BLOB);
    CREATE TABLE IF NOT EXISTS spaces(owner TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS memberships(owner TEXT, person TEXT, role TEXT NOT NULL, PRIMARY KEY(owner,person));
    CREATE TABLE IF NOT EXISTS sessions(digest TEXT PRIMARY KEY, person TEXT, owner TEXT, expires INTEGER);
    CREATE TABLE IF NOT EXISTS invitations(id TEXT PRIMARY KEY, digest TEXT UNIQUE, owner TEXT, note TEXT, expires INTEGER, used INTEGER DEFAULT 0);
    CREATE TABLE IF NOT EXISTS personal_settings(person TEXT PRIMARY KEY, sealed BLOB NOT NULL, rev INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS recovery(person TEXT PRIMARY KEY, hash TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS login_attempts(key TEXT PRIMARY KEY, start INTEGER, n INTEGER);
    CREATE TABLE IF NOT EXISTS cloud_chunks(owner TEXT, id TEXT, bytes BLOB NOT NULL, created INTEGER, PRIMARY KEY(owner,id));
    CREATE TABLE IF NOT EXISTS cloud_records(owner TEXT, key TEXT, parts TEXT, PRIMARY KEY(owner,key));
    """)


def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()


def identity(db,token):
    if not isinstance(token,str):raise ValueError("请登录工作空间")
    if re.fullmatch(r"s\.[a-f0-9]{64}",token):
        row=db.execute("""SELECT s.person,s.owner,m.role FROM sessions s JOIN memberships m ON m.owner=s.owner AND m.person=s.person
                        WHERE s.digest=? AND s.expires>?""",(digest(token),int(time.time()))).fetchone()
        if not row:raise ValueError("登录已过期，请重新登录")
        return dict(row)
    if not re.fullmatch(r"[a-f0-9]{64}",token):raise ValueError("缺少工作空间身份")
    owner=digest(token)
    if db.execute("SELECT 1 FROM spaces WHERE owner=?",(owner,)).fetchone():raise ValueError("工作空间已绑定账号，请登录")
    return dict(person=None,owner=owner,role="guest")


def public_info(db,who):
    if not who["person"]:return {"signedIn":False}
    person=db.execute("SELECT id,login,display FROM people WHERE id=?",(who["person"],)).fetchone()
    spaces=[dict(r) for r in db.execute("SELECT s.owner AS id,s.name,m.role FROM memberships m JOIN spaces s USING(owner) WHERE m.person=? ORDER BY s.rowid",(who["person"],))]
    return dict(signedIn=True,person=dict(person),spaces=spaces,space=who["owner"],role=who["role"])


def password_hash(text,salt):
    return hashlib.scrypt(text.encode(),salt=salt,n=32768,r=8,p=1,maxmem=64*1024*1024,dklen=32)


def join(db,person,code):
    row=db.execute("SELECT * FROM invitations WHERE digest=? AND expires>? AND used=0",(digest(code.strip()),int(time.time()))).fetchone()
    if not row:raise ValueError("邀请码无效、已使用或已过期")
    if db.execute("SELECT 1 FROM memberships WHERE person=? AND owner=?",(person,row["owner"])).fetchone():raise ValueError("你已是该团队成员")
    db.execute("INSERT INTO memberships VALUES(?,?,'member')",(row["owner"],person))
    db.execute("UPDATE invitations SET used=1 WHERE id=?",(row["id"],))
    return row["owner"]


def throttle(db,key,limit):
    now=int(time.time())
    db.execute("DELETE FROM login_attempts WHERE start<?",(now-600,))
    db.execute("INSERT INTO login_attempts VALUES(?,?,1) ON CONFLICT(key) DO UPDATE SET n=n+1",(key,now))
    hits=db.execute("SELECT n FROM login_attempts WHERE key=?",(key,)).fetchone()[0]
    db.commit()
    if hits>limit:raise ValueError("尝试过于频繁，请稍后再试")


def sign(db,action,raw,token):
    login=connections.field(raw,"login",64).casefold()
    password=connections.field(raw,"password",180,strip=False)
    if not re.fullmatch(r"[a-z0-9][a-z0-9._@+-]{2,63}",login):raise ValueError("账号须为 3–64 位字母、数字或常用邮箱字符")
    throttle(db,"login:"+digest(login),24)
    if action=="register":throttle(db,"registration",80)
    elif action=="recover":
        code=connections.field(raw,"code",120)
        if len(password)<10:raise ValueError("密码至少 10 个字符")
        salt=os.urandom(16);verified=password_hash(password,salt)
        db.execute("BEGIN IMMEDIATE")
        row=db.execute("SELECT p.id,r.hash FROM people p JOIN recovery r ON r.person=p.id WHERE p.login=?",(login,)).fetchone()
        if not row or not hmac.compare_digest(row["hash"],digest(code)):raise ValueError("账号或找回码无效")
        db.execute("UPDATE people SET salt=?,verifier=? WHERE id=?",(salt,verified,row["id"]))
        db.execute("DELETE FROM sessions WHERE person=?",(row["id"],));db.execute("DELETE FROM recovery WHERE person=?",(row["id"],));return {"ok":True}
    if action=="register":
        if len(password)<10:raise ValueError("密码至少 10 个字符")
        guest=identity(db,token)
        if guest["person"]:raise ValueError("请先退出当前账号")
        display=connections.field(raw,"display",40,False) or login
        salt=os.urandom(16);verifier=password_hash(password,salt);person=secrets.token_hex(16)
        db.execute("BEGIN IMMEDIATE")
        if db.execute("SELECT 1 FROM people WHERE login=?",(login,)).fetchone():raise ValueError("此账号已注册")
        if db.execute("SELECT 1 FROM spaces WHERE owner=?",(guest["owner"],)).fetchone():raise ValueError("此工作空间已注册")
        db.execute("INSERT INTO people VALUES(?,?,?,?,?)",(person,login,display,salt,verifier))
        owner=guest["owner"]
        db.execute("INSERT INTO spaces VALUES(?,?)",(owner,display+"的工作空间"))
        db.execute("INSERT INTO memberships VALUES(?,?,'admin')",(owner,person))
        if raw.get("invite"):owner=join(db,person,raw["invite"])
    else:
        row=db.execute("SELECT * FROM people WHERE login=?",(login,)).fetchone()
        verified=password_hash(password,row["salt"] if row else bytes(16))
        if not row or not hmac.compare_digest(verified,row["verifier"]):raise ValueError("账号或密码不正确")
        person=row["id"]
        owner=db.execute("SELECT owner FROM memberships WHERE person=? ORDER BY rowid LIMIT 1",(person,)).fetchone()[0]
        if raw.get("space") and db.execute("SELECT 1 FROM memberships WHERE person=? AND owner=?",(person,raw["space"])).fetchone():owner=raw["space"]
    session="s."+secrets.token_hex(32)
    now=int(time.time())
    db.execute("DELETE FROM sessions WHERE expires<=?",(now,))
    db.execute("INSERT INTO sessions VALUES(?,?,?,?)",(digest(session),person,owner,now+14*86400))
    return {**public_info(db,identity(db,session)),"session":session}


def team(db,who,action,raw,token):
    person,owner,role=who["person"],who["owner"],who["role"]
    if action=="account":return public_info(db,who)
    if not person:raise ValueError("请先登录账号")
    if action in ("getPrefs","setPrefs"):
        aad=("preferences/"+person).encode()
        if action=="setPrefs":db.execute("BEGIN IMMEDIATE")
        row=db.execute("SELECT * FROM personal_settings WHERE person=?",(person,)).fetchone()
        rev=row["rev"] if row else 0
        if action=="getPrefs":
            return {"rev":rev,"value":json.loads(connections.crypt().decrypt(row["sealed"][:12],row["sealed"][12:],aad)) if row else None}
        if rev!=raw.get("rev"):raise ValueError("其他设备已更新偏好，请重新载入后编辑")
        text=raw.get("preferences");enabled=raw.get("enabled")
        if not isinstance(text,str) or len(text)>800 or type(enabled)!=bool:raise ValueError("个人偏好格式无效")
        nonce=os.urandom(12);blob=nonce+connections.crypt().encrypt(nonce,json.dumps(dict(preferences=text,enabled=enabled)).encode(),aad)
        db.execute("INSERT OR REPLACE INTO personal_settings VALUES(?,?,?)",(person,blob,rev+1));return {"rev":rev+1}
    if action in ("changePassword","issueRecovery"):
        throttle(db,"account:"+person,18)
        row=db.execute("SELECT salt,verifier FROM people WHERE id=?",(person,)).fetchone()
        if not hmac.compare_digest(password_hash(connections.field(raw,"current",180,strip=False),row["salt"]),row["verifier"]):raise ValueError("当前密码不正确")
        if action=="issueRecovery":
            code=secrets.token_urlsafe(30)
            db.execute("INSERT OR REPLACE INTO recovery VALUES(?,?)",(person,digest(code)));return {"code":code}
        new=connections.field(raw,"password",180,strip=False)
        if len(new)<10:raise ValueError("密码至少 10 个字符")
        salt=os.urandom(16);db.execute("UPDATE people SET salt=?,verifier=? WHERE id=?",(salt,password_hash(new,salt),person))
        db.execute("DELETE FROM sessions WHERE person=? AND digest<>?",(person,digest(token)))
        db.execute("DELETE FROM recovery WHERE person=?",(person,));return {"ok":True}
    if action=="logout":
        db.execute("DELETE FROM sessions WHERE digest=?",(digest(token),));return {"ok":True}
    if action=="members":
        people=[dict(r) for r in db.execute("SELECT p.id,p.display,p.login,m.role FROM memberships m JOIN people p ON p.id=m.person WHERE m.owner=? ORDER BY m.rowid",(owner,))]
        invites=[dict(r) for r in db.execute("SELECT id,note,used,expires FROM invitations WHERE owner=? ORDER BY rowid DESC LIMIT 50",(owner,))] if role=="admin" else []
        return {"members":people,"invites":invites}
    db.execute("BEGIN IMMEDIATE")
    if action in ("joinTeam","switchTeam"):
        if action=="joinTeam":destination=join(db,person,connections.field(raw,"code",120))
        else:
            destination=connections.field(raw,"space",64)
            if not db.execute("SELECT 1 FROM memberships WHERE owner=? AND person=?",(destination,person)).fetchone():raise ValueError("没有这个工作空间的访问权限")
        # Rotate the bearer so requests already underway cannot be redirected to another team.
        new_token="s."+secrets.token_hex(32)
        db.execute("UPDATE sessions SET owner=?,digest=? WHERE digest=?",(destination,digest(new_token),digest(token)))
        return {**public_info(db,identity(db,new_token)),"session":new_token}
    if role!="admin":raise ValueError("只有工作空间管理员可以执行此操作")
    if action=="invite":
        code=secrets.token_urlsafe(21);now=int(time.time())
        if db.execute("SELECT count(*) FROM invitations WHERE owner=? AND used=0 AND expires>?",(owner,now)).fetchone()[0]>=30:raise ValueError("待使用邀请码已达上限")
        db.execute("INSERT INTO invitations VALUES(?,?,?,?,?,0)",(secrets.token_hex(12),digest(code),owner,connections.field(raw,"note",120,False),now+7*86400))
        return {"code":code}
    if action=="revokeInvite":db.execute("UPDATE invitations SET used=2 WHERE owner=? AND id=? AND used=0",(owner,raw["id"]));return {"ok":True}
    if action=="removeMember":
        db.execute("DELETE FROM memberships WHERE owner=? AND person=? AND role='member'",(owner,raw["id"]))
        db.execute("DELETE FROM sessions WHERE owner=? AND person=? AND person<>?",(owner,raw["id"],person));return {"ok":True}
    raise ValueError("未知的团队操作")


def cloud(db,who,action,data):
    owner=who["owner"]
    if not who["person"]:raise ValueError("跨设备同步需要登录")
    def valid_key(key):
        return isinstance(key,str) and re.fullmatch(r"(?:projects|tasks|knowledge|skills|staff|teams|files|chats|office|settings)/[a-zA-Z0-9_-]{1,120}",key)
    if action=="syncIndex":
        return {"records":{r[0]:json.loads(r[1]) for r in db.execute("SELECT key,parts FROM cloud_records WHERE owner=?",(owner,))}}
    if action in ("syncPut","syncGet"):
        key=data.get("hash","")
        if not isinstance(key,str) or not re.fullmatch("[a-f0-9]{64}",key):raise ValueError("数据块标识无效")
        aad=f"{owner}/chunk/{key}".encode()
        if action=="syncGet":
            row=db.execute("SELECT bytes FROM cloud_chunks WHERE owner=? AND id=?",(owner,key)).fetchone()
            if not row:raise ValueError("数据块已过期，请刷新")
            blob=row[0];return {"data":base64.b64encode(connections.crypt().decrypt(blob[:12],blob[12:],aad)).decode()}
        try:raw=base64.b64decode(data["data"],validate=True)
        except (ValueError,TypeError,KeyError):raise ValueError("数据块格式无效") from None
        if not 1<=len(raw)<=42000 or hashlib.sha256(raw).hexdigest()!=key:raise ValueError("数据校验失败")
        if db.execute("SELECT 1 FROM cloud_chunks WHERE owner=? AND id=?",(owner,key)).fetchone():return {"ok":True}
        db.execute("BEGIN IMMEDIATE")
        now=int(time.time())
        # Retain newly uploaded chunks for concurrent clients until their manifests commit.
        db.execute("""DELETE FROM cloud_chunks WHERE owner=? AND created<? AND id NOT IN
                   (SELECT j.value FROM cloud_records r,json_each(r.parts) j WHERE r.owner=?)""",(owner,now-3600,owner))
        if db.execute("SELECT coalesce(sum(length(bytes)),0) FROM cloud_chunks WHERE owner=?",(owner,)).fetchone()[0]+len(raw)>40*1024*1024:raise ValueError("工作空间同步容量已达 40 MB")
        nonce=os.urandom(12);blob=nonce+connections.crypt().encrypt(nonce,raw,aad)
        db.execute("INSERT OR IGNORE INTO cloud_chunks VALUES(?,?,?,?)",(owner,key,blob,now));return {"ok":True}
    changes=data.get("changes")
    if not isinstance(changes,list) or not 1<=len(changes)<=100:raise ValueError("同步数量无效")
    db.execute("BEGIN IMMEDIATE")
    for change in changes:
        key=change.get("key");parts=change.get("parts")
        if not valid_key(key) or not isinstance(parts,list) or len(parts)>128:raise ValueError("同步记录无效")
        row=db.execute("SELECT parts FROM cloud_records WHERE owner=? AND key=?",(owner,key)).fetchone()
        if (json.loads(row[0]) if row else [])!=change.get("base"):return_conflict=True;break
        for chunk in parts:
            if not isinstance(chunk,str) or not db.execute("SELECT 1 FROM cloud_chunks WHERE owner=? AND id=?",(owner,chunk)).fetchone():raise ValueError("同步数据块缺失")
    else:return_conflict=False
    if return_conflict:return {"conflict":True}
    for change in changes:
        if change["parts"]:db.execute("INSERT OR REPLACE INTO cloud_records VALUES(?,?,?)",(owner,change["key"],json.dumps(change["parts"])))
        else:db.execute("DELETE FROM cloud_records WHERE owner=? AND key=?",(owner,change["key"]))
    if db.execute("SELECT count(*) FROM cloud_records WHERE owner=?",(owner,)).fetchone()[0]>2000:raise ValueError("工作空间最多同步 2000 项")
    return {"ok":True}
