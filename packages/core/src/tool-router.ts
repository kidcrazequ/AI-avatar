import path from 'path'
import fs from 'fs'
import { KnowledgeRetriever } from './knowledge-retriever'
import { loadIndex } from './knowledge-indexer'
import { SubAgentManager } from './sub-agent-manager'
import { assertSafeSegment } from './utils/path-security'

/**
 * 工具调用路由器（GAP4）
 * 处理 LLM 发起的工具调用，执行对应的本地函数并返回结果。
 */

export interface ToolCallRequest {
  name: string
  arguments: Record<string, unknown>
}

export interface ToolCallResult {
  content: string
  error?: string
}

// ─── query_excel 限流常量 ─────────────────────────────────────────────────────
// 防止单次工具调用 dump 几百行 × 几十列 × 几十字符 = 几十 KB 数据进 chat history
// 累积起来撞破 LLM context 上限。

/** 单次 query_excel 默认返回行数 */
const QUERY_EXCEL_DEFAULT_LIMIT = 50
/** 单次 query_excel 硬上限行数（即使 LLM 显式传 1000 也会被截断） */
const QUERY_EXCEL_HARD_LIMIT = 200
/**
 * 单次 query_excel 返回 content 的字符数硬上限（约 2k token）。
 * 即使在 limit 范围内，如果列数太多导致 JSON 太大也会被按行二次截断。
 */
const QUERY_EXCEL_MAX_CONTENT_CHARS = 8000

export class ToolRouter {
  private avatarsPath: string
  private retrievers = new Map<string, KnowledgeRetriever>()
  /** Feature 7: 子代理管理器 */
  readonly subAgentManager = new SubAgentManager()
  /** 主代理 system prompt（用于子代理共享上下文） */
  private systemPromptCache = new Map<string, string>()

  constructor(avatarsPath: string) {
    this.avatarsPath = avatarsPath
  }

  /**
   * 获取或创建分身的 KnowledgeRetriever，自动加载持久化索引（contexts + embeddings）。
   */
  getRetriever(avatarId: string): KnowledgeRetriever {
    assertSafeSegment(avatarId, '分身ID')
    if (!this.retrievers.has(avatarId)) {
      const knowledgePath = path.join(this.avatarsPath, avatarId, 'knowledge')
      const retriever = new KnowledgeRetriever(knowledgePath)
      const index = loadIndex(knowledgePath)
      if (index) {
        retriever.setContexts(index.contexts)
        retriever.setEmbeddings(index.embeddings)
      }
      this.retrievers.set(avatarId, retriever)
    }
    return this.retrievers.get(avatarId)!
  }

  /**
   * 使新索引生效：清除缓存的 retriever，下次访问时自动重新加载。
   */
  invalidateRetriever(avatarId: string): void {
    this.retrievers.delete(avatarId)
  }

  /**
   * 设置主代理 system prompt 缓存，供子代理委派时共享。
   */
  setSystemPrompt(avatarId: string, systemPrompt: string): void {
    this.systemPromptCache.set(avatarId, systemPrompt)
  }

  /** 执行工具调用 */
  async execute(avatarId: string, request: ToolCallRequest, callLLM?: (sys: string, user: string, maxTokens?: number) => Promise<string>): Promise<ToolCallResult> {
    assertSafeSegment(avatarId, '分身ID')
    const { name, arguments: args } = request

    try {
      switch (name) {
        case 'read_knowledge_file':
          return this.readKnowledgeFile(avatarId, args)
        case 'search_knowledge':
          return this.searchKnowledge(avatarId, args)
        case 'list_knowledge_files':
          return this.listKnowledgeFiles(avatarId)
        case 'query_excel':
          return this.queryExcel(avatarId, args)
        case 'calculate_roi':
          return this.calculateRoi(args)
        case 'lookup_policy':
          return this.lookupPolicy(avatarId, args)
        case 'compare_products':
          return this.compareProducts(avatarId, args)
        case 'load_skill':
          return this.loadSkill(avatarId, args)
        case 'delegate_task':
          return await this.delegateTask(avatarId, args, callLLM)
        default:
          return { content: '', error: `未知工具: ${name}` }
      }
    } catch (error) {
      return { content: '', error: error instanceof Error ? error.message : String(error) }
    }
  }

  // ─── 知识库工具 ──────────────────────────────────────────────────────────────

