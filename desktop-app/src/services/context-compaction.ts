/**
 * context-compaction.ts — BR-2：tool-call 安全的主动上下文压缩。
 *
 * 为什么不直接用 packages/core 的 agent-runtime/compaction/summarizer.ts：
 * 那个模块基于简化的 {role, content} 模型，不认 tool_calls / tool_call_id；按"条数"切中段
 * 会把成对的 tool_use / tool_result 拆散，生成非法消息序列 → provider 直接 400。
 * 本模块改按 **user 消息边界** 切分——user 消息永远是干净的 round 边界（其之前一轮的工具调用
 * 已全部闭合），因此中段整体摘要后不会遗留孤儿工具调用。
 *
 * 关键前提（决定这不违反可溯源红线）：这里压缩的 `apiMessages` 只是"发给模型的工作上下文"，
 * 完整对话早已双写 SQLite + JSONL（v17 事件溯源）。压缩只裁剪模型上下文、不动任何持久记录，
 * 用户仍能在会话里看到全部原文；被摘要的只是模型下一轮"看到"的历史。
 */

import type { LLMMessage } from './llm-service'

export interface CompactionPlan {
  /** head = messages[0, headEnd)（含首条 user，结束于 user，无悬空 tool_calls） */
  headEnd: number
  /** tail = messages[tailStart, end)（从某条 user 开始，内部工具调用自洽成对） */
  tailStart: number
}

/**
 * 计算 tool-call 安全的压缩边界。返回 null 表示无法安全压缩（无 user / 无足够中段）。
 *
 * 不变量（务必保持，否则会产生孤儿 tool 消息）：
 *  1. head 结束于首条 user 之后 → head 尾部是 user，不会遗留其 assistant 的悬空 tool_calls。
 *  2. tail 从一条 user 消息开始 → 该 user 之前一轮的工具调用已闭合；tail 内任何 tool 结果的
 *     assistant(tool_calls) 必然也在 tail 内（都在这条 user 之后）。
 *  3. 中段（headEnd..tailStart）被单条 assistant 摘要替换 → 其中 tool_use/tool_result 成对 collapse。
 *  4. 摘要 assistant 夹在 head(user) 与 tail(user) 之间 → user/assistant 交替合法（不出现连续同角色）。
 */
export function planContextCompaction(
  messages: readonly LLMMessage[],
  opts: { minTailMessages: number; minMiddleMessages: number },
): CompactionPlan | null {
  const firstUser = messages.findIndex((m) => m.role === 'user')
  if (firstUser < 0) return null
  const headEnd = firstUser + 1

  // tail：从"目标位置或更早"的最近一条 user 消息开始，保证 tail 至少 minTailMessages 条。
  const desired = messages.length - opts.minTailMessages
  let tailStart = -1
  for (let i = Math.min(desired, messages.length - 1); i > headEnd; i--) {
    if (messages[i].role === 'user') {
      tailStart = i
      break
    }
  }
  if (tailStart < 0) return null
  if (tailStart - headEnd < opts.minMiddleMessages) return null
  return { headEnd, tailStart }
}

/** 把中段消息渲染成供 LLM 摘要的纯文本（保留角色与工具名，方便摘要引用来源）。 */
export function renderMiddleForSummary(mid: readonly LLMMessage[]): string {
  return mid
    .map((m) => {
      const role =
        m.role === 'tool' ? '工具结果' : m.role === 'assistant' ? '助手' : m.role === 'user' ? '用户' : m.role
      const calls = m.tool_calls?.length
        ? ` [调用: ${m.tool_calls.map((c) => c.function?.name ?? '?').join(', ')}]`
        : ''
      const text = typeof m.content === 'string' ? m.content : '[多模态内容]'
      return `【${role}${calls}】\n${text}`
    })
    .join('\n\n')
}

export interface CompactionOutcome {
  compacted: boolean
  /** 压缩后的消息列表；未压缩时原样返回入参引用 */
  messages: LLMMessage[]
  /** 被摘要替换掉的原始消息条数 */
  summarizedCount: number
  summary?: string
}

/**
 * 若能安全压缩则把中段交给 summarize 回调摘要，并用 **原始消息对象** 重建 head/tail
 * （保留 tool_calls / tool_call_id / reasoning_content 结构，绝不经有损映射）。
 *
 * 保守失败：无安全边界、或摘要为空 → 一律不压缩、原样返回（宁可不省 token，也不冒破坏风险）。
 */
export async function compactContextIfSafe(input: {
  messages: LLMMessage[]
  minTailMessages: number
  minMiddleMessages: number
  summarize: (mid: readonly LLMMessage[]) => Promise<string>
}): Promise<CompactionOutcome> {
  const plan = planContextCompaction(input.messages, {
    minTailMessages: input.minTailMessages,
    minMiddleMessages: input.minMiddleMessages,
  })
  if (!plan) return { compacted: false, messages: input.messages, summarizedCount: 0 }

  const mid = input.messages.slice(plan.headEnd, plan.tailStart)
  const summary = await input.summarize(mid)
  if (!summary || !summary.trim()) {
    return { compacted: false, messages: input.messages, summarizedCount: 0 }
  }

  const summaryMsg: LLMMessage = {
    role: 'assistant',
    content: `【已压缩历史摘要（完整对话仍在会话记录中，未改动）】\n${summary.trim()}`,
  }
  const newMessages = [
    ...input.messages.slice(0, plan.headEnd),
    summaryMsg,
    ...input.messages.slice(plan.tailStart),
  ]
  return { compacted: true, messages: newMessages, summarizedCount: mid.length, summary: summary.trim() }
}
