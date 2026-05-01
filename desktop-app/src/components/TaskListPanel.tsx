/**
 * TaskListPanel: Agent 任务列表面板（像素风 checklist）。
 *
 * Stage 三 P2 #14 升级：
 *   - 顶部进度条（done/total，带百分比）
 *   - 按状态分组（in_progress / pending / completed / cancelled）每段可独立折叠
 *   - 每条任务下方展示已关联的工具调用（自动通过 attachToolCallToTask 挂载）
 *
 * 状态可视化：
 *   - pending      ☐ 灰色文字
 *   - in_progress  ▶ 主色 + 闪烁
 *   - completed    ☑ 绿色 + 删除线
 *   - cancelled    ✕ 暗色 + 删除线
 *
 * 默认行为：整个面板默认展开；进行中分组默认展开，其余默认折叠。
 * tasks 为空时不渲染任何内容（不占空间）。
 *
 * @author zhi.qu
 * @date 2026-04-29
 */

import { useState, useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useChatStore, type AgentTask, type AgentTaskToolCall } from '../stores/chatStore'
import { formatToolCallLabel } from '../lib/tool-name-map'

type TaskStatus = AgentTask['status']

/** 状态对应的图标字符（保持 ASCII / 简单 unicode，与像素风一致） */
const STATUS_GLYPH: Record<TaskStatus, string> = {
  pending: '☐',
  in_progress: '▶',
  completed: '☑',
  cancelled: '✕',
}

/** 状态对应的 tailwind class（颜色 + 字体修饰） */
const STATUS_CLASS: Record<TaskStatus, string> = {
  pending: 'text-px-text-dim',
  in_progress: 'text-px-primary animate-pulse',
  completed: 'text-px-success line-through opacity-70',
  cancelled: 'text-px-text-dim line-through opacity-50',
}

/** 状态在中文界面下的标签 */
const STATUS_LABEL: Record<TaskStatus, string> = {
  pending: '待执行',
  in_progress: '进行中',
  completed: '已完成',
  cancelled: '已取消',
}

/** 分组渲染顺序（in_progress 优先，cancelled 殿后） */
const STATUS_ORDER: readonly TaskStatus[] = ['in_progress', 'pending', 'completed', 'cancelled'] as const

interface TaskGroupProps {
  status: TaskStatus
  tasks: Array<{ task: AgentTask; index: number }>
  collapsed: boolean
  onToggle: () => void
}

/**
 * 单个状态分组渲染：标题栏（点击折叠）+ 任务列表 + 每条任务关联的工具调用。
 *
 * 之所以拆出独立组件而不是 inline，是为了 useState 在 collapsed 状态变化时
 * 只重渲染当前分组，不影响其他分组（特别是任务列表很长时的性能）。
 */
