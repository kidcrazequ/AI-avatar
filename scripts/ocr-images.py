#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""对跳过的位图图片跑 macOS Vision OCR，识别文本回写 md 入库。
来源：_ingest-report.json 的 skipped 中的图片类；按源目录镜像归类。
无文本图片（照片/示意图/Logo）写占位并标注。"""
import os, json, subprocess, hashlib

ROOT="/Users/kian/备份/AI/soul"
KN=os.path.join(ROOT,"avatars","小凯-电气工程师","knowledge")
VISION=os.path.join(ROOT,"scripts","vision-ocr")
DL="/Users/kian/Downloads/"
TODAY="2026-05-30"
SRC_MAP={"00 国标及技术文献":"国标及技术文献","工作小结":"工作小结","工商业储能":"工商业储能","超充桩":"超充桩"}
IMG_EXT={".jpg",".jpeg",".png",".gif",".bmp",".tif",".tiff"}

def dest_for(p):
    rel=os.path.relpath(p,DL); parts=rel.split(os.sep)
    if parts[0] in SRC_MAP and len(parts)>1:
        return os.path.join(KN,SRC_MAP[parts[0]],os.path.splitext(os.path.join(*parts[1:]))[0]+".md")
    return None

def sha1(p):
    h=hashlib.sha1()
    with open(p,"rb") as f:
        for c in iter(lambda:f.read(1<<20),b""): h.update(c)
    return h.hexdigest()

def main():
    ing=json.load(open(os.path.join(KN,"_ingest-report.json")))
    imgs=[p for p,_ in ing["skipped"] if os.path.splitext(p)[1].lower() in IMG_EXT and os.path.exists(p)]
    print(f"待 OCR 图片: {len(imgs)}",flush=True)
    cache={}; ok=empty=err=0
    for i,src in enumerate(imgs,1):
        op=dest_for(src)
        if not op: err+=1; continue
        try:
            key=sha1(src)
            if key in cache: text=cache[key]
            else:
                r=subprocess.run([VISION,src],capture_output=True,text=True,timeout=120)
                text=r.stdout.strip(); cache[key]=text
            title=os.path.splitext(os.path.basename(src))[0]
            ne=len(text)
            fm=["---",f"source_path: {src}","source_type: image",f"ingested: {TODAY}",
                "ocr: macos-vision",f"ocr_chars: {ne}","---",""]
            if ne>=2:
                body=f"> **本文为图片经 macOS Vision OCR 识别，可能有误差；图形/接线关系无法由 OCR 还原，关键信息须看原图。**\n\n{text}"
                ok+=1
            else:
                body="> **该图片未识别出文本（可能是照片/示意图/Logo/纯图形）。仅登记来源，如需图形信息请人工查看原图或走多模态识别。**"
                empty+=1
            os.makedirs(os.path.dirname(op),exist_ok=True)
            open(op,"w",encoding="utf-8").write("\n".join(fm)+f"# {title}\n\n> 来源原件（图片）：`{src}`\n"+body+"\n")
            if i%20==0: print(f"[{i}/{len(imgs)}] 有文本{ok}/无文本{empty}/err{err}",flush=True)
        except Exception as e:
            err+=1; print(f"ERR {type(e).__name__}: {e} :: {os.path.basename(src)}",flush=True)
    print(f"完成: 有文本{ok} 无文本{empty} err{err}",flush=True)

if __name__=="__main__": main()
