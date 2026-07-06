/**
 * Slash 命令面板：在 MessageInput 上方浮起，列出当前分身已启用的技能。
 *
 * 受控组件：keyboard 由父组件（MessageInput）统一处理，本组件只负责渲染 + 鼠标选择。
 *
 * 数据源：window.electronAPI.getSkills(avatarId) 已有 IPC，本组件不直接拉数据，
 *        由父组件提供过滤后的 items，避免在每次按键时重新 IPC。
 *
 * @author zhi.qu
 * @date 2026-05-19
 */

import { useEffect, useRef } from 'react'

/** Palette 接受的最小技能信息（从 Skill 类型抽出展示需要的字段） */
export interface SlashCommandItem {
  /** skill name（小写连字符），用作 `/<name>` 插入文本 */
  name: string
  /** description（first line / 截断），用于副标题展示 */
  description: string
  /** 来源标签：local / shared / community；用于右侧 chip */
  source?: 'local' | 'shared' | 'community'
}

interface Props {
  /** 候选项（已按 query 过滤、按 source 优先级排序） */
  items: SlashCommandItem[]
  /** 当前高亮的索引；超出范围则不高亮 */
  selectedIndex: number
  /** 鼠标点击 / Enter 选中时回调 */
  onSelect: (item: SlashCommandItem) => void
  /** 鼠标悬停时同步索引（与键盘高亮统一） */
  onHoverIndex: (index: number) => void
  /**
   * 「运行」动作（工作流技能·入口 3）：直接以固定模板发送执行指令，
   * 不走 onSelect 的"插入 /名字 "路径。未传时不渲染运行按钮。
   */
  onRun?: (item: SlashCommandItem) => void
}

const SOURCE_LABEL: Record<NonNullable<SlashCommandItem['source']>, string> = {
  local: '本地',
  shared: '公共',
  community: '社区',
}

export default function SlashCommandPalette({ items, selectedIndex, onSelect, onHoverIndex, onRun }: Props) {
  const listRef = useRef<HTMLUListElement>(null)

  // 选中项滚入视口（键盘上下移动时跟随）
  useEffect(() => {
    const ul = listRef.current
    if (!ul) return
    const el = ul.querySelector<HTMLLIElement>(`li[data-index="${selectedIndex}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  if (items.length === 0) {
    return (
      <div
        role="listbox"
        aria-label="技能命令"
        className="bg-px-surface border-2 border-px-border shadow-pixel-brand px-3 py-2"
      >
        <div className="font-game text-[11px] text-px-text-dim tracking-wider">
          没有匹配的技能（试试 / 后跟关键词，或不输入查看全部）
        </div>
      </div>
    )
  }

  return (
    <div
      role="listbox"
      aria-label="技能命令"
      className="bg-px-surface border-2 border-px-border shadow-pixel-brand max-h-[280px] overflow-hidden flex flex-col"
    >
      <div className="px-3 py-1.5 border-b-2 border-px-border bg-px-elevated">
        <div className="font-game text-[10px] text-px-text-dim tracking-wider uppercase">
          技能 · ↑↓ 选择 · Enter 确认{onRun ? ' · ⌘Enter 运行' : ''} · Esc 取消
        </div>
      </div>
      <ul ref={listRef} className="overflow-y-auto flex-1">
        {items.map((item, index) => {
          const active = index === selectedIndex
          return (
            <li
              key={item.name}
              data-index={index}
              role="option"
              aria-selected={active}
              onMouseEnter={() => onHoverIndex(index)}
              onMouseDown={(e) => {
                // 用 mousedown 而非 click，避免 textarea blur 抢先把 palette 关掉
                e.preventDefault()
                onSelect(item)
              }}
              className={`group px-3 py-2 cursor-pointer border-b border-px-border/40 last:border-b-0
                ${active ? 'bg-px-primary/10 border-l-2 border-l-px-primary' : 'hover:bg-px-elevated/60'}`}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="font-game text-[12px] text-px-text tracking-wider truncate">
                  /{item.name}
                </div>
                <div className="flex items-center gap-1.5 flex-shrink-0">
                  {/* 运行按钮：悬停/高亮时显示；mousedown 阻止冒泡，避免触发 onSelect 的插入路径 */}
                  {onRun && (
                    <button
                      type="button"
                      onMouseDown={(e) => {
                        e.preventDefault()
                        e.stopPropagation()
                        onRun(item)
                      }}
                      title={`直接运行技能 /${item.name}（按固定模板发送执行指令）`}
                      aria-label={`运行技能 ${item.name}`}
                      className={`font-game text-[9px] tracking-wider px-1.5 py-0.5 border border-px-primary/60 text-px-primary
                        hover:bg-px-primary hover:text-px-bg transition-none
                        ${active ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}
                    >
                      ▶ 运行
                    </button>
                  )}
                  {item.source && (
                    <span className="font-mono text-[9px] text-px-text-dim px-1.5 py-0.5 border border-px-border/60">
                      {SOURCE_LABEL[item.source]}
                    </span>
                  )}
                </div>
              </div>
              <div className="font-game text-[10px] text-px-text-dim mt-0.5 line-clamp-2">
                {item.description || '（无描述）'}
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
