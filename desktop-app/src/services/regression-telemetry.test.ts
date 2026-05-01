/**
 * regression-telemetry.test.ts — 遥测总线 + 收集器单测
 *
 * 关键场景：
 *   - disable 状态下 emit 是无操作
 *   - enable 后多订阅者都能收到
 *   - unsubscribe 生效
 *   - 单订阅者抛错不影响其他订阅者
 *   - Collector 按 conversationId 过滤
 *   - Collector 重复 start 抛错
 *
 * 运行：
 *   NODE_PATH=./test-support/node_modules npx tsx --test src/services/regression-telemetry.test.ts
 *
 * @author zhi.qu
 * @date 2026-04-30
 */

import { test } from 'node:test'
import assert from 'node:assert'
import {
  regressionTelemetry,
  TelemetryCollector,
  type TelemetryEvent,
} from './regression-telemetry'

function makeStartedEvent(conversationId: string, prompt = 'q'): TelemetryEvent {
  return {
    type: 'conversation-started',
    conversationId,
    timestamp: Date.now(),
    prompt,
  }
}

function makeToolEndEvent(conversationId: string, name: string, ok = true): TelemetryEvent {
  return {
    type: 'tool-call-end',
    conversationId,
    timestamp: Date.now(),
    toolCallId: `tc-${Math.random()}`,
    name,
    durationMs: 12,
    ok,
  }
}

test('disable 状态下 emit 不触发订阅者', () => {
  regressionTelemetry.disable()
  let calls = 0
  const unsub = regressionTelemetry.subscribe(() => calls++)
  // disable 调用过后订阅者集合也被清空，subscribe 在 disable 之后会成功
  // 但 emit 在未 enable 状态下早退
  regressionTelemetry.emit(makeStartedEvent('c1'))
  assert.strictEqual(calls, 0, 'disable 状态 emit 不应触发')
  unsub()
})

test('enable 后 emit 触发所有订阅者', () => {
  regressionTelemetry.disable()
  regressionTelemetry.enable()
  let a = 0
  let b = 0
  const u1 = regressionTelemetry.subscribe(() => a++)
  const u2 = regressionTelemetry.subscribe(() => b++)
  regressionTelemetry.emit(makeStartedEvent('c1'))
  regressionTelemetry.emit(makeToolEndEvent('c1', 'query_excel'))
  assert.strictEqual(a, 2)
  assert.strictEqual(b, 2)
  u1()
  u2()
  regressionTelemetry.disable()
})

test('unsubscribe 生效，幂等安全', () => {
  regressionTelemetry.disable()
  regressionTelemetry.enable()
  let count = 0
  const unsub = regressionTelemetry.subscribe(() => count++)
  regressionTelemetry.emit(makeStartedEvent('c1'))
  unsub()
  unsub() // 重复调用安全
  regressionTelemetry.emit(makeStartedEvent('c1'))
  assert.strictEqual(count, 1, 'unsubscribe 后 emit 不应触发')
  regressionTelemetry.disable()
})

test('单个订阅者抛错不影响其他', () => {
  regressionTelemetry.disable()
  regressionTelemetry.enable()
  let goodCalls = 0
  const u1 = regressionTelemetry.subscribe(() => { throw new Error('bad subscriber') })
  const u2 = regressionTelemetry.subscribe(() => goodCalls++)
  // 用 console.warn 静默替换避免污染输出
  const origWarn = console.warn
  console.warn = () => { /* 静默 */ }
  try {
    regressionTelemetry.emit(makeStartedEvent('c1'))
    assert.strictEqual(goodCalls, 1, '另一个订阅者应仍被调用')
  } finally {
    console.warn = origWarn
    u1()
    u2()
    regressionTelemetry.disable()
  }
})

test('disable 清空所有订阅者', () => {
  const noop = (): void => { /* 占位 */ }
  regressionTelemetry.enable()
  regressionTelemetry.subscribe(noop)
  regressionTelemetry.subscribe(noop)
  // Set 去重：两次相同函数引用只算 1 个订阅者
  assert.strictEqual(regressionTelemetry.subscriberCount(), 1)
  regressionTelemetry.subscribe(() => { /* 不同引用 */ })
  assert.strictEqual(regressionTelemetry.subscriberCount(), 2)
  regressionTelemetry.disable()
  assert.strictEqual(regressionTelemetry.subscriberCount(), 0)
})

test('TelemetryCollector 按 conversationId 过滤', () => {
  regressionTelemetry.disable()
  regressionTelemetry.enable()
  const collector = new TelemetryCollector('conv-A')
  collector.start()

  regressionTelemetry.emit(makeStartedEvent('conv-A'))
  regressionTelemetry.emit(makeStartedEvent('conv-B'))
  regressionTelemetry.emit(makeToolEndEvent('conv-A', 'query_excel'))
  regressionTelemetry.emit(makeToolEndEvent('conv-B', 'load_skill'))

  const events = collector.stop()
  assert.strictEqual(events.length, 2, '应只收集 conv-A 的事件')
  assert.ok(events.every(e => e.conversationId === 'conv-A'))
  assert.deepStrictEqual(events.map(e => e.type), ['conversation-started', 'tool-call-end'])
  regressionTelemetry.disable()
})

test('TelemetryCollector stop 后再 emit 不被收集', () => {
  regressionTelemetry.disable()
  regressionTelemetry.enable()
  const collector = new TelemetryCollector('conv-A')
  collector.start()
  regressionTelemetry.emit(makeStartedEvent('conv-A'))
  const events1 = collector.stop()
  regressionTelemetry.emit(makeToolEndEvent('conv-A', 'query_excel'))
  assert.strictEqual(events1.length, 1)
  assert.strictEqual(collector.size(), 1, 'stop 后内部数组保留 stop 时刻的快照')
  regressionTelemetry.disable()
})

test('TelemetryCollector 重复 start 抛错', () => {
  regressionTelemetry.disable()
  regressionTelemetry.enable()
  const collector = new TelemetryCollector('conv-A')
  collector.start()
  assert.throws(() => collector.start(), /已 start/)
  collector.stop()
  // stop 后可以重新 start
  collector.start()
  collector.stop()
  regressionTelemetry.disable()
})

test('TelemetryCollector stop 返回事件数组副本（不被后续 reset 影响）', () => {
  regressionTelemetry.disable()
  regressionTelemetry.enable()
  const collector = new TelemetryCollector('conv-A')
  collector.start()
  regressionTelemetry.emit(makeStartedEvent('conv-A'))
  const snapshot = collector.stop()
  // 重新 start 不应影响已返回的快照
  collector.start()
  regressionTelemetry.emit(makeToolEndEvent('conv-A', 'query_excel'))
  assert.strictEqual(snapshot.length, 1, '快照应不变')
  collector.stop()
  regressionTelemetry.disable()
})
