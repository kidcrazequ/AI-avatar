/**
 * cost-tracker.ts — 按分身 / 模型累计 token 用量与成本（LiteLLM 风格）
 *
 * 借鉴 LiteLLM 的 cost callback：每次 LLM 调用结束后给一个 NormalizedUsage，
 * 本模块按模型定价表换算 USD 成本，按 (avatarId, model) 维度累加。
 *
 * 设计要点：
 *   - 不依赖任何 provider 实现，纯 record(...) 接口；调用方（chatStore / eval Solver）显式上报
 *   - 单例 + reset()，便于在 batch eval 前清零再统计
 *   - 未知模型：成本记为 0，但 token 仍计入；同时 console.warn 一次（去抖以模型名为 key）
 *
 * 定价来源：
 *   - 仅录 Soul 当前可能用到的 Claude / DeepSeek / OpenAI 主流型号
 *   - 单位 USD per 1M tokens；与 LiteLLM model_prices.json 量纲一致
 *   - cache_read / cache_creation 走单独价位（Anthropic prompt cache 折扣 10x / +25%）
 *
 * @author zhi.qu
 * @date 2026-05-19
 */

import type { NormalizedUsage } from './types'

/** 单模型定价（USD per 1M tokens） */
export interface ModelPricing {
  inputPerMillion: number
  outputPerMillion: number
  cacheReadPerMillion?: number
  cacheCreationPerMillion?: number
}

/**
 * 内置定价表。覆盖 Soul 现支持的两种 provider 的主流 model。
 * 数据冻结于 2026-05；后续按需用 setPricing(model, ...) 在运行时覆盖。
 */
export const DEFAULT_PRICING: Record<string, ModelPricing> = {
  // Anthropic
  'claude-opus-4-7':        { inputPerMillion: 15.0, outputPerMillion: 75.0, cacheReadPerMillion: 1.5,  cacheCreationPerMillion: 18.75 },
  'claude-sonnet-4-6':      { inputPerMillion: 3.0,  outputPerMillion: 15.0, cacheReadPerMillion: 0.3,  cacheCreationPerMillion: 3.75 },
  'claude-haiku-4-5':       { inputPerMillion: 1.0,  outputPerMillion: 5.0,  cacheReadPerMillion: 0.1,  cacheCreationPerMillion: 1.25 },
  // DeepSeek（OpenAI-compat）
  'deepseek-chat':          { inputPerMillion: 0.27, outputPerMillion: 1.1,  cacheReadPerMillion: 0.07 },
  'deepseek-reasoner':      { inputPerMillion: 0.55, outputPerMillion: 2.19, cacheReadPerMillion: 0.14 },
}

export interface CostBreakdown {
  /** USD */
  inputCost: number
  outputCost: number
  cacheReadCost: number
  cacheCreationCost: number
  total: number
}

export interface AggregateRow {
  avatarId: string
  model: string
  callCount: number
  usage: NormalizedUsage
  cost: CostBreakdown
}

function emptyUsage(): NormalizedUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }
}

function emptyCost(): CostBreakdown {
  return { inputCost: 0, outputCost: 0, cacheReadCost: 0, cacheCreationCost: 0, total: 0 }
}

class CostTracker {
  private pricing = new Map<string, ModelPricing>(Object.entries(DEFAULT_PRICING))
  private rows = new Map<string, AggregateRow>()
  private warnedUnknown = new Set<string>()

  /** 覆盖 / 新增模型定价 */
  setPricing(model: string, p: ModelPricing): void {
    this.pricing.set(model, p)
  }

