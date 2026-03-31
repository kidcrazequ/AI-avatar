#!/bin/bash
# test-avatar.sh - 分身自动化测试运行器
# 用法: ./test-avatar.sh <avatar-name> [category-filter]
# 示例: ./test-avatar.sh ci-storage-expert
#       ./test-avatar.sh ci-storage-expert 红线合规

set -euo pipefail

# ── 参数 ──
AVATAR_NAME="${1:-}"
CATEGORY_FILTER="${2:-}"
TEST_MODEL="${TEST_MODEL:-opus}"

if [ -z "$AVATAR_NAME" ]; then
  echo "用法: ./test-avatar.sh <avatar-name> [category-filter]"
  echo "示例: ./test-avatar.sh ci-storage-expert"
  echo "      ./test-avatar.sh ci-storage-expert 红线合规"
  exit 1
fi

# ── 路径 ──
SOUL_ROOT="$(cd "$(dirname "$0")" && pwd)"
AVATAR_DIR="$SOUL_ROOT/avatars/$AVATAR_NAME"
TESTS_DIR="$AVATAR_DIR/tests"
CASES_DIR="$TESTS_DIR/cases"
REPORTS_DIR="$TESTS_DIR/reports"
JUDGE_PROMPT="$TESTS_DIR/judge-prompt.md"
TIMESTAMP=$(date +%Y-%m-%d_%H%M%S)
REPORT_FILE="$REPORTS_DIR/$TIMESTAMP.md"

# ── 校验 ──
[ -d "$AVATAR_DIR" ] || { echo "错误: 分身 '$AVATAR_NAME' 不存在 ($AVATAR_DIR)"; exit 1; }
[ -d "$CASES_DIR" ]  || { echo "错误: 测试目录不存在 ($CASES_DIR)"; exit 1; }
[ -f "$JUDGE_PROMPT" ] || { echo "错误: judge-prompt.md 不存在 ($JUDGE_PROMPT)"; exit 1; }
mkdir -p "$REPORTS_DIR"

# ── 颜色 ──
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
NC='\033[0m'

# ── 解析测试用例 ──
# 用例格式: 用 --- 分隔的区块
# 区块顺序: metadata / PROMPT / RUBRICS / MUST_CONTAIN / MUST_NOT_CONTAIN
parse_section() {
  local file="$1"
  local section_num="$2"
  awk -v n="$section_num" '
    BEGIN { count=0 }
    /^---$/ { count++; next }
    count==n { print }
  ' "$file"
}

parse_meta() {
  local file="$1"
  local key="$2"
  parse_section "$file" 1 | grep "^${key}:" | sed "s/^${key}: *//"
}

# ── 统计变量 ──
TOTAL=0
PASSED=0
FAILED=0
CRITICAL_COUNT=0
RESULTS=""
CRITICAL_DETAILS=""
DETAIL_SECTIONS=""

echo -e "${CYAN}═══════════════════════════════════════════════════${NC}"
echo -e "${CYAN}  分身测试: $AVATAR_NAME${NC}"
echo -e "${CYAN}  模型: $TEST_MODEL${NC}"
[ -n "$CATEGORY_FILTER" ] && echo -e "${CYAN}  过滤: $CATEGORY_FILTER${NC}"
echo -e "${CYAN}═══════════════════════════════════════════════════${NC}"
echo ""

