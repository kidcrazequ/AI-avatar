/**
 * DashboardPanel — 分身工作台账（docs/staffdeck-adoption-plan.md W2）。
 *
 * 四 tab：记忆 / 会话日志 / 定时任务 / 工作记录。tab 切换为本地 state，不引路由。
 *   - 记忆：readMemory（MEMORY.md 原文）+ getMemoryStats，渲染方式对齐 MemoryPanel
 *   - 会话日志：getConversations 只读列表——chatStore 没有"切换当前会话"的完整 action
 *     （bindConversation 只绑任务列表，真正的会话切换是 App 层 handleSelectConversation），
 *     故本 tab 不做点击回跳，只读展示
 *   - 定时任务：消费已有 schedule:list / schedule:update IPC 的轻量视图，
 *     完整管理（新建/编辑/删除/触发历史）在 SchedulesPanel
 *   - 工作记录：最近 20 个会话（上限在 UI 明示，不静默截断）逐个 getMessages，
 *     经 aggregateTraceTurns / aggregateWorkStats（@soul/core/browser 纯函数）出统计
 *
 * 风格对齐 SchedulesPanel / MemoryPanel 的 pixel UI（PanelHeader + font-game + px-* 色板）。
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  MEMORY_CHAR_LIMIT,
  aggregateTraceTurns,
  aggregateWorkStats,
  type TraceTimelineEntry,
  type TraceMessageInput,
  type AvatarWorkStats,
} from '@soul/core/browser'
import PanelHeader from './shared/PanelHeader'

interface Props {
  avatarId: string
  onClose: () => void
}

type DashboardTab = 'memory' | 'conversations' | 'schedules' | 'work'

const TABS: Array<{ key: DashboardTab; label: string }> = [
  { key: 'memory', label: '记忆' },
  { key: 'conversations', label: '会话日志' },
  { key: 'schedules', label: '定时任务' },
  { key: 'work', label: '工作记录' },
]

/** 工作记录统计的会话数上限——UI 里明示该范围，禁止静默截断 */
const WORK_STATS_CONVERSATION_LIMIT = 20

/** Unix ms → 本地可读时间（与 SchedulesPanel.fmtLocalTime 同格式） */
function fmtLocalTime(ts: number | null | undefined): string {
  if (!ts) return '—'
  const d = new Date(ts)
  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  const hh = String(d.getHours()).padStart(2, '0')
  const mi = String(d.getMinutes()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}`
}

/** 平均轮耗时展示：>=1s 用秒（1 位小数），否则毫秒 */
function fmtDuration(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`
  return `${ms}ms`
}

/**
 * DB tool_call_timeline_json 列 → 时间线数组。
 * 损坏 / 非数组一律视为无时间线（对齐 ChatWindow.parseTimeline 的容错语义，不崩）。
 */
function parseTimelineJson(raw: string | null | undefined): TraceTimelineEntry[] | undefined {
  if (!raw) return undefined
  try {
    const parsed: unknown = JSON.parse(raw)
    if (Array.isArray(parsed) && parsed.length > 0) {
      return parsed as TraceTimelineEntry[]
    }
  } catch { /* swallow: 损坏列等价于无时间线 */ }
  return undefined
}

/** 工作记录 tab 的聚合结果（含扫描范围元信息，供 UI 如实披露） */
interface WorkStatsResult {
  stats: AvatarWorkStats
  /** 该分身会话总数（用于展示"共 N 个，统计最近 M 个"） */
  totalConversations: number
  /** getMessages 拉取失败的会话数（fail loud：显示而不是吞掉） */
  fetchFailedCount: number
}

