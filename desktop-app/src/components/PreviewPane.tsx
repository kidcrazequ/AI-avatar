/**
 * 预览面板：占据 Chat 右侧固定区域，把自身屏幕坐标 + 尺寸通过 IPC 报告给主进程，
 * 主进程据此 setBounds 调整 user 端 WebContentsView，让它精确贴合这个 div 的位置。
 *
 * 还提供：
 *   - inspector 切换按钮
 *   - 切换显隐（折叠时同时通知主进程隐藏 WebContentsView，避免遮挡聊天区）
 *
 * @author zhi.qu
 * @date 2026-04-28
 */

import { useEffect, useRef, useState } from 'react'

interface Props {
  conversationId: string
  visible?: boolean
  onClose?: () => void
}

export default function PreviewPane({ conversationId: _conversationId, visible = true, onClose }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [inspector, setInspector] = useState(false)

  // 把容器 bounds 报告给主进程：mount / 窗口 resize / 容器自身 resize 时都同步一次
  useEffect(() => {
    const reportBounds = (): void => {
      const el = containerRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      const dpr = window.devicePixelRatio || 1
      // 注意：rect 是 CSS 像素，setBounds 也用 CSS 像素 — Electron 内部会按 dpr 处理
      void window.electronAPI.previewSetBounds({
        x: Math.floor(rect.left),
        y: Math.floor(rect.top),
        width: Math.max(1, Math.floor(rect.width)),
        height: Math.max(1, Math.floor(rect.height)),
      })
      void dpr // 保留 dpr 引用，便于将来按需回退到实际像素
    }
    reportBounds()
    const ro = new ResizeObserver(() => reportBounds())
    if (containerRef.current) ro.observe(containerRef.current)
    window.addEventListener('resize', reportBounds)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', reportBounds)
    }
  }, [visible])

  // 显隐变化：通知主进程 setUserVisible，避免折叠时 WebContentsView 仍盖在聊天上
  useEffect(() => {
    void window.electronAPI.previewSetUserVisible(!!visible)
  }, [visible])

  // inspector 切换：只对 user view 生效
  useEffect(() => {
    void window.electronAPI.previewSetInspector('user', inspector)
  }, [inspector])

  if (!visible) return null

  return (
    <div ref={containerRef} className="h-full w-full border-l border-px-border bg-px-surface/40 relative flex flex-col">
      <div className="flex items-center justify-between border-b border-px-border px-2 py-1 bg-px-surface text-[11px]">
        <span className="font-game tracking-wider text-px-text-dim">PREVIEW</span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className={`px-2 py-0.5 border border-px-border ${inspector ? 'bg-px-accent text-px-bg' : 'bg-px-bg text-px-text-dim'} hover:opacity-90`}
            onClick={() => setInspector((v) => !v)}
            title="按住 Cmd/Ctrl 点击元素，把组件信息回传到聊天"
          >
            {inspector ? 'INSPECT ON' : 'INSPECT'}
          </button>
          {onClose && (
            <button type="button" className="px-2 py-0.5 border border-px-border bg-px-bg text-px-text-dim hover:opacity-90" onClick={onClose}>
              CLOSE
            </button>
          )}
        </div>
      </div>
      <div className="flex-1 relative">
        {/* 真实的 WebContentsView 由主进程绘制在此区域之上 */}
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <span className="font-game text-[10px] text-px-text-dim/40 tracking-widest">SOUL · LIVE PREVIEW</span>
        </div>
      </div>
    </div>
  )
}
