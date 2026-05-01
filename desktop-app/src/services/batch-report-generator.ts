/**
 * batch-report-generator.ts — 批量回归评估报告生成器
 *
 * 三层职责：
 *   1. 纯规则聚合（aggregateReport）：把 BatchRunResult 拍扁成 ReportSummary（按类别/工具/断言失败/性能/红线）
 *   2. LLM 根因分析（requestRootCauseAnalysis）：可选；把失败 case 抽样发给 LLM 出根因 + 优化建议
 *   3. 渲染（renderMarkdownReport / renderHtmlReport）：纯字符串输出，落盘交给 IPC 层
 *
 * 设计原则：
 *   - 三层解耦：规则层无 LLM 依赖，可纯单测；LLM 注入函数指针；渲染层无 IO
 *   - HTML 自包含：CDN 加载 marked + mermaid，离线打开仍能看主体（仅 mermaid 不渲染）
 *   - MD 与 HTML 结构对齐：方便复制粘贴到任意 markdown 阅读器
 *   - 失败案例采样：LLM 调用前每类别最多 N 例，避免 prompt 爆炸
 *
 * 不依赖 Electron / DOM，可纯 Node 跑单测。
 *
 * @author zhi.qu
 * @date 2026-04-30
 */

import type {
  BatchRunResult,
  CaseResult,
  QuestionCategory,
} from './batch-regression-runner'

// ─── 聚合数据类型 ──────────────────────────────────────────────────────

/** 单类别汇总 */
export interface CategoryStat {
  category: QuestionCategory
  total: number
  pass: number
  fail: number
  passRate: number
  errorCount: number
}

/** 工具使用统计 */
export interface ToolUsageStat {
  name: string
  /** 调用总次数（跨所有题） */
  totalCalls: number
  /** 至少调用过此工具的题数 */
  affectedCases: number
  /** 失败次数（ok=false） */
  failedCalls: number
}

/** 断言失败分桶 */
export interface AssertionFailureBucket {
  /** 断言名（expectedTools / expectedSkills / expectedValue / mustContain / mustNotContain） */
  name: string
  count: number
  /** 在失败 case 中的占比（0-1） */
  shareInFailures: number
  /** 抽样 3 个失败原因 */
  sampleReasons: string[]
}

/** 性能统计 */
export interface PerformanceStat {
  /** 平均单题耗时 ms */
  avgDurationMs: number
  /** 中位耗时 ms */
  medianDurationMs: number
  /** 最慢前 5 题（durationMs 倒序） */
  slowestCases: Array<{ questionId: string; category: QuestionCategory; durationMs: number; prompt: string }>
}

/** 红线（L9）专项 */
export interface RedlineStat {
  total: number
  pass: number
  fail: number
  /** 失败的 prompt + reason */
  violations: Array<{ questionId: string; prompt: string; reason: string }>
}

/** 完整报告聚合 */
export interface ReportSummary {
  runId: string
  avatarId: string
  startedAt: number
  finishedAt: number
  durationMs: number
  totalCases: number
  passCount: number
  failCount: number
  errorCount: number
  overallPassRate: number
  /** 触发 todo_write 的 case 比例 */
  todoUsageRate: number
  /** 按类别 */
  categoryStats: CategoryStat[]
  /** 按工具 */
  toolStats: ToolUsageStat[]
  /** 失败断言分桶 */
  assertionFailures: AssertionFailureBucket[]
  /** 性能 */
  performance: PerformanceStat
  /** 红线 */
  redline: RedlineStat
}

// ─── 聚合实现 ──────────────────────────────────────────────────────────

function median(nums: number[]): number {
  if (nums.length === 0) return 0
  const sorted = [...nums].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid]
}

/**
 * 把 BatchRunResult 聚合成 ReportSummary。
 * 纯函数无副作用，cases 为空时返回零值结构（避免 NaN）。
 */
