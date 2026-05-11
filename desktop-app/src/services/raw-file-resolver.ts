/**
 * 渲染层：把 LLM 引用 `[来源: knowledge/<file>.md...]` 文本块里所有 .md 路径
 * 提取出来（提取式，不再追逐 LLM 自由格式），并对每个路径独立解析对应原始
 * 源文件（_raw/<file>.pdf 等）元信息。带本地 LRU 缓存。
 *
 * 设计要点：
 * 1. **提取阶段**（`extractMdPathsFromAnchor`）：用 `String.prototype.matchAll`
 *    全局扫描 anchor 文本里所有 `knowledge/<path>.md` 命中，去重后返回。负向
 *    先行断言排除 `knowledge/_excel/`（Excel JSON 走另一套展开链路）。
 * 2. **解析阶段**（`resolveRawFile`）：入参就是单个 .md 路径（提取阶段的产物
 *    之一），LRU 缓存命中直接返回；未命中则走 `window.electronAPI.resolveRawFile`
 *    IPC。主进程返回 null 也写缓存（"已知没有 raw_file"短路），抛错则不写
 *    缓存（保留下次重试机会）。
 * 3. 渲染层接口拆成两个，使「单 anchor 含多个 .md 文件」场景下的并发解析逻辑
 *    （`Promise.all(paths.map(p => resolveRawFile(avatarId, p)))`）由调用方掌控。
 *
 * @author zhi.qu
 * @date 2026-05-06
 */

import type {
  ResolveRawFileResult,
  ResolveRawFileFn,
  ExtractMdPathsFromAnchorFn,
} from '../types/raw-file-anchor'

/**
 * 全局扫描 `knowledge/<path>.md`：
 * - `knowledge/` 前缀固定字面量
 * - `(?!_excel\/)` 负向先行断言，排除 `knowledge/_excel/` 路径
 * - `([^,，、;；\s\]#]+\.md)` 捕获相对路径，字符类排除半角逗号 / 全角逗号 /
 *   顿号 / 半角分号 / 全角分号 / 任意空白 / `]` / `#`，确保命中以 `.md` 结尾的最长合法段
 * - 全局 `g` flag，配合 `matchAll` 一次拿到 anchor 里所有命中
 */
const MD_PATH_GLOBAL_REGEX = /knowledge\/(?!_excel\/)([^,，、;；\s\]#]+\.md)/g

/**
 * LRU 上限：覆盖典型一次会话中所有引用，超过则按插入顺序淘汰最早项。
 */
const MAX_CACHE_ENTRIES = 256

/**
 * 简单 LRU：Map 的迭代顺序 = 插入顺序，命中时先 delete 再 set 把 key 顶到末尾，
 * 满时淘汰 `keys().next().value`（最早插入项）。
 *
 * value 允许为 null，表示"主进程已确认没有 raw_file"，下次直接短路。
 */
const rawFileCache = new Map<string, ResolveRawFileResult | null>()

/**
 * 读缓存。命中则把 key 顶到末尾（LRU touch），未命中返回 undefined（与 null 区分）。
 */
function cacheGet(key: string): ResolveRawFileResult | null | undefined {
  if (!rawFileCache.has(key)) return undefined
  const value = rawFileCache.get(key) ?? null
  rawFileCache.delete(key)
  rawFileCache.set(key, value)
  return value
}

/**
 * 写缓存。已存在则先删再插（保证顺序），超过上限淘汰最早项。
 */
function cacheSet(key: string, value: ResolveRawFileResult | null): void {
  if (rawFileCache.has(key)) rawFileCache.delete(key)
  rawFileCache.set(key, value)
  while (rawFileCache.size > MAX_CACHE_ENTRIES) {
    const firstKey = rawFileCache.keys().next().value
    if (firstKey === undefined) break
    rawFileCache.delete(firstKey)
  }
}

/**
 * 清空缓存。仅用于测试或手动刷新场景。
 */
export function clearRawFileCache(): void {
  rawFileCache.clear()
}

/**
 * 主进程注入的解析函数签名（与 preload 暴露的形状对齐）。
 * 与 `ResolveRawFileFn` 同形，但单独命名以隔离"渲染层对外 API"和"IPC bridge"。
 */
type IpcResolveRawFileFn = (
  avatarId: string,
  mdRelativePath: string,
) => Promise<ResolveRawFileResult | null>

/**
 * 从全局 window 上获取 electronAPI.resolveRawFile。
 * SSR / Node 测试环境 window 不存在时返回 undefined，由调用方降级。
 */
function getResolveRawFile(): IpcResolveRawFileFn | undefined {
  const win = globalThis as unknown as {
    window?: { electronAPI?: { resolveRawFile?: IpcResolveRawFileFn } }
  }
  return win.window?.electronAPI?.resolveRawFile
}

/**
 * 提取阶段：从完整 anchor 文本块全局扫描所有 `knowledge/<path>.md` 路径。
 *
 * - 用 `matchAll` + 全局正则一次拿到所有命中
 * - group 1 是不含 `knowledge/` 前缀的相对路径
 * - 用 Set 去重，保留首次出现顺序（多文件 anchor 里同一路径只保留第一次出现）
 * - 没有任何命中（普通文本 / 仅 `_excel/` 引用）时返回空数组 `[]`
 *
 * @param anchor 完整 anchor 字符串，如 `[来源: knowledge/a.md, knowledge/b.md#第7页]`
 * @returns 去重后的 .md 相对路径数组（不含 `knowledge/` 前缀）
 */
export const extractMdPathsFromAnchor: ExtractMdPathsFromAnchorFn = (anchor) => {
  const seen = new Set<string>()
  const result: string[] = []
  for (const match of anchor.matchAll(MD_PATH_GLOBAL_REGEX)) {
    const path = match[1]
    if (!seen.has(path)) {
      seen.add(path)
      result.push(path)
    }
  }
  return result
}

/**
 * 解析阶段：单个 .md 路径 → 原始源文件元信息。
 *
 * - 缓存命中（含 null 命中）→ 直接返回
 * - IPC 未注入（SSR / 测试环境）→ 返回 null，不写缓存（保留环境就绪后再试的机会）
 * - IPC 抛错 → console.error + 返回 null，不写缓存（让调用方下次重试）
 * - IPC 正常返回（含返回 null）→ 写缓存
 *
 * @param avatarId 分身 ID（专家包或 avatars 目录名），如 `小堵-工商储专家`
 * @param mdRelativePath 相对 `<avatar>/knowledge/` 的 .md 路径，**不含** `knowledge/` 前缀
 */
export const resolveRawFile: ResolveRawFileFn = async (avatarId, mdRelativePath) => {
  const cacheKey = `${avatarId}:${mdRelativePath}`

  const cached = cacheGet(cacheKey)
  if (cached !== undefined) return cached

  const ipcFn = getResolveRawFile()
  if (!ipcFn) return null

  try {
    const result = await ipcFn(avatarId, mdRelativePath)
    cacheSet(cacheKey, result)
    return result
  } catch (err) {
    console.error('[raw-file-resolver] resolveRawFile failed:', err)
    return null
  }
}
