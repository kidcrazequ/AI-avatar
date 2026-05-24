/**
 * Context 引用面板：在 MessageInput 上方浮起，支持 @namespace/<entry> 引用语法。
 *
 * 两级结构：
 *   Level 1 — 选 namespace（@knowledge / @decision / @excel / @conversation / @web）
 *   Level 2 — 在该 namespace 下选具体 entry（文件路径 / 会话标题等）
 *
 * 受控组件：keyboard 由父组件（MessageInput）处理；本组件渲染 + 鼠标点选。
 *
 * @author zhi.qu
 * @date 2026-05-19
 */

import { useEffect, useRef } from 'react'

/** namespace 元信息：决定一级菜单展示和触发关键字 */
export interface ContextNamespace {
  /** 唯一标识，用作 @<key> 前缀 */
  key: 'knowledge' | 'decision' | 'excel' | 'conversation' | 'web'
  /** 一级菜单显示名 */
  label: string
  /** 一级菜单副标题 */
  description: string
  /** 中文别名（命中也算选中），可选 */
  aliases?: string[]
}

/** namespace 下的具体 entry */
export interface ContextEntry {
  /** 唯一标识（resolver 用来取内容） */
  id: string
  /** 显示标题 */
  title: string
  /** 副标题（路径 / 时间 / 摘要等） */
  subtitle?: string
  /** namespace */
  namespace: ContextNamespace['key']
}

interface Props {
  /** 当前级别：'namespace' 选大类，'entries' 选具体项 */
  level: 'namespace' | 'entries'
  /** Level 1：可选 namespace 列表（已按 query 前缀过滤） */
  namespaces: ContextNamespace[]
  /** Level 2：当前 namespace 下的 entry 列表（已按 query 过滤） */
  entries: ContextEntry[]
  /** 选中 namespace（Level 1）时高亮 */
  selectedNamespaceIndex: number
  /** 选中 entry（Level 2）时高亮 */
  selectedEntryIndex: number
  /** 已选定的 namespace（Level 2 状态时显示在头部） */
  activeNamespace?: ContextNamespace
  /** 选中 namespace 时回调 */
  onSelectNamespace: (ns: ContextNamespace) => void
  /** 选中 entry 时回调 */
  onSelectEntry: (entry: ContextEntry) => void
  /** 鼠标悬停同步高亮 */
  onHoverNamespace: (index: number) => void
  onHoverEntry: (index: number) => void
  /** Level 2 时返回 Level 1（点头部"← 返回"或按 Backspace） */
  onBack: () => void
  /** Entry 列表是否还在加载 */
  loading?: boolean
  /** conversation namespace 专用：要引用的最近消息条数（默认 30） */
  conversationMessageCount?: number
  /** conversation 消息数变化回调 */
  onChangeConversationMessageCount?: (n: number) => void
}

export default function ContextReferencePalette({
  level,
  namespaces,
  entries,
  selectedNamespaceIndex,
  selectedEntryIndex,
  activeNamespace,
  onSelectNamespace,
  onSelectEntry,
  onHoverNamespace,
  onHoverEntry,
  onBack,
  loading = false,
  conversationMessageCount,
  onChangeConversationMessageCount,
}: Props) {
  const showConvCountInput = level === 'entries' && activeNamespace?.key === 'conversation'
  const listRef = useRef<HTMLUListElement>(null)
  const selectedIndex = level === 'namespace' ? selectedNamespaceIndex : selectedEntryIndex

  useEffect(() => {
    const ul = listRef.current
    if (!ul) return
    const el = ul.querySelector<HTMLLIElement>(`li[data-index="${selectedIndex}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  return (
    <div
      role="listbox"
      aria-label="上下文引用"
      className="bg-px-surface border-2 border-px-border shadow-pixel-brand max-h-[320px] overflow-hidden flex flex-col"
    >
      <div className="px-3 py-1.5 border-b-2 border-px-border bg-px-elevated">
        {level === 'namespace' ? (
          <div className="font-game text-[10px] text-px-text-dim tracking-wider uppercase">
            引用类别 · ↑↓ 选择 · Enter/Tab 进入 · Esc 取消
          </div>
        ) : (
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <button
              type="button"
              onMouseDown={(e) => { e.preventDefault(); onBack() }}
              className="font-game text-[10px] text-px-text-dim hover:text-px-primary tracking-wider"
            >
              ← {activeNamespace?.label}
            </button>
            {showConvCountInput && onChangeConversationMessageCount && (
              <label className="flex items-center gap-1.5 font-game text-[10px] text-px-text-dim tracking-wider">
                最近
                <input
                  type="number"
                  min={10}
                  max={200}
                  step={10}
                  value={conversationMessageCount ?? 30}
                  onChange={(e) => {
                    const n = Number(e.target.value)
                    if (Number.isFinite(n)) onChangeConversationMessageCount(Math.max(10, Math.min(200, n)))
                  }}
                  onMouseDown={(e) => e.stopPropagation()}
                  className="w-14 bg-px-bg border border-px-border text-px-text px-1 py-0.5 font-mono text-[11px] focus:border-px-primary focus:outline-none"
                  title="引用最近 N 条消息（10-200）"
                />
                条消息
              </label>
            )}
            <div className="font-game text-[10px] text-px-text-dim tracking-wider">
              ↑↓ 选择 · Enter 确认 · Backspace 返回
            </div>
          </div>
        )}
      </div>

      {level === 'namespace' ? (
        <ul ref={listRef} className="overflow-y-auto flex-1">
          {namespaces.map((ns, index) => {
            const active = index === selectedNamespaceIndex
            return (
              <li
                key={ns.key}
                data-index={index}
                role="option"
                aria-selected={active}
                onMouseEnter={() => onHoverNamespace(index)}
                onMouseDown={(e) => { e.preventDefault(); onSelectNamespace(ns) }}
                className={`px-3 py-2 cursor-pointer border-b border-px-border/40 last:border-b-0
                  ${active ? 'bg-px-primary/10 border-l-2 border-l-px-primary' : 'hover:bg-px-elevated/60'}`}
              >
                <div className="font-game text-[12px] text-px-text tracking-wider">
                  @{ns.label}
                </div>
                <div className="font-game text-[10px] text-px-text-dim mt-0.5">
                  {ns.description}
                </div>
              </li>
            )
          })}
        </ul>
      ) : (
        <ul ref={listRef} className="overflow-y-auto flex-1">
          {loading && (
            <li className="px-3 py-3 font-game text-[11px] text-px-text-dim">加载中…</li>
          )}
          {!loading && entries.length === 0 && (
            <li className="px-3 py-3 font-game text-[11px] text-px-text-dim">
              没有匹配项（继续输入过滤或按 Backspace 返回）
            </li>
          )}
          {entries.map((entry, index) => {
            const active = index === selectedEntryIndex
            return (
              <li
                key={`${entry.namespace}:${entry.id}`}
                data-index={index}
                role="option"
                aria-selected={active}
                onMouseEnter={() => onHoverEntry(index)}
                onMouseDown={(e) => { e.preventDefault(); onSelectEntry(entry) }}
                className={`px-3 py-2 cursor-pointer border-b border-px-border/40 last:border-b-0
                  ${active ? 'bg-px-primary/10 border-l-2 border-l-px-primary' : 'hover:bg-px-elevated/60'}`}
              >
                <div className="font-game text-[12px] text-px-text tracking-wider truncate">
                  {entry.title}
                </div>
                {entry.subtitle && (
                  <div className="font-game text-[10px] text-px-text-dim mt-0.5 truncate">
                    {entry.subtitle}
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
