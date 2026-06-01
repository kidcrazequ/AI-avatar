/**
 * 会话树模型（借鉴 Pi Coding Agent 的树状/可分叉会话）。
 *
 * Pi 把会话存成 append-only、每条带 parentId 的树，leafId 决定"活动叶子"，回溯到根
 * 即得当前活动路径。本文件是该模型的**纯逻辑核心**：从 parentId 链算活动路径、回填线性
 * 父链、找分叉点。零 I/O，便于单测。
 *
 * 落地分期（如实说明）：本期只落"数据底座"——SQLite 加 parent_id/leaf_message_id 列、
 * 写入时维护链、读取仍线性（无分叉时活动路径 == 线性顺序，零行为变化）。真正的
 * 分叉创建 UI、按非默认叶子切换读取路径、新字段的跨端 sync，属更重的集成，留作后续。
 *
 * @author zhi.qu
 * @date 2026-06-01
 */

export interface TreeNode {
  readonly id: string
  readonly parentId?: string | null
}

/**
 * 从给定叶子沿 parentId 回溯到根，返回 **root→leaf** 顺序的活动路径。
 * 带环保护（自引用/坏数据不会死循环）；leaf 不存在或为空 → 返回空数组。
 */
export function buildActivePath<T extends TreeNode>(nodes: readonly T[], leafId: string | null | undefined): T[] {
  if (!leafId) return []
  const byId = new Map<string, T>(nodes.map((n) => [n.id, n]))
  const path: T[] = []
  const seen = new Set<string>()
  let cur: string | null | undefined = leafId
  while (cur && byId.has(cur) && !seen.has(cur)) {
    seen.add(cur)
    const node = byId.get(cur) as T
    path.push(node)
    cur = node.parentId ?? null
  }
  return path.reverse()
}

/**
 * 为按时间升序排好的线性序列回填 parentId：每条指向前一条，首条父为 null。
 * 用于迁移时把历史"扁平消息"补成退化的线性树。
 */
export function backfillLinearParents<T extends { id: string }>(
  ordered: readonly T[],
): Array<{ id: string; parentId: string | null }> {
  return ordered.map((n, i) => ({ id: n.id, parentId: i === 0 ? null : ordered[i - 1].id }))
}

/** 找出分叉点：被多于一个节点引用为 parentId 的节点 id（有多个子分支处）。 */
export function findBranchPoints<T extends TreeNode>(nodes: readonly T[]): string[] {
  const childCount = new Map<string, number>()
  for (const n of nodes) {
    const p = n.parentId
    if (p) childCount.set(p, (childCount.get(p) ?? 0) + 1)
  }
  return [...childCount.entries()].filter(([, count]) => count > 1).map(([id]) => id)
}
