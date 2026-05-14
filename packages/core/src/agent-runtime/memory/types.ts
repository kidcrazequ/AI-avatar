/**
 * Memory 3 层抽象（PAP 风格）：
 *
 *   - ShortTerm：当前会话/任务的临时上下文（TTL 秒级，默认 1h）
 *   - Episodic：事件级（对话摘要、子任务结果），TTL 默认 1 年，支持衰减
 *   - Semantic：事实级（结构化知识、用户偏好），TTL 默认 5 年
 *
 * 设计原则：
 *   - 接口而非实现 — 桌面端 adapter 把 life / structured-memory / 对话窗口
 *     挂到这 3 个接口上
 *   - 一致的读写 API：put / get / list / forget
 *   - importance 字段在 episodic 上启用衰减（life 的语义）
 *
 * 与旧 memory-manager 共存：旧路径继续读写 memory/MEMORY.md，新路径走本层接口。
 */

export interface MemoryRecord<T = unknown> {
  /** 全局唯一 id（caller 提供或 layer 内生成） */
  id: string
  /** 创建时间戳（ms） */
  createdAt: number
  /** 最近访问时间戳（用于衰减计算） */
  lastAccessedAt: number
  /** 0..1，越高越重要；episodic/semantic 用于衰减加权 */
  importance: number
  /** 该记录所属 agent id，便于多分身隔离 */
  agentId: string
  /** 业务载荷 */
  value: T
  /** 自由标签，便于检索 */
  tags?: string[]
}

export interface MemoryQuery {
  agentId: string
  tags?: string[]
  /** 返回前 N 条；按 (importance × recency) 综合排序 */
  topK?: number
  /** 仅返回 importance ≥ 阈值的 */
  minImportance?: number
}

export interface MemoryLayer<T = unknown> {
  put(record: Omit<MemoryRecord<T>, 'createdAt' | 'lastAccessedAt'> & { createdAt?: number; lastAccessedAt?: number }): Promise<MemoryRecord<T>>
  get(id: string, agentId: string): Promise<MemoryRecord<T> | null>
  list(query: MemoryQuery): Promise<MemoryRecord<T>[]>
  forget(id: string, agentId: string): Promise<boolean>
  /** 强制清理过期记录；返回清理条数 */
  prune(now?: number): Promise<number>
}

export interface MemoryTier {
  shortTerm: MemoryLayer
  episodic: MemoryLayer
  semantic: MemoryLayer
}