  private readKnowledgeFile(avatarId: string, args: Record<string, unknown>): ToolCallResult {
    const filePath = args.file_path as string
    if (!filePath) return { content: '', error: '缺少 file_path 参数' }
    const content = this.getRetriever(avatarId).readFile(filePath)
    return { content }
  }

  private searchKnowledge(avatarId: string, args: Record<string, unknown>): ToolCallResult {
    const query = args.query as string
    if (!query) return { content: '', error: '缺少 query 参数' }
    const topN = (args.top_n as number) ?? 5
    const results = this.getRetriever(avatarId).searchChunks(query, topN)
    if (results.length === 0) {
      return { content: '未找到相关知识内容。' }
    }
    const content = results.map(r =>
      `### [${r.file}] ${r.heading}\n${r.content}`
    ).join('\n\n---\n\n')
    return { content }
  }

  private listKnowledgeFiles(avatarId: string): ToolCallResult {
    const files = this.getRetriever(avatarId).listFiles()
    return { content: files.join('\n') }
  }

  // ─── Excel 结构化查询（v0.5.x 新增）─────────────────────────────────────────

  /**
   * query_excel: 按 MongoDB 风格 filter 精确过滤 Excel 行，返回 JSON。
   *
   * 严格保护：返回值不能太大，否则会污染 chat history 引发 context overflow。
   *   - 返回内容硬上限 QUERY_EXCEL_MAX_CONTENT_CHARS 字符
   *   - 默认 limit 50，硬上限 QUERY_EXCEL_HARD_LIMIT
   *   - 不传 filter 且不传 columns 时，要求加 limit 否则报错（防止 dump 全表）
   *   - 超出 content 上限时按行数截断，附 truncated_by_size 标志和提示
   *
   * 参数：
   *   file    — _excel/ 目录下的 basename（不含 .json）
   *   sheet   — sheet 名
   *   filter? — 列名 → 值（$eq 默认）或 {$gte/$lte/$gt/$lt/$ne/$in: ...}
   *   columns? — 只返回这些列
   *   limit?   — 最多返回行数，默认 50，硬上限 200
   */
  private queryExcel(avatarId: string, args: Record<string, unknown>): ToolCallResult {
    const file = args.file as string
    const sheetName = args.sheet as string
    if (!file) return { content: '', error: '缺少 file 参数（Excel basename）' }
    if (!sheetName) return { content: '', error: '缺少 sheet 参数' }

    try {
      assertSafeSegment(file, 'file')
    } catch (e) {
      return { content: '', error: e instanceof Error ? e.message : String(e) }
    }

    const jsonPath = path.join(this.avatarsPath, avatarId, 'knowledge', '_excel', `${file}.json`)
    let raw: string
    try {
      raw = fs.readFileSync(jsonPath, 'utf-8')
    } catch {
      return { content: '', error: `Excel 数据源不存在: _excel/${file}.json` }
    }

    let parsed: {
      fileName?: string
      sheets?: Array<{
        name: string
        rowCount: number
        columns: Array<{ name: string; dtype: string }>
        rows: Array<Record<string, string | number | null>>
      }>
    }
    try {
      parsed = JSON.parse(raw)
    } catch (e) {
      return { content: '', error: `Excel JSON 解析失败: ${e instanceof Error ? e.message : String(e)}` }
    }

    const sheet = parsed.sheets?.find(s => s.name === sheetName)
    if (!sheet) {
      const available = (parsed.sheets ?? []).map(s => s.name).join(', ')
      return { content: '', error: `sheet 不存在: "${sheetName}"（可用: ${available}）` }
    }

    const filter = (args.filter as Record<string, unknown>) || {}
    const columns = args.columns as string[] | undefined
    const limitRaw = args.limit
    const limit = Math.min(
      QUERY_EXCEL_HARD_LIMIT,
      typeof limitRaw === 'number' && Number.isFinite(limitRaw) && limitRaw > 0
        ? Math.floor(limitRaw)
        : QUERY_EXCEL_DEFAULT_LIMIT,
    )

    // 防 dump：没 filter 没 columns 时强制要求显式 limit，且 limit 必须很小
    const hasFilter = Object.keys(filter).length > 0
    const hasColumns = Array.isArray(columns) && columns.length > 0
    if (!hasFilter && !hasColumns && typeof limitRaw !== 'number') {
      return {
        content: '',
        error: `查询过宽：没有 filter、没有 columns、也没有 limit，会一次性返回整张表 ${sheet.rowCount} 行污染 context。请至少指定 filter（推荐）、columns 或显式 limit≤50。`,
      }
    }

    // 执行过滤
    const matched: Array<Record<string, string | number | null>> = []
    for (const row of sheet.rows) {
      if (matchFilter(row, filter)) {
        if (hasColumns) {
          const picked: Record<string, string | number | null> = {}
          for (const col of columns!) {
            if (col in row) picked[col] = row[col]
          }
          matched.push(picked)
        } else {
          matched.push(row)
        }
        if (matched.length >= limit) break
      }
    }

    const truncatedByLimit = matched.length >= limit

    // 二级保护：返回内容字符数上限。若 JSON serialize 后超过阈值，按行截断。
    let resultRows = matched
    let truncatedBySize = false
    let serialized = JSON.stringify(resultRows)
    while (serialized.length > QUERY_EXCEL_MAX_CONTENT_CHARS && resultRows.length > 1) {
      // 砍一半重试
      resultRows = resultRows.slice(0, Math.max(1, Math.floor(resultRows.length / 2)))
      truncatedBySize = true
      serialized = JSON.stringify(resultRows)
    }

    const payload = {
      file,
      sheet: sheetName,
      count: resultRows.length,
      total_matched: matched.length,
      truncated: truncatedByLimit || truncatedBySize,
      truncated_by_limit: truncatedByLimit,
      truncated_by_size: truncatedBySize,
      hint: truncatedBySize
        ? `数据被按 content size (${QUERY_EXCEL_MAX_CONTENT_CHARS} chars) 截断，请加更精细的 filter 或减少 columns 重新查询`
        : truncatedByLimit
          ? `数据被按 limit=${limit} 截断，原匹配 ${matched.length} 行，请加 filter 缩小或翻页`
          : undefined,
      rows: resultRows,
    }

    return { content: JSON.stringify(payload, null, 2) }
  }

