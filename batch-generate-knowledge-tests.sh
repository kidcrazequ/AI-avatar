#!/bin/bash
# batch-generate-knowledge-tests.sh - 批量从所有 knowledge 文件生成测试用例
# 用法: ./batch-generate-knowledge-tests.sh <avatar-name>

set -euo pipefail

AVATAR_NAME="${1:-}"

if [ -z "$AVATAR_NAME" ]; then
  echo "用法: ./batch-generate-knowledge-tests.sh <avatar-name>"
  echo "示例: ./batch-generate-knowledge-tests.sh ci-storage-expert"
  exit 1
fi

SOUL_ROOT="$(cd "$(dirname "$0")" && pwd)"
AVATAR_DIR="$SOUL_ROOT/avatars/$AVATAR_NAME"

[ -d "$AVATAR_DIR" ] || { echo "错误: 分身 '$AVATAR_NAME' 不存在"; exit 1; }

echo "═══════════════════════════════════════════════════"
echo "  批量生成知识测试用例"
echo "  分身: $AVATAR_NAME"
echo "═══════════════════════════════════════════════════"
echo ""

# 查找所有 knowledge 文件
KNOWLEDGE_FILES=$(find "$AVATAR_DIR/knowledge" -name "*.md" -type f)

TOTAL_FILES=$(echo "$KNOWLEDGE_FILES" | wc -l | tr -d ' ')
CURRENT=0
SUCCESS=0
FAILED=0

echo "找到 $TOTAL_FILES 个知识文件"
echo ""

for file in $KNOWLEDGE_FILES; do
  CURRENT=$((CURRENT + 1))
  REL_PATH="${file#$AVATAR_DIR/}"

  echo "[$CURRENT/$TOTAL_FILES] 处理: $REL_PATH"

  # 检查文件是否为空或只有模板
  FILE_SIZE=$(wc -l < "$file" | tr -d ' ')
  if [ "$FILE_SIZE" -lt 20 ]; then
    echo "  ⊘ 跳过（文件太小，可能是模板）"
    echo ""
    continue
  fi

  # 生成测试用例（不运行完整测试，只生成）
  if SKIP_TEST=1 "$SOUL_ROOT/generate-knowledge-tests.sh" "$AVATAR_NAME" "$REL_PATH" > /tmp/gen-output.log 2>&1; then
    SUCCESS=$((SUCCESS + 1))
    echo "  ✓ 成功"
  else
    FAILED=$((FAILED + 1))
    echo "  ✗ 失败"
    echo "  错误日志: /tmp/gen-output.log"
  fi
  echo ""
done

echo "═══════════════════════════════════════════════════"
echo "  批量生成完成"
echo "  成功: $SUCCESS"
echo "  失败: $FAILED"
echo "═══════════════════════════════════════════════════"
echo ""
echo "现在运行完整测试..."
echo ""

# 运行一次完整测试
"$SOUL_ROOT/test-avatar.sh" "$AVATAR_NAME"
