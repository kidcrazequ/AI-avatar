/**
 * 会话树版本切换器的纯逻辑（v21·phase2，借鉴 Pi 树状会话）。
 *
 * 渲染端拿到轻量会话树（getConversationTree）后，靠这两个纯函数算：
 *   - computeBranchInfo：某条消息在"同父同角色兄弟"里的版本序号/总数（决定要不要显示 ‹k/n›）。
 *   - findBranchTip：切到某分支时，把活动叶子设到该分支最深、最近活动的尖端。
 * 纯函数、可单测；UI 只负责把结果渲染成 ‹ › 切换条 + 调 forkConversation。
 *
 * @author zhi.qu
 * @date 2026-06-02
 */

export interface TreeNodeLite {
  id: string
  parentId: string | null
  role: string
  createdAt: number
}

export interface BranchInfo {
  /** 当前消息在兄弟版本里的下标（0-based） */
  index: number
  /** 兄弟版本总数（>1 才需要切换器） */
  total: number
  /** 兄弟版本 id，按 createdAt 升序（用于 ‹ › 定位上一个/下一个） */
  siblings: string[]
}

function cmp(a: TreeNodeLite, b: TreeNodeLite): number {
  return a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
}

/**
 * 算某消息的分支版本信息：同 parentId、同 role 的兄弟即"同一轮的不同版本"。
 * 只有一个版本（无分叉）时返回 null —— UI 据此不显示切换器。
 */
export function computeBranchInfo(tree: readonly TreeNodeLite[], messageId: string): BranchInfo | null {
  const node = tree.find((n) => n.id === messageId)
  if (!node) return null
  const siblings = tree
    .filter((n) => n.parentId === node.parentId && n.role === node.role)
    .sort(cmp)
  if (siblings.length <= 1) return null
  const index = siblings.findIndex((s) => s.id === messageId)
  return { index, total: siblings.length, siblings: siblings.map((s) => s.id) }
}

/**
 * 从某消息沿"最近创建的子"一路向下到叶子，得到该分支的活动尖端。
 * 切换分支时把 leaf 设到这里（而非分支根），才能恢复该分支后续可能追加的多轮。带环保护。
 */
export function findBranchTip(tree: readonly TreeNodeLite[], messageId: string): string {
  const childrenByParent = new Map<string, TreeNodeLite[]>()
  for (const n of tree) {
    if (n.parentId) {
      const arr = childrenByParent.get(n.parentId)
      if (arr) arr.push(n)
      else childrenByParent.set(n.parentId, [n])
    }
  }
  let cur = messageId
  const seen = new Set<string>()
  while (!seen.has(cur)) {
    seen.add(cur)
    const kids = childrenByParent.get(cur)
    if (!kids || kids.length === 0) break
    // 选最近创建的子继续向下（最近活动的那条分支）
    const next = [...kids].sort((a, b) => -cmp(a, b))[0]
    cur = next.id
  }
  return cur
}
