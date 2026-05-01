/**
 * batch-regression-runner.test.ts — 批量运行器 + 5 类断言单测
 *
 * 关键场景：
 *   断言层（5 类）
 *     - expectedTools 全命中 / 部分缺失 / 调用失败
 *     - expectedSkills 任一命中 / 全未加载 / 加载了但未命中
 *     - expectedValue 数值在容差内 / 容差外 / unit 邻近
 *     - mustContain / mustNotContain
 *   运行器
 *     - 模拟 sendMessage 触发 telemetry 事件，跑通整流程
 *     - 单题失败不影响后续
 *     - 单题超时变成 error
 *     - AbortSignal 在题间触发 → 提前终止
 *     - 进度回调按序触发 + cumulativePassRate 正确
 *     - categorySummary 聚合正确
 *
 * 运行：
 *   NODE_PATH=./test-support/node_modules npx tsx --test src/services/batch-regression-runner.test.ts
 *
 * @author zhi.qu
 * @date 2026-04-30
 */

import { test } from 'node:test'
import assert from 'node:assert'
import {
  assertExpectedTools,
  assertExpectedSkills,
  assertExpectedValue,
  assertMustContain,
  assertMustNotContain,
  runAllAssertions,
  runBatchRegression,
  type GeneratedQuestion,
  type BatchProgressEvent,
} from './batch-regression-runner'
import {
  regressionTelemetry,
  type TelemetryEvent,
} from './regression-telemetry'

// ─── Helper: 构造遥测事件 ──────────────────────────────────────────────

function ev(partial: Partial<TelemetryEvent> & { type: TelemetryEvent['type']; conversationId: string }): TelemetryEvent {
  const merged = { timestamp: Date.now(), ...partial } as TelemetryEvent
  return merged
}

function toolEnd(conversationId: string, name: string, ok = true): TelemetryEvent {
  return {
    type: 'tool-call-end',
    conversationId,
    timestamp: Date.now(),
    toolCallId: `tc-${Math.random()}`,
    name,
    durationMs: 10,
    ok,
  }
}

function toolStart(conversationId: string, name: string, args: Record<string, unknown> = {}): TelemetryEvent {
  return {
    type: 'tool-call-start',
    conversationId,
    timestamp: Date.now(),
    toolCallId: `tc-${Math.random()}`,
    name,
    args,
  }
}

// ─── 断言层：expectedTools ─────────────────────────────────────────────

test('assertExpectedTools: undefined / 空数组 → pass', () => {
  assert.strictEqual(assertExpectedTools([], undefined).pass, true)
  assert.strictEqual(assertExpectedTools([], []).pass, true)
})

test('assertExpectedTools: 全部命中 → pass', () => {
  const events = [
    toolEnd('c1', 'query_excel'),
    toolEnd('c1', 'load_skill'),
  ]
  assert.strictEqual(assertExpectedTools(events, ['query_excel', 'load_skill']).pass, true)
})

test('assertExpectedTools: 缺失 → fail', () => {
  const events = [toolEnd('c1', 'query_excel')]
  const r = assertExpectedTools(events, ['query_excel', 'load_skill'])
  assert.strictEqual(r.pass, false)
  assert.match(r.reason ?? '', /load_skill/)
})

test('assertExpectedTools: 调用了但全部 ok=false → fail', () => {
  const events = [toolEnd('c1', 'query_excel', false)]
  const r = assertExpectedTools(events, ['query_excel'])
  assert.strictEqual(r.pass, false)
  assert.match(r.reason ?? '', /失败/)
})

test('assertExpectedTools: 多次调用，至少一次成功 → pass', () => {
  const events = [
    toolEnd('c1', 'query_excel', false),
    toolEnd('c1', 'query_excel', true),
  ]
  assert.strictEqual(assertExpectedTools(events, ['query_excel']).pass, true)
})

// ─── 断言层：expectedSkills ────────────────────────────────────────────

