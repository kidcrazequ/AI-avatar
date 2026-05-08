import { buildSourceAnchorReferenceBlock, extractSourceAnchorsFromContent } from './source-anchor'

export interface ToolPolicy {
  maxRounds: number
  maxQueryExcelCallsPerRequest: number
  maxLoadSkillCallsPerRequest: number
  enableQueryExcelGuard: boolean
  enableLoadSkillGuard: boolean
  enableToolConvergeMode: boolean
  enableConvergeFinalRoundSpeedup: boolean
  convergeFinalRoundMaxTokens: number
  maxToolResultContextChars: number
  toolResultCompressThreshold: number
}

export const DEFAULT_TOOL_POLICY: ToolPolicy = {
  // 工具循环硬上限。25 → 30 同步扩容（v0.9.3 调整理由：query_excel 上限提高到 24 后，
  // 若 maxRounds 仍是 25，会被 query_excel 占满后挤掉 export_excel / load_skill 等收尾工具）。
  maxRounds: 30,
  // 单次回答允许 query_excel 调用次数。
  //   - 之前设为 1：L1 单点查询够，但 L2/L3 跨列对比、Excel 合并单元格 label 写错重试、
  //     先 schema 再 filter 等场景一次根本不够，反而促使 LLM 编"配额已用尽"作为放弃借口
  //   - 之前设为 5：仍不足 — 2026-05-01 回归报告显示 L1/L2 大量"先 schema → 多 sheet 试 →
  //     变体重试"的真实需求被打断（参见 task-router rule A3 约束）；典型 L2 跨表对比要查 4-6
  //     次（schema, sheet1 filter, sheet2 filter, 命名变体重试 1-2 次）
  //   - 之前设为 8：覆盖典型穷举（schema + 3-4 sheet × 1-2 变体），同时 8×8KB ≈ 64KB 仍远低于
  //     DeepSeek 131K 窗口；compress() 在第 2 轮后会进一步压缩历史结果，安全余量足够
  //   - v0.9.3 调整理由：用户反馈双 Excel 多 sheet 对比任务（2 schema + 8 共有 sheet × 2 +
  //     3 独有 sheet ≈ 21 次精确查询）触底，第 9 次起被守卫短路；现设为 24 覆盖此类双源
  //     对比/diff 报告场景，配合 export_excel 工具一次性产出落盘 .xlsx
  maxQueryExcelCallsPerRequest: 24,
  maxLoadSkillCallsPerRequest: 1,
  enableQueryExcelGuard: true,
  enableLoadSkillGuard: true,
  enableToolConvergeMode: true,
  enableConvergeFinalRoundSpeedup: true,
  convergeFinalRoundMaxTokens: 1200,
  maxToolResultContextChars: 6000,
  toolResultCompressThreshold: 2000,
}

export interface ToolBudgetConsumeResult {
  allowed: boolean
  hint?: string
  reason?: 'query_excel-max-calls' | 'load_skill-max-calls'
}

export interface ToolBudgetMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: unknown
  tool_calls?: unknown
  tool_call_id?: string
  name?: string
}

/**
 * 规范化 query_excel 参数生成稳定 cache key。
 * 仅做等价写法归一，不做语义归一。
 */
export function normalizeQueryExcelArgs(args: Record<string, unknown>): string {
  const normObj = (v: unknown): unknown => {
    if (v === null || v === undefined) return v
    if (typeof v === 'string') return v.trim()
    if (Array.isArray(v)) return v.map(normObj)
    if (typeof v === 'object') {
      const out: Record<string, unknown> = {}
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        out[k] = normObj((v as Record<string, unknown>)[k])
      }
      return out
    }
    return v
  }

  const norm = normObj(args) as Record<string, unknown>
  if (Array.isArray(norm.columns)) {
    norm.columns = [...norm.columns]
      .map(c => (typeof c === 'string' ? c.trim() : c))
      .sort((a, b) => String(a).localeCompare(String(b)))
  }
  return JSON.stringify(norm)
}

