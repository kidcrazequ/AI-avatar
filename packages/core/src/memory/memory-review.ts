/**
 * Memory Review — N 轮一次的后台记忆复盘（A4 · Hermes Agent 借鉴）
 *
 * 抽取从「每轮 nudge + 标签」改为「每 N 个用户轮跑一次后台复盘」：
 * 回复送达后异步执行、可路由便宜模型、"Nothing to save" 是合法输出。
 *
 * 本模块只含纯函数（prompt 构造 + 响应解析），无 IO / 无 LLM 调用——
 * 编排在 desktop-app electron/memory-review.ts（工程铁律：复盘永远不
 * 阻塞回复路径，由调用方保证 fire-and-forget）。
 *
 * @author zhi.qu
 * @date 2026-07-05
 */

import { formatMemoryUsageHeader, getBoundedMemoryUsage, type BoundedMemoryDoc, type BoundedMemoryOp } from './bounded-store'

/** 默认每 N 个用户轮触发一次复盘（Hermes 默认 10；设置 memory_review_turns 可配） */
export const MEMORY_REVIEW_DEFAULT_TURNS = 10
/** 单次复盘最多应用的操作数（防 LLM 一次性倾倒） */
export const MEMORY_REVIEW_MAX_OPS = 8
/** 复盘 prompt 中每条消息正文截断长度 */
export const MEMORY_REVIEW_MSG_TRUNCATE = 1200
/** 复盘 prompt 最多带最近多少条消息 */
export const MEMORY_REVIEW_MAX_MESSAGES = 60

export interface MemoryReviewStoreOp {
  store: 'memory' | 'user'
  op: BoundedMemoryOp
}

export interface MemoryReviewParseResult {
  ops: MemoryReviewStoreOp[]
  /** true = 模型明确表示无可保存（或输出解析不出任何合法 op） */
  nothingToSave: boolean
}

export interface MemoryReviewTranscriptMessage {
  role: 'user' | 'assistant'
  content: string
}

/**
 * 复盘 System Prompt：Hermes 负面清单 + Soul 特有禁令。
 * 输出契约是纯 JSON，便于 parseMemoryReviewResponse 零 LLM 解析。
 */
export const MEMORY_REVIEW_SYSTEM_PROMPT = `你是 AI 分身的记忆复盘助手。任务：回顾最近若干轮对话，对两个**有界**长期记忆库产出最小的原子编辑操作。

两个库（各自独立字符预算，当前用量已在下方给出）：
- "memory"（MEMORY.md 分身运行笔记）：环境约定、用户纠偏过的错误理解、项目关键决策、可复用的教训
- "user"（USER.md 用户画像）：用户是谁、长期偏好、沟通风格

输出格式（只输出 JSON，不要任何其它文字）：
{"ops":[{"store":"memory","op":"add","content":"..."},{"store":"user","op":"replace","id":"m-xxx","content":"..."},{"store":"memory","op":"remove","id":"m-yyy"}]}

没有值得长期记住的内容时输出 {"ops":[]} ——这是合法且常见的结果（Nothing to save），不要为了"有产出"硬凑条目。

【负面清单——以下内容禁止写入任何记忆库】
1. 专业事实 / 参数 / 数据 / 政策条款：属于 knowledge/ 知识库，必须走溯源规范（标注来源文件）；记忆里的"事实"无法溯源，等于污染。
2. 对工具或环境的负面断言（如"query_excel 不可用""联网坏了"）：一次偶发故障会硬化成几个月后还在自我引用的拒绝理由。故障是暂态，不进记忆。
3. 过程性内容（本次做了哪些步骤、中间产物、单次任务细节）：会话历史有全文索引（session_search 工具可找回），不占记忆预算。
4. 秘密 / 凭据 / API Key / 个人敏感标识。
5. 无来源的推断"事实"：推断 ≠ 事实，宁缺勿滥。
6. 一次性琐事、寒暄、明确只对本次会话生效的特例。

【预算规则——预算即遗忘】
- 每个库有全文件字符预算；add/replace 导致超预算会被系统拒绝。
- 用量接近/超过预算时，必须先用 remove 删除过时条目、或用 replace 把多条合并成一条，再 add。
- 删除会留痕（被删内容记录在案），不用担心误删无法追溯；但用户纠偏记录与关键决策优先保留。
- replace/remove 的 id 必须取自下方现有条目清单；legacy 段（无 id 的旧内容）不可编辑。

【写入原则】
- 条目要短（一两句话）、面向未来可复用；合并同主题旧条目优于新增。
- 单次复盘操作总数 ≤ ${MEMORY_REVIEW_MAX_OPS}。`

