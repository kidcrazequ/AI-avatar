/**
 * eval.test.ts — Task/Solver/Scorer + cost-tracker + dataset-from-flows 联合单测
 *
 * 运行：
 *   NODE_PATH=./test-support/node_modules npx tsx --test src/services/eval/eval.test.ts
 *
 * @author zhi.qu
 * @date 2026-05-19
 */

import { test } from 'node:test'
import assert from 'node:assert'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  runEval,
  staticSolver,
  defaultScorers,
  questionsToSamples,
  citationScorer,
  personaScorer,
  loadFlowsAsSamples,
  flowsToSamples,
  parseFlowJsonl,
  costTracker,
  type Sample,
  type Scorer,
  type SolverOutput,
} from './index'
import type { FullTarget } from './scorers'

// ─── Scorers ────────────────────────────────────────────────────────────

test('citationScorer: 命中来源锚点 pass', () => {
  const r = citationScorer.score(
    { id: 'a', input: '' },
    { text: '答案。[来源: knowledge/policy.md#L1-L10]', toolEvents: [], durationMs: 0 },
  )
  // citation scorer 是同步分支
  const score = r instanceof Promise ? null : r
  assert.ok(score && score.passed)
})

test('citationScorer: 缺锚点 fail，requireCitation=false 则 pass', () => {
  const noCite: SolverOutput = { text: '光秃秃的答案', toolEvents: [], durationMs: 0 }
  const r1 = citationScorer.score({ id: 'a', input: '' }, noCite) as { passed: boolean }
  assert.strictEqual(r1.passed, false)

  const r2 = citationScorer.score(
    { id: 'a', input: '', target: { requireCitation: false } },
    noCite,
  ) as { passed: boolean }
  assert.strictEqual(r2.passed, true)
})

test('personaScorer: 命中任一 marker', () => {
  const r = personaScorer.score(
    { id: 'a', input: '', target: { personaMarkers: ['小堵', '我作为分身'] } },
    { text: '你好，我是小堵。', toolEvents: [], durationMs: 0 },
  ) as { passed: boolean; metadata?: { matched?: string } }
  assert.strictEqual(r.passed, true)
  assert.strictEqual(r.metadata?.matched, '小堵')
})

test('personaScorer: 无 marker 视作无要求 → pass', () => {
  const r = personaScorer.score(
    { id: 'a', input: '' },
    { text: '', toolEvents: [], durationMs: 0 },
  ) as { passed: boolean }
  assert.strictEqual(r.passed, true)
})

// ─── runEval ────────────────────────────────────────────────────────────

test('runEval: staticSolver + defaultScorers 全 pass', async () => {
  const dataset: Sample<string, FullTarget>[] = [
    {
      id: 's1',
      input: '电池循环寿命？',
      target: {
        mustContain: ['循环'],
        mustNotContain: ['假新闻'],
        requireCitation: true,
      },
    },
  ]
  const answers = new Map([['s1', '电池循环寿命约 6000 次。[来源: knowledge/cell.md#L1-L5]']])
  const result = await runEval({
    name: 'static-smoke',
    dataset,
    solver: staticSolver(answers, { model: 'claude-sonnet-4-6' }),
    scorers: defaultScorers,
    config: { interSampleDelayMs: 0 },
  })
  assert.strictEqual(result.summary.total, 1)
  assert.strictEqual(result.summary.passed, 1)
  assert.strictEqual(result.summary.failed, 0)
  assert.strictEqual(result.summary.errored, 0)
  assert.strictEqual(result.samples[0].passed, true)
})

test('runEval: solver error 时所有 scorer 跳过，整条 errored', async () => {
  const dataset: Sample<string, FullTarget>[] = [
    { id: 'bad', input: 'x', target: { mustContain: ['anything'] } },
  ]
  // staticSolver 对未匹配 id 返回 error
  const result = await runEval({
    name: 'err',
    dataset,
    solver: staticSolver(new Map()),
    scorers: defaultScorers,
    config: { interSampleDelayMs: 0 },
  })
  assert.strictEqual(result.summary.errored, 1)
  assert.strictEqual(result.summary.passed, 0)
  assert.strictEqual(result.samples[0].error?.includes('no stub'), true)
  // 错误样本不跑任何 scorer
  assert.strictEqual(Object.keys(result.samples[0].scores).length, 0)
})

test('runEval: scorer 抛错只让该 scorer fail，不影响其他', async () => {
  const throwScorer: Scorer<unknown> = {
    name: 'throws',
    score() { throw new Error('boom') },
  }
  const okScorer: Scorer<unknown> = {
    name: 'ok',
    score() { return { value: 'pass', passed: true } },
  }
  const result = await runEval({
    name: 'mixed-scorer',
    dataset: [{ id: 's', input: 'q' }],
    solver: staticSolver({ s: 'a' }),
    scorers: [throwScorer, okScorer],
    config: { interSampleDelayMs: 0 },
  })
  assert.strictEqual(result.samples[0].scores.throws.passed, false)
  assert.ok(result.samples[0].scores.throws.explanation?.includes('boom'))
  assert.strictEqual(result.samples[0].scores.ok.passed, true)
  // 任一 scorer fail → 整样本 fail
  assert.strictEqual(result.samples[0].passed, false)
})

