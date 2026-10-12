/**
 * 知识检索策略决策（借鉴 Pi Coding Agent 的渐进式知识披露）。
 *
 * 现状（重要）：chat 路径已于 2026-05-13 改为 agentic-only —— pre-message BM25 注入
 * 早已删除，知识只通过 search_knowledge 等工具按需进入。
 *
 * 本文件提供剩下那半边（"小库整库进 cacheable stable prompt，享 prompt cache"）所需的
 * **决策层**：给定知识库体量，决定走 'stable-full'（整库进稳定段）还是 'agentic'（维持
 * on-demand 工具检索）。决策是纯函数、可单测；真正把内容注入 stable prompt 的接线属召回
 * 敏感的 Phase-2，须 eval 守门，由 SOUL_USE_STABLE_KNOWLEDGE_PROMPT 控制（默认关）。
 *
 * @author zhi.qu
 * @date 2026-06-01
 */

export type KnowledgeStrategy = 'stable-full' | 'agentic'

/**
 * 小库阈值（字符数）。低于等于此值才考虑整库进 stable prompt——再大就会撑爆 cacheable 前缀、
 * 反而拖累 prompt cache。200k 字符约对应数万 token，是个保守起点，实测后可调。
 */
export const DEFAULT_SMALL_LIBRARY_CHAR_THRESHOLD = 200_000

export interface DecideKnowledgeStrategyOptions {
  /** 小库阈值，缺省 DEFAULT_SMALL_LIBRARY_CHAR_THRESHOLD。 */
  thresholdChars?: number
  /** 稳定知识 prompt 是否启用（来自 isStableKnowledgePromptEnabled），缺省 false。 */
  enabled?: boolean
}

/**
 * 决定知识检索策略。flag 关闭时一律 'agentic'（维持现状，零行为变化）；
 * 仅当启用且库体量 ≤ 阈值时才返回 'stable-full'。非正的体量按 'agentic' 处理（无内容可注入）。
 */
export function decideKnowledgeStrategy(
  libraryChars: number,
  opts?: DecideKnowledgeStrategyOptions,
): KnowledgeStrategy {
  const enabled = opts?.enabled ?? false
  if (!enabled) return 'agentic'
  if (!Number.isFinite(libraryChars) || libraryChars <= 0) return 'agentic'
  const threshold = opts?.thresholdChars ?? DEFAULT_SMALL_LIBRARY_CHAR_THRESHOLD
  return libraryChars <= threshold ? 'stable-full' : 'agentic'
}
