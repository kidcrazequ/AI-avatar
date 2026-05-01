/**
 * batch-report-generator.test.ts — 报告生成器单测
 *
 * 关键场景：
 *   聚合层
 *     - 全通过 / 全失败 / 混合
 *     - 空 cases（零值结构，不 NaN）
 *     - 类别按 passRate 升序
 *     - 工具统计去重 affected
 *     - 失败断言分桶 + sampleReasons 截断
 *     - 红线专项
 *     - 性能最慢前 5
 *   LLM 层
 *     - 无失败 case → ok=true, causes=[]
 *     - LLM 抛错 → ok=false
 *     - LLM 返回 ```json 包裹 / 尾随文本 → 容错解析
 *     - causes 按 priority 排序（P0 在前）
 *   渲染层
 *     - MD 包含核心 section
 *     - HTML 转义 < > &
 *     - HTML 内嵌 escape 后的 markdown 源
 *
 * 运行：
 *   NODE_PATH=./test-support/node_modules npx tsx --test src/services/batch-report-generator.test.ts
 *
 * @author zhi.qu
 * @date 2026-04-30
 */

import { test } from 'node:test'
import assert from 'node:assert'
import {
  aggregateReport,
  requestRootCauseAnalysis,
  renderMarkdownReport,
  renderHtmlReport,
  type ReportSummary,
  type RootCauseAnalysis,
  type CallLLMFn,
} from './batch-report-generator'
import type {
  BatchRunResult,
  CaseResult,
  QuestionCategory,
} from './batch-regression-runner'

// ─── Helper：构造 fixture ──────────────────────────────────────────────

function makeCase(overrides: Partial<CaseResult> = {}): CaseResult {
  return {
    questionId: overrides.questionId ?? 'q1',
    category: overrides.category ?? 'L1_excel_fact',
    prompt: overrides.prompt ?? '默认问题',
    conversationId: overrides.conversationId ?? 'conv-1',
    answer: overrides.answer ?? '默认答案',
    toolCallSequence: overrides.toolCallSequence ?? [],
    toolCallCounts: overrides.toolCallCounts ?? {},
    hasTodoWrite: overrides.hasTodoWrite ?? false,
    durationMs: overrides.durationMs ?? 100,
    assertions: overrides.assertions ?? [
      { name: 'expectedTools', pass: true },
      { name: 'expectedSkills', pass: true },
      { name: 'expectedValue', pass: true },
      { name: 'mustContain', pass: true },
      { name: 'mustNotContain', pass: true },
    ],
    pass: overrides.pass ?? true,
    error: overrides.error,
  }
}

function makeRunResult(cases: CaseResult[], opts: Partial<BatchRunResult> = {}): BatchRunResult {
  const passCount = cases.filter(c => c.pass).length
  const failCount = cases.filter(c => !c.pass).length
  const errorCount = cases.filter(c => c.error).length
  const categorySummary: Record<string, { total: number; pass: number; fail: number }> = {}
  for (const c of cases) {
    const s = categorySummary[c.category] ?? { total: 0, pass: 0, fail: 0 }
    s.total++
    if (c.pass) s.pass++; else s.fail++
    categorySummary[c.category] = s
  }
  return {
    runId: opts.runId ?? 'run-1',
    avatarId: opts.avatarId ?? 'test-avatar',
    startedAt: opts.startedAt ?? 1_700_000_000_000,
    finishedAt: opts.finishedAt ?? 1_700_000_010_000,
    totalCases: cases.length,
    passCount,
    failCount,
    errorCount,
    categorySummary,
    cases,
  }
}

// ─── 聚合层 ────────────────────────────────────────────────────────────

test('aggregateReport: cases 为空 → 零值结构（不 NaN）', () => {
  const r = aggregateReport(makeRunResult([]))
  assert.strictEqual(r.totalCases, 0)
  assert.strictEqual(r.overallPassRate, 0)
  assert.strictEqual(r.todoUsageRate, 0)
  assert.strictEqual(r.performance.avgDurationMs, 0)
  assert.strictEqual(r.performance.medianDurationMs, 0)
  assert.deepStrictEqual(r.performance.slowestCases, [])
  assert.strictEqual(r.redline.total, 0)
  assert.deepStrictEqual(r.categoryStats, [])
  assert.deepStrictEqual(r.toolStats, [])
  assert.deepStrictEqual(r.assertionFailures, [])
})

test('aggregateReport: 全通过 → overallPassRate=1, 无失败断言', () => {
  const r = aggregateReport(makeRunResult([makeCase(), makeCase({ questionId: 'q2' })]))
  assert.strictEqual(r.overallPassRate, 1)
  assert.deepStrictEqual(r.assertionFailures, [])
})