  /** 计算单次调用成本（不计入累计；用于"只看本次"场景） */
  computeCost(model: string, usage: NormalizedUsage): CostBreakdown {
    const p = this.pricing.get(model)
    if (!p) {
      if (!this.warnedUnknown.has(model)) {
        this.warnedUnknown.add(model)
        console.warn(`[cost-tracker] 未知模型 "${model}"：token 计入但 cost=0；用 setPricing(...) 添加定价`)
      }
      return emptyCost()
    }
    const inputCost = (usage.inputTokens / 1e6) * p.inputPerMillion
    const outputCost = (usage.outputTokens / 1e6) * p.outputPerMillion
    const cacheReadCost = ((usage.cacheReadTokens ?? 0) / 1e6) * (p.cacheReadPerMillion ?? 0)
    const cacheCreationCost = ((usage.cacheCreationTokens ?? 0) / 1e6) * (p.cacheCreationPerMillion ?? 0)
    return {
      inputCost,
      outputCost,
      cacheReadCost,
      cacheCreationCost,
      total: inputCost + outputCost + cacheReadCost + cacheCreationCost,
    }
  }

  /**
   * 记录一次 LLM 调用：累加到 (avatarId, model) 行。
   *
   * - usage 不存在则 noop（避免 mock solver 污染）
   * - 未知模型仍计 token，cost 用 0（一次 warn）
   */
  record(avatarId: string, model: string, usage: NormalizedUsage | undefined): void {
    if (!usage) return
    const key = `${avatarId}::${model}`
    const cur = this.rows.get(key) ?? {
      avatarId,
      model,
      callCount: 0,
      usage: emptyUsage(),
      cost: emptyCost(),
    }
    cur.callCount++
    cur.usage = {
      inputTokens: cur.usage.inputTokens + (usage.inputTokens || 0),
      outputTokens: cur.usage.outputTokens + (usage.outputTokens || 0),
      cacheReadTokens: (cur.usage.cacheReadTokens ?? 0) + (usage.cacheReadTokens ?? 0),
      cacheCreationTokens: (cur.usage.cacheCreationTokens ?? 0) + (usage.cacheCreationTokens ?? 0),
    }
    const delta = this.computeCost(model, usage)
    cur.cost = {
      inputCost: cur.cost.inputCost + delta.inputCost,
      outputCost: cur.cost.outputCost + delta.outputCost,
      cacheReadCost: cur.cost.cacheReadCost + delta.cacheReadCost,
      cacheCreationCost: cur.cost.cacheCreationCost + delta.cacheCreationCost,
      total: cur.cost.total + delta.total,
    }
    this.rows.set(key, cur)
  }

  /** 取某分身（不传则取全部）的明细行 */
  summary(avatarId?: string): AggregateRow[] {
    const all = [...this.rows.values()]
    return avatarId ? all.filter(r => r.avatarId === avatarId) : all
  }

  /** 一行总计 USD（avatarId 可选） */
  totalUsd(avatarId?: string): number {
    return this.summary(avatarId).reduce((a, r) => a + r.cost.total, 0)
  }

  /** 一行总 token（avatarId 可选） */
  totalTokens(avatarId?: string): number {
    return this.summary(avatarId).reduce(
      (a, r) => a + r.usage.inputTokens + r.usage.outputTokens
        + (r.usage.cacheReadTokens ?? 0) + (r.usage.cacheCreationTokens ?? 0),
      0,
    )
  }

  reset(): void {
    this.rows.clear()
  }
}

/** 全局单例（chatStore / eval Solver / 报告页面都引用同一份） */
export const costTracker = new CostTracker()

/**
 * BR-1：把用户设置里的"单轮成本上限"字符串解析为 USD 数值。
 *
 * 语义要点（决定 cap 会不会误触发，务必保持）：
 *   - 空 / 未配置 / 非数字(NaN) / ≤ 0 → 一律返回 0 = **关闭**上限。
 *     宁可不设限，也不能因解析歧义误停一次正常对话（未知/本地模型成本本就算 0）。
 *   - 有效正数 → 原样返回，作为单次 sendMessage 的累计成本硬上限。
 */
export function resolveTurnBudgetUsd(raw: string | null | undefined): number {
  const parsed = Number.parseFloat(raw ?? '')
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}
