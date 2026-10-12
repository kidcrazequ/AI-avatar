/**
 * Bounded Memory Store — 有界条目化长期记忆（A4 · Hermes Agent 借鉴）
 *
 * 核心洞察（NousResearch Hermes memory_tool.py）：该量级不需要向量/图，
 * **有界纯文本 + 条目原子操作**就是正确解。全文件字符预算由结构强制——
 * 预算满时写入必须先删/合并（"预算即遗忘"），价值排序不靠 prompt 恳求。
 *
 * 文件格式（人类可读 markdown，与 legacy MEMORY.md 同文件共存）：
 *
 * ```
 * （legacy 自由格式内容，原样保留，绝不回溯截断/重写）
 *
 * <!-- mem:m-20260705-ab12 2026-07-05 -->
 * 条目正文（可多行）
 *
 * <!-- mem:m-20260706-cd34 2026-07-06 -->
 * 另一条
 * ```
 *
 * 向后兼容：首个 `<!-- mem:... -->` 标记之前的所有内容视为 legacy 块，
 * 解析/序列化全程原样保留（懒迁移：新写入走条目，旧内容只能人工整理或
 * 走既有 consolidate 路径）。legacy 字符计入预算展示，但 remove/replace
 * 无法作用于 legacy（结构上防止 LLM 静默改写用户手写记忆）。
 *
 * @author zhi.qu
 * @date 2026-07-05
 */

import fs from 'fs'
import path from 'path'
import { localDateString } from '../utils/local-date'

/** 默认全文件字符预算（规格：4-6K 区间取中值；Hermes 为 2200） */
export const DEFAULT_MEMORY_CHAR_BUDGET = 5000
/** 预算可配下限/上限（avatar.config.json memoryCharBudget 越界时 clamp） */
export const MIN_MEMORY_CHAR_BUDGET = 1000
export const MAX_MEMORY_CHAR_BUDGET = 20000
/** 单条条目正文字符上限（防单条巨型条目吃掉整个预算） */
export const MAX_BOUNDED_ENTRY_CHARS = 1000

/** 条目标记：`<!-- mem:<id> <YYYY-MM-DD> -->` */
const ENTRY_MARKER_RE = /<!--\s*mem:([A-Za-z0-9_-]+)\s+(\d{4}-\d{2}-\d{2})\s*-->/g

export interface BoundedMemoryEntry {
  id: string
  /** 最近一次写入日期（YYYY-MM-DD，本地时区） */
  date: string
  content: string
}

export interface BoundedMemoryDoc {
  /** 首个条目标记之前的 legacy 自由格式内容（原样保留，可为空） */
  legacyPreamble: string
  entries: BoundedMemoryEntry[]
}

export type BoundedMemoryOp =
  | { type: 'add'; content: string; id?: string }
  | { type: 'replace'; id: string; content: string }
  | { type: 'remove'; id: string }

export interface BoundedMemoryUsage {
  chars: number
  budget: number
  ratio: number
}

export type BoundedMemoryOpResult =
  | { ok: true; doc: BoundedMemoryDoc; usage: BoundedMemoryUsage; entryId: string; forgotten?: string }
  | { ok: false; error: string; usage: BoundedMemoryUsage }

export const EMPTY_BOUNDED_MEMORY_DOC: BoundedMemoryDoc = { legacyPreamble: '', entries: [] }

/** 生成条目 id：m-<yyyymmdd>-<4 位随机>（日期取本地时区） */
export function newBoundedMemoryEntryId(date = localDateString()): string {
  const compact = date.replace(/-/g, '')
  const rand = Math.random().toString(36).slice(2, 6)
  return `m-${compact}-${rand}`
}

/**
 * 解析 MEMORY.md / USER.md 全文为有界文档。
 * 无任何 mem 标记的自由格式文件 → 整体进 legacyPreamble（容忍，不破坏）。
 */
