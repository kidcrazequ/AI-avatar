/**
 * Traces 调试面板（docs/staffdeck-adoption-plan.md W1.2）。
 *
 * 数据流（只读展示，不新增 IPC）：
 *   getConversations(avatarId) 选会话（默认最近一个）
 *   → getMessages(conversationId) 拿消息行（返回 SQLite 原始行，
 *     tool_call_timeline_json 为 v19 列的 JSON **字符串**，未在主进程解析）
 *   → 渲染层 JSON.parse（失败的消息按无时间线处理，不崩）
 *   → 映射为 TraceMessageInput[] → @soul/core/browser 的 aggregateTraceTurns
 *   → 每轮一张「摘要行 + 可折叠明细」卡片（借鉴 StaffDeck ExecutionRecord 形态）。
 *
 * kind 字符标识与颜色语义对齐 ToolCallTimeline（▷ tool / ⌕ rag / ★ skill / ⊘ skipped），
 * 不引入图标库。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import Modal from './shared/Modal'
import PanelHeader from './shared/PanelHeader'
import {
  aggregateTraceTurns,
  localDateString,
  type TraceMessageInput,
  type TraceTimelineEntry,
  type TraceTurn,
} from '@soul/core/browser'

interface Props {
  avatarId: string
  onClose: () => void
}

/**
 * 解析消息行的 tool_call_timeline_json（TEXT 列，存 ToolCallTimelineEntry[] 的 JSON 字符串）。
 * 解析失败 / 非数组 → null（该消息按无时间线处理）；数组内 null/非对象元素剔除，
 * 其余字段缺失由 aggregateTraceTurns 与渲染层的守卫兜底。
 */
function parseTimeline(json: string | null | undefined): TraceTimelineEntry[] | null {
  if (!json) return null
  try {
    const parsed: unknown = JSON.parse(json)
    if (!Array.isArray(parsed)) return null
    return parsed.filter((e): e is TraceTimelineEntry => typeof e === 'object' && e !== null)
  } catch {
    return null
  }
}

/** 耗时格式化（与 ToolCallTimeline 的 formatDuration 保持一致；其未导出，此处本地复制） */
function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0ms'
  if (ms < 1000) return `${Math.round(ms)}ms`
  const totalSec = ms / 1000
  if (totalSec < 60) return `${totalSec.toFixed(1)}s`
  const minutes = Math.floor(totalSec / 60)
  const seconds = totalSec - minutes * 60
  return `${minutes}m ${seconds.toFixed(1)}s`
}

/** 轮次时间：本地时分秒；startedAt 缺失（聚合层回退到 0）时显示占位符 */
function formatTurnTime(startedAt: number): string {
  if (!Number.isFinite(startedAt) || startedAt <= 0) return '--:--:--'
  return new Date(startedAt).toLocaleTimeString('zh-CN', { hour12: false })
}

/** kind → 字符标识与颜色（与 ToolCallTimeline 的视觉语义一致；缺省视为 tool） */
function kindGlyph(kind: TraceTimelineEntry['kind']): { glyph: string; cls: string } {
  switch (kind) {
    case 'rag':
      return { glyph: '⌕', cls: 'text-px-accent' }
    case 'skill':
      return { glyph: '★', cls: 'text-px-success' }
    default:
      return { glyph: '▷', cls: 'text-px-primary' }
  }
}

/** 摘要计数：「N 工具 / M 检索 / K 技能」，为 0 的段省略；全部被守卫跳过时如实说明 */
function countsLabel(turn: TraceTurn): string {
  const parts: string[] = []
  if (turn.toolCount > 0) parts.push(`${turn.toolCount} 工具`)
  if (turn.ragCount > 0) parts.push(`${turn.ragCount} 检索`)
  if (turn.skillCount > 0) parts.push(`${turn.skillCount} 技能`)
  return parts.length > 0 ? parts.join(' / ') : '全部条目已跳过'
}

