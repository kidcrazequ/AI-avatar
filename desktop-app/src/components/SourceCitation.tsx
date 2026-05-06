/**
 * 引用 chip 子组件：拦截 LLM 回答中的 `[来源: knowledge/<file>.md#L..]` 文本，
 * 异步解析对应的原始 PDF/Excel/PPT 文件元信息，给出 chip 视觉。
 *
 * 状态：
 *   - undefined：解析中（chip 右侧只显示 …）
 *   - ResolveRawFileResult.exists=true：可点击「📎 xxx.pdf」按钮，调
 *     `window.electronAPI.openRawFile` 由主进程 shell.openPath 打开
 *   - ResolveRawFileResult.exists=false：只显示「⚠️ 原文件已删除：xxx.pdf」（不可点）
 *   - null：保持原 anchor 文本不变（无原始文件，或解析失败优雅降级）
 *
 * 错误反馈：
 *   - 当前用 alert + electronAPI.logEvent 兜底（TODO: 接全局 Toast，
 *     避免在消息气泡深层级透传 showToast 回调）
 *
 * @author zhi.qu
 * @date 2026-05-06
 */
import { useEffect, useState } from 'react'
import { resolveRawFileForAnchor } from '../services/raw-file-resolver'
import type { ResolveRawFileResult } from '../types/raw-file-anchor'

interface Props {
  /** 完整 anchor 文本，如 `[来源: knowledge/xxx.md#L12-L20]` 或 `[来源：BOM 图纸系列]` */
  anchor: string
  /** 当前对话所属分身 ID，用于解析 raw_file frontmatter */
  avatarId: string
}

/** undefined = 加载中；null = 不可解析 / 无原始文件 */
type ResolveState = ResolveRawFileResult | null | undefined

/**
 * 判断 anchor 是否为「结构化 knowledge 路径」格式。
 * 结构化：`[来源: knowledge/foo.md...]`（含 `knowledge/` 前缀）→ 走 raw_file 解析
 * 自由文本：`[来源：自由文本]` → 跳过 IPC，仅渲染样式化 chip
 */
