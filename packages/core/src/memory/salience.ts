/**
 * Salience 评分引擎（v17 Phase 2c of human-cognition extension）。
 *
 * 给"分身的记忆条目"打一个综合分数：重要性 + 情感强度 + 时间近因 + 整理状态。
 * 设计为纯函数，可同时服务两种记忆系统：
 *   - 对话情景记忆（ConversationEpisode）：用 wall-clock 半衰期算 recency
 *   - 想象人生事件（LifeTimelineEntry）：用 age_gap 算 recency
 *
 * 两边的"重要性 0-10、情感强度 0-10、状态 remembered/blurred/forgotten"语义对齐，
 * 所以 computeSalience 接受归一化后的 SalienceInput；recency 由调用方各自计算。
 *
 * 算法形态：
 *   salience = (importance * iw + emotionMag * ew) * recencyFactor * statusFactor
 *   forgotten → 0
 *   blurred → 乘以 blurredPenalty（< 1）
 *
 * @author zhi.qu
 * @date 2026-05-17
 */

/** 与 life 模块的 LifeConsolidationStatus 对齐，避免类型依赖 */
export type SalienceStatus = 'remembered' | 'blurred' | 'forgotten'

/** computeSalience 的纯输入——recency 由调用方根据系统类型预先计算 */
export interface SalienceInput {
  /** 0-10：被打分项的重要性 */
  importance: number
  /** 0-10：情感强度（episode 用 |valence|；life 用 emotion 字段） */
  emotionMagnitude: number
  /**
   * 0-1：近因因子。1=完全新鲜，0=已过若干半衰期。
   * 调用方根据系统类型预计算：
   *   - 对话用 computeWallClockRecencyFactor(lastTs, halfLifeDays)
   *   - 人生事件用 computeAgeGapRecencyFactor(ageGap, ...)
   */
  recencyFactor: number
  /** 整理状态 */
  status: SalienceStatus
  /**
   * v18 Letta-style：被 agent pin 住的条目。
   * pinned=true 时：
   *   - 跳过 forgotten 早返回（pinned forgotten 仍参与排序）
   *   - recency 强制为 1.0（不衰减时间因子）
   *   - status 衰减 / blurredPenalty 被绕过
   *   - 最终分加上 PINNED_BONUS（确保排在所有非 pinned 之前）
   * pinned 之间仍按 importance + emotion 排序。
   */
  pinned?: boolean
}

/**
 * pin 加成分：让 pinned 项稳定排在非 pinned 项之前。
 * 非 pinned 最大值约 = importance(10) * 1.0 + emotion(10) * 0.3 = 13；
 * 设 50 确保任何非 pinned 都比最低 pinned 低。
 */
export const PINNED_SALIENCE_BONUS = 50

/** 评分权重，可全局微调 */
export interface SalienceWeights {
  /** importance 项权重，默认 1.0 */
  importanceWeight: number
  /** emotionMagnitude 项权重，默认 0.3 */
  emotionWeight: number
  /** blurred 状态的衰减乘数，默认 0.6 */
  blurredPenalty: number
}

export const DEFAULT_SALIENCE_WEIGHTS: SalienceWeights = {
  importanceWeight: 1.0,
  emotionWeight: 0.3,
  blurredPenalty: 0.6,
}

/**
 * 计算 salience 分数。
 *
 * 边界行为：
 *   - forgotten → 直接返回 0（这一档不该进 prompt，应被 caller 过滤）
 *   - 任一数值字段越界（NaN/负数等）→ 视为 0，不抛
 */
export function computeSalience(
  input: SalienceInput,
  weights: SalienceWeights = DEFAULT_SALIENCE_WEIGHTS,
): number {
  // pinned 跳过 forgotten 早返回（保护性进 prompt）；非 pinned forgotten 直接归零
  if (input.status === 'forgotten' && !input.pinned) return 0
  const importance = sanitize(input.importance)
  const emotion = sanitize(input.emotionMagnitude)
  // pinned 不衰减时间因子和状态因子
  const recency = input.pinned ? 1 : sanitizeUnit(input.recencyFactor)
  const statusFactor = input.pinned
    ? 1
    : (input.status === 'blurred' ? weights.blurredPenalty : 1)
  const base = (importance * weights.importanceWeight + emotion * weights.emotionWeight) * recency * statusFactor
  return input.pinned ? base + PINNED_SALIENCE_BONUS : base
}

function sanitize(x: number): number {
  if (!Number.isFinite(x) || x < 0) return 0
  return x
}

function sanitizeUnit(x: number): number {
  if (!Number.isFinite(x) || x < 0) return 0
  if (x > 1) return 1
  return x
}

// ─── 调用方专用 recency 计算器 ────────────────────────────────────────────────

/**
 * Wall-clock 半衰期 recency（对话情景记忆专用）。
 *
 * @param lastTsMs 该条目最近一次相关时间（如 conversationLastMessageAt），毫秒
 * @param halfLifeDays 半衰期天数（默认 30：一个月后 0.5，三个月后 0.125）
 * @param now 当前时间（毫秒，注入便于单测）
 * @returns 0-1，越新越接近 1
 */
export function computeWallClockRecencyFactor(
  lastTsMs: number,
  halfLifeDays = 30,
  now = Date.now(),
): number {
  if (!Number.isFinite(lastTsMs) || lastTsMs <= 0) return 0
  const ageMs = Math.max(0, now - lastTsMs)
  const halfLifeMs = halfLifeDays * 86400 * 1000
  if (halfLifeMs <= 0) return 0
  return Math.pow(0.5, ageMs / halfLifeMs)
}

/**
 * 年龄差 recency（人生事件专用）。
 *
 * @param ageGap currentAge - eventAge，单位年
 * @param recencyWindowYears 满分窗口（默认 5）：窗口内 = 1.0
 * @param decayPerYear 每年衰减率（默认 0.05）：窗口外按 (1 - decay * extraYears) 线性衰减，最低 0.1
 */
export function computeAgeGapRecencyFactor(
  ageGap: number,
  recencyWindowYears = 5,
  decayPerYear = 0.05,
): number {
  if (!Number.isFinite(ageGap) || ageGap < 0) return 1
  if (ageGap <= recencyWindowYears) return 1
  const extra = ageGap - recencyWindowYears
  return Math.max(0.1, 1 - decayPerYear * extra)
}
