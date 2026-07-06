/**
 * Memory Review 编排（A4 · Hermes 借鉴）：N 轮一次的后台记忆复盘。
 *
 * 触发链路：chatStore 在回复送达后 fire-and-forget 调 IPC `run-memory-review`
 * → main.ts 组装依赖 → 本模块 runMemoryReviewOnce。
 *
 * 工程铁律（Hermes 298 秒阻塞事故换来的）：本函数**永远不在回复路径上**——
 * 调用方必须 void 掉返回的 promise；这里的 better-sqlite3 同步调用只有
 * 单行游标读写与带 LIMIT 的转写查询（毫秒级），LLM 调用与文件写入全异步。
 *
 * 复盘产出通过 bounded-store 原子操作落盘（预算强制 + 遗忘留痕），
 * 每个 op 结果记入 logger + JSONL 事件流（删除必须留痕，不做静默遗忘）。
 * 写入只落盘——冻结快照语义下，下个 session 装配 system prompt 才生效。
 *
 * @author zhi.qu
 * @date 2026-07-05
 */

import path from 'path'
import {
  applyBoundedMemoryOp,
  boundedMemoryChars,
  buildMemoryReviewUserPrompt,
  MEMORY_REVIEW_SYSTEM_PROMPT,
  parseMemoryReviewResponse,
  readBoundedMemoryFile,
  resolveMemoryCharBudget,
  writeBoundedMemoryFileAtomic,
  type BoundedMemoryDoc,
} from '@soul/core'
import type { MemoryReviewStore } from './db-memory-review'

export interface MemoryReviewDeps {
  avatarsPath: string
  avatarId: string
  conversationId: string
  /** 触发阈值：距上次复盘的用户轮数（设置 memory_review_turns，默认 10） */
  reviewTurns: number
  store: MemoryReviewStore
  callLLM: (system: string, user: string, maxTokens?: number) => Promise<string>
  log?: (level: 'info' | 'warn' | 'error', event: string, message: string) => void
  /** 每次复盘完成（applied>0 时）记 JSONL 事件（沿用 memory_update 事件形态） */
  recordEvent?: (payload: { updateCount: number; summaryPreview: string; totalByteSize: number }) => void
}

export interface MemoryReviewResult {
  ok: boolean
  reason?: string
  /** 实际应用的 op 数 */
  applied?: number
  /** 被预算/校验拒绝的 op 数（错误已逐条记日志） */
  rejected?: number
  nothingToSave?: boolean
}

/**
 * 同一分身的复盘互斥：复盘是"读旧值→LLM→改→整份覆盖写"，两次复盘（或复盘与
 * memory_update 工具）交叠会静默覆盖先写者——与"删除必须留痕"承诺直接矛盾。
 * 复盘、memory_update 都在主进程执行，进程内 Set 即可关闭并发窗口。
 */
const inFlightAvatars = new Set<string>()

export async function runMemoryReviewOnce(deps: MemoryReviewDeps): Promise<MemoryReviewResult> {
  const { store, conversationId, avatarId } = deps

  // 跨分身防护（IDOR）：conversationId 必须真的属于 avatarId，否则可把
  // 其他分身的私密会话内容摘要进本分身持久记忆，下个 session 静默生效
  const owner = store.conversationAvatarId(conversationId)
  if (owner !== avatarId) {
    return { ok: false, reason: `会话不属于该分身（conv=${conversationId}），拒绝复盘` }
  }

  if (inFlightAvatars.has(avatarId)) {
    return { ok: false, reason: '该分身已有复盘在进行中，本次跳过（防并发覆盖）' }
  }
  inFlightAvatars.add(avatarId)
  try {
    return await runReviewInner(deps)
  } finally {
    inFlightAvatars.delete(avatarId)
  }
}