export function parseBoundedMemoryMarkdown(text: string): BoundedMemoryDoc {
  const raw = text ?? ''
  const markers: Array<{ id: string; date: string; start: number; end: number }> = []
  ENTRY_MARKER_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = ENTRY_MARKER_RE.exec(raw)) !== null) {
    markers.push({ id: m[1], date: m[2], start: m.index, end: m.index + m[0].length })
  }
  if (markers.length === 0) {
    return { legacyPreamble: raw.trimEnd(), entries: [] }
  }
  const legacyPreamble = raw.slice(0, markers[0].start).trimEnd()
  const entries: BoundedMemoryEntry[] = []
  const seen = new Set<string>()
  for (let i = 0; i < markers.length; i++) {
    const bodyEnd = i + 1 < markers.length ? markers[i + 1].start : raw.length
    const content = raw.slice(markers[i].end, bodyEnd).trim()
    // 同 id 重复标记（人工编辑事故）：保留后者，前者并入即被覆盖——解析不抛错
    if (seen.has(markers[i].id)) {
      const idx = entries.findIndex(e => e.id === markers[i].id)
      if (idx >= 0) entries.splice(idx, 1)
    }
    seen.add(markers[i].id)
    entries.push({ id: markers[i].id, date: markers[i].date, content })
  }
  return { legacyPreamble, entries }
}

/** 序列化为写盘文本（round-trip 稳定：parse(serialize(doc)) 结构等价） */
export function serializeBoundedMemoryDoc(doc: BoundedMemoryDoc): string {
  const parts: string[] = []
  if (doc.legacyPreamble.trim()) {
    parts.push(doc.legacyPreamble.trimEnd())
  }
  for (const e of doc.entries) {
    parts.push(`<!-- mem:${e.id} ${e.date} -->\n${e.content.trim()}`)
  }
  if (parts.length === 0) return ''
  return parts.join('\n\n') + '\n'
}

/** 全文件字符数（以实际写盘/注入文本计） */
export function boundedMemoryChars(doc: BoundedMemoryDoc): number {
  return serializeBoundedMemoryDoc(doc).length
}

export function getBoundedMemoryUsage(doc: BoundedMemoryDoc, budget: number): BoundedMemoryUsage {
  const chars = boundedMemoryChars(doc)
  return { chars, budget, ratio: budget > 0 ? chars / budget : 0 }
}

/**
 * 注入用量表头：`[82% — 1,804/2,200 chars]`。
 * 用量可见本身就是 consolidate 的 nudge（Hermes 设计）。
 */
export function formatMemoryUsageHeader(chars: number, budget: number): string {
  const pct = budget > 0 ? Math.round((chars / budget) * 100) : 0
  const fmt = (n: number) => n.toLocaleString('en-US')
  return `[${pct}% — ${fmt(chars)}/${fmt(budget)} chars]`
}

/**
 * 原子操作（纯函数，不做文件 IO）。
 *
 * 预算强制：add / replace 后全文件超预算 → 拒绝并返回当前用量与条目清单
 * 提示（调用方把错误回显给 LLM，迫使其先 remove/replace——预算即遗忘）。
 * remove 永远允许；remove/replace 返回被覆盖/删除的原文（forgotten），
 * 供调用方留痕（可见的遗忘记录）。
 *
 * legacy 块不受任何 op 影响：结构上禁止 LLM 改写用户既有自由格式记忆。
 */
