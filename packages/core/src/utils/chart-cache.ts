/**
 * chart-cache.ts — 图表答案持久化缓存
 *
 * 目的：对 chartConsistencyMode 命中的"同一格式化问题"做跨 session 同问同答。
 * 当用户再次问同一个格式化问题、且关键文件 (mtime, size) 快照未变时，
 * 直接返回上次的完整 assistant markdown（含 ```chart 块），完全跳过 LLM 调用。
 *
 * 与 _index 失效范式对齐：
 *   - _index/hashes.json 用 chunk 内容 FNV-1a 判断单个 chunk 是否需要重建
 *   - 本模块用关键文件 (mtimeMs, size) 快照判断整条 entry 是否还有效
 *
 * 失效策略：
 *   - 每条 entry 在写入时快照所有引用文件（Excel JSON / soul.md 等）的 mtime+size
 *   - 命中时 re-stat 所有快照文件，任一不匹配则丢弃
 *   - 不做 fs.watch、不做 TTL、不做全局版本号
 *   - 适合"用户基本不改 soul.md、偶尔 re-import Excel"的真实使用模式
 *
 * 存储：avatars/<id>/_cache/charts.json（单文件，atomic tmp+rename 写）
 *
 * @author claude + zhi.qu
 * @date 2026-04-17
 */

import fs from 'fs'
import path from 'path'

/** cache 文件相对分身根目录的路径 */
export const CHART_CACHE_REL_PATH = '_cache/charts.json'

/** 默认最大条目数；超出按 createdAt 升序淘汰最旧的 */
export const DEFAULT_MAX_CHART_CACHE_ENTRIES = 100

/** 文件快照：命中时用来验证这些文件在创建 entry 之后没变 */
export interface FileSnapshot {
  /** 绝对路径 */
  path: string
  /** mtime ms；文件当前不存在时固定 0 */
  mtimeMs: number
  /** 字节数；文件当前不存在时固定 0 */
  size: number
}

export interface ChartCacheEntry {
  /** hashQueryContent(userContent) — key 主体 */
  queryHash: string
  /** 原始 user content 前 200 字（debug 用，不参与 key） */
  queryPreview: string
  /** 最终完整 assistant markdown（必须含 ```chart 代码块） */
  assistantContent: string
  /** 命中时需验证仍一致的文件快照 */
  fileSnapshots: FileSnapshot[]
  /** 写入时刻（ms epoch），用于 LRU 淘汰 */
  createdAt: number
}

export interface ChartCache {
  version: number
  entries: ChartCacheEntry[]
}

const CACHE_VERSION = 1

/**
 * 规范化用户问题文本用于生成 cache key。
 * 只做"等价写法归一"：压缩内部空白 + 两端 trim + ASCII 小写。
 * 不去标点、不分词 —— 避免把语义不同的问题误归为同一 key。
 */
export function normalizeQueryForHash(content: string): string {
  return content
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[A-Z]/g, c => c.toLowerCase())
}

/**
 * FNV-1a 32bit hex；和 knowledge-indexer / deriveSeedFromContent 同源风格。
 */
export function hashQueryContent(content: string): string {
  const s = normalizeQueryForHash(content)
  let hash = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    hash ^= s.charCodeAt(i)
    hash = (hash * 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/**
 * 对单个文件取 (mtimeMs, size) 快照。
 * 文件不存在时保持 path 返回 {mtimeMs:0, size:0}，
 * verifier 会把"曾经不存在" vs "现在存在"也视为失效。
 */
export function captureFileSnapshot(filePath: string): FileSnapshot {
  try {
    const st = fs.statSync(filePath)
    return { path: filePath, mtimeMs: st.mtimeMs, size: st.size }
  } catch {
    return { path: filePath, mtimeMs: 0, size: 0 }
  }
}

/**
 * 验证快照列表是否仍和当前文件系统状态一致。
 * 任一 mtime 或 size 不匹配 → false。
 */
export function verifySnapshots(snapshots: FileSnapshot[]): boolean {
  for (const snap of snapshots) {
    const current = captureFileSnapshot(snap.path)
    if (current.mtimeMs !== snap.mtimeMs || current.size !== snap.size) {
      return false
    }
  }
  return true
}

/**
 * 从磁盘加载 cache；文件不存在 / 损坏 / 结构不合法时静默返回空 cache。
 */
export function loadChartCache(cachePath: string): ChartCache {
  if (!fs.existsSync(cachePath)) return { version: CACHE_VERSION, entries: [] }
  try {
    const raw = fs.readFileSync(cachePath, 'utf-8')
    const obj = JSON.parse(raw) as unknown
    if (!obj || typeof obj !== 'object') return { version: CACHE_VERSION, entries: [] }
    const cast = obj as Partial<ChartCache>
    const entries = Array.isArray(cast.entries) ? cast.entries.filter(isValidEntry) : []
    return { version: CACHE_VERSION, entries }
  } catch (err) {
    console.warn(`[chart-cache] 加载失败，忽略 cache: ${err instanceof Error ? err.message : String(err)}`)
    return { version: CACHE_VERSION, entries: [] }
  }
}

function isValidEntry(v: unknown): v is ChartCacheEntry {
  if (!v || typeof v !== 'object') return false
  const e = v as Record<string, unknown>
  return (
    typeof e.queryHash === 'string' &&
    typeof e.queryPreview === 'string' &&
    typeof e.assistantContent === 'string' &&
    Array.isArray(e.fileSnapshots) &&
    typeof e.createdAt === 'number'
  )
}

/**
 * 原子写入 cache：tmp 文件 + rename，和 knowledge-indexer 一致风格。
 * 目标目录不存在时自动创建。
 */
export function saveChartCache(cachePath: string, cache: ChartCache): void {
  const dir = path.dirname(cachePath)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  const tmpPath = cachePath + `.${Date.now()}.${process.pid}.tmp`
  fs.writeFileSync(tmpPath, JSON.stringify(cache), 'utf-8')
  try {
    fs.renameSync(tmpPath, cachePath)
  } catch (err) {
    try { fs.unlinkSync(tmpPath) } catch { /* 清理失败不阻塞 */ }
    throw err
  }
}

/**
 * 按 queryHash 查找并用 verifier 验证；任一步失败返回 null。
 * 本函数不修改 cache（不删过期 entry，留给 insert 时的 LRU 或手动清理）。
 */
export function findChartCacheHit(
  cache: ChartCache,
  queryHash: string,
  verifier: (entry: ChartCacheEntry) => boolean = e => verifySnapshots(e.fileSnapshots),
): ChartCacheEntry | null {
  const entry = cache.entries.find(e => e.queryHash === queryHash)
  if (!entry) return null
  if (!verifier(entry)) return null
  return entry
}

/**
 * 插入或替换 entry。
 * - 同 queryHash 存在 → 替换为新 entry
 * - 超出 maxEntries → 淘汰 createdAt 最小的旧 entry
 * - 返回新 ChartCache（immutable 风格；原对象保持不变）
 */
export function insertChartCacheEntry(
  cache: ChartCache,
  entry: ChartCacheEntry,
  maxEntries: number = DEFAULT_MAX_CHART_CACHE_ENTRIES,
): ChartCache {
  const filtered = cache.entries.filter(e => e.queryHash !== entry.queryHash)
  filtered.push(entry)
  if (filtered.length > maxEntries) {
    filtered.sort((a, b) => a.createdAt - b.createdAt)
    filtered.splice(0, filtered.length - maxEntries)
  }
  return { version: CACHE_VERSION, entries: filtered }
}
