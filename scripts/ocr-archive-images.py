#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""对压缩包内的位图图片做 Vision OCR 入库（顶层图片已由 ocr-images.py 处理）。
解压→找图片→Vision OCR→写 md 到 <包名>__解压/，source_path 记 <压缩包>::<包内路径>。"""
import os, json, subprocess, tempfile, shutil, zipfile, hashlib

ROOT="/Users/kian/备份/AI/soul"
KN=os.path.join(ROOT,"avatars","小凯-电气工程师","knowledge")
VISION=os.path.join(ROOT,"scripts","vision-ocr")
DL="/Users/kian/Downloads/"
TODAY="2026-05-30"
SRC_MAP={"00 国标及技术文献":"国标及技术文献","工作小结":"工作小结","工商业储能":"工商业储能","超充桩":"超充桩"}
IMG_EXT={".jpg",".jpeg",".png",".gif",".bmp",".tif",".tiff"}

def out_base_for(archive):
    rel=os.path.relpath(archive,DL); parts=rel.split(os.sep)
    if parts[0] in SRC_MAP and len(parts)>1:
        return os.path.join(KN,SRC_MAP[parts[0]],os.path.splitext(os.path.join(*parts[1:]))[0]+"__解压")
    return os.path.join(KN,"_archives",os.path.splitext(os.path.basename(archive))[0]+"__解压")

def extract(archive,dest):
    os.makedirs(dest,exist_ok=True)
    if archive.lower().endswith(".zip"):
        try:
            with zipfile.ZipFile(archive) as z:
                for info in z.infolist():
                    name=info.filename
                    if not (info.flag_bits & 0x800):
                        try: name=name.encode("cp437").decode("gbk")
                        except: pass
                    name=name.replace("..","__")
                    if info.is_dir() or name.endswith("/"): continue
                    if os.path.splitext(name)[1].lower() not in IMG_EXT: continue
                    tgt=os.path.join(dest,name); os.makedirs(os.path.dirname(tgt),exist_ok=True)
                    with z.open(info) as s, open(tgt,"wb") as o: shutil.copyfileobj(s,o)
            return True
        except Exception: return False
    else:
        r=subprocess.run(["bsdtar","-xf",archive,"-C",dest],capture_output=True)
        return r.returncode==0 and bool(os.listdir(dest))

def sha1(p):
    h=hashlib.sha1()
    with open(p,"rb") as f:
        for c in iter(lambda:f.read(1<<20),b""): h.update(c)
    return h.hexdigest()

def main():
    ing=json.load(open(os.path.join(KN,"_ingest-report.json")))
    archives=[p for p,_ in ing["skipped"] if p.lower().endswith((".zip",".rar",".7z")) and os.path.exists(p)]
    cache={}; ok=empty=err=total=0
    for a in archives:
        tmp=tempfile.mkdtemp(prefix="aimg_")
        try:
            if not extract(a,tmp): continue
            for dp,_,fs in os.walk(tmp):
                for fn in fs:
                    if os.path.splitext(fn)[1].lower() not in IMG_EXT: continue
                    src=os.path.join(dp,fn); rel=os.path.relpath(src,tmp)
                    total+=1
                    op=os.path.join(out_base_for(a),os.path.splitext(rel)[0]+".md")
                    prov=f"{a}::{rel}"
                    try:
                        key=sha1(src)
                        if key in cache: text=cache[key]
                        else:
                            r=subprocess.run([VISION,src],capture_output=True,text=True,timeout=120)
                            text=r.stdout.strip(); cache[key]=text
                        title=os.path.splitext(os.path.basename(rel))[0]
                        fm=["---",f"source_path: {prov}","source_type: image",f"ingested: {TODAY}",
                            "ocr: macos-vision",f"ocr_chars: {len(text)}","---",""]
                        if len(text)>=2:
                            body=f"> **图片经 macOS Vision OCR 识别（解压自压缩包），可能有误差；图形/接线须看原图。**\n\n{text}"; ok+=1
                        else:
                            body="> **该图片未识别出文本（照片/示意图/Logo/纯图形）。仅登记来源。**"; empty+=1
                        os.makedirs(os.path.dirname(op),exist_ok=True)
                        open(op,"w",encoding="utf-8").write("\n".join(fm)+f"# {title}\n\n> 来源原件（压缩包内图片）：`{prov}`\n"+body+"\n")
                    except Exception as e:
                        err+=1; print("ERR",type(e).__name__,os.path.basename(src))
        finally:
            shutil.rmtree(tmp,ignore_errors=True)
    print(f"完成: 图片{total} | 有文本{ok} 无文本{empty} err{err}")

if __name__=="__main__": main()
