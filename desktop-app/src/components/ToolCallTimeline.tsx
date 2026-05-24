/**
 * ToolCallTimeline: 仿 Cursor IDE 的"工具调用时间线"组件。
 *
 * 在 ChatWindow 顶部按时序展示当前轮次（或最近一次回答）里所有的工具调用：
 *
 *   ▷ 检索知识库   · search_knowledge   · 312ms ✓
 *   ▷ 读取知识文件 · read_knowledge_file · 87ms ✓
 *   ▷ 生成图片     · generate_image     · 2.3s ✗
 *
 * 每行可点击展开，查看 args 和 result 的摘要（已被 store 截短到固定字数）。
 * 当 isLoading 为 true 时，会在末尾追加一行"思考中... · X.Xs"占位
 * （三点跳动动画与 ChatWindow.tsx L401-406 的写法保持视觉一致）。
 *
 * 设计取舍：
 *   1. 单行 <TimelineRow> 抽出独立组件并 memo()，避免某行展开/收起时整列重渲。
 *   2. 用 useState 自管理 expanded 状态而非 <details>，因为 <details> 在 Tailwind
 *      下定制三角箭头样式比较麻烦，且像素风需要 ▸/▾ 而非默认箭头。
 *   3. 失败色用 text-px-warning（项目 Tailwind 主题没有 px-error；px-danger
 *      虽然存在，但 user spec 要求"优先用 px-warning"，遵循之）。
 *   4. entries 通常 < 20 条，不引入 react-virtuoso，普通滚动列表即可。
 *
 * @author zhi.qu
 * @date 2026-05-05
 */

import { memo, useState, useCallback } from 'react'
import { TOOL_NAME_MAP } from '../lib/tool-name-map'
import type { ToolCallTimelineEntry } from '../stores/chatStore'

/**
 * 把毫秒时长格式化为人类可读字符串。
 *
 *   < 1000ms       → "312ms"
 *   1s – 59.95s    → "1.2s"（保留 1 位小数）
 *   ≥ 60s          → "1m 24.1s"（分 + 秒，2026-05-21 用户反馈：超过 1 分的纯秒数读起来累）
 *
 * @param ms 工具调用耗时（毫秒）
 * @returns 格式化后的字符串
 */
function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0ms'
  if (ms < 1000) return `${Math.round(ms)}ms`
  const totalSec = ms / 1000
  if (totalSec < 60) return `${totalSec.toFixed(1)}s`
  const minutes = Math.floor(totalSec / 60)
  const seconds = totalSec - minutes * 60
  return `${minutes}m ${seconds.toFixed(1)}s`
}

/**
 * 秒为单位的"已经过时间"格式化（用于直播态"思考中..."占位行）。
 *
 *   < 60s   → "44.1s"
 *   ≥ 60s   → "1m 24.1s"
 */
function formatElapsedSec(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '0s'
  if (sec < 60) return `${sec.toFixed(1)}s`
  const minutes = Math.floor(sec / 60)
  const seconds = sec - minutes * 60
  return `${minutes}m ${seconds.toFixed(1)}s`
}

/** 单行 props（仅给内部 TimelineRow 用） */
interface TimelineRowProps {
  entry: ToolCallTimelineEntry
}

/**
 * 按 kind 决定行首前缀字符 + 颜色 class。
 *
 *   tool  ▷ 主色（默认，向后兼容旧条目无 kind 字段）
 *   rag   ⌕ 强调色（次于主色，与 tool 区分）
 *   skill ★ 成功色（命中 skill 是积极信号）
 */
function getKindGlyph(kind: ToolCallTimelineEntry['kind']): { glyph: string; cls: string } {
  switch (kind) {
    case 'rag':
      return { glyph: '⌕', cls: 'text-px-accent' }
    case 'skill':
      return { glyph: '★', cls: 'text-px-success' }
    case 'tool':
    case undefined:
    default:
      return { glyph: '▷', cls: 'text-px-primary' }
  }
}