function buildToolResultAnchorAppendix(content: string, title: string, maxAnchors: number): string {
  return buildSourceAnchorReferenceBlock(extractSourceAnchorsFromContent(content), {
    title,
    maxAnchors,
  })
}

/**
 * 运行时工具预算。负责守卫、上下文截断与历史工具结果压缩。
 * 这是 prompt/runtime 的唯一真相源之一：同一份 policy 同时驱动提示词和运行时行为。
 */
export class ToolBudget {
  readonly policy: ToolPolicy

  private queryExcelCallCount = 0
  private loadSkillCallCount = 0

  constructor(policy: Partial<ToolPolicy> = {}) {
    this.policy = { ...DEFAULT_TOOL_POLICY, ...policy }
  }

  get maxRounds(): number {
    return this.policy.maxRounds
  }

  get convergeFinalRoundMaxTokens(): number {
    return this.policy.convergeFinalRoundMaxTokens
  }

  get enableConvergeFinalRoundSpeedup(): boolean {
    return this.policy.enableConvergeFinalRoundSpeedup
  }

  tryConsume(name: string): ToolBudgetConsumeResult {
    if (name === 'query_excel' && this.policy.enableQueryExcelGuard) {
      // 第 N 次调用前检查上限。注意：达到上限时返回的 hint 措辞要克制，
      // 避免使用"配额"等诱导 LLM 编"配额已用尽"幻觉的字眼。
      if (this.queryExcelCallCount >= this.policy.maxQueryExcelCallsPerRequest) {
        return {
          allowed: false,
          reason: 'query_excel-max-calls',
          hint: `工具执行已跳过：query_excel 在当前对话已调用 ${this.policy.maxQueryExcelCallsPerRequest} 次（兜底上限）。请立即基于已查到的数据给出最终答案；若仍缺关键数据，请如实说明"在 X 文件 Y sheet 未查到 Z 行"，不要再调用工具，也不要把上限当成"放弃借口"。仅当用户明确发起新对话时才会重置计数。`,
        }
      }
      this.queryExcelCallCount++
      return { allowed: true }
    }

    if (name === 'load_skill' && this.policy.enableLoadSkillGuard) {
      if (this.loadSkillCallCount >= this.policy.maxLoadSkillCallsPerRequest) {
        return {
          allowed: false,
          reason: 'load_skill-max-calls',
          hint: `工具执行已跳过：load_skill 在当前对话已执行 ${this.policy.maxLoadSkillCallsPerRequest} 次。相关技能内容通常已由系统注入，请基于已有上下文直接完成回答，不要继续调用 load_skill。`,
        }
      }
      this.loadSkillCallCount++
      return { allowed: true }
    }

    return { allowed: true }
  }

  shouldConverge(reason?: ToolBudgetConsumeResult['reason']): boolean {
    if (!this.policy.enableToolConvergeMode) return false
    return reason === 'query_excel-max-calls' || reason === 'load_skill-max-calls'
  }

  getBudgetExhaustedHint(name: string): string | undefined {
    if (name === 'query_excel' && this.policy.enableQueryExcelGuard && this.queryExcelCallCount >= this.policy.maxQueryExcelCallsPerRequest) {
      // 措辞克制：避免"配额"字眼诱导 LLM 转述为"配额已用尽"作为放弃借口
      return `[系统提示] query_excel 已达本轮上限（${this.queryExcelCallCount}/${this.policy.maxQueryExcelCallsPerRequest} 次，兜底约束）。请立即基于已查到的数据给最终答案；若仍缺数据，请明确写"在 <文件> 的 <sheet> 中以 filter <X> 未查到对应行"，不要再调用工具，也不要把上限措辞误转为"配额已用尽 / 无法查询"。`
    }
    if (name === 'load_skill' && this.policy.enableLoadSkillGuard && this.loadSkillCallCount >= this.policy.maxLoadSkillCallsPerRequest) {
      return `[系统提示] load_skill 配额已用完（${this.loadSkillCallCount}/${this.policy.maxLoadSkillCallsPerRequest}）。请基于当前已注入的技能与数据直接完成回答，不要再调用工具。`
    }
    return undefined
  }

