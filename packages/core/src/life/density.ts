/**
 * 「人生经历」事件密度函数（Phase 2 grower 使用）。
 *
 * 给定分身的当前年龄（岁），返回「每月触发新事件的概率」。grower 在
 * `samplePendingMonths` 里对每个待推进月份按此概率做 Bernoulli 抽样：
 *
 *   density(age=10) = 0.30    →  每 10 个月里期望出现 3 个事件
 *   density(age=40) = 0.15    →  中年段事件密度减半
 *   density(age=70) = 0.08    →  老年段进一步降低
 *
 * 默认分桶（年龄段 → 概率）：
 *   - 年轻段（[0, 25)）  : 0.30
 *   - 中年段（[25, 55)） : 0.15
 *   - 老年段（[55, +∞)） : 0.08
 *
 * 设计原则：
 *   1. 纯函数 + 无副作用，便于单测快照
 *   2. 通过 `weights` 参数完全可参数化（用户后续可在 LifePanel 里调）
 *   3. 边界处理：负年龄按 0 处理；超大年龄按老年段处理
 *
 * @author zhi.qu
 * @date 2026-05-09
 */

/**
 * 事件密度权重。
 * 三个分桶的边界 + 三档概率均可覆盖。
 */
export interface DensityWeights {
  /** 年轻段上界（不含），默认 25 */
  youngBoundary: number
  /** 中年段上界（不含），默认 55 */
  middleBoundary: number
  /** 年轻段每月概率（默认 0.30） */
  youngProbability: number
  /** 中年段每月概率（默认 0.15） */
  middleProbability: number
  /** 老年段每月概率（默认 0.08） */
  oldProbability: number
}

/**
 * plan 2.2 节默认密度参数。
 * 修改默认值需同步更新 plan 与 grower 的 reconsolidate 阈值文档。
 */
export const DEFAULT_DENSITY_WEIGHTS: DensityWeights = {
  youngBoundary: 25,
  middleBoundary: 55,
  youngProbability: 0.30,
  middleProbability: 0.15,
  oldProbability: 0.08,
}

/**
 * 给定年龄（岁）返回每月触发新事件的概率。
 *
 * @param ageYears 分身当前年龄（岁，可为浮点数；负数按 0 处理）
 * @param weights 自定义权重；缺省使用 DEFAULT_DENSITY_WEIGHTS
 * @returns 概率 ∈ [0, 1]
 *
 * @example
 *   eventDensityPerMonth(10)                          // → 0.30
 *   eventDensityPerMonth(40)                          // → 0.15
 *   eventDensityPerMonth(70)                          // → 0.08
 *   eventDensityPerMonth(-5)                          // → 0.30（按 0 岁处理）
 *   eventDensityPerMonth(40, { ...DEFAULT_DENSITY_WEIGHTS, middleProbability: 0.2 })
 *                                                       // → 0.20
 */
export function eventDensityPerMonth(
  ageYears: number,
  weights: DensityWeights = DEFAULT_DENSITY_WEIGHTS,
): number {
  // 边界归一：负年龄按 0 岁处理；NaN/Infinity 按老年段兜底
  if (!Number.isFinite(ageYears)) {
    return weights.oldProbability
  }
  const safeAge = Math.max(0, ageYears)

  if (safeAge < weights.youngBoundary) {
    return weights.youngProbability
  }
  if (safeAge < weights.middleBoundary) {
    return weights.middleProbability
  }
  return weights.oldProbability
}

/**
 * 月数转年龄（年）。grower 中频繁需要把 currentAgeMonths 转成年龄段，
 * 抽出来避免散落的 `Math.floor(months / 12)`。
 *
 * @param months >= 0 的整数月份
 */
export function monthsToYears(months: number): number {
  if (!Number.isFinite(months) || months < 0) return 0
  return Math.floor(months / 12)
}