test('assertExpectedSkills: 任一命中 → pass', () => {
  const events = [
    toolStart('c1', 'load_skill', { skill_id: 'chart-from-knowledge' }),
  ]
  assert.strictEqual(
    assertExpectedSkills(events, ['draw-chart', 'chart-from-knowledge']).pass,
    true,
  )
})

test('assertExpectedSkills: 完全未加载 → fail', () => {
  const events = [toolEnd('c1', 'query_excel')]
  const r = assertExpectedSkills(events, ['draw-chart'])
  assert.strictEqual(r.pass, false)
  assert.match(r.reason ?? '', /未调用 load_skill/)
})

test('assertExpectedSkills: 加载了但未命中 → fail', () => {
  const events = [toolStart('c1', 'load_skill', { skill_id: 'memory-update' })]
  const r = assertExpectedSkills(events, ['draw-chart'])
  assert.strictEqual(r.pass, false)
  assert.match(r.reason ?? '', /已加载/)
})

test('assertExpectedSkills: skill_id 非法（数字 / null）→ 当作未加载', () => {
  const events = [toolStart('c1', 'load_skill', { skill_id: 123 })]
  const r = assertExpectedSkills(events, ['draw-chart'])
  assert.strictEqual(r.pass, false)
})

// ─── 断言层：expectedValue ─────────────────────────────────────────────

test('assertExpectedValue: 容差内 → pass', () => {
  const r = assertExpectedValue(
    '答案是 90.3 设备效率',
    { value: 90.1, tolerancePct: 5 },
  )
  assert.strictEqual(r.pass, true)
})

test('assertExpectedValue: 容差外 → fail', () => {
  const r = assertExpectedValue(
    '答案是 80.5',
    { value: 90.1, tolerancePct: 5 },
  )
  assert.strictEqual(r.pass, false)
})

test('assertExpectedValue: unit 邻近匹配（在 ±10 字内）→ pass', () => {
  const r = assertExpectedValue(
    '电芯能量密度为 175 Wh/kg，循环寿命 8000 次',
    { value: 175, tolerancePct: 1, unit: 'Wh/kg' },
  )
  assert.strictEqual(r.pass, true)
})

test('assertExpectedValue: 数值对了但 unit 不在邻近 → fail', () => {
  const r = assertExpectedValue(
    '175 然后接一长串没有单位的描述长长长长长长长长长 Wh/kg',
    { value: 175, tolerancePct: 1, unit: 'Wh/kg' },
  )
  assert.strictEqual(r.pass, false)
})

test('assertExpectedValue: 答案为空 → fail', () => {
  const r = assertExpectedValue('', { value: 1, tolerancePct: 5 })
  assert.strictEqual(r.pass, false)
})

test('assertExpectedValue: undefined → pass（无期望即跳过）', () => {
  assert.strictEqual(assertExpectedValue('随意文本', undefined).pass, true)
})

test('assertExpectedValue: value=0 用绝对误差 ±0.5', () => {
  assert.strictEqual(assertExpectedValue('零次故障', { value: 0, tolerancePct: 5 }).pass, false)
  assert.strictEqual(assertExpectedValue('故障 0 次', { value: 0, tolerancePct: 5 }).pass, true)
  assert.strictEqual(assertExpectedValue('故障 0.3 次', { value: 0, tolerancePct: 5 }).pass, true)
})

// ─── 断言层：mustContain / mustNotContain ──────────────────────────────

test('mustContain: 全部出现 → pass', () => {
  assert.strictEqual(assertMustContain('引用 knowledge/abc.md', ['knowledge/']).pass, true)
})

test('mustContain: 缺一个 → fail', () => {
  const r = assertMustContain('只有 knowledge/', ['knowledge/', '具体数值'])
  assert.strictEqual(r.pass, false)
  assert.match(r.reason ?? '', /具体数值/)
})

test('mustNotContain: 任一出现 → fail', () => {
  const r = assertMustNotContain('能量密度约 200 Wh/kg', ['Wh/kg'])
  assert.strictEqual(r.pass, false)
  assert.match(r.reason ?? '', /Wh\/kg/)
})

