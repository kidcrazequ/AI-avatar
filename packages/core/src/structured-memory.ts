/**
 * 结构化长期记忆（白盒条目）解析、校验与 prompt 渲染。
 * 与 `memory/MEMORY.md` 并行存在，供 SoulLoader 与 IPC 层复用；本模块无文件 IO。
 *
 * @author zhi.qu
 * @date 2026-05-09
 */

import { getMemoryStats, type MemoryStats } from './memory-manager'

/** 与 `MEMORY.md` 同目录的 JSON 文件名 */
export const STRUCTURED_MEMORY_FILENAME = 'MEMORY.entries.json'

/** 首期条目数量上限（防止巨型 JSON） */
export const STRUCTURED_MEMORY_MAX_ENTRIES = 256

/** 单条条目正文上限 */
export const STRUCTURED_MEMORY_MAX_CONTENT_CHARS = 8000

const SCHEMA_VERSION = 1 as const

export interface StructuredMemoryEntry {
  id: string
  createdAt: string
  updatedAt: string
  category: string
  content: string
  /** 记录来源（如 manual、import） */
  source?: string
}

export interface StructuredMemoryDocument {
  schemaVersion: typeof SCHEMA_VERSION
  entries: StructuredMemoryEntry[]
}

export const EMPTY_STRUCTURED_MEMORY_DOCUMENT: StructuredMemoryDocument = {
  schemaVersion: SCHEMA_VERSION,
  entries: [],
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0
}

function isMemoryEntry(raw: unknown): raw is StructuredMemoryEntry {
  if (typeof raw !== 'object' || raw === null) return false
  const o = raw as Record<string, unknown>
  if (!isNonEmptyString(o.id)) return false
  if (!isNonEmptyString(o.createdAt) || !isNonEmptyString(o.updatedAt)) return false
  if (!isNonEmptyString(o.category)) return false
  if (typeof o.content !== 'string') return false
  if (o.source !== undefined && typeof o.source !== 'string') return false
  return true
}

/**
 * 将 ISO 字符串规范为可读日期片段（YYYY-MM-DD），解析失败则原样缩略返回。
 */
