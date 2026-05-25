#!/usr/bin/env bash
# @author zhi.qu
# @date 2026-05-25
#
# check-soul-rules.sh — Soul 分身（expert-packs/）结构与必备小节 lint
#
# 单职责：扫描所有 expert-packs/*/，对每个分身检查
#   1) 必备文件存在（CLAUDE.md / soul.md / knowledge/README.md / expert-pack.json）
#   2) soul.md 必备小节（Identity 段 + Principles/红线段）
#   3) CLAUDE.md 必备小节（知识库约束 / 知识与服务边界 / 调度员铁律 / 数据源 之一）
#
# 用法：
#   ./scripts/check-soul-rules.sh            # 扫描所有分身
#   ./scripts/check-soul-rules.sh --json     # JSON 输出（便于 CI 集成）
#   ./scripts/check-soul-rules.sh <pack>     # 只检查指定包，如：小堵-工商储专家
#
# 退出码：
#   0 = 全部通过（或仅有 warning）
#   1 = 至少一个分身有 error

set -euo pipefail

SOUL_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PACKS_DIR="$SOUL_ROOT/expert-packs"

# 透传参数给 Python：剥离 bash 看到的标志后由 Python 解析。
exec python3 - "$PACKS_DIR" "$@" << 'PYEOF'
from __future__ import annotations  # Python 3.9 兼容（scripts/soul-sync.sh 也跑在 3.9）
import json
import re
import sys
from pathlib import Path
from typing import Optional, Tuple, List, Dict

PACKS_DIR = Path(sys.argv[1])
args = sys.argv[2:]
json_mode = "--json" in args
selected = [a for a in args if not a.startswith("--")]

# ANSI 颜色（json 模式下禁用）
def color(code, s):
    if json_mode or not sys.stdout.isatty():
        return s
    return f"\033[{code}m{s}\033[0m"

GREEN = lambda s: color("0;32", s)
RED = lambda s: color("0;31", s)
YELLOW = lambda s: color("0;33", s)
BLUE = lambda s: color("0;34", s)
DIM = lambda s: color("2", s)


# ─────────────────────────────────────────────────────────
# Rule 定义（declarative）。新增规则只改本节，不动主循环。
# ─────────────────────────────────────────────────────────
# 每条 rule 三类之一：
#   - file_exists：检查 path 相对 pack 根存在
#   - heading_any：在 file 里至少匹配 patterns 中的一个 ## / ### heading
#   - heading_all：file 里必须匹配 patterns 中的**每一个**
RULES = [
    # ── Tier 1：硬性文件 ──
    {"kind": "file_exists", "path": "CLAUDE.md", "level": "error",
     "desc": "CLAUDE.md 必存（写给 LLM 的操作规则）"},
    {"kind": "file_exists", "path": "soul.md", "level": "error",
     "desc": "soul.md 必存（人格定义）"},
    {"kind": "file_exists", "path": "expert-pack.json", "level": "error",
     "desc": "expert-pack.json 必存（pack 元数据）"},
    {"kind": "file_exists", "path": "knowledge/README.md", "level": "warn",
     "desc": "knowledge/README.md 推荐存在（知识库索引）"},
    {"kind": "file_exists", "path": "skills", "level": "warn",
     "desc": "skills/ 目录推荐存在（即便为空，也作为约定）"},

    # ── Tier 2：soul.md 必备小节 ──
    {"kind": "heading_any", "file": "soul.md",
     "patterns": [r"Identity", r"我是谁", r"核心声明"],
     "level": "error",
     "desc": "soul.md 必须有 Identity / 我是谁 / 核心声明 小节（人格起源）"},
    {"kind": "heading_any", "file": "soul.md",
     "patterns": [r"Principles", r"原则", r"红线", r"铁律"],
     "level": "error",
     "desc": "soul.md 必须有 Principles / 原则 / 红线 / 铁律 小节"},

    # ── Tier 3：CLAUDE.md 必备小节 ──
    # 不同分身命名差异大（"知识约束"/"知识与服务边界"/"压倒性前缀"/"调度员铁律"/"数据源"），
    # 全部归为"必须有约束类章节"一条规则。完全没有此类章节 = 给 LLM 的指令不完整。
    {"kind": "heading_any", "file": "CLAUDE.md",
     "patterns": [
        r"知识.*约束", r"知识库", r"知识与服务", r"压倒性前缀",
        r"调度员铁律", r"最高准则", r"数据源", r"约束",
     ],
     "level": "error",
     "desc": "CLAUDE.md 必须有约束类章节（知识库 / 数据源 / 铁律 / 最高准则 之一）"},

    # ── Tier 4：人格小节存在性（缺则黄牌）──
    {"kind": "heading_any", "file": "soul.md",
     "patterns": [r"人格", r"Identity"],
     "level": "warn",
     "desc": "soul.md 推荐有「人格」小节（给 LLM 角色钉锚）"},
]