  // ─── 计算工具（GAP4 计算引擎）────────────────────────────────────────────────

  /**
   * 工商储收益测算（GAP4 计算引擎核心）
   * 计算峰谷套利、需量管理收益
   */
  private calculateRoi(args: Record<string, unknown>): ToolCallResult {
    const toNum = (v: unknown, fallback: number): number => {
      const n = Number(v)
      return Number.isFinite(n) ? n : fallback
    }

    const capacity_kwh = toNum(args.capacity_kwh, 0)
    const power_kw = toNum(args.power_kw, 0)
    const peak_price = toNum(args.peak_price, 1.2)
    const valley_price = toNum(args.valley_price, 0.4)
    const daily_cycles = toNum(args.daily_cycles, 1)
    const dod = toNum(args.dod, 0.9)
    const efficiency = toNum(args.efficiency, 0.9)
    const annual_degradation = toNum(args.annual_degradation, 0.03)
    const project_life_years = Math.min(toNum(args.project_life_years, 10), 50)
    const investment_per_kwh = toNum(args.investment_per_kwh, 1800)
    const demand_charge_saving = toNum(args.demand_charge_saving, 0)
    const annual_opex = toNum(args.annual_opex, 0)

    if (capacity_kwh <= 0) {
      return { content: '', error: '储能容量 capacity_kwh 必须大于 0' }
    }
    if (power_kw <= 0) {
      return { content: '', error: '充放电功率 power_kw 必须大于 0' }
    }
    const investmentTotal = capacity_kwh * investment_per_kwh
    const results: string[] = []
    results.push(`## 储能收益测算报告`)
    results.push(`\n### 基础参数`)
    results.push(`- 储能容量: ${capacity_kwh} kWh`)
    results.push(`- 充放功率: ${power_kw} kW`)
    results.push(`- 峰谷电价差: ${peak_price - valley_price} 元/kWh`)
    results.push(`- 放电深度: ${dod * 100}%，系统效率: ${efficiency * 100}%`)
    results.push(`- 总投资: ${investmentTotal.toFixed(0)} 元`)

    results.push(`\n### 逐年收益预测`)
    let totalRevenue = 0
    let paybackYear: number | null = null
    let cumulativeCashflow = -investmentTotal

    for (let year = 1; year <= project_life_years; year++) {
      const degradedCapacity = capacity_kwh * Math.pow(1 - annual_degradation, year - 1)
      const dailyEnergy = degradedCapacity * dod * efficiency
      const dailyArbitrage = dailyEnergy * (peak_price - valley_price) * daily_cycles
      const annualArbitrage = dailyArbitrage * 330
      const annualRevenue = annualArbitrage + demand_charge_saving
      const netRevenue = annualRevenue - annual_opex
      totalRevenue += netRevenue
      cumulativeCashflow += netRevenue

      if (paybackYear === null && cumulativeCashflow >= 0) paybackYear = year

      results.push(`- 第 ${year} 年: 年收益 ${annualRevenue.toFixed(0)} 元，净收益 ${netRevenue.toFixed(0)} 元，累计现金流 ${cumulativeCashflow.toFixed(0)} 元`)
    }

    const roi = (totalRevenue / investmentTotal) * 100
    const irr = estimateIRR(investmentTotal, project_life_years,
      capacity_kwh, peak_price, valley_price,
      dod, efficiency, daily_cycles, demand_charge_saving, annual_opex, annual_degradation)

    results.push(`\n### 汇总`)
    results.push(`- 总投资: **${investmentTotal.toFixed(0)} 元**`)
    results.push(`- ${project_life_years} 年累计净收益: **${totalRevenue.toFixed(0)} 元**`)
    results.push(`- 静态回收期: **${paybackYear !== null ? paybackYear + ' 年' : '超过项目寿命'}**`)
    results.push(`- 整体投资回报率: **${roi.toFixed(1)}%**`)
    results.push(`- 估算 IRR: **${(irr * 100).toFixed(1)}%**`)

    return { content: results.join('\n') }
  }