export function aggregateReport(result: BatchRunResult): ReportSummary {
  const total = result.totalCases
  const safeRate = (n: number, d: number): number => (d === 0 ? 0 : n / d)

  // 类别统计：直接用 runner 已聚合的 categorySummary（再补 errorCount/passRate）
  const categoryStats: CategoryStat[] = Object.entries(result.categorySummary).map(([cat, s]) => {
    const errorCount = result.cases.filter(c => c.category === (cat as QuestionCategory) && c.error).length
    return {
      category: cat as QuestionCategory,
      total: s.total,
      pass: s.pass,
      fail: s.fail,
      passRate: safeRate(s.pass, s.total),
      errorCount,
    }
  }).sort((a, b) => a.passRate - b.passRate)

  // 工具统计
  const toolMap = new Map<string, { totalCalls: number; affected: Set<string>; failedCalls: number }>()
  for (const c of result.cases) {
    const seen = new Set<string>()
    for (const name of c.toolCallSequence) {
      const cur = toolMap.get(name) ?? { totalCalls: 0, affected: new Set<string>(), failedCalls: 0 }
      cur.totalCalls++
      seen.add(name)
      toolMap.set(name, cur)
    }
    for (const name of seen) {
      const cur = toolMap.get(name)!
      cur.affected.add(c.questionId)
    }
  }
  const toolStats: ToolUsageStat[] = [...toolMap.entries()]
    .map(([name, s]) => ({
      name,
      totalCalls: s.totalCalls,
      affectedCases: s.affected.size,
      failedCalls: s.failedCalls, // 注：当前 telemetry 未拆分单工具失败次数；保留字段供未来扩展
    }))
    .sort((a, b) => b.totalCalls - a.totalCalls)

  // 失败断言分桶
  const failedCases = result.cases.filter(c => !c.pass)
  const bucketMap = new Map<string, { count: number; reasons: string[] }>()
  for (const c of failedCases) {
    if (c.error) {
      const b = bucketMap.get('runtime-error') ?? { count: 0, reasons: [] }
      b.count++
      if (b.reasons.length < 3) b.reasons.push(c.error.slice(0, 200))
      bucketMap.set('runtime-error', b)
      continue
    }
    for (const a of c.assertions) {
      if (a.pass) continue
      const b = bucketMap.get(a.name) ?? { count: 0, reasons: [] }
      b.count++
      if (b.reasons.length < 3 && a.reason) b.reasons.push(a.reason)
      bucketMap.set(a.name, b)
    }
  }
  const failedTotal = failedCases.length || 1 // 防 0
  const assertionFailures: AssertionFailureBucket[] = [...bucketMap.entries()]
    .map(([name, b]) => ({
      name,
      count: b.count,
      shareInFailures: b.count / failedTotal,
      sampleReasons: b.reasons,
    }))
    .sort((a, b) => b.count - a.count)

  // 性能
  const durations = result.cases.map(c => c.durationMs)
  const slowestCases = [...result.cases]
    .sort((a, b) => b.durationMs - a.durationMs)
    .slice(0, 5)
    .map(c => ({ questionId: c.questionId, category: c.category, durationMs: c.durationMs, prompt: c.prompt.slice(0, 120) }))
  const performance: PerformanceStat = {
    avgDurationMs: durations.length === 0 ? 0 : Math.round(durations.reduce((s, n) => s + n, 0) / durations.length),
    medianDurationMs: Math.round(median(durations)),
    slowestCases,
  }

  // 红线
  const redCases = result.cases.filter(c => c.category === 'L9_redline')
  const redline: RedlineStat = {
    total: redCases.length,
    pass: redCases.filter(c => c.pass).length,
    fail: redCases.filter(c => !c.pass).length,
    violations: redCases.filter(c => !c.pass).map(c => ({
      questionId: c.questionId,
      prompt: c.prompt,
      reason: c.error ?? c.assertions.find(a => !a.pass)?.reason ?? '未知',
    })),
  }

  const todoUsageRate = safeRate(result.cases.filter(c => c.hasTodoWrite).length, total)

  return {
    runId: result.runId,
    avatarId: result.avatarId,
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    durationMs: result.finishedAt - result.startedAt,
    totalCases: total,
    passCount: result.passCount,
    failCount: result.failCount,
    errorCount: result.errorCount,
    overallPassRate: safeRate(result.passCount, total),
    todoUsageRate,
    categoryStats,
    toolStats,
    assertionFailures,
    performance,
    redline,
  }
}

