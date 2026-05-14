/**
 * 内存 MemoryLayer 实现（测试 / 桌面端默认）。
 *
 * 三层差异由构造参数 ttlMs + decay 控制：
 *   - shortTerm: ttlMs = 3600_000，decay = false（硬过期）
 *   - episodic:  ttlMs = 365d，decay = true（衰减权重影响排序）
 *   - semantic:  ttlMs = 5y，decay = false（事实型）
 */

import type { MemoryLayer, MemoryQuery, MemoryRecord } from './types'

export interface InMemoryLayerOptions {
  /** 记录硬过期时长（ms）；null 表示永不过期 */
  ttlMs: number | null
  /** 是否对 importance 应用时间衰减（episodic 用） */
  decay: boolean
  /** 半衰期天数（默认 30 天，importance 每 N 天减半） */
  halfLifeDays?: number
  /** 容量上限；超出时按综合分数最低的剔除 */
  maxRecords?: number
}

export class InMemoryLayer<T = unknown> implements MemoryLayer<T> {
  private store = new Map<string, MemoryRecord<T>>()
  private opts: Required<Omit<InMemoryLayerOptions, 'ttlMs'>> & { ttlMs: number | null }

  constructor(opts: InMemoryLayerOptions) {
    this.opts = {
      ttlMs: opts.ttlMs,
      decay: opts.decay,
      halfLifeDays: opts.halfLifeDays ?? 30,
      maxRecords: opts.maxRecords ?? 10000,
    }
  }

  async put(
    record: Omit<MemoryRecord<T>, 'createdAt' | 'lastAccessedAt'> & {
      createdAt?: number
      lastAccessedAt?: number
    }
  ): Promise<MemoryRecord<T>> {
    const now = Date.now()
    const r: MemoryRecord<T> = {
      ...record,
      createdAt: record.createdAt ?? now,
      lastAccessedAt: record.lastAccessedAt ?? now,
    }
    this.store.set(this.key(r.id, r.agentId), r)
    await this.enforceCapacity()
    return r
  }

  async get(id: string, agentId: string): Promise<MemoryRecord<T> | null> {
    const key = this.key(id, agentId)
    const r = this.store.get(key)
    if (!r) return null
    if (this.isExpired(r)) {
      this.store.delete(key)
      return null
    }
    r.lastAccessedAt = Date.now()
    return r
  }

  async list(query: MemoryQuery): Promise<MemoryRecord<T>[]> {
    const minImp = query.minImportance ?? 0
    const items: Array<{ rec: MemoryRecord<T>; score: number }> = []
    for (const r of this.store.values()) {
      if (r.agentId !== query.agentId) continue
      if (this.isExpired(r)) continue
      if (query.tags && query.tags.length > 0) {
        if (!query.tags.some((t) => r.tags?.includes(t))) continue
      }
      if (r.importance < minImp) continue
      items.push({ rec: r, score: this.score(r) })
    }
    items.sort((a, b) => b.score - a.score)
    const limit = query.topK ?? items.length
    return items.slice(0, limit).map((i) => i.rec)
  }

  async forget(id: string, agentId: string): Promise<boolean> {
    return this.store.delete(this.key(id, agentId))
  }

  async prune(now: number = Date.now()): Promise<number> {
    let removed = 0
    for (const [key, r] of this.store) {
      if (this.isExpired(r, now)) {
        this.store.delete(key)
        removed++
      }
    }
    return removed
  }

  // ── 内部 ──────────────────────────────────────────────────────────────

  private key(id: string, agentId: string): string {
    return `${agentId}::${id}`
  }

  private isExpired(r: MemoryRecord<T>, now: number = Date.now()): boolean {
    if (this.opts.ttlMs === null) return false
    return now - r.createdAt > this.opts.ttlMs
  }

  /** 综合排序分：importance × recencyWeight。episodic 启用衰减时按半衰期衰减。 */
  private score(r: MemoryRecord<T>): number {
    if (!this.opts.decay) return r.importance
    const ageDays = (Date.now() - r.lastAccessedAt) / (24 * 3600 * 1000)
    const decayFactor = Math.pow(0.5, ageDays / this.opts.halfLifeDays)
    return r.importance * decayFactor
  }

  private async enforceCapacity(): Promise<void> {
    if (this.store.size <= this.opts.maxRecords) return
    const sorted = [...this.store.entries()].sort((a, b) => this.score(a[1]) - this.score(b[1]))
    const toRemove = sorted.slice(0, this.store.size - this.opts.maxRecords)
    for (const [k] of toRemove) this.store.delete(k)
  }
}