/** 明细一行：kind 标识 + 名称 + 耗时 + 状态；args/result 预览折叠在 details 内 */
function TraceEntryRow({ entry }: { entry: TraceTimelineEntry }) {
  const { glyph, cls } = kindGlyph(entry.kind)
  const skipped = entry.skipped === true
  const hasPreview = Boolean(entry.argsPreview || entry.resultPreview)
  return (
    <div className={skipped ? 'opacity-50' : ''}>
      <div className="flex items-center gap-2 text-[11px] min-w-0">
        <span className={`font-game shrink-0 ${skipped ? 'text-px-text-dim' : cls}`}>
          {skipped ? '⊘' : glyph}
        </span>
        <span className="font-mono text-px-text truncate min-w-0">{entry.name}</span>
        <span className="font-mono text-px-text-dim shrink-0">{formatDuration(entry.durationMs)}</span>
        <span className={`shrink-0 ${skipped ? 'text-px-text-dim' : entry.ok ? 'text-px-success' : 'text-px-danger'}`}>
          {skipped ? '已跳过' : entry.ok ? '✓' : '✗ 失败'}
        </span>
      </div>
      {hasPreview && (
        <details className="ml-5 mt-0.5">
          <summary className="text-[10px] text-px-text-dim cursor-pointer select-none">
            参数 / 结果预览
          </summary>
          {entry.argsPreview && (
            <div className="mt-1 px-2 py-1 border border-px-border bg-px-bg font-mono text-[10px] text-px-text-sec whitespace-pre-wrap break-all">
              args: {entry.argsPreview}
            </div>
          )}
          {entry.resultPreview && (
            <div className="mt-1 px-2 py-1 border border-px-border bg-px-bg font-mono text-[10px] text-px-text-sec whitespace-pre-wrap break-all">
              result: {entry.resultPreview}
            </div>
          )}
        </details>
      )}
    </div>
  )
}

