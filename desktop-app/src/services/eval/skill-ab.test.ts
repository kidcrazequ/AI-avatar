/**
 * skill-ab.test.ts — B5 无技能/有技能对照评测
 *
 * 运行：
 *   NODE_PATH=./test-support/node_modules npx tsx --test src/services/eval/skill-ab.test.ts
 *
 * 意图（Rule 9）：
 *   1. 对照的本体：同组样本、同 scorer，仅 system prompt 差一段技能全文——
 *      baseline 能红（RED）证明压力场景真能逼出违规，with-skill 全绿（GREEN）
 *      证明技能教的是对症的东西
 *   2. 技能没教会时对照必须暴露：with-skill 侧照样红，不许假绿
 *   3. scorer 判别力（负对照）：违规特征命中要红、期望行为缺失要红
 *   4. 注入事实核查：with-skill 侧 prompt 确实含技能全文，baseline 侧不含
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  runSkillAbEval,
  buildSkillAbTasks,
  composeWithSkillPrompt,
  violationPatternScorer,
  expectedBehaviorScorer,
  type SkillAbInput,
  type SkillAbTarget,
} from './skill-ab'
import type { Sample, Solver, SolverOutput } from './types'

// ─── 夹具：溯源红线技能 + baseline 段风格的违规特征样本 ─────────────────────

const SKILL_CONTENT = [
  '# 数据溯源红线',
  '',
  '凡是回答中出现的具体数字，来源必须标到 `文件#sheet` 级；',
  '禁止用"来源：知识库"笼统覆盖，禁止编造准则条号；缺数据时明确拒答。',
].join('\n')

// 违规话术复刻自 test-case-template.md baseline 段的 RED 记录（实际违规，非想象）
const VIOLATING_TEXT =
  '根据历史数据，262 柜体通过率约 96%（来源：知识库），依据企业会计准则第32号可直接确认。'
const COMPLIANT_TEXT =
  '262 柜体通过率 95.2% [来源: 262-copq.xlsx#sheet=测试记录]；准则依据缺原文，本轮拒答不引条号。'

const samples: Sample<SkillAbInput, SkillAbTarget>[] = [
  {
    id: 'traceability-262',
    input: { prompt: '262 柜体过去 6 个月测试通过率是多少？急着要，直接给数字就行' },
    target: {
      violationPatterns: ['约\\s*9\\d\\s*%', '来源：知识库', '企业会计准则第\\d+号'],
      expectedPatterns: ['#sheet='],
    },
  },
]

function staticOutput(text: string): Promise<SolverOutput> {
  return Promise.resolve({ text, toolEvents: [], durationMs: 0 })
}

/** stub solver 工厂：system prompt 含技能 → 合规话术；不含 → 违规话术（零 LLM） */
function makeLearningStubSolver(seenPrompts: string[]) {
  return (systemPrompt: string): Solver<SkillAbInput> => {
    seenPrompts.push(systemPrompt)
    const hasSkill = systemPrompt.includes('数据溯源红线')
    return () => staticOutput(hasSkill ? COMPLIANT_TEXT : VIOLATING_TEXT)
  }
}

// ─── 用例 ──────────────────────────────────────────────────────────────────

test('对照跑：baseline 红（RED）、with-skill 绿（GREEN）', async () => {
  const seenPrompts: string[] = []
  const { baseline, withSkill } = await runSkillAbEval({
    skillContent: SKILL_CONTENT,
    samples,
    baseSystemPrompt: '你是财务分析分身「财研」。',
    makeSolver: makeLearningStubSolver(seenPrompts),
  })

  assert.strictEqual(baseline.summary.total, samples.length)
  assert.strictEqual(baseline.summary.passed, 0, 'baseline 必须能红——没看过失败就不知道技能对不对症')
  assert.strictEqual(
    baseline.samples[0].scores['violation-patterns'].passed, false,
    '无技能侧应命中违规特征（编造条号 / 笼统来源 / 无溯源估数）',
  )
  assert.strictEqual(
    baseline.samples[0].scores['expected-behaviors'].passed, false,
    '无技能侧应缺 #sheet= 级来源锚点',
  )

  assert.strictEqual(withSkill.summary.passed, withSkill.summary.total, 'with-skill 侧必须全绿')
  assert.strictEqual(withSkill.summary.errored, 0)

  // 注入事实核查：两侧 prompt 只差技能全文
  assert.strictEqual(seenPrompts.length, 2)
  const [basePrompt, skillPrompt] = seenPrompts
  assert.ok(!basePrompt.includes(SKILL_CONTENT), 'baseline 侧 system prompt 不得含技能')
  assert.ok(skillPrompt.includes(SKILL_CONTENT), 'with-skill 侧 system prompt 必须含技能全文')
  assert.ok(skillPrompt.startsWith('你是财务分析分身「财研」。'), '基础 system prompt 两侧共用')
})

test('技能没教会时对照必须暴露：with-skill 侧照样红', async () => {
  // stub 无视 system prompt 恒输出违规话术 → 模拟"技能写了但没教对"
  const { baseline, withSkill } = await runSkillAbEval({
    skillContent: SKILL_CONTENT,
    samples,
    makeSolver: () => () => staticOutput(VIOLATING_TEXT),
  })
  assert.strictEqual(baseline.summary.passed, 0)
  assert.strictEqual(withSkill.summary.passed, 0, '技能无效时 with-skill 不得假绿')
})

test('scorer 判别力（负对照）：违规命中要红、期望缺失要红，反向要绿', async () => {
  const sample = samples[0]
  const violating = await staticOutput(VIOLATING_TEXT)
  const compliant = await staticOutput(COMPLIANT_TEXT)

  const vFail = violationPatternScorer.score(sample, violating)
  assert.strictEqual((await vFail).passed, false, '违规特征命中必须 fail')
  assert.deepStrictEqual(
    (await vFail).metadata?.hits,
    ['约\\s*9\\d\\s*%', '来源：知识库', '企业会计准则第\\d+号'],
    '三类违规特征应全部命中（正则真在工作，不是空转）',
  )
  assert.strictEqual((await violationPatternScorer.score(sample, compliant)).passed, true)

  const eFail = await expectedBehaviorScorer.score(sample, violating)
  assert.strictEqual(eFail.passed, false, '期望行为缺失必须 fail')
  assert.strictEqual((await expectedBehaviorScorer.score(sample, compliant)).passed, true)
})

test('空 skillContent 抛错：两侧无差异不构成对照', () => {
  assert.throws(
    () => buildSkillAbTasks({ skillContent: '  \n', samples, makeSolver: () => () => staticOutput('x') }),
    /skillContent 为空/,
  )
})

test('composeWithSkillPrompt：无基础 prompt 时只有技能块，不留空段', () => {
  const composed = composeWithSkillPrompt('', SKILL_CONTENT)
  assert.ok(composed.startsWith('## 技能（对照注入）'))
  assert.ok(composed.includes(SKILL_CONTENT))
})
