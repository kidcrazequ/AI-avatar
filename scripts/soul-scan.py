#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""soul-scan.py — 社区技能安装门禁（A2）：Unicode 隐藏字符硬拦截 + 四类
prompt-injection 静态 pattern 扫描 + baseline 指纹抑制 + install-lock 写入。

被 scripts/soul-sync.sh 在「clone 之后、cp 进 community/ 之前」调用；也可手动
对任意技能目录/文件跑扫描。人类可读报告走 stderr，机器可读 JSON 摘要走 stdout
（scan 模式单行 JSON，供 soul-sync.sh 取 risk_score）。

用法：
  soul-scan.py scan [--root DIR] [--baseline FILE] [--source-name NAME] [--force] 路径...
  soul-scan.py accept-baseline --reason "为什么接受" [--root DIR] [--baseline FILE] 路径...
  soul-scan.py write-lock --lock FILE --name 源名 --repo URL --ref REF --commit SHA --score N

退出码：
  0 = 放行（含 --force 强制通过的中风险）
  1 = 用法 / IO / 格式错误
  2 = 中风险：risk_score ∈ [WARN, REJECT)，需 --force 才放行
  3 = 高风险：risk_score ≥ REJECT，拒装，--force 无效
  4 = Unicode 隐藏字符命中：硬拦截，--force 无效、不可 baseline

═══════════════ 硬边界（安全要求，禁止"顺手放宽"） ═══════════════
1. Unicode 类 finding（零宽 U+200B/200C/200D/FEFF、bidi U+202A-202E/
   U+2066-2069（Trojan Source）、Tag 块 U+E0000-E007F（ASCII smuggling））
   永不进 baseline、不接受 --force——技能 md 里无合法理由出现，命中即拒。
2. accept-baseline 必须带非空 --reason，否则拒绝写入。
3. 高风险（risk_score ≥ REJECT_THRESHOLD）不接受 --force。
4. 零外部依赖：只用 Python 标准库。baseline / lock 均为本脚本自有的
   受限 YAML 子集（本脚本既是唯一写入方也是唯一读取方），不要手工编辑。