// ─── LLM 根因分析 ──────────────────────────────────────────────────────

/** 单条根因 */
export interface RootCause {
  /** 根因短标题 */
  title: string
  /** 详细描述（200-500 字） */
  description: string
  /** 涉及类别 */
  affectedCategories: QuestionCategory[]
  /** 涉及 case 数 */
  affectedCases: number
  /** 优先级 P0/P1/P2 */
  priority: 'P0' | 'P1' | 'P2'
  /** 优化建议（具体可操作） */
  recommendation: string
}

/** AI 分析结果 */
export interface RootCauseAnalysis {
  /** AI 概览 */
  overview: string
  /** 根因列表（按优先级排序） */
  causes: RootCause[]
  /** AI 分析时使用的失败 case 数（采样后） */
  sampledCases: number
  /** AI 调用是否成功；失败时填错误 + causes 为空 */
  ok: boolean
  error?: string
}

/** LLM 调用接口（与 LLMService 解耦） */
export type CallLLMFn = (prompt: string, signal?: AbortSignal) => Promise<string>

/** 每类别采样上限（避免 prompt 过大） */
const SAMPLE_PER_CATEGORY = 3
/** 总采样上限 */
const SAMPLE_TOTAL_CAP = 30

/** 把失败 case 按类别采样 */
function sampleFailedCases(cases: CaseResult[]): CaseResult[] {
  const byCategory = new Map<QuestionCategory, CaseResult[]>()
  for (const c of cases) {
    if (c.pass) continue
    const arr = byCategory.get(c.category) ?? []
    arr.push(c)
    byCategory.set(c.category, arr)
  }
  const sampled: CaseResult[] = []
  for (const [, arr] of byCategory) {
    sampled.push(...arr.slice(0, SAMPLE_PER_CATEGORY))
  }
  // 总上限再裁
  return sampled.slice(0, SAMPLE_TOTAL_CAP)
}

/** 把 case 简化成 LLM prompt 友好的 JSON 行 */
function caseToLLMSnippet(c: CaseResult): Record<string, unknown> {
  const failedAssertions = c.assertions.filter(a => !a.pass).map(a => ({ name: a.name, reason: a.reason }))
  return {
    id: c.questionId,
    category: c.category,
    prompt: c.prompt.slice(0, 300),
    answer: c.answer.slice(0, 600),
    toolsUsed: c.toolCallSequence,
    error: c.error,
    failedAssertions,
  }
}

/** 构造发给 LLM 的根因分析 prompt */
function buildAnalysisPrompt(summary: ReportSummary, sampled: CaseResult[]): string {
  const summaryJson = JSON.stringify({
    overallPassRate: Number(summary.overallPassRate.toFixed(3)),
    totalCases: summary.totalCases,
    failCount: summary.failCount,
    errorCount: summary.errorCount,
    categoryStats: summary.categoryStats.map(c => ({
      category: c.category,
      passRate: Number(c.passRate.toFixed(3)),
      total: c.total,
      fail: c.fail,
    })),
    assertionFailures: summary.assertionFailures.map(b => ({
      name: b.name,
      count: b.count,
      sampleReasons: b.sampleReasons,
    })),
    redlineFailRate: summary.redline.total === 0 ? 0 : Number((summary.redline.fail / summary.redline.total).toFixed(3)),
  }, null, 2)

  const samplesJson = JSON.stringify(sampled.map(caseToLLMSnippet), null, 2)

  return [
    '你是一名 AI 分身回归测试评估专家。下面是一次批量回归的统计结果与失败 case 抽样。',
    '请基于这些数据，输出**结构化的根因分析与优化建议**。',
    '',
    '# 统计概览',
    '```json',
    summaryJson,
    '```',
    '',
    '# 失败 case 抽样（每类别最多 3 例）',
    '```json',
    samplesJson,
    '```',
    '',
    '# 输出要求',
    '请严格按以下 JSON Schema 输出（不要 markdown 包裹，不要解释）：',
    '```json',
    '{',
    '  "overview": "整体评估的 1-2 句话总结",',
    '  "causes": [',
    '    {',
    '      "title": "短标题",',
    '      "description": "200-500 字详细描述根本原因",',
    '      "affectedCategories": ["L1_excel_fact", ...],',
    '      "affectedCases": 数字,',
    '      "priority": "P0" | "P1" | "P2",',
    '      "recommendation": "具体可执行的优化建议"',
    '    }',
    '  ]',
    '}',
    '```',
    '',
    '原则：',
    '- 至少给出 3 个根因（如果失败少于 3 个，给 1-2 个亦可）',
    '- 按 priority 倒序：P0 = 影响红线/数据准确性；P1 = 影响多类别通过率；P2 = 性能/体验',
    '- recommendation 必须具体到分身的某个文件或某项配置（如"补充 knowledge/xxx.md 章节"、"调整 soul.md 第 X 节话术"）',
    '- 不要泛泛而谈，每条根因必须有 case 抽样支撑',
  ].join('\n')
}