export default function TracesPanel({ avatarId, onClose }: Props) {
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [convLoading, setConvLoading] = useState(true)
  const [convError, setConvError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  /** 轨迹结果按会话 id 键控：loading 态由「已加载 id ≠ 当前选中 id」推导，避免 effect 内同步 setState */
  const [loaded, setLoaded] = useState<{ convId: string; turns: TraceTurn[] } | null>(null)
  const [turnsError, setTurnsError] = useState<{ convId: string; message: string } | null>(null)
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(new Set())

  // 竞态防护：会话列表 / 轨迹加载各持序号，过期响应直接丢弃
  const convSeqRef = useRef(0)
  const msgSeqRef = useRef(0)

  // 加载会话列表（主进程按 updated_at 降序返回，默认选最近一个）
  useEffect(() => {
    const seq = ++convSeqRef.current
    const load = async (): Promise<void> => {
      try {
        const list = await window.electronAPI.getConversations(avatarId)
        if (seq !== convSeqRef.current) return
        setConversations(list)
        setSelectedId(list.length > 0 ? list[0].id : null)
        setConvError(null)
      } catch (e) {
        if (seq !== convSeqRef.current) return
        setConvError(e instanceof Error ? e.message : String(e))
      } finally {
        if (seq === convSeqRef.current) setConvLoading(false)
      }
    }
    void load()
  }, [avatarId])

  // 加载选中会话的消息并聚合成轮次轨迹
  useEffect(() => {
    if (!selectedId) return
    const convId = selectedId
    const seq = ++msgSeqRef.current
    const load = async (): Promise<void> => {
      try {
        const msgs = await window.electronAPI.getMessages(convId)
        if (seq !== msgSeqRef.current) return
        const inputs: TraceMessageInput[] = msgs.map((m) => ({
          id: m.id,
          role: m.role,
          createdAt: m.created_at,
          toolCallTimeline: parseTimeline(m.tool_call_timeline_json),
        }))
        setLoaded({ convId, turns: aggregateTraceTurns(inputs) })
        setTurnsError(null)
      } catch (e) {
        if (seq !== msgSeqRef.current) return
        setTurnsError({ convId, message: e instanceof Error ? e.message : String(e) })
      }
    }
    void load()
  }, [selectedId])

  const toggleTurn = useCallback((turnId: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev)
      if (next.has(turnId)) next.delete(turnId)
      else next.add(turnId)
      return next
    })
  }, [])

  // 主区内容：错误 > 加载中 > 无会话 > 无轨迹 > 轮次卡片
  const renderBody = () => {
    if (convError) {
      return <div className="text-[12px] text-px-danger">加载会话列表失败：{convError}</div>
    }
    if (convLoading) {
      return <div className="text-[12px] text-px-text-dim">加载会话列表中...</div>
    }
    if (conversations.length === 0 || !selectedId) {
      return <div className="text-[12px] text-px-text-dim">该分身还没有会话。</div>
    }
    if (turnsError && turnsError.convId === selectedId) {
      return <div className="text-[12px] text-px-danger">加载轨迹失败：{turnsError.message}</div>
    }
    if (!loaded || loaded.convId !== selectedId) {
      return <div className="text-[12px] text-px-text-dim">加载轨迹中...</div>
    }
    if (loaded.turns.length === 0) {
      // 用户红线：宁可明确说无，不放骨架屏/假占位
      return (
        <div className="text-[12px] text-px-text-dim border border-px-border bg-px-surface px-3 py-2">
          该会话没有已持久化的工具轨迹（旧会话或纯文本轮次）。
        </div>
      )
    }
    return loaded.turns.map((turn) => {
      const isOpen = expandedIds.has(turn.turnId)
      const timeTitle =
        turn.startedAt > 0
          ? `${localDateString(new Date(turn.startedAt))} ${formatTurnTime(turn.startedAt)}`
          : '起始时间未知'
      return (
        <div key={turn.turnId} className="border border-px-border bg-px-surface">
          {/* 摘要行：时间 + 计数 + 总耗时 + 失败数，点击展开明细 */}
          <button
            type="button"
            onClick={() => toggleTurn(turn.turnId)}
            className="w-full flex items-center gap-3 px-3 py-2 text-left hover:bg-px-elevated min-w-0"
          >
            <span className="text-[11px] text-px-text-dim shrink-0">{isOpen ? '▾' : '▸'}</span>
            <span className="font-mono text-[11px] text-px-text-sec shrink-0" title={timeTitle}>
              {formatTurnTime(turn.startedAt)}
            </span>
            <span className="text-[11px] text-px-text flex-1 truncate min-w-0">{countsLabel(turn)}</span>
            <span className="font-mono text-[11px] text-px-text-dim shrink-0">
              {formatDuration(turn.totalDurationMs)}
            </span>
            {turn.failedCount > 0 && (
              <span className="font-game text-[11px] text-px-danger shrink-0">✗ {turn.failedCount} 失败</span>
            )}
          </button>
          {isOpen && (
            <div className="border-t border-px-border px-3 py-2 space-y-1.5">
              {turn.entries.map((entry, i) => (
                <TraceEntryRow key={entry.id || `${turn.turnId}-${i}`} entry={entry} />
              ))}
            </div>
          )}
        </div>
      )
    })
  }

  return (
    <Modal isOpen={true} onClose={onClose} size="md">
      <PanelHeader title="TRACES" subtitle={`${avatarId} · 执行轨迹`} onClose={onClose} />
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* 会话选择（updated_at 降序，默认最近一个） */}
        <div className="flex items-center gap-2 px-4 py-2 bg-px-elevated border-b-2 border-px-border">
          <span className="font-game text-[12px] text-px-text-dim shrink-0">会话</span>
          <select
            className="flex-1 min-w-0 border border-px-border bg-px-bg text-px-text text-[12px] px-2 py-1"
            value={selectedId ?? ''}
            onChange={(e) => setSelectedId(e.target.value || null)}
            disabled={conversations.length === 0}
          >
            {conversations.map((c) => (
              <option key={c.id} value={c.id}>
                {(c.title || '未命名会话') + ' · ' + localDateString(new Date(c.updated_at))}
              </option>
            ))}
          </select>
        </div>
        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-2">{renderBody()}</div>
      </div>
    </Modal>
  )
}
