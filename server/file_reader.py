"""Bounded extraction of text from a visitor-selected PDF or raster image."""
import base64
import os
import shutil
import subprocess
import tempfile
import threading
import time
from pathlib import Path

_slots=threading.BoundedSemaphore(2)


def extract(params):
    if not _slots.acquire(blocking=False):raise ValueError("正在处理其他文件，请稍后再试")
    try:return _extract(params)
    finally:_slots.release()


def _extract(params):
    raw=base64.b64decode(params["data"],validate=True)
    if len(raw)>4_000_000:raise ValueError("文件最大为 4 MB")
    pdf=raw.startswith(b"%PDF-")
    if not pdf and not (raw.startswith(b"\x89PNG\r\n\x1a\n") or raw.startswith(b"\xff\xd8\xff") or raw[:4]==b"RIFF" and raw[8:12]==b"WEBP"):
        raise ValueError("支持 PDF、PNG、JPEG 和 WebP")
    deadline=time.monotonic()+28
    with tempfile.TemporaryDirectory(prefix="aiwp-read-") as work:
        root=Path(work)
        src=root/("input.pdf" if pdf else "image")
        src.write_bytes(raw)
        identity={}
        if os.getuid()==0:
            import pwd
            user=pwd.getpwnam("nobody")
            os.chown(root,user.pw_uid,user.pw_gid);os.chown(src,user.pw_uid,user.pw_gid)
            identity=dict(user=user.pw_uid,group=user.pw_gid,extra_groups=[])
        def run(program,*args):
            binary=shutil.which(program)
            if not binary:raise ValueError("服务器尚未安装文件文字识别组件")
            cmd=[binary,*map(str,args)]
            if limiter:=shutil.which("prlimit"):cmd=[limiter,"--as=805306368","--cpu=12","--fsize=12000000","--nofile=64","--",*cmd]
            try:
                subprocess.run(cmd,cwd=work,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,
                    timeout=max(.2,deadline-time.monotonic()),check=True,env={"PATH":os.defpath,"HOME":work,"TMPDIR":work,"OMP_THREAD_LIMIT":"1"},**identity)
            except (subprocess.SubprocessError,OSError):raise ValueError("无法读取文件，请检查文件、密码或减少页数") from None
        chunks=[]
        if pdf:
            out=root/"text.txt"
            run("pdftotext","-f","1","-l","40","-enc","UTF-8",src,out)
            with out.open(encoding="utf-8",errors="replace") as handle:text=handle.read(24001).strip()
            if text:return {"text":text[:24000],"method":"PDF 正文（前 40 页）","truncated":len(text)>24000}
            run("pdftoppm","-f","1","-l","3","-scale-to","1300","-png",src,root/"page")
            images=sorted(root.glob("page-*.png"))
        else:images=[src]
        for i,img in enumerate(images):
            output=root/f"ocr{i}"
            run("tesseract",img,output,"-l","chi_sim+eng")
            with output.with_suffix(".txt").open(encoding="utf-8",errors="replace") as handle:chunks.append(handle.read(24001).strip())
        text="\n\n".join(chunks).strip()
        if not text:raise ValueError("没有识别到文字，可以上传更清晰的文件或手动添加笔记")
        return {"text":text[:24000],"method":"扫描件 OCR（前 3 页）" if pdf else "图片 OCR","truncated":len(text)>24000}
