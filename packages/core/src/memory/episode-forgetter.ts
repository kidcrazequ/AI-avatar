/**
 * 对话情景记忆遗忘机制（v17，Phase 2c+ of human-cognition extension）。
 *
 * 把 Life Experience 的 sigmoid 遗忘算法接到 ConversationEpisode 上：
 *   forget_prob = sigmoid(α·age_months - β·importance - γ·emotion - δ·recency_boost)
 *
 * 单位差异：
 *   - Life 用 age_gap_years（人生跨度 0-80 年级）
 *   - Episodes 用 age_months（对话跨度 0-48 月级）
 *   所以默认权重不同——episode α=0.10/月 vs life α=0.05/年，让两边在
 *   "几年级别"的衰减节奏接近。
 *
 * 与 Life 共享的部分：
 *   - sigmoid() 函数：从 life/forgetter 直接复用
 *   - probabilityToStatus() 阈值表：本地复刻同样的 0.7/0.4 切分
 *
 * 不和 Life 共享：
 *   - 权重默认值（单位不同）
 *   - applyXxxAlgorithmicForgetting 入口（不同类型）
 *
 * 设计为纯函数 + 确定性：相同输入 + 相同 now + 相同权重 → 输出相同结果，便于快照测试。
 *
 * @author zhi.qu
 * @date 2026-05-17
 */

import { sigmoid } from '../life/forgetter'
import type { ConversationEpisode } from './episode-types'

/** 对话情景记忆遗忘权重——字段名标月份单位，避免和 life 的年单位混淆 */
export interface EpisodeForgettingWeights {
  /** 月单位的年龄差权重：每老一个月，logit 加 alpha（默认 0.10） */
  alpha: number
  /** importance 权重：越重要越不易遗忘（默认 0.3） */
  beta: number
  /** emotion 权重：情感越强越不易遗忘（默认 0.2） */
  gamma: number
  /** 近期加成：近期窗口内全得 boost（默认 0.4） */
  delta: number
  /** 近期窗口（月），窗口内 recency boost=1，否则 0（默认 1 月） */
  recencyWindowMonths: number
  /** forgotten 阈值（默认 0.7） */
  forgottenThreshold: number
  /** blurred 阈值（默认 0.4） */
  blurredThreshold: number
}

/**
 * 默认权重，已校准到这些参考点（近似）：
 *   importance=2 emotion=2 unimportant：
 *     1 月    → remembered（prob ≈ 0.16）
 *     12 月   → blurred  （prob ≈ 0.60）
 *     24 月   → forgotten（prob ≈ 0.83）
 *   importance=8 emotion=6：
 *     12 月   → remembered（prob ≈ 0.08）
 *     36 月   → blurred  （prob ≈ 0.50）
 *     60 月   → forgotten（prob ≈ 0.86）
 *
 * 想加快遗忘可调大 alpha；想延长重要记忆寿命可调大 beta/gamma。
 */
export const DEFAULT_EPISODE_FORGETTING_WEIGHTS: EpisodeForgettingWeights = {
  alpha: 0.10,
  beta: 0.3,
  gamma: 0.2,
  delta: 0.4,
  recencyWindowMonths: 1,
  forgottenThreshold: 0.7,
  blurredThreshold: 0.4,
}

/** 30 天近似一月——固定，不随月份长短变化（衰减算法不必精确到 28/30/31） */
const MS_PER_MONTH = 30 * 86400 * 1000

/**
 * 单条 episode 的遗忘概率（0-1）。
 *
 * @param episode 输入条目（用 importance、|valence|、conversationLastMessageAt）
 * @param now 当前时间（毫秒，注入便于测试；默认 Date.now()）
 */
export function computeEpisodeForgetProbability(
  episode: ConversationEpisode,
  now: number = Date.now(),
  weights: EpisodeForgettingWeights = DEFAULT_EPISODE_FORGETTING_WEIGHTS,
): number {
  const ageMs = Math.max(0, now - episode.conversationLastMessageAt)
  const ageMonths = ageMs / MS_PER_MONTH
  const emotionMag = Math.abs(episode.valence) // |valence| 当作 emotion 强度
  const recencyBoost = ageMonths <= weights.recencyWindowMonths ? 1 : 0
  const x =
    weights.alpha * ageMonths
    - weights.beta * episode.importance
    - weights.gamma * emotionMag
    - weights.delta * recencyBoost
  return sigmoid(x)
}

/** 概率反推 status——与 life 同阈值表，独立复刻避免跨模块耦合 */
export function probabilityToEpisodeStatus(
  forgetProb: number,
  weights: EpisodeForgettingWeights = DEFAULT_EPISODE_FORGETTING_WEIGHTS,
): 'remembered' | 'blurred' | 'forgotten' {
  if (forgetProb > weights.forgottenThreshold) return 'forgotten'
  if (forgetProb > weights.blurredThreshold) return 'blurred'
  return 'remembered'
}

/**
 * 算法层主入口：批量重算 episodes 的 consolidationStatus + 计算变化条目。
 *
 * 返回新数组（纯函数，不修改入参）+ 哪些 id 实际状态变了——
 * caller 据此只写回变化条目，避免每天 N 次磁盘写。
 *
 * @returns { episodes, changedIds }
 */
export function applyEpisodeAlgorithmicForgetting(
  episodes: ConversationEpisode[],
  now: number = Date.now(),
  weights: EpisodeForgettingWeights = DEFAULT_EPISODE_FORGETTING_WEIGHTS,
): { episodes: ConversationEpisode[]; changedIds: string[] } {
  const changedIds: string[] = []
  const updated = episodes.map((ep) => {
    const prob = computeEpisodeForgetProbability(ep, now, weights)
    const newStatus = probabilityToEpisodeStatus(prob, weights)
    if (newStatus === ep.consolidationStatus) return ep
    changedIds.push(ep.conversationId)
    return {
      ...ep,
      consolidationStatus: newStatus,
    }
  })
  return { episodes: updated, changedIds }
}