/** 渲染单个库的当前状态（用量表头 + 条目清单 + legacy 提示） */
function renderStoreState(label: string, doc: BoundedMemoryDoc, budget: number): string {
  const usage = getBoundedMemoryUsage(doc, budget)
  const lines: string[] = [`### ${label} ${formatMemoryUsageHeader(usage.chars, usage.budget)}`]
  if (doc.legacyPreamble.trim()) {
    lines.push(`（legacy 自由格式段 ${doc.legacyPreamble.length} 字符，不可通过 op 编辑）`)
  }
  if (doc.entries.length === 0) {
    lines.push('（暂无条目）')
  } else {
    for (const e of doc.entries) {
      lines.push(`- id=${e.id} (${e.date}): ${e.content.replace(/\s+/g, ' ')}`)
    }
  }
  return lines.join('\n')
}

/**
 * 复盘 User Prompt：两库现状 + 最近对话转写。
 * transcript 由调用方按 cursor 截取（只含 user/assistant，不含 tool）。
 */
export function buildMemoryReviewUserPrompt(input: {
  memoryDoc: BoundedMemoryDoc
  userDoc: BoundedMemoryDoc
  memoryBudget: number
  userBudget: number
  transcript: MemoryReviewTranscriptMessage[]
}): string {
  const msgs = input.transcript.slice(-MEMORY_REVIEW_MAX_MESSAGES)
  const transcriptText = msgs
    .map(m => {
      const body = m.content.length > MEMORY_REVIEW_MSG_TRUNCATE
        ? m.content.slice(0, MEMORY_REVIEW_MSG_TRUNCATE) + '…[截断]'
        : m.content
      return `${m.role === 'user' ? '用户' : '分身'}: ${body}`
    })
    .join('\n\n')
  return [
    '## 当前记忆库状态',
    '',
    renderStoreState('memory（MEMORY.md）', input.memoryDoc, input.memoryBudget),
    '',
    renderStoreState('user（USER.md）', input.userDoc, input.userBudget),
    '',
    '## 待复盘的最近对话',
    '',
    transcriptText,
    '',
    '请按 system 规则输出 JSON。',
  ].join('\n')
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

/**
 * 解析复盘 LLM 输出为操作列表。
 * 容忍 ```json 围栏 / 前后杂文字；解析不出合法 JSON 或 ops 为空 → nothingToSave。
 * 非法 op（缺字段/未知 store）逐条丢弃而非整体失败。
 */
export function parseMemoryReviewResponse(text: string): MemoryReviewParseResult {
  const raw = (text ?? '').trim()
  if (!raw) return { ops: [], nothingToSave: true }

  // 提取首个 JSON object：优先 ```json 围栏，其次首个 { 到最后一个 }
  let jsonText: string | null = null
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fence) jsonText = fence[1].trim()
  if (!jsonText) {
    const start = raw.indexOf('{')
    const end = raw.lastIndexOf('}')
    if (start >= 0 && end > start) jsonText = raw.slice(start, end + 1)
  }
  if (!jsonText) return { ops: [], nothingToSave: true }

  let parsed: unknown
  try {
    parsed = JSON.parse(jsonText)
  } catch {
    return { ops: [], nothingToSave: true }
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.ops)) {
    return { ops: [], nothingToSave: true }
  }

  const ops: MemoryReviewStoreOp[] = []
  for (const item of parsed.ops) {
    if (ops.length >= MEMORY_REVIEW_MAX_OPS) break
    if (!isRecord(item)) continue
    const store = item.store === 'memory' || item.store === 'user' ? item.store : null
    if (!store) continue
    const opName = item.op
    if (opName === 'add') {
      if (typeof item.content === 'string' && item.content.trim()) {
        ops.push({ store, op: { type: 'add', content: item.content.trim() } })
      }
    } else if (opName === 'replace') {
      if (typeof item.id === 'string' && item.id.trim() && typeof item.content === 'string' && item.content.trim()) {
        ops.push({ store, op: { type: 'replace', id: item.id.trim(), content: item.content.trim() } })
      }
    } else if (opName === 'remove') {
      if (typeof item.id === 'string' && item.id.trim()) {
        ops.push({ store, op: { type: 'remove', id: item.id.trim() } })
      }
    }
  }
  return { ops, nothingToSave: ops.length === 0 }
}