test('aggregateReport: 类别按 passRate 升序', () => {
  const r = aggregateReport(makeRunResult([
    makeCase({ questionId: 'a1', category: 'L1_excel_fact', pass: true }),
    makeCase({ questionId: 'a2', category: 'L1_excel_fact', pass: true }),
    makeCase({ questionId: 'b1', category: 'L9_redline', pass: false, assertions: [{ name: 'mustNotContain', pass: false, reason: 'x' }] }),
    makeCase({ questionId: 'b2', category: 'L9_redline', pass: false, assertions: [{ name: 'mustNotContain', pass: false, reason: 'y' }] }),
    makeCase({ questionId: 'c1', category: 'L4_chart', pass: true }),
    makeCase({ questionId: 'c2', category: 'L4_chart', pass: false, assertions: [{ name: 'mustContain', pass: false, reason: 'z' }] }),
  ]))
  // L9_redline pass=0/2=0 < L4_chart 0.5 < L1_excel_fact 1.0
  assert.deepStrictEqual(r.categoryStats.map(c => c.category), ['L9_redline', 'L4_chart', 'L1_excel_fact'])
})

test('aggregateReport: 工具统计 affectedCases 去重', () => {
  const r = aggregateReport(makeRunResult([
    makeCase({ questionId: 'a', toolCallSequence: ['query_excel', 'query_excel', 'load_skill'] }),
    makeCase({ questionId: 'b', toolCallSequence: ['query_excel'] }),
  ]))
  const qe = r.toolStats.find(t => t.name === 'query_excel')!
  assert.strictEqual(qe.totalCalls, 3)
  assert.strictEqual(qe.affectedCases, 2)
  const ls = r.toolStats.find(t => t.name === 'load_skill')!
  assert.strictEqual(ls.totalCalls, 1)
  assert.strictEqual(ls.affectedCases, 1)
})

test('aggregateReport: 工具按 totalCalls 降序', () => {
  const r = aggregateReport(makeRunResult([
    makeCase({ questionId: 'a', toolCallSequence: ['load_skill'] }),
    makeCase({ questionId: 'b', toolCallSequence: ['query_excel', 'query_excel'] }),
  ]))
  assert.deepStrictEqual(r.toolStats.map(t => t.name), ['query_excel', 'load_skill'])
})

test('aggregateReport: 失败断言分桶 + sampleReasons 最多 3', () => {
  const cases = []
  for (let i = 0; i < 5; i++) {
    cases.push(makeCase({
      questionId: `q${i}`,
      pass: false,
      assertions: [{ name: 'mustContain', pass: false, reason: `reason-${i}` }],
    }))
  }
  const r = aggregateReport(makeRunResult(cases))
  const bucket = r.assertionFailures.find(b => b.name === 'mustContain')!
  assert.strictEqual(bucket.count, 5)
  assert.strictEqual(bucket.shareInFailures, 1)
  assert.strictEqual(bucket.sampleReasons.length, 3)
})

test('aggregateReport: error case 进 runtime-error 桶', () => {
  const r = aggregateReport(makeRunResult([
    makeCase({ questionId: 'q1', pass: false, error: 'timeout', assertions: [] }),
    makeCase({ questionId: 'q2', pass: false, assertions: [{ name: 'mustContain', pass: false, reason: 'x' }] }),
  ]))
  const errBucket = r.assertionFailures.find(b => b.name === 'runtime-error')
  assert.ok(errBucket)
  assert.strictEqual(errBucket!.count, 1)
})

test('aggregateReport: 红线专项', () => {
  const r = aggregateReport(makeRunResult([
    makeCase({ questionId: 'r1', category: 'L9_redline', pass: true }),
    makeCase({ questionId: 'r2', category: 'L9_redline', pass: false, assertions: [{ name: 'mustNotContain', pass: false, reason: '出现 Wh/kg' }] }),
    makeCase({ questionId: 'r3', category: 'L9_redline', pass: false, error: 'timeout', assertions: [] }),
  ]))
  assert.strictEqual(r.redline.total, 3)
  assert.strictEqual(r.redline.pass, 1)
  assert.strictEqual(r.redline.fail, 2)
  assert.strictEqual(r.redline.violations.length, 2)
  assert.match(r.redline.violations[0].reason, /Wh\/kg/)
  assert.strictEqual(r.redline.violations[1].reason, 'timeout')
})

test('aggregateReport: 性能取最慢前 5', () => {
  const cases = []
  for (let i = 0; i < 10; i++) {
    cases.push(makeCase({ questionId: `q${i}`, durationMs: i * 1000 }))
  }
  const r = aggregateReport(makeRunResult(cases))
  assert.strictEqual(r.performance.slowestCases.length, 5)
  assert.strictEqual(r.performance.slowestCases[0].questionId, 'q9')
  assert.strictEqual(r.performance.slowestCases[4].questionId, 'q5')
})