  /**
   * 查询省份电价/补贴政策（从 knowledge/ 中检索）
   */
  private lookupPolicy(avatarId: string, args: Record<string, unknown>): ToolCallResult {
    const province = args.province as string
    const policyType = (args.policy_type as string) || '电价'
    if (!province) return { content: '', error: '缺少 province 参数' }

    const query = `${province} ${policyType}`
    const results = this.getRetriever(avatarId).searchChunks(query, 3)

    if (results.length === 0) {
      return { content: `暂无 ${province} 的 ${policyType} 数据，建议用户提供当地电网公司最新文件。` }
    }
    return { content: results.map(r => `### ${r.heading}\n${r.content}`).join('\n\n---\n\n') }
  }

  /**
   * 产品参数对比（从 knowledge/products/ 检索）
   */
  private compareProducts(avatarId: string, args: Record<string, unknown>): ToolCallResult {
    const raw = args.products
    const products: string[] = Array.isArray(raw)
      ? raw.filter((p): p is string => typeof p === 'string')
      : typeof raw === 'string' ? [raw] : []
    if (products.length === 0) return { content: '', error: '缺少 products 参数（需为字符串数组）' }

    const results: string[] = [`## 产品对比\n`]
    for (const productName of products) {
      const chunks = this.getRetriever(avatarId).searchChunks(productName, 2)
      if (chunks.length > 0) {
        results.push(`### ${productName}\n${chunks[0].content}`)
      } else {
        results.push(`### ${productName}\n（未找到相关数据）`)
      }
    }
    return { content: results.join('\n\n---\n\n') }
  }

  /**
   * Feature 5: 按需加载技能完整内容（渐进式披露）。
   * system prompt 中只注入技能摘要，AI 在需要执行技能时调用此工具获取完整定义。
   */
  private loadSkill(avatarId: string, args: Record<string, unknown>): ToolCallResult {
    const skillId = args.skill_id as string
    if (!skillId) return { content: '', error: '缺少 skill_id 参数' }
    try {
      assertSafeSegment(skillId, 'skill_id')
    } catch (e) {
      return { content: '', error: e instanceof Error ? e.message : String(e) }
    }
    const skillPath = path.join(this.avatarsPath, avatarId, 'skills', `${skillId}.md`)
    try {
      const content = fs.readFileSync(skillPath, 'utf-8')
      return { content: `## 技能：${skillId}\n\n${content}` }
    } catch {
      return { content: '', error: `技能不存在: ${skillId}` }
    }
  }

