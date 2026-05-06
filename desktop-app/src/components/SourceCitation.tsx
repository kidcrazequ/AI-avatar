/**
 * 引用 chip 子组件（视觉方案 B）：
 * 把整个 `[来源: knowledge/a.md, knowledge/b.md#xxx]` 文本块**替换**为 N 个
 * 「📎 文件名.pdf」按钮组（隐藏原引用文本，更清爽）。
 *
 * 数据流：
 *   anchor → extractMdPathsFromAnchor (sync) → string[]
 *         → Promise.all(resolveRawFile) → Array<ResolveRawFileResult | null>
 *         → 渲染 N 个 chip
 *
 * 降级：mdPaths 为空（极端情况 LLM 写错路径）→ 保留原 anchor 文本不消失。
 *
 * @author zhi.qu
 * @date 2026-05-06
 */
import { useEffect, useMemo, useState } from 'react'
import { extractMdPathsFromAnchor, resolveRawFile } from '../services/raw-file-resolver'
import type { ResolveRawFileResult } from '../types/raw-file-anchor'

interface Props {
  /** 完整 anchor 文本，如 `[来源: knowledge/a.md#L1-L5, knowledge/b.md#第7页]` */
  anchor: string
  /** 当前对话所属分身 ID，用于解析 raw_file frontmatter */
  avatarId: string
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

/** 单个按钮组容器 className（inline 流式排版，按钮换行不破坏行内文字） */
const GROUP_CLASS = 'inline-flex flex-wrap items-center gap-1 mx-0.5 align-baseline'

/** 单个可点击 chip className（像素风，沿用旧实现的色调） */
const CHIP_BUTTON_CLASS =
  'inline-flex items-center gap-1 px-1.5 py-0.5 align-baseline ' +
  'border border-px-primary/30 bg-px-bg text-px-primary text-[11px] font-mono ' +
  'whitespace-nowrap hover:text-px-accent hover:border-px-accent ' +
  'focus:outline-none focus:border-px-accent ' +
  'transition-none cursor-pointer'

/** 已删除文件的灰色 chip className（不可点） */
const CHIP_MISSING_CLASS =
  'inline-flex items-center gap-1 px-1.5 py-0.5 align-baseline ' +
  'border border-px-border bg-px-elevated text-px-text-dim text-[11px] font-mono ' +
  'whitespace-nowrap'

/** 加载中 / 全部解析失败时的占位 chip className */
const CHIP_PLACEHOLDER_CLASS =
  'inline-flex items-center gap-1 px-1.5 py-0.5 align-baseline ' +
  'border border-px-border bg-px-elevated text-px-text-dim/80 text-[11px] font-mono ' +
  'whitespace-nowrap'

/**
 * 单个 anchor → N 个 chip 按钮组渲染。
 *
 * 状态机：
 *   1. mdPaths 为空           → 降级：直接吐回原 anchor 文本
 *   2. results === undefined  → 灰色「📎 加载中…」chip
 *   3. results 全部为 null    → 灰色「📎 N 个来源（原始文件未挂载）」chip
 *   4. results 有数据         → 按钮组：每个非空 result 渲染独立 chip
 */
export default function SourceCitation({ anchor, avatarId }: Props) {
  // useMemo 避免每次渲染都重新跑全局正则扫描
  const mdPaths = useMemo(() => extractMdPathsFromAnchor(anchor), [anchor])

  // 注意：初值就是 undefined（加载中），不要在 effect 内同步 setResults(undefined)，
  // 否则会触发 react-hooks/set-state-in-effect 警告（commit 阶段同步 setState）。
  // 当 anchor / avatarId 变化时，effect 通过 alive 守卫丢弃过期请求；
  // 中间一帧短暂展示旧 results 是可接受的代价。
  const [results, setResults] = useState<Array<ResolveRawFileResult | null> | undefined>(undefined)

  useEffect(() => {
    // mdPaths 为空时不发起任何 IPC，直接走降级渲染分支
    if (mdPaths.length === 0) return
    let alive = true
    Promise.all(mdPaths.map((mdPath) => resolveRawFile(avatarId, mdPath)))
      .then((res) => {
        if (alive) setResults(res)
      })
      .catch((err: unknown) => {
        const detail = describeError(err)
        console.error('[SourceCitation] resolveRawFile 批量失败:', anchor, detail)
        safeLogEvent('error', 'source-citation-resolve-failed', `${anchor} | ${detail}`)
        // 失败时把每一项置为 null，触发"全部为 null"的灰色占位分支
        if (alive) setResults(mdPaths.map(() => null))
      })
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [avatarId, anchor])

  const handleOpen = async (rawRelPath: string, displayName: string) => {
    try {
      const ret = await window.electronAPI.openRawFile(avatarId, rawRelPath)
      if (!ret.ok) {
        const reason = ret.error ?? '未知错误'
        console.error('[SourceCitation] openRawFile 拒绝:', rawRelPath, reason)
        safeLogEvent('error', 'source-citation-open-failed', `${rawRelPath} | ${reason}`)
        // TODO: 接全局 Toast 替代 alert
        window.alert(`打开「${displayName}」失败：${reason}`)
      }
    } catch (err: unknown) {
      const detail = describeError(err)
      console.error('[SourceCitation] openRawFile 异常:', detail)
      safeLogEvent('error', 'source-citation-open-exception', `${rawRelPath} | ${detail}`)
      // TODO: 接全局 Toast 替代 alert
      window.alert(`打开「${displayName}」失败：${detail}`)
    }
  }

  // —— 分支 1：降级（mdPaths 为空） —— //
  // 极端情况：LLM 写了 [来源: ...] 但里面没有任何合法的 knowledge/*.md 路径。
  // 直接回吐原文本，保证用户能看到 LLM 的引用提示，不让信息凭空消失。
  if (mdPaths.length === 0) {
    return <>{anchor}</>
  }

  // —— 分支 2：加载中 —— //
  if (results === undefined) {
    return (
      <span className={GROUP_CLASS}>
        <span
          className={CHIP_PLACEHOLDER_CLASS}
          aria-label={`正在解析 ${mdPaths.length} 个来源原始文件`}
          title={anchor}
        >
          <span aria-hidden="true">📎</span>
          <span>加载中…（{mdPaths.length}）</span>
        </span>
      </span>
    )
  }

  // —— 分支 3：全部为 null（原始文件未挂载 / 全部解析失败） —— //
  const allNull = results.every((r) => r === null)
  if (allNull) {
    return (
      <span className={GROUP_CLASS}>
        <span
          className={CHIP_PLACEHOLDER_CLASS}
          // tooltip 给排查用：把原 anchor 文本暴露出来，方便定位 LLM 引用了哪些路径
          title={anchor}
          aria-label={`${mdPaths.length} 个来源，但原始文件均未挂载`}
        >
          <span aria-hidden="true">📎</span>
          <span>{mdPaths.length} 个来源（原始文件未挂载）</span>
        </span>
      </span>
    )
  }

  // —— 分支 4：渲染按钮组 —— //
  return (
    <span className={GROUP_CLASS}>
      {results.map((result, idx) => {
        // null → 该路径解析失败 / 无 raw_file，本契约下跳过不渲染
        if (result === null) return null

        if (result.exists) {
          return (
            <button
              key={`${idx}-${result.rawRelPath}`}
              type="button"
              onClick={() => {
                void handleOpen(result.rawRelPath, result.displayName)
              }}
              title={`用系统默认应用打开：${result.displayName}`}
              aria-label={`打开原始文件 ${result.displayName}`}
              className={CHIP_BUTTON_CLASS}
            >
              <span aria-hidden="true">📎</span>
              <span>{result.displayName}</span>
            </button>
          )
        }

        return (
          <span
            key={`${idx}-${result.rawRelPath}`}
            title={`原始文件已被删除或迁移：${result.rawRelPath}`}
            aria-label={`原始文件已删除 ${result.displayName}`}
            className={CHIP_MISSING_CLASS}
          >
            <span aria-hidden="true">⚠️</span>
            <span>{result.displayName}</span>
          </span>
        )
      })}
    </span>
  )
}
