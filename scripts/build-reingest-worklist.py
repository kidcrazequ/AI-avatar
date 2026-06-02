#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""为 opus 重摄取生成工作清单：遍历某知识库子目录下的 .md，按 frontmatter 分流。

每条 .md 的处理模式：
  - read-original : source_path 是松散(非 zip 内) PDF/图片、文件存在、≤ MAX_MB → opus 读原件重做
  - polish-md     : Word/PPT/txt / zip 内 / 超大 / 原件缺失 → opus 润色现有 .md 文本
  - skip          : Excel(source:excel / excel_json) / 媒体(asr) → 跳过

用法：
  python3 build-reingest-worklist.py <KB子目录绝对路径> <staging根绝对路径> [MAX_MB]
输出：stdout 打印 JSON 数组（喂给 workflow 的 args），并打印分流统计到 stderr。
"""
import os, sys, json, re, collections

KB_ROOT = "/Users/kian/备份/AI/soul/avatars/小凯-电气工程师/knowledge"
MAX_MB = 30

def parse_fm(path):
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            head = f.read(4096)
    except OSError:
        return {}
    if not head.startswith("---\n") and not head.startswith("---\r\n"):
        return {}
    end = head.find("\n---", 3)
    if end < 0:
        return {}
    fm = {}
    for line in head[3:end].splitlines():
        m = re.match(r"^([a-zA-Z_][\w-]*)\s*:\s*(.*)$", line)
        if m:
            fm[m.group(1)] = m.group(2).strip()
    return fm

def classify(fm, src):
    """细分流，目标是让 opus 读到真内容（转换/解压而非润色机械抽取）。"""
    st = (fm.get("source_type") or fm.get("source") or "").lower()
    low = src.lower()
    if st == "excel" or fm.get("excel_json") or fm.get("asr") or st in ("mp4", "mp3", "avi"):
        return "skip"                              # Excel 保结构化 / 媒体走 ASR 二期
    if "::" in src:
        return "unzip-read"                        # zip 内：解压后按内层类型读
    if not src or not os.path.isfile(src):
        return "polish-md"                         # 原件缺失 → 退而润色现有 .md
    try:
        big = os.path.getsize(src) > MAX_MB * 1024 * 1024
    except OSError:
        big = False
    if low.endswith(".pdf"):
        return "pdf-chunk" if big else "pdf-read"  # 超大 PDF 分块读
    if low.endswith((".jpg", ".jpeg", ".png")):
        return "image-read"
    if low.endswith((".docx", ".doc")):
        return "docx-read"                         # pandoc → md → opus
    if low.endswith((".pptx", ".ppt")):
        return "pptx-read"                         # python-pptx → 文本结构 → opus
    if low.endswith((".txt", ".md")):
        return "txt-read"                          # opus 直读
    return "polish-md"

def main():
    kb_sub = os.path.abspath(sys.argv[1])
    staging_root = os.path.abspath(sys.argv[2])
    items, stats = [], collections.Counter()
    for dirpath, dirs, files in os.walk(kb_sub):
        dirs[:] = [d for d in dirs if not d.startswith("_")]  # 跳过 _excel/_raw 等
        for fn in files:
            if not fn.endswith(".md"):
                continue
            md = os.path.join(dirpath, fn)
            fm = parse_fm(md)
            src = fm.get("source_path", "")
            mode = classify(fm, src)
            stats[mode] += 1
            if mode == "skip":
                continue
            rel = os.path.relpath(md, KB_ROOT)
            items.append({
                "md": md,
                "src": src,
                "srcType": (fm.get("source_type") or fm.get("source") or ""),
                "mode": mode,
                "staging": os.path.join(staging_root, rel),
            })
    print(json.dumps(items, ensure_ascii=False))
    sys.stderr.write(f"[worklist] {kb_sub}  待处理={len(items)}\n  "
                     + "  ".join(f"{m}={n}" for m, n in stats.most_common()) + "\n")

if __name__ == "__main__":
    main()
