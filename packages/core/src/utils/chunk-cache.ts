/**
 * chunk-cache.ts — BM25 token 缓存持久化
 *
 * 把 KnowledgeRetriever 的 chunk tokens 序列化到 `_index/tokens.json`，
 * 让重启 / 跨 session 的首次 search_knowledge 跳过 segmentit 中文分词的 CPU 重活。
 *
 * 性能对比（实测 233 文件 / 4.5 MB CJK）：
 *   - 无 cache：30-180 秒（main process 100% CPU 单线程分词）
 *   - 有 cache：< 2 秒（直接 JSON 加载到内存）
 *
 * 失效策略：
 *   - chunk key 用 `file::heading`，文件改名 / 标题改 → 自动 cache miss → 重新 tokenize
 *   - 配合 `_index/hashes.json` 文件 hash 验证：hash 变了的 chunk 丢弃 cache
 *   - JSON 损坏时静默 fallback 到全量 tokenize（不崩）
 *
 * @author zhi.qu
 * @date 2026-04-14
 */

import fs from 'fs'
import path from 'path'

/** tokens.json 文件名 */
export const TOKENS_FILE = 'tokens.json'

/**
 * 持久化序列化格式：{ "file::heading": ["token1", "token2", ...] }
 * key 和其他 _index/ 文件（contexts.json / embeddings.json / hashes.json）保持一致。
 */
export type PersistedTokens = Record<string, string[]>

/**
 * 从 `<knowledgePath>/_index/tokens.json` 加载 token 缓存。
 * - 文件不存在：返回 null（首次构建）
 * - 文件损坏：返回 null（fallback 到重新分词），并 console.warn
 * - 类型不合法（不是 string[][]):跳过该项，其他保留
 */
export function loadTokensCache(indexDir: string): Map<string, string[]> | null {
  const p = path.join(indexDir, TOKENS_FILE)
  if (!fs.existsSync(p)) return null
  try {
    const raw = fs.readFileSync(p, 'utf-8')
    const obj = JSON.parse(raw) as unknown
    if (typeof obj !== 'object' || obj === null) return null
    const map = new Map<string, string[]>()
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (Array.isArray(v) && v.every((t): t is string => typeof t === 'string')) {
        map.set(k, v)
      }
    }
    return map
  } catch (err) {
    console.warn(`[chunk-cache] tokens.json 加载失败，将重新分词: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}

/**
 * 把 token 缓存原子写入 `<knowledgePath>/_index/tokens.json`。
 * 复用 knowledge-indexer 的原子写模式：先写临时文件再 rename，防止进程崩溃损坏。
 *
 * 设计选择：JSON 不缩进（节省磁盘空间，加载更快）。
 * 233 文件 / 4.5MB CJK 实测：tokens.json 约 1-3 MB，加载 < 50 ms。
 */
export function saveTokensCache(indexDir: string, tokens: Map<string, string[]>): void {
  if (!fs.existsSync(indexDir)) {
    fs.mkdirSync(indexDir, { recursive: true })
  }
  const obj: PersistedTokens = {}
  for (const [k, v] of tokens) obj[k] = v
  const targetPath = path.join(indexDir, TOKENS_FILE)
  const tmpPath = targetPath + `.${Date.now()}.${process.pid}.tmp`
  fs.writeFileSync(tmpPath, JSON.stringify(obj), 'utf-8')
  try {
    fs.renameSync(tmpPath, targetPath)
  } catch (err) {
    try { fs.unlinkSync(tmpPath) } catch { /* 清理失败不阻塞 */ }
    throw err
  }
}
