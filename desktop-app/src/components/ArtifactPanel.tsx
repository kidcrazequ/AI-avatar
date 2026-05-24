/**
 * Artifact 副面板（完整版）：tab 多制品 + 拖拽宽度。
 *
 * 状态：useArtifactStore
 * - items[] + activeIndex：多 tab
 * - widthPercent：localStorage 持久化
 * - autoOpenThreshold：自动检测大制品阈值（MessageBubble 侧判定）
 *
 * @author zhi.qu
 * @date 2026-05-19
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { useArtifactStore, type ArtifactItem } from '../stores/artifactStore'
import ChartRenderer from './ChartRenderer'
import MermaidRenderer from './MermaidRenderer'
import InfographicRenderer from './InfographicRenderer'

const KIND_LABEL = {
  chart: 'CHART',
  mermaid: 'MERMAID',
  infographic: 'INFOGRAPHIC',
} as const

export default function ArtifactPanel() {
  const { open, items, activeIndex, widthPercent, closeArtifact, closeTab, setActiveIndex, setWidthPercent } = useArtifactStore()
  const [copied, setCopied] = useState(false)
  const dragStartXRef = useRef<number | null>(null)
  const dragStartWidthRef = useRef<number>(50)
  const [dragging, setDragging] = useState(false)

  const current: ArtifactItem | undefined = items[activeIndex]

  // Esc 关闭
  useEffect(() => {
    if (!open) return
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        closeArtifact()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, closeArtifact])

  // 拖拽 resize
  useEffect(() => {
    if (!dragging) return
    const onMove = (e: globalThis.MouseEvent) => {
      if (dragStartXRef.current === null) return
      const dx = dragStartXRef.current - e.clientX
      const vw = window.innerWidth
      const nextPercent = dragStartWidthRef.current + (dx / vw) * 100
      setWidthPercent(nextPercent)
    }
    const onUp = () => {
      dragStartXRef.current = null
      setDragging(false)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [dragging, setWidthPercent])

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    dragStartXRef.current = e.clientX
    dragStartWidthRef.current = widthPercent
    setDragging(true)
  }, [widthPercent])

  const handleCopy = useCallback(async () => {
    if (!current) return
    try {
      await navigator.clipboard.writeText(current.raw)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch { /* ignore */ }
  }, [current])

  if (!open || items.length === 0 || !current) return null

  return (
    <div
      className="fixed top-0 right-0 bottom-0 z-[90] bg-px-surface border-l-2 border-px-border shadow-pixel-brand flex flex-col"
      role="dialog"
      aria-label="制品副面板"
      style={{ width: `${widthPercent}vw`, minWidth: 380, maxWidth: '90vw' }}
    >
      {/* 拖拽 handle：左侧 4px 竖条 */}
      <div
        onMouseDown={handleResizeStart}
        className={`absolute left-0 top-0 bottom-0 w-1 cursor-col-resize z-20 hover:bg-px-primary/60 ${dragging ? 'bg-px-primary' : 'bg-transparent'}`}
        title="拖拽调整宽度"
      />

      {/* 顶部 toolbar */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b-2 border-px-border bg-px-elevated">
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <span className="font-game text-[11px] text-px-text-dim tracking-wider flex-shrink-0">
            {items.length === 1 ? '副面板' : `${items.length} 制品`}
          </span>
          <span className="font-game text-[10px] text-px-text-dim/70 tracking-wider hidden sm:inline">
            Esc 关闭
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={handleCopy}
            className="font-game text-[11px] text-px-text-dim hover:text-px-primary px-2 py-0.5 border border-transparent hover:border-px-primary/50 transition-none"
            title="复制源码"
          >
            {copied ? '已复制 ✓' : '复制'}
          </button>
          <button
            type="button"
            onClick={closeArtifact}
            className="font-game text-[11px] text-px-text-dim hover:text-px-danger px-2 py-0.5 border border-transparent hover:border-px-danger/50 transition-none"
            title="关闭副面板"
            aria-label="关闭副面板"
          >
            ×
          </button>
        </div>
      </div>

      {/* tab bar */}
      {items.length > 0 && (
        <div className="flex overflow-x-auto border-b-2 border-px-border bg-px-bg/60">
          {items.map((it, i) => {
            const active = i === activeIndex
            return (
              <div
                key={it.key}
                className={`group flex items-center gap-1.5 px-3 py-1.5 cursor-pointer border-r border-px-border/40 flex-shrink-0
                  ${active ? 'bg-px-surface border-b-2 border-b-px-primary -mb-[2px]' : 'bg-px-bg/40 hover:bg-px-elevated/60'}`}
                onClick={() => setActiveIndex(i)}
                role="tab"
                aria-selected={active}
              >
                <span className={`font-mono text-[9px] tracking-widest ${active ? 'text-px-primary' : 'text-px-text-dim'}`}>
                  {KIND_LABEL[it.kind]}
                </span>
                <span className={`font-game text-[11px] ${active ? 'text-px-text' : 'text-px-text-dim'}`}>
                  #{i + 1}
                </span>
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); closeTab(i) }}
                  className="opacity-0 group-hover:opacity-100 font-mono text-[10px] text-px-text-dim hover:text-px-danger px-0.5"
                  title="关闭此 tab"
                  aria-label="关闭此 tab"
                >
                  ×
                </button>
              </div>
            )
          })}
        </div>
      )}

      {/* body */}
      <div className="flex-1 overflow-auto p-4 bg-px-bg">
        {current.kind === 'chart' && <ArtifactChartBody raw={current.raw} />}
        {current.kind === 'mermaid' && <MermaidRenderer code={current.raw} />}
        {current.kind === 'infographic' && <InfographicRenderer dsl={current.raw} />}
      </div>
    </div>
  )
}

function ArtifactChartBody({ raw }: { raw: string }) {
  let parsed: Record<string, unknown> | null = null
  let err: string | null = null
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>
  } catch (e) {
    err = (e as Error).message
  }
  if (parsed) return <ChartRenderer option={parsed} rawJson={raw} />
  return (
    <pre className="border-2 border-px-danger bg-px-bg p-3 overflow-auto">
      <div className="font-game text-[11px] tracking-wider text-px-danger mb-2">
        ⚠ CHART JSON 解析失败{err ? `: ${err}` : ''}
      </div>
      <code className="text-[12px] text-px-text-dim font-mono">{raw}</code>
    </pre>
  )
}
