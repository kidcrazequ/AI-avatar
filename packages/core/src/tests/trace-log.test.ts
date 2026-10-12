/**
 * trace-log 聚合单测。
 *
 * 意图（WHY）：TracesPanel 与工作台账的数字是用户判断"分身怎么得出答案 /
 * 干了多少活"的依据，聚合口径错了会直接误导（docs/staffdeck-adoption-plan.md W1/W2）。
 * 钉死三条口径：
 *   1. 只聚合 assistant 且时间线非空的消息——user/system 消息绝不产生轮次
 *   2. skipped 条目保留在 entries 供展示，但**不进任何计数**
 *   3. 0 轮时 avgTurnDurationMs 为 0（不除零），topTools 并列按名称稳定排序
 *
 * 运行：
 *   npx tsx --test packages/core/src/tests/trace-log.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  aggregateTraceTurns,
  aggregateWorkStats,
  type TraceMessageInput,
  type TraceTimelineEntry,
} from '../trace-log'

function entry(partial: Partial<TraceTimelineEntry> & { name: string }): TraceTimelineEntry {
  return {
    id: `e-${partial.name}`,
    argsPreview: '',
    resultPreview: '',
    durationMs: 100,
    ok: true,
    startedAt: 1000,
    ...partial,
  }
}

test('只聚合 assistant 且时间线非空的消息；顺序与输入一致', () => {
  const messages: TraceMessageInput[] = [
    { id: 'u1', role: 'user' },
    { id: 'a1', role: 'assistant', toolCallTimeline: [entry({ name: 'search_knowledge', kind: 'rag' })] },
    { id: 'a2', role: 'assistant', toolCallTimeline: [] },
    { id: 'a3', role: 'assistant', toolCallTimeline: null },
    { id: 'a4', role: 'assistant', toolCallTimeline: [entry({ name: 'web_fetch' })] },
  ]
  const turns = aggregateTraceTurns(messages)
  assert.deepEqual(turns.map((t) => t.turnId), ['a1', 'a4'], 'user/空时间线消息不得产生轮次')
})

test('计数口径：kind 分类、缺省 kind 视为 tool、skipped 保留但不计数、failed 判定', () => {
  const turns = aggregateTraceTurns([
    {
      id: 'a1',
      role: 'assistant',
      toolCallTimeline: [
        entry({ name: 'search_knowledge', kind: 'rag', durationMs: 50 }),
        entry({ name: 'load_skill', kind: 'skill', durationMs: 30 }),
        entry({ name: 'web_fetch', ok: false, durationMs: 200 }),          // 缺省 kind → tool
        entry({ name: 'query_excel', skipped: true, ok: false, durationMs: 999 }), // skipped 全豁免
      ],
    },
  ])
  assert.equal(turns.length, 1)
  const t = turns[0]
  assert.equal(t.ragCount, 1)
  assert.equal(t.skillCount, 1)
  assert.equal(t.toolCount, 1, '缺省 kind 计入 tool；skipped 不计')
  assert.equal(t.failedCount, 1, 'skipped 的失败不算失败')
  assert.equal(t.totalDurationMs, 280, 'skipped 耗时不入总耗时')
  assert.equal(t.hasError, true)
  assert.equal(t.entries.length, 4, 'skipped 条目仍保留在 entries 供 UI 展示')
})

test('startedAt 回退链：首个有效事件 → 消息 createdAt → 0', () => {
  const withEvent = aggregateTraceTurns([
    { id: 'a1', role: 'assistant', createdAt: 5, toolCallTimeline: [entry({ name: 'x', startedAt: 42 })] },
  ])
  assert.equal(withEvent[0].startedAt, 42)
  const fromMsg = aggregateTraceTurns([
    { id: 'a2', role: 'assistant', createdAt: 5, toolCallTimeline: [entry({ name: 'x', startedAt: 0 })] },
  ])
  assert.equal(fromMsg[0].startedAt, 5, 'startedAt=0 视为无效，回退消息时间')
  const bare = aggregateTraceTurns([
    { id: 'a3', role: 'assistant', toolCallTimeline: [entry({ name: 'x', startedAt: 0 })] },
  ])
  assert.equal(bare[0].startedAt, 0)
})

test('工作台账：跨会话聚合、topTools 稳定排序、0 轮不除零', () => {
  const conv1 = aggregateTraceTurns([
    {
      id: 'a1',
      role: 'assistant',
      toolCallTimeline: [
        entry({ name: 'search_knowledge', kind: 'rag', durationMs: 100 }),
        entry({ name: 'web_fetch', ok: false, durationMs: 300 }),
      ],
    },
  ])
  const conv2 = aggregateTraceTurns([
    {
      id: 'b1',
      role: 'assistant',
      toolCallTimeline: [
        entry({ name: 'web_fetch', durationMs: 100 }),
        entry({ name: 'query_excel', durationMs: 100 }),
        entry({ name: 'ignored', skipped: true }),
      ],
    },
  ])
  const stats = aggregateWorkStats([conv1, conv2])
  assert.equal(stats.conversationCount, 2)
  assert.equal(stats.turnCount, 2)
  assert.equal(stats.toolCallCount, 4, 'skipped 不进用量')
  assert.equal(stats.failedToolCount, 1)
  assert.equal(stats.ragTurnCount, 1)
  assert.equal(stats.avgTurnDurationMs, Math.round((400 + 200) / 2))
  assert.deepEqual(
    stats.topTools.map((u) => u.name),
    ['web_fetch', 'query_excel', 'search_knowledge'],
    'count 降序；并列(1次)按名称字典序稳定',
  )
  assert.deepEqual(stats.topTools[0], { name: 'web_fetch', count: 2, failed: 1 })

  const empty = aggregateWorkStats([])
  assert.equal(empty.avgTurnDurationMs, 0, '0 轮不除零')
  assert.deepEqual(empty.topTools, [])
})
