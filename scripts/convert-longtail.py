#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""长尾格式转换底座（B8）：用 markitdown 把 EPUB / docx / pptx / html 转成
markdown，落盘约定与 ingest-xiaokai-knowledge.py 一致（frontmatter 溯源头 +
镜像目录结构 + __n 防覆盖 + fail-loud 跳过/错误清单）。

用法：
  python3 convert-longtail.py --out <输出根目录> <源文件或目录> ...
  # 输出根目录一般是某分身的 knowledge/<子目录>

═══════════════ 硬边界（违反会撞溯源红线，禁止"顺手支持"） ═══════════════
1. 不处理 Excel（.xlsx/.xls/.xlsm/.csv）——markitdown 转表格会丢单元格地址、
   合并格、公式，撑不起「文件#sheet」粒度溯源（CLAUDE.md 数据溯源强制条款）。
   Excel 走既有 query_excel / knowledge/_excel 管线，本脚本遇到直接拒绝并登记。
2. 不处理 PDF——markitdown 内置无 OCR，扫描件会静默产出空文；文本型 PDF 也已有
   PyMuPDF 管线（ingest-xiaokai-knowledge.py）。扫描件走既有 Vision OCR 管线
   （scripts/ocr-scanned.py / vision-ocr）。本脚本遇到 .pdf 直接拒绝并登记。
═══════════════════════════════════════════════════════════════════════

markitdown 未安装时打印安装指引后退出（exit 1），不甩 traceback：
  pip3 install 'markitdown[all]' -i https://pypi.tuna.tsinghua.edu.cn/simple
"""
import argparse
import datetime
import json
import os
import sys

HARD_BOUNDARY_HELP = """硬边界（详见脚本头注释）：
  - 不处理 Excel（.xlsx/.xls/.xlsm/.csv）：markitdown 丢单元格地址/合并格/公式，
    撑不起 文件#sheet 溯源红线 → 走既有 query_excel / _excel 管线
  - 不处理 PDF（含扫描件）：markitdown 内置无 OCR → 扫描件走既有 Vision OCR 管线，
    文本型 PDF 走 ingest-xiaokai-knowledge.py 的 PyMuPDF 路径
