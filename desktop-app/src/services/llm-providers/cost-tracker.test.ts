/**
 * cost-tracker.test.ts
 *
 * 运行：
 *   NODE_PATH=./test-support/node_modules npx tsx --test src/services/llm-providers/cost-tracker.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert'
import { costTracker, DEFAULT_PRICING, resolveTurnBudgetUsd } from './cost-tracker'

test('computeCost: Claude sonnet 价位换算', () => {
  costTracker.reset()
  const c = costTracker.computeCost('claude-sonnet-4-6', {
    inputTokens: 1_000_000,
    outputTokens: 500_000,
    cacheReadTokens: 200_000,
    cacheCreationTokens: 100_000,
  })
  // 3.0 * 1M + 15.0 * 0.5M + 0.3 * 0.2M + 3.75 * 0.1M
  const expected = 3.0 + 7.5 + 0.06 + 0.375
  assert.ok(Math.abs(c.total - expected) < 1e-6, `total=${c.total} vs ${expected}`)
})

test('record: 同 (avatar, model) 累加，不同分桶', () => {
  costTracker.reset()
  costTracker.record('a1', 'claude-sonnet-4-6', { inputTokens: 1000, outputTokens: 100 })
  costTracker.record('a1', 'claude-sonnet-4-6', { inputTokens: 2000, outputTokens: 200 })
  costTracker.record('a1', 'deepseek-chat', { inputTokens: 5000, outputTokens: 500 })
  costTracker.record('a2', 'claude-sonnet-4-6', { inputTokens: 100, outputTokens: 10 })

  const a1 = costTracker.summary('a1')
  assert.strictEqual(a1.length, 2)
  const sonnet = a1.find(r => r.model === 'claude-sonnet-4-6')!
  assert.strictEqual(sonnet.callCount, 2)
  assert.strictEqual(sonnet.usage.inputTokens, 3000)
  assert.strictEqual(sonnet.usage.outputTokens, 300)

  const all = costTracker.summary()
  assert.strictEqual(all.length, 3)
})

test('未知模型：token 计入 cost=0，只 warn 一次', () => {
  costTracker.reset()
  const origWarn = console.warn
  let warnCount = 0
  console.warn = () => { warnCount++ }
  try {
    costTracker.record('a', 'unknown-model-xyz', { inputTokens: 100, outputTokens: 50 })
    costTracker.record('a', 'unknown-model-xyz', { inputTokens: 100, outputTokens: 50 })
    const rows = costTracker.summary('a')
    assert.strictEqual(rows[0].usage.inputTokens, 200)
    assert.strictEqual(rows[0].cost.total, 0)
    assert.strictEqual(warnCount, 1)
  } finally {
    console.warn = origWarn
  }
})

test('setPricing: 运行时覆盖', () => {
  costTracker.reset()
  costTracker.setPricing('my-local-llm', { inputPerMillion: 0, outputPerMillion: 0 })
  costTracker.record('a', 'my-local-llm', { inputTokens: 1000, outputTokens: 1000 })
  assert.strictEqual(costTracker.summary('a')[0].cost.total, 0)
})

test('usage 缺失：record noop', () => {
  costTracker.reset()
  costTracker.record('a', 'claude-sonnet-4-6', undefined)
  assert.strictEqual(costTracker.summary().length, 0)
})

test('DEFAULT_PRICING 覆盖 Soul 当前两个 provider 的主流型号', () => {
  for (const key of ['claude-opus-4-7', 'claude-sonnet-4-6', 'deepseek-chat']) {
    assert.ok(DEFAULT_PRICING[key], `缺少定价: ${key}`)
  }
})

// BR-1: 单轮成本上限解析——关键不变量是"歧义即关闭"，绝不能因解析问题误停一次正常对话
test('resolveTurnBudgetUsd: 空/非法/≤0 一律关闭（返回 0），避免误停正常对话', () => {
  assert.strictEqual(resolveTurnBudgetUsd(undefined), 0)
  assert.strictEqual(resolveTurnBudgetUsd(null), 0)
  assert.strictEqual(resolveTurnBudgetUsd(''), 0)
  assert.strictEqual(resolveTurnBudgetUsd('   '), 0)
  assert.strictEqual(resolveTurnBudgetUsd('abc'), 0)
  assert.strictEqual(resolveTurnBudgetUsd('NaN'), 0)
  assert.strictEqual(resolveTurnBudgetUsd('0'), 0)
  assert.strictEqual(resolveTurnBudgetUsd('-1.5'), 0)
})

test('resolveTurnBudgetUsd: 有效正数原样返回，作为单轮成本硬上限', () => {
  assert.strictEqual(resolveTurnBudgetUsd('0.5'), 0.5)
  assert.strictEqual(resolveTurnBudgetUsd('2'), 2)
  assert.strictEqual(resolveTurnBudgetUsd('10.25'), 10.25)
  assert.strictEqual(resolveTurnBudgetUsd(' 3.0 '), 3) // parseFloat 容忍首尾空白
})