test('mustNotContain: 全部未出现 → pass', () => {
  assert.strictEqual(
    assertMustNotContain('知识库无此信息', ['Wh/kg', '约']).pass,
    true,
  )
})

test('runAllAssertions: L4 明确无数据且有来源时豁免 chart 代码块', () => {
  const q: GeneratedQuestion = {
    id: 'L4-empty',
    category: 'L4_chart',
    prompt: '帮我画一个「故障次数_15」的折线图',
    mustContain: ['```chart'],
  }
  const r = runAllAssertions(
    q,
    '结论：故障次数_15 在目标机型行没有可用数据，无法生成图表。[来源: knowledge/_excel/chart-dashboard.json#Summary总表]',
    [],
  )
  assert.strictEqual(r.pass, true)
  assert.strictEqual(r.assertions.find(a => a.name === 'mustContain')?.pass, true)
})

test('runAllAssertions: L4 非无数据说明仍要求 chart 代码块', () => {
  const q: GeneratedQuestion = {
    id: 'L4-missing-chart',
    category: 'L4_chart',
    prompt: '帮我画一个「故障次数」的柱状图',
    mustContain: ['```chart'],
  }
  const r = runAllAssertions(q, '这里是图表分析，但没有 chart 代码块。', [])
  assert.strictEqual(r.pass, false)
  assert.strictEqual(r.assertions.find(a => a.name === 'mustContain')?.pass, false)
})

// ─── runAllAssertions 集成 ────────────────────────────────────────────

test('runAllAssertions: 全部通过 → pass=true', () => {
  const q: GeneratedQuestion = {
    id: 'q1',
    category: 'L1_excel_fact',
    prompt: 'x',
    expectedTools: ['query_excel'],
    expectedValue: { value: 90.1, tolerancePct: 5 },
    mustContain: ['knowledge/'],
  }
  const r = runAllAssertions(
    q,
    '答案 90.0，来源 knowledge/x.md',
    [toolEnd('c1', 'query_excel')],
  )
  assert.strictEqual(r.pass, true)
  assert.strictEqual(r.assertions.length, 5)
})

test('runAllAssertions: 任一失败 → pass=false', () => {
  const q: GeneratedQuestion = {
    id: 'q1',
    category: 'L9_redline',
    prompt: 'x',
    mustContain: ['知识库'],
    mustNotContain: ['Wh/kg'],
  }
  const r = runAllAssertions(q, '能量密度 200 Wh/kg', [])
  assert.strictEqual(r.pass, false)
  // mustContain 失败 + mustNotContain 失败 = 2 个
  const failed = r.assertions.filter(a => !a.pass)
  assert.strictEqual(failed.length, 2)
})

// ─── 运行器集成（mock sendMessage 通过 telemetry 模拟工作流） ─────────

interface MockHarnessOptions {
  /** 单题应触发的工具（用于 mock sendMessage emit 事件） */
  toolsPerCase?: string[]
  /** 单题答案 */
  answerPerCase?: string
  /** 强制让某些 caseIdx 抛错 */
  failIndices?: Set<number>
  /** 让某些 caseIdx 卡住超过 timeout */
  hangIndices?: Set<number>
}