function TaskGroup({ status, tasks, collapsed, onToggle }: TaskGroupProps) {
  if (tasks.length === 0) return null

  return (
    <div className="border-t border-px-border-dim first:border-t-0">
      {/* 分组标题：状态名 + 计数 + 折叠箭头 */}
      <div
        className="flex items-center gap-2 px-3 py-1.5 cursor-pointer hover:bg-px-surface/30"
        onClick={onToggle}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onToggle() }}
        aria-label={collapsed ? `展开${STATUS_LABEL[status]}分组` : `折叠${STATUS_LABEL[status]}分组`}
      >
        <span className="font-game text-[10px] text-px-text-dim w-3">
          {collapsed ? '▸' : '▾'}
        </span>
        <span className={`font-game text-[11px] ${STATUS_CLASS[status]}`}>
          {STATUS_GLYPH[status]} {STATUS_LABEL[status]}
        </span>
        <span className="font-game text-[11px] text-px-text-dim">
          ({tasks.length})
        </span>
      </div>

      {/* 任务条目：折叠时不渲染 */}
      {!collapsed && (
        <ul className="px-3 pb-2 space-y-1">
          {tasks.map(({ task, index }) => (
            <li key={task.id} className="font-game text-[12px] leading-relaxed">
              {/* 任务行 */}
              <div className="flex items-start gap-2">
                <span
                  className={`shrink-0 w-4 ${STATUS_CLASS[task.status]}`}
                  aria-label={STATUS_LABEL[task.status]}
                  title={STATUS_LABEL[task.status]}
                >
                  {STATUS_GLYPH[task.status]}
                </span>
                <span className="shrink-0 text-px-text-dim w-6">
                  {String(index + 1).padStart(2, '0')}.
                </span>
                <span className={`flex-1 ${STATUS_CLASS[task.status]} break-words`}>
                  {task.content}
                </span>
              </div>

              {/* 关联的工具调用：缩进后展示，每条带成功/失败图标和耗时 */}
              {task.toolCalls && task.toolCalls.length > 0 && (
                <ul className="mt-0.5 ml-12 space-y-0.5">
                  {task.toolCalls.map((tc) => (
                    <ToolCallItem key={tc.id} call={tc} />
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/**
 * 工具调用单行渲染：状态图标 + 中文名 + 耗时。
 *
 * 失败用 ✗ + danger 色，成功用 ✓ + dim 色（不抢戏，让任务行本身保持视觉重点）。
 */
function ToolCallItem({ call }: { call: AgentTaskToolCall }) {
  const icon = call.ok ? '✓' : '✗'
  const colorClass = call.ok ? 'text-px-text-dim' : 'text-px-danger'
  return (
    <li
      className={`flex items-center gap-1.5 font-game text-[11px] ${colorClass}`}
      title={`tool_call_id: ${call.id}`}
    >
      <span className="w-3">{icon}</span>
      <span className="opacity-80">↳ {formatToolCallLabel(call.name, call.durationMs)}</span>
    </li>
  )
}

export default function TaskListPanel() {
  const { tasks, clearTasks, currentConversationId } = useChatStore(
    useShallow(s => ({
      tasks: s.tasks,
      clearTasks: s.clearTasks,
      currentConversationId: s.currentConversationId,
    }))
  )
  // 整面板的展开/折叠（点击 TASKS 标题切换）
  const [panelCollapsed, setPanelCollapsed] = useState(false)

  // 各分组独立的折叠状态：默认 in_progress 展开、其他折叠
  const [groupCollapsed, setGroupCollapsed] = useState<Record<TaskStatus, boolean>>({
    in_progress: false,
    pending: false,
    completed: true,
    cancelled: true,
  })

  // 进度统计 + 分组数据
  const { stats, grouped } = useMemo(() => {
    const total = tasks.filter(t => t.status !== 'cancelled').length
    const done = tasks.filter(t => t.status === 'completed').length
    const running = tasks.filter(t => t.status === 'in_progress').length
    const percent = total > 0 ? Math.round((done / total) * 100) : 0

    const groupedMap: Record<TaskStatus, Array<{ task: AgentTask; index: number }>> = {
      in_progress: [],
      pending: [],
      completed: [],
      cancelled: [],
    }
    tasks.forEach((task, index) => {
      groupedMap[task.status].push({ task, index })
    })

    return { stats: { total, done, running, percent }, grouped: groupedMap }
  }, [tasks])

  if (tasks.length === 0) return null

  return (
    <div className="mx-4 my-2 border-2 border-px-border bg-px-elevated">
      {/* 标题栏：进度概览 + 折叠/清空按钮 */}
      <div
        className="flex items-center justify-between px-3 py-2 border-b border-px-border-dim cursor-pointer hover:bg-px-surface/50"
        onClick={() => setPanelCollapsed(c => !c)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setPanelCollapsed(c => !c) }}
        aria-label={panelCollapsed ? '展开任务列表' : '折叠任务列表'}
      >
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <span className="font-game text-[11px] text-px-text-dim tracking-widest w-3">
            {panelCollapsed ? '▸' : '▾'}
          </span>
          <span className="font-game text-[12px] text-px-primary tracking-wider">
            TASKS
          </span>
          <span className="font-game text-[11px] text-px-text-sec">
            {stats.done} / {stats.total}
          </span>
          {stats.running > 0 && (
            <span className="font-game text-[11px] text-px-primary animate-pulse">
              · 进行中 {stats.running}
            </span>
          )}

          {/* 进度条：占据剩余空间，最大 200px */}
          <div className="flex items-center gap-1.5 ml-2 flex-1 max-w-[200px]">
            <div className="flex-1 h-1.5 bg-px-surface border border-px-border-dim relative">
              <div
                className="absolute inset-y-0 left-0 bg-px-primary transition-all duration-300"
                style={{ width: `${stats.percent}%` }}
                aria-label={`进度 ${stats.percent}%`}
              />
            </div>
            <span className="font-game text-[10px] text-px-text-dim w-9 text-right">
              {stats.percent}%
            </span>
          </div>
        </div>

        <div className="flex items-center gap-1 ml-2">
          {/* Stage 三 P2 范围外 2：spool 文件查看入口 */}
          {currentConversationId && (
            <button
              onClick={async (e) => {
                e.stopPropagation()
                try {
                  const r = await window.electronAPI.openToolResultsFolder(currentConversationId)
                  if (!r.success && r.error) {
                    window.electronAPI.logEvent('info', 'open-tool-results-folder', r.error)
                    // 用 Toast 提示更佳；这里临时用 alert（项目其他 toast 与 Modal 已有，但避免引入新依赖）
                    alert(r.error)
                  }
                } catch (err) {
                  const msg = err instanceof Error ? err.message : String(err)
                  console.warn('[TaskListPanel] open-tool-results 失败:', msg)
                }
              }}
              className="font-game text-[11px] text-px-text-dim hover:text-px-primary px-2"
              title="打开本会话的工具大返回值落盘目录"
              aria-label="查看工具结果"
            >
              📁 工具结果
            </button>
          )}
          <button
            onClick={(e) => { e.stopPropagation(); clearTasks() }}
            className="font-game text-[11px] text-px-text-dim hover:text-px-danger px-2"
            title="清空任务列表"
            aria-label="清空任务列表"
          >
            清空
          </button>
        </div>
      </div>

      {/* 分组列表：折叠时不渲染 */}
      {!panelCollapsed && (
        <div className="max-h-96 overflow-auto">
          {STATUS_ORDER.map((status) => (
            <TaskGroup
              key={status}
              status={status}
              tasks={grouped[status]}
              collapsed={groupCollapsed[status]}
              onToggle={() => setGroupCollapsed(prev => ({ ...prev, [status]: !prev[status] }))}
            />
          ))}
        </div>
      )}
    </div>
  )
}
