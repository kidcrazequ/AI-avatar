/**
 * Intelligent Skill Selection (ISS)：在工具数超过 topN 时，用 query 与工具描述的
 * embedding 余弦相似度筛选 topN，降低 LLM tools 载荷 token。
 *
 * - 仅在 `tools.length > topN` 时重排，否则原样返回。
 * - `list_mcp_tools` / `call_mcp_tool` / `todo_write` / `load_skill` 默认钉住，不参与淘汰。
 * - Embedding 调用由注入的 {@link EmbeddingCallFn} 提供（与 knowledge-indexer 同源签名）。
 *
 * @author zhi.qu
 * @date 2026-05-09
 */

import type { ToolForRerank } from './skill-reranker-types'
import { buildToolDocForEmbedding, stableToolDocHash } from './utils/skill-embedding-store'

/** 与 knowledge-indexer 一致；在此重复声明避免浏览器入口依赖 indexer 的文件系统 import。 */
export type EmbeddingCallFn = (texts: string[]) => Promise<number[][]>

export type { ToolForRerank } from './skill-reranker-types'

/** 默认注入 LLM 的工具条数上限（AnythingLLM PR #5236 对齐）。 */
export const ISS_DEFAULT_TOP_N = 15

/** 默认始终保留的网关 / 编排类工具，避免 ISS 删掉 MCP 入口。 */
export const ISS_DEFAULT_PINNED_TOOL_NAMES: ReadonlySet<string> = new Set([
  'list_mcp_tools',
  'call_mcp_tool',
  'todo_write',
  'load_skill',
])

/** 单次 embedding API 请求的文本条数上限（与 buildKnowledgeIndex 默认批大小同量级）。 */
const DEFAULT_EMBED_BATCH = 10

export interface SkillRerankerOptions {
  topN?: number
  embedBatchSize?: number
  /** 为空则使用 {@link ISS_DEFAULT_PINNED_TOOL_NAMES} */
  pinnedToolNames?: ReadonlySet<string>
  /** Query 最长字符（避免超长用户输入撑爆单次 embedding） */
  maxQueryChars?: number
}

function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  const len = Math.min(a.length, b.length)
  if (len === 0) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < len; i++) {
    const x = a[i]!
    const y = b[i]!
    dot += x * y
    na += x * x
    nb += y * y
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb)
  return denom === 0 ? 0 : dot / denom
}

/**
 * ISS 核心类：embedding + 向量缓存 Map（由调用方持有并负责持久化）。
 */
export class SkillReranker<T extends ToolForRerank> {
  private readonly pinned: ReadonlySet<string>

  constructor(
    private readonly callEmbedding: EmbeddingCallFn,
    private readonly embeddingCache: Map<string, number[]>,
    private readonly opts: SkillRerankerOptions = {},
  ) {
    this.pinned = opts.pinnedToolNames ?? ISS_DEFAULT_PINNED_TOOL_NAMES
  }

  /**
   * 当工具总数大于 topN 时，保留钉住工具 + 与其余工具的相似度 top 剩余槽位；否则返回副本。
   */
  async rerank(query: string, tools: readonly T[]): Promise<T[]> {
    const topN = this.opts.topN ?? ISS_DEFAULT_TOP_N
    if (tools.length <= topN) {
      return [...tools]
    }

    const maxQ = this.opts.maxQueryChars ?? 8000
    const qText = query.length > maxQ ? query.slice(0, maxQ) : query
    const embedBatch = Math.max(1, this.opts.embedBatchSize ?? DEFAULT_EMBED_BATCH)

    const name = (t: T) => t.function.name
    const desc = (t: T) => t.function.description ?? ''

    const pinnedList: T[] = []
    const pool: T[] = []
    for (const t of tools) {
      if (this.pinned.has(name(t))) pinnedList.push(t)
      else pool.push(t)
    }

    if (pinnedList.length >= topN) {
      return [...pinnedList.slice(0, topN)]
    }

    const remaining = topN - pinnedList.length
    if (pool.length <= remaining) {
      return [...pinnedList, ...pool]
    }

    let queryVec: number[]
    try {
      ;[queryVec] = await this.callEmbedding([qText])
    } catch {
      return [...tools]
    }
    if (!queryVec || queryVec.length === 0) {
      return [...tools]
    }

    const docFor = (t: T) => buildToolDocForEmbedding(name(t), desc(t))
    const hashFor = (t: T) => stableToolDocHash(name(t), desc(t))

    const needEmbed: T[] = []
    for (const t of pool) {
      const h = hashFor(t)
      if (!this.embeddingCache.has(h)) needEmbed.push(t)
    }

    for (let i = 0; i < needEmbed.length; i += embedBatch) {
      const chunk = needEmbed.slice(i, i + embedBatch)
      const texts = chunk.map(docFor)
      try {
        const vectors = await this.callEmbedding(texts)
        for (let j = 0; j < chunk.length; j++) {
          const vec = vectors[j]
          const t = chunk[j]!
          if (vec && vec.length > 0) {
            this.embeddingCache.set(hashFor(t), vec)
          }
        }
      } catch {
        return [...tools]
      }
    }

    const scored = pool.map((t) => {
      const vec = this.embeddingCache.get(hashFor(t))
      const score = vec && vec.length > 0 ? cosineSimilarity(queryVec, vec) : -1
      return { t, score }
    })
    scored.sort((a, b) => b.score - a.score)
    const picked = scored.slice(0, remaining).map(s => s.t)

    const seen = new Set(picked.map(name))
    const stablePinned = pinnedList.filter((t) => !seen.has(name(t)))
    return [...stablePinned, ...picked]
  }
}
