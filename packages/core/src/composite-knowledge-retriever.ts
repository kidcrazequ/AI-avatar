/**
 * 合并分身全局知识目录与可选的 `projects/<id>/knowledge` 检索结果。
 *
 * @author zhi.qu
 * @date 2026-05-09
 */

import { computeCoverageHint, type KnowledgeRetriever, type KnowledgeSearchCoverage } from './knowledge-retriever'

const RRF_K = 60

export function reciprocalRankFusion(
  rankedLists: Array<Array<{ file: string; heading: string; content: string; score: number }>>,
  topN: number,
): Array<{ file: string; heading: string; content: string; score: number }> {
  const acc = new Map<string, {
    item: { file: string; heading: string; content: string; score: number }
    rrf: number
  }>()
  for (const list of rankedLists) {
    list.forEach((item, rank) => {
      const key = `${item.file}::${item.heading}`
      const add = 1 / (RRF_K + rank + 1)
      const prev = acc.get(key)
      if (prev) {
        prev.rrf += add
      } else {
        acc.set(key, { item: { ...item }, rrf: add })
      }
    })
  }
  return [...acc.values()]
    .sort((a, b) => b.rrf - a.rrf)
    .slice(0, topN)
    .map(({ item, rrf }) => ({ ...item, score: Number(rrf.toFixed(6)) }))
}

/**
 * 将「分身 knowledge」与「projects/<pid>/knowledge」视为一个逻辑检索面。
 * overlay 中的文件在 list/search 结果里带 `projects/<pid>/knowledge/` 前缀，避免与全局同名冲突。
 */
export class CompositeKnowledgeRetriever {
  constructor(
    private readonly base: KnowledgeRetriever,
    private readonly overlay: KnowledgeRetriever | null,
    private readonly overlayFilePrefix: string,
  ) {}

  searchChunks(
    query: string,
    topN: number = 5,
  ): Array<{ file: string; heading: string; content: string; score: number }> {
    return this.searchChunksWithCoverage(query, topN).chunks
  }

  /**
   * 同 {@link searchChunks}，但同时返回合并后的召回完整度信号。
   *
   * 合并规则：
   * - totalCandidates = base + overlay 候选池之和
   * - topScore = 合并 RRF 排序后的最高分（overlay 存在时强制 rrf 尺度）
   * - mode：overlay 存在 → 'rrf'；否则沿用 base 模式
   * - hint：以合并后 hits + topScore 用对应阈值重算
   */
  searchChunksWithCoverage(
    query: string,
    topN: number = 5,
  ): {
    chunks: Array<{ file: string; heading: string; content: string; score: number }>
    coverage: KnowledgeSearchCoverage
  } {
    const innerTopN = Math.max(topN * 2, topN + 4)
    const baseRes = this.base.searchChunksWithCoverage(query, innerTopN)
    if (!this.overlay) {
      const chunks = baseRes.chunks.slice(0, topN)
      const topScore = chunks[0]?.score ?? 0
      return {
        chunks,
        coverage: {
          ...baseRes.coverage,
          hits: chunks.length,
          topScore,
          hint: computeCoverageHint(chunks.length, topScore, baseRes.coverage.mode),
        },
      }
    }
    const overlayRes = this.overlay.searchChunksWithCoverage(query, innerTopN)
    const b = overlayRes.chunks.map((c) => ({
      ...c,
      file: `${this.overlayFilePrefix}${c.file}`,
    }))
    const fused = reciprocalRankFusion([baseRes.chunks, b], topN)
    const topScore = fused[0]?.score ?? 0
    return {
      chunks: fused,
      coverage: {
        hits: fused.length,
        totalCandidates: baseRes.coverage.totalCandidates + overlayRes.coverage.totalCandidates,
        topScore,
        mode: 'rrf',
        hint: computeCoverageHint(fused.length, topScore, 'rrf'),
      },
    }
  }

  readFile(relPath: string): string {
    if (this.overlay && relPath.startsWith(this.overlayFilePrefix)) {
      const rest = relPath.slice(this.overlayFilePrefix.length)
      return this.overlay.readFile(rest)
    }
    return this.base.readFile(relPath)
  }

  listFiles(): string[] {
    const b = this.base.listFiles()
    if (!this.overlay) return b
    const o = this.overlay.listFiles().map((f) => `${this.overlayFilePrefix}${f}`)
    return [...b, ...o]
  }

  async warmUpAsync(): Promise<void> {
    await this.base.warmUpAsync()
    if (this.overlay) await this.overlay.warmUpAsync()
  }

  isTokensDirty(): boolean {
    return this.base.isTokensDirty() || (this.overlay?.isTokensDirty() ?? false)
  }

  clearTokensDirty(): void {
    this.base.clearTokensDirty()
    this.overlay?.clearTokensDirty()
  }
}
