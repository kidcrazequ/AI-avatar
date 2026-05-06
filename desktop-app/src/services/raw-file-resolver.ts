/**
 * 渲染层：把 LLM 引用 anchor `[来源: knowledge/<file>.md...]` 解析成对应原始
 * 源文件（_raw/<file>.pdf 等）元信息。带本地缓存，避免每条消息渲染都走 IPC。
 *
 * 实现策略：
 * 1. 用本地宽松正则提取 .md 文件路径（兼容 #L行号 / #章节名 / #section=xxx /
 *    无 # 后缀等所有 LLM 实际产出的格式；不复用 source-anchor-resolver 的严格
 *    `#L行号` 正则——那个用于 mustContain 行级断言，对原文件展开过严）
 * 2. 命中 LRU 缓存（key = `${avatarId}:${mdRelativePath}`）→ 直接返回
 * 3. 未命中 → 走 window.electronAPI.resolveRawFile(...)
 * 4. 主进程返回 null 也要缓存（标记"已知没有 raw_file"，避免重复请求）
 *
 * 排除：knowledge/_excel/ 路径（那是 Excel JSON 引用，原文件由别的链路处理）。
 * 不可解析（非 knowledge .md anchor / IPC 未注入）→ 返回 null，不写缓存。
 *
 * @author zhi.qu
 * @date 2026-05-06
 */

import type { ResolveRawFileResult, ResolveRawFileForAnchorFn } from '../types/raw-file-anchor'

/**
 * 宽松匹配 `[来源: knowledge/<path>.md...]`：
 * - 必须以 `.md` 结尾（路径段最后一个 `.md` 之前的全部内容是文件路径）
 * - `.md` 之后的任意 `#xxx` / `&xxx` / 空白 都算 anchor 的"段内定位"，不影响文件识别
 * - 排除 `_excel/` 前缀（Excel JSON 走另一套展开逻辑）
 *
 * 例：
 *   `[来源: knowledge/foo.md#L12-L20]`               → file=foo.md
 *   `[来源: knowledge/foo.md#2. 设备布局图]`          → file=foo.md
 *   `[来源: knowledge/sub/foo.md#section=xxx]`       → file=sub/foo.md
 *   `[来源: knowledge/foo.md]`                        → file=foo.md
 *   `[来源: knowledge/_excel/x.json#sheet=A&rows=1]` → 不匹配
 */
const KNOWLEDGE_MD_ANCHOR_REGEX = /^\[来源:\s*knowledge\/((?!_excel\/)[^\]]+?\.md)(?:[#\s][^\]]*)?\]$/

/** LRU 上限：覆盖典型一次会话中所有引用，超过则按插入顺序淘汰最早项 */
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

/** 主进程注入的解析函数签名（与 preload 暴露的形状对齐） */
type ResolveRawFileFn = (avatarId: string, mdRelativePath: string) => Promise<ResolveRawFileResult | null>

/**
 * 从全局 window 上获取 electronAPI.resolveRawFile。
 * SSR / Node 测试环境 window 不存在时返回 undefined，由调用方降级。
 */
function getResolveRawFile(): ResolveRawFileFn | undefined {
  const win = globalThis as unknown as {
    window?: { electronAPI?: { resolveRawFile?: ResolveRawFileFn } }
  }
  return win.window?.electronAPI?.resolveRawFile
}

/**
 * 渲染层 anchor → 原始源文件解析器主入口。
 *
 * - anchor 不是 knowledge 类型（excel / 非法 / 缺失） → 直接返回 null，不写缓存
 * - 缓存命中 → 直接返回（包括 null 命中）
 * - IPC 未注入 → 返回 null，不写缓存（保留下次环境就绪后再试的机会）
 * - IPC 抛错 → console.error + 返回 null，不写缓存（让调用方下次重试）
 * - IPC 正常返回（含返回 null）→ 写缓存
 */
export const resolveRawFileForAnchor: ResolveRawFileForAnchorFn = async (avatarId, anchor) => {
  const match = anchor.trim().match(KNOWLEDGE_MD_ANCHOR_REGEX)
  if (!match) return null

  const mdRelativePath = match[1]
  const cacheKey = `${avatarId}:${mdRelativePath}`

  const cached = cacheGet(cacheKey)
  if (cached !== undefined) return cached

  const resolver = getResolveRawFile()
  if (!resolver) return null

  try {
    const result = await resolver(avatarId, mdRelativePath)
    cacheSet(cacheKey, result)
    return result
  } catch (err) {
    // 主进程报错（路径越界 / 文件不存在等）→ 不缓存，返回 null 让 UI 降级
    console.error('[raw-file-resolver] resolveRawFile failed:', err)
    return null
  }
}
