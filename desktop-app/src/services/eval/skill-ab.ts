/**
 * eval/skill-ab.ts — B5 技能 TDD：无技能 / 有技能对照评测
 *
 * 同组压力样本分别在「baseline（system prompt 不含技能）/ with-skill（含技能全文）」
 * 两个 Task 下跑，**程序化 scorer**（零 LLM judge）按样本声明的违规特征断言
 * （特征来自 templates/test-case-template.md 的 baseline 段语义——编造的准则
 * 条号模式、笼统"来源：知识库"、占位骨架话术等）：
 *   - baseline 预期能红（RED：亲眼看到无技能时的违规）
 *   - with-skill 预期绿（GREEN：技能教的确实是对症的东西）
 * "If you didn't watch an agent fail without the skill, you don't know if
 *  the skill teaches the right thing."（superpowers writing-skills）
 *
 * solver 按合成后的 system prompt 注入：测试传 stub（零模型调用，可进 CI），
 * 生产可传真实 chat solver。本模块只管两侧 Task 的构建与对照跑。
 *
 * @author zhi.qu
 * @date 2026-07-06
 */

import { runEval } from './task'
import type { EvalResult, Sample, Scorer, Solver, Task } from './types'

/** 单条压力样本输入：用户侧压力场景 prompt（与 tests/cases 的 PROMPT 对应） */
export interface SkillAbInput {
  prompt: string
}

/**
 * 断言目标：均为 JS 正则源字符串（new RegExp(p) 无 flags）。
 * 违规特征直接从 baseline 段记录的**实际违规话术**提取，不凭想象写。
 */
export interface SkillAbTarget {
  /** 违规特征——输出命中任一模式即 fail（如 `企业会计准则第\d+号`、`来源：知识库`） */
  violationPatterns?: string[]
  /** 期望行为特征——缺任一模式即 fail（如 `#sheet=` 级来源锚点）；可省 */
  expectedPatterns?: string[]
}

function matchedPatterns(text: string, patterns: string[] | undefined): string[] {
  return (patterns ?? []).filter((p) => new RegExp(p).test(text))
}

/** 违规特征断言：命中任一违规模式即 fail——baseline 预期在这里红 */
export const violationPatternScorer: Scorer<SkillAbTarget> = {
  name: 'violation-patterns',
  score(sample, output) {
    const hits = matchedPatterns(output.text, sample.target?.violationPatterns)
    if (hits.length === 0) return { value: 'pass', passed: true }
    return {
      value: 'fail',
      passed: false,
      explanation: `命中违规特征：${hits.join('、')}`,
      metadata: { hits },
    }
  },
}

/** 期望行为断言：声明的期望模式缺一即 fail——with-skill 侧的正向验收 */
export const expectedBehaviorScorer: Scorer<SkillAbTarget> = {
  name: 'expected-behaviors',
  score(sample, output) {
    const expected = sample.target?.expectedPatterns ?? []
    const missing = expected.filter((p) => !new RegExp(p).test(output.text))
    if (missing.length === 0) return { value: 'pass', passed: true }
    return {
      value: 'fail',
      passed: false,
      explanation: `期望行为缺失：${missing.join('、')}`,
      metadata: { missing },
    }
  },
}

export interface SkillAbOptions {
  /** 技能全文——with-skill 侧原样注入 system prompt（不做摘要，防"教了但没教全"假绿） */
  skillContent: string
  /** 同组压力样本，两侧共用（同数据集才构成对照） */
  samples: Sample<SkillAbInput, SkillAbTarget>[]
  /** 两侧共用的基础 system prompt（分身 soul / 通用约束）；默认空 */
  baseSystemPrompt?: string
  /** 按合成后的 system prompt 生成 solver——测试注入 stub，生产接真实 chat solver */
  makeSolver: (systemPrompt: string) => Solver<SkillAbInput>
}

/** with-skill 侧 system prompt 合成：基础约束 + 技能全文（独立导出便于测试核查注入事实） */
export function composeWithSkillPrompt(baseSystemPrompt: string, skillContent: string): string {
  const skillBlock = `## 技能（对照注入）\n\n${skillContent}`
  return baseSystemPrompt ? `${baseSystemPrompt}\n\n${skillBlock}` : skillBlock
}

/** 构建同数据集、同 scorer 的 baseline / with-skill 两个 Task */
export function buildSkillAbTasks(
  opts: SkillAbOptions,
): { baseline: Task<SkillAbInput, SkillAbTarget>; withSkill: Task<SkillAbInput, SkillAbTarget> } {
  const { skillContent, samples, baseSystemPrompt = '', makeSolver } = opts
  // 空技能 → 两侧 system prompt 相同，"对照"全绿只是假象——B5 要防的正是这种自欺
  if (!skillContent.trim()) {
    throw new Error('buildSkillAbTasks: skillContent 为空，两侧无差异不构成对照')
  }
  const scorers = [violationPatternScorer, expectedBehaviorScorer]
  const config = { interSampleDelayMs: 0 }
  return {
    baseline: {
      name: 'skill-ab-baseline',
      dataset: samples,
      solver: makeSolver(baseSystemPrompt),
      scorers,
      config,
    },
    withSkill: {
      name: 'skill-ab-with-skill',
      dataset: samples,
      solver: makeSolver(composeWithSkillPrompt(baseSystemPrompt, skillContent)),
      scorers,
      config,
    },
  }
}

/**
 * 一次跑完 baseline / with-skill 两组，返回可对照的 EvalResult 对。
 * 判定口径由调用方（测试 / 上层）掌握：baseline 应有红、with-skill 应全绿。
 */
export async function runSkillAbEval(
  opts: SkillAbOptions,
): Promise<{ baseline: EvalResult; withSkill: EvalResult }> {
  const tasks = buildSkillAbTasks(opts)
  return { baseline: await runEval(tasks.baseline), withSkill: await runEval(tasks.withSkill) }
}