/**
 * 按 kind 决定主标签文本：
 *   tool  → 优先 TOOL_NAME_MAP 中文名，没有就用工具原名
 *   rag/skill → 优先 argsPreview（主进程已传中文 detail），fallback 到 name
 */
function getDisplayName(entry: ToolCallTimelineEntry): string {
  if (entry.kind === 'rag' || entry.kind === 'skill') {
    return entry.argsPreview || entry.name
  }
  return TOOL_NAME_MAP[entry.name] ?? entry.name
}

/**
 * 单条工具调用行：折叠态显示一行摘要，展开后显示 args / result 两段详情。
 *
 * 拆出独立组件 + memo 的目的是：
 *   - 父组件 re-render（如父列表追加新条目）时，未展开的旧行不必重新渲染。
 *   - 单行内部的 expanded 状态变化也只重渲自己。
 */
const TimelineRow = memo(function TimelineRow({ entry }: TimelineRowProps) {
  const [expanded, setExpanded] = useState(false)
  const toggle = useCallback(() => setExpanded(v => !v), [])

  const cnName = getDisplayName(entry)
  const { glyph: kindGlyph, cls: kindCls } = getKindGlyph(entry.kind)
  // v19 (2026-05-21)：skipped（守卫主动拦截）与 ok=false（真错误）视觉分离：
  //   ⊘ 中性灰  = 已跳过（如 load_skill 重复加载、达到次数上限）
  //   ✓ 成功色  = 正常执行
  //   ✗ 警告色  = 真错误（IPC 失败 / 工具内部异常）
  const okGlyph = entry.skipped ? '⊘' : entry.ok ? '✓' : '✗'
  const okClass = entry.skipped
    ? 'text-px-text-dim'
    : entry.ok ? 'text-px-success' : 'text-px-warning'
  const okLabel = entry.skipped ? '已跳过' : entry.ok ? '成功' : '失败'
  const duration = formatDuration(entry.durationMs)

  // rag/skill 条目展开后只显示 args（resultPreview 通常为空，显示也无意义）
  // tool 条目按原逻辑：args 或 result 任一非空即可展开
  const isRagOrSkill = entry.kind === 'rag' || entry.kind === 'skill'
  // rag/skill 的 argsPreview 已经显示在主标签里，不需要再展开
  const hasDetail = isRagOrSkill ? false : (entry.argsPreview.length > 0 || entry.resultPreview.length > 0)

  return (
    <li className="border-b border-px-border-dim/40 last:border-b-0">
      {/* 折叠态行 */}
      <div
        className={`flex items-center gap-2 py-1 ${hasDetail ? 'cursor-pointer hover:bg-px-hover/30' : ''}`}
        onClick={hasDetail ? toggle : undefined}
        role={hasDetail ? 'button' : undefined}
        tabIndex={hasDetail ? 0 : -1}
        aria-expanded={hasDetail ? expanded : undefined}
        aria-label={hasDetail ? (expanded ? `折叠 ${cnName} 详情` : `展开 ${cnName} 详情`) : undefined}
        onKeyDown={(e) => {
          if (!hasDetail) return
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            toggle()
          }
        }}
        title={isRagOrSkill ? entry.name : `tool_call_id: ${entry.id}`}
      >
        {/* 行首种类前缀：tool ▷ / rag ⌕ / skill ★（替代原折叠箭头位置） */}
        <span className={`font-game text-[12px] w-3 shrink-0 ${kindCls}`} aria-hidden="true">
          {hasDetail ? (expanded ? '▾' : kindGlyph) : kindGlyph}
        </span>

        {/* 中文工具名 / RAG 阶段中文 / Skill 中文（主标签） */}
        <span className="font-game text-[12px] tracking-wider text-px-text-sec shrink-0">
          {cnName}
        </span>

        <span className="font-game text-[11px] text-px-text-dim shrink-0">·</span>

        {/* 英文原名（工具名 / phase / skill id），等宽小号灰色 */}
        <span className="font-mono text-[11px] text-px-text-dim truncate min-w-0 flex-shrink">
          {entry.name}
        </span>

        <span className="font-game text-[11px] text-px-text-dim shrink-0">·</span>

        {/* 耗时 */}
        <span className="font-mono text-[11px] text-px-text-dim shrink-0">
          {duration}
        </span>

        {/* 成功/失败/已跳过 状态符号 */}
        <span className={`font-game text-[12px] shrink-0 ${okClass}`} aria-label={okLabel}>
          {okGlyph}
        </span>
      </div>

      {/* 展开态详情：args + result */}
      {expanded && hasDetail && (
        <div className="pb-1.5 pl-5 pr-1 space-y-1">
          {entry.argsPreview.length > 0 && (
            <div className="font-mono text-[11px] text-px-text-dim leading-snug break-words whitespace-pre-wrap">
              <span className="text-px-text-sec">args:</span> {entry.argsPreview}
            </div>
          )}
          {entry.resultPreview.length > 0 && (
            <div className="font-mono text-[11px] text-px-text-dim leading-snug break-words whitespace-pre-wrap">
              <span className="text-px-text-sec">result:</span> {entry.resultPreview}
            </div>
          )}
        </div>
      )}
    </li>
  )
})