export default function DashboardPanel({ avatarId, onClose }: Props) {
  const [tab, setTab] = useState<DashboardTab>('memory')

  // ─── 记忆 tab ─────────────────────────────────────────────────────────────
  const [memoryContent, setMemoryContent] = useState('')
  const [memoryStats, setMemoryStats] = useState<{ chars: number; ratio: number; entries: number } | null>(null)
  const [memoryError, setMemoryError] = useState<string | null>(null)
  const [memoryLoading, setMemoryLoading] = useState(false)

  // ─── 会话日志 tab ─────────────────────────────────────────────────────────
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [convError, setConvError] = useState<string | null>(null)
  const [convLoading, setConvLoading] = useState(false)

  // ─── 定时任务 tab ─────────────────────────────────────────────────────────
  const [schedules, setSchedules] = useState<ScheduleRow[]>([])
  const [scheduleError, setScheduleError] = useState<string | null>(null)
  const [scheduleLoading, setScheduleLoading] = useState(false)
  /** 正在切换启停的 schedule id（防连点） */
  const [togglingId, setTogglingId] = useState<string | null>(null)

  // ─── 工作记录 tab ─────────────────────────────────────────────────────────
  const [workResult, setWorkResult] = useState<WorkStatsResult | null>(null)
  const [workError, setWorkError] = useState<string | null>(null)
  const [workLoading, setWorkLoading] = useState(false)
  /** 顺序拉取进度：done/total（20 次 IPC 顺序 await，必须有加载中态） */
  const [workProgress, setWorkProgress] = useState<{ done: number; total: number } | null>(null)

  /** 各 tab 独立的加载序号，防止快速切 tab / 卸载后旧请求覆盖新状态 */
  const loadSeqRef = useRef({ memory: 0, conversations: 0, schedules: 0, work: 0 })

  const reportError = useCallback((area: string, err: unknown): string => {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(`[DashboardPanel] ${area} 失败:`, msg)
    try {
      window.electronAPI.logEvent('error', `dashboard-panel:${area}`, msg)
    } catch { /* logEvent 自身失败不阻塞 UI */ }
    return msg
  }, [])

  const loadMemory = useCallback(async () => {
    const seq = ++loadSeqRef.current.memory
    setMemoryLoading(true)
    setMemoryError(null)
    try {
      const [content, stats] = await Promise.all([
        window.electronAPI.readMemory(avatarId),
        window.electronAPI.getMemoryStats(avatarId),
      ])
      if (loadSeqRef.current.memory !== seq) return
      setMemoryContent(content)
      setMemoryStats(stats)
    } catch (err) {
      if (loadSeqRef.current.memory !== seq) return
      setMemoryError(reportError('load-memory', err))
    } finally {
      if (loadSeqRef.current.memory === seq) setMemoryLoading(false)
    }
  }, [avatarId, reportError])

  const loadConversations = useCallback(async () => {
    const seq = ++loadSeqRef.current.conversations
    setConvLoading(true)
    setConvError(null)
    try {
      const list = await window.electronAPI.getConversations(avatarId)
      if (loadSeqRef.current.conversations !== seq) return
      setConversations(list)
    } catch (err) {
      if (loadSeqRef.current.conversations !== seq) return
      setConvError(reportError('load-conversations', err))
    } finally {
      if (loadSeqRef.current.conversations === seq) setConvLoading(false)
    }
  }, [avatarId, reportError])

  const loadSchedules = useCallback(async () => {
    const seq = ++loadSeqRef.current.schedules
    setScheduleLoading(true)
    setScheduleError(null)
    try {
      const list = await window.electronAPI.scheduleList(avatarId)
      if (loadSeqRef.current.schedules !== seq) return
      setSchedules(list)
    } catch (err) {
      if (loadSeqRef.current.schedules !== seq) return
      setScheduleError(reportError('load-schedules', err))
    } finally {
      if (loadSeqRef.current.schedules === seq) setScheduleLoading(false)
    }
  }, [avatarId, reportError])

  const loadWorkStats = useCallback(async () => {
    const seq = ++loadSeqRef.current.work
    setWorkLoading(true)
    setWorkError(null)
    setWorkProgress(null)
    try {
      const all = await window.electronAPI.getConversations(avatarId)
      if (loadSeqRef.current.work !== seq) return
      // getConversations 按 updated_at DESC 返回（database.ts），头部即最近
      const scanned = all.slice(0, WORK_STATS_CONVERSATION_LIMIT)
      let fetchFailedCount = 0
      const aggregated = []
      for (let i = 0; i < scanned.length; i++) {
        setWorkProgress({ done: i, total: scanned.length })
        try {
          // 顺序 await：避免 20 路并发压主进程同步 SQLite
          const messages = await window.electronAPI.getMessages(scanned[i].id)
          if (loadSeqRef.current.work !== seq) return
          const inputs: TraceMessageInput[] = messages.map((m) => ({
            id: m.id,
            role: m.role,
            createdAt: m.created_at,
            toolCallTimeline: parseTimelineJson(m.tool_call_timeline_json),
          }))
          aggregated.push(aggregateTraceTurns(inputs))
        } catch (err) {
          if (loadSeqRef.current.work !== seq) return
          // 单会话拉取失败不中断整体统计，但计数披露（fail loud）
          fetchFailedCount++
          reportError('work-get-messages', err)
        }
      }
      if (loadSeqRef.current.work !== seq) return
      setWorkResult({
        stats: aggregateWorkStats(aggregated),
        totalConversations: all.length,
        fetchFailedCount,
      })
      setWorkProgress(null)
    } catch (err) {
      if (loadSeqRef.current.work !== seq) return
      setWorkError(reportError('load-work-stats', err))
    } finally {
      if (loadSeqRef.current.work === seq) setWorkLoading(false)
    }
  }, [avatarId, reportError])

  // tab 激活时懒加载对应数据（avatarId 变化会因 loader 依赖变化而重载）。
  // loader 首行会 setLoading(true)，先让出一个微任务再调用——避免在 effect 同步阶段
  // setState 触发级联渲染（repo 的 react-hooks/set-state-in-effect 规则）。
  useEffect(() => {
    let cancelled = false
    const run = async (): Promise<void> => {
      await Promise.resolve()
      if (cancelled) return
      if (tab === 'memory') await loadMemory()
      else if (tab === 'conversations') await loadConversations()
      else if (tab === 'schedules') await loadSchedules()
      else await loadWorkStats()
    }
    void run()
    return () => { cancelled = true }
  }, [tab, loadMemory, loadConversations, loadSchedules, loadWorkStats])

  /** 启停开关：scheduleUpdate 的 patch 键名为 enabled（boolean，主进程转 0/1 落库） */
  const handleToggleSchedule = async (row: ScheduleRow) => {
    setTogglingId(row.id)
    try {
      await window.electronAPI.scheduleUpdate(row.id, { enabled: row.enabled !== 1 })
      await loadSchedules()
    } catch (err) {
      setScheduleError(reportError('toggle-schedule', err))
    } finally {
      setTogglingId(null)
    }
  }

  // ─── 渲染：记忆 tab ───────────────────────────────────────────────────────
  const renderMemoryTab = () => {
    if (memoryLoading) {
      return <div className="font-game text-[12px] text-px-text-dim p-6 text-center">正在读取记忆…</div>
    }
    if (memoryError) {
      return <div className="font-game text-[12px] text-red-400 p-6 text-center">读取记忆失败：{memoryError}</div>
    }
    return (
      <div className="h-full flex flex-col">
        {memoryStats && (
          <div className="px-4 py-2 border-b-2 border-px-border bg-px-elevated flex-shrink-0">
            <span className="font-game text-[11px] text-px-text-dim">
              注入体积 {memoryStats.chars} / {MEMORY_CHAR_LIMIT} 字符
              （{Math.round(memoryStats.ratio * 100)}%） · 结构化条目 {memoryStats.entries} 条
            </span>
          </div>
        )}
        <div className="flex-1 overflow-y-auto p-6">
          {memoryContent ? (
            <div className="prose prose-sm prose-invert max-w-none prose-pixel font-body
              prose-headings:font-game prose-headings:font-bold prose-headings:text-px-text prose-headings:tracking-wider
              prose-p:text-px-text-sec prose-p:leading-[1.75] prose-p:text-[14px] prose-p:font-body
              prose-code:text-px-accent prose-code:bg-px-bg prose-code:px-1.5 prose-code:py-0.5 prose-code:border prose-code:border-px-border prose-code:text-[13px] prose-code:font-mono
              prose-strong:text-px-text prose-strong:font-bold
              prose-a:text-px-primary prose-a:no-underline hover:prose-a:underline
              prose-li:text-px-text-sec prose-li:marker:text-px-primary prose-li:font-body">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{memoryContent}</ReactMarkdown>
            </div>
          ) : (
            <div className="font-game text-[12px] text-px-text-dim p-6 text-center border-2 border-px-border bg-px-bg-sec">
              该分身暂无长期记忆（memory/MEMORY.md 为空或不存在）
            </div>
          )}
        </div>
      </div>
    )
  }

  // ─── 渲染：会话日志 tab ───────────────────────────────────────────────────
  const renderConversationsTab = () => {
    if (convLoading) {
      return <div className="font-game text-[12px] text-px-text-dim p-6 text-center">正在加载会话列表…</div>
    }
    if (convError) {
      return <div className="font-game text-[12px] text-red-400 p-6 text-center">加载会话列表失败：{convError}</div>
    }
    return (
      <div className="h-full overflow-y-auto p-4">
        <div className="font-game text-[11px] text-px-text-dim mb-3">
          共 {conversations.length} 个会话 · 只读台账（切换会话请使用左侧会话列表）
        </div>
        {conversations.length === 0 ? (
          <div className="font-game text-[12px] text-px-text-dim p-6 text-center border-2 border-px-border bg-px-bg-sec">
            该分身暂无会话记录
          </div>
        ) : (
          conversations.map((c) => (
            <div key={c.id} className="p-3 mb-2 border-2 border-px-border bg-px-bg-sec">
              <div className="font-game text-[13px] text-px-text truncate">{c.title || '（无标题）'}</div>
              <div className="font-game text-[10px] text-px-text-sec mt-1">
                更新 {fmtLocalTime(c.updated_at)} · 创建 {fmtLocalTime(c.created_at)}
                {c.project_id && c.project_id !== 'default' ? ` · 项目 ${c.project_id}` : ''}
              </div>
              <div className="font-mono text-[10px] text-px-text-dim mt-0.5 truncate">{c.id}</div>
            </div>
          ))
        )}
      </div>
    )
  }

  // ─── 渲染：定时任务 tab ───────────────────────────────────────────────────
  const renderSchedulesTab = () => {
    if (scheduleLoading) {
      return <div className="font-game text-[12px] text-px-text-dim p-6 text-center">正在加载定时任务…</div>
    }
    return (
      <div className="h-full overflow-y-auto p-4">
        <div className="font-game text-[11px] text-px-text-dim mb-3">
          轻量视图：仅支持启停。完整管理（新建 / 编辑 / 删除 / 触发历史）请打开定时任务面板。
        </div>
        {scheduleError && (
          <div className="font-game text-[11px] text-red-400 mb-3">操作失败：{scheduleError}</div>
        )}
        {schedules.length === 0 ? (
          <div className="font-game text-[12px] text-px-text-dim p-6 text-center border-2 border-px-border bg-px-bg-sec">
            该分身暂无定时任务，可在定时任务面板创建
          </div>
        ) : (
          schedules.map((row) => (
            <div key={row.id} className="p-3 mb-2 border-2 border-px-border bg-px-bg-sec flex items-center gap-3">
              <div className="flex-1 min-w-0">
                <div className="font-game text-[13px] text-px-text truncate">{row.name}</div>
                <div className="font-mono text-[11px] text-px-text-sec mt-1">
                  {row.cron_expr} · {row.timezone}
                </div>
                <div className="font-game text-[10px] text-px-text-dim mt-0.5">
                  下次触发：{row.enabled === 1 ? fmtLocalTime(row.next_run_at) : '已停用'}
                </div>
              </div>
              <button
                onClick={() => { void handleToggleSchedule(row) }}
                disabled={togglingId === row.id}
                className={`px-3 py-1 font-game text-[11px] border-2 flex-shrink-0 ${
                  row.enabled === 1
                    ? 'border-px-primary bg-px-primary/20 text-px-primary'
                    : 'border-px-border bg-px-bg text-px-text-dim'
                } ${togglingId === row.id ? 'opacity-50' : 'hover:border-px-primary'}`}
              >
                {togglingId === row.id ? '…' : row.enabled === 1 ? 'ON' : 'OFF'}
              </button>
            </div>
          ))
        )}
      </div>
    )
  }

  // ─── 渲染：工作记录 tab ───────────────────────────────────────────────────
  const renderWorkTab = () => {
    if (workLoading) {
      return (
        <div className="font-game text-[12px] text-px-text-dim p-6 text-center">
          正在统计{workProgress ? `（${workProgress.done}/${workProgress.total} 个会话）` : '…'}
        </div>
      )
    }
    if (workError) {
      return <div className="font-game text-[12px] text-red-400 p-6 text-center">统计失败：{workError}</div>
    }
    if (!workResult) return null
    const { stats, totalConversations, fetchFailedCount } = workResult
    const statItems: Array<{ label: string; value: string }> = [
      { label: '会话数', value: String(stats.conversationCount) },
      { label: '轮次', value: String(stats.turnCount) },
      { label: '工具调用', value: String(stats.toolCallCount) },
      { label: '失败', value: String(stats.failedToolCount) },
      { label: 'RAG 覆盖轮次', value: String(stats.ragTurnCount) },
      { label: '平均轮耗时', value: stats.turnCount === 0 ? '—' : fmtDuration(stats.avgTurnDurationMs) },
    ]
    return (
      <div className="h-full overflow-y-auto p-4">
        <div className="font-game text-[11px] text-px-text-dim mb-3">
          统计最近 {WORK_STATS_CONVERSATION_LIMIT} 个会话（按更新时间倒序；该分身共 {totalConversations} 个）
        </div>
        {fetchFailedCount > 0 && (
          <div className="font-game text-[11px] text-red-400 mb-3">
            {fetchFailedCount} 个会话消息拉取失败，未计入统计（详见日志）
          </div>
        )}
        <div className="grid grid-cols-3 gap-2 mb-4">
          {statItems.map((item) => (
            <div key={item.label} className="p-3 border-2 border-px-border bg-px-bg-sec text-center">
              <div className="font-game text-[16px] text-px-primary">{item.value}</div>
              <div className="font-game text-[10px] text-px-text-sec mt-1">{item.label}</div>
            </div>
          ))}
        </div>
        {stats.turnCount === 0 ? (
          <div className="font-game text-[12px] text-px-text-dim p-6 text-center border-2 border-px-border bg-px-bg-sec">
            统计范围内没有工具调用轨迹（时间线自 v19 起才随消息落库，老会话无数据属正常）
          </div>
        ) : (
          <div>
            <div className="font-game text-[12px] text-px-primary mb-2">TOP 工具</div>
            <table className="w-full border-collapse">
              <thead>
                <tr className="border-b-2 border-px-border">
                  <th className="font-game text-[11px] text-px-text-sec text-left py-1.5 px-2">工具</th>
                  <th className="font-game text-[11px] text-px-text-sec text-right py-1.5 px-2">次数</th>
                  <th className="font-game text-[11px] text-px-text-sec text-right py-1.5 px-2">失败</th>
                </tr>
              </thead>
              <tbody>
                {stats.topTools.map((t) => (
                  <tr key={t.name} className="border-b border-px-border-dim">
                    <td className="font-mono text-[11px] text-px-text py-1.5 px-2 truncate max-w-[280px]">{t.name}</td>
                    <td className="font-game text-[11px] text-px-text text-right py-1.5 px-2">{t.count}</td>
                    <td className={`font-game text-[11px] text-right py-1.5 px-2 ${t.failed > 0 ? 'text-red-400' : 'text-px-text-dim'}`}>
                      {t.failed}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    )
  }

  // ─── 渲染 ─────────────────────────────────────────────────────────────────
  return (
    <div className="fixed inset-0 z-50 bg-px-bg flex flex-col">
      <PanelHeader
        title="工作台账"
        subtitle={avatarId}
        onClose={onClose}
      />

      <div className="flex items-center gap-1 px-3 py-2 bg-px-elevated border-b-2 border-px-border flex-shrink-0">
        {TABS.map(({ key, label }) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={`px-3 py-1 font-game text-[11px] tracking-wider border-2 ${
              tab === key
                ? 'border-px-primary bg-px-primary/15 text-px-text'
                : 'border-px-border text-px-text-dim'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-hidden bg-px-surface">
        {tab === 'memory' && renderMemoryTab()}
        {tab === 'conversations' && renderConversationsTab()}
        {tab === 'schedules' && renderSchedulesTab()}
        {tab === 'work' && renderWorkTab()}
      </div>
    </div>
  )
}