"""

# 本脚本支持的长尾格式（EPUB 是主要缺口，其余为 markitdown 顺带覆盖）
SUPPORTED_EXT = {".epub", ".docx", ".pptx", ".html", ".htm"}
# 硬拒绝（不是"未支持"，是"禁止走此路"）：ext -> 拒绝原因
REFUSE_EXT = {
    ".xlsx": "Excel 禁走 markitdown（丢单元格地址，违反 文件#sheet 溯源红线）→ 用 query_excel / _excel 管线",
    ".xls":  "Excel 禁走 markitdown（丢单元格地址，违反 文件#sheet 溯源红线）→ 用 query_excel / _excel 管线",
    ".xlsm": "Excel 禁走 markitdown（丢单元格地址，违反 文件#sheet 溯源红线）→ 用 query_excel / _excel 管线",
    ".csv":  "表格数据禁走 markitdown（丢结构溯源）→ 用 query_excel / _excel 管线",
    ".pdf":  "PDF 禁走 markitdown（内置无 OCR，扫描件静默空文）→ 扫描件走 Vision OCR，文本型走 PyMuPDF 管线",
}

stats = {"converted": 0, "skipped": 0, "refused": 0, "errors": 0}
skipped_list = []   # (path, reason) — 未支持类型，静默丢会违反 fail-loud
refused_list = []   # (path, reason) — 硬边界拒绝
error_list = []     # (path, err)
converted_list = [] # (rel_out, source_type)


def load_markitdown():
    """import 守卫：缺包时给清晰安装指引（含镜像源，用户网络慢），不甩 traceback。"""
    try:
        from markitdown import MarkItDown
    except ImportError:
        print("错误：未安装 markitdown。请先安装（国内镜像源）：", file=sys.stderr)
        print("  pip3 install 'markitdown[all]' -i https://pypi.tuna.tsinghua.edu.cn/simple",
              file=sys.stderr)
        sys.exit(1)
    try:
        from importlib.metadata import version
        ver = version("markitdown")
    except Exception:
        ver = "unknown"
    return MarkItDown(enable_plugins=False), ver


def fm(source_path, stype, converted_at, converter_version):
    """frontmatter 溯源头，字段与 ingest-xiaokai-knowledge.py 的 fm() 对齐并补转换器注记。"""
    return "\n".join([
        "---",
        f"source_path: {source_path}",
        f"source_type: {stype}",
        f"ingested: {converted_at[:10]}",
        f"converted_at: {converted_at}",
        f"converter: markitdown {converter_version} (scripts/convert-longtail.py)",
        "---\n",
    ])


def write_md(out_path, content):
    """写盘，已存在则加 __n 后缀防覆盖（与既有摄取脚本一致）。"""
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    base, ext = os.path.splitext(out_path)
    n = 1
    p = out_path
    while os.path.exists(p):
        p = f"{base}__{n}{ext}"
        n += 1
    with open(p, "w", encoding="utf-8") as f:
        f.write(content)
    return p


def convert_one(md_engine, ver, src, rel, out_root):
    ext = os.path.splitext(src)[1].lower()
    now = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    result = md_engine.convert(src)
    body = (result.markdown or "").strip()
    if not body:
        body = "> （该文件经 markitdown 转换后无可抽取文本内容。）"
    title = os.path.splitext(os.path.basename(rel))[0]
    disp = rel  # 溯源用相对路径，不写本机绝对前缀（与既有脚本约定一致）
    content = (
        fm(disp, ext.lstrip("."), now, ver)
        + f"# {title}\n\n> 来源原件：`{disp}`（markitdown {ver} 转换于 {now}）\n\n"
        + body + "\n"
    )
    out_path = os.path.join(out_root, os.path.splitext(rel)[0] + ".md")
    p = write_md(out_path, content)
    stats["converted"] += 1
    converted_list.append((os.path.relpath(p, out_root), ext.lstrip(".")))


def classify(src, rel):
    """返回 'convert' / None（已登记跳过或拒绝）。"""
    fn = os.path.basename(src)
    ext = os.path.splitext(fn)[1].lower()
    if fn.startswith("~$") or fn == ".DS_Store":
        stats["skipped"] += 1
        skipped_list.append((src, "临时/系统文件"))
        return None
    if ext in REFUSE_EXT:
        stats["refused"] += 1
        refused_list.append((src, REFUSE_EXT[ext]))
        return None
    if ext not in SUPPORTED_EXT:
        stats["skipped"] += 1
        skipped_list.append((src, f"未支持类型 {ext or fn}"))
        return None
    return "convert"


def collect(inputs):
    """展开输入（文件/目录）为 (abs_src, rel) 列表，目录内按镜像结构保留相对路径。"""
    jobs = []
    for item in inputs:
        if os.path.isdir(item):
            root = item.rstrip("/")
            for dirpath, _, files in os.walk(root):
                for f in sorted(files):
                    src = os.path.join(dirpath, f)
                    jobs.append((src, os.path.relpath(src, root)))
        elif os.path.isfile(item):
            jobs.append((item, os.path.basename(item)))
        else:
            stats["skipped"] += 1
            skipped_list.append((item, "路径不存在"))
    return jobs


def main():
    ap = argparse.ArgumentParser(
        description="长尾格式转换底座（markitdown）：EPUB / docx / pptx / html → markdown，"
                    "输出遵循 Soul 摄取管线的溯源 frontmatter 约定。",
        epilog=HARD_BOUNDARY_HELP,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument("inputs", nargs="+", help="源文件或目录（目录会递归并镜像结构）")
    ap.add_argument("--out", required=True,
                    help="输出根目录（一般是分身 knowledge/ 下某子目录）")
    args = ap.parse_args()

    md_engine, ver = load_markitdown()
    out_root = os.path.abspath(args.out)

    for src, rel in collect(args.inputs):
        if classify(src, rel) != "convert":
            continue
        try:
            convert_one(md_engine, ver, src, rel, out_root)
        except Exception as e:
            stats["errors"] += 1
            error_list.append((src, f"{type(e).__name__}: {e}"))

    # fail-loud 报告：拒绝/跳过/错误逐条打印，不静默丢
    print(json.dumps(stats, ensure_ascii=False))
    for tag, lst in (("refused", refused_list), ("skipped", skipped_list), ("error", error_list)):
        for pth, reason in lst:
            print(f"[{tag}] {pth} — {reason}")
    for rel_out, stype in converted_list:
        print(f"[converted:{stype}] {rel_out}")
    if stats["errors"]:
        sys.exit(2)


if __name__ == "__main__":
    main()
