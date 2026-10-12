/**
 * ISS 工具描述 embedding 向量持久化助手（纯函数，无 Node 内建依赖）。
 *
 * 供渲染进程写入 localStorage 或 Node 侧写入文件前统一序列化格式；
 * key 为 {@link stableToolDocHash}，value 为与 DashScope text-embedding-v3 对齐的向量。
 *
 * @author zhi.qu
 * @date 2026-05-09
 */

/** localStorage / 持久化 JSON 的 schema 版本 */
const STORE_VERSION = 1 as const

export interface SkillEmbeddingPersistedV1 {
  v: typeof STORE_VERSION
  /** hash -> 向量（JSON 对象为 string key） */
  entries: Record<string, number[]>
}

const DEFAULT_MAX_ENTRIES = 640

/**
 * FNV-1a 32-bit：仅依赖字符串，浏览器 / Node 通用，避免 `crypto` 子系统差异。
 */
export function stableToolDocHash(toolName: string, description: string): string {
  const text = `${toolName}\n${description}`
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

/** 构造与 embedding 请求一致的文档串（名称 + 描述） */
export function buildToolDocForEmbedding(toolName: string, description: string): string {
  return `${toolName}\n${description}`
}

/**
 * 将持久化 JSON 解析为内存 Map；非法输入返回空 Map。
 */
export function parseSkillEmbeddingCacheJson(raw: string | null | undefined): Map<string, number[]> {
  const map = new Map<string, number[]>()
  if (raw === null || raw === undefined || raw.trim() === '') return map
  try {
    const obj = JSON.parse(raw) as unknown
    if (typeof obj !== 'object' || obj === null) return map
    const v = (obj as SkillEmbeddingPersistedV1).v
    const entries = (obj as SkillEmbeddingPersistedV1).entries
    if (v !== STORE_VERSION || typeof entries !== 'object' || entries === null) return map
    for (const [k, vec] of Object.entries(entries)) {
      if (Array.isArray(vec) && vec.every((n): n is number => typeof n === 'number' && Number.isFinite(n))) {
        map.set(k, vec)
      }
    }
    return map
  } catch {
    return map
  }
}

/**
 * 序列化为 JSON 字符串（紧凑，无缩进）。
 */
export function serializeSkillEmbeddingCacheJson(map: Map<string, number[]>): string {
  const entries: Record<string, number[]> = {}
  for (const [k, v] of map) entries[k] = v
  const payload: SkillEmbeddingPersistedV1 = { v: STORE_VERSION, entries }
  return JSON.stringify(payload)
}

/**
 * 限制缓存体积：超过 maxEntries 时从 Map 迭代序前端删除（相当于淘汰最旧批次）。
 */
export function trimSkillEmbeddingCache(map: Map<string, number[]>, maxEntries: number = DEFAULT_MAX_ENTRIES): void {
  while (map.size > maxEntries) {
    const first = map.keys().next().value
    if (first === undefined) break
    map.delete(first)
  }
}