/** 构造 sendMessage + waitForIdle 的 mock 实现 */
function buildHarness(harnessOpts: MockHarnessOptions = {}): {
  sendMessage: (content: string, conversationId: string, avatarId: string) => Promise<void>
  waitForIdle: (signal: AbortSignal) => Promise<void>
} {
  let caseCount = 0
  let lastConvId = ''

  const sendMessage = async (content: string, conversationId: string, _avatarId: string): Promise<void> => {
    const idx = caseCount++
    lastConvId = conversationId
    if (harnessOpts.failIndices?.has(idx)) {
      throw new Error(`mock failure for case ${idx}`)
    }
    if (harnessOpts.hangIndices?.has(idx)) {
      // 故意卡住，让 timeout 触发
      await new Promise(() => { /* never resolve */ })
      return
    }
    // 模拟 chatStore 的 emit 序列
    regressionTelemetry.emit({
      type: 'conversation-started',
      conversationId,
      timestamp: Date.now(),
      prompt: content,
    })
    for (const tool of harnessOpts.toolsPerCase ?? []) {
      regressionTelemetry.emit({
        type: 'tool-call-start',
        conversationId,
        timestamp: Date.now(),
        toolCallId: `tc-${Math.random()}`,
        name: tool,
        args: tool === 'load_skill' ? { skill_id: 'chart-from-knowledge' } : {},
      })
      regressionTelemetry.emit({
        type: 'tool-call-end',
        conversationId,
        timestamp: Date.now(),
        toolCallId: `tc-${Math.random()}`,
        name: tool,
        durationMs: 5,
        ok: true,
      })
    }
    regressionTelemetry.emit({
      type: 'message-done',
      conversationId,
      timestamp: Date.now(),
      content: harnessOpts.answerPerCase ?? '默认答案，引用 knowledge/x.md',
    })
  }

  const waitForIdle = async (_signal: AbortSignal): Promise<void> => {
    // Mock 假设 sendMessage 已经同步 emit 完了所有事件
    void lastConvId
    await new Promise(r => setTimeout(r, 5))
  }

  return { sendMessage, waitForIdle }
}

const Q_BASIC: GeneratedQuestion = {
  id: 'q-basic',
  category: 'L1_excel_fact',
  prompt: '默认问题',
  expectedTools: ['query_excel'],
  mustContain: ['knowledge/'],
}

test('runBatchRegression: 题库为空 → 抛错', async () => {
  const harness = buildHarness()
  await assert.rejects(
    () => runBatchRegression({
      runId: 'r1',
      avatarId: 'a1',
      questions: [],
      sendMessage: harness.sendMessage,
      waitForIdle: harness.waitForIdle,
    }),
    /题库为空/,
  )
})

test('runBatchRegression: 全部题通过', async () => {
  const harness = buildHarness({ toolsPerCase: ['query_excel'] })
  const result = await runBatchRegression({
    runId: 'r1',
    avatarId: 'a1',
    questions: [Q_BASIC, { ...Q_BASIC, id: 'q2' }],
    sendMessage: harness.sendMessage,
    waitForIdle: harness.waitForIdle,
    interCaseDelayMs: 0,
  })
  assert.strictEqual(result.totalCases, 2)
  assert.strictEqual(result.passCount, 2)
  assert.strictEqual(result.failCount, 0)
  assert.strictEqual(result.errorCount, 0)
  assert.deepStrictEqual(result.cases.map(c => c.pass), [true, true])
})

test('runBatchRegression: 单题失败不阻断后续', async () => {
  const harness = buildHarness({
    toolsPerCase: ['query_excel'],
    failIndices: new Set([1]), // 第 2 题抛错
  })
  const result = await runBatchRegression({
    runId: 'r1',
    avatarId: 'a1',
    questions: [Q_BASIC, { ...Q_BASIC, id: 'q2' }, { ...Q_BASIC, id: 'q3' }],
    sendMessage: harness.sendMessage,
    waitForIdle: harness.waitForIdle,
    interCaseDelayMs: 0,
  })
  assert.strictEqual(result.totalCases, 3)
  assert.strictEqual(result.passCount, 2)
  assert.strictEqual(result.failCount, 1)
  assert.strictEqual(result.errorCount, 1)
  assert.match(result.cases[1].error ?? '', /mock failure/)
})

test('runBatchRegression: 单题超时记为 error', async () => {
  const harness = buildHarness({
    toolsPerCase: ['query_excel'],
    hangIndices: new Set([0]),
  })
  const result = await runBatchRegression({
    runId: 'r1',
    avatarId: 'a1',
    questions: [Q_BASIC],
    sendMessage: harness.sendMessage,
    waitForIdle: harness.waitForIdle,
    perCaseTimeoutMs: 100,
    interCaseDelayMs: 0,
  })
  assert.strictEqual(result.errorCount, 1)
  assert.match(result.cases[0].error ?? '', /timeout/)
})

