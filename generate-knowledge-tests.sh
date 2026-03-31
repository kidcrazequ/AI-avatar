#!/bin/bash
# generate-knowledge-tests.sh - 从 knowledge 文件自动生成测试用例
# 用法: ./generate-knowledge-tests.sh <avatar-name> <knowledge-file>
# 示例: ./generate-knowledge-tests.sh ci-storage-expert knowledge/products/envision-L262.md

set -euo pipefail

AVATAR_NAME="${1:-}"
KNOWLEDGE_FILE="${2:-}"

if [ -z "$AVATAR_NAME" ] || [ -z "$KNOWLEDGE_FILE" ]; then
  echo "用法: ./generate-knowledge-tests.sh <avatar-name> <knowledge-file>"
  echo "示例: ./generate-knowledge-tests.sh ci-storage-expert knowledge/products/envision-L262.md"
  exit 1
fi

SOUL_ROOT="$(cd "$(dirname "$0")" && pwd)"
AVATAR_DIR="$SOUL_ROOT/avatars/$AVATAR_NAME"
KNOWLEDGE_PATH="$AVATAR_DIR/$KNOWLEDGE_FILE"
TESTS_DIR="$AVATAR_DIR/tests/cases"

# 校验
[ -d "$AVATAR_DIR" ] || { echo "错误: 分身 '$AVATAR_NAME' 不存在"; exit 1; }
[ -f "$KNOWLEDGE_PATH" ] || { echo "错误: 知识文件 '$KNOWLEDGE_FILE' 不存在"; exit 1; }
[ -d "$TESTS_DIR" ] || { echo "错误: tests/cases/ 目录不存在"; exit 1; }

echo "═══════════════════════════════════════════════════"
echo "  从知识文件生成测试用例"
echo "  分身: $AVATAR_NAME"
echo "  知识文件: $KNOWLEDGE_FILE"
echo "═══════════════════════════════════════════════════"
echo ""

# 提取文件名作为 ID 前缀
FILENAME=$(basename "$KNOWLEDGE_FILE" .md)
ID_PREFIX="knowledge-${FILENAME}"

# 读取知识文件内容
KNOWLEDGE_CONTENT=$(cat "$KNOWLEDGE_PATH")

# 生成测试用例的 system prompt
SYSTEM_PROMPT='你是一个测试用例生成专家。你的任务是从知识文件中提取 3-5 个关键知识点，为每个知识点生成一个测试用例。

## 测试用例格式

每个测试用例必须严格按照以下 markdown 格式输出：

```
---
id: knowledge-<filename>-001
name: 简短描述测试目标
category: 知识验证
timeout: 120
---
PROMPT:
发送给分身的具体问题
---
RUBRICS:
- 评分维度1：具体可验证的标准
- 评分维度2：具体可验证的标准
- 评分维度3：具体可验证的标准
- 是否标注数据来源
- 是否保持人格一致性
---
MUST_CONTAIN:

---
MUST_NOT_CONTAIN:

```

## 要求

1. **问题要具体**：不要问"介绍一下 L262"，要问"L262 的 PCS 效率是多少？"
2. **rubrics 要可验证**：不要写"回答是否准确"，要写"是否准确回答 PCS 效率 >98.8%"
3. **优先测试容易出错的知识点**：数字、规格、差异对比、计算公式
4. **每个测试用例独立**：不依赖其他用例的结果

## 输出格式

请输出 3-5 个测试用例，每个用例之间用 `---NEXT---` 分隔。

只输出测试用例的 markdown 内容，不要输出其他解释。'

# 构造完整的 prompt
USER_PROMPT="请从以下知识文件中提取 3-5 个关键知识点，为每个知识点生成测试用例。

知识文件内容：

$KNOWLEDGE_CONTENT

---

请生成 3-5 个测试用例，每个用例之间用 ---NEXT--- 分隔。"

echo "步骤 1: 用 Claude 分析知识文件并生成测试用例..."
echo ""

# 调用 Claude 生成测试用例
TEST_CASES_OUTPUT=$(echo "$USER_PROMPT" | claude -p \
  --model sonnet \
  --system-prompt "$SYSTEM_PROMPT" \
  --allowedTools "" \
  --max-budget-usd 0.5 \
  2>/dev/null)

echo "步骤 2: 解析并保存测试用例..."
echo ""

# 分割测试用例并保存
CASE_NUM=1
CURRENT_CASE=""
while IFS= read -r line; do
  if [ "$line" = "---NEXT---" ]; then
    # 保存当前测试用例
    if [ -n "$CURRENT_CASE" ]; then
      CASE_ID="${ID_PREFIX}-$(printf "%03d" $CASE_NUM)"
      CASE_FILE="$TESTS_DIR/${CASE_ID}.md"
      echo "$CURRENT_CASE" > "$CASE_FILE"
      echo "✓ 创建测试用例: $CASE_FILE"
      CASE_NUM=$((CASE_NUM + 1))
      CURRENT_CASE=""
    fi
  else
    CURRENT_CASE="${CURRENT_CASE}${line}
"
  fi
done <<< "$TEST_CASES_OUTPUT"

# 保存最后一个测试用例
if [ -n "$CURRENT_CASE" ]; then
  CASE_ID="${ID_PREFIX}-$(printf "%03d" $CASE_NUM)"
  CASE_FILE="$TESTS_DIR/${CASE_ID}.md"
  echo "$CURRENT_CASE" > "$CASE_FILE"
  echo "✓ 创建测试用例: $CASE_FILE"
fi

TOTAL_CASES=$((CASE_NUM))
echo ""
echo "共生成 $TOTAL_CASES 个测试用例"
echo ""

# 如果设置了 SKIP_TEST 环境变量，跳过测试
if [ "${SKIP_TEST:-}" = "1" ]; then
  echo "跳过测试（SKIP_TEST=1）"
  exit 0
fi

echo "步骤 3: 运行测试验证..."
echo ""

# 运行测试
"$SOUL_ROOT/test-avatar.sh" "$AVATAR_NAME"

echo ""
echo "═══════════════════════════════════════════════════"
echo "  测试用例生成完成"
echo "═══════════════════════════════════════════════════"
