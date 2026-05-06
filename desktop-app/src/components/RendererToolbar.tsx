/**
 * RendererToolbar.tsx — Mermaid / ECharts / Infographic 渲染容器右上角的复用工具栏。
 *
 * 提供三个能力按钮（hover 父容器时浮现，失焦/键盘聚焦也会浮现）：
 *   1. ⤢ 放大 → 调用方把渲染内容塞进 LightboxModal
 *   2. ⬇ PNG  → 调用方提供 getPngDataUrl()，本组件负责触发浏览器下载
 *   3. ⎘ 复制 → 调用方提供 getPngDataUrl()，本组件用 Clipboard API 写入图片
 *
 * 反馈策略：
 *   不依赖全局 toast（避免在消息气泡深层级透传 showToast 回调）。
 *   复制/下载结果直接在按钮文字上做 2 秒短反馈：[✓ 已复制] / [✗ 失败]。
 *
 * 父容器约定（重要）：
 *   父容器必须加 `group relative` 才能让 hover 浮现 + 绝对定位生效。
 *
 * @author zhi.qu
 * @date 2026-05-05
 */

import { useCallback, useRef, useState, type ReactElement } from 'react'
import { dataUrlToBlob } from '../utils/export-image'

/** 复制/下载按钮的瞬时反馈状态 */
type ButtonState = 'idle' | 'success' | 'error'

interface RendererToolbarProps {
  /** 点击「放大」回调（一般是把 isOpen 置为 true） */
  onZoom: () => void
  /**
   * 异步生成 PNG 的 dataURL（data:image/png;base64,...）。
   * 由各 renderer 自己实现：ECharts 用 instance.getDataURL；Mermaid/Infographic
   * 走 SVG → Canvas → toDataURL 的通用路径。失败时抛错或返回 null。
   */
  getPngDataUrl: () => Promise<string | null>
  /** 下载文件名（不含扩展名），默认 `chart-{timestamp}` */
  filenameBase?: string
  /** aria-label 前缀（例如 "Mermaid 图表"），用于辅助技术 */
  ariaLabelPrefix?: string
}

/** 把 dataURL 触发为浏览器下载（不依赖 fetch / FileSaver，零依赖） */
function triggerDownload(dataUrl: string, filename: string): void {
  const a = document.createElement('a')
  a.href = dataUrl
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
}

/**
 * 把 dataURL 形式的 PNG 写入剪贴板。
 * Electron 的 Chromium 默认支持 navigator.clipboard.write + ClipboardItem。
 * 老 API（execCommand）只能复制文本，不能复制图片，所以不做降级。
 */
async function copyPngDataUrlToClipboard(dataUrl: string): Promise<void> {
  if (!navigator.clipboard || typeof window.ClipboardItem === 'undefined') {
    throw new Error('当前环境不支持图片复制（需 Clipboard API + ClipboardItem）')
  }
  // dataURL → Blob：手动解析 base64，规避项目对裸 fetch 的禁用规则（dataURL 不走网络，不需要 fetchWithTimeout）
  const blob = dataUrlToBlob(dataUrl)
  await navigator.clipboard.write([
    new ClipboardItem({ [blob.type || 'image/png']: blob }),
  ])
}

/** 生成默认文件名：chart-2026-05-05-T2349.png 格式（本地时间，避免 UTC 偏差） */
function defaultFilename(base: string): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`
  return `${base}-${stamp}.png`
}

export default function RendererToolbar({
  onZoom,
  getPngDataUrl,
  filenameBase = 'chart',
  ariaLabelPrefix = '图表',
}: RendererToolbarProps): ReactElement {
  const [downloadState, setDownloadState] = useState<ButtonState>('idle')
  const [copyState, setCopyState] = useState<ButtonState>('idle')
  const downloadResetRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  const copyResetRef = useRef<ReturnType<typeof setTimeout>>(undefined)

  const flashState = useCallback(
    (
      next: ButtonState,
      setter: (s: ButtonState) => void,
      ref: React.MutableRefObject<ReturnType<typeof setTimeout> | undefined>,
    ) => {
      setter(next)
      clearTimeout(ref.current)
      ref.current = setTimeout(() => setter('idle'), 2000)
    },
    [],
  )

  const handleDownload = useCallback(async () => {
    try {
      const dataUrl = await getPngDataUrl()
      if (!dataUrl) throw new Error('未生成图像')
      triggerDownload(dataUrl, defaultFilename(filenameBase))
      flashState('success', setDownloadState, downloadResetRef)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[RendererToolbar] 下载 PNG 失败:', msg)
      window.electronAPI?.logEvent?.('error', 'renderer-toolbar:download', msg)
      flashState('error', setDownloadState, downloadResetRef)
    }
  }, [getPngDataUrl, filenameBase, flashState])

  const handleCopy = useCallback(async () => {
    try {
      const dataUrl = await getPngDataUrl()
      if (!dataUrl) throw new Error('未生成图像')
      await copyPngDataUrlToClipboard(dataUrl)
      flashState('success', setCopyState, copyResetRef)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[RendererToolbar] 复制图片失败:', msg)
      window.electronAPI?.logEvent?.('error', 'renderer-toolbar:copy', msg)
      flashState('error', setCopyState, copyResetRef)
    }
  }, [getPngDataUrl, flashState])

  // 共用按钮样式（沿用 MessageBubble 的 SAVE 按钮像素风：font-game + tracking-wider + 边框）
  const baseBtn =
    'font-game text-[10px] tracking-wider px-2 py-0.5 ' +
    'border bg-px-elevated text-px-text-dim ' +
    'hover:text-px-primary hover:border-px-primary ' +
    'focus:opacity-100 focus:outline-none focus:ring-1 focus:ring-px-primary ' +
    'transition-none'

  const stateClass = (s: ButtonState): string => {
    if (s === 'success') return 'border-px-success text-px-success hover:!text-px-success hover:!border-px-success'
    if (s === 'error') return 'border-px-danger text-px-danger hover:!text-px-danger hover:!border-px-danger'
    return 'border-px-border'
  }

  const downloadLabel =
    downloadState === 'success' ? '✓ 已下载'
      : downloadState === 'error' ? '✗ 失败'
        : '⬇ PNG'
  const copyLabel =
    copyState === 'success' ? '✓ 已复制'
      : copyState === 'error' ? '✗ 失败'
        : '⎘ 复制'

  return (
    <div
      className="absolute top-2 right-2 z-10 flex gap-1
        opacity-0 group-hover:opacity-100 focus-within:opacity-100
        transition-opacity"
      role="toolbar"
      aria-label={`${ariaLabelPrefix} 操作`}
    >
      <button
        type="button"
        onClick={onZoom}
        className={`${baseBtn} border-px-border`}
        aria-label={`${ariaLabelPrefix} 放大查看`}
        title="放大查看（点击或按 Enter）"
      >
        ⤢ 放大
      </button>
      <button
        type="button"
        onClick={handleDownload}
        className={`${baseBtn} ${stateClass(downloadState)}`}
        aria-label={`${ariaLabelPrefix} 下载 PNG`}
        title="下载为 PNG 图片"
      >
        {downloadLabel}
      </button>
      <button
        type="button"
        onClick={handleCopy}
        className={`${baseBtn} ${stateClass(copyState)}`}
        aria-label={`${ariaLabelPrefix} 复制图片到剪贴板`}
        title="复制图片到剪贴板"
      >
        {copyLabel}
      </button>
    </div>
  )
}

// SVG → PNG / dataURL → Blob 的通用工具已移至 ../utils/export-image.ts，
// 由 Mermaid / Infographic 渲染器和本组件共同复用。
