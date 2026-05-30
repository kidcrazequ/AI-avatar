#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""为小凯的「可精确查询」Excel（点表/BOM/物料/特殊特性/参数/配置）生成 _excel/<basename>.json，
格式与 App write-excel-data 一致，供 query_excel 工具精确过滤行。只建子集，避免系统提示膨胀。"""
import os, re, json, shutil, tempfile, sys

KN="/Users/kian/备份/AI/soul/avatars/小凯-电气工程师/knowledge"
EXCEL_DIR=os.path.join(KN,"_excel")
SRC_DIRS=["/Users/kian/Downloads/00 国标及技术文献","/Users/kian/Downloads/工商业储能",
          "/Users/kian/Downloads/超充桩","/Users/kian/Downloads/工作小结"]
KEYWORDS=re.compile(r'点表|modbus|寄存器|通讯|通信|bom|物料|料号|特殊特性|参数表|参数清单|配置表|品号', re.I)
IMPORTED_AT="2026-05-30T00:00:00.000Z"
MAX_ROWS=5000
MAX_SAMPLES=8

def sanitize(stem):
    return re.sub(r'[^a-zA-Z0-9一-龥_-]','_',stem)

def read_sheets(path):
    """返回 [(sheet_name, [row_tuple,...]), ...]；兼容 xlsx/xlsm 与老/伪 xls。"""
    ext=os.path.splitext(path)[1].lower()
    # xlsx/xlsm 直接 openpyxl
    def via_openpyxl(p):
        import openpyxl
        wb=openpyxl.load_workbook(p,read_only=True,data_only=True)
        out=[(ws.title,list(ws.iter_rows(values_only=True))) for ws in wb.worksheets]
        wb.close(); return out
    if ext in (".xlsx",".xlsm"):
        return via_openpyxl(path)
    # .xls：先 xlrd（老 BIFF），失败再当 xlsx 临时改名，再不行用 calamine（含 xlrd 读不了的老 BIFF）
    try:
        import xlrd
        wb=xlrd.open_workbook(path, ignore_workbook_corruption=True)
        out=[]
        for sh in wb.sheets():
            rows=[tuple(sh.cell_value(r,c) for c in range(sh.ncols)) for r in range(sh.nrows)]
            out.append((sh.name,rows))
        if out: return out
    except Exception:
        pass
    tmp=tempfile.mktemp(suffix=".xlsx"); shutil.copy(path,tmp)
    try:
        return via_openpyxl(tmp)
    except Exception:
        pass
    finally:
        try: os.remove(tmp)
        except: pass
    from python_calamine import CalamineWorkbook
    wb=CalamineWorkbook.from_path(path)
    return [(n, wb.get_sheet_by_name(n).to_python()) for n in wb.sheet_names]

def jval(v):
    if v is None: return None
    if isinstance(v,bool): return str(v)
    if isinstance(v,(int,float)): return v
    return str(v).strip()

def build_sheet(name, rows):
    rows=[r for r in rows]
    if not rows: return None
    ncols=max((len(r) for r in rows), default=0)
    if ncols==0: return None
    # 表头探测：前 5 行里非空单元最多、且非空值唯一、且多为字符串的那一行
    header_idx=-1; best=0
    for i,r in enumerate(rows[:5]):
        cells=[jval(x) for x in r]
        nn=[c for c in cells if c not in (None,"")]
        if len(nn)<ncols*0.6: continue
        if len(set(map(str,nn)))!=len(nn): continue
        if sum(1 for c in nn if isinstance(c,str))<len(nn)*0.7: continue
        if len(nn)>best: best=len(nn); header_idx=i
    if header_idx>=0:
        hdr=[jval(x) for x in rows[header_idx]]
        names=[]; seen={}
        for i in range(ncols):
            nm=str(hdr[i]).strip() if i<len(hdr) and hdr[i] not in (None,"") else f"col{i+1}"
            if nm in seen: seen[nm]+=1; nm=f"{nm}_{seen[nm]}"
            else: seen[nm]=1
            names.append(nm)
        data=rows[header_idx+1:]
    else:
        names=[f"col{i+1}" for i in range(ncols)]
        data=rows
    data=data[:MAX_ROWS]
    # 行 dict
    rdicts=[]
    for r in data:
        d={}
        for i,nm in enumerate(names):
            d[nm]=jval(r[i]) if i<len(r) else None
        rdicts.append(d)
    # 列 schema
    columns=[]
    for i,nm in enumerate(names):
        vals=[d[nm] for d in rdicts if d.get(nm) not in (None,"")]
        nums=all(isinstance(v,(int,float)) for v in vals) and len(vals)>0
        seen=[];
        for v in vals:
            s=str(v)
            if s not in seen: seen.append(s)
            if len(seen)>=MAX_SAMPLES: break
        columns.append({"name":nm,"dtype":"number" if nums else "string",
                        "uniqueCount":len(set(str(v) for v in vals)),"samples":seen})
    return {"name":name,"rowCount":len(rdicts),"columns":columns,
            "rows":rdicts,"rowMetaRoles":["data"]*len(rdicts)}

def main():
    os.makedirs(EXCEL_DIR,exist_ok=True)
    files=[]
    for root in SRC_DIRS:
        for dp,_,fs in os.walk(root):
            for fn in fs:
                if fn.startswith("~$"): continue
                if os.path.splitext(fn)[1].lower() not in (".xlsx",".xls",".xlsm"): continue
                full=os.path.join(dp,fn)
                if KEYWORDS.search(full): files.append(full)
    print(f"匹配可查询 Excel: {len(files)}",flush=True)
    used={}; ok=err=0; manifest=[]
    for path in sorted(files):
        stem=os.path.splitext(os.path.basename(path))[0]
        base=sanitize(stem)
        if base in used: used[base]+=1; base=f"{base}_{used[base]}"
        else: used[base]=1
        try:
            sheets_raw=read_sheets(path)
            sheets=[s for s in (build_sheet(n,r) for n,r in sheets_raw) if s and s["rowCount"]>0]
            if not sheets: err+=1; print("  空表跳过:",os.path.basename(path)); continue
            doc={"fileName":os.path.basename(path),"importedAt":IMPORTED_AT,"sheets":sheets}
            out=os.path.join(EXCEL_DIR,base+".json")
            json.dump(doc,open(out,"w",encoding="utf-8"),ensure_ascii=False,indent=2)
            ok+=1; manifest.append({"file":base,"source":path.replace("/Users/kian/Downloads/",""),
                                    "sheets":[(s["name"],s["rowCount"],len(s["columns"])) for s in sheets]})
        except Exception as e:
            err+=1; print(f"  ERR {type(e).__name__}: {e} :: {os.path.basename(path)}")
    json.dump(manifest,open(os.path.join(EXCEL_DIR,"_manifest.json"),"w",encoding="utf-8"),ensure_ascii=False,indent=1)
    print(f"完成: 生成 {ok} 个 _excel/json, 失败 {err}",flush=True)

if __name__=="__main__": main()