# ── 遍历测试用例 ──
for case_file in "$CASES_DIR"/*.md; do
  [ -f "$case_file" ] || continue

  # 解析元数据
  CASE_ID=$(parse_meta "$case_file" "id")
  CASE_NAME=$(parse_meta "$case_file" "name")
  CASE_CATEGORY=$(parse_meta "$case_file" "category")
  CASE_TIMEOUT=$(parse_meta "$case_file" "timeout")
  CASE_TIMEOUT="${CASE_TIMEOUT:-120}"

  # 类别过滤
  if [ -n "$CATEGORY_FILTER" ] && [ "$CASE_CATEGORY" != "$CATEGORY_FILTER" ]; then
    continue
  fi

  TOTAL=$((TOTAL + 1))
  echo -e "${CYAN}[$CASE_ID]${NC} $CASE_NAME"
  echo -n "  被测分身回答中..."

  # 提取各区块（去掉首行标签行）
  PROMPT=$(parse_section "$case_file" 2 | tail -n +2)
  RUBRICS=$(parse_section "$case_file" 3 | tail -n +2)
  MUST_CONTAIN=$(parse_section "$case_file" 4 | tail -n +2 | sed '/^$/d')
  MUST_NOT_CONTAIN=$(parse_section "$case_file" 5 | tail -n +2 | sed '/^$/d')

  # ── Step 1: 被测分身回答 ──
  # 从分身目录运行 claude，让它自动加载 CLAUDE.md → soul.md → knowledge
  RESPONSE=$(cd "$AVATAR_DIR" && echo "$PROMPT" | claude -p \
    --model "$TEST_MODEL" \
    --allowedTools "Read,Glob,Grep" \
    --max-budget-usd 0.5 \
    2>/dev/null) || RESPONSE="[ERROR: 分身调用超时或失败]"

  echo -e "\r  被测分身回答完成 ✓    "

  # ── Step 2: 快速检查 ──
  QUICK_CHECK="PASS"
  QUICK_NOTES=""

  if [ -n "$MUST_CONTAIN" ]; then
    while IFS= read -r keyword; do
      [ -z "$keyword" ] && continue
      if ! echo "$RESPONSE" | grep -q "$keyword"; then
        QUICK_CHECK="FAIL"
        QUICK_NOTES="${QUICK_NOTES}  缺少必须包含: $keyword\n"
      fi
    done <<< "$MUST_CONTAIN"
  fi

  if [ -n "$MUST_NOT_CONTAIN" ]; then
    while IFS= read -r keyword; do
      [ -z "$keyword" ] && continue
      if echo "$RESPONSE" | grep -q "$keyword"; then
        QUICK_CHECK="FAIL"
        QUICK_NOTES="${QUICK_NOTES}  包含了禁止词: $keyword\n"
      fi
    done <<< "$MUST_NOT_CONTAIN"
  fi

  # ── Step 3: LLM Judge 评分 ──
  echo -n "  Judge 评分中..."

  JUDGE_INPUT=$(cat <<JUDGE_EOF
## 被测分身的回答

$RESPONSE

## 评分维度（Rubrics）

$RUBRICS

## 快速检查结果

$QUICK_CHECK
$([ -n "$QUICK_NOTES" ] && echo -e "$QUICK_NOTES")

请严格按照 system prompt 中的 JSON 格式输出评分结果。只输出 JSON，不要输出其他内容。
JUDGE_EOF
)

  JUDGE_RESULT=$(echo "$JUDGE_INPUT" | claude -p \
    --model "$TEST_MODEL" \
    --system-prompt "$(cat "$JUDGE_PROMPT")" \
    --allowedTools "" \
    --max-budget-usd 0.3 \
    2>/dev/null) || JUDGE_RESULT='{"dimensions":[],"total":0,"critical_issues":["Judge 调用失败"],"pass":false,"comment":"Judge 评分失败"}'

  echo -e "\r  Judge 评分完成 ✓       "

  # ── Step 4: 解析结果 ──
  # 从 judge 输出中提取 JSON（可能包含 markdown code block）
  JUDGE_JSON=$(echo "$JUDGE_RESULT" | sed -n '/^```/,/^```/p' | sed '1d;$d')
  [ -z "$JUDGE_JSON" ] && JUDGE_JSON="$JUDGE_RESULT"

  # 提取关键字段（用 grep + sed 简单解析，避免依赖 jq）
  SCORE=$(echo "$JUDGE_JSON" | grep '"total"' | head -1 | sed 's/[^0-9]//g')
  SCORE="${SCORE:-0}"
  IS_PASS=$(echo "$JUDGE_JSON" | grep '"pass"' | head -1 | grep -c "true" || true)
  HAS_CRITICAL=$(echo "$JUDGE_JSON" | grep '"critical_issues"' | grep -c '\[\]' || true)
  COMMENT=$(echo "$JUDGE_JSON" | grep '"comment"' | tail -1 | sed 's/.*"comment": *"//;s/".*//')

  # 判定最终结果
  if [ "$HAS_CRITICAL" -eq 0 ]; then
    CASE_RESULT="CRITICAL"
    CRITICAL_COUNT=$((CRITICAL_COUNT + 1))
    FAILED=$((FAILED + 1))
    echo -e "  结果: ${RED}CRITICAL${NC} (得分: $SCORE)"
    CRITICAL_DETAILS="${CRITICAL_DETAILS}\n### [$CASE_ID] $CASE_NAME\n- **类别**: $CASE_CATEGORY\n- **得分**: $SCORE\n- **评语**: $COMMENT\n"
  elif [ "$IS_PASS" -eq 1 ] && [ "$QUICK_CHECK" = "PASS" ]; then
    CASE_RESULT="PASS"
    PASSED=$((PASSED + 1))
    echo -e "  结果: ${GREEN}PASS${NC} (得分: $SCORE)"
  else
    CASE_RESULT="FAIL"
    FAILED=$((FAILED + 1))
    echo -e "  结果: ${YELLOW}FAIL${NC} (得分: $SCORE)"
  fi

  # 记录结果行
  RESULTS="${RESULTS}| $CASE_ID | $CASE_CATEGORY | $SCORE | $CASE_RESULT | $COMMENT |\n"

  # 记录详细评分
  DETAIL_SECTIONS="${DETAIL_SECTIONS}\n### [$CASE_ID] $CASE_NAME\n\n**类别**: $CASE_CATEGORY | **得分**: $SCORE | **结果**: $CASE_RESULT\n"
  if [ -n "$QUICK_NOTES" ]; then
    DETAIL_SECTIONS="${DETAIL_SECTIONS}\n**快速检查**: $QUICK_CHECK\n$(echo -e "$QUICK_NOTES")\n"
  fi
  DETAIL_SECTIONS="${DETAIL_SECTIONS}\n**Judge 评分**:\n\`\`\`json\n$JUDGE_JSON\n\`\`\`\n"
  DETAIL_SECTIONS="${DETAIL_SECTIONS}\n<details><summary>分身原始回答</summary>\n\n$RESPONSE\n\n</details>\n"

  echo ""