test('runBatchRegression: AbortSignal 提前终止 → 已跑完的题被保留', async () => {
  const harness = buildHarness({ toolsPerCase: ['query_excel'] })
  const controller = new AbortController()
  const onProgress = (e: BatchProgressEvent): void => {
    if (e.current === 2) controller.abort()
  }
  const result = await runBatchRegression({
    runId: 'r1',
    avatarId: 'a1',
    questions: [Q_BASIC, { ...Q_BASIC, id: 'q2' }, { ...Q_BASIC, id: 'q3' }, { ...Q_BASIC, id: 'q4' }],
    sendMessage: harness.sendMessage,
    waitForIdle: harness.waitForIdle,
    onProgress,
    signal: controller.signal,
    interCaseDelayMs: 0,
  })
  assert.strictEqual(result.totalCases, 2, 'abort 后 case 数量 = 已完成的')
  assert.strictEqual(result.passCount, 2)
})

test('runBatchRegression: 进度回调按序触发 + cumulativePassRate 正确', async () => {
  const harness = buildHarness({ toolsPerCase: ['query_excel'] })
  const events: BatchProgressEvent[] = []
  await runBatchRegression({
    runId: 'r1',
    avatarId: 'a1',
    questions: [Q_BASIC, { ...Q_BASIC, id: 'q2' }],
    sendMessage: harness.sendMessage,
    waitForIdle: harness.waitForIdle,
    onProgress: (e) => { events.push(e) },
    interCaseDelayMs: 0,
  })
  assert.strictEqual(events.length, 2)
  assert.strictEqual(events[0].current, 1)
  assert.strictEqual(events[0].cumulativePassRate, 1)
  assert.strictEqual(events[1].current, 2)
  assert.strictEqual(events[1].cumulativePassRate, 1)
})

test('runBatchRegression: 进度回调抛错不影响整体', async () => {
  const harness = buildHarness({ toolsPerCase: ['query_excel'] })
  // 静默 console.warn 避免污染输出
  const origWarn = console.warn
  console.warn = () => { /* 静默 */ }
  try {
    const result = await runBatchRegression({
      runId: 'r1',
      avatarId: 'a1',
      questions: [Q_BASIC, { ...Q_BASIC, id: 'q2' }],
      sendMessage: harness.sendMessage,
      waitForIdle: harness.waitForIdle,
      onProgress: () => { throw new Error('cb error') },
      interCaseDelayMs: 0,
    })
    assert.strictEqual(result.totalCases, 2)
    assert.strictEqual(result.passCount, 2)
  } finally {
    console.warn = origWarn
  }
})

test('runBatchRegression: categorySummary 聚合正确', async () => {
  const harness = buildHarness({ toolsPerCase: ['query_excel'] })
  const result = await runBatchRegression({
    runId: 'r1',
    avatarId: 'a1',
    questions: [
      { ...Q_BASIC, id: 'q1', category: 'L1_excel_fact' },
      { ...Q_BASIC, id: 'q2', category: 'L1_excel_fact' },
      { ...Q_BASIC, id: 'q3', category: 'L9_redline' },
    ],
    sendMessage: harness.sendMessage,
    waitForIdle: harness.waitForIdle,
    interCaseDelayMs: 0,
  })
  assert.strictEqual(result.categorySummary.L1_excel_fact?.total, 2)
  assert.strictEqual(result.categorySummary.L1_excel_fact?.pass, 2)
  assert.strictEqual(result.categorySummary.L9_redline?.total, 1)
})

