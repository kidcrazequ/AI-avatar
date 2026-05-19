/**
 * eval/scorers.ts — 内置 Scorer 集合
 *
 * 全部复用 batch-regression-runner.ts 的断言函数（不重写规则），
 * 只把 (target, output) → Score 的包壳换成 Inspect-AI 风格。
 *
 * 设计：
 *   - 一个 scorer 只关心一类约束。组合多个 scorer 是上层 Task 的事
 *   - target schema 由 scorer 自己声明的 narrow 类型决定，未提供则视作"无约束 → pass"
 *
 * @author zhi.qu
 * @date 2026-05-19
 */

import {
  assertExpectedTools,
  assertExpectedSkills,
  assertExpectedValue,
  assertMustContain,
  assertMustNotContain,
  type ExpectedToolItem,
  type ExpectedValue,
} from '../batch-regression-runner'
import type { Scorer, Score } from './types'

function fromAssertion(pass: boolean, reason?: string): Score {
  return {
    value: pass ? 'pass' : 'fail',
    passed: pass,
    explanation: pass ? undefined : reason,
  }
}

/** target.expectedTools 命中校验（AND/OR 语义见 batch-regression-runner） */
export interface ExpectedToolsTarget { expectedTools?: ExpectedToolItem[] }
export const expectedToolsScorer: Scorer<ExpectedToolsTarget> = {
  name: 'expectedTools',
  score(sample, output) {
    const r = assertExpectedTools(output.toolEvents, sample.target?.expectedTools)
    return fromAssertion(r.pass, r.reason)
  },
}

/** target.expectedSkills 任一命中（OR 语义） */
export interface ExpectedSkillsTarget { expectedSkills?: string[] }
export const expectedSkillsScorer: Scorer<ExpectedSkillsTarget> = {
  name: 'expectedSkills',
  score(sample, output) {
    const r = assertExpectedSkills(output.toolEvents, sample.target?.expectedSkills)
    return fromAssertion(r.pass, r.reason)
  },
}

/** target.expectedValue 数值容差匹配 */
export interface ExpectedValueTarget { expectedValue?: ExpectedValue }
export const expectedValueScorer: Scorer<ExpectedValueTarget> = {
  name: 'expectedValue',
  score(sample, output) {
    const r = assertExpectedValue(output.text, sample.target?.expectedValue)
    return fromAssertion(r.pass, r.reason)
  },
}

/** target.mustContain 全部包含 */
export interface MustContainTarget { mustContain?: string[] }
export const mustContainScorer: Scorer<MustContainTarget> = {
  name: 'mustContain',
  score(sample, output) {
    const r = assertMustContain(output.text, sample.target?.mustContain)
    return fromAssertion(r.pass, r.reason)
  },
}

/** target.mustNotContain 一律不含（红线扫描） */
export interface MustNotContainTarget { mustNotContain?: string[] }
export const mustNotContainScorer: Scorer<MustNotContainTarget> = {
  name: 'mustNotContain',
  score(sample, output) {
    const r = assertMustNotContain(output.text, sample.target?.mustNotContain)
    return fromAssertion(r.pass, r.reason)
  },
}

/**
 * 数据溯源 scorer：答案里必须出现至少一个 [来源: ...] 锚点。
 *
 * - 默认正则匹配 `[来源:` / `[source:`（中英文）
 * - 允许 target.requireCitation = false 显式关闭（如人格寒暄题）
 *
 * 不解析锚点是否真实存在（那是 source-anchor-resolver 的事），只做"是否标了来源"的基线检查。
 */
export interface CitationTarget { requireCitation?: boolean }
const CITATION_RE = /\[(?:来源|source)\s*[:：]/i
export const citationScorer: Scorer<CitationTarget> = {
  name: 'citation',
  score(sample, output) {
    const required = sample.target?.requireCitation !== false
    if (!required) return { value: 'pass', passed: true }
    const hit = CITATION_RE.test(output.text)
    return fromAssertion(hit, hit ? undefined : '答案缺少来源锚点 [来源: ...]')
  },
}

/**
 * 人格 scorer：答案应包含人格签名 / 自称 / 关键风格短语之一。
 *
 * target.personaMarkers 是字符串数组；任一出现即通过（OR）。
 * 提供为空数组或不提供 → 视作"无人格要求"，pass。
 */
export interface PersonaTarget { personaMarkers?: string[] }
export const personaScorer: Scorer<PersonaTarget> = {
  name: 'persona',
  score(sample, output) {
    const markers = sample.target?.personaMarkers ?? []
    if (markers.length === 0) return { value: 'pass', passed: true }
    const hit = markers.find(m => output.text.includes(m))
    if (hit) return { value: 'pass', passed: true, metadata: { matched: hit } }
    return {
      value: 'fail',
      passed: false,
      explanation: `未命中任一人格标记 [${markers.map(m => JSON.stringify(m)).join(', ')}]`,
    }
  },
}

/** 把多个 target 子接口求交后用于 Task<TInput, FullTarget> */
export type FullTarget =
  & ExpectedToolsTarget
  & ExpectedSkillsTarget
  & ExpectedValueTarget
  & MustContainTarget
  & MustNotContainTarget
  & CitationTarget
  & PersonaTarget

/** 默认全套（5 类断言 + 溯源 + 人格） */
export const defaultScorers: Scorer<FullTarget>[] = [
  expectedToolsScorer,
  expectedSkillsScorer,
  expectedValueScorer,
  mustContainScorer,
  mustNotContainScorer,
  citationScorer,
  personaScorer,
]
