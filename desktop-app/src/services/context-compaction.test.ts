/**
 * context-compaction.test.ts — BR-2
 *
 * 运行：
 *   NODE_PATH=./test-support/node_modules npx tsx --test src/services/context-compaction.test.ts
 *
 * 核心不变量：压缩后绝不产生"孤儿 tool 消息"（tool_call_id 找不到对应的 assistant tool_calls）——
 * 那会让 provider 直接 400。其余测试保证保守失败（无边界/空摘要→不压缩）。
 */

import { test } from 'node:test'
import assert from 'node:assert'
import type { LLMMessage } from './llm-service'
import { planContextCompaction, compactContextIfSafe, renderMiddleForSummary } from './context-compaction'

function toolCall(id: string, name = 'search') {
  return { id, type: 'function' as const, function: { name, arguments: '{}' } }
}

/** 断言消息序列中每条 tool 都能在其之前找到声明了该 tool_call_id 的 assistant。 */
function assertNoOrphanTools(messages: readonly LLMMessage[]): void {
  const declared = new Set<string>()
  for (const m of messages) {
    if (m.role === 'assistant' && m.tool_calls) {
      for (const tc of m.tool_calls) declared.add(tc.id)
    }
    if (m.role === 'tool') {
      assert.ok(
        m.tool_call_id && declared.has(m.tool_call_id),
        `孤儿 tool 消息：tool_call_id=${m.tool_call_id} 没有对应的 assistant tool_calls`,
      )
    }
  }
}

/** 断言不出现连续同角色（简化的 user/assistant 交替校验，Claude 对此敏感）。 */
function assertNoAdjacentSameRole(messages: readonly LLMMessage[]): void {
  for (let i = 1; i < messages.length; i++) {
    if (messages[i].role === 'assistant' && messages[i - 1].role === 'assistant') {
      // tool 结果后接 assistant、user 后接 assistant 都合法；这里只防摘要造成的 assistant-assistant
      assert.fail(`位置 ${i} 出现连续 assistant`)
    }
  }
}

// 中段工具结果给足长度，确保摘要替换是净收益（不触发 A3-5 inflation guard）
const CONVO: LLMMessage[] = [
  { role: 'user', content: 'Q1 首轮问题' },
  { role: 'assistant', content: '', tool_calls: [toolCall('t1')] },
  { role: 'tool', tool_call_id: 't1', content: 'R1 工具结果 ' + '检索命中的数据行内容。'.repeat(20) },
  { role: 'assistant', content: 'A1 首轮答案' },
  { role: 'user', content: 'Q2 第二轮' },
  { role: 'assistant', content: '', tool_calls: [toolCall('t2')] },
  { role: 'tool', tool_call_id: 't2', content: 'R2 工具结果 ' + '检索命中的数据行内容。'.repeat(20) },
  { role: 'assistant', content: 'A2 第二轮答案' },
  { role: 'user', content: 'Q3 当前轮' },
  { role: 'assistant', content: 'A3 当前答案' },
]

test('compactContextIfSafe: 压缩后不产生孤儿 tool 消息（核心不变量）', async () => {
  const outcome = await compactContextIfSafe({
    messages: CONVO,
    minTailMessages: 2,
    minMiddleMessages: 2,
    summarize: async () => '这是历史摘要，保留了 R1/R2 的关键结论',
  })
  assert.strictEqual(outcome.compacted, true)
  assertNoOrphanTools(outcome.messages)
  assertNoAdjacentSameRole(outcome.messages)
  // head 保留首条 user 原文；摘要作为 assistant 注入；比原来短
  assert.strictEqual(outcome.messages[0].content, 'Q1 首轮问题')
  assert.ok(outcome.messages.length < CONVO.length)
  assert.ok(
    outcome.messages.some((m) => typeof m.content === 'string' && m.content.includes('历史摘要')),
  )
})

