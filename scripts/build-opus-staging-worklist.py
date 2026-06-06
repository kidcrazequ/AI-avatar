#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
小凯 opus-staging「精读重写」工作流的待办清单生成器。

背景：
  avatars/小凯-电气工程师/knowledge/<目录>/ 下是脚本机械抽取的 md（已含原文文本，
  含解压/OCR 内容），是「学习」的输入源。
  /Users/kian/Downloads/小凯-opus-staging/<目录>/ 下是 Opus 精读后重写的高质量 md（产出）。
  本脚本 diff 两者，列出「待学」清单，供多 agent 认领分片、跨会话续跑（幂等）。

判定：
  对每个机械 md（排除 _ 前缀的索引/报告文件），计算其在 staging 下的同相对路径 md：
    - staging 已存在        -> done
    - 机械 md 是 stub（需 OCR/无文本层/无法解析）-> skip（正文未入库，无法重写）
    - 否则                  -> pending（待学）

输出：
  <staging>/_worklist.json          —— 完整 manifest（done/pending/skip 明细 + 统计）
  <staging>/_worklist-pending.md     —— 待学清单（按目录/子目录分组，供人/agent 浏览认领）

用法：
  python3 scripts/build-opus-staging-worklist.py
  python3 scripts/build-opus-staging-worklist.py --dir 国标及技术文献   # 只看单个目录
"""
import os
import sys
import json
import datetime

REPO = "/Users/kian/备份/AI/soul"
KN = os.path.join(REPO, "avatars", "小凯-电气工程师", "knowledge")
STAGING = "/Users/kian/Downloads/小凯-opus-staging"
DIRS = ["国标及技术文献", "工作小结", "工商业储能", "超充桩"]
TODAY = datetime.date.today().isoformat()

# stub 判定关键词：机械 md 正文标注「正文未入库」时不可重写
STUB_MARKERS = (
    "需 OCR",
    "文本层为空",
    "无可抽取文本",
    "无法解析",
    "解析后无可抽取",
)
# 仅在 frontmatter / 文件头部检测 stub，避免误判正文里偶然出现的关键词
STUB_SCAN_BYTES = 1200


def is_stub(md_path: str) -> bool:
    """读取机械 md 头部，判断是否为正文未入库的占位 stub。"""
    try:
        with open(md_path, "r", encoding="utf-8", errors="replace") as f:
            head = f.read(STUB_SCAN_BYTES)
    except OSError:
        return False
    return any(m in head for m in STUB_MARKERS)


def scan_dir(top: str):
    """遍历单个 knowledge 子目录，返回 done/pending/skip 三类条目。"""
    src_root = os.path.join(KN, top)
    out_root = os.path.join(STAGING, top)
    done, pending, skip = [], [], []
    if not os.path.isdir(src_root):
        return done, pending, skip
    for dirpath, _, files in os.walk(src_root):
        for fn in files:
            if not fn.endswith(".md") or fn.startswith("_"):
                continue
            src = os.path.join(dirpath, fn)
            rel = os.path.relpath(src, src_root)
            out = os.path.join(out_root, rel)
            entry = {"dir": top, "rel": rel, "input": src, "output": out}
            if os.path.exists(out):
                done.append(entry)
            elif is_stub(src):
                entry["reason"] = "stub: 机械 md 正文未入库（需 OCR/无法解析），无法重写"
                skip.append(entry)
            else:
                pending.append(entry)
    done.sort(key=lambda e: e["rel"])
    pending.sort(key=lambda e: e["rel"])
    skip.sort(key=lambda e: e["rel"])
    return done, pending, skip


def main():
    only = None
    if "--dir" in sys.argv:
        only = sys.argv[sys.argv.index("--dir") + 1]
    dirs = [only] if only else DIRS

    manifest = {"generated": TODAY, "dirs": {}, "totals": {}}
    tot_done = tot_pending = tot_skip = 0
    pending_md = ["# 小凯 opus-staging 待学清单", "",
                  f"> 生成时间：{TODAY}　输入源：knowledge/<目录>/*.md（机械抽取）　产出：小凯-opus-staging/<目录>/*.md",
                  "> 每条「待学」= 需 Opus 精读机械 md 后重写为高质量结构化 md（忠实、标注缺图、不臆测）。", ""]

    for d in dirs:
        done, pending, skip = scan_dir(d)
        manifest["dirs"][d] = {
            "done": len(done),
            "pending": len(pending),
            "skip": len(skip),
            "pending_items": pending,
            "skip_items": skip,
        }
        tot_done += len(done)
        tot_pending += len(pending)
        tot_skip += len(skip)

        pending_md.append(f"## {d}（待学 {len(pending)} / 已学 {len(done)} / 跳过 {len(skip)}）")
        pending_md.append("")
        if pending:
            for e in pending:
                pending_md.append(f"- [ ] {e['rel']}")
        else:
            pending_md.append("> （无待学条目）")
        pending_md.append("")

    manifest["totals"] = {"done": tot_done, "pending": tot_pending, "skip": tot_skip}

    os.makedirs(STAGING, exist_ok=True)
    with open(os.path.join(STAGING, "_worklist.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=1)
    with open(os.path.join(STAGING, "_worklist-pending.md"), "w", encoding="utf-8") as f:
        f.write("\n".join(pending_md) + "\n")

    print(json.dumps({"done": tot_done, "pending": tot_pending, "skip": tot_skip},
                     ensure_ascii=False))
    print("manifest:", os.path.join(STAGING, "_worklist.json"))
    print("pending:", os.path.join(STAGING, "_worklist-pending.md"))


if __name__ == "__main__":
    main()
