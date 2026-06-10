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
const GROUP_CLASS = 'inline-flex flex-wrap items-center gap-1.5 mx-1 align-baseline'

/**
 * 单个可点击 chip className（像素风，视觉权重 3x 强化版）。
 *
 * 2026-05-22 真实需求：原 chip 使用 `text-[11px] border border-px-primary/30 bg-px-bg`——
 * 边框 30% 透明 + 背景与正文同色 + 字号 11px，在 1080p 屏录里几乎隐形。演示"每个数字都能溯源"
 * 这个核心卖点时观众根本看不到角标。
 *
 * 升级方案：
 *   - border 30% → 100% 实色 (`border-px-primary`) + border-2（双线增加视觉重量）
 *   - 加 `bg-px-primary/10` 底色（chip 在正文里不再隐形）
 *   - 字号 11 → 12 + medium 字重
 *   - hover 加 `shadow-pixel-brand`（像素风偏移阴影，强化"可点击"信号）
 */
const CHIP_BUTTON_CLASS =
  'inline-flex items-center gap-1 px-2 py-0.5 align-baseline ' +
  'border-2 border-px-primary bg-px-primary/10 text-px-primary text-[12px] font-mono font-medium ' +
  'whitespace-nowrap hover:bg-px-primary/20 hover:shadow-pixel-brand ' +
  'focus:outline-none focus:bg-px-primary/20 ' +
  'transition-none cursor-pointer'

/**
 * raw_file 缺失 / 已被删除的兜底 chip className：仍可点击，但视觉用 dim 色系区分主链接，
 * 同步增重以保持与 CHIP_BUTTON_CLASS 的尺寸一致（border-2 + py-0.5），避免文本基线错位。
 */
const CHIP_MISSING_CLASS =
  'inline-flex items-center gap-1 px-2 py-0.5 align-baseline ' +
  'border-2 border-px-border bg-px-elevated text-px-text-dim text-[12px] font-mono ' +
  'whitespace-nowrap hover:text-px-text hover:border-px-text-dim ' +
  'focus:outline-none focus:border-px-text-dim ' +
  'transition-none cursor-pointer'

/** 加载中 / 全部解析失败时的占位 chip className */
const CHIP_PLACEHOLDER_CLASS =
  'inline-flex items-center gap-1 px-2 py-0.5 align-baseline ' +
  'border-2 border-px-border bg-px-elevated text-px-text-dim/80 text-[12px] font-mono ' +
  'whitespace-nowrap'

/**
 * 单个 anchor → N 个 chip 按钮组渲染。
 *
 * 状态机：
 *   1. mdPaths 为空           → 降级：直接吐回原 anchor 文本
 *   2. results === undefined  → 灰色「📎 加载中…」chip
 *   3. results 有数据         → 按钮组（每个 mdPath 一个 chip，全部可点）：
 *      - result.exists       → 📎 文件名（打开 _raw/ 下原始文件）
 *      - result === null     → 📄 .md（raw_file frontmatter 缺失，兜底打开 markdown 源）
 *      - result.exists=false → ⚠️ 文件名（_raw/ 物理文件丢失，兜底打开 markdown 源）
 *
 * 设计原则：用户能点的 chip 永远 ≥ 用户能点的原始文件，让"溯源"路径**不消失**。
 */