test('aggregateReport: todoUsageRate', () => {
  const r = aggregateReport(makeRunResult([
    makeCase({ questionId: 'a', hasTodoWrite: true }),
    makeCase({ questionId: 'b', hasTodoWrite: false }),
    makeCase({ questionId: 'c', hasTodoWrite: false }),
    makeCase({ questionId: 'd', hasTodoWrite: true }),
  ]))
  assert.strictEqual(r.todoUsageRate, 0.5)
})

// ─── LLM 层 ────────────────────────────────────────────────────────────

function makeSummary(overrides: Partial<ReportSummary> = {}): ReportSummary {
  return {
    runId: 'run-1', avatarId: 'a',
    startedAt: 0, finishedAt: 1000, durationMs: 1000,
    totalCases: 1, passCount: 1, failCount: 0, errorCount: 0,
    overallPassRate: 1, todoUsageRate: 0,
    categoryStats: [], toolStats: [], assertionFailures: [],
    performance: { avgDurationMs: 100, medianDurationMs: 100, slowestCases: [] },
    redline: { total: 0, pass: 0, fail: 0, violations: [] },
    ...overrides,
  }
}

test('requestRootCauseAnalysis: 无失败 → ok=true causes=[]', async () => {
  const callLLM: CallLLMFn = async () => { throw new Error('不应被调用') }
  const result = await requestRootCauseAnalysis(makeSummary(), [makeCase()], callLLM)
  assert.strictEqual(result.ok, true)
  assert.strictEqual(result.causes.length, 0)
  assert.strictEqual(result.sampledCases, 0)
})

test('requestRootCauseAnalysis: LLM 抛错 → ok=false', async () => {
  const callLLM: CallLLMFn = async () => { throw new Error('网络超时') }
  const result = await requestRootCauseAnalysis(
    makeSummary({ failCount: 1, passCount: 0, totalCases: 1 }),
    [makeCase({ pass: false, assertions: [{ name: 'mustContain', pass: false, reason: 'x' }] })],
    callLLM,
  )
  assert.strictEqual(result.ok, false)
  assert.match(result.error ?? '', /网络超时/)
})

test('requestRootCauseAnalysis: ```json 包裹被剥离', async () => {
  const fakeResp = '前置文本\n```json\n{\n  "overview": "整体一般",\n  "causes": [{"title":"A","description":"d","affectedCategories":["L1_excel_fact"],"affectedCases":3,"priority":"P1","recommendation":"r"}]\n}\n```\n后置文本'
  const callLLM: CallLLMFn = async () => fakeResp
  const result = await requestRootCauseAnalysis(
    makeSummary({ failCount: 1, passCount: 0, totalCases: 1 }),
    [makeCase({ pass: false, assertions: [{ name: 'mustContain', pass: false, reason: 'x' }] })],
    callLLM,
  )
  assert.strictEqual(result.ok, true)
  assert.strictEqual(result.overview, '整体一般')
  assert.strictEqual(result.causes.length, 1)
  assert.strictEqual(result.causes[0].title, 'A')
})

test('requestRootCauseAnalysis: causes 按 priority 排序', async () => {
  const fakeResp = JSON.stringify({
    overview: 'x',
    causes: [
      { title: 'C2', description: 'd', priority: 'P2', recommendation: 'r', affectedCategories: [], affectedCases: 1 },
      { title: 'C0', description: 'd', priority: 'P0', recommendation: 'r', affectedCategories: [], affectedCases: 1 },
      { title: 'C1', description: 'd', priority: 'P1', recommendation: 'r', affectedCategories: [], affectedCases: 1 },
    ],
  })
  const callLLM: CallLLMFn = async () => fakeResp
  const result = await requestRootCauseAnalysis(
    makeSummary({ failCount: 1, passCount: 0, totalCases: 1 }),
    [makeCase({ pass: false, assertions: [{ name: 'mustContain', pass: false, reason: 'x' }] })],
    callLLM,
  )
  assert.deepStrictEqual(result.causes.map(c => c.title), ['C0', 'C1', 'C2'])
})

test('requestRootCauseAnalysis: 非法字段被容错（priority 默认 P2）', async () => {
  const fakeResp = JSON.stringify({
    overview: 'x',
    causes: [{ title: 'X', description: 'd', priority: '紧急', recommendation: 'r' }],
  })
  const callLLM: CallLLMFn = async () => fakeResp
  const result = await requestRootCauseAnalysis(
    makeSummary({ failCount: 1, passCount: 0, totalCases: 1 }),
    [makeCase({ pass: false, assertions: [{ name: 'mustContain', pass: false, reason: 'x' }] })],
    callLLM,
  )
  assert.strictEqual(result.causes[0].priority, 'P2')
  assert.deepStrictEqual(result.causes[0].affectedCategories, [])
})