export function formatStructuredMemoryDateLabel(iso: string): string {
  const d = Date.parse(iso)
  if (Number.isNaN(d)) return iso.length > 10 ? iso.slice(0, 10) : iso
  const x = new Date(d)
  const y = x.getFullYear()
  const m = String(x.getMonth() + 1).padStart(2, '0')
  const day = String(x.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/**
 * 解析并校验 JSON 文本；失败返回 null（调用方按「无结构化文件」处理）。
 */
export function parseStructuredMemoryDocumentJson(jsonText: string): StructuredMemoryDocument | null {
  try {
    const parsed = JSON.parse(jsonText) as unknown
    return parseStructuredMemoryDocumentUnknown(parsed)
  } catch {
    return null
  }
}

/** 从已 parse 的 JSON 值校验文档（IPC / 深拷贝对象用，不经 JSON 字符串）。 */
export function parseStructuredMemoryDocumentUnknown(parsed: unknown): StructuredMemoryDocument | null {
  if (typeof parsed !== 'object' || parsed === null) return null
  const root = parsed as Record<string, unknown>
  if (root.schemaVersion !== SCHEMA_VERSION) return null
  if (!Array.isArray(root.entries)) return null
  const entries: StructuredMemoryEntry[] = []
  for (const item of root.entries) {
    if (!isMemoryEntry(item)) return null
    if (item.content.length > STRUCTURED_MEMORY_MAX_CONTENT_CHARS) return null
    entries.push({
      id: item.id.trim(),
      createdAt: item.createdAt.trim(),
      updatedAt: item.updatedAt.trim(),
      category: item.category.trim(),
      content: item.content,
      source: item.source?.trim() || undefined,
    })
  }
  if (entries.length > STRUCTURED_MEMORY_MAX_ENTRIES) return null
  return { schemaVersion: SCHEMA_VERSION, entries }
}

/**
 * 规范化渲染进程或其它入口提交的 unknown，失败抛带语义信息的 Error（主进程记录日志用）。
 */
export function assertStructuredMemoryDocumentPayload(raw: unknown): StructuredMemoryDocument {
  const doc = parseStructuredMemoryDocumentUnknown(raw)
  if (!doc) {
    throw new Error('structured_memory_invalid_payload')
  }
  return doc
}

/**
 * 将 unknown 解析为文档；无效时返回空文档（便于 IPC 读盘容错）。
 */
export function normalizeStructuredMemoryDocumentUnknown(raw: unknown): StructuredMemoryDocument {
  try {
    if (typeof raw === 'string') {
      return parseStructuredMemoryDocumentJson(raw) ?? EMPTY_STRUCTURED_MEMORY_DOCUMENT
    }
    return parseStructuredMemoryDocumentUnknown(raw) ?? EMPTY_STRUCTURED_MEMORY_DOCUMENT
  } catch {
    return EMPTY_STRUCTURED_MEMORY_DOCUMENT
  }
}

function sortEntriesForPrompt(entries: StructuredMemoryEntry[]): StructuredMemoryEntry[] {
  return [...entries].sort((a, b) => {
    const tb = Date.parse(b.updatedAt)
    const ta = Date.parse(a.updatedAt)
    if (!Number.isNaN(tb) && !Number.isNaN(ta) && tb !== ta) return tb - ta
    return b.updatedAt.localeCompare(a.updatedAt)
  })
}

/**
 * 将条目渲染为注入 system prompt 的 Markdown（含二级标题，便于与 legacy MD 区分）。
 */
export function formatStructuredMemoryEntriesForPrompt(entries: StructuredMemoryEntry[]): string {
  if (entries.length === 0) return ''
  const lines: string[] = ['## 结构化记忆（白盒）', '']
  for (const e of sortEntriesForPrompt(entries)) {
    const day = formatStructuredMemoryDateLabel(e.updatedAt)
    const src = e.source && e.source.length > 0 ? e.source : '—'
    lines.push(`### ${e.category} · ${day} · \`${e.id}\``, '')
    lines.push(e.content.trim())
    lines.push('')
    lines.push(`- **类别**: ${e.category}`)
    lines.push(`- **来源**: ${src}`)
    lines.push(`- **创建**: ${formatStructuredMemoryDateLabel(e.createdAt)} · **更新**: ${formatStructuredMemoryDateLabel(e.updatedAt)}`)
    lines.push('')
  }
  return lines.join('\n').trimEnd()
}

/**
 * 拼装注入「长期记忆」段的正文：结构化块 + 可选 legacy `MEMORY.md`。
 */
export function buildLongTermMemoryInjectionBody(
  structuredMarkdown: string,
  legacyMemoryMd: string
): string {
  const s = structuredMarkdown.trim()
  const m = legacyMemoryMd.trim()
  if (s && m) {
    return `${s}\n\n---\n\n## memory/MEMORY.md（兼容）\n\n${m}`
  }
  if (s) return s
  return m
}

/**
 * 与 `getMemoryStats` 一致的量纲：对 **实际注入正文** 计数字符；条目数 = 结构化条数 + legacy 中 `<!-- ... -->` 注释数。
 */
export function getCombinedMemoryInjectionStats(
  structuredMarkdown: string,
  legacyMemoryMd: string,
  structuredEntryCount: number
): MemoryStats {
  const body = buildLongTermMemoryInjectionBody(structuredMarkdown, legacyMemoryMd)
  const base = getMemoryStats(body)
  const legacyMarkers = (legacyMemoryMd.match(/<!--[^>]+-->/g) ?? []).length
  return {
    chars: base.chars,
    ratio: base.ratio,
    entries: structuredEntryCount + legacyMarkers,
  }
}

/**
 * 序列化为写入磁盘的 JSON（带换行，便于 Git diff）。
 */
export function serializeStructuredMemoryDocument(doc: StructuredMemoryDocument): string {
  const payload: StructuredMemoryDocument = {
    schemaVersion: SCHEMA_VERSION,
    entries: doc.entries.map(e => ({
      id: e.id,
      createdAt: e.createdAt,
      updatedAt: e.updatedAt,
      category: e.category,
      content: e.content,
      ...(e.source !== undefined && e.source !== '' ? { source: e.source } : {}),
    })),
  }
  return `${JSON.stringify(payload, null, 2)}\n`
}