export default function SourceCitation({ anchor, avatarId }: Props) {
  // useMemo 避免每次渲染都重新跑全局正则扫描
  const mdPaths = useMemo(() => extractMdPathsFromAnchor(anchor), [anchor])

  // 把 results 和它对应的 (avatarId, anchor) 绑在一起。
  // 之前只存 results：anchor/avatarId 切换时旧 results 仍渲染一帧，用户点 chip
  // 会跳到上一条 anchor 的来源。现在用 currentKey 比对，key 不匹配 → 视作 undefined
  // (加载中)，等新 effect 的 Promise resolve 后再展示新 results。
  // 注意不要在 effect 内同步 setResolved(null) —— 触发 react-hooks/set-state-in-effect。
  const currentKey = `${avatarId}|${anchor}`
  const [resolved, setResolved] = useState<{ key: string; res: Array<ResolveRawFileResult | null> } | null>(null)

  useEffect(() => {
    // mdPaths 为空时不发起任何 IPC，直接走降级渲染分支
    if (mdPaths.length === 0) return
    let alive = true
    const keyAtStart = `${avatarId}|${anchor}`
    Promise.all(mdPaths.map((mdPath) => resolveRawFile(avatarId, mdPath)))
      .then((res) => {
        if (alive) setResolved({ key: keyAtStart, res })
      })
      .catch((err: unknown) => {
        const detail = describeError(err)
        console.error('[SourceCitation] resolveRawFile 批量失败:', anchor, detail)
        safeLogEvent('error', 'source-citation-resolve-failed', `${anchor} | ${detail}`)
        // 失败时把每一项置为 null，触发"全部为 null"的灰色占位分支
        if (alive) setResolved({ key: keyAtStart, res: mdPaths.map(() => null) })
      })
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [avatarId, anchor])

  // key 不匹配（anchor/avatarId 已切换，新 Promise 还没 resolve）→ 视作加载中
  const results: Array<ResolveRawFileResult | null> | undefined =
    resolved && resolved.key === currentKey ? resolved.res : undefined

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

  /**
   * 兜底打开 markdown 源（raw_file 缺失或对应 _raw/ 物理文件不存在时）。
   * mdRelPath 从 anchor 解析出，是相对 knowledge/ 根的路径（不含 `knowledge/` 前缀，
   * 项目知识为 `projects/<pid>/knowledge/<file>.md`）。
   *
   * 全局知识 .md → 派发 `soul-open-knowledge-file` 事件，App 打开应用内知识库面板
   * 定位该文件（KnowledgeViewer 渲染 markdown），不依赖系统 .md 关联应用——
   * 系统没装 markdown 查看器时 shell.openPath 会失败或落到 Xcode 等糟糕体验。
   * 项目知识 .md 不在 KnowledgePanel 全局知识树里，仍走系统默认应用打开。
   */
  const handleOpenMd = async (mdRelPath: string) => {
    if (!mdRelPath.startsWith('projects/')) {
      window.dispatchEvent(new CustomEvent('soul-open-knowledge-file', {
        detail: { avatarId, relativePath: mdRelPath },
      }))
      return
    }
    try {
      const ret = await window.electronAPI.openMdFile(avatarId, mdRelPath)
      if (!ret.ok) {
        const reason = ret.error ?? '未知错误'
        console.error('[SourceCitation] openMdFile 拒绝:', mdRelPath, reason)
        safeLogEvent('error', 'source-citation-open-md-failed', `${mdRelPath} | ${reason}`)
        window.alert(`打开「${mdRelPath}」失败：${reason}`)
      }
    } catch (err: unknown) {
      const detail = describeError(err)
      console.error('[SourceCitation] openMdFile 异常:', detail)
      safeLogEvent('error', 'source-citation-open-md-exception', `${mdRelPath} | ${detail}`)
      window.alert(`打开「${mdRelPath}」失败：${detail}`)
    }
  }

  /** 从 knowledge/foo.md 提取展示用文件名 foo.md */
  const mdDisplayName = (mdPath: string): string => {
    const slash = mdPath.lastIndexOf('/')
    return slash >= 0 ? mdPath.slice(slash + 1) : mdPath
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

  // —— 分支 3 + 4 合并：每个 result 各自渲染一个 chip —— //
  // 旧实现把 "全部 null" 折叠成不可点 chip，且 result.exists=false 也只是灰色 span，丢失了
  // 用户跳转到 markdown 源的机会。新实现：raw_file 缺失或物理文件丢失时仍渲染**可点击**的
  // 兜底 chip，调用 openMdFile 让系统默认 app 打开 .md。
  return (
    <span className={GROUP_CLASS}>
      {results.map((result, idx) => {
        const mdPath = mdPaths[idx]
        const mdName = mdDisplayName(mdPath)

        // raw_file 字段缺失 → 兜底打开 .md
        if (result === null) {
          return (
            <button
              key={`${idx}-md-${mdPath}`}
              type="button"
              onClick={() => { void handleOpenMd(mdPath) }}
              title={`原始文件未挂载，点击打开 markdown 源：${mdName}`}
              aria-label={`打开 markdown 源 ${mdName}`}
              className={CHIP_MISSING_CLASS}
            >
              <span aria-hidden="true">📄</span>
              <span>{mdName}</span>
            </button>
          )
        }

        // raw_file 存在且物理文件在 → 首选打开原始文件
        if (result.exists) {
          return (
            <button
              key={`${idx}-raw-${result.rawRelPath}`}
              type="button"
              onClick={() => { void handleOpen(result.rawRelPath, result.displayName) }}
              title={`用系统默认应用打开：${result.displayName}`}
              aria-label={`打开原始文件 ${result.displayName}`}
              className={CHIP_BUTTON_CLASS}
            >
              <span aria-hidden="true">📎</span>
              <span>{result.displayName}</span>
            </button>
          )
        }

        // raw_file 写了路径但物理文件丢失（_raw/ 目录未挂载或单文件被删）→ 降级打开 .md
        return (
          <button
            key={`${idx}-fallback-${mdPath}`}
            type="button"
            onClick={() => { void handleOpenMd(mdPath) }}
            title={`原始文件已被删除或迁移（${result.rawRelPath}），点击打开 markdown 源`}
            aria-label={`原始文件丢失，打开 markdown 源 ${mdName}`}
            className={CHIP_MISSING_CLASS}
          >
            <span aria-hidden="true">⚠️</span>
            <span>{result.displayName}</span>
          </button>
        )
      })}
    </span>
  )
}
