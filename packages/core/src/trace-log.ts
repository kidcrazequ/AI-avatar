/**
 * 会话执行轨迹聚合（Traces / 工作台账共用，docs/staffdeck-adoption-plan.md W1/W2）。
 *
 * 数据源：消息表已持久化的 tool_call_timeline（chatStore 每轮 assistant 消息落库的
 * ToolCallTimelineEntry[]，经 save-message 的 toolCallTimelineJson 参数写入）。
 * 本模块是**纯函数层**——不做 IPC / IO / LLM，渲染层 TracesPanel / DashboardPanel
 * 通过 @soul/core/browser 引用，主进程与单测可直接引用。
 *
 * 范围边界（如实声明，见方案 W1 裁剪）：
 *   - RouteLog（skill-router 路由决策日志）当前未持久化，v1 不进轨迹
 *   - phase05 结构化埋点走独立日志通道，v1 不合流
 */

/**
 * 时间线条目。结构与渲染层 chatStore.ToolCallTimelineEntry 保持一致；
 * core 不能反向依赖渲染层，故此处独立声明（字段增减需两侧同步）。
 */
export interface TraceTimelineEntry {
  id: string
  name: string
  argsPreview: string
  resultPreview: string
  durationMs: number
  ok: boolean
  startedAt: number
  /** 缺省视为 'tool'（渲染层历史数据早于 kind 字段引入） */
  kind?: 'tool' | 'rag' | 'skill'
  skipped?: boolean
}

/** 聚合输入：一条消息的最小投影（渲染层从 getMessages 结果映射而来） */
export interface TraceMessageInput {
  id: string
  role: string
  /** Unix 毫秒；缺省时轮次时间回退到时间线首事件 */
  createdAt?: number
  toolCallTimeline?: TraceTimelineEntry[] | null
}

/** 一轮 assistant 回复的执行轨迹（TracesPanel 的展示单元） */
export interface TraceTurn {
  /** assistant 消息 id */
  turnId: string
  /** 轮次起点：时间线首事件 startedAt → 消息 createdAt → 0 */
  startedAt: number
  entries: TraceTimelineEntry[]
  /** 各计数均不含 skipped 条目 */
  toolCount: number
  ragCount: number
  skillCount: number
  failedCount: number
  totalDurationMs: number
  hasError: boolean
}

/**
 * 把一段会话消息聚合成轮次轨迹。
 * 只保留 role==='assistant' 且时间线非空的消息；输出顺序与输入一致。
 */
export function aggregateTraceTurns(messages: TraceMessageInput[]): TraceTurn[] {
  const turns: TraceTurn[] = []
  for (const msg of messages) {
    if (msg.role !== 'assistant') continue
    const entries = msg.toolCallTimeline ?? []
    if (entries.length === 0) continue
    let toolCount = 0
    let ragCount = 0
    let skillCount = 0
    let failedCount = 0
    let totalDurationMs = 0
    for (const e of entries) {
      if (e.skipped) continue
      const kind = e.kind ?? 'tool'
      if (kind === 'rag') ragCount++
      else if (kind === 'skill') skillCount++
      else toolCount++
      if (!e.ok) failedCount++
      totalDurationMs += Number.isFinite(e.durationMs) ? Math.max(0, e.durationMs) : 0
    }
    const firstStarted = entries.find((e) => Number.isFinite(e.startedAt) && e.startedAt > 0)?.startedAt
    turns.push({
      turnId: msg.id,
      startedAt: firstStarted ?? msg.createdAt ?? 0,
      entries,
      toolCount,
      ragCount,
      skillCount,
      failedCount,
      totalDurationMs,
      hasError: failedCount > 0,
    })
  }
  return turns
}

/** 单工具用量（工作台账 top 工具行） */
export interface ToolUsage {
  name: string
  count: number
  failed: number
}

/** 分身工作台账统计（Dashboard「工作记录」tab 的数据契约） */
export interface AvatarWorkStats {
  conversationCount: number
  turnCount: number
  toolCallCount: number
  failedToolCount: number
  /** 含 rag 类条目的轮次数（知识检索覆盖率信号） */
  ragTurnCount: number
  /** 0 轮时为 0（不除零） */
  avgTurnDurationMs: number
  /** 按 count 降序；并列时按名称字典序保证稳定输出 */
  topTools: ToolUsage[]
}

/**
 * 跨会话聚合工作台账。
 * @param turnsByConversation 每个元素 = 一个会话经 aggregateTraceTurns 的结果
 */
export function aggregateWorkStats(
  turnsByConversation: TraceTurn[][],
  opts?: { topN?: number },
): AvatarWorkStats {
  const topN = opts?.topN && opts.topN > 0 ? Math.floor(opts.topN) : 8
  const usage = new Map<string, ToolUsage>()
  let turnCount = 0
  let toolCallCount = 0
  let failedToolCount = 0
  let ragTurnCount = 0
  let durationSum = 0
  for (const turns of turnsByConversation) {
    for (const turn of turns) {
      turnCount++
      if (turn.ragCount > 0) ragTurnCount++
      durationSum += turn.totalDurationMs
      for (const e of turn.entries) {
        if (e.skipped) continue
        toolCallCount++
        const u = usage.get(e.name) ?? { name: e.name, count: 0, failed: 0 }
        u.count++
        if (!e.ok) {
          u.failed++
          failedToolCount++
        }
        usage.set(e.name, u)
      }
    }
  }
  const topTools = [...usage.values()]
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, topN)
  return {
    conversationCount: turnsByConversation.length,
    turnCount,
    toolCallCount,
    failedToolCount,
    ragTurnCount,
    avgTurnDurationMs: turnCount === 0 ? 0 : Math.round(durationSum / turnCount),
    topTools,
  }
}