# ─────────────────────────────────────────────────────────
# 规则执行
# ─────────────────────────────────────────────────────────
HEADING_RE = re.compile(r"^#{2,4}\s+(.+)$", re.MULTILINE)


def evaluate_rule(pack_dir: Path, rule: dict) -> tuple[bool, str | None]:
    """返回 (pass, evidence)。evidence 在 fail 时给一条更详细的诊断。"""
    kind = rule["kind"]
    if kind == "file_exists":
        target = pack_dir / rule["path"]
        if target.exists():
            return True, None
        return False, f"缺失路径：{rule['path']}"

    if kind in ("heading_any", "heading_all"):
        target = pack_dir / rule["file"]
        if not target.exists():
            return False, f"前提缺失：{rule['file']} 不存在"
        try:
            content = target.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            return False, f"{rule['file']} 不是合法 UTF-8"
        headings = [m.group(1).strip() for m in HEADING_RE.finditer(content)]
        patterns = [re.compile(p) for p in rule["patterns"]]
        matches = [pat.pattern for pat in patterns if any(pat.search(h) for h in headings)]
        if kind == "heading_any":
            if matches:
                return True, None
            return False, (
                f"{rule['file']} 中 0/{len(patterns)} 个候选 heading 命中。"
                f" 现有 heading 数：{len(headings)}（前 5：{headings[:5]}）"
            )
        # heading_all
        missing = [pat.pattern for pat in patterns if not any(pat.search(h) for h in headings)]
        if not missing:
            return True, None
        return False, f"{rule['file']} 缺 heading：{missing}"

    return False, f"未知 rule kind: {kind}"


def check_pack(pack_dir: Path) -> list[dict]:
    """对单个 pack 跑所有规则，返回结果列表。"""
    results = []
    for rule in RULES:
        ok, evidence = evaluate_rule(pack_dir, rule)
        results.append({
            "level": rule["level"],
            "desc": rule["desc"],
            "passed": ok,
            "evidence": evidence,
        })
    return results


# ─────────────────────────────────────────────────────────
# 主流程
# ─────────────────────────────────────────────────────────
if not PACKS_DIR.exists():
    print(RED(f"[ERROR] expert-packs 目录不存在：{PACKS_DIR}"))
    sys.exit(2)

packs = sorted([p for p in PACKS_DIR.iterdir() if p.is_dir()])
if selected:
    packs = [p for p in packs if p.name in selected]
    if not packs:
        print(RED(f"[ERROR] 找不到指定 pack：{selected}"))
        sys.exit(2)

report = []  # for --json
total_errors = 0
total_warnings = 0
ok_packs = 0

for pack in packs:
    results = check_pack(pack)
    pack_errors = sum(1 for r in results if not r["passed"] and r["level"] == "error")
    pack_warnings = sum(1 for r in results if not r["passed"] and r["level"] == "warn")
    if pack_errors == 0:
        ok_packs += 1
    total_errors += pack_errors
    total_warnings += pack_warnings

    if not json_mode:
        status = GREEN("OK") if pack_errors == 0 else RED("FAIL")
        warn_tag = YELLOW(f" · {pack_warnings} warn") if pack_warnings else ""
        print(f"\n═══ {BLUE(pack.name)} · {status}{warn_tag} ═══")
        for r in results:
            if r["passed"]:
                print(f"  {GREEN('✓')} {r['desc']}")
            else:
                mark = RED("✗") if r["level"] == "error" else YELLOW("!")
                print(f"  {mark} {r['desc']}")
                if r["evidence"]:
                    print(f"      {DIM(r['evidence'])}")

    report.append({
        "pack": pack.name,
        "errors": pack_errors,
        "warnings": pack_warnings,
        "results": results,
    })

if json_mode:
    print(json.dumps({
        "total_packs": len(packs),
        "ok_packs": ok_packs,
        "total_errors": total_errors,
        "total_warnings": total_warnings,
        "report": report,
    }, ensure_ascii=False, indent=2))
else:
    print()
    summary_color = GREEN if total_errors == 0 else RED
    print(summary_color(
        f"Summary: {len(packs)} packs · {ok_packs} OK · "
        f"{total_errors} errors · {total_warnings} warnings"
    ))

sys.exit(1 if total_errors > 0 else 0)
PYEOF
