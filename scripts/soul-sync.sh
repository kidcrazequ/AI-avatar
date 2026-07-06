#!/usr/bin/env bash
# @author zhi.qu
# @date 2026-05-08
#
# soul-sync.sh — 根据 sources.yaml 同步外部技能到 community/
#
# 用法：
#   ./scripts/soul-sync.sh           # 同步所有外部技能
#   ./scripts/soul-sync.sh --clean   # 清理后重新同步
#   ./scripts/soul-sync.sh --status  # 显示当前安装状态
#   ./scripts/soul-sync.sh --help    # 帮助

set -euo pipefail

# ═══════════════════════════════════════
# 路径常量
# ═══════════════════════════════════════
SOUL_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SOURCES_FILE="$SOUL_ROOT/shared/skills/sources.yaml"
COMMUNITY_DIR="$SOUL_ROOT/shared/skills/community"
LOCK_FILE="$SOUL_ROOT/shared/skills/sources.lock"
TMP_DIR="$SOUL_ROOT/.soul-sync-tmp"
# A2 安装门禁（scripts/soul-scan.py）：clone 之后、cp 进 community/ 之前扫描。
# 中风险 finding 需 SOUL_SYNC_FORCE=1 环境变量强制放行；Unicode 硬拦截不可绕过。
SCAN_SCRIPT="$SOUL_ROOT/scripts/soul-scan.py"
SCAN_BASELINE="$COMMUNITY_DIR/.scan-baseline.yaml"
INSTALL_LOCK="$COMMUNITY_DIR/.install-lock.yaml"

