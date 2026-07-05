#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""validate-skills.py — 三级技能体系统一校验器（B3）：只读扫描
avatars/<id>/skills/、shared/skills/、shared/skills/community/、
expert-packs/<id>/skills/，按 error / warn / info 分级输出。

校验项：
  [error] skill-index.yaml 引用的技能文件不存在 / 缺 path 字段 / index 解析失败
  [error] 技能文件（或目录）名与 frontmatter name 不一致
  [warn]  技能名不是 kebab-case（小写 + 连字符）
  [warn]  缺 frontmatter 或缺 name 字段
  [warn]  description 缺失 / 过短（< MIN_DESC_LEN）/ 不含触发短语（"当…时" / "Use when" 类）
  [warn]  技能文件存在但未被 index 收录
  [warn]  category 在受控词表之外（非阻塞）
  [info]  同名技能跨层覆写（优先级 local > shared > community）

退出码：error 数 > 0 → 1，否则 0（warn / info 不阻塞）。

用法：
  python3 scripts/validate-skills.py                 # 全量只读校验
  python3 scripts/validate-skills.py --emit-index avatars/foo/skills
      # 从该目录技能文件的 frontmatter 生成 index，打到 stdout 供人工对比

═══════════════ 硬边界（违反会踩坏用户 WIP，禁止"顺手修"） ═══════════════
1. 纯只读：本脚本绝不写入 / 改写任何 skill-index.yaml 或技能文件。
   --emit-index 只打 stdout，不落盘。仓库里多个 skill-index.yaml 存在
   用户未提交的手工改动，任何自动改写都可能吃掉 WIP。
2. 零外部依赖：只用 Python 标准库；内置一个受限 YAML 子集解析器
   （本仓库 skill-index / frontmatter 实际用到的子集），解析不了的写法
   按 error fail-loud 报出来，绝不静默猜测。
