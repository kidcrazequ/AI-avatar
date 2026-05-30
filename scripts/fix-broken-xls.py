#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用 python-calamine 修复 xlrd 读不了的老 BIFF .xls（特殊特性清单等），
把 knowledge 里的 xls-broken 占位 stub 重写成真实表格 md。"""
import os, re, glob
from python_calamine import CalamineWorkbook

KN="/Users/kian/备份/AI/soul/avatars/小凯-电气工程师/knowledge"
TODAY="2026-05-30"
MAX_ROWS=300

def rows_to_md(rows):
    out=[]
    for r in rows[:MAX_ROWS]:
        cells=["" if c is None else str(c).replace("\n"," ").replace("|","/") for c in r]
        if any(cells): out.append("| "+" | ".join(cells)+" |")
    if len(rows)>MAX_ROWS: out.append(f"\n> （仅抽取前 {MAX_ROWS} 行，共 {len(rows)} 行，余略）")
    return "\n".join(out)

def find_broken_xls_stubs():
    hits=[]
    for f in glob.glob(os.path.join(KN,"**","*.md"),recursive=True):
        head=open(f,encoding="utf-8").read(400)
        if "source_type: xls-broken" in head or ("无法解析（损坏/加密" in head and "source_path:" in head):
            m=re.search(r'source_path:\s*(.+)',head)
            sp=m.group(1).strip() if m else ""
            if sp.lower().endswith(".xls"): hits.append((f,sp))
    return hits

def main():
    stubs=find_broken_xls_stubs()
    print(f"待修复 xls-broken stub: {len(stubs)}")
    ok=err=0
    for mdpath,src in stubs:
        if not os.path.exists(src):
            print("  源缺失:",src); err+=1; continue
        try:
            wb=CalamineWorkbook.from_path(src)
            parts=[]
            for name in wb.sheet_names:
                rows=wb.get_sheet_by_name(name).to_python()
                if not rows: continue
                parts.append(f"\n## Sheet: {name}\n"+rows_to_md(rows))
            body="\n".join(parts) if parts else "> （解析后无可抽取内容。）"
            title=os.path.splitext(os.path.basename(src))[0]
            fm=["---",f"source_path: {src}","source_type: xls",f"ingested: {TODAY}",
                "recovered_by: python-calamine（xlrd 无法解析的老 BIFF）","---",""]
            open(mdpath,"w",encoding="utf-8").write("\n".join(fm)+f"# {title}\n\n> 来源原件：`{src}`\n"+body+"\n")
            ok+=1; print(f"  ✓ {title} → {sum(len(wb.get_sheet_by_name(n).to_python()) for n in wb.sheet_names)} 行")
        except Exception as e:
            err+=1; print(f"  ✗ {os.path.basename(src)} → {type(e).__name__}: {e}")
    print(f"完成: 修复 {ok}, 失败 {err}")

if __name__=="__main__": main()