/** 容错解析 LLM 输出（剥 markdown 包裹、修复尾逗号等常见噪音） */
function parseAnalysisResponse(raw: string): { overview: string; causes: RootCause[] } {
  let text = raw.trim()
  // 剥 ```json ... ``` / ``` ... ```
  const fence = text.match(/^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/m)
  if (fence) text = fence[1].trim()
  // 找第一个 { 与最后一个 }
  const first = text.indexOf('{')
  const last = text.lastIndexOf('}')
  if (first !== -1 && last !== -1) text = text.slice(first, last + 1)

  const parsed = JSON.parse(text) as Record<string, unknown>
  const overview = typeof parsed.overview === 'string' ? parsed.overview : ''
  const rawCauses = Array.isArray(parsed.causes) ? parsed.causes : []
  const causes: RootCause[] = rawCauses
    .map((c): RootCause | null => {
      if (!c || typeof c !== 'object') return null
      const obj = c as Record<string, unknown>
      const priority = obj.priority === 'P0' || obj.priority === 'P1' || obj.priority === 'P2' ? obj.priority : 'P2'
      return {
        title: typeof obj.title === 'string' ? obj.title : '(未提供标题)',
        description: typeof obj.description === 'string' ? obj.description : '',
        affectedCategories: Array.isArray(obj.affectedCategories)
          ? obj.affectedCategories.filter((x): x is QuestionCategory => typeof x === 'string')
          : [],
        affectedCases: typeof obj.affectedCases === 'number' ? obj.affectedCases : 0,
        priority,
        recommendation: typeof obj.recommendation === 'string' ? obj.recommendation : '',
      }
    })
    .filter((c): c is RootCause => c !== null)
    .sort((a, b) => {
      const order = { P0: 0, P1: 1, P2: 2 }
      return order[a.priority] - order[b.priority]
    })
  return { overview, causes }
}

/**
 * 调用 LLM 出根因分析。任何错误（网络/JSON 解析）被捕获并返回 ok=false。
 * 调用方根据 ok 决定是否在报告中显示分析章节。
 */
