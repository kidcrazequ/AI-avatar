/**
 * 双重遗忘机制：
 *   - Stage 3a 算法层：sigmoid 公式按 (年龄差 - 重要性 - 情感 + 近期加成) 算遗忘概率，
 *                       结果落到每条 timeline 条目的 consolidationStatus 字段。
 *   - Stage 3b AI 复盘层：让 LLM 扮演分身回看 remembered 事件，输出
 *                          consolidated.md 第一人称叙述。
 *
 * 公式（plan 2.1 Stage 3a）：
 *   forget_prob = sigmoid(α·age_gap - β·importance - γ·emotion - δ·recency_boost)
 *   默认 α=0.05  β=0.3  γ=0.2  δ=0.4   recency = 最近 5 年加 boost
 *   阈值：forget_prob > 0.7 → forgotten
 *         forget_prob > 0.4 → blurred
 *         其余                → remembered
 *
 * 注意：算法层是「纯函数 + 确定性」，给定相同输入 + 同 currentAge + 同权重必然输出相同结果，
 * 便于测试快照对比。LLM 复盘层（generateConsolidated）接受外部注入 LLMCallFn，可被 mock。
 *
 * @author zhi.qu
 * @date 2026-05-09
 */

import type { LLMCallFn } from '../document-formatter'
import {
  buildConsolidatedPrompt,
  CONSOLIDATED_SYSTEM_PROMPT,
} from './prompts'
import type {
  LifeConsolidationStatus,
  LifeManifest,
  LifeTimelineEntry,
} from './types'

/** sigmoid 公式权重，默认值见 plan 2.1 节 */
export interface ForgettingWeights {
  /** 年龄差权重：年龄差越大遗忘概率越高（默认 0.05） */
  alpha: number
  /** 重要性权重：重要性越高越不容易遗忘（默认 0.3） */
  beta: number
  /** 情感强度权重：情感越强越不容易遗忘（默认 0.2） */
  gamma: number
  /** 近期加成权重：最近 N 年的事件额外加分（默认 0.4） */
  delta: number
  /** 近期窗口（年），默认 5 */
  recencyWindowYears: number
  /** forgotten 阈值（默认 0.7） */
  forgottenThreshold: number
  /** blurred 阈值（默认 0.4） */
  blurredThreshold: number
}

/** 默认权重，与 plan 一致 */
export const DEFAULT_FORGETTING_WEIGHTS: ForgettingWeights = {
  alpha: 0.05,
  beta: 0.3,
  gamma: 0.2,
  delta: 0.4,
  recencyWindowYears: 5,
  forgottenThreshold: 0.7,
  blurredThreshold: 0.4,
}

/**
 * sigmoid(x) = 1 / (1 + e^-x)
 * 单独抽出便于测试和调权。
 */
export function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x))
}

/**
 * 算法层：对单个事件计算遗忘概率（0-1）。
 *
 * @param entry 时间轴条目（用到 age / importance / emotion）
 * @param currentAge 分身当前年龄
 * @param weights 权重，缺省用 DEFAULT_FORGETTING_WEIGHTS
 */
export function computeForgetProbability(
  entry: LifeTimelineEntry,
  currentAge: number,
  weights: ForgettingWeights = DEFAULT_FORGETTING_WEIGHTS,
): number {
  const ageGap = Math.max(0, currentAge - entry.age)
  const recencyBoost = ageGap <= weights.recencyWindowYears ? 1 : 0
  const x =
    weights.alpha * ageGap
    - weights.beta * entry.importance
    - weights.gamma * entry.emotion
    - weights.delta * recencyBoost
  return sigmoid(x)
}

/**
 * 由概率反推 consolidation status。
 */
export function probabilityToStatus(
  forgetProb: number,
  weights: ForgettingWeights = DEFAULT_FORGETTING_WEIGHTS,
): LifeConsolidationStatus {
  if (forgetProb > weights.forgottenThreshold) return 'forgotten'
  if (forgetProb > weights.blurredThreshold) return 'blurred'
  return 'remembered'
}

/**
 * 算法层主入口：批量为 timeline 标注 consolidationStatus。
 *
 * 纯函数：不修改入参，返回新数组。原有 consolidationNote 字段
 * 保留（generator 后续 Stage 3b 之后会写入 AI 复盘理由）。
 *
 * @param timeline 待筛选的时间轴
 * @param currentAge 分身当前年龄（按月计算时建议传 floor(currentAgeMonths / 12)）
 * @param weights 可覆盖默认权重
 */
