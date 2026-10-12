/**
 * lorebook-trigger.ts — SillyTavern World Info / Lorebook 借鉴的关键词触发注入
 *
 * 痛点：BM25 + 向量召回有概率漏掉关键文档；`knowledge_grep` 工具补漏但需 LLM 主动调用，
 * 对小模型 / 短上下文场景不可靠。本模块在 user message 进入 LLM 前**被动**扫描 keyword，
 * 命中后直接把对应知识片段注入到 system prompt 的 dynamic 段，绕开 LLM 调用决策。
 *
 * 配置：`avatars/<id>/knowledge/_triggers.yaml`
 *   triggers:
 *     - keywords: ['铜铝', '铝排']
 *       knowledge: '电气标准/铜铝对比.md'
 *       priority: 10
 *       max_chars: 600
 *       note: '用户提到铜铝时常需要参数对比'
 *     - ...
 *   total_max_chars: 2400   # 全部注入字符上限（防注入爆 context）
 *   max_entries: 3          # 最多命中条目数
 *
 * 数据流：
 *   user message → matchTriggers() → buildTriggerInjection(retriever) → 拼到 prompt
 *
 * 与工具检索的关系：互补不替代。BM25 走"相关性 topk"，trigger 走"keyword → 指定文件"，
 * 适合"提到 X 就一定要看 Y"的强约束场景。
 */

import fs from 'fs'
import path from 'path'
import { parse as parseYaml } from 'yaml'
import type { KnowledgeRetriever } from './knowledge-retriever'

const TRIGGERS_FILE_NAME = '_triggers.yaml'
const DEFAULT_TOTAL_MAX_CHARS = 2400
const DEFAULT_MAX_ENTRIES = 3
const DEFAULT_ENTRY_MAX_CHARS = 800
const MIN_REMAINING_FOR_NEXT = 100 // 至少留 100 字给下一个 entry，否则提前停

export interface TriggerEntry {
  /** 关键词列表（OR 关系，任一命中即触发；大小写不敏感） */
  keywords: string[]
  /** 命中后注入的知识文件相对路径（相对 knowledge/） */
  knowledge: string
  /** 优先级；多命中时按 priority desc + hitCount desc 排序，默认 0 */
  priority?: number
  /** 单条注入字符上限，默认 800 */
  max_chars?: number
  /** 给 LLM 的一段说明（可选） */
  note?: string
}

export interface TriggersConfig {
  triggers: TriggerEntry[]
  total_max_chars: number
  max_entries: number
}

export interface TriggerMatch {
  trigger: TriggerEntry
  hits: string[]
  score: number
}

export interface TriggerInjection {
  text: string
  charCount: number
  entries: Array<{ knowledge: string; hits: string[]; chars: number; truncated: boolean }>
}

/**
 * 从 `<knowledgePath>/_triggers.yaml` 加载触发器配置。
 * - 文件不存在：返回 null（功能未启用）
 * - YAML 损坏 / schema 不合法：返回 null + console.warn，不抛错
 * - 单条 entry 缺字段：静默跳过，其他保留
 */
