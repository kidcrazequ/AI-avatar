#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""从一个 worklist JSON 里筛掉「staging 已存在且非空」的条目，得到剩余待处理清单。

让重摄取按 staging 文件是否存在来驱动，天然幂等：每次 relaunch 只跑真正缺的，
不依赖 workflow 的 resume 缓存（实测缓存会重复已完成文件）。

用法：python3 filter-remaining-worklist.py <worklist.json> [MIN_BYTES=300]
输出：stdout 打印剩余条目的 JSON 数组；统计打到 stderr。
"""
import os
import sys
import json

MIN_BYTES = int(sys.argv[2]) if len(sys.argv) > 2 else 300


def done(staging):
    try:
        return os.path.getsize(staging) >= MIN_BYTES
    except OSError:
        return False


def main():
    items = json.load(open(sys.argv[1], encoding="utf-8"))
    remaining = [it for it in items if not done(it["staging"])]
    print(json.dumps(remaining, ensure_ascii=False))
    sys.stderr.write(f"[remaining] 总 {len(items)}  已完成 {len(items) - len(remaining)}  待处理 {len(remaining)}\n")


if __name__ == "__main__":
    main()