═══════════════════════════════════════════════════════════════════════
"""
import argparse
import json
import os
import re
import sys

SOUL_ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

MIN_DESC_LEN = 30
RE_KEBAB = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")
RE_TRIGGER = re.compile(
    r"(当.{0,60}(时|后)|当用户|use\s+when|use\s+this\s+skill|must\s+use\s+when|适用|触发)",
    re.IGNORECASE)

# category 受控词表（B3：词表外仅 warn 不阻塞；当前仓库尚无 category 字段，
# 引入该字段时在此扩展）
CONTROLLED_CATEGORIES = {
    "检索", "互联网检索", "知识问答", "数据可视化", "可视化", "导出",
    "决策回溯", "文档", "设计", "质检", "沟通", "工程",
}


# ═══════════════════════════════════════
# 受限 YAML 子集解析器（fail-loud）
# ═══════════════════════════════════════
class YamlError(Exception):
    pass


RE_KEY = re.compile(r"^([A-Za-z_][A-Za-z0-9_-]*):(?:\s+(.*))?$")


def _scalar(raw):
    v = raw.strip()
    if v.startswith('"') and v.endswith('"') and len(v) >= 2:
        try:
            return json.loads(v)
        except ValueError:
            return v[1:-1]
    if v.startswith("'") and v.endswith("'") and len(v) >= 2:
        return v[1:-1].replace("''", "'")
    return v


class MiniYaml:
    """针对本仓库 skill-index / frontmatter 实际写法的受限 YAML 子集：
    嵌套 map / list、`- key: value` 内联首键、`[]`/`{}` 空集合、
    单双引号标量、`>` `>-` `|` `|-` 块标量、全行注释。
    超出子集 → YamlError（带 文件:行号），fail-loud。"""

    def __init__(self, text, filename):
        self.lines = text.splitlines()
        self.filename = filename
        self.pos = 0

    def err(self, msg, lineno=None):
        ln = (lineno if lineno is not None else self.pos + 1)
        raise YamlError(f"{self.filename}:{ln}: {msg}")

    def _skip(self):
        while self.pos < len(self.lines):
            s = self.lines[self.pos].strip()
            if s == "" or s.startswith("#"):
                self.pos += 1
            else:
                return

    def _indent(self):
        line = self.lines[self.pos]
        if "\t" in line[: len(line) - len(line.lstrip())]:
            self.err("缩进含 TAB，超出支持子集")
        return len(line) - len(line.lstrip(" "))

    def parse(self):
        val = self.parse_block(0)
        self._skip()
        if self.pos < len(self.lines):
            self.err(f"存在无法归属的行: {self.lines[self.pos].strip()!r}")
        return val

    def parse_block(self, min_indent):
        self._skip()
        if self.pos >= len(self.lines) or self._indent() < min_indent:
            return None
        ind = self._indent()
        s = self.lines[self.pos].strip()
        if s == "-" or s.startswith("- "):
            return self.parse_list(ind)
        return self.parse_map(ind)

    def parse_map(self, ind):
        out = {}
        while True:
            self._skip()
            if self.pos >= len(self.lines) or self._indent() < ind:
                return out
            if self._indent() > ind:
                self.err("缩进异常（比所在 map 更深且无所属 key）")
            s = self.lines[self.pos].strip()
            m = RE_KEY.match(s)
            if not m:
                self.err(f"期望 'key: value'，得到 {s!r}")
            key, rest = m.group(1), (m.group(2) or "").strip()
            self.pos += 1
            if rest == "":
                out[key] = self.parse_block(ind + 1)
            elif rest == "[]":
                out[key] = []
            elif rest == "{}":
                out[key] = {}
            elif rest[0] in ">|":
                out[key] = self.parse_block_scalar(ind, rest)
            else:
                out[key] = _scalar(rest)

    def parse_list(self, ind):
        out = []
        while True:
            self._skip()
            if self.pos >= len(self.lines) or self._indent() != ind:
                if self.pos < len(self.lines) and ind < self._indent():
                    self.err("列表项后出现缩进异常行")
                return out
            s = self.lines[self.pos].strip()
            if not (s == "-" or s.startswith("- ")):
                return out
            content = s[1:].strip()
            if content == "":
                self.pos += 1
                out.append(self.parse_block(ind + 1))
            elif RE_KEY.match(content):
                # `- key: value` 内联首键：把 '- ' 改写为两个空格后按 map 解析
                self.lines[self.pos] = " " * (ind + 2) + content
                out.append(self.parse_map(ind + 2))
            else:
                self.pos += 1
                out.append(_scalar(content))

    def parse_block_scalar(self, key_indent, header):
        style = header[0]  # '>' 折叠 / '|' 保留换行
        collected = []
        content_indent = None
        while self.pos < len(self.lines):
            raw = self.lines[self.pos]
            if raw.strip() == "":
                collected.append("")
                self.pos += 1
                continue
            cur = len(raw) - len(raw.lstrip(" "))
            if cur <= key_indent:
                break
            if content_indent is None:
                content_indent = cur
            collected.append(raw[content_indent:])
            self.pos += 1
        while collected and collected[-1] == "":
            collected.pop()
        joiner = " " if style == ">" else "\n"
        return joiner.join(x for x in collected if x != "") if style == ">" \
            else "\n".join(collected)


def parse_yaml_file(path):
    with open(path, "r", encoding="utf-8") as f:
        return MiniYaml(f.read(), os.path.relpath(path, SOUL_ROOT)).parse()


def read_frontmatter(path):
    """返回 (dict 或 None, 错误信息或 None)。"""
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        text = f.read()
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        return None, "no-frontmatter"
    for i in range(1, len(lines)):
        if lines[i].strip() in ("---", "..."):
            body = "\n".join(lines[1:i])
            try:
                data = MiniYaml(body, os.path.relpath(path, SOUL_ROOT) + "#frontmatter").parse()
            except YamlError as e:
                return None, f"frontmatter 解析失败: {e}"
            if not isinstance(data, dict):
                return None, "frontmatter 不是 map"
            return data, None
    return None, "frontmatter 未闭合（缺第二个 ---）"


# ═══════════════════════════════════════
# 扫描三级技能体系
# ═══════════════════════════════════════
class Reporter:
    def __init__(self):
        self.errors, self.warns, self.infos = [], [], []

    def error(self, where, msg):
        self.errors.append((where, msg))

    def warn(self, where, msg):
        self.warns.append((where, msg))

    def info(self, where, msg):
        self.infos.append((where, msg))

    def dump(self):
        for tag, items in (("ERROR", self.errors), ("WARN", self.warns), ("INFO", self.infos)):
            for where, msg in items:
                print(f"[{tag}] {where} — {msg}")
        print()
        print(f"统计: {len(self.errors)} error / {len(self.warns)} warn / {len(self.infos)} info")


def rel(p):
    return os.path.relpath(p, SOUL_ROOT)


def list_md(d):
    if not os.path.isdir(d):
        return []
    return sorted(
        os.path.join(d, n) for n in os.listdir(d)
        if n.lower().endswith(".md") and os.path.isfile(os.path.join(d, n)))


def collect_scopes():
    """返回 scope 列表：{tier, owner, scope_root, skills_dir, index, files}。"""
    scopes = []
    shared_dir = os.path.join(SOUL_ROOT, "shared", "skills")
    scopes.append({
        "tier": "shared", "owner": "shared", "scope_root": SOUL_ROOT,
        "skills_dir": shared_dir,
        "index": os.path.join(shared_dir, "skill-index.yaml"),
        "files": list_md(shared_dir),
    })
    community = os.path.join(shared_dir, "community")
    if os.path.isdir(community):
        for pkg in sorted(os.listdir(community)):
            pdir = os.path.join(community, pkg)
            sdir = os.path.join(pdir, "skills")
            if os.path.isdir(sdir):
                scopes.append({
                    "tier": "community", "owner": f"community/{pkg}",
                    "scope_root": SOUL_ROOT, "skills_dir": sdir,
                    "index": None, "files": list_md(sdir),
                })
    for base in ("avatars", "expert-packs"):
        bdir = os.path.join(SOUL_ROOT, base)
        if not os.path.isdir(bdir):
            continue
        for name in sorted(os.listdir(bdir)):
            root = os.path.join(bdir, name)
            sdir = os.path.join(root, "skills")
            if not os.path.isdir(sdir):
                continue
            idx = os.path.join(sdir, "skill-index.yaml")
            scopes.append({
                "tier": "local", "owner": f"{base}/{name}", "scope_root": root,
                "skills_dir": sdir,
                "index": idx if os.path.isfile(idx) else None,
                "files": list_md(sdir),
            })
    return scopes


def parse_index_entries(index_path, scope, rep):
    """解析一个 skill-index.yaml，返回条目列表；解析失败记 error 返回 []。"""
    try:
        data = parse_yaml_file(index_path)
    except (YamlError, OSError) as e:
        rep.error(rel(index_path), f"skill-index 解析失败（fail-loud，不猜测）: {e}")
        return []
    if not isinstance(data, dict):
        rep.error(rel(index_path), "skill-index 顶层不是 map")
        return []
    entries = []
    for section, val in data.items():
        if not isinstance(val, list):
            continue
        for item in val:
            if isinstance(item, dict) and "name" in item:
                entries.append({
                    "section": section, "name": item.get("name"),
                    "path": item.get("path"), "category": item.get("category"),
                    "index": index_path, "scope": scope,
                })
    return entries


def resolve_entry_path(entry):
    """返回解析成功的绝对路径，找不到返回 None。"""
    p = entry["path"]
    if not p:
        return None
    cands = [
        os.path.join(SOUL_ROOT, p),                      # 仓库根相对（shared/community 风格）
        os.path.join(entry["scope"]["scope_root"], p),   # 分身/专家包根相对（local 风格）
        os.path.join(os.path.dirname(entry["index"]), p),  # 兜底：相对 index 所在目录
    ]
    for c in cands:
        if os.path.isfile(c):
            return os.path.realpath(c)
    return None


def check_skill_file(path, rep):
    """单个技能文件的 frontmatter 校验；返回 frontmatter name（可能为 None）。"""
    where = rel(path)
    fm, err = read_frontmatter(path)
    stem = os.path.splitext(os.path.basename(path))[0]
    expected = os.path.basename(os.path.dirname(path)) if stem.upper() == "SKILL" else stem

    if fm is None:
        if err == "no-frontmatter":
            rep.warn(where, "缺 YAML frontmatter（无 name/description，无法被路由）")
        else:
            rep.warn(where, err)
        return None

    name = fm.get("name")
    if not name or not isinstance(name, str):
        rep.warn(where, "frontmatter 缺 name 字段")
    else:
        if name != expected:
            rep.error(where, f"frontmatter name ({name!r}) 与文件/目录名 ({expected!r}) 不一致")
        if not RE_KEBAB.match(name):
            rep.warn(where, f"name {name!r} 不是 kebab-case（小写字母/数字 + 连字符）")

    desc = fm.get("description")
    if not desc or not isinstance(desc, str):
        rep.warn(where, "frontmatter 缺 description")
    else:
        if len(desc) < MIN_DESC_LEN:
            rep.warn(where, f"description 过短（{len(desc)} < {MIN_DESC_LEN} 字符）")
        if not RE_TRIGGER.search(desc):
            rep.warn(where, "description 不含触发短语（如「当…时」/「Use when」），弱模型易漏触发")

    cat = fm.get("category")
    if cat and cat not in CONTROLLED_CATEGORIES:
        rep.warn(where, f"category {cat!r} 不在受控词表内（非阻塞）")

    return name if isinstance(name, str) else None


def cmd_validate():
    rep = Reporter()
    scopes = collect_scopes()

    # 1) 技能文件自检 + 收集 name → 层级
    name_tiers = {}  # name -> list[(tier, owner, relpath)]
    for sc in scopes:
        for f in sc["files"]:
            name = check_skill_file(f, rep)
            key = name or os.path.splitext(os.path.basename(f))[0]
            name_tiers.setdefault(key, []).append((sc["tier"], sc["owner"], rel(f)))

    # 2) index 校验
    all_entries = []
    referenced_global = set()          # 所有 index 解析成功的目标绝对路径
    referenced_by_index = {}           # index path -> set(目标绝对路径)
    for sc in scopes:
        if not sc["index"]:
            if sc["tier"] == "local" and sc["files"]:
                rep.info(f"{sc['owner']}/skills", "无 skill-index.yaml，跳过收录检查")
            continue
        entries = parse_index_entries(sc["index"], sc, rep)
        all_entries.extend(entries)
        refset = referenced_by_index.setdefault(sc["index"], set())
        for e in entries:
            where = f"{rel(sc['index'])} [{e['section']}] {e['name']}"
            if not e["path"]:
                rep.error(where, "缺 path 字段")
                continue
            resolved = resolve_entry_path(e)
            if resolved is None:
                rep.error(where, f"引用的技能文件不存在: {e['path']}")
            else:
                refset.add(resolved)
                referenced_global.add(resolved)
            cat = e.get("category")
            if cat and cat not in CONTROLLED_CATEGORIES:
                rep.warn(where, f"category {cat!r} 不在受控词表内（非阻塞）")

    # 3) 技能文件存在但 index 未收录（warn）
    for sc in scopes:
        for f in sc["files"]:
            realf = os.path.realpath(f)
            if sc["tier"] == "community":
                if realf not in referenced_global:
                    rep.warn(rel(f), "社区技能未被任何 skill-index.yaml 收录")
            elif sc["index"]:
                if realf not in referenced_by_index.get(sc["index"], set()):
                    rep.warn(rel(f), f"未被 {rel(sc['index'])} 收录")

    # 4) 同名跨层覆写（info）
    tier_rank = {"local": 0, "shared": 1, "community": 2}
    for name, places in sorted(name_tiers.items()):
        tiers = {t for t, _, _ in places}
        if len(tiers) > 1:
            ordered = sorted(places, key=lambda x: (tier_rank[x[0]], x[1]))
            chain = "  >  ".join(f"{t}:{owner} ({p})" for t, owner, p in ordered)
            rep.info(f"skill:{name}", f"跨层同名覆写（生效优先级 local > shared > community）: {chain}")

    rep.dump()
    sys.exit(1 if rep.errors else 0)


def cmd_emit_index(target_dir):
    """从目录内技能文件的 frontmatter 生成 index，打到 stdout（绝不落盘）。"""
    d = os.path.abspath(target_dir)
    if not os.path.isdir(d):
        print(f"[ERROR] 目录不存在: {target_dir}", file=sys.stderr)
        sys.exit(1)
    items, skipped = [], []
    for dirpath, _, names in os.walk(d):
        for n in sorted(names):
            if not n.lower().endswith(".md"):
                continue
            p = os.path.join(dirpath, n)
            fm, err = read_frontmatter(p)
            if fm is None or not fm.get("name"):
                skipped.append((rel(p), err or "缺 name"))
                continue
            try:
                shown = rel(p)
                if shown.startswith(".."):
                    shown = p
            except ValueError:
                shown = p
            items.append((fm["name"], shown, fm.get("description", "")))
    print("# 由 validate-skills.py --emit-index 生成（stdout-only，仅供人工对比；本脚本绝不写 index 文件）")
    print("skills:")
    for name, path, desc in sorted(items):
        print(f"  - name: {name}")
        print(f"    path: {path}")
        if desc:
            print(f"    description: {json.dumps(desc, ensure_ascii=False)}")
    for p, why in skipped:
        print(f"# [跳过] {p} — {why}")


def main():
    ap = argparse.ArgumentParser(
        description="三级技能体系统一校验器（只读；error>0 时 exit 1）",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="硬边界：纯只读，绝不改写任何 skill-index.yaml；--emit-index 只打 stdout。")
    ap.add_argument("--emit-index", metavar="DIR",
                    help="从 DIR 下技能文件 frontmatter 生成 index 打到 stdout（不落盘）")
    args = ap.parse_args()
    if args.emit_index:
        cmd_emit_index(args.emit_index)
    else:
        cmd_validate()


if __name__ == "__main__":
    main()
