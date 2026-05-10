/**
 * 合并分身全局知识目录与可选的 `projects/<id>/knowledge` 检索结果。
 *
 * @author zhi.qu
 * @date 2026-05-09
 */

import type { KnowledgeRetriever } from './knowledge-retriever'

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
    const a = this.base.searchChunks(query, Math.max(topN * 2, topN + 4))
    if (!this.overlay) {
      return a.slice(0, topN)
    }
    const rawB = this.overlay.searchChunks(query, Math.max(topN * 2, topN + 4))
    const b = rawB.map((c) => ({
      ...c,
      file: `${this.overlayFilePrefix}${c.file}`,
    }))
    return reciprocalRankFusion([a, b], topN)
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