const STRUCTURED_KNOWLEDGE_ANCHOR_REGEX = /\[来源:\s*knowledge\//
function isStructuredAnchor(anchor: string): boolean {
  return STRUCTURED_KNOWLEDGE_ANCHOR_REGEX.test(anchor)
}

/**
 * 从自由文本 anchor 中提取文档名。
 * `[来源：BOM 图纸系列]` → `BOM 图纸系列`
 * `[来源：262Kwh工商柜装配说明 > 工序4]` → `262Kwh工商柜装配说明 > 工序4`
 * 解析失败时返回原文（保险降级）。
 */
const LOOSE_ANCHOR_INNER_REGEX = /^\[来源[：:]\s*([^\]]+)\]$/
function extractLooseAnchorText(anchor: string): string {
  const match = anchor.trim().match(LOOSE_ANCHOR_INNER_REGEX)
  return match ? match[1].trim() : anchor
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

function safeLogEvent(level: 'info' | 'warn' | 'error', action: string, detail?: string): void {
  try {
    const api = (globalThis as { window?: { electronAPI?: { logEvent?: (l: string, a: string, d?: string) => unknown } } }).window?.electronAPI
    if (api && typeof api.logEvent === 'function') {
      void api.logEvent(level, action, detail)
    }
  } catch (logErr) {
    console.error('[SourceCitation] logEvent 失败', describeError(logErr))
  }
}

/**
 * 单个引用 chip 渲染。
 *
 * 两种 anchor 形态：
 *   1. 结构化（`[来源: knowledge/xxx.md...]`）→ 异步 IPC 解析 raw_file，按结果渲染
 *      loading / 打开按钮 / 已删除三态
 *   2. 自由文本（`[来源：xxx]`）→ 跳过 IPC，直接渲染样式化 chip 显示文档名
 */
export default function SourceCitation({ anchor, avatarId }: Props) {
  const structured = isStructuredAnchor(anchor)
  const [result, setResult] = useState<ResolveState>(structured ? undefined : null)

  useEffect(() => {
    // 自由文本 anchor 不走 IPC：避免主进程解析 raw_file 时打 warn 日志和等待往返
    if (!structured) return
    let alive = true
    resolveRawFileForAnchor(avatarId, anchor)
      .then((res) => {
        if (alive) setResult(res)
      })
      .catch((err: unknown) => {
        const detail = describeError(err)
        console.error('[SourceCitation] resolveRawFileForAnchor 失败:', anchor, detail)
        safeLogEvent('error', 'source-citation-resolve-failed', `${anchor} | ${detail}`)
        if (alive) setResult(null)
      })
    return () => {
      alive = false
    }
  }, [anchor, avatarId, structured])

  const handleOpen = async () => {
    if (!result || !result.exists) return
    try {
      const ret = await window.electronAPI.openRawFile(avatarId, result.rawRelPath)
      if (!ret.ok) {
        const reason = ret.error ?? '未知错误'
        console.error('[SourceCitation] openRawFile 拒绝:', result.rawRelPath, reason)
        safeLogEvent('error', 'source-citation-open-failed', `${result.rawRelPath} | ${reason}`)
        // TODO: 接全局 Toast 替代 alert
        window.alert(`打开原始文件失败：${reason}`)
      }
    } catch (err: unknown) {
      const detail = describeError(err)
      console.error('[SourceCitation] openRawFile 异常:', detail)
      safeLogEvent('error', 'source-citation-open-exception', `${result.rawRelPath} | ${detail}`)
      // TODO: 接全局 Toast 替代 alert
      window.alert(`打开原始文件失败：${detail}`)
    }
  }

  // 自由文本 anchor（如 `[来源：BOM 图纸系列]`）：渲染极简样式化 chip，
  // 仅展示文档名，不带打开按钮（无原始文件可定位），让 LLM 输出不再"裸奔"
  if (!structured) {
    const docName = extractLooseAnchorText(anchor)
    return (
      <span
        title="来源说明"
        className="inline-flex items-center gap-1 mx-0.5 px-1.5 py-0.5 align-baseline
          border border-px-border bg-px-elevated text-px-text-dim text-[11px] font-game
          tracking-wider whitespace-nowrap"
      >
        <span aria-hidden="true">📖</span>
        <span>{docName}</span>
      </span>
    )
  }

  // 结构化 anchor 但解析无结果（raw_file 缺失 / IPC 异常）：保持原 anchor 文本兜底
  if (result === null) {
    return <>{anchor}</>
  }

  return (
    <span
      className="inline-flex items-center gap-1 mx-0.5 px-1.5 py-0.5 align-baseline
        border border-px-primary/30 bg-px-bg text-px-text-dim text-[11px] font-mono
        whitespace-nowrap"
    >
      <span>{anchor}</span>
      {result === undefined && (
        <span
          aria-label="原始文件解析中"
          className="font-game tracking-wider text-px-text-dim/60"
        >
          …
        </span>
      )}
      {result && result.exists && (
        <button
          type="button"
          onClick={handleOpen}
          title={`用系统默认应用打开：${result.displayName}`}
          aria-label={`打开原始文件 ${result.displayName}`}
          className="font-game tracking-wider text-[11px]
            border border-px-primary/40 bg-px-elevated text-px-primary px-1 py-0
            hover:text-px-accent hover:border-px-accent
            focus:outline-none focus:border-px-accent
            transition-none cursor-pointer"
        >
          📎 {result.displayName}
        </button>
      )}
      {result && !result.exists && (
        <span
          title="原始文件已被删除或迁移"
          className="font-game tracking-wider text-[11px]
            border border-px-border bg-px-elevated text-px-text-dim px-1 py-0"
        >
          ⚠️ 原文件已删除：{result.displayName}
        </span>
      )}
    </span>
  )
}
