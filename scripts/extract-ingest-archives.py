#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""解压 zip/rar/7z 并把其中文本文件抽取入库（复用 ingest-xiaokai-knowledge 的转换器）。
- zip：Python zipfile（修正 GBK 中文名）；7z/rar：bsdtar(libarchive)
- 解压物镜像到 knowledge/<源子目录>/<...>/<包名>__解压/
- 嵌套压缩包递归一层；非文本继续跳过登记；扫描件 PDF 留 stub（之后再跑 OCR）
"""
import os, sys, json, subprocess, tempfile, shutil, importlib.util, zipfile

ROOT = "/Users/kian/备份/AI/soul"
spec = importlib.util.spec_from_file_location("ingest", os.path.join(ROOT,"scripts","ingest-xiaokai-knowledge.py"))
ing = importlib.util.module_from_spec(spec); spec.loader.exec_module(ing)
ospec = importlib.util.spec_from_file_location("ocrmod", os.path.join(ROOT,"scripts","ocr-scanned.py"))
ocrmod = importlib.util.module_from_spec(ospec); ospec.loader.exec_module(ocrmod)
KN, CONV, SKIP_EXT, SRC_MAP = ing.KN, ing.CONV, ing.SKIP_EXT, ing.SRC_MAP
ARCH_EXT = {".zip", ".rar", ".7z"}

report = {"archives":0, "extract_fail":[], "converted":0, "skipped":0,
          "scanned_pdf":0, "errors":[], "nested":0, "per_archive":[]}

DL = "/Users/kian/Downloads"
def dest_for(archive):
    rel = os.path.relpath(archive, DL)              # 工商业储能/01 洛希/合同.7z
    parts = rel.split(os.sep)
    if parts[0] in SRC_MAP and len(parts) > 1:
        inner = os.path.join(*parts[1:])            # 01 洛希/合同.7z
        return os.path.join(KN, SRC_MAP[parts[0]], os.path.splitext(inner)[0] + "__解压")
    return os.path.join(KN, "_archives", os.path.splitext(os.path.basename(archive))[0] + "__解压")

def extract(archive, dest):
    os.makedirs(dest, exist_ok=True)
    ext = os.path.splitext(archive)[1].lower()
    if ext == ".zip":
        try:
            with zipfile.ZipFile(archive) as z:
                for info in z.infolist():
                    name = info.filename
                    if not (info.flag_bits & 0x800):   # 非 UTF-8 → 多为 GBK
                        try: name = name.encode("cp437").decode("gbk")
                        except Exception: pass
                    name = name.replace("..", "__")
                    tgt = os.path.join(dest, name)
                    if info.is_dir() or name.endswith("/"):
                        os.makedirs(tgt, exist_ok=True); continue
                    os.makedirs(os.path.dirname(tgt), exist_ok=True)
                    with z.open(info) as s, open(tgt, "wb") as o:
                        shutil.copyfileobj(s, o)
            return True
        except Exception as e:
            report["extract_fail"].append((archive, f"zip: {e}")); return False
    else:  # 7z / rar via bsdtar（stderr 可能含 GBK 字节，按 bytes 捕获再容错解码）
        r = subprocess.run(["bsdtar","-xf",archive,"-C",dest], capture_output=True)
        if r.returncode == 0 and os.listdir(dest): return True
        msg = (r.stderr or b"").decode("utf-8","replace").strip()[:120]
        report["extract_fail"].append((archive, f"bsdtar rc={r.returncode}: {msg}"))
        return False

def ocr_inline(src, prov, npages_hint):
    """扫描件 PDF：趁临时文件还在，直接渲染+Vision OCR，返回真实 md 正文。"""
    tmp = tempfile.mkdtemp(prefix="aocr_")
    try:
        pages_text, npages = ocrmod.ocr_pdf(src, tmp)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    ne = sum(1 for t in pages_text if t)
    body = "".join(f"\n## 第 {i+1} 页\n\n{t}" for i,t in enumerate(pages_text) if t)
    extra = {"ocr": "macos-vision", "pages": npages, "ocr_pages_with_text": ne}
    note = "> **本文由扫描件经 macOS Vision OCR 抽取，可能有识别误差；关键数值/条款须比对原件。**\n"
    return body, extra, note, ne

def convert_tree(src_root, out_base, archive, depth=0):
    """把解压树里的文本文件转 md 写到 out_base（镜像）。嵌套压缩包递归一层。
    source_path 写成 `<压缩包>::<包内相对路径>`（稳定可溯源，不依赖临时目录）。"""
    conv = skip = scan = 0
    for dp, _, files in os.walk(src_root):
        for fn in files:
            src = os.path.join(dp, fn)
            ext = os.path.splitext(fn)[1].lower()
            rel = os.path.relpath(src, src_root)
            prov = f"{archive}::{rel}"               # 溯源：压缩包 + 包内路径
            if ext in ARCH_EXT and depth < 1:          # 嵌套压缩包：再解一层
                nd = os.path.join(out_base, os.path.splitext(rel)[0] + "__解压")
                tmp = tempfile.mkdtemp(prefix="narc_")
                try:
                    if extract(src, tmp):
                        report["nested"] += 1
                        c,s,sc = convert_tree(tmp, nd, prov, depth+1); conv+=c; skip+=s; scan+=sc
                finally:
                    shutil.rmtree(tmp, ignore_errors=True)
                continue
            if ext in SKIP_EXT or ext in ARCH_EXT or fn.startswith("~$") or fn == ".DS_Store":
                skip += 1; continue
            if ext not in CONV:
                skip += 1; continue
            out_path = os.path.join(out_base, os.path.splitext(rel)[0] + ".md")
            try:
                stype, body, extra = CONV[ext](src)
                note = ""
                if ext == ".pdf" and extra.get("scanned") == "true":
                    # 扫描件：趁临时文件还在，内联 OCR
                    body, extra, note, ne = ocr_inline(src, prov, extra.get("pages",0))
                    if ne > 0: scan += 1
                    else: extra["scanned"] = "true"   # OCR 也没文本 → 仍标扫描件
                if not body or not body.strip(): body = "> （该文件解析后无可抽取文本内容。）"
                title = os.path.splitext(os.path.basename(rel))[0]
                content = ing.fm(prov, stype, **extra) + f"# {title}\n\n> 来源原件（解压自压缩包）：`{prov}`\n{note}" + body + "\n"
                ing.write_md(out_path, content); conv += 1
            except Exception as e:
                report["errors"].append((prov, f"{type(e).__name__}: {e}"))
    return conv, skip, scan

def main():
    archives = sys.argv[1:]
    if not archives:
        d = json.load(open(os.path.join(KN, "_ingest-report.json")))
        archives = [p for p,_ in d["skipped"] if p.lower().endswith((".zip",".rar",".7z"))]
    for a in archives:
        if not os.path.exists(a):
            report["extract_fail"].append((a, "源缺失")); continue
        out_base = dest_for(a)
        if os.path.isdir(out_base) and any(os.scandir(out_base)):
            print(f"· 跳过(已完成) {os.path.basename(a)}", flush=True); continue
        report["archives"] += 1
        tmp = tempfile.mkdtemp(prefix="arc_")
        try:
            if extract(a, tmp):
                c, s, sc = convert_tree(tmp, out_base, a)
                report["converted"] += c; report["skipped"] += s; report["scanned_pdf"] += sc
                report["per_archive"].append((a.replace("/Users/kian/Downloads/",""), c, s, sc))
                print(f"✓ {os.path.basename(a)}: 转{c} 跳{s} 扫描{sc}", flush=True)
            else:
                print(f"✗ 解压失败 {os.path.basename(a)}", flush=True)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)
    json.dump(report, open(os.path.join(KN,"_archive-ingest-report.json"),"w"), ensure_ascii=False, indent=1)
    print(f"\n汇总: 压缩包{report['archives']} 解压失败{len(report['extract_fail'])} 嵌套{report['nested']} | 转md{report['converted']} 跳过{report['skipped']} 扫描件{report['scanned_pdf']} 错误{len(report['errors'])}", flush=True)
    for a,e in report["extract_fail"]: print("  解压失败:", os.path.basename(a), "::", e[:60])

if __name__ == "__main__":
    main()