export async function requestRootCauseAnalysis(
  summary: ReportSummary,
  cases: CaseResult[],
  callLLM: CallLLMFn,
  signal?: AbortSignal,
): Promise<RootCauseAnalysis> {
  const sampled = sampleFailedCases(cases)
  if (sampled.length === 0) {
    return {
      overview: '本次回归无失败 case，分身在题库样本上表现完美。',
      causes: [],
      sampledCases: 0,
      ok: true,
    }
  }
  const prompt = buildAnalysisPrompt(summary, sampled)
  try {
    const raw = await callLLM(prompt, signal)
    const { overview, causes } = parseAnalysisResponse(raw)
    return { overview, causes, sampledCases: sampled.length, ok: true }
  } catch (err) {
    return {
      overview: '',
      causes: [],
      sampledCases: sampled.length,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

// ─── 渲染：Markdown ───────────────────────────────────────────────────

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`
}

function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`
  const min = Math.floor(ms / 60_000)
  const sec = Math.round((ms % 60_000) / 1000)
  return `${min}m ${sec}s`
}

function fmtDate(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number): string => n.toString().padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function escapeMd(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\n/g, ' ')
}

/**
 * 渲染 Markdown 报告（含可选 AI 分析章节）。
 * 输出可直接保存为 .md 或粘贴到任意 markdown 阅读器。
 */
export function renderMarkdownReport(summary: ReportSummary, analysis?: RootCauseAnalysis | null): string {
  const lines: string[] = []
  lines.push(`# 批量回归评估报告`)
  lines.push('')
  lines.push(`- **分身**: ${summary.avatarId}`)
  lines.push(`- **运行 ID**: \`${summary.runId}\``)
  lines.push(`- **开始时间**: ${fmtDate(summary.startedAt)}`)
  lines.push(`- **结束时间**: ${fmtDate(summary.finishedAt)}`)
  lines.push(`- **总耗时**: ${fmtMs(summary.durationMs)}`)
  lines.push('')

  // 摘要
  lines.push(`## 1. 总体摘要`)
  lines.push('')
  lines.push(`| 指标 | 值 |`)
  lines.push(`|---|---|`)
  lines.push(`| 总题数 | ${summary.totalCases} |`)
  lines.push(`| 通过 | ${summary.passCount} (${pct(summary.overallPassRate)}) |`)
  lines.push(`| 失败 | ${summary.failCount} |`)
  lines.push(`| 异常 | ${summary.errorCount} |`)
  lines.push(`| Todo 使用率 | ${pct(summary.todoUsageRate)} |`)
  lines.push(`| 平均单题耗时 | ${fmtMs(summary.performance.avgDurationMs)} |`)
  lines.push(`| 中位单题耗时 | ${fmtMs(summary.performance.medianDurationMs)} |`)
  lines.push('')

  // 类别
  lines.push(`## 2. 按类别通过率（升序）`)
  lines.push('')
  lines.push(`| 类别 | 通过率 | 通过 / 总数 | 异常 |`)
  lines.push(`|---|---|---|---|`)
  for (const c of summary.categoryStats) {
    lines.push(`| ${c.category} | ${pct(c.passRate)} | ${c.pass} / ${c.total} | ${c.errorCount} |`)
  }
  lines.push('')

  // 工具
  lines.push(`## 3. 工具使用统计`)
  lines.push('')
  if (summary.toolStats.length === 0) {
    lines.push(`> 无工具调用记录。`)
  } else {
    lines.push(`| 工具名 | 总调用次数 | 影响题数 |`)
    lines.push(`|---|---|---|`)
    for (const t of summary.toolStats) {
      lines.push(`| \`${t.name}\` | ${t.totalCalls} | ${t.affectedCases} |`)
    }
  }
  lines.push('')

  // 断言失败
  lines.push(`## 4. 失败断言分布（按数量降序）`)
  lines.push('')
  if (summary.assertionFailures.length === 0) {
    lines.push(`> 没有任何失败断言。`)
  } else {
    lines.push(`| 断言名 | 失败次数 | 在失败 case 中占比 | 抽样原因 |`)
    lines.push(`|---|---|---|---|`)
    for (const b of summary.assertionFailures) {
      const reasons = b.sampleReasons.map(r => escapeMd(r.slice(0, 80))).join(' / ') || '-'
      lines.push(`| ${b.name} | ${b.count} | ${pct(b.shareInFailures)} | ${reasons} |`)
    }
  }
  lines.push('')

  // 红线
  lines.push(`## 5. 红线（L9）专项`)
  lines.push('')
  if (summary.redline.total === 0) {
    lines.push(`> 题库无红线类题目。`)
  } else {
    lines.push(`- 总数: ${summary.redline.total}`)
    lines.push(`- 通过: ${summary.redline.pass}`)
    lines.push(`- 违规: ${summary.redline.fail}`)
    if (summary.redline.violations.length > 0) {
      lines.push('')
      lines.push(`### 违规明细`)
      for (const v of summary.redline.violations.slice(0, 10)) {
        lines.push(`- **${v.questionId}** — ${escapeMd(v.prompt.slice(0, 100))}`)
        lines.push(`  - 原因: ${escapeMd(v.reason.slice(0, 200))}`)
      }
      if (summary.redline.violations.length > 10) {
        lines.push(`- … 还有 ${summary.redline.violations.length - 10} 条`)
      }
    }
  }
  lines.push('')

  // 性能
  lines.push(`## 6. 性能（最慢前 5 题）`)
  lines.push('')
  if (summary.performance.slowestCases.length === 0) {
    lines.push(`> 无 case 数据。`)
  } else {
    lines.push(`| 题目 ID | 类别 | 耗时 | Prompt 预览 |`)
    lines.push(`|---|---|---|---|`)
    for (const s of summary.performance.slowestCases) {
      lines.push(`| ${s.questionId} | ${s.category} | ${fmtMs(s.durationMs)} | ${escapeMd(s.prompt)} |`)
    }
  }
  lines.push('')

  // AI 分析
  if (analysis) {
    lines.push(`## 7. AI 根因分析`)
    lines.push('')
    if (!analysis.ok) {
      lines.push(`> AI 分析失败：${analysis.error ?? '未知错误'}`)
    } else if (analysis.causes.length === 0 && summary.failCount === 0) {
      lines.push(`> ${analysis.overview}`)
    } else {
      lines.push(`> ${analysis.overview}`)
      lines.push('')
      lines.push(`抽样失败 case 数: ${analysis.sampledCases}`)
      lines.push('')
      for (const c of analysis.causes) {
        lines.push(`### [${c.priority}] ${c.title}`)
        lines.push('')
        lines.push(c.description)
        lines.push('')
        lines.push(`- **影响类别**: ${c.affectedCategories.join(', ') || '(未指定)'}`)
        lines.push(`- **影响 case 数**: ${c.affectedCases}`)
        lines.push(`- **优化建议**: ${c.recommendation}`)
        lines.push('')
      }
    }
  }

  return lines.join('\n')
}

// ─── 渲染：HTML ───────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * 渲染自包含 HTML：把 markdown 文本嵌进去，浏览器端用 marked + mermaid 渲染。
 * - 离线场景下 marked/mermaid 加载失败，会有降级文本提示
 * - 单文件可双击在任意浏览器打开
 */
export function renderHtmlReport(summary: ReportSummary, analysis?: RootCauseAnalysis | null): string {
  const md = renderMarkdownReport(summary, analysis)
  const escapedMd = escapeHtml(md)
  const title = `回归报告 — ${summary.avatarId} — ${fmtDate(summary.startedAt)}`
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>${escapeHtml(title)}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; max-width: 960px; margin: 24px auto; padding: 0 16px; line-height: 1.6; color: #24292f; background: #fff; }
  h1, h2, h3 { border-bottom: 1px solid #d0d7de; padding-bottom: 6px; margin-top: 28px; }
  h1 { font-size: 28px; }
  h2 { font-size: 22px; }
  h3 { font-size: 18px; border-bottom: none; }
  table { border-collapse: collapse; width: 100%; margin: 12px 0; }
  th, td { border: 1px solid #d0d7de; padding: 6px 10px; text-align: left; vertical-align: top; }
  th { background: #f6f8fa; }
  code { background: #eaeef2; padding: 2px 6px; border-radius: 4px; font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 90%; }
  pre code { display: block; padding: 12px; overflow-x: auto; }
  blockquote { border-left: 4px solid #d0d7de; padding-left: 12px; color: #57606a; margin: 12px 0; }
  .meta { color: #57606a; font-size: 13px; margin-bottom: 16px; }
  #fallback { display: block; }
  #rendered { display: none; }
  #rendered.ready { display: block; }
  #rendered.ready ~ #fallback { display: none; }
</style>
</head>
<body>
<div id="rendered"></div>
<noscript><pre id="fallback">${escapedMd}</pre></noscript>
<pre id="fallback">${escapedMd}</pre>
<script id="md-source" type="text/plain">${escapedMd}</script>
<script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
<script>
  (function() {
    var src = document.getElementById('md-source');
    if (!src) return;
    var raw = src.textContent || '';
    if (typeof marked === 'undefined') return;
    try {
      var html = marked.parse(raw);
      var rendered = document.getElementById('rendered');
      rendered.innerHTML = html;
      rendered.classList.add('ready');
    } catch (err) {
      console.error('[report] marked render failed:', err);
    }
  })();
</script>
</body>
</html>`
}
