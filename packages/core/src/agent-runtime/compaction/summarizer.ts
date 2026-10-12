/**
 * 上下文压缩：监测对话窗口 token 占比，超阈值时把中间段交给 LLM 摘要替换。
 *
 * 策略（保守且可回滚）：
 *   - 始终保留首 N 条（system / 第一轮上下文）
 *   - 始终保留尾 M 条（最近交互，保证连续性）
 *   - 中间段送给 summarize 回调生成单条 assistant 摘要消息
 *   - 输出新消息列表 + 元信息（原始长度、压缩后长度、估算 token）
 *
 * 触发 ON_COMPACTION hook，调用方按需挂 UI 提示。
 */

import { HookPoint } from '../hooks/points'
import type { HookRegistry, OnCompactionPayload } from '../hooks/registry'

export interface CompactionMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  /** 调用方可选附带原始 token 数 */
  tokens?: number
}

export interface CompactOptions {
  /** 触发阈值（估算 token）；超过即压缩 */
  triggerTokens: number
  /** 压缩目标 token 上限（≤ triggerTokens） */
  targetTokens: number
  /** 头部保留条数（含 system） */
  retainHead: number
  /** 尾部保留条数 */
  retainTail: number
  /** 摘要回调：把中间段消息总结成单条文本 */
  summarize: (mid: readonly CompactionMessage[]) => Promise<string>
  /** Token 估算函数；不传按字符数 / 4 估算（粗略） */
  estimateTokens?: (msg: CompactionMessage) => number
  hooks?: HookRegistry
}

export interface CompactionResult {
  /** 处理后的消息列表（可能与原相同） */
  messages: CompactionMessage[]
  /** 是否真的压缩了 */
  compacted: boolean
  /** 原始消息条数 */
  originalCount: number
  /** 压缩后消息条数 */
  compactedCount: number
  /** 摘要替换的原始条数 */
  summarizedCount: number
  /** 估算节省的 token */
  tokensSaved: number
  /** 摘要文本（若生成） */
  summary?: string
}

export function defaultTokenEstimate(msg: CompactionMessage): number {
  if (typeof msg.tokens === 'number') return msg.tokens
  return Math.ceil(msg.content.length / 4)
}

export async function compactIfNeeded(
  messages: readonly CompactionMessage[],
  opts: CompactOptions
): Promise<CompactionResult> {
  const est = opts.estimateTokens ?? defaultTokenEstimate
  const totalTokens = messages.reduce((s, m) => s + est(m), 0)

  if (totalTokens <= opts.triggerTokens || messages.length <= opts.retainHead + opts.retainTail) {
    return {
      messages: [...messages],
      compacted: false,
      originalCount: messages.length,
      compactedCount: messages.length,
      summarizedCount: 0,
      tokensSaved: 0,
    }
  }

  const head = messages.slice(0, opts.retainHead)
  const tail = messages.slice(messages.length - opts.retainTail)
  const mid = messages.slice(opts.retainHead, messages.length - opts.retainTail)

  if (mid.length === 0) {
    return {
      messages: [...messages],
      compacted: false,
      originalCount: messages.length,
      compactedCount: messages.length,
      summarizedCount: 0,
      tokensSaved: 0,
    }
  }

  const summaryText = await opts.summarize(mid)
  const summaryMsg: CompactionMessage = {
    role: 'assistant',
    content: `【已压缩历史摘要】\n${summaryText}`,
  }

  const newMessages = [...head, summaryMsg, ...tail]
  const midTokens = mid.reduce((s, m) => s + est(m), 0)
  const summaryTokens = est(summaryMsg)
  const tokensSaved = midTokens - summaryTokens

  if (opts.hooks) {
    const payload: OnCompactionPayload = {
      point: HookPoint.ON_COMPACTION,
      timestamp: Date.now(),
      originalMessageCount: messages.length,
      compactedMessageCount: newMessages.length,
      tokensSaved,
    }
    await opts.hooks.fire(payload)
  }

  // 检查目标：若仍超 target，递归压缩剩余尾段
  const newTotal = newMessages.reduce((s, m) => s + est(m), 0)
  if (newTotal > opts.targetTokens && tail.length > opts.retainTail) {
    // 不递归更多，避免在单次内多次摘要把语义打碎
  }

  return {
    messages: newMessages,
    compacted: true,
    originalCount: messages.length,
    compactedCount: newMessages.length,
    summarizedCount: mid.length,
    tokensSaved,
    summary: summaryText,
  }
}