test('requestRootCauseAnalysis: 每类别采样上限 3', async () => {
  let receivedPrompt = ''
  const callLLM: CallLLMFn = async (prompt) => {
    receivedPrompt = prompt
    return JSON.stringify({ overview: 'x', causes: [] })
  }
  // 同类别 5 个失败 case
  const cases: CaseResult[] = []
  const cat: QuestionCategory = 'L1_excel_fact'
  for (let i = 0; i < 5; i++) {
    cases.push(makeCase({ questionId: `q${i}`, category: cat, pass: false, assertions: [{ name: 'mustContain', pass: false, reason: 'x' }] }))
  }
  await requestRootCauseAnalysis(
    makeSummary({ failCount: 5, passCount: 0, totalCases: 5 }),
    cases,
    callLLM,
  )
  // 检查 prompt 中只有 3 条 q（采样上限）
  const matches = receivedPrompt.match(/"id"\s*:\s*"q\d+"/g) ?? []
  assert.strictEqual(matches.length, 3, '每类别上限 3，但实际:' + matches.length)
})

// ─── 渲染层 ────────────────────────────────────────────────────────────

test('renderMarkdownReport: 包含全部主 section', () => {
  const summary = aggregateReport(makeRunResult([
    makeCase({ questionId: 'a', toolCallSequence: ['query_excel'] }),
    makeCase({ questionId: 'b', category: 'L9_redline', pass: false, assertions: [{ name: 'mustNotContain', pass: false, reason: '出现 Wh/kg' }] }),
  ]))
  const md = renderMarkdownReport(summary)
  assert.match(md, /# 批量回归评估报告/)
  assert.match(md, /## 1\. 总体摘要/)
  assert.match(md, /## 2\. 按类别通过率/)
  assert.match(md, /## 3\. 工具使用统计/)
  assert.match(md, /## 4\. 失败断言分布/)
  assert.match(md, /## 5\. 红线/)
  assert.match(md, /## 6\. 性能/)
  // 没传 analysis，section 7 不应出现
  assert.doesNotMatch(md, /## 7\. AI 根因分析/)
})

test('renderMarkdownReport: 含 analysis 时出现 section 7', () => {
  const summary = aggregateReport(makeRunResult([makeCase()]))
  const analysis: RootCauseAnalysis = {
    overview: '整体良好',
    causes: [{
      title: 'X', description: 'd', priority: 'P1',
      recommendation: 'r', affectedCategories: ['L1_excel_fact'], affectedCases: 3,
    }],
    sampledCases: 1, ok: true,
  }
  const md = renderMarkdownReport(summary, analysis)
  assert.match(md, /## 7\. AI 根因分析/)
  assert.match(md, /\[P1\] X/)
  assert.match(md, /整体良好/)
})

test('renderMarkdownReport: AI 分析失败时显示错误', () => {
  const summary = aggregateReport(makeRunResult([makeCase()]))
  const analysis: RootCauseAnalysis = {
    overview: '', causes: [], sampledCases: 0, ok: false, error: 'API 超时',
  }
  const md = renderMarkdownReport(summary, analysis)
  assert.match(md, /AI 分析失败.*API 超时/)
})

test('renderHtmlReport: 包含 DOCTYPE + title + escape 后的 markdown', () => {
  const summary = aggregateReport(makeRunResult([
    makeCase({ prompt: '<script>alert("x")</script>' }),
  ]))
  const html = renderHtmlReport(summary)
  assert.match(html, /<!DOCTYPE html>/)
  assert.match(html, /回归报告/)
  // < > 应被转义
  assert.doesNotMatch(html, /<script>alert/)
  assert.match(html, /&lt;script&gt;alert/)
  // 应内嵌 marked CDN
  assert.match(html, /marked\.min\.js/)
})

test('renderHtmlReport: 空 cases → 渲染不抛错', () => {
  const summary = aggregateReport(makeRunResult([]))
  const html = renderHtmlReport(summary)
  assert.ok(html.length > 100)
  assert.match(html, /<!DOCTYPE html>/)
})

test('renderMarkdownReport: 表格里特殊字符（管道/换行）被转义', () => {
  const summary = aggregateReport(makeRunResult([
    makeCase({ pass: false, assertions: [{ name: 'mustContain', pass: false, reason: 'a | b\nc' }] }),
  ]))
  const md = renderMarkdownReport(summary)
  // pipe 转义
  assert.match(md, /a \\\| b/)
  // 换行被替换为空格
  assert.doesNotMatch(md, /b\nc/)
})
