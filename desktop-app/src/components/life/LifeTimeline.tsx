/**
 * @file LifeTimeline.tsx — 像素风人生时间轴（plan 4.2 左 32%）
 *
 * 渲染策略：
 *   - 按 entry.age 升序排；同年龄按 month 排序；
 *   - 三色编码（plan 要求）：
 *       remembered → ★ bg-px-primary（关键瞬间金）
 *       blurred    → ● bg-yellow-400（已经历亮）
 *       forgotten  → ○ bg-px-text-dim（已淡忘灰）
 *   - NOW 锚点（generationStatus='complete'|'growing'）：
 *       根据 currentAgeMonths 在已生成事件最后插入 ┄┄ NOW ┄┄ 分隔线；
 *       下方画一个虚线段表示"未来还会生长"。
 *   - 选中态：高亮蓝色边框 + 左侧粗指示条。
 *   - 容器自身可滚动（overflow-y-auto），事件多时不撑爆面板。
 *
 * @author zhi.qu
 * @date 2026-05-09
 */

import { useMemo, useRef, useEffect } from 'react'

interface Props {
  /** 排序后的全部 timeline 条目 */
  timeline: LifeTimelineEntry[]
  /** 当前选中的事件 ID（高亮用），无则 null */
  selectedId: string | null
  /** 选中事件回调 */
  onSelect: (entry: LifeTimelineEntry) => void
  /** 分身当前精确月龄（用于画 NOW 锚点位置） */
  currentAgeMonths: number
  /** 生成状态；决定是否画 NOW 锚点 + 未来虚线 */
  generationStatus: LifeGenerationStatus
  /** 时间轴是否启用持续生长（决定未来虚线是否画"待生成"还是"已冻结"） */
  growthEnabled: boolean
}

/** 单个事件圆点的颜色与符号映射 */
function statusVisual(status: LifeConsolidationStatus): { dotClass: string; symbol: string; labelClass: string } {
  switch (status) {
    case 'remembered':
      return { dotClass: 'bg-px-primary', symbol: '★', labelClass: 'text-px-primary' }
    case 'blurred':
      return { dotClass: 'bg-yellow-400', symbol: '●', labelClass: 'text-yellow-400' }
    case 'forgotten':
      return { dotClass: 'bg-px-text-dim', symbol: '○', labelClass: 'text-px-text-dim' }
    default:
      // exhaustive 兜底（Soul 项目 user_rule 禁 any）
      return { dotClass: 'bg-px-text-dim', symbol: '·', labelClass: 'text-px-text-dim' }
  }
}

