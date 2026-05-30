#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""二次抽取（带回退）首轮 14 个 errors：
 - .xls 实为 xlsx：临时改名 .xlsx 后用 openpyxl 读
 - 老 BIFF .xls：xlrd(ignore_workbook_corruption=True)
 - 仍不行：HTML 表格解析
 - 加密/损坏 PDF：fitz authenticate('')；失败写可追溯 stub
真损坏一律写 stub（fail loud），不静默丢、不把报错当正文。"""
import os, json, shutil, tempfile
from html.parser import HTMLParser

KN = "/Users/kian/备份/AI/soul/avatars/小凯-电气工程师/knowledge"
TODAY = "2026-05-30"
SRC_ROOTS = {
    "/Users/kian/Downloads/00 国标及技术文献": "国标及技术文献",
    "/Users/kian/Downloads/工作小结": "工作小结",
    "/Users/kian/Downloads/工商业储能": "工商业储能",
    "/Users/kian/Downloads/超充桩": "超充桩",
}
MAX_ROWS = 300

ERRORS = [
 "/Users/kian/Downloads/工商业储能/01 明美/设计资料/SJ2024B7192SJ2024B7192modbusTcp-en.xls",
 "/Users/kian/Downloads/工商业储能/01 明美/设计资料/SJ2024B7192明美-欧洲125kW262kWhMAX-Pro认证测试项目modbusTcp-zh.xls",
 "/Users/kian/Downloads/工商业储能/海外招标/新风光-远景投标资料/附件/12、20240807 125kW261kWh液冷工商业储能系统产品规格书 ZMS.pdf",
 "/Users/kian/Downloads/工商业储能/09售后分析报告/英沃退件分析报告.pptx",
 "/Users/kian/Downloads/工商业储能/14 通讯点表/SJ2024B1447星纪云能-明美modbusTcp.xls",
 "/Users/kian/Downloads/工商业储能/11 器件规格书/00 远景/2025 Storage M&C/OneDrive_2025-09-24/Storage M&C交接相关文件/供应商站端EMS点表/高特EMS（ENS-L215、ENS-L372、 ENS-L262、ENS-L419）/高特 Modbus TCP标准协议.xls",
 "/Users/kian/Downloads/工商业储能/招投标/技术响应资料/新风光/附件/12、20240807 125kW261kWh液冷工商业储能系统产品规格书 ZMS.pdf",
 "/Users/kian/Downloads/超充桩/器件规格书/摄像头组件/高清充电桩车位管理相机_CCK10系列整机标准.pdf",
 "/Users/kian/Downloads/超充桩/01 零碳超充资料汇总/02 终端PPAP文件/02 终端/02 PPAP/10 特殊特性清单V1.xls",
 "/Users/kian/Downloads/超充桩/01 零碳超充资料汇总/01 充电柜/3.1特殊特性清单.xls",
 "/Users/kian/Downloads/超充桩/01 零碳超充资料汇总/01 充电柜/01 PPAP文件/06&10 特殊特性清单/远景特殊特性清单 (自动保存的) (自动保存的).xls",
 "/Users/kian/Downloads/超充桩/01 零碳超充资料汇总/02 终端/02 PPAP/10 特殊特性清单V1.xls",
 "/Users/kian/Downloads/超充桩/APQP相关/3.1特殊特性清单20250819-2.xls",
 "/Users/kian/Downloads/超充桩/充电桩/SPEC/摄像头/高清充电桩车位管理相机_CCK10系列整机标准.pdf",
]

def out_path_for(src):
    for root, sub in SRC_ROOTS.items():
        if src.startswith(root):
            rel = os.path.relpath(src, root)
            return os.path.join(KN, sub, os.path.splitext(rel)[0] + ".md")
    return None

def fm(src, stype, **ex):
    L=["---",f"source_path: {src}",f"source_type: {stype}",f"ingested: {TODAY}"]
    for k,v in ex.items(): L.append(f"{k}: {v}")
    return "\n".join(L)+"\n---\n"

def rows_to_md(rows):
    out=[]
    for row in rows[:MAX_ROWS]:
        cells=["" if c is None else str(c).replace("\n"," ").replace("|","/") for c in row]
        if any(cells): out.append("| "+" | ".join(cells)+" |")
    if len(rows)>MAX_ROWS: out.append(f"\n> （仅抽取前 {MAX_ROWS} 行，共 {len(rows)} 行，余略）")
    return "\n".join(out)

class TableHTML(HTMLParser):
    def __init__(self): super().__init__(); self.rows=[]; self.cur=None; self.cell=None
    def handle_starttag(self,t,a):
        if t=="tr": self.cur=[]
        elif t in("td","th"): self.cell=[]
    def handle_endtag(self,t):
        if t=="tr" and self.cur is not None: self.rows.append(self.cur); self.cur=None
        elif t in("td","th") and self.cell is not None and self.cur is not None:
            self.cur.append("".join(self.cell).strip()); self.cell=None
    def handle_data(self,d):
        if self.cell is not None: self.cell.append(d)

def try_xls(src):
    # 1) 老 BIFF：xlrd 容错
    try:
        import xlrd
        wb=xlrd.open_workbook(src, ignore_workbook_corruption=True)
        out=[]
        for sh in wb.sheets():
            rows=[[sh.cell_value(r,c) for c in range(sh.ncols)] for r in range(sh.nrows)]
            if rows: out.append(f"\n## Sheet: {sh.name}\n"+rows_to_md(rows))
        if out: return ("xls(xlrd)","\n".join(out))
    except Exception: pass
    # 2) 实为 xlsx：临时改名后 openpyxl
    try:
        import openpyxl
        tmp=tempfile.mktemp(suffix=".xlsx"); shutil.copy(src,tmp)
        wb=openpyxl.load_workbook(tmp, read_only=True, data_only=True)
        out=[]
        for ws in wb.worksheets:
            rows=list(ws.iter_rows(values_only=True))
            if rows: out.append(f"\n## Sheet: {ws.title}\n"+rows_to_md(rows))
        wb.close(); os.remove(tmp)
        if out: return ("xls→xlsx","\n".join(out))
    except Exception: pass
    # 3) HTML 表格
    try:
        raw=open(src,"rb").read()
        if b"<table" in raw[:4096].lower() or b"<html" in raw[:4096].lower():
            for enc in ("utf-8","gbk","gb18030","latin-1"):
                try: txt=raw.decode(enc); break
                except Exception: continue
            p=TableHTML(); p.feed(txt)
            if p.rows: return ("xls→html","## 表格\n"+rows_to_md(p.rows))
    except Exception: pass
    return (None,None)

def try_pdf(src):
    try:
        import fitz
        doc=fitz.open(src)
        if doc.needs_pass:
            if not doc.authenticate(""): doc.close(); return (None,None,0)
        parts=[]; total=0
        for i,pg in enumerate(doc):
            t=pg.get_text("text").strip(); total+=len(t)
            if t: parts.append(f"\n## 第 {i+1} 页\n\n{t}")
        npages=doc.page_count; doc.close()
        if total>=40: return ("pdf(recovered)","\n".join(parts), npages)
        return (None,None,0)
    except Exception:
        return (None,None,0)

def write_md(out_path, content):
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    open(out_path, "w", encoding="utf-8").write(content)

def main():
    recovered=[]; broken=[]
    for src in ERRORS:
        op=out_path_for(src)
        if op and os.path.exists(op): os.remove(op)  # 清掉首轮/上次残留
        title=os.path.splitext(os.path.basename(src))[0]
        ext=os.path.splitext(src)[1].lower()
        body=stype=None; extra={}
        if ext in(".xls",".xlsx",".xlsm"): stype,body=try_xls(src)
        elif ext==".pdf": stype,body,npg=try_pdf(src); extra={"pages":npg}
        if body:
            content=fm(src,stype,**extra)+f"# {title}\n\n> 来源原件：`{src}`\n"+body+"\n"
            write_md(op,content); recovered.append((os.path.relpath(op,KN),stype))
        else:
            content=fm(src,(ext or 'unknown').lstrip('.')+'-broken')+\
                f"# {title}\n\n> 来源原件：`{src}`\n\n> **该原件无法解析（损坏/加密/格式异常），仅登记来源；需人工重新导出后再入库。**\n"
            write_md(op,content); broken.append((src.replace('/Users/kian/Downloads/',''),))
    # 更新报告
    rep=os.path.join(KN,"_ingest-report.json"); d=json.load(open(rep))
    d["recovered"]=recovered; d["broken_stub"]=[b[0] for b in broken]
    # converted 计数：首轮 1337 已含？否。recovered 是新写成功的；broken 是 stub（也算登记）
    d["errors"]=[]
    json.dump(d,open(rep,"w"),ensure_ascii=False,indent=1)
    print("recovered:",len(recovered),"| broken-stub:",len(broken))
    for rp,st in recovered: print("  恢复:",st,"::",os.path.basename(rp))
    for b in broken: print("  stub:",os.path.basename(b[0]))

if __name__=="__main__": main()