# ═══════════════════════════════════════
# 颜色输出
# ═══════════════════════════════════════
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info()  { echo -e "${BLUE}[INFO]${NC}  $*"; }
log_ok()    { echo -e "${GREEN}[OK]${NC}    $*"; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
log_error() { echo -e "${RED}[ERROR]${NC} $*"; }

# ═══════════════════════════════════════
# 依赖检查
# ═══════════════════════════════════════
check_deps() {
    local missing=()
    for cmd in git python3; do
        if ! command -v "$cmd" &>/dev/null; then
            missing+=("$cmd")
        fi
    done
    if [[ ${#missing[@]} -gt 0 ]]; then
        log_error "缺少依赖: ${missing[*]}"
        log_error "请安装后重试"
        exit 1
    fi
}

# ═══════════════════════════════════════
# 解析 sources.yaml（用 Python 避免依赖 yq）
# ═══════════════════════════════════════
parse_sources() {
    # `-` 让 python 从 stdin 读程序、后续参数进 sys.argv（否则 argv[1] 永远为空静默退出）。
    # 零外部依赖：系统 python3 无 PyYAML，与 soul-scan.py / validate-skills.py 同款
    # 受限 YAML 子集解析器（只支持 sources.yaml 文件头注释里声明的写法），
    # 解析不了的行 fail-loud 报行号退出，绝不静默猜测。
    python3 - "$1" << 'PYEOF'
import json, re, sys

sources_file = sys.argv[1] if len(sys.argv) > 1 else ""
if not sources_file:
    sys.exit("parse_sources: 缺少 sources.yaml 路径参数")

def strip_comment(line):
    # 引号外、且前面是行首/空白的 "#" 起为注释（受限子集：不处理引号内转义）
    out, in_q = [], None
    for i, ch in enumerate(line):
        if in_q:
            out.append(ch)
            if ch == in_q:
                in_q = None
        elif ch in ('"', "'"):
            in_q = ch
            out.append(ch)
        elif ch == '#' and (i == 0 or line[i - 1] in ' \t'):
            break
        else:
            out.append(ch)
    return ''.join(out).rstrip()

def unquote(v):
    v = v.strip()
    if len(v) >= 2 and v[0] == v[-1] and v[0] in ('"', "'"):
        return v[1:-1]
    return v

def inline_list(v):
    inner = v.strip()[1:-1].strip()
    return [unquote(x) for x in inner.split(',')] if inner else []

KV = re.compile(r'^([A-Za-z_][\w-]*):(?:\s+(.*))?$')

sources, cur = [], None
in_sources = False
item_indent = None      # source 条目 "- " 的缩进
list_key = None         # 等待块列表项的键（如 skills）

def set_kv(d, text, lineno):
    global list_key
    m = KV.match(text)
    if not m:
        sys.exit(f"parse_sources: 第 {lineno} 行无法解析（受限 YAML 子集）: {text}")
    key, val = m.group(1), (m.group(2) or '').strip()
    if not val:
        d[key] = []           # 空值 = 块列表开头（如 skills:）
        list_key = key
    elif val.startswith('[') and val.endswith(']'):
        d[key] = inline_list(val)
        list_key = None
    else:
        d[key] = unquote(val)
        list_key = None

with open(sources_file, encoding='utf-8') as f:
    for lineno, raw in enumerate(f, 1):
        line = strip_comment(raw.rstrip('\n'))
        if not line.strip():
            continue
        indent = len(line) - len(line.lstrip(' '))
        text = line.strip()

        if indent == 0:
            in_sources, list_key, cur = False, None, None
            m = KV.match(text)
            if not m:
                sys.exit(f"parse_sources: 第 {lineno} 行无法解析（受限 YAML 子集）: {text}")
            if m.group(1) == 'sources':
                val = (m.group(2) or '').strip()
                if val == '[]' or not val:
                    in_sources = True    # [] = 空清单；无值 = 后接块列表
                else:
                    sys.exit(f"parse_sources: 第 {lineno} 行 sources 只支持块列表或 []: {val}")
            continue          # version 等其他顶层键忽略

        if not in_sources:
            continue

        if text.startswith('- '):
            rest = text[2:].strip()
            if list_key is not None and item_indent is not None and indent > item_indent:
                cur[list_key].append(unquote(rest))     # skills 块列表项
                continue
            item_indent, list_key = indent, None        # 新 source 条目
            cur = {}
            sources.append(cur)
            set_kv(cur, rest, lineno)
        else:
            if cur is None:
                sys.exit(f"parse_sources: 第 {lineno} 行不在任何 source 条目内: {text}")
            set_kv(cur, text, lineno)

if not sources:
    print("__EMPTY__")
    sys.exit(0)

for src in sources:
    # 输出每个 source 为一行 JSON，便于 bash 逐行处理
    print(json.dumps(src, ensure_ascii=False))
PYEOF
}

# ═══════════════════════════════════════
# 同步单个技能源
# ═══════════════════════════════════════
sync_source() {
    local json_line="$1"

    local name repo ref path file skills
    name=$(echo "$json_line" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('name',''))")
    repo=$(echo "$json_line" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('repo',''))")
    ref=$(echo "$json_line" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('ref','main'))")
    path=$(echo "$json_line" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('path','skills/'))")
    file=$(echo "$json_line" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('file',''))")
    skills=$(echo "$json_line" | python3 -c "import sys,json; d=json.load(sys.stdin); print(json.dumps(d.get('skills',[]) or []))")

    if [[ -z "$name" || -z "$repo" ]]; then
        log_error "source 缺少 name 或 repo 字段，跳过"
        return 1
    fi

    log_info "同步 $name ← $repo@$ref"

    local clone_dir="$TMP_DIR/$name"
    local target_dir="$COMMUNITY_DIR/$name"

    # 克隆到临时目录
    rm -rf "$clone_dir"
    if ! git clone --depth 1 --branch "$ref" "$repo" "$clone_dir" 2>/dev/null; then
        # branch/tag 失败，尝试 commit hash
        git clone "$repo" "$clone_dir" 2>/dev/null
        cd "$clone_dir" && git checkout "$ref" 2>/dev/null
        cd "$SOUL_ROOT"
    fi

    if [[ ! -d "$clone_dir" ]]; then
        log_error "  克隆失败: $repo@$ref"
        return 1
    fi

    # 获取实际 commit hash（用于 lock 文件）
    local actual_commit
    actual_commit=$(cd "$clone_dir" && git rev-parse HEAD)

    # ── A2 安装门禁：clone 之后、cp 之前，扫描「将要安装」的技能文件 ──
    # 命中 Unicode 隐藏字符 / 高风险 pattern → 整源跳过安装（fail-loud）
    local scan_files=()
    if [[ -n "$file" ]]; then
        [[ -f "$clone_dir/$file" ]] && scan_files+=("$clone_dir/$file")
    else
        local scan_src_dir="$clone_dir/$path"
        local scan_skill_list
        scan_skill_list=$(echo "$skills" | python3 -c "import sys,json; print(' '.join(json.load(sys.stdin)))")
        if [[ -z "$scan_skill_list" ]]; then
            local scan_f
            for scan_f in "$scan_src_dir"/*.md; do
                [[ -f "$scan_f" ]] && scan_files+=("$scan_f")
            done
            # B1 目录型技能（SKILL.md 标准）：整个技能目录交给扫描器
            # （soul-scan.py 对目录递归收 *.md，覆盖 SKILL.md + references/**）
            local scan_d
            for scan_d in "$scan_src_dir"/*/; do
                [[ -f "${scan_d}SKILL.md" ]] && scan_files+=("${scan_d%/}")
            done
        else
            local scan_name
            for scan_name in $scan_skill_list; do
                if [[ -f "$scan_src_dir/${scan_name}.md" ]]; then
                    scan_files+=("$scan_src_dir/${scan_name}.md")
                elif [[ -f "$scan_src_dir/${scan_name}/SKILL.md" ]]; then
                    scan_files+=("$scan_src_dir/${scan_name}")
                fi
            done
        fi
    fi
    local scan_score=0
    if [[ ${#scan_files[@]} -gt 0 ]]; then
        local scan_args=(scan --root "$clone_dir" --baseline "$SCAN_BASELINE" --source-name "$name")
        if [[ "${SOUL_SYNC_FORCE:-0}" == "1" ]]; then
            scan_args+=(--force)
        fi
        local scan_rc=0 scan_summary=""
        scan_summary=$(python3 "$SCAN_SCRIPT" "${scan_args[@]}" -- "${scan_files[@]}") || scan_rc=$?
        if [[ $scan_rc -ne 0 ]]; then
            case $scan_rc in
                4) log_error "  安装门禁拒绝: 检测到 Unicode 隐藏字符（硬拦截，SOUL_SYNC_FORCE 无效），跳过该源" ;;
                3) log_error "  安装门禁拒绝: risk_score 达到拒装线（详见上方扫描报告），跳过该源" ;;
                2) log_error "  安装门禁拒绝: 中风险 finding（详见上方扫描报告）。确认无害后可 SOUL_SYNC_FORCE=1 重跑强制安装" ;;
                *) log_error "  安装门禁执行失败 (exit=$scan_rc)，为安全起见跳过该源" ;;
            esac
            return 1
        fi
        scan_score=$(echo "$scan_summary" | python3 -c "import sys,json; print(json.load(sys.stdin).get('risk_score',0))" 2>/dev/null || echo 0)
    fi

    # 准备目标目录
    rm -rf "$target_dir"
    mkdir -p "$target_dir"

    if [[ -n "$file" ]]; then
        # 单文件模式
        if [[ -f "$clone_dir/$file" ]]; then
            mkdir -p "$target_dir/skills"
            cp "$clone_dir/$file" "$target_dir/skills/"
            log_ok "  安装单文件: $file"
        else
            log_error "  文件不存在: $file"
            return 1
        fi
    else
        # 目录模式
        local src_dir="$clone_dir/$path"
        if [[ ! -d "$src_dir" ]]; then
            log_error "  目录不存在: $path"
            return 1
        fi

        local skill_list
        skill_list=$(echo "$skills" | python3 -c "import sys,json; print(' '.join(json.load(sys.stdin)))")

        if [[ -z "$skill_list" ]]; then
            # 全部安装
            mkdir -p "$target_dir/skills"
            cp "$src_dir"/*.md "$target_dir/skills/" 2>/dev/null || true
            # B1 零转换安装目录型技能：含 SKILL.md 的子目录整目录拷入
            # （anthropics/skills 一目录一技能形态，不做任何格式转换）
            local dir_skill
            for dir_skill in "$src_dir"/*/; do
                [[ -f "${dir_skill}SKILL.md" ]] || continue
                cp -R "${dir_skill%/}" "$target_dir/skills/"
            done
            local count dir_count
            count=$(ls "$target_dir/skills/"*.md 2>/dev/null | wc -l | tr -d ' ')
            dir_count=$(ls "$target_dir/skills/"*/SKILL.md 2>/dev/null | wc -l | tr -d ' ')
            # 注：${dir_count} 必须带花括号——macOS bash 3.2 对 $var 紧跟全角字符会把
            # 多字节字符误并进变量名（unbound variable）
            log_ok "  安装 $((count + dir_count)) 个技能（全部，其中目录型 ${dir_count}）"
        else
            # 选择性安装
            mkdir -p "$target_dir/skills"
            local installed=0
            for skill_name in $skill_list; do
                local skill_file="$src_dir/${skill_name}.md"
                if [[ -f "$skill_file" ]]; then
                    cp "$skill_file" "$target_dir/skills/"
                    installed=$((installed + 1))
                elif [[ -f "$src_dir/${skill_name}/SKILL.md" ]]; then
                    # B1 零转换安装目录型技能
                    cp -R "$src_dir/${skill_name}" "$target_dir/skills/"
                    installed=$((installed + 1))
                else
                    log_warn "  技能文件不存在: ${skill_name}.md（也无 ${skill_name}/SKILL.md）"
                fi
            done
            log_ok "  安装 $installed 个技能（选择性）"
        fi
    fi

    # 复制 manifest（如果有）
    if [[ -f "$clone_dir/skill-manifest.yaml" ]]; then
        cp "$clone_dir/skill-manifest.yaml" "$target_dir/"
    fi

    # 校验技能文件格式（单文件 .md + 目录型 */SKILL.md）
    local valid=0 invalid=0
    for md_file in "$target_dir/skills/"*.md "$target_dir/skills/"*/SKILL.md; do
        [[ -f "$md_file" ]] || continue
        if head -1 "$md_file" | grep -q "^---$"; then
            valid=$((valid + 1))
        else
            log_warn "  缺少 YAML frontmatter: $(basename "$md_file")"
            invalid=$((invalid + 1))
        fi
    done
    if [[ $invalid -gt 0 ]]; then
        log_warn "  $invalid 个文件缺少 frontmatter（仍可使用，但建议作者修复）"
    fi

    # 写入 lock 信息
    echo "$name|$repo|$ref|$actual_commit|$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$LOCK_FILE"

    # ── A2 来源持久化：source_repo / source_commit / installed_at / scan_score
    #    写入 community/.install-lock.yaml（按源名分节，由 soul-scan.py 维护格式）──
    if ! python3 "$SCAN_SCRIPT" write-lock --lock "$INSTALL_LOCK" \
        --name "$name" --repo "$repo" --ref "$ref" \
        --commit "$actual_commit" --score "$scan_score"; then
        log_warn "  写入 .install-lock.yaml 失败（不影响本次安装，请检查 soul-scan.py）"
    fi

    return 0
}

# ═══════════════════════════════════════
# 显示状态
# ═══════════════════════════════════════
show_status() {
    echo ""
    log_info "=== Soul 外部技能安装状态 ==="
    echo ""

    if [[ ! -f "$LOCK_FILE" ]]; then
        log_warn "尚未同步过任何外部技能"
        return
    fi

    printf "%-20s %-50s %-12s %s\n" "名称" "仓库" "版本" "同步时间"
    printf "%-20s %-50s %-12s %s\n" "----" "----" "----" "--------"

    while IFS='|' read -r name repo ref commit synced_at; do
        local short_commit="${commit:0:7}"
        printf "%-20s %-50s %-12s %s\n" "$name" "$repo" "$ref($short_commit)" "$synced_at"
    done < "$LOCK_FILE"

    echo ""

    # 统计 community/ 下的技能文件数
    local total_skills=0
    for pkg_dir in "$COMMUNITY_DIR"/*/; do
        [[ -d "$pkg_dir/skills" ]] || continue
        local count
        count=$(ls "$pkg_dir/skills/"*.md "$pkg_dir/skills/"*/SKILL.md 2>/dev/null | wc -l | tr -d ' ')
        total_skills=$((total_skills + count))
    done
    log_info "共安装 $total_skills 个社区技能"
}

# ═══════════════════════════════════════
# 主流程
# ═══════════════════════════════════════
main() {
    check_deps

    case "${1:-}" in
        --help|-h)
            echo "用法: soul-sync.sh [选项]"
            echo ""
            echo "选项:"
            echo "  (无参数)    同步所有外部技能"
            echo "  --clean     清理后重新同步"
            echo "  --status    显示当前安装状态"
            echo "  --help      显示帮助"
            exit 0
            ;;
        --status)
            show_status
            exit 0
            ;;
        --clean)
            log_info "清理 community/ 目录..."
            find "$COMMUNITY_DIR" -mindepth 1 -not -name '.gitkeep' -delete 2>/dev/null || true
            rm -f "$LOCK_FILE"
            log_ok "已清理"
            ;;
    esac

    # 检查 sources.yaml 是否存在
    if [[ ! -f "$SOURCES_FILE" ]]; then
        log_error "找不到 $SOURCES_FILE"
        exit 1
    fi

    # 解析 sources
    local sources_output
    sources_output=$(parse_sources "$SOURCES_FILE" 2>&1) || {
        log_error "解析 sources.yaml 失败"
        log_error "$sources_output"
        exit 1
    }

    if [[ "$sources_output" == "__EMPTY__" || -z "$sources_output" ]]; then
        log_info "sources.yaml 中没有配置任何外部技能源"
        log_info "编辑 $SOURCES_FILE 添加技能源后重新运行"
        exit 0
    fi

    # 准备临时目录
    rm -rf "$TMP_DIR"
    mkdir -p "$TMP_DIR"

    # 重置 lock 文件
    rm -f "$LOCK_FILE"
    echo "# sources.lock — 自动生成，请勿手动编辑" > "$LOCK_FILE"
    echo "# 格式: name|repo|ref|commit|synced_at" >> "$LOCK_FILE"

    # 逐个同步
    local success=0 failed=0
    while IFS= read -r line; do
        if sync_source "$line"; then
            success=$((success + 1))
        else
            failed=$((failed + 1))
        fi
    done <<< "$sources_output"

    # 清理临时目录
    rm -rf "$TMP_DIR"

    echo ""
    log_info "═══════════════════════════════════"
    log_ok "同步完成: $success 成功, $failed 失败"

    if [[ $success -gt 0 ]]; then
        echo ""
        log_info "下一步："
        log_info "  1. 在分身的 skill-index.yaml 中添加社区技能引用"
        log_info "  2. 格式: path: shared/skills/community/<name>/skills/<skill>.md"
        log_info "  3. 设置: source: community"
    fi

    # A2 fail-loud：只要有源同步失败（含被安装门禁拒绝），整体退出码非零
    if [[ $failed -gt 0 ]]; then
        exit 1
    fi
}

main "$@"