done

# ── 生成报告 ──
if [ "$TOTAL" -eq 0 ]; then
  echo "没有找到匹配的测试用例。"
  exit 0
fi

PASS_RATE=$((PASSED * 100 / TOTAL))

cat > "$REPORT_FILE" <<REPORT_EOF
# 测试报告：$AVATAR_NAME

> **时间**: $(date '+%Y-%m-%d %H:%M:%S')
> **模型**: $TEST_MODEL
> **用例数**: $TOTAL
> **通过**: $PASSED / $TOTAL ($PASS_RATE%)
$([ -n "$CATEGORY_FILTER" ] && echo "> **过滤**: $CATEGORY_FILTER")

## 结果总览

| 用例 | 类别 | 得分 | 结果 | 摘要 |
|------|------|------|------|------|
$(echo -e "$RESULTS")
$(if [ "$CRITICAL_COUNT" -gt 0 ]; then
echo "
## CRITICAL 问题（需立即修复）
$(echo -e "$CRITICAL_DETAILS")"
fi)

## 详细评分
$(echo -e "$DETAIL_SECTIONS")
REPORT_EOF

# ── 输出总结 ──
echo -e "${CYAN}═══════════════════════════════════════════════════${NC}"
echo -e "  测试完成: $PASSED/$TOTAL 通过 ($PASS_RATE%)"
[ "$CRITICAL_COUNT" -gt 0 ] && echo -e "  ${RED}CRITICAL 问题: $CRITICAL_COUNT${NC}"
echo -e "  报告: $REPORT_FILE"
echo -e "${CYAN}═══════════════════════════════════════════════════${NC}"

# 退出码: 有失败则返回 1
[ "$FAILED" -gt 0 ] && exit 1
exit 0