test('runBatchRegression: setupPrompts 在收集 telemetry 之前下发，不计入 toolCallSequence', async () => {
  // 给 mock harness 一个能区分 setup vs prompt 的实现：
  // - 第 1 条消息（setup）只发一个 search_knowledge 工具
  // - 第 2 条消息（prompt）发一个 query_excel 工具
  let callIdx = 0
  const sendMessage = async (content: string, conversationId: string, _avatarId: string): Promise<void> => {
    const idx = callIdx++
    regressionTelemetry.emit({
      type: 'conversation-started',
      conversationId,
      timestamp: Date.now(),
      prompt: content,
    })
    const toolForThis = idx === 0 ? 'search_knowledge' : 'query_excel'
    regressionTelemetry.emit({
      type: 'tool-call-start',
      conversationId,
      timestamp: Date.now(),
      toolCallId: `tc-${Math.random()}`,
      name: toolForThis,
      args: {},
    })
    regressionTelemetry.emit({
      type: 'tool-call-end',
      conversationId,
      timestamp: Date.now(),
      toolCallId: `tc-${Math.random()}`,
      name: toolForThis,
      durationMs: 5,
      ok: true,
    })
    regressionTelemetry.emit({
      type: 'message-done',
      conversationId,
      timestamp: Date.now(),
      content: idx === 0 ? '256（华致）故障 1 次 [来源: knowledge/_excel/x.json#sheet=Summary&row=0]' : '上一条回答来自 knowledge/_excel/x.json',
    })
  }
  const waitForIdle = async (): Promise<void> => { await new Promise(r => setTimeout(r, 5)) }

  const result = await runBatchRegression({
    runId: 'rL8',
    avatarId: 'a1',
    questions: [
      {
        id: 'L8-test',
        category: 'L8_traceability',
        prompt: '上一条回答来自哪里？',
        mustContain: ['knowledge/'],
        setupPrompts: ['256（华致）故障次数 是多少？'],
      },
    ],
    sendMessage,
    waitForIdle,
    interCaseDelayMs: 0,
  })

  const c = result.cases[0]
  // setup 阶段的 search_knowledge 不应进入 sequence
  assert.deepStrictEqual(c.toolCallSequence, ['query_excel'])
  // prompt 阶段的 message-done 才是答案
  assert.match(c.answer, /上一条回答来自/)
  assert.strictEqual(c.pass, true)
})

test('runBatchRegression: setupPrompts 抛错时跳过正题并标 error', async () => {
  let callIdx = 0
  const sendMessage = async (content: string, _conversationId: string, _avatarId: string): Promise<void> => {
    if (callIdx++ === 0) {
      throw new Error('setup blew up')
    }
    // 不应到这一步
    void content
  }
  const waitForIdle = async (): Promise<void> => { await new Promise(r => setTimeout(r, 5)) }
  const result = await runBatchRegression({
    runId: 'rL8b',
    avatarId: 'a1',
    questions: [
      {
        id: 'L8-fail',
        category: 'L8_traceability',
        prompt: '正题',
        setupPrompts: ['前置铺垫'],
      },
    ],
    sendMessage,
    waitForIdle,
    interCaseDelayMs: 0,
  })
  const c = result.cases[0]
  assert.match(c.error ?? '', /setup-failed/)
  assert.strictEqual(c.pass, false)
})

test('runBatchRegression: case 包含完整字段（toolCallSequence/Counts/hasTodoWrite/conversationId）', async () => {
  const harness = buildHarness({ toolsPerCase: ['query_excel', 'load_skill'] })
  const result = await runBatchRegression({
    runId: 'rX',
    avatarId: 'a1',
    questions: [{ ...Q_BASIC, expectedSkills: ['chart-from-knowledge'] }],
    sendMessage: harness.sendMessage,
    waitForIdle: harness.waitForIdle,
    interCaseDelayMs: 0,
  })
  const c = result.cases[0]
  assert.deepStrictEqual(c.toolCallSequence, ['query_excel', 'load_skill'])
  assert.deepStrictEqual(c.toolCallCounts, { query_excel: 1, load_skill: 1 })
  assert.strictEqual(c.hasTodoWrite, false)
  assert.strictEqual(c.conversationId, 'regression-rX-0')
  assert.strictEqual(c.pass, true)
})

// 防止 ev 工具未使用的 lint 提示
test('helper ev 占位', () => {
  const e = ev({ type: 'message-done', conversationId: 'x', content: 'y' } as TelemetryEvent)
  assert.strictEqual(e.type, 'message-done')
})
