/**
 * 消息管线原语单测（AstrBot 借鉴 · 阶段 1a）。
 *
 * 编码的是"为什么"而非仅"是什么"：
 *   - 短路优先级：边界护栏命中后，澄清等后续 stage 必须不再执行（否则既拒答又反问）。
 *   - 增益组合：多个非短路 stage 能各自独立地改写 content / 增补 systemBlocks。
 *   - 短路后不再增益：护栏已给定式答案时，不该再往 systemBlocks 塞 palace 卡片。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runPreMessageStages, runPostMessageStages, type MessageContext, type MessageStage, type PostMessageStage } from './message-pipeline'

function baseCtx(overrides: Partial<MessageContext> = {}): MessageContext {
  return {
    conversationId: 'conv-1',
    avatarId: 'avatar-1',
    content: '原始问题',
    systemBlocks: [{ text: 'stable', cacheable: true }],
    hasAttachments: false,
    outcome: null,
    ...overrides,
  }
}

test('stage 按注册顺序执行', async () => {
  const order: string[] = []
  const mk = (name: string): MessageStage => ({ name, run: () => { order.push(name) } })
  await runPreMessageStages(baseCtx(), [mk('a'), mk('b'), mk('c')])
  assert.deepEqual(order, ['a', 'b', 'c'])
})

test('短路优先级：护栏置 outcome 后，后续澄清 stage 不再执行', async () => {
  const ran: string[] = []
  const guardrail: MessageStage = {
    name: 'guardrail',
    run: (ctx) => { ran.push('guardrail'); ctx.outcome = { kind: 'canned-answer', text: '不能披露实现细节' } },
  }
  const clarify: MessageStage = {
    name: 'clarify',
    run: (ctx) => { ran.push('clarify'); ctx.outcome = { kind: 'clarify', question: 'q', options: ['a'], original: ctx.content } },
  }
  const ctx = await runPreMessageStages(baseCtx(), [guardrail, clarify])
  assert.deepEqual(ran, ['guardrail'], '澄清 stage 不应在护栏短路后执行')
  assert.equal(ctx.outcome?.kind, 'canned-answer', 'outcome 应保持护栏的定式答案，未被澄清覆盖')
})

test('增益组合：nudge 改写 content 且 palace 增补 systemBlocks 都生效', async () => {
  const nudge: MessageStage = { name: 'nudge', run: (ctx) => { ctx.content = ctx.content + '\n[记忆提示]' } }
  const palace: MessageStage = { name: 'palace', run: (ctx) => { ctx.systemBlocks.push({ text: '[职场·路线卡预载]' }) } }
  const ctx = await runPreMessageStages(baseCtx(), [nudge, palace])
  assert.equal(ctx.outcome, null, '纯增益不应短路')
  assert.match(ctx.content, /\[记忆提示\]$/)
  assert.equal(ctx.systemBlocks.length, 2)
  assert.match(ctx.systemBlocks[1].text, /路线卡预载/)
})

test('短路后不再增益：护栏短路时 palace 不应再改 systemBlocks', async () => {
  const guardrail: MessageStage = { name: 'guardrail', run: (ctx) => { ctx.outcome = { kind: 'canned-answer', text: 'x' } } }
  const palace: MessageStage = { name: 'palace', run: (ctx) => { ctx.systemBlocks.push({ text: 'palace' }) } }
  const ctx = await runPreMessageStages(baseCtx(), [guardrail, palace])
  assert.equal(ctx.systemBlocks.length, 1, 'palace 不应在短路后运行')
})

test('async stage 被正确 await', async () => {
  const slow: MessageStage = { name: 'slow', run: async (ctx) => { await Promise.resolve(); ctx.content = 'changed' } }
  const ctx = await runPreMessageStages(baseCtx(), [slow])
  assert.equal(ctx.content, 'changed')
})

// ── post-message 管线：fire-and-forget、无短路、互不阻塞 ──
test('post: 所有 stage 都启动（无短路）', () => {
  const ran: string[] = []
  const mk = (n: string): PostMessageStage => ({ name: n, run: () => { ran.push(n) } })
  runPostMessageStages({ conversationId: 'c', avatarId: 'a' }, [mk('x'), mk('y'), mk('z')])
  assert.deepEqual(ran, ['x', 'y', 'z'])
})

test('post: 一个 stage 同步抛出，不影响后续 stage（互不阻塞）', () => {
  const ran: string[] = []
  const boom: PostMessageStage = { name: 'boom', run: () => { ran.push('boom'); throw new Error('x') } }
  const ok: PostMessageStage = { name: 'ok', run: () => { ran.push('ok') } }
  // runner 不应把同步抛出冒泡出来，且后续 stage 仍执行
  assert.doesNotThrow(() => runPostMessageStages({ conversationId: 'c', avatarId: 'a' }, [boom, ok]))
  assert.deepEqual(ran, ['boom', 'ok'])
})

test('post: async stage 的 rejection 被吞掉，不产生未处理 rejection', async () => {
  const rejected: PostMessageStage = { name: 'rej', run: async () => { throw new Error('async fail') } }
  // 不抛、不产生 unhandledRejection（runner 已 .catch）
  assert.doesNotThrow(() => runPostMessageStages({ conversationId: 'c', avatarId: 'a' }, [rejected]))
  await new Promise(r => setTimeout(r, 5)) // 让微任务跑完，确认无 unhandledRejection
})
