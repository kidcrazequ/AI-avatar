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
    python3 << 'PYEOF'
import yaml, json, sys

sources_file = sys.argv[1] if len(sys.argv) > 1 else ""
if not sources_file:
    sys.exit(0)

with open(sources_file, 'r') as f:
    data = yaml.safe_load(f)

sources = data.get('sources', []) or []
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
            local count
            count=$(ls "$target_dir/skills/"*.md 2>/dev/null | wc -l | tr -d ' ')
            log_ok "  安装 $count 个技能（全部）"
        else
            # 选择性安装
            mkdir -p "$target_dir/skills"
            local installed=0
            for skill_name in $skill_list; do
                local skill_file="$src_dir/${skill_name}.md"
                if [[ -f "$skill_file" ]]; then
                    cp "$skill_file" "$target_dir/skills/"
                    installed=$((installed + 1))
                else
                    log_warn "  技能文件不存在: ${skill_name}.md"
                fi
            done
            log_ok "  安装 $installed 个技能（选择性）"
        fi
    fi

    # 复制 manifest（如果有）
    if [[ -f "$clone_dir/skill-manifest.yaml" ]]; then
        cp "$clone_dir/skill-manifest.yaml" "$target_dir/"
    fi

    # 校验技能文件格式
    local valid=0 invalid=0
    for md_file in "$target_dir/skills/"*.md; do
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
        count=$(ls "$pkg_dir/skills/"*.md 2>/dev/null | wc -l | tr -d ' ')
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
}

main "$@"
