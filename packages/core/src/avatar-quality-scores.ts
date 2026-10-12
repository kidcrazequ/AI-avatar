/**
 * 分身质量三维评分：基于测试用例 category / id 归类，与桌面端 test-runner 输出对接。
 *
 * 维度与主计划阶段二「质量勋章」一致：
 * - 红线：红线合规类用例通过率
 * - 知识完整度：知识库约束类用例通过率
 * - 引用准确率：数据溯源类用例通过率
 *
 * @author zhi.qu
 * @date 2026-05-09
 */

/** 与 {@link mapTestCaseToQualityDimension} 对应的业务维度 */
export type AvatarQualityAxis = 'redline' | 'knowledge' | 'citation'

/** 单次测试 outcome（由渲染进程从 TestCase + TestResult 组装） */
export interface AvatarTestOutcomeForQuality {
  caseId: string
  category: string
  passed: boolean
  score: number
}

/** 某一维度上的聚合分数 */
export interface AvatarQualityDimensionAggregate {
  /** 该维度用例通过率 0–100（四舍五入） */
  passRatePercent: number
  passedCount: number
  totalCount: number
  /** 该维度平均分 0–100（一位小数，与单用例百分制对齐） */
  averageScore: number
}

/**
 * TEST CENTER / report.json 中与「质量勋章」对齐的结构化分数。
 *
 * 某维度无对应用例时为 `null`，UI 应展示「—」而非 0%。
 */
export interface AvatarQualityScores {
  redline: AvatarQualityDimensionAggregate | null
  knowledgeCompleteness: AvatarQualityDimensionAggregate | null
  citationAccuracy: AvatarQualityDimensionAggregate | null
  /** 未归入上述三维的已跑用例数（人格、记忆、自定义类别等） */
  otherRanCount: number
}

function normalizeSegment(s: string): string {
  return s.trim().toLowerCase()
}

/**
 * 将测试用例元数据映射到三维之一；无法映射时返回 `null`。
 *
 * 优先级：YAML `category` 关键词 → `caseId` 前缀（兼容历史文件）。
 */
export function mapTestCaseToQualityDimension(
  category: string,
  caseId: string
): AvatarQualityAxis | null {
  const c = category.trim()
  const id = normalizeSegment(caseId)

  if (
    c === '红线合规' ||
    c.includes('红线') ||
    id.startsWith('redline')
  ) {
    return 'redline'
  }

  if (
    c === '知识库约束' ||
    (c.includes('知识库') && c.includes('约束')) ||
    id.startsWith('knowledge')
  ) {
    return 'knowledge'
  }

  if (
    c === '数据溯源' ||
    (c.includes('数据') && c.includes('溯源')) ||
    c.includes('溯源') ||
    id.startsWith('traceability')
  ) {
    return 'citation'
  }

  return null
}

function aggregateDimension(
  outcomes: AvatarTestOutcomeForQuality[],
  axis: AvatarQualityAxis
): AvatarQualityDimensionAggregate | null {
  const bucket = outcomes.filter(
    (o) => mapTestCaseToQualityDimension(o.category, o.caseId) === axis
  )
  const totalCount = bucket.length
  if (totalCount === 0) return null

  const passedCount = bucket.filter((o) => o.passed).length
  const passRatePercent = Math.round((100 * passedCount) / totalCount)
  const sumScore = bucket.reduce((s, o) => s + o.score, 0)
  const averageScore = Math.round((10 * sumScore) / totalCount) / 10

  return { passRatePercent, passedCount, totalCount, averageScore }
}

/**
 * 从一轮测试的全部 outcome 计算三维分数。
 *
 * @param outcomes 必须与本轮执行顺序无关；每项需带 `category`（与 Markdown 前置一致）。
 */
export function computeAvatarQualityScores(outcomes: AvatarTestOutcomeForQuality[]): AvatarQualityScores {
  const otherRanCount = outcomes.filter(
    (o) => mapTestCaseToQualityDimension(o.category, o.caseId) === null
  ).length

  return {
    redline: aggregateDimension(outcomes, 'redline'),
    knowledgeCompleteness: aggregateDimension(outcomes, 'knowledge'),
    citationAccuracy: aggregateDimension(outcomes, 'citation'),
    otherRanCount,
  }
}