export function applyAlgorithmicForgetting(
  timeline: LifeTimelineEntry[],
  currentAge: number,
  weights: ForgettingWeights = DEFAULT_FORGETTING_WEIGHTS,
): LifeTimelineEntry[] {
  return timeline.map((entry) => {
    const forgetProb = computeForgetProbability(entry, currentAge, weights)
    const status = probabilityToStatus(forgetProb, weights)
    return {
      ...entry,
      consolidationStatus: status,
    }
  })
}

// ─── Stage 3b：AI 复盘 ──────────────────────────────────────────────────────

/** generateConsolidated 入参 */
export interface GenerateConsolidatedOptions {
  manifest: LifeManifest
  /** 已经过算法层筛选的完整 timeline（含 consolidationStatus） */
  timeline: LifeTimelineEntry[]
  /** LLM 调用函数（注入，便于 mock） */
  callLLM: LLMCallFn
  /** 字数目标，默认 4000；硬上限 8000（与 plan 8 节验收标准一致） */
  wordTarget?: number
  /** 单次 LLM 输出 token 上限（默认 8000，约够 8000 字中文） */
  maxTokens?: number
}

/** consolidated.md 字数硬上限（plan 7 节风险条目） */
export const CONSOLIDATED_MAX_CHARS = 8000

/**
 * Stage 3b：调用 LLM 生成第一人称「我记得的人生」。
 *
 * 注意：本函数只生成正文 string，不写盘——调用方（generator）负责调
 * `writeLifeConsolidated`。这样 Phase 2 grower 的 reconsolidate 也能复用。
 *
 * @returns Markdown 正文（含主标题，可直接写入 consolidated.md）
 */
export async function generateConsolidated(
  opts: GenerateConsolidatedOptions,
): Promise<string> {
  const wordTarget = opts.wordTarget ?? 4000
  const maxTokens = opts.maxTokens ?? 8000

  const remembered = opts.timeline.filter(e => e.consolidationStatus === 'remembered')
  const blurred = opts.timeline.filter(e => e.consolidationStatus === 'blurred')

  const userPrompt = buildConsolidatedPrompt({
    manifest: opts.manifest,
    rememberedEntries: remembered,
    blurredEntries: blurred,
    wordTarget,
  })

  const raw = await opts.callLLM(CONSOLIDATED_SYSTEM_PROMPT, userPrompt, maxTokens)
  const cleaned = stripCodeFence(raw).trim()

  // 防御：LLM 偶尔会忽略约束输出超长内容，截断到上限避免撑爆 system prompt。
  // 截断在最近的换行处，避免句子断在半截。
  if (cleaned.length <= CONSOLIDATED_MAX_CHARS) {
    return ensureMainHeading(cleaned, opts.manifest)
  }
  const truncated = cleaned.slice(0, CONSOLIDATED_MAX_CHARS)
  const lastBreak = truncated.lastIndexOf('\n')
  const safe = lastBreak > CONSOLIDATED_MAX_CHARS * 0.8
    ? truncated.slice(0, lastBreak)
    : truncated
  return ensureMainHeading(safe, opts.manifest)
}

/**
 * 如果 LLM 没有给主标题，自动补一个。让 consolidated.md 在 LifePanel 直接渲染时
 * 有清晰的入口。
 */
function ensureMainHeading(content: string, manifest: LifeManifest): string {
  const trimmed = content.trim()
  if (trimmed.startsWith('#')) return trimmed
  const currentAge = Math.floor(manifest.currentAgeMonths / 12)
  return `# 我还记得的人生（${currentAge} 岁回望）\n\n${trimmed}`
}

/**
 * 去掉 LLM 输出里偶发的 markdown 代码块包装：
 *   \`\`\`\n... \n\`\`\`   →  ...
 *   \`\`\`markdown\n... \n\`\`\`   →  ...
 */
function stripCodeFence(text: string): string {
  const fence = /^```[a-zA-Z]*\n([\s\S]*?)\n```$/m
  const m = text.trim().match(fence)
  if (m) return m[1]
  return text
}
