/**
 * sop-runner.ts — SOP 状态机运行器（W5.2）
 *
 * 痛点：把整个 SOP 流程一次性塞进 prompt，LLM 会跳步、漏槽位、提前宣告完成。
 * 本模块每轮只注入"当前节点指令 + 已收集信息 + 转移条件"，回合结束由 LLM 自报
 * sop_state，runner 用图结构硬校验自报内容——非法转移拒绝、槽位不齐拒绝、
 * 非终点节点不许 done。这是引入状态机的全部意义：LLM 负责判断，图负责纪律。
 *
 * 设计约束（W5.3/W5.4 集成前提）：
 * - 纯状态机：无 IO / 无 LLM 调用 / 不依赖 Date.now（时间一律由调用方参数传入），
 *   保证可单测、可回放、可在会话恢复后精确重建。
 * - SopState 是纯 JSON 数据：会话持久化直接 JSON.stringify / parse，round-trip
 *   后 applyTurn 行为与未落盘完全一致。
 * - 汇报通道双轨：text 通道（回复末尾 <sop_state>JSON</sop_state>，parseReport 解析）
 *   与 tool 通道（LLM 调 sop_report 工具，ToolRouter 把参数直接交给 applyTurn）。
 *   buildTurnPrompt 通过 opts.reportChannel 切换汇报格式段，其余内容两通道一致。
 */

import type { SopCard, SopNode } from './sop-schema'

export interface SopState {
  skill: string
  nodeId: string
  filled: Record<string, string>
  startedAtMs: number
  history: string[]                      // 形如 'collect-basics -> fetch-tariff'
}

export interface SopReport { filled?: Record<string, string>; next?: string | null; done?: boolean }

export const SOP_REPORT_OPEN = '<sop_state>'
export const SOP_REPORT_CLOSE = '</sop_state>'

/** applyTurn 的判定结果 */
export interface SopTurnResult {
  state: SopState
  transitioned: boolean
  finished: boolean
  warnings: string[]
}

/** buildTurnPrompt 可选项：汇报通道，默认 'text'（回复文本内嵌标记），'tool' 走 sop_report 工具 */
export interface SopTurnPromptOptions {
  reportChannel?: 'text' | 'tool'
}

/** 槽位视为已填：非空且非纯空白（空串不算收集到） */
function isSlotFilled(value: string | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0
}

export class SopRunner {
  private readonly card: SopCard
  private readonly nodeById: Map<string, SopNode>

  constructor(card: SopCard) {
    this.card = card
    this.nodeById = new Map(card.nodes.map((n) => [n.id, n]))
  }

  /** 新会话的初始状态。时间由调用方注入（不读 Date.now），保证可测可回放 */
  initialState(nowMs: number): SopState {
    return {
      skill: this.card.skill,
      nodeId: this.card.startId,
      filled: {},
      startedAtMs: nowMs,
      history: [],
    }
  }

  /**
   * 组装本轮注入 prompt：只暴露当前节点的指令 / 槽位进度 / 转移选项，
   * 不给 LLM 看全图——每轮视野越小，跳步空间越小。
   */
  buildTurnPrompt(state: SopState, opts?: SopTurnPromptOptions): string {
    const node = this.nodeById.get(state.nodeId)
    if (!node) {
      // 防御：持久化状态损坏（nodeId 不在卡里）时不抛错，提示 LLM 如实告知用户
      return `【SOP 状态异常】当前状态记录的节点「${state.nodeId}」不在技能「${this.card.skill}」的 SOP 卡中，流程无法继续。请如实告知用户 SOP 状态已损坏，建议重新发起该流程。`
    }

    const filledEntries = Object.entries(state.filled).filter(([, v]) => isSlotFilled(v))
    const filledText = filledEntries.length > 0
      ? filledEntries.map(([k, v]) => `- ${k}: ${v}`).join('\n')
      : '（暂无）'

    const missing = node.expects.filter((slot) => !isSlotFilled(state.filled[slot]))
    const missingText = node.expects.length === 0
      ? '（本节点无需收集槽位）'
      : missing.length > 0 ? missing.join('、') : '（已收集齐）'

    const nextText = node.next.length > 0
      ? node.next.map((e) => `- ${e.to}${e.when ? `（条件: ${e.when}）` : ''}`).join('\n')
      : '（无可转移选项，本节点为流程末端）'

    const toolsText = node.tools.length > 0 ? node.tools.join('、') : '（无）'

    const channel = opts?.reportChannel ?? 'text'
    const reportSection = channel === 'tool'
      ? [
          '汇报要求: 本轮结束时调用 `sop_report` 工具上报 SOP 状态，参数含义:',
          '- filled: 本轮新收集或修正的槽位（对象，键=槽位名，值=字符串；没有则传空对象）',
          '- next: 请求转移的目标节点 id；本轮不转移传 null。仅当"仍缺槽位"为空时才允许请求转移',
          '- done: 是否完成整个流程；仅当已处于终点节点且交付完成时传 true',
          // 不在此处复述 text 通道的标记字面量：一旦出现，LLM 容易照抄成文本汇报，两通道串味
          '不要在回复正文里输出任何 SOP 状态标记文本，状态一律走 sop_report 工具上报。',
        ].join('\n')
      : [
          '汇报要求: 回复正文结束后，必须在最后输出一段 SOP 状态汇报，格式（单行 JSON）:',
          `${SOP_REPORT_OPEN}{"filled":{"槽位名":"值"},"next":"目标节点id 或 null","done":false}${SOP_REPORT_CLOSE}`,
          '- filled: 本轮新收集或修正的槽位（没有则给空对象）',
          '- next: 请求转移的目标节点 id；本轮不转移填 null。仅当"仍缺槽位"为空时才允许请求转移',
          '- done: 是否完成整个流程；仅当已处于终点节点且交付完成时填 true',
        ].join('\n')

    return [
      `【SOP 流程执行中】技能: ${this.card.skill} | 目标: ${this.card.goal}`,
      `当前节点: ${node.name}（id: ${node.id}）`,
      `节点指令: ${node.instruction}`,
      '',
      '已收集槽位:',
      filledText,
      '',
      `本节点仍缺槽位: ${missingText}`,
      '',
      '可转移选项:',
      nextText,
      '',
      `本节点建议工具: ${toolsText}`,
      '',
      reportSection,
    ].join('\n')
  }

