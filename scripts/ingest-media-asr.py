#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把视频/音频用 whisper.cpp 转写成文本入库。
流程：ffmpeg 抽音轨→16kHz 单声道 wav→whisper-cli(-l zh)→文本→md。
按源文件 sha1 去重。需先装 ffmpeg + whisper.cpp + ggml 中文模型。"""
import os, json, subprocess, tempfile, hashlib, shutil, sys, time

ROOT="/Users/kian/备份/AI/soul"
KN=os.path.join(ROOT,"avatars","小凯-电气工程师","knowledge")
DL="/Users/kian/Downloads/"
TODAY="2026-05-30"
SRC_MAP={"00 国标及技术文献":"国标及技术文献","工作小结":"工作小结","工商业储能":"工商业储能","超充桩":"超充桩"}
MEDIA_EXT={".mp4",".avi",".mov",".mkv",".flv",".wmv",".mp3",".wav",".wma",".m4a"}
MODEL=os.environ.get("WHISPER_MODEL", os.path.join(ROOT,"scripts","models","ggml-medium.bin"))
WHISPER=shutil.which("whisper-cli") or shutil.which("whisper-cpp") or shutil.which("main")

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

def transcribe(src, tmp):
    wav=os.path.join(tmp,"a.wav")
    r=subprocess.run(["ffmpeg","-y","-i",src,"-ar","16000","-ac","1","-f","wav",wav],
                     capture_output=True,timeout=600)
    if not os.path.exists(wav) or os.path.getsize(wav)<1000:
        return None  # 无音轨
    outp=os.path.join(tmp,"o")
    subprocess.run([WHISPER,"-m",MODEL,"-l","zh","-nt","-otxt","-of",outp,"-f",wav],
                   capture_output=True,timeout=3600)
    txt=outp+".txt"
    return open(txt,encoding="utf-8",errors="replace").read().strip() if os.path.exists(txt) else ""

def main():
    if not WHISPER or not os.path.exists(MODEL):
        print(f"缺工具/模型: whisper={WHISPER} model存在={os.path.exists(MODEL)}"); sys.exit(2)
    ing=json.load(open(os.path.join(KN,"_ingest-report.json")))
    media=[p for p,_ in ing["skipped"] if os.path.splitext(p)[1].lower() in MEDIA_EXT and os.path.exists(p)]
    if len(sys.argv)>1: media=media[:int(sys.argv[1])]
    print(f"待转写媒体: {len(media)}",flush=True)
    cache={}; ok=empty=err=0; t0=time.time()
    for i,src in enumerate(media,1):
        op=dest_for(src)
        if not op: err+=1; continue
        tmp=tempfile.mkdtemp(prefix="asr_")
        try:
            key=sha1(src)
            text = cache[key] if key in cache else transcribe(src,tmp)
            cache[key]=text
            title=os.path.splitext(os.path.basename(src))[0]
            fm=["---",f"source_path: {src}","source_type: media",f"ingested: {TODAY}",
                "asr: whisper.cpp ggml-medium zh",f"asr_chars: {len(text or '')}","---",""]
            if text:
                body=f"> **本文为视频/音频经 whisper.cpp 语音转写，可能有识别误差；画面/操作演示无法由 ASR 还原。**\n\n{text}"
                ok+=1
            elif text=="":
                body="> **未转写出文本（可能无语音/纯背景音乐）。仅登记来源。**"; empty+=1
            else:
                body="> **该文件无音轨或无法解码，未转写。仅登记来源。**"; empty+=1
            os.makedirs(os.path.dirname(op),exist_ok=True)
            open(op,"w",encoding="utf-8").write("\n".join(fm)+f"# {title}\n\n> 来源原件（媒体）：`{src}`\n"+body+"\n")
            print(f"[{i}/{len(media)}] {title[:30]} → {len(text or '')}字 | ok{ok}/空{empty} | {time.time()-t0:.0f}s",flush=True)
        except Exception as e:
            err+=1; print(f"[{i}] ERR {type(e).__name__}: {e} :: {os.path.basename(src)}",flush=True)
        finally:
            shutil.rmtree(tmp,ignore_errors=True)
    print(f"完成: 有文本{ok} 空/无音{empty} err{err} | {time.time()-t0:.0f}s",flush=True)

if __name__=="__main__": main()