test('runEval: logDir 写出 JSONL（header + sample + summary）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'eval-log-'))
  const result = await runEval({
    name: 'log-test',
    dataset: [{ id: 's1', input: 'q', target: { mustContain: ['hi'] } }],
    solver: staticSolver({ s1: 'hi there' }),
    scorers: defaultScorers,
    config: { logDir: dir, interSampleDelayMs: 0 },
  })
  assert.ok(result.logPath)
  const content = await readFile(result.logPath!, 'utf8')
  const lines = content.trim().split('\n').map(l => JSON.parse(l))
  assert.strictEqual(lines.length, 3)
  assert.strictEqual(lines[0].kind, 'header')
  assert.strictEqual(lines[0].datasetSize, 1)
  assert.strictEqual(lines[1].kind, 'sample')
  assert.strictEqual(lines[2].kind, 'summary')
})

test('runEval: trackCostsAs 把 usage 累加到 costTracker', async () => {
  costTracker.reset()
  await runEval(
    {
      name: 'cost',
      dataset: [{ id: 's', input: 'q' }],
      solver: staticSolver(
        { s: 'a' },
        { model: 'claude-sonnet-4-6', usage: { inputTokens: 1000, outputTokens: 500 } },
      ),
      scorers: [],
      config: { interSampleDelayMs: 0 },
    },
    { trackCostsAs: 'xiaodu' },
  )
  const rows = costTracker.summary('xiaodu')
  assert.strictEqual(rows.length, 1)
  assert.strictEqual(rows[0].model, 'claude-sonnet-4-6')
  assert.strictEqual(rows[0].usage.inputTokens, 1000)
  // sonnet: 3.0 input / 15.0 output per 1M
  assert.ok(Math.abs(rows[0].cost.inputCost - (1000 / 1e6) * 3.0) < 1e-9)
  assert.ok(Math.abs(rows[0].cost.outputCost - (500 / 1e6) * 15.0) < 1e-9)
})

// ─── adapter ────────────────────────────────────────────────────────────

test('questionsToSamples: 老题库 → Sample 等价转换', () => {
  const samples = questionsToSamples([
    {
      id: 'q1',
      category: 'L1_excel_fact',
      prompt: '215 1 月效率',
      expectedTools: ['query_excel'],
      mustContain: ['91'],
    },
  ])
  assert.strictEqual(samples.length, 1)
  assert.strictEqual(samples[0].id, 'q1')
  assert.strictEqual(samples[0].input, '215 1 月效率')
  assert.deepStrictEqual(samples[0].target?.expectedTools, ['query_excel'])
  assert.deepStrictEqual(samples[0].target?.mustContain, ['91'])
  assert.strictEqual(samples[0].metadata?.category, 'L1_excel_fact')
})

// ─── dataset-from-flows ─────────────────────────────────────────────────

test('flowsToSamples: 抽取 user 文本作为 input，跳过 error 流', async () => {
  const flows = [
    {
      flowId: 'a', startedAt: 1, finishedAt: 2, durationMs: 1, conversationId: 'c1', stream: true,
      request: { body: { model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: '你好' }] } },
      response: { kind: 'sse' as const, sseOk: true },
    },
    {
      flowId: 'b', startedAt: 1, finishedAt: 2, durationMs: 1, conversationId: 'c2', stream: false,
      request: { body: { messages: [{ role: 'user', content: [{ type: 'text', text: '问题二' }] }] } },
      response: {
        kind: 'json' as const,
        json: { content: [{ type: 'text', text: '回答二' }] },
      },
    },
    {
      flowId: 'c', startedAt: 1, finishedAt: 2, durationMs: 1, conversationId: 'c3', stream: false,
      request: { body: { messages: [{ role: 'user', content: 'skip me' }] } },
      response: { kind: 'error' as const, error: 'boom' },
    },
  ]
  const samples = flowsToSamples(flows)
  assert.strictEqual(samples.length, 2)
  assert.strictEqual(samples[0].input, '你好')
  assert.strictEqual(samples[1].input, '问题二')
  assert.strictEqual(samples[1].metadata?.recordedAnswer, '回答二')
})

test('loadFlowsAsSamples: 从 JSONL 文件读', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'flow-'))
  const path = join(dir, 'flows.jsonl')
  const lines = [
    JSON.stringify({
      flowId: 'a', startedAt: 1, finishedAt: 2, durationMs: 1, conversationId: 'c1', stream: true,
      request: { body: { messages: [{ role: 'user', content: 'hello' }] } },
      response: { kind: 'sse', sseOk: true },
    }),
    '', // blank line tolerated
    'not-json-should-be-skipped',
  ].join('\n')
  await writeFile(path, lines, 'utf8')
  const samples = await loadFlowsAsSamples(path)
  assert.strictEqual(samples.length, 1)
  assert.strictEqual(samples[0].input, 'hello')
})

test('parseFlowJsonl: 容忍空行与坏行', () => {
  const flows = parseFlowJsonl('{"flowId":"a","startedAt":1,"finishedAt":2,"durationMs":1,"conversationId":"c","stream":false,"request":{"body":{}},"response":{"kind":"sse"}}\n\nbad\n')
  assert.strictEqual(flows.length, 1)
  assert.strictEqual(flows[0].flowId, 'a')
})