async function runReviewInner(deps: MemoryReviewDeps): Promise<MemoryReviewResult> {
  const { store, conversationId, avatarId } = deps

  const state = store.get(conversationId)
  const cursor = state?.last_reviewed_message_created_at ?? 0
  const userTurns = store.countUserMessagesSince(conversationId, cursor)
  if (userTurns < deps.reviewTurns) {
    return { ok: false, reason: `未达复盘轮数（${userTurns}/${deps.reviewTurns} 用户轮）` }
  }

  const transcript = store.getTranscriptSince(conversationId, cursor)
  if (transcript.length === 0) {
    return { ok: false, reason: '游标后无 user/assistant 消息' }
  }
  const latestCreatedAt = transcript[transcript.length - 1].created_at

  const memoryPath = path.join(deps.avatarsPath, avatarId, 'memory', 'MEMORY.md')
  const userPath = path.join(deps.avatarsPath, avatarId, 'memory', 'USER.md')
  const budget = resolveMemoryCharBudget(deps.avatarsPath, avatarId)
  const memoryDoc = readBoundedMemoryFile(memoryPath)
  const userDoc = readBoundedMemoryFile(userPath)

  const userPrompt = buildMemoryReviewUserPrompt({
    memoryDoc,
    userDoc,
    memoryBudget: budget,
    userBudget: budget,
    transcript: transcript.map(m => ({ role: m.role, content: m.content })),
  })

  const responseText = await deps.callLLM(MEMORY_REVIEW_SYSTEM_PROMPT, userPrompt, 1000)
  const { ops, nothingToSave } = parseMemoryReviewResponse(responseText)

  if (nothingToSave) {
    // "Nothing to save" 是合法输出：推进游标（这批轮次已消化），不写任何文件
    store.advanceCursor(conversationId, avatarId, latestCreatedAt)
    deps.log?.('info', 'memory-review', `conv=${conversationId} 复盘完成：Nothing to save（${userTurns} 用户轮已消化）`)
    return { ok: true, applied: 0, rejected: 0, nothingToSave: true }
  }

  // 竞态防护：LLM 调用是长 await，期间 memory_update 工具可能已改写文件——
  // op 应用前重新读盘，读→改→写全在同步段内完成（主进程单线程不可交叠），
  // 不用 prompt 阶段的旧快照覆盖并发写入
  const docs: Record<'memory' | 'user', BoundedMemoryDoc> = {
    memory: readBoundedMemoryFile(memoryPath),
    user: readBoundedMemoryFile(userPath),
  }
  const dirty: Record<'memory' | 'user', boolean> = { memory: false, user: false }
  const summaries: string[] = []
  let applied = 0
  let rejected = 0

  for (const item of ops) {
    const res = applyBoundedMemoryOp(docs[item.store], item.op, budget)
    if (!res.ok) {
      rejected++
      // 预算拒绝也是有价值的信号——记录但不中断其余 op（预算即遗忘由结构强制）
      deps.log?.('warn', 'memory-review-op-rejected', `conv=${conversationId} store=${item.store} op=${item.op.type}: ${res.error}`)
      continue
    }
    docs[item.store] = res.doc
    dirty[item.store] = true
    applied++
    const preview = item.op.type === 'remove'
      ? `remove ${res.entryId}（留痕: ${res.forgotten?.slice(0, 80) ?? ''}）`
      : `${item.op.type} ${res.entryId}: ${item.op.content.slice(0, 80)}`
    summaries.push(`[${item.store}] ${preview}`)
    // 遗忘留痕：删除/覆盖的原文记入持久日志，不做静默遗忘
    deps.log?.(
      'info',
      'memory-review-op',
      `conv=${conversationId} store=${item.store} op=${item.op.type} id=${res.entryId}` +
        (res.forgotten !== undefined ? ` forgotten="${res.forgotten.slice(0, 200)}"` : ''),
    )
  }

  if (dirty.memory) writeBoundedMemoryFileAtomic(memoryPath, docs.memory)
  if (dirty.user) writeBoundedMemoryFileAtomic(userPath, docs.user)

  store.advanceCursor(conversationId, avatarId, latestCreatedAt)

  if (applied > 0) {
    deps.recordEvent?.({
      updateCount: applied,
      summaryPreview: summaries.join(' · ').slice(0, 500),
      totalByteSize: boundedMemoryChars(docs.memory) + boundedMemoryChars(docs.user),
    })
  }
  deps.log?.('info', 'memory-review', `conv=${conversationId} 复盘完成：applied=${applied} rejected=${rejected}（${userTurns} 用户轮）`)
  return { ok: true, applied, rejected, nothingToSave: false }
}
