#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把 dwg CAD 图纸里的文字注释抽出来入库。
dwg --(dwg2dxf, libredwg)--> dxf --(解析 TEXT/MTEXT/ATTRIB 的 group code 1)--> 文本。
只抽文字（标题栏、标注、线号、料号、说明），图形/线条无法还原。"""
import os, json, subprocess, tempfile

ROOT="/Users/kian/备份/AI/soul"
KN=os.path.join(ROOT,"avatars","小凯-电气工程师","knowledge")
DL="/Users/kian/Downloads/"
TODAY="2026-05-30"
SRC_MAP={"00 国标及技术文献":"国标及技术文献","工作小结":"工作小结","工商业储能":"工商业储能","超充桩":"超充桩"}

def dest_for(p):
    rel=os.path.relpath(p,DL); parts=rel.split(os.sep)
    if parts[0] in SRC_MAP and len(parts)>1:
        return os.path.join(KN,SRC_MAP[parts[0]],os.path.splitext(os.path.join(*parts[1:]))[0]+".md")
    return None

def dxf_texts(dxf_path):
    """从 ASCII DXF 抽 TEXT/MTEXT/ATTRIB/ATTDEF 的文字（group code 1，MTEXT 续行 code 3）。"""
    try:
        lines=open(dxf_path,encoding="utf-8",errors="replace").read().splitlines()
    except Exception:
        return []
    texts=[]; i=0; n=len(lines); cur_entity=None
    while i+1 < n:
        code=lines[i].strip(); val=lines[i+1]
        if code=="0":
            cur_entity=val.strip()
        elif cur_entity in ("TEXT","MTEXT","ATTRIB","ATTDEF"):
            if code in ("1","3"):
                t=val.strip()
                # 清理 MTEXT 格式码 \A1; {\fName;...} \P 等
                import re
                t=re.sub(r'\\[A-Za-z][^;\\]*;','',t)
                t=t.replace("\\P"," ").replace("{","").replace("}","")
                t=re.sub(r'\\[\\{}]','',t).strip()
                if t: texts.append(t)
        i+=2
    return texts

def main():
    ing=json.load(open(os.path.join(KN,"_ingest-report.json")))
    dwgs=[p for p,_ in ing["skipped"] if p.lower().endswith(".dwg") and os.path.exists(p)]
    print(f"待处理 dwg: {len(dwgs)}",flush=True)
    ok=empty=err=0
    for idx,src in enumerate(dwgs,1):
        op=dest_for(src)
        if not op: err+=1; continue
        tmp=tempfile.mkdtemp(prefix="dwg_")
        dxf=os.path.join(tmp,"out.dxf")
        try:
            r=subprocess.run(["dwg2dxf","-o",dxf,src],capture_output=True,timeout=120)
            texts=dxf_texts(dxf) if os.path.exists(dxf) else []
            # 去重保序
            seen=set(); uniq=[t for t in texts if not (t in seen or seen.add(t))]
            title=os.path.splitext(os.path.basename(src))[0]
            fm=["---",f"source_path: {src}","source_type: dwg",f"ingested: {TODAY}",
                "extract: libredwg dwg2dxf → TEXT/MTEXT",f"text_items: {len(uniq)}","---",""]
            if uniq:
                body=("> **本文仅抽取 CAD 图纸中的**文字注释**（标题栏/标注/线号/料号/说明）；"
                      "图形、线条、连接关系无法由文本还原，读图请看原 dwg。**\n\n## 图纸文字注释\n\n"
                      + "\n".join(f"- {t}" for t in uniq))
                ok+=1
            else:
                body="> **该 dwg 未抽到文字注释（可能纯图形或转换失败）。仅登记来源，读图请看原 dwg 或导出 PDF。**"
                empty+=1
            os.makedirs(os.path.dirname(op),exist_ok=True)
            open(op,"w",encoding="utf-8").write("\n".join(fm)+f"# {title}\n\n> 来源原件（CAD 图纸）：`{src}`\n"+body+"\n")
            if idx%20==0: print(f"[{idx}/{len(dwgs)}] 有文字{ok}/无{empty}/err{err}",flush=True)
        except Exception as e:
            err+=1; print(f"ERR {type(e).__name__}: {e} :: {os.path.basename(src)}",flush=True)
        finally:
            import shutil; shutil.rmtree(tmp,ignore_errors=True)
    print(f"完成: 有文字{ok} 无文字{empty} err{err}",flush=True)

if __name__=="__main__": main()