export default function LifeTimeline({
  timeline, selectedId, onSelect, currentAgeMonths, generationStatus, growthEnabled,
}: Props) {
  const sorted = useMemo(() => {
    const copy = [...timeline]
    copy.sort((a, b) => {
      if (a.age !== b.age) return a.age - b.age
      return a.month - b.month
    })
    return copy
  }, [timeline])

  const currentAgeYears = currentAgeMonths / 12
  const showNowAnchor = generationStatus === 'complete' || generationStatus === 'growing'
  const showFutureDashed = generationStatus === 'growing' || (generationStatus === 'complete' && growthEnabled)

  // 选中事件自动滚动到可视区
  const containerRef = useRef<HTMLDivElement>(null)
  const selectedRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (selectedId && selectedRef.current && containerRef.current) {
      selectedRef.current.scrollIntoView({ block: 'nearest', behavior: 'auto' })
    }
  }, [selectedId])

  if (sorted.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center px-3 py-6 bg-px-bg border-r-2 border-px-border">
        <p className="font-game text-[11px] text-px-text-dim tracking-wider text-center leading-relaxed">
          暂无事件
          <br />
          等待生成…
        </p>
      </div>
    )
  }

  return (
    <div
      ref={containerRef}
      // h-full + min-h-0 + w-full：让本组件填满父 flex 容器的高度上限，
      // 否则 overflow-y-auto 永远不触发（flex 子元素默认 min-height:auto 会撑开父容器，
      // 导致 footer LEGEND 与事件列表重叠）。
      className="flex flex-col h-full min-h-0 w-full overflow-y-auto bg-px-bg border-r-2 border-px-border"
    >
      {/* 标题 */}
      <div className="flex-shrink-0 px-3 py-3 border-b-2 border-px-border-dim sticky top-0 bg-px-bg z-10">
        <div className="font-game text-[12px] text-px-primary tracking-widest">TIMELINE</div>
        <div className="font-game text-[11px] text-px-text-dim tracking-wider mt-1">
          {sorted.length} 个事件
        </div>
      </div>

      {/* 时间轴主体 */}
      <div className="relative px-3 py-3">
        {/* 左侧竖线（贯穿） */}
        <div
          className="absolute left-[18px] top-3 bottom-3 w-[2px] bg-px-border-dim"
          aria-hidden="true"
        />

        <div className="flex flex-col gap-1">
          {sorted.map((entry, idx) => {
            const isSelected = entry.id === selectedId
            const visual = statusVisual(entry.consolidationStatus)
            // 在到达当前年龄之前的最后一个事件后插入 NOW 锚点
            const nextEntry = sorted[idx + 1]
            const insertNowHere =
              showNowAnchor &&
              entry.age <= currentAgeYears &&
              (!nextEntry || nextEntry.age > currentAgeYears)

            return (
              <div key={entry.id}>
                <button
                  ref={isSelected ? selectedRef : null}
                  onClick={() => onSelect(entry)}
                  className={`relative w-full flex items-start gap-3 pl-1 pr-2 py-2 text-left transition-none
                    ${isSelected
                      ? 'bg-px-primary/10 border-l-2 border-l-px-primary'
                      : 'border-l-2 border-l-transparent hover:bg-px-elevated'
                    }
                  `}
                  aria-pressed={isSelected}
                  aria-label={`${entry.age} 岁 · ${entry.title}`}
                >
                  {/* 圆点 */}
                  <div
                    className={`flex-shrink-0 w-3 h-3 mt-1 ${visual.dotClass} relative z-10`}
                    aria-hidden="true"
                  />
                  {/* 内容 */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-baseline gap-2">
                      <span className={`font-game text-[12px] tracking-wider ${visual.labelClass}`}>
                        {entry.age}
                      </span>
                      <span className={`font-game text-[11px] ${visual.labelClass}`} aria-hidden="true">
                        {visual.symbol}
                      </span>
                      <span
                        className={`font-game text-[12px] tracking-wider truncate ${
                          isSelected ? 'text-px-text font-bold' : 'text-px-text-sec'
                        }`}
                        title={entry.title}
                      >
                        {entry.title}
                      </span>
                    </div>
                  </div>
                </button>

                {/* NOW 锚点：在最后一个 age <= currentAgeYears 的事件之后画分隔 */}
                {insertNowHere && (
                  <div className="relative my-2 flex items-center gap-2 pl-1 pr-2" aria-label="当前时间锚点">
                    <div className="flex-shrink-0 w-3 h-3" />
                    <div className="flex-1 flex items-center gap-2">
                      <div
                        className="flex-1 border-t-2 border-dashed border-px-primary"
                        aria-hidden="true"
                      />
                      <span className="font-game text-[10px] text-px-primary tracking-widest">NOW</span>
                      <div
                        className="flex-1 border-t-2 border-dashed border-px-primary"
                        aria-hidden="true"
                      />
                    </div>
                  </div>
                )}
              </div>
            )
          })}

          {/* 未来段（虚线提示分身将继续生长） */}
          {showFutureDashed && (
            <div className="relative pl-1 pr-2 py-2 mt-1">
              <div className="flex items-start gap-3">
                <div
                  className="flex-shrink-0 w-3 h-3 mt-1 border-2 border-dashed border-px-text-dim bg-transparent"
                  aria-hidden="true"
                />
                <div className="flex-1">
                  <div className="font-game text-[11px] text-px-text-dim tracking-wider italic">
                    {generationStatus === 'growing' || growthEnabled ? '（待生成）' : '（已冻结）'}
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* 图例 */}
      <div className="flex-shrink-0 px-3 py-3 border-t-2 border-px-border-dim sticky bottom-0 bg-px-bg">
        <div className="font-game text-[10px] text-px-text-dim tracking-wider mb-2">LEGEND</div>
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <div className="w-2.5 h-2.5 bg-px-primary" aria-hidden="true" />
            <span className="font-game text-[10px] text-px-primary tracking-wider">★ 关键瞬间</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-2.5 h-2.5 bg-yellow-400" aria-hidden="true" />
            <span className="font-game text-[10px] text-yellow-400 tracking-wider">● 已经历</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-2.5 h-2.5 bg-px-text-dim" aria-hidden="true" />
            <span className="font-game text-[10px] text-px-text-dim tracking-wider">○ 已淡忘</span>
          </div>
          {showFutureDashed && (
            <div className="flex items-center gap-2">
              <div
                className="w-2.5 h-2.5 border-2 border-dashed border-px-text-dim bg-transparent"
                aria-hidden="true"
              />
              <span className="font-game text-[10px] text-px-text-dim tracking-wider">┄ 未来</span>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
