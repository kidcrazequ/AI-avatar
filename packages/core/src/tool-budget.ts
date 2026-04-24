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
  maxRounds: 10,
  maxQueryExcelCallsPerRequest: 1,
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
      if (this.queryExcelCallCount >= this.policy.maxQueryExcelCallsPerRequest) {
        return {
          allowed: false,
          reason: 'query_excel-max-calls',
          hint: `工具执行已跳过：query_excel 在当前对话已执行 ${this.policy.maxQueryExcelCallsPerRequest} 次。请基于已有查询结果直接完成回答，不要继续调用 query_excel。仅当用户明确要求新增筛选条件时，再发起新一轮对话查询。`,
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
      return `[系统提示] query_excel 配额已用完（${this.queryExcelCallCount}/${this.policy.maxQueryExcelCallsPerRequest}）。请立即基于以上数据给出最终答案（如需图表，请直接输出 \`\`\`chart 代码块），不要再调用任何工具。`
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
    `1. Excel / CSV 行级数值必须使用 query_excel；单次回答最多 ${policy.maxQueryExcelCallsPerRequest} 次。达到上限后直接基于现有数据给最终答案，不要继续试探。`,
    `2. load_skill 仅作为兜底路径，通常相关技能已由系统自动注入；单次回答最多 ${policy.maxLoadSkillCallsPerRequest} 次。`,
    '3. search_knowledge 适用于 PDF / Word / Markdown / 手写笔记等非结构化资料；不要用它代替 query_excel 查询表格数值。',
    '4. 当系统提示“工具预算已耗尽”时，立即直接回答，不要继续调用工具。',
  ]
  return lines.join('\n')
}