/**
 * "思考中..." 占位行：复刻 ChatWindow.tsx L401-406 的三点跳动动画。
 *
 * 单独抽出避免污染 TimelineRow 的 props 类型（loading 行没有 entry）。
 */
const ThinkingRow = memo(function ThinkingRow({ elapsedSec }: { elapsedSec?: number }) {
  return (
    <li className="flex items-center gap-2 py-1">
      <span className="w-3 shrink-0" aria-hidden="true" />
      {/* 三点跳动：与 ChatWindow 原占位完全一致的写法 */}
      <div className="flex items-center gap-0.5 shrink-0">
        <div
          className="w-1.5 h-1.5 rounded-full bg-px-primary animate-bounce"
          style={{ animationDelay: '0ms', animationDuration: '1s' }}
        />
        <div
          className="w-1.5 h-1.5 rounded-full bg-px-primary animate-bounce"
          style={{ animationDelay: '150ms', animationDuration: '1s' }}
        />
        <div
          className="w-1.5 h-1.5 rounded-full bg-px-primary animate-bounce"
          style={{ animationDelay: '300ms', animationDuration: '1s' }}
        />
      </div>
      <span className="font-game text-[12px] tracking-wider text-px-text-sec">
        思考中...
        {typeof elapsedSec === 'number' && Number.isFinite(elapsedSec) && (
          <span className="ml-1 font-mono text-[11px] text-px-text-dim">
            · {formatElapsedSec(elapsedSec)}
          </span>
        )}
      </span>
    </li>
  )
})

/** ToolCallTimeline 组件 props */
export interface ToolCallTimelineProps {
  /** 时间线条目（按时间顺序追加，最新的在数组末尾） */
  entries: ToolCallTimelineEntry[]
  /** 当前是否正在生成（用于在末尾追加一行"思考中..."占位） */
  isLoading: boolean
  /** 已耗时（秒），由父组件传入；用于"思考中..."旁的进度感知 */
  elapsedSec?: number
}

/**
 * 工具调用时间线（默认导出）。
 *
 * 显示规则：
 *   1. entries 为空且 !isLoading → 返回 null，整个组件不占位
 *   2. entries 为空但 isLoading → 仅渲染一行"思考中..."占位
 *   3. entries 非空 → 滚动列表 + （isLoading 时）末尾追加"思考中..."
 *
 * 父组件用法：
 *   ```tsx
 *   <ToolCallTimeline
 *     entries={toolCallTimeline}
 *     isLoading={isLoading}
 *     elapsedSec={elapsedSec}
 *   />
 *   ```
 */
