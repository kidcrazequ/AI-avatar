export type ConsistencyMode = 'normal' | 'chart'

export interface ConsistencyPolicy {
  mode: ConsistencyMode
  temperature?: number
  seed?: number
  skipRag: boolean
  skipNudge: boolean
  hintToInject?: string
}

/** 图表请求关键词（领域无关，用于识别一致性模式场景） */
export const CHART_KEYWORDS = /(图表|可视化|趋势图|折线图|柱状图|柱图|饼图|KPI|对比图|分布图)/i
/** 时间范围关键词（领域无关，用于识别“时间序列趋势”类场景） */
export const TIME_RANGE_KEYWORDS = /(20\d{2}年|[1-9]|1[0-2])\s*(月|~|～|到|至|-|—)/i
/** 确定性模式默认温度，0 表示尽量贪心解码 */
export const DETERMINISTIC_TEMPERATURE = 0

export const CHART_CONSISTENCY_HINT = `[系统提示] 图表一致性模式：
1) 当用户要求时间范围图且数据点不足 3 个时，默认推荐降级（1 点→KPI，2 点→柱图）；若用户明确指定图型，可按指定图型输出。
2) 若按用户指定图型输出但数据点不足，必须明确提示“数据点不足，趋势解释受限”。
3) 不要自动拼接历史数据补齐趋势，除非用户明确要求。
4) 使用已有数据直接收敛输出，不要重复调用同参数工具。`

export function shouldEnableChartConsistencyMode(content: string, hasImages: boolean): boolean {
  if (hasImages) return false
  return CHART_KEYWORDS.test(content) && TIME_RANGE_KEYWORDS.test(content)
}

/**
 * 基于字符串内容生成稳定 seed（FNV-1a 32bit 简化版）。
 * 同样的 user content 会得到同样的 seed，保证“同问”时采样稳定。
 */
export function deriveSeedFromContent(content: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < content.length; i++) {
    hash ^= content.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return Math.abs(hash | 0) % 2_147_483_647 || 1
}

export interface ResolvePolicyOptions {
  content: string
  hasImages: boolean
  enableDeterministicMode?: boolean
  enableChartConsistencyMode?: boolean
  enableNudgeSkipOnChart?: boolean
}

export function resolvePolicy(options: ResolvePolicyOptions): ConsistencyPolicy {
  const {
    content,
    hasImages,
    enableDeterministicMode = true,
    enableChartConsistencyMode = true,
    enableNudgeSkipOnChart = true,
  } = options

  const chartMode = enableChartConsistencyMode && shouldEnableChartConsistencyMode(content, hasImages)
  const seed = enableDeterministicMode && content.trim().length > 0
    ? deriveSeedFromContent(content)
    : undefined

  if (chartMode) {
    return {
      mode: 'chart',
      temperature: DETERMINISTIC_TEMPERATURE,
      seed,
      skipRag: true,
      skipNudge: enableNudgeSkipOnChart,
      hintToInject: CHART_CONSISTENCY_HINT,
    }
  }

  return {
    mode: 'normal',
    temperature: enableDeterministicMode ? DETERMINISTIC_TEMPERATURE : undefined,
    seed,
    skipRag: false,
    skipNudge: false,
  }
}