export function applyBoundedMemoryOp(
  doc: BoundedMemoryDoc,
  op: BoundedMemoryOp,
  budget: number = DEFAULT_MEMORY_CHAR_BUDGET,
): BoundedMemoryOpResult {
  const usage = getBoundedMemoryUsage(doc, budget)
  const today = localDateString()

  if (op.type === 'remove') {
    const idx = doc.entries.findIndex(e => e.id === op.id)
    if (idx < 0) {
      return { ok: false, error: `条目 id "${op.id}" 不存在。现有条目：${listBoundedEntriesSummary(doc) || '（无）'}`, usage }
    }
    const forgotten = doc.entries[idx].content
    const next: BoundedMemoryDoc = {
      legacyPreamble: doc.legacyPreamble,
      entries: doc.entries.filter((_, i) => i !== idx),
    }
    return { ok: true, doc: next, usage: getBoundedMemoryUsage(next, budget), entryId: op.id, forgotten }
  }

  const content = (op.content ?? '').trim()
  if (!content) {
    return { ok: false, error: `${op.type} 操作缺少非空 content`, usage }
  }
  if (content.length > MAX_BOUNDED_ENTRY_CHARS) {
    return { ok: false, error: `单条条目上限 ${MAX_BOUNDED_ENTRY_CHARS} 字符（当前 ${content.length}）；请精简后重试`, usage }
  }

  if (op.type === 'replace') {
    const idx = doc.entries.findIndex(e => e.id === op.id)
    if (idx < 0) {
      return { ok: false, error: `条目 id "${op.id}" 不存在，无法 replace。现有条目：${listBoundedEntriesSummary(doc) || '（无）'}`, usage }
    }
    const forgotten = doc.entries[idx].content
    const nextEntries = doc.entries.slice()
    nextEntries[idx] = { id: op.id, date: today, content }
    const next: BoundedMemoryDoc = { legacyPreamble: doc.legacyPreamble, entries: nextEntries }
    const nextUsage = getBoundedMemoryUsage(next, budget)
    if (nextUsage.chars > budget) {
      return {
        ok: false,
        error: `replace 后将超出预算（${nextUsage.chars}/${budget} chars）。请先 remove 其它条目或进一步精简内容。现有条目：${listBoundedEntriesSummary(doc)}`,
        usage,
      }
    }
    return { ok: true, doc: next, usage: nextUsage, entryId: op.id, forgotten }
  }

  // add
  const id = op.id && /^[A-Za-z0-9_-]+$/.test(op.id) && !doc.entries.some(e => e.id === op.id)
    ? op.id
    : newBoundedMemoryEntryId(today)
  const next: BoundedMemoryDoc = {
    legacyPreamble: doc.legacyPreamble,
    entries: [...doc.entries, { id, date: today, content }],
  }
  const nextUsage = getBoundedMemoryUsage(next, budget)
  if (nextUsage.chars > budget) {
    return {
      ok: false,
      error: `预算已满（写入后 ${nextUsage.chars}/${budget} chars）——必须先 remove 或 replace 合并旧条目再 add（预算即遗忘）。现有条目：${listBoundedEntriesSummary(doc) || '（无条目；legacy 内容占 ' + usage.chars + ' 字符，需人工整理或走 consolidate）'}`,
      usage,
    }
  }
  return { ok: true, doc: next, usage: nextUsage, entryId: id }
}

/** 条目清单摘要（id · 日期 · 前 40 字符），供预算满时回显给 LLM 选删除对象 */
export function listBoundedEntriesSummary(doc: BoundedMemoryDoc): string {
  return doc.entries
    .map(e => {
      const preview = e.content.replace(/\s+/g, ' ').slice(0, 40)
      return `[${e.id} ${e.date}] ${preview}${e.content.length > 40 ? '…' : ''}`
    })
    .join(' | ')
}

// ─── 文件 IO（Node 侧；渲染进程请勿 import 本模块的 IO 部分）───────────────

/** 读取有界记忆文件；不存在 → 空文档（不报错） */
export function readBoundedMemoryFile(filePath: string): BoundedMemoryDoc {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8')
    return parseBoundedMemoryMarkdown(raw)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') {
      console.warn(`[bounded-store] 读 ${filePath} 失败: ${err instanceof Error ? err.message : String(err)}`)
    }
    return { legacyPreamble: '', entries: [] }
  }
}

/** 原子写入（tmp + rename），自动建目录 */
export function writeBoundedMemoryFileAtomic(filePath: string, doc: BoundedMemoryDoc): void {
  const dir = path.dirname(filePath)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = path.join(dir, `.${path.basename(filePath)}.tmp-${process.pid}-${Date.now()}`)
  fs.writeFileSync(tmp, serializeBoundedMemoryDoc(doc), 'utf-8')
  fs.renameSync(tmp, filePath)
}

/**
 * 读取分身的记忆字符预算：avatar.config.json 的 `memoryCharBudget`（数字，
 * 越界 clamp 到 [MIN, MAX]）；缺省 DEFAULT_MEMORY_CHAR_BUDGET。
 * MEMORY.md 与 USER.md 各自独享一份该预算。
 */
export function resolveMemoryCharBudget(avatarsPath: string, avatarId: string): number {
  try {
    const raw = fs.readFileSync(path.join(avatarsPath, avatarId, 'avatar.config.json'), 'utf-8')
    const parsed = JSON.parse(raw) as { memoryCharBudget?: unknown }
    const v = parsed.memoryCharBudget
    if (typeof v === 'number' && Number.isFinite(v)) {
      return Math.max(MIN_MEMORY_CHAR_BUDGET, Math.min(MAX_MEMORY_CHAR_BUDGET, Math.floor(v)))
    }
  } catch {
    // 配置缺失/损坏 → 默认预算
  }
  return DEFAULT_MEMORY_CHAR_BUDGET
}