═══════════════════════════════════════════════════════════════════
"""
import argparse
import datetime
import hashlib
import json
import os
import re
import sys
import unicodedata

# ═══ 阈值与评分 ═══
# 单条 finding 计 weight 分；同一 pattern id 最多计 2 次（防止同类弱信号在
# 合法技能里大量重复出现时把总分刷上拒装线——真实攻击通常跨类别组合）。
WARN_THRESHOLD = 4     # ≥ 此分：中风险，需 --force
REJECT_THRESHOLD = 10  # ≥ 此分：高风险，拒装，--force 无效
PER_PATTERN_CAP = 2    # 每个 pattern id 最多计分次数

# ═══ Unicode 隐藏字符（硬拦截，逐行扫描） ═══
RE_UNICODE_HIDDEN = re.compile(
    "["
    "\u200b\u200c\u200d\ufeff"  # 零宽字符 U+200B/200C/200D + BOM U+FEFF
    "\u202a-\u202e"               # bidi 嵌入/覆盖（Trojan Source）
    "\u2066-\u2069"               # bidi 隔离
    "\U000e0000-\U000e007f"       # Unicode Tag 块（ASCII smuggling）
    "]"
)

# ═══ 四类静态 pattern（纯标准库 regex，按行匹配；multiline=False） ═══
# 每项: (pattern_id, weight, 说明, 编译后的 regex)
PATTERNS = [
    # ── 1. 指令覆盖 ──
    ("override/en", 5, "英文指令覆盖（ignore previous instructions 类）",
     re.compile(r"(?i)\b(ignore|disregard|forget|override|bypass)\b[^\n]{0,40}"
                r"\b(previous|prior|above|earlier|system|initial|original)\b[^\n]{0,40}"
                r"\b(instructions?|prompts?|rules?|messages?|directives?|context|constraints?)\b")),
    ("override/en-role", 5, "英文角色劫持（you are no longer / new instructions supersede 类）",
     re.compile(r"(?i)(you\s+are\s+no\s+longer|new\s+(instructions?|rules?)\s+(supersede|replace|override)|"
                r"do\s+not\s+(follow|obey)\s[^\n]{0,30}\b(system|previous|above)\b)")),
    ("override/zh", 5, "中文指令覆盖（无视之前指令类）",
     re.compile(r"(无视|忽略|忘掉|忘记|不要(遵守|遵循|理会|执行)|不再(遵守|遵循))"
                r"[^\n]{0,20}(之前|以上|先前|上述|前面|上面|系统|原有|初始)"
                r"[^\n]{0,20}(指令|指示|规则|提示词|提示|设定|约束|要求)")),
    ("override/zh-sysprompt", 5, "中文系统提示词覆盖/替换",
     re.compile(r"(覆盖|替换|重写)[^\n]{0,16}(系统提示词|系统提示|系统设定|system\s*prompt)")),

    # ── 2. 隐藏指令 ──
    # HTML 注释类为全文扫描（可跨行），见 scan_text() 中 HIDDEN_COMMENT 特判
    ("hidden/css-container", 4, "不可见容器内容（display:none / visibility:hidden / opacity:0 / font-size:0）",
     re.compile(r"(?i)<(span|div|p|font|details|section)\b[^>]{0,200}"
                r"(display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0(?![.0-9]*[1-9])|font-size\s*:\s*0)")),

    # ── 3. 会话外传 ──
    ("exfil/conversation-out", 6, "对话内容外传（对话/会话/聊天记录 + 外部 URL/webhook/POST）",
     re.compile(r"(?i)^(?=.*(对话内容|会话内容|聊天记录|完整对话|conversation|chat\s?history|"
                r"message\s?history|transcript))"
                r"(?=.*(https?://|webhook|curl\b|\bpost\b|发送到|上传到|提交到)).*$")),
    ("exfil/curl-post", 2, "curl/wget POST 外部 URL（弱信号，合法技能可能示范 API 调用）",
     re.compile(r"(?i)\b(curl\b(?=[^\n]*https?://)(?=[^\n]*(\s-d\s|--data\b|--form\b|\s-F\s|-X\s*POST|--upload-file\b))|"
                r"wget\b[^\n]*--post-(data|file)\b)")),
    ("exfil/webhook-url", 4, "已知外传/回连端点（slack webhook / discord webhook / telegram bot / 回连域名）",
     re.compile(r"(?i)(hooks\.slack\.com/services/|discord(?:app)?\.com/api/webhooks|"
                r"api\.telegram\.org/bot|webhook\.site|requestbin|pipedream\.net|"
                r"oastify\.com|burpcollaborator\.net|interact\.sh)")),

    # ── 4. 凭证收集 ──
    ("cred/ask-secret", 3, "索要密钥/密码/令牌（key/token/密码 + 提供/输入/发给我）",
     re.compile(r"(?i)^(?=.*(api[\s_-]?key|access[\s_-]?token|secret[\s_-]?key|password|passphrase|"
                r"密码|口令|密钥|令牌|凭证))"
                r"(?=.*(paste|provide|enter|send\s?me|tell\s?me|share|输入|粘贴|提供|发给我|告诉我|发送给)).*$")),
    ("cred/read-secret-file", 4, "读取敏感凭证文件（~/.ssh、.aws/credentials、/etc/shadow 等）",
     re.compile(r"(?i)(~/\.ssh/|\bid_rsa\b|\bid_ed25519\b|\.aws/credentials|\B\.netrc\b|"
                r"/etc/passwd|/etc/shadow)")),
    ("cred/env-secret", 2, "枚举/回显环境密钥（printenv/process.env/os.environ + KEY/TOKEN/SECRET，弱信号）",
     re.compile(r"(?i)(\b(printenv|process\.env\.|os\.environ)\b[^\n]{0,40}(key|token|secret|password)|"
                r"\becho\b[^\n]{0,30}\$\{?[A-Z_]*(API_?KEY|TOKEN|SECRET))")),
]

# 隐藏指令：HTML 注释里含劫持类关键词（可跨行，全文扫描）
HIDDEN_COMMENT_ID = "hidden/html-comment"
HIDDEN_COMMENT_WEIGHT = 4
RE_HTML_COMMENT = re.compile(r"(?s)<!--.*?-->")
RE_COMMENT_SUSPECT = re.compile(
    r"(?i)(ignore\s+(all\s+)?(previous|prior|above)|system\s*prompt|do\s?n[o']t\s+tell|secretly|"
    r"无视之前|忽略之前|忽略以上|不要告诉|偷偷|悄悄|发送到\s*http|上传到\s*http|执行以下命令)")

# 编码异常：无法按 UTF-8 解码的技能 md 本身可疑（可夹带字节级 payload）
ENCODING_ID = "encoding/invalid-utf8"
ENCODING_WEIGHT = 5


def eprint(*args):
    print(*args, file=sys.stderr)


def die(msg, code=1):
    eprint(f"[ERROR] {msg}")
    sys.exit(code)


def now_utc():
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def fingerprint(relpath, pattern_id, line_content):
    """指纹 = sha256(相对路径 + pattern id + 命中行内容)——与 baseline 约定一致。"""
    h = hashlib.sha256()
    h.update(relpath.encode("utf-8"))
    h.update(b"\n")
    h.update(pattern_id.encode("utf-8"))
    h.update(b"\n")
    h.update(line_content.encode("utf-8"))
    return h.hexdigest()


def char_label(ch):
    cp = ord(ch)
    name = unicodedata.name(ch, "")
    return f"U+{cp:04X}{'（' + name + '）' if name else ''}"


class Finding:
    __slots__ = ("category", "pattern_id", "weight", "file", "line", "content", "detail")

    def __init__(self, category, pattern_id, weight, file, line, content, detail):
        self.category = category      # "unicode" | "pattern"
        self.pattern_id = pattern_id
        self.weight = weight
        self.file = file              # 相对 --root 的路径（指纹用）
        self.line = line
        self.content = content        # 命中行内容（指纹用）
        self.detail = detail          # 人类可读说明

    def fp(self):
        return fingerprint(self.file, self.pattern_id, self.content)


def collect_md_files(paths):
    """展开输入路径：目录递归收 *.md，显式给的文件不论扩展名都收。"""
    files = []
    for p in paths:
        if os.path.isdir(p):
            for dirpath, _, names in os.walk(p):
                for n in sorted(names):
                    if n.lower().endswith(".md"):
                        files.append(os.path.join(dirpath, n))
        elif os.path.isfile(p):
            files.append(p)
        else:
            die(f"路径不存在: {p}")
    return files


def scan_file(abspath, relpath):
    """扫描单个文件，返回 Finding 列表。"""
    findings = []
    with open(abspath, "rb") as f:
        raw = f.read()
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError as e:
        findings.append(Finding(
            "pattern", ENCODING_ID, ENCODING_WEIGHT, relpath, 0, "<binary>",
            f"无法按 UTF-8 解码（{e.reason} @ byte {e.start}），可疑字节级 payload"))
        text = raw.decode("utf-8", errors="replace")

    lines = text.split("\n")

    # 1) Unicode 隐藏字符（硬拦截）
    for i, line in enumerate(lines, 1):
        for m in RE_UNICODE_HIDDEN.finditer(line):
            ch = m.group(0)
            hint = ""
            if ch == "\ufeff" and i == 1 and m.start() == 0:
                hint = "——文件头 BOM，请以无 BOM UTF-8 重新保存后再装"
            findings.append(Finding(
                "unicode", "unicode/hidden-char", 0, relpath, i, line,
                f"隐藏字符 {char_label(ch)} @ 列 {m.start() + 1}{hint}"))

    # 2) 静态 pattern（逐行）
    for pid, weight, desc, rx in PATTERNS:
        for i, line in enumerate(lines, 1):
            if rx.search(line):
                excerpt = line.strip()
                if len(excerpt) > 100:
                    excerpt = excerpt[:100] + "…"
                findings.append(Finding(
                    "pattern", pid, weight, relpath, i, line, f"{desc}：{excerpt}"))

    # 3) 隐藏指令：HTML 注释（可跨行，全文扫描）
    for m in RE_HTML_COMMENT.finditer(text):
        body = m.group(0)
        if RE_COMMENT_SUSPECT.search(body):
            line_no = text.count("\n", 0, m.start()) + 1
            first_line = body.split("\n")[0].strip()
            findings.append(Finding(
                "pattern", HIDDEN_COMMENT_ID, HIDDEN_COMMENT_WEIGHT, relpath, line_no,
                lines[line_no - 1] if line_no <= len(lines) else first_line,
                f"HTML 注释内含劫持类关键词：{first_line[:100]}"))

    return findings


# ═══════════════════════════════════════
# baseline（.scan-baseline.yaml，自有受限 YAML 子集）
# ═══════════════════════════════════════
BASELINE_HEADER = """\
# .scan-baseline.yaml — soul-scan.py 指纹基线（脚本自动维护，请勿手工编辑）
# 每条指纹 = sha256(文件相对路径 + "\\n" + pattern id + "\\n" + 命中行内容)。
# 仅抑制静态 pattern 类 finding；Unicode 隐藏字符类 finding 永不允许进入本基线。
version: "1.0"
findings:
"""


def load_baseline(path):
    """读 baseline，返回 {fingerprint: entry_dict}。文件不存在返回空。格式异常 fail-loud。"""
    entries = {}
    if not os.path.isfile(path):
        return entries
    cur = None
    with open(path, "r", encoding="utf-8") as f:
        for ln, raw in enumerate(f, 1):
            line = raw.rstrip("\n")
            s = line.strip()
            if not s or s.startswith("#"):
                continue
            if s in ("version: \"1.0\"", "findings:", "findings: []"):
                continue
            if s.startswith("- fingerprint:"):
                cur = {"fingerprint": s.split(":", 1)[1].strip().strip('"')}
                entries[cur["fingerprint"]] = cur
                continue
            if cur is not None and ":" in s:
                k, v = s.split(":", 1)
                k = k.strip()
                v = v.strip()
                if v.startswith('"') and v.endswith('"') and len(v) >= 2:
                    try:
                        v = json.loads(v)
                    except ValueError:
                        v = v[1:-1]
                cur[k] = v
                continue
            die(f"baseline 格式异常 {path}:{ln}: {s!r}（本文件只能由 soul-scan.py 维护）")
    return entries


def save_baseline(path, entries):
    """全量重写 baseline（原子写）。"""
    tmp = path + ".tmp"
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(BASELINE_HEADER)
        for e in entries.values():
            f.write(f"  - fingerprint: {e['fingerprint']}\n")
            for k in ("pattern", "file", "line", "reason", "accepted_at"):
                if k in e:
                    f.write(f"    {k}: {json.dumps(str(e[k]), ensure_ascii=False)}\n")
    os.replace(tmp, path)


# ═══════════════════════════════════════
# 扫描主流程
# ═══════════════════════════════════════
def run_scan(args, collect_new=False):
    """返回 (exit_code, summary, new_pattern_findings)。"""
    files = collect_md_files(args.paths)
    root = os.path.abspath(args.root)
    baseline = load_baseline(args.baseline)

    all_findings = []
    for f in files:
        rel = os.path.relpath(os.path.abspath(f), root)
        all_findings.extend(scan_file(f, rel))

    unicode_findings = [x for x in all_findings if x.category == "unicode"]
    pattern_findings = [x for x in all_findings if x.category == "pattern"]

    suppressed, active = [], []
    for x in pattern_findings:
        (suppressed if x.fp() in baseline else active).append(x)

    # 评分：同一 pattern id 最多计 PER_PATTERN_CAP 次
    score = 0
    counted = {}
    for x in active:
        n = counted.get(x.pattern_id, 0)
        if n < PER_PATTERN_CAP:
            score += x.weight
        counted[x.pattern_id] = n + 1

    src = f"（源: {args.source_name}）" if args.source_name else ""
    eprint(f"[SCAN] 扫描 {len(files)} 个文件{src}，root={root}")
    for x in unicode_findings:
        eprint(f"[HARD] {x.file}:{x.line} {x.detail}")
    for x in active:
        lv = "HIGH" if x.weight >= 5 else ("MED" if x.weight >= 4 else "LOW")
        eprint(f"[{lv}]  {x.file}:{x.line} [{x.pattern_id} w={x.weight}] {x.detail}")
    for x in suppressed:
        reason = baseline[x.fp()].get("reason", "?")
        eprint(f"[BASE] {x.file}:{x.line} [{x.pattern_id}] 已基线抑制（reason: {reason}）")

    forced = False
    if unicode_findings:
        result, code = "unicode-reject", 4
        eprint(f"[RESULT] 检测到 {len(unicode_findings)} 处 Unicode 隐藏字符 → 硬拦截拒装"
               "（不可 --force、不可 baseline）")
    elif score >= REJECT_THRESHOLD:
        result, code = "reject", 3
        eprint(f"[RESULT] risk_score={score} ≥ {REJECT_THRESHOLD} → 高风险拒装（--force 无效）")
    elif score >= WARN_THRESHOLD:
        if args.force:
            result, code, forced = "forced-pass", 0, True
            eprint(f"[RESULT] risk_score={score} 中风险，--force 已指定 → 强制放行（请自担风险）")
        else:
            result, code = "warn", 2
            eprint(f"[RESULT] risk_score={score} ∈ [{WARN_THRESHOLD},{REJECT_THRESHOLD}) → "
                   "中风险，需 --force 才放行")
    else:
        result, code = "pass", 0
        eprint(f"[RESULT] risk_score={score} < {WARN_THRESHOLD} → 放行"
               + ("" if not active else f"（{len(active)} 条低分 finding 已列出，请留意）"))

    summary = {
        "result": result, "risk_score": score, "files": len(files),
        "findings": len(active), "suppressed": len(suppressed),
        "unicode_findings": len(unicode_findings), "forced": forced,
    }
    return code, summary, (active if collect_new else None)


def cmd_scan(args):
    code, summary, _ = run_scan(args)
    print(json.dumps(summary, ensure_ascii=False))
    sys.exit(code)


def cmd_accept_baseline(args):
    reason = (args.reason or "").strip()
    if not reason:
        die("accept-baseline 必须提供非空 --reason（为什么接受这些 finding）")
    args.force = False
    code, _, active = run_scan(args, collect_new=True)
    if code == 4:
        die("存在 Unicode 隐藏字符 finding：硬拦截类永不进 baseline，先解决它们再谈基线", 4)
    if not active:
        eprint("[OK] 无新增 pattern finding（可能已全部在基线中），baseline 未变更")
        sys.exit(0)
    entries = load_baseline(args.baseline)
    added = 0
    for x in active:
        fp = x.fp()
        if fp in entries:
            continue
        entries[fp] = {
            "fingerprint": fp, "pattern": x.pattern_id, "file": x.file,
            "line": x.line, "reason": reason, "accepted_at": now_utc(),
        }
        added += 1
    save_baseline(args.baseline, entries)
    eprint(f"[OK] 已写入 {added} 条新指纹到 {args.baseline}（reason: {reason}）")
    sys.exit(0)


# ═══════════════════════════════════════
# install-lock（.install-lock.yaml，自有受限 YAML 子集，按源名分节）
# ═══════════════════════════════════════
LOCK_HEADER = """\
# .install-lock.yaml — soul-sync.sh 来源持久化（脚本自动维护，请勿手工编辑）
# 每个源一节：source_repo / source_ref / source_commit / installed_at / scan_score
version: "1.0"
sources:
"""


def load_lock(path):
    """读 lock，返回 OrderedDict {源名: {字段: 值}}。格式异常 fail-loud。"""
    sections = {}
    if not os.path.isfile(path):
        return sections
    cur = None
    with open(path, "r", encoding="utf-8") as f:
        for ln, raw in enumerate(f, 1):
            line = raw.rstrip("\n")
            s = line.strip()
            if not s or s.startswith("#") or s in ("version: \"1.0\"", "sources:", "sources: {}"):
                continue
            indent = len(line) - len(line.lstrip(" "))
            if indent == 2 and s.endswith(":"):
                key = s[:-1].strip()
                if key.startswith('"'):
                    try:
                        key = json.loads(key)
                    except ValueError:
                        key = key.strip('"')
                cur = {}
                sections[key] = cur
                continue
            if indent == 4 and cur is not None and ":" in s:
                k, v = s.split(":", 1)
                v = v.strip()
                if v.startswith('"'):
                    try:
                        v = json.loads(v)
                    except ValueError:
                        v = v.strip('"')
                cur[k.strip()] = v
                continue
            die(f"install-lock 格式异常 {path}:{ln}: {s!r}（本文件只能由 soul-scan.py 维护）")
    return sections


def cmd_write_lock(args):
    sections = load_lock(args.lock)
    sections[args.name] = {
        "source_repo": args.repo,
        "source_ref": args.ref,
        "source_commit": args.commit,
        "installed_at": now_utc(),
        "scan_score": args.score,
    }
    tmp = args.lock + ".tmp"
    os.makedirs(os.path.dirname(args.lock) or ".", exist_ok=True)
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(LOCK_HEADER)
        for name, fields in sections.items():
            f.write(f"  {json.dumps(str(name), ensure_ascii=False)}:\n")
            for k in ("source_repo", "source_ref", "source_commit", "installed_at", "scan_score"):
                if k in fields:
                    v = fields[k]
                    if k == "scan_score":
                        try:
                            f.write(f"    {k}: {int(v)}\n")
                            continue
                        except (TypeError, ValueError):
                            pass
                    f.write(f"    {k}: {json.dumps(str(v), ensure_ascii=False)}\n")
    os.replace(tmp, args.lock)
    eprint(f"[OK] 已写入 install-lock 分节: {args.name} → {args.lock}")
    sys.exit(0)


# ═══════════════════════════════════════
# CLI
# ═══════════════════════════════════════
def default_root():
    return os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))


def default_baseline():
    return os.path.join(default_root(), "shared", "skills", "community", ".scan-baseline.yaml")


def main():
    ap = argparse.ArgumentParser(
        description="soul-scan.py — 社区技能安装门禁：Unicode 硬拦截 + 四类注入 pattern + baseline 指纹抑制",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="硬边界：Unicode 类 finding 不可 --force、不可 baseline；高风险不可 --force；"
               "accept-baseline 缺 --reason 拒绝写入。详见脚本头注释。")
    sub = ap.add_subparsers(dest="cmd", required=True)

    def add_scan_args(p):
        p.add_argument("paths", nargs="+", help="待扫描的文件或目录（目录递归收 *.md）")
        p.add_argument("--root", default=default_root(),
                       help="指纹相对路径的根目录（sync 时传 clone 目录；默认仓库根）")
        p.add_argument("--baseline", default=default_baseline(),
                       help="baseline 文件路径（默认 shared/skills/community/.scan-baseline.yaml）")
        p.add_argument("--source-name", default="", help="源名（仅用于报告标注）")

    p_scan = sub.add_parser("scan", help="扫描并按三段阈值给出放行/警告/拒装")
    add_scan_args(p_scan)
    p_scan.add_argument("--force", action="store_true",
                        help="中风险强制放行（对 Unicode 硬拦截与高风险无效）")

    p_acc = sub.add_parser("accept-baseline", help="把当前 pattern finding 写入 baseline（需 --reason）")
    add_scan_args(p_acc)
    p_acc.add_argument("--reason", required=True, help="接受理由（必填，写入 baseline）")

    p_lock = sub.add_parser("write-lock", help="写入/更新 install-lock 中某源的分节")
    p_lock.add_argument("--lock", required=True, help=".install-lock.yaml 路径")
    p_lock.add_argument("--name", required=True, help="源名（sources.yaml 的 name）")
    p_lock.add_argument("--repo", required=True, help="源仓库 URL")
    p_lock.add_argument("--ref", required=True, help="声明的 ref（tag/branch/commit）")
    p_lock.add_argument("--commit", required=True, help="实际 commit hash（actual_commit）")
    p_lock.add_argument("--score", default="0", help="本次安装的 risk_score")

    args = ap.parse_args()
    if args.cmd == "scan":
        cmd_scan(args)
    elif args.cmd == "accept-baseline":
        cmd_accept_baseline(args)
    elif args.cmd == "write-lock":
        cmd_write_lock(args)


if __name__ == "__main__":
    main()