  /**
   * Feature 7: 委派子任务给独立子代理。
   * 若提供 callLLM，子代理会立即执行；否则返回任务 ID 供后续轮询。
   */
  private async delegateTask(
    avatarId: string,
    args: Record<string, unknown>,
    callLLM?: (sys: string, user: string, maxTokens?: number) => Promise<string>
  ): Promise<ToolCallResult> {
    const task = args.task as string
    if (!task) return { content: '', error: '缺少 task 参数' }

    if (!callLLM) {
      return { content: `[子任务已记录] 任务描述：${task}\n\n由于当前无 LLM 调用权限，请在主对话中直接完成此任务。` }
    }

    const systemPrompt = this.systemPromptCache.get(avatarId) || `你是一个专业 AI 助手，请独立完成分配的任务。`
    const agentTask = await this.subAgentManager.delegate(task, systemPrompt, callLLM)

    // 基于事件通知等待完成，无轮询
    const TIMEOUT_MS = 30000
    const t = await this.subAgentManager.waitForTask(agentTask.id, TIMEOUT_MS)
    if (!t) {
      return { content: '', error: '子任务丢失（可能已被清理），请重试。' }
    }
    if (t.status === 'done') {
      return { content: t.result ?? '子任务完成，无结果输出。' }
    }
    if (t.status === 'error') {
      return { content: '', error: `子任务失败: ${t.error}` }
    }
    return { content: `子任务执行超时（ID: ${agentTask.id}），请稍后查询结果。` }
  }
}

/**
 * MongoDB 风格 filter 匹配器。支持：
 *   - 标量值：{col: "215"} 等价于 $eq
 *   - 运算符对象：{col: {$gte: "2026-01", $lte: "2026-03"}}
 *   - 支持 $eq / $ne / $gt / $gte / $lt / $lte / $in
 *
 * 字符串/数字统一用 JS 宽松比较（支持 "2026-01" 字典序、数字大小比较）。
 */
function matchFilter(
  row: Record<string, string | number | null>,
  filter: Record<string, unknown>,
): boolean {
  for (const [col, cond] of Object.entries(filter)) {
    const cell = row[col]
    if (cond === null || cond === undefined) {
      if (cell !== null && cell !== undefined) return false
      continue
    }
    if (typeof cond === 'object' && !Array.isArray(cond)) {
      const ops = cond as Record<string, unknown>
      for (const [op, val] of Object.entries(ops)) {
        if (!matchOp(cell, op, val)) return false
      }
    } else {
      // 标量默认 $eq
      if (!looseEquals(cell, cond)) return false
    }
  }
  return true
}

function matchOp(cell: string | number | null, op: string, val: unknown): boolean {
  switch (op) {
    case '$eq':
      return looseEquals(cell, val)
    case '$ne':
      return !looseEquals(cell, val)
    case '$gt':
      return cell !== null && val !== null && val !== undefined && cell > (val as string | number)
    case '$gte':
      return cell !== null && val !== null && val !== undefined && cell >= (val as string | number)
    case '$lt':
      return cell !== null && val !== null && val !== undefined && cell < (val as string | number)
    case '$lte':
      return cell !== null && val !== null && val !== undefined && cell <= (val as string | number)
    case '$in':
      if (!Array.isArray(val)) return false
      return val.some(v => looseEquals(cell, v))
    default:
      // 未知运算符 → 不匹配
      return false
  }
}

function looseEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a === null || a === undefined || b === null || b === undefined) return false
  return String(a) === String(b)
}

/**
 * 简单 IRR 估算（牛顿迭代法，取 [-50, 300%] 区间）
 */
function estimateIRR(
  investment: number, years: number, capacity: number,
  peakPrice: number, valleyPrice: number, dod: number, efficiency: number,
  cycles: number, demandSaving: number, opex: number, degradation: number
): number {
  const cashflows = [-investment]
  for (let y = 1; y <= years; y++) {
    const degraded = capacity * Math.pow(1 - degradation, y - 1)
    const daily = degraded * dod * efficiency * (peakPrice - valleyPrice) * cycles
    const annual = daily * 330 + demandSaving - opex
    cashflows.push(annual)
  }

  let rate = 0.1
  let converged = false
  for (let i = 0; i < 50; i++) {
    let npv = 0
    let dnpv = 0
    for (let t = 0; t < cashflows.length; t++) {
      npv += cashflows[t] / Math.pow(1 + rate, t)
      if (t > 0) dnpv -= t * cashflows[t] / Math.pow(1 + rate, t + 1)
    }
    if (Math.abs(dnpv) < 1e-10) {
      converged = Math.abs(npv) < 1e-6
      break
    }
    const newRate = rate - npv / dnpv
    if (Math.abs(newRate - rate) < 1e-6) { rate = newRate; converged = true; break }
    rate = newRate
    if (rate < -0.99) { rate = -0.99; break }
    if (rate > 5) { rate = 5; break }
  }
  if (!converged) {
    console.warn(`[IRR] 牛顿迭代未收敛，返回估算值 ${(rate * 100).toFixed(2)}%`)
  }
  return rate
}
