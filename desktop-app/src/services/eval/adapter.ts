/**
 * eval/adapter.ts — 老题库 → Eval Sample 的桥接
 *
 * 不强迫调用方迁移：现有 GeneratedQuestion[] 可以直接 questionsToSamples(...) 喂入 runEval。
 * 反向 evalResultToBatchRunResult 暂未提供，因为 batch-regression-runner 输出更窄（无 cost / 无 multi-scorer），
 * 报告生成层应该直接消费 EvalResult。
 *
 * @author zhi.qu
 * @date 2026-05-19
 */

import type { GeneratedQuestion } from '../batch-regression-runner'
import type { Sample } from './types'
import type { FullTarget } from './scorers'

/** 让 batch-regression-runner 的 GeneratedQuestion 走 Eval 抽象 */
export function questionsToSamples(questions: GeneratedQuestion[]): Sample<string, FullTarget>[] {
  return questions.map(q => ({
    id: q.id,
    input: q.prompt,
    target: {
      expectedTools: q.expectedTools,
      expectedSkills: q.expectedSkills,
      expectedValue: q.expectedValue,
      mustContain: q.mustContain,
      mustNotContain: q.mustNotContain,
      // 默认不要求人格 marker、不强制溯源（保持与老断言完全等价）
      personaMarkers: [],
      requireCitation: false,
    },
    metadata: {
      category: q.category,
      sourceFile: q.sourceFile,
      sourceSection: q.sourceSection,
      setupPrompts: q.setupPrompts,
    },
  }))
}