  /**
   * 压缩旧轮次的 tool 结果，保留最近 2 轮完整内容。
   * 压缩时额外保留一份精简来源锚点，避免后续回答阶段丢失可追溯出处。
   */
  compress<T extends ToolBudgetMessage>(messages: T[]): void {
    let assistantsSeen = 0
    let preserveFromIdx = -1
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'assistant') {
        assistantsSeen++
        if (assistantsSeen >= 2) {
          preserveFromIdx = i
          break
        }
      }
    }
    if (preserveFromIdx <= 0) return

    for (let i = 0; i < preserveFromIdx; i++) {
      const msg = messages[i]
      if (msg.role === 'tool' && typeof msg.content === 'string' && msg.content.length > this.policy.toolResultCompressThreshold) {
        const anchorAppendix = buildToolResultAnchorAppendix(msg.content, '压缩后仍可直接复用的来源锚点', 4)
        messages[i] = {
          ...msg,
          content: [
            msg.content.slice(0, 500),
            anchorAppendix,
            `[..., 已压缩，原文 ${msg.content.length} 字符。⚠️ 不要因为这段被压缩就重新调用相同参数的工具。仅当需要不同 filter / sheet / file 的新数据时才调用工具。]`,
          ].filter(Boolean).join('\n\n'),
        }
      }
    }
  }

  truncate(toolName: string, content: string): { content: string; truncated: boolean; originalLength: number } {
    const originalLength = content.length
    if (originalLength <= this.policy.maxToolResultContextChars) {
      return { content, truncated: false, originalLength }
    }
    const clipped = content.slice(0, this.policy.maxToolResultContextChars)
    const anchorAppendix = buildToolResultAnchorAppendix(content, '截断后仍可直接复用的来源锚点', 6)
    const note = `[系统提示] 工具 ${toolName} 返回内容过长（原始 ${originalLength} 字符），已截断为前 ${this.policy.maxToolResultContextChars} 字符用于上下文续推。请基于现有结果直接收敛回答，除非用户明确要求新的查询维度。`
    return {
      content: [clipped, anchorAppendix, note].filter(Boolean).join('\n\n'),
      truncated: true,
      originalLength,
    }
  }
}

/**
 * 运行时预算与 system prompt 对齐用的短约束。
 * 放在 stable prompt 后面，确保模型看到的规则与 runtime 守卫一致。
 */
export function buildToolPolicyPromptHints(policy: ToolPolicy = DEFAULT_TOOL_POLICY): string {
  const lines = [
    '[运行时工具约束｜以此为准]',
    // 第 1 条措辞调整：去"配额"，改"按需调用"+ 上限是兜底而非起点；
    // 同时点明"未达上限就不能编借口偷懒"，从源头堵幻觉路径。
    `1. Excel / CSV 行级数值必须先调 query_excel 拿真实结果。一次精确 filter 查不全可继续调（本轮上限 ${policy.maxQueryExcelCallsPerRequest} 次，未达上限不得以"已达上限/配额已用尽/无法查询"为由拒绝调用）；上限只是防试探失控的兜底。`,
    `2. load_skill 仅作为兜底路径，通常相关技能已由系统自动注入；单次回答最多 ${policy.maxLoadSkillCallsPerRequest} 次。`,
    '3. search_knowledge 适用于 PDF / Word / Markdown / 手写笔记等非结构化资料；不要用它代替 query_excel 查询表格数值。',
    `4. 工具循环硬上限为 ${policy.maxRounds} 轮；当系统提示"已达本轮上限"或"系统硬上限"时，立即基于已查到的数据给最终答案，不要继续调用工具，也不要用"上限"为由编造未发生的查询过程。`,
  ]
  return lines.join('\n')
}
