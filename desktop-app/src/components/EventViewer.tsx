/**
 * EventViewer：会话 JSONL 事件日志的查看器（v17 引入，2026-05-17）。
 *
 * 入口：ChatWindow 顶栏「事件」按钮，对当前 conversationId 打开本面板。
 * 数据：window.electronAPI.readConversationEvents → 主进程 reader 解析 JSONL。
 *
 * 显示策略：
 *   - 时间戳（HH:mm:ss）左对齐
 *   - type 用颜色徽章区分
 *   - per-type 渲染一行摘要（不展开正文）
 *   - 顶部 chip 过滤；点击 ALL 重置
 *   - 损坏行数显示在副标题
 *   - 空状态友好提示（v17 前的旧会话从未写入过 JSONL）
 *
 * @author zhi.qu
 * @date 2026-05-17
 */

import { useEffect, useMemo, useState } from 'react'
import Modal from './shared/Modal'
import PanelHeader from './shared/PanelHeader'

interface Props {
  conversationId: string
  isOpen: boolean
  onClose: () => void
}

type EventType = ConversationJsonlAnyEvent['type']
type FilterValue = EventType | 'all'

/** 过滤条目顺序——保留事件首次出现的语义顺序，all 永远在前 */
const FILTER_ORDER: Array<{ value: FilterValue; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'conversation_started', label: '会话起点' },
  { value: 'message', label: '消息' },
  { value: 'memory_update', label: '记忆更新' },
  { value: 'model_switch', label: '模型切换' },
  { value: 'mode_switch', label: '模式切换' },
  { value: 'sub_agent_task', label: '子分身派发' },
]

/** type → 徽章 className（用现有 px-* 色票，不引入新色） */
const TYPE_BADGE_CLS: Record<EventType, string> = {
  conversation_started: 'text-px-primary border-px-primary',
  message: 'text-px-text-sec border-px-border',
  memory_update: 'text-px-warning border-px-warning',
  model_switch: 'text-px-accent border-px-accent',
  mode_switch: 'text-px-accent border-px-accent',
  sub_agent_task: 'text-px-warning border-px-warning',
}

const TYPE_LABEL: Record<EventType, string> = {
  conversation_started: '会话起点',
  message: '消息',
  memory_update: '记忆更新',
  model_switch: '模型切换',
  mode_switch: '模式切换',
  sub_agent_task: '子分身',
}

/** sub_agent_task 状态独立色票（覆盖 default） */
const SUB_STATUS_CLS: Record<JsonlEventSubAgentTask['status'], string> = {
  running: 'text-px-primary border-px-primary',
  done: 'text-px-text-sec border-px-border',
  error: 'text-px-danger border-px-danger',
  lost: 'text-px-danger border-px-danger',
  denied: 'text-px-warning border-px-warning',
}

function truncate(s: string, n: number): string {
  if (!s) return ''
  return s.length > n ? s.slice(0, n) + '…' : s
}