test('planContextCompaction: 无 user → null；中段不足 → null', () => {
  assert.strictEqual(
    planContextCompaction(
      [{ role: 'assistant', content: 'x' }],
      { minTailMessages: 1, minMiddleMessages: 1 },
    ),
    null,
  )
  // 只有首尾、无足够中段
  assert.strictEqual(
    planContextCompaction(CONVO, { minTailMessages: 2, minMiddleMessages: 50 }),
    null,
  )
})

test('planContextCompaction: 边界落在 user 上（保证 tool-call 安全）', () => {
  const plan = planContextCompaction(CONVO, { minTailMessages: 2, minMiddleMessages: 2 })
  assert.ok(plan)
  assert.strictEqual(CONVO[plan!.headEnd - 1].role, 'user') // head 结束于 user
  assert.strictEqual(CONVO[plan!.tailStart].role, 'user') // tail 从 user 开始
})

test('compactContextIfSafe: 空摘要 → 保守不压缩（不冒破坏风险）', async () => {
  const outcome = await compactContextIfSafe({
    messages: CONVO,
    minTailMessages: 2,
    minMiddleMessages: 2,
    summarize: async () => '   ',
  })
  assert.strictEqual(outcome.compacted, false)
  assert.strictEqual(outcome.messages.length, CONVO.length)
})

test('compactContextIfSafe: tail 内的 tool_calls 结构原样保留（不经有损映射）', async () => {
  // 让 tail 包含一整轮工具调用：把当前轮做成带工具的
  const convo: LLMMessage[] = [
    { role: 'user', content: 'Q1' },
    { role: 'assistant', content: '', tool_calls: [toolCall('t1')] },
    { role: 'tool', tool_call_id: 't1', content: 'R1 ' + '较长的工具结果内容。'.repeat(20) },
    { role: 'assistant', content: 'A1' },
    { role: 'user', content: 'Q2' },
    { role: 'assistant', content: '', tool_calls: [toolCall('t2', 'query_excel')] },
    { role: 'tool', tool_call_id: 't2', content: 'R2' },
  ]
  const outcome = await compactContextIfSafe({
    messages: convo,
    minTailMessages: 2,
    minMiddleMessages: 2,
    summarize: async () => 'S',
  })
  assert.strictEqual(outcome.compacted, true)
  assertNoOrphanTools(outcome.messages)
  const tailAssistant = outcome.messages.find((m) => m.role === 'assistant' && m.tool_calls)
  assert.ok(tailAssistant?.tool_calls?.[0]?.function.name === 'query_excel')
})

test('compactContextIfSafe: 摘要+提示头反而更长 → 负收益回退（A3-5 inflation guard）', async () => {
  // 中段极短：任何摘要 + 固定提示头都比原文长，压缩是净负收益
  const convo: LLMMessage[] = [
    { role: 'user', content: 'Q1' },
    { role: 'assistant', content: 'A' },
    { role: 'user', content: 'q' },
    { role: 'assistant', content: 'a' },
    { role: 'user', content: 'Q3' },
    { role: 'assistant', content: 'A3' },
  ]
  const outcome = await compactContextIfSafe({
    messages: convo,
    minTailMessages: 2,
    minMiddleMessages: 2,
    summarize: async () => '这是一段比被压缩中段原文长得多的摘要文本，导致压缩净收益为负',
  })
  assert.strictEqual(outcome.compacted, false)
  assert.strictEqual(outcome.inflationRollback, true, '应在返回值里注明负收益回退')
  assert.strictEqual(outcome.messages, convo, '负收益时应整体回退返回原始输入引用')
})

test('renderMiddleForSummary: 标注角色与工具名，纯文本可读', () => {
  const out = renderMiddleForSummary([
    { role: 'assistant', content: '', tool_calls: [toolCall('t1', 'search_knowledge')] },
    { role: 'tool', tool_call_id: 't1', content: '命中 3 条' },
  ])
  assert.ok(out.includes('search_knowledge'))
  assert.ok(out.includes('命中 3 条'))
  assert.ok(out.includes('工具结果'))
})