export function loadTriggers(knowledgePath: string): TriggersConfig | null {
  const p = path.join(knowledgePath, TRIGGERS_FILE_NAME)
  if (!fs.existsSync(p)) return null
  try {
    const raw = fs.readFileSync(p, 'utf-8')
    const parsed = parseYaml(raw) as unknown
    return validateTriggersConfig(parsed)
  } catch (err) {
    console.warn(`[lorebook] _triggers.yaml 加载失败: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}

function validateTriggersConfig(parsed: unknown): TriggersConfig | null {
  if (typeof parsed !== 'object' || parsed === null) return null
  const obj = parsed as Record<string, unknown>
  if (!Array.isArray(obj.triggers)) return null

  const triggers: TriggerEntry[] = []
  for (const item of obj.triggers) {
    if (typeof item !== 'object' || item === null) continue
    const t = item as Record<string, unknown>
    if (!Array.isArray(t.keywords) || typeof t.knowledge !== 'string' || !t.knowledge) continue
    const keywords = t.keywords.filter((k): k is string => typeof k === 'string' && k.length > 0)
    if (keywords.length === 0) continue

    const entry: TriggerEntry = {
      keywords,
      knowledge: t.knowledge,
    }
    if (typeof t.priority === 'number' && Number.isFinite(t.priority)) entry.priority = t.priority
    if (typeof t.max_chars === 'number' && t.max_chars > 0) entry.max_chars = t.max_chars
    if (typeof t.note === 'string' && t.note.length > 0) entry.note = t.note
    triggers.push(entry)
  }

  const total_max_chars = typeof obj.total_max_chars === 'number' && obj.total_max_chars > 0
    ? obj.total_max_chars
    : DEFAULT_TOTAL_MAX_CHARS
  const max_entries = typeof obj.max_entries === 'number' && obj.max_entries > 0
    ? Math.floor(obj.max_entries)
    : DEFAULT_MAX_ENTRIES

  return { triggers, total_max_chars, max_entries }
}

/**
 * 按 user message 扫描 trigger，返回命中条目（已按 score 排序 + 截断到 max_entries）。
 * 关键词匹配规则：大小写不敏感的 substring。
 * 排序：priority desc → hitCount desc。
 */
export function matchTriggers(userMessage: string, config: TriggersConfig): TriggerMatch[] {
  if (!userMessage || config.triggers.length === 0) return []
  const lowMsg = userMessage.toLowerCase()
  const matches: TriggerMatch[] = []
  for (const trigger of config.triggers) {
    const hits = trigger.keywords.filter(k => lowMsg.includes(k.toLowerCase()))
    if (hits.length === 0) continue
    matches.push({
      trigger,
      hits,
      score: (trigger.priority ?? 0) * 1000 + hits.length,
    })
  }
  matches.sort((a, b) => b.score - a.score)
  return matches.slice(0, config.max_entries)
}

/**
 * 把命中的 trigger 转成注入字符串。
 * - 按 totalMaxChars 全局截断，单条按 entry.max_chars 截断
 * - 读不到的文件静默跳过（不让一个坏 trigger 阻塞整批）
 * - 空 matches 返回 empty injection（caller 可直接 skip 注入）
 */
export function buildTriggerInjection(
  matches: TriggerMatch[],
  retriever: Pick<KnowledgeRetriever, 'readFile'>,
  totalMaxChars: number = DEFAULT_TOTAL_MAX_CHARS,
): TriggerInjection {
  if (matches.length === 0) {
    return { text: '', charCount: 0, entries: [] }
  }

  const headerLines = [
    '## 触发知识片段',
    '（按 user 消息关键词自动命中并注入，仅作背景辅助；如需精确数字仍以 knowledge_grep / read_knowledge_file 为准）',
    '',
  ]
  const entries: TriggerInjection['entries'] = []
  let remaining = totalMaxChars
  const bodyBlocks: string[] = []

  for (const m of matches) {
    if (remaining <= MIN_REMAINING_FOR_NEXT) break
    let content: string
    try {
      content = retriever.readFile(m.trigger.knowledge)
    } catch (err) {
      console.warn(`[lorebook] 读触发文件失败 ${m.trigger.knowledge}: ${err instanceof Error ? err.message : String(err)}`)
      continue
    }
    const entryLimit = Math.min(m.trigger.max_chars ?? DEFAULT_ENTRY_MAX_CHARS, remaining)
    const truncated = content.length > entryLimit
    const clip = truncated ? content.slice(0, entryLimit) + '\n…[截断]' : content
    bodyBlocks.push(`### 触发文件 \`${m.trigger.knowledge}\`（命中：${m.hits.join(', ')}）`)
    if (m.trigger.note) bodyBlocks.push(`> ${m.trigger.note}`)
    bodyBlocks.push('')
    bodyBlocks.push(clip)
    bodyBlocks.push('')
    entries.push({ knowledge: m.trigger.knowledge, hits: m.hits, chars: clip.length, truncated })
    remaining -= clip.length
  }

  if (entries.length === 0) {
    return { text: '', charCount: 0, entries: [] }
  }
  const text = [...headerLines, ...bodyBlocks].join('\n')
  return { text, charCount: text.length, entries }
}
