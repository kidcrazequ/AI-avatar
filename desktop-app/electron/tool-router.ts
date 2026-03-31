import path from 'path'
import { KnowledgeRetriever } from './knowledge-retriever'

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

export class ToolRouter {
  private avatarsPath: string
  private retrievers = new Map<string, KnowledgeRetriever>()

  constructor(avatarsPath: string) {
    this.avatarsPath = avatarsPath
  }

  private getRetriever(avatarId: string): KnowledgeRetriever {
    if (!this.retrievers.has(avatarId)) {
      const knowledgePath = path.join(this.avatarsPath, avatarId, 'knowledge')
      this.retrievers.set(avatarId, new KnowledgeRetriever(knowledgePath))
    }
    return this.retrievers.get(avatarId)!
  }

  /** 执行工具调用 */
  async execute(avatarId: string, request: ToolCallRequest): Promise<ToolCallResult> {
    const { name, arguments: args } = request

    try {
      switch (name) {
        case 'read_knowledge_file':
          return this.readKnowledgeFile(avatarId, args)
        case 'search_knowledge':
          return this.searchKnowledge(avatarId, args)
        case 'list_knowledge_files':
          return this.listKnowledgeFiles(avatarId)
        case 'calculate_roi':
          return this.calculateRoi(args)
        case 'lookup_policy':
          return this.lookupPolicy(avatarId, args)
        case 'compare_products':
          return this.compareProducts(avatarId, args)
        default:
          return { content: '', error: `未知工具: ${name}` }
      }
    } catch (error) {
      return { content: '', error: (error as Error).message }
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

  // ─── 计算工具（GAP4 计算引擎）────────────────────────────────────────────────

  /**
   * 工商储收益测算（GAP4 计算引擎核心）
   * 计算峰谷套利、需量管理收益
   */
  private calculateRoi(args: Record<string, unknown>): ToolCallResult {
    const {
      capacity_kwh = 0,          // 储能容量 (kWh)
      power_kw = 0,               // 充放电功率 (kW)
      peak_price = 1.2,           // 峰时电价 (元/kWh)
      valley_price = 0.4,         // 谷时电价 (元/kWh)
      daily_cycles = 1,           // 日充放电次数
      dod = 0.9,                  // 放电深度 (%)
      efficiency = 0.9,           // 系统效率（充放双向）
      annual_degradation = 0.03,  // 年容量衰减率
      project_life_years = 10,    // 项目寿命
      investment_per_kwh = 1800,  // 投资成本 (元/kWh)
      demand_charge_saving = 0,   // 需量管理年节省 (元)
      annual_opex = 0,            // 年运维成本 (元)
    } = args as Record<string, number>

    const investmentTotal = (capacity_kwh as number) * investment_per_kwh
    const results: string[] = []
    results.push(`## 储能收益测算报告`)
    results.push(`\n### 基础参数`)
    results.push(`- 储能容量: ${capacity_kwh} kWh`)
    results.push(`- 充放功率: ${power_kw} kW`)
    results.push(`- 峰谷电价差: ${(peak_price as number) - (valley_price as number)} 元/kWh`)
    results.push(`- 放电深度: ${(dod as number) * 100}%，系统效率: ${(efficiency as number) * 100}%`)
    results.push(`- 总投资: ${investmentTotal.toFixed(0)} 元`)

    results.push(`\n### 逐年收益预测`)
    let totalRevenue = 0
    let paybackYear: number | null = null
    let cumulativeCashflow = -investmentTotal

    for (let year = 1; year <= (project_life_years as number); year++) {
      const degradedCapacity = (capacity_kwh as number) * Math.pow(1 - annual_degradation, year - 1)
      const dailyEnergy = degradedCapacity * (dod as number) * (efficiency as number)
      const dailyArbitrage = dailyEnergy * ((peak_price as number) - (valley_price as number)) * (daily_cycles as number)
      const annualArbitrage = dailyArbitrage * 330  // 约330个工作日
      const annualRevenue = annualArbitrage + (demand_charge_saving as number)
      const netRevenue = annualRevenue - (annual_opex as number)
      totalRevenue += netRevenue
      cumulativeCashflow += netRevenue

      if (paybackYear === null && cumulativeCashflow >= 0) paybackYear = year

      results.push(`- 第 ${year} 年: 年收益 ${annualRevenue.toFixed(0)} 元，净收益 ${netRevenue.toFixed(0)} 元，累计现金流 ${cumulativeCashflow.toFixed(0)} 元`)
    }

    const roi = (totalRevenue / investmentTotal) * 100
    const irr = estimateIRR(investmentTotal, project_life_years as number,
      (capacity_kwh as number), peak_price as number, valley_price as number,
      dod as number, efficiency as number, daily_cycles as number, demand_charge_saving as number, annual_opex as number, annual_degradation as number)

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
    const products = (args.products as string[]) || []
    if (products.length === 0) return { content: '', error: '缺少 products 参数' }

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
  for (let i = 0; i < 50; i++) {
    let npv = 0
    let dnpv = 0
    for (let t = 0; t < cashflows.length; t++) {
      npv += cashflows[t] / Math.pow(1 + rate, t)
      if (t > 0) dnpv -= t * cashflows[t] / Math.pow(1 + rate, t + 1)
    }
    if (Math.abs(dnpv) < 1e-10) break
    const newRate = rate - npv / dnpv
    if (Math.abs(newRate - rate) < 1e-6) { rate = newRate; break }
    rate = newRate
    if (rate < -0.99) { rate = -0.99; break }
    if (rate > 5) { rate = 5; break }
  }
  return rate
}