  /**
   * 从回复文本中提取最后一个 <sop_state>...</sop_state> 的 JSON 汇报。
   * 任何环节失败（无标记 / 标记不闭合 / JSON 损坏 / 顶层不是对象）→ null，
   * 由 applyTurn 按"本轮未上报"处理，绝不猜测。
   */
  parseReport(assistantText: string): SopReport | null {
    const open = assistantText.lastIndexOf(SOP_REPORT_OPEN)
    if (open < 0) return null
    const close = assistantText.indexOf(SOP_REPORT_CLOSE, open + SOP_REPORT_OPEN.length)
    if (close < 0) return null
    const jsonText = assistantText.slice(open + SOP_REPORT_OPEN.length, close).trim()
    let parsed: unknown
    try {
      parsed = JSON.parse(jsonText)
    } catch {
      return null
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    const obj = parsed as Record<string, unknown>

    const report: SopReport = {}
    if (typeof obj.filled === 'object' && obj.filled !== null && !Array.isArray(obj.filled)) {
      const filled: Record<string, string> = {}
      for (const [k, v] of Object.entries(obj.filled as Record<string, unknown>)) {
        if (typeof v === 'string') filled[k] = v
        // LLM 常把数值槽位（如装机容量）报成 number，直接丢弃会造成真实信息损失 → 转字符串收下
        else if (typeof v === 'number' || typeof v === 'boolean') filled[k] = String(v)
        // 其余类型（对象/数组/null）不可靠，丢弃
      }
      report.filled = filled
    }
    if (obj.next === null) report.next = null
    else if (typeof obj.next === 'string') report.next = obj.next
    if (typeof obj.done === 'boolean') report.done = obj.done
    return report
  }

  /**
   * 回合结算：合并槽位 → 校验转移 → 校验完成。LLM 的自报只是"申请"，
   * 图结构说了算——这里的每条拒绝分支都是状态机存在的理由。
   * 不修改传入 state（纯函数），返回新 state；nowMs 预留给后续扩展
   * （如转移时刻审计），当前判定不依赖时钟。
   */
  applyTurn(state: SopState, report: SopReport | null, nowMs: number): SopTurnResult {
    void nowMs
    // 纪律 1：没有汇报就没有推进——状态原地不动，绝不替 LLM 猜
    if (!report) {
      return { state, transitioned: false, finished: false, warnings: ['本轮未上报 sop_state'] }
    }

    const warnings: string[] = []

    // 纪律 2：filled 合并，新值覆盖旧值（用户中途修正参数是常态）
    const filled = { ...state.filled }
    if (report.filled) {
      for (const [k, v] of Object.entries(report.filled)) filled[k] = v
    }

    const node = this.nodeById.get(state.nodeId)
    if (!node) {
      // 防御：持久化状态损坏，只合并槽位，拒绝一切推进
      return {
        state: { ...state, filled },
        transitioned: false,
        finished: false,
        warnings: [`当前节点 ${state.nodeId} 不在 SOP 卡中，已拒绝推进（状态可能已损坏）`],
      }
    }

    let nodeId = state.nodeId
    let history = state.history
    let transitioned = false

    const requested = typeof report.next === 'string' && report.next.trim().length > 0 ? report.next.trim() : null
    if (requested) {
      const allowed = node.next.some((e) => e.to === requested)
      if (!allowed) {
        // 纪律 3：只能沿图上的边走，图外目标一律拒绝
        warnings.push(`请求转移到「${requested}」被拒绝: 不在当前节点 ${node.id} 的可转移列表中`)
      } else {
        const missing = node.expects.filter((slot) => !isSlotFilled(filled[slot]))
        if (missing.length > 0) {
          // 纪律 4：槽位不齐不许走——防跳步是状态机的核心价值
          warnings.push(`请求转移到「${requested}」被拒绝: 当前节点仍有未收集槽位（${missing.join('、')}），不得跳步`)
        } else {
          nodeId = requested
          history = [...state.history, `${node.id} -> ${requested}`]
          transitioned = true
        }
      }
    }

    // 纪律 5：done 只在终点节点生效（本轮转入终点节点后 done 也算数）
    let finished = false
    if (report.done === true) {
      if (this.card.terminalIds.includes(nodeId)) finished = true
      else warnings.push('未到终点节点不可完成')
    }

    return { state: { ...state, filled, nodeId, history }, transitioned, finished, warnings }
  }
}