function ToolCallTimelineImpl({ entries, isLoading, elapsedSec }: ToolCallTimelineProps) {
  // 折叠状态：本地维护，不持久化（用户每次重启桌面端都默认展开）
  // 切换会话时 ChatWindow 不会卸载本组件，故折叠态会跨会话保留，符合"操作即偏好"的直觉
  const [collapsed, setCollapsed] = useState(false)
  const toggleCollapsed = useCallback(() => setCollapsed(v => !v), [])

  // 规则：空 + 非加载态，整个组件不渲染
  if (entries.length === 0 && !isLoading) return null

  const total = entries.length
  // v19：守卫拦截（skipped）不计入"失败"汇总——拦截是预期行为，不该让用户以为出错。
  const failedCount = entries.reduce((acc, e) => acc + (!e.ok && !e.skipped ? 1 : 0), 0)
  const skippedCount = entries.reduce((acc, e) => acc + (e.skipped ? 1 : 0), 0)

  return (
    <div className="px-6 py-2 bg-px-surface border-t-2 border-px-border">
      {/* 标题栏：统计 + 折叠按钮（整行可点击） */}
      <div
        className="flex items-center gap-2 py-0.5 cursor-pointer hover:bg-px-hover/30"
        onClick={toggleCollapsed}
        role="button"
        tabIndex={0}
        aria-expanded={!collapsed}
        aria-label={collapsed ? '展开工具调用时间线' : '折叠工具调用时间线'}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            toggleCollapsed()
          }
        }}
      >
        <span className="font-game text-[11px] text-px-text-dim w-3 shrink-0" aria-hidden="true">
          {collapsed ? '▸' : '▾'}
        </span>
        <span className="font-game text-[11px] tracking-wider text-px-text-dim">
          工具调用时间线 · {total} 步
        </span>
        {failedCount > 0 && (
          <span className="font-game text-[11px] tracking-wider text-px-warning" aria-label={`其中 ${failedCount} 步失败`}>
            · {failedCount} 失败
          </span>
        )}
        {skippedCount > 0 && (
          <span className="font-game text-[11px] tracking-wider text-px-text-dim" aria-label={`其中 ${skippedCount} 步已跳过`}>
            · {skippedCount} 已跳过
          </span>
        )}
        {/* 折叠时把活动指示挪到标题栏右侧，避免用户误以为"卡住了" */}
        {collapsed && isLoading && (
          <span className="ml-auto flex items-center gap-1.5 shrink-0">
            <span className="flex items-center gap-0.5">
              <span className="w-1 h-1 rounded-full bg-px-primary animate-bounce" style={{ animationDelay: '0ms', animationDuration: '1s' }} />
              <span className="w-1 h-1 rounded-full bg-px-primary animate-bounce" style={{ animationDelay: '150ms', animationDuration: '1s' }} />
              <span className="w-1 h-1 rounded-full bg-px-primary animate-bounce" style={{ animationDelay: '300ms', animationDuration: '1s' }} />
            </span>
            <span className="font-game text-[11px] tracking-wider text-px-text-sec">
              思考中...
              {typeof elapsedSec === 'number' && Number.isFinite(elapsedSec) && (
                <span className="ml-1 font-mono text-[11px] text-px-text-dim">
                  · {formatElapsedSec(elapsedSec)}
                </span>
              )}
            </span>
          </span>
        )}
      </div>

      {/* 列表本体：折叠态完全隐藏（不只是 max-h:0，节省 DOM） */}
      {!collapsed && (
        <ul
          className="max-h-60 overflow-auto mt-0.5"
          role="list"
          aria-label="工具调用时间线"
        >
          {entries.map((entry) => (
            <TimelineRow key={entry.id} entry={entry} />
          ))}
          {isLoading && <ThinkingRow elapsedSec={elapsedSec} />}
        </ul>
      )}
    </div>
  )
}

/**
 * memo 化后的默认导出。
 *
 * 父组件每次输入新字符或定时器 tick 都会触发 ChatWindow re-render，
 * 但只要 entries 引用 / isLoading / elapsedSec 不变，时间线就不会重渲。
 */
const ToolCallTimeline = memo(ToolCallTimelineImpl)
export default ToolCallTimeline