function formatTs(ts: number): string {
  const d = new Date(ts)
  const pad = (x: number) => String(x).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/**
 * 把单条事件渲染成一行摘要（不展开正文）。
 * 切回 default 分支只为兜底——TS 已用 never 卡过；此处保留是为运行时 schema 漂移防御。
 */
function renderSummary(ev: ConversationJsonlAnyEvent): string {
  switch (ev.type) {
    case 'conversation_started':
      return `avatar=${ev.avatarId} · project=${ev.projectId} · "${truncate(ev.title, 60)}"`
    case 'message':
      return `${ev.role} · ${truncate(ev.content, 100)}`
    case 'memory_update':
      return `${ev.updateCount} 条${ev.consolidated ? ' · 已整理' : ''} · ${truncate(ev.summaryPreview, 80)} · ${ev.totalByteSize}B`
    case 'model_switch':
      return `${ev.fromModel ?? '默认'} → ${ev.toModel ?? '默认'}`
    case 'mode_switch':
      return `${ev.fromMode} → ${ev.toMode}`
    case 'sub_agent_task': {
      const who = ev.targetAvatar ? `→ ${ev.targetAvatar}` : '(self)'
      const errTail = ev.error ? ` · ${truncate(ev.error, 60)}` : ''
      const denyTail = ev.denyReason ? ` · ${truncate(ev.denyReason, 60)}` : ''
      return `${who} · ${truncate(ev.taskPreview, 60)}${errTail}${denyTail}`
    }
  }
}

export default function EventViewer({ conversationId, isOpen, onClose }: Props) {
  const [loading, setLoading] = useState(false)
  const [data, setData] = useState<ReadEventsResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<FilterValue>('all')

  // 打开时加载一次；conversationId 变化也重载
  useEffect(() => {
    if (!isOpen) return
    let cancelled = false
    setLoading(true)
    setError(null)
    window.electronAPI.readConversationEvents(conversationId)
      .then((r) => {
        if (cancelled) return
        setData(r)
      })
      .catch((e) => {
        if (cancelled) return
        setError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        if (cancelled) return
        setLoading(false)
      })
    return () => { cancelled = true }
  }, [isOpen, conversationId])

  const filtered = useMemo(() => {
    if (!data) return []
    if (filter === 'all') return data.events
    return data.events.filter((e) => e.type === filter)
  }, [data, filter])

  const subtitle = (() => {
    if (loading) return '加载中...'
    if (error) return `加载失败: ${error}`
    if (!data) return ''
    const total = data.events.length
    const errs = data.parseErrors > 0 ? ` · ${data.parseErrors} 损坏` : ''
    return `${conversationId} · ${total} 条事件${errs}`
  })()

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="lg">
      <PanelHeader title="事件日志" subtitle={subtitle} onClose={onClose} />

      {/* 过滤 chips */}
      <div className="flex flex-wrap items-center gap-2 px-6 py-3 border-b border-px-border-dim bg-px-bg flex-shrink-0">
        {FILTER_ORDER.map((opt) => {
          const active = filter === opt.value
          return (
            <button
              key={opt.value}
              onClick={() => setFilter(opt.value)}
              className={`font-game text-[11px] px-2 py-0.5 border tracking-widest ${
                active
                  ? 'text-px-primary border-px-primary'
                  : 'text-px-text-dim border-px-border hover:text-px-text-sec'
              }`}
            >
              {opt.label}
            </button>
          )
        })}
      </div>

      {/* 事件列表 */}
      <div className="flex-1 overflow-auto px-6 py-3 bg-px-surface">
        {!loading && !error && filtered.length === 0 && (
          <div className="font-game text-[12px] text-px-text-dim tracking-wider py-8 text-center">
            {data && data.events.length === 0
              ? '暂无事件（v17 之前创建的会话不会有 JSONL，本面板仅展示新事件流）'
              : '当前过滤下无事件'}
          </div>
        )}
        {filtered.map((ev, idx) => {
          const badgeCls =
            ev.type === 'sub_agent_task'
              ? SUB_STATUS_CLS[ev.status]
              : TYPE_BADGE_CLS[ev.type]
          const badgeLabel =
            ev.type === 'sub_agent_task' ? `子分身 ${ev.status}` : TYPE_LABEL[ev.type]
          return (
            <div
              key={`${ev.ts}-${idx}`}
              className="flex items-start gap-3 py-1.5 border-b border-px-border-dim/40 font-mono text-[12px]"
            >
              <span className="text-px-text-dim shrink-0 w-16">{formatTs(ev.ts)}</span>
              <span
                className={`shrink-0 px-1.5 py-0 border font-game text-[10px] tracking-widest ${badgeCls}`}
              >
                {badgeLabel}
              </span>
              <span className="text-px-text-sec break-all">{renderSummary(ev)}</span>
            </div>
          )
        })}
      </div>
    </Modal>
  )
}
