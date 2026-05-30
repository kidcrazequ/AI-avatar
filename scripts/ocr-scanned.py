#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""对 knowledge/ 下所有 scanned:true 的占位 md 做 OCR 补全（macOS Vision）。
渲染页→Vision OCR→回写 md；按源文件 sha1 去重，重复件复用结果。可重复运行（已 OCR 的跳过）。"""
import os, re, sys, subprocess, tempfile, hashlib, shutil, time

KN = "/Users/kian/备份/AI/soul/avatars/小凯-电气工程师/knowledge"
VISION = "/Users/kian/备份/AI/soul/scripts/vision-ocr"
DPI = 220
BATCH = 8          # 每批渲染+OCR 的页数（限制临时磁盘占用）
TODAY = "2026-05-30"

def find_scanned():
    out = []
    for dp, _, fs in os.walk(KN):
        for f in fs:
            if not f.endswith(".md"): continue
            p = os.path.join(dp, f)
            head = open(p, encoding="utf-8").read(500)
            if "scanned: true" in head:
                m = re.search(r'source_path:\s*(.+)', head)
                src = m.group(1).strip() if m else None
                out.append((p, src))
    return out

def sha1(path):
    h = hashlib.sha1()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1<<20), b""): h.update(chunk)
    return h.hexdigest()

def ocr_pdf(src, tmpdir):
    """逐批渲染+OCR，返回 (页文本列表, 总页数)。"""
    import fitz
    doc = fitz.open(src)
    npages = doc.page_count
    mat = fitz.Matrix(DPI/72, DPI/72)
    pages_text = []
    i = 0
    while i < npages:
        batch = list(range(i, min(i+BATCH, npages)))
        imgs = []
        for pi in batch:
            img = os.path.join(tmpdir, f"p{pi}.png")
            try:
                doc[pi].get_pixmap(matrix=mat).save(img)
                imgs.append(img)
            except Exception:
                imgs.append(None)
        valid = [x for x in imgs if x]
        texts = {}
        if valid:
            try:
                r = subprocess.run([VISION]+valid, capture_output=True, text=True, timeout=300)
                chunks = r.stdout.split("<<<PAGE_BREAK>>>\n")
                for img, txt in zip(valid, chunks):
                    texts[img] = txt.rstrip()
            except Exception as e:
                for img in valid: texts[img] = ""
        for pi, img in zip(batch, imgs):
            pages_text.append(texts.get(img, "").strip() if img else "")
        for img in valid:
            try: os.remove(img)
            except Exception: pass
        i += BATCH
    doc.close()
    return pages_text, npages

def build_md(src, pages_text, npages):
    title = os.path.splitext(os.path.basename(src))[0]
    nonempty = sum(1 for t in pages_text if t)
    body = []
    for idx, t in enumerate(pages_text):
        if t: body.append(f"\n## 第 {idx+1} 页\n\n{t}")
    fm = ["---", f"source_path: {src}", "source_type: pdf",
          f"ingested: {TODAY}", "ocr: macos-vision",
          f"pages: {npages}", f"ocr_pages_with_text: {nonempty}", "---", ""]
    head = f"# {title}\n\n> 来源原件：`{src}`\n> **本文由扫描件经 macOS Vision OCR 抽取，可能有识别误差；关键数值/条款须比对原件。**\n"
    return "\n".join(fm) + head + "\n".join(body) + "\n"

def main():
    items = find_scanned()
    if len(sys.argv) > 1:
        items = items[:int(sys.argv[1])]
    print(f"待 OCR 扫描件: {len(items)}", flush=True)
    cache = {}   # sha1 -> (pages_text, npages)
    done = ok = empty = err = 0
    t0 = time.time()
    for mdpath, src in items:
        done += 1
        if not src or not os.path.exists(src):
            err += 1; print(f"[{done}/{len(items)}] 源缺失: {src}", flush=True); continue
        try:
            key = sha1(src)
            if key in cache:
                pages_text, npages = cache[key]
                tag = "(复用)"
            else:
                tmpdir = tempfile.mkdtemp(prefix="ocr_")
                try:
                    pages_text, npages = ocr_pdf(src, tmpdir)
                finally:
                    shutil.rmtree(tmpdir, ignore_errors=True)
                cache[key] = (pages_text, npages)
                tag = ""
            content = build_md(src, pages_text, npages)
            open(mdpath, "w", encoding="utf-8").write(content)
            ne = sum(1 for t in pages_text if t)
            if ne == 0: empty += 1
            else: ok += 1
            if done % 5 == 0 or tag:
                el = time.time()-t0
                print(f"[{done}/{len(items)}] {tag} {npages}页 OCR文本页{ne} | 累计ok{ok}/空{empty}/err{err} | {el:.0f}s", flush=True)
        except Exception as e:
            err += 1; print(f"[{done}/{len(items)}] ERR {type(e).__name__}: {e} :: {os.path.basename(src)}", flush=True)
    print(f"完成: ok(含文本){ok} 空{empty} err{err} | 用时 {time.time()-t0:.0f}s", flush=True)

if __name__ == "__main__":
    main()
