/**
 * 默认 MemoryTier 工厂：从 Blueprint.memoryPolicy 装配 3 层内存实例。
 *
 * 桌面端可替换 episodic/semantic 为持久化实现（FS / SQLite）；
 * 测试 / CLI 默认全用内存层即可。
 */

import type { MemoryPolicy } from '../blueprint'
import { InMemoryLayer } from './in-memory-layer'
import type { MemoryTier } from './types'

export function makeDefaultMemoryTier(policy: MemoryPolicy): MemoryTier {
  return {
    shortTerm: new InMemoryLayer({
      ttlMs: policy.shortTermTtlSec * 1000,
      decay: false,
      maxRecords: 200,
    }),
    episodic: new InMemoryLayer({
      ttlMs: policy.episodicRetentionDays * 24 * 3600 * 1000,
      decay: policy.importanceDecay,
      halfLifeDays: 30,
      maxRecords: 5000,
    }),
    semantic: new InMemoryLayer({
      ttlMs: policy.semanticRetentionDays * 24 * 3600 * 1000,
      decay: false,
      maxRecords: 10000,
    }),
  }
}
