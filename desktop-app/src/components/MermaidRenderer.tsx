/**
 * MermaidRenderer.tsx — Mermaid 图表渲染器（甘特/流程/时序/思维导图/看板/饼图/状态机/ER/类/git 等）。
 *
 * 数据流：
 *   MessageBubble 的 react-markdown `code` component 拦截 ```mermaid 代码块
 *   → 传入本组件
 *   → 本组件动态 import mermaid + 渲染 SVG
 *   → dangerouslySetInnerHTML 注入
 *
 * 错误处理：
 *   - 语法错误：ErrorBoundary 兜底 + 红框显示原始代码 + 错误消息
 *   - 流式输出未完成：由上游 MessageBubble 层通过 mermaid.parse 预校验检测
 *
 * 为什么不用 remark-mermaid 插件：项目已有 ChartRenderer 的懒加载 + 错误边界
 * 模式，新增组件保持架构一致性，同时避免把 mermaid 强塞进 markdown 管线
 * 影响其它 markdown 消费点（KnowledgeViewer / MemoryPanel 等不需要 mermaid）
 *
 * @author claude
 * @date 2026-04-15
 */

import { Component, useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react'

interface MermaidRendererProps {
  /** mermaid 源码（不含 ```mermaid fence） */
  code: string
}

interface ErrorBoundaryState {
  hasError: boolean
  errorMessage: string
}

class MermaidErrorBoundary extends Component<
  { children: ReactNode; code: string },
  ErrorBoundaryState
> {
  constructor(props: { children: ReactNode; code: string }) {
    super(props)
    this.state = { hasError: false, errorMessage: '' }
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, errorMessage: error.message }
  }

  componentDidCatch(error: Error): void {
    console.error('[MermaidRenderer] 渲染失败:', error)
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div
          role="alert"
          className="my-3 border-2 border-px-danger bg-px-bg p-3"
          aria-label="Mermaid 图表渲染失败"
        >
          <div className="font-game text-[11px] tracking-wider text-px-danger mb-2">
            ⚠ MERMAID RENDER FAILED
          </div>
          <div className="text-[12px] text-px-text-dim mb-2 font-body">
            {this.state.errorMessage || '未知错误'}
          </div>
          <pre className="text-[11px] text-px-text-dim font-mono overflow-x-auto max-h-40">
            {this.props.code}
          </pre>
        </div>
      )
    }
    return this.props.children
  }
}

/**
 * mermaid 懒加载 + 单例初始化。
 * 首次渲染时异步导入 + initialize，后续调用直接复用。
 * 约 800KB gz 的依赖，不打包进初始 bundle。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _mermaid: any = null
let _mermaidLoaded = false
let _mermaidLoadingPromise: Promise<void> | null = null

async function ensureMermaidLoaded(): Promise<void> {
  if (_mermaidLoaded) return
  if (_mermaidLoadingPromise) return _mermaidLoadingPromise

  _mermaidLoadingPromise = (async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod = (await import('mermaid')) as any
    const mermaid = mod.default || mod
    mermaid.initialize({
      startOnLoad: false,
      theme: 'base',
      securityLevel: 'strict',
      fontFamily: '"JetBrains Mono", monospace',
      themeVariables: {
        // 对齐 tailwind.config.js 的 px 主题：LED 粉 × void-black × 薄荷绿
        // 参见 desktop-app/tailwind.config.js colors.px
        darkMode: true,
        background: '#0A0A0F',        // px.bg
        primaryColor: '#12121A',      // px.surface（节点填充）
        primaryTextColor: '#E8E8EC',  // px.text（节点文字）
        primaryBorderColor: '#FFB0C8', // px.primary（LED 粉边框）
        secondaryColor: '#1A1A25',    // px.elevated
        secondaryTextColor: '#E8E8EC',
        secondaryBorderColor: '#50D8A0', // px.accent 薄荷绿
        tertiaryColor: '#222230',     // px.hover
        tertiaryTextColor: '#E8E8EC',
        tertiaryBorderColor: '#9898A8',
        lineColor: '#FFB0C8',         // px.primary 连线
        textColor: '#E8E8EC',
        mainBkg: '#12121A',
        secondBkg: '#1A1A25',
        tertiaryBkg: '#222230',
        nodeBorder: '#FFB0C8',
        clusterBkg: '#1A1A25',
        clusterBorder: '#2A2A3A',
        titleColor: '#FFB0C8',
        edgeLabelBackground: '#0A0A0F',
        // 甘特图
        gridColor: '#2A2A3A',
        taskBkgColor: '#1A1A25',
        taskTextColor: '#E8E8EC',
        taskTextLightColor: '#E8E8EC',
        taskTextOutsideColor: '#E8E8EC',
        taskTextClickableColor: '#FFB0C8',
        activeTaskBkgColor: '#FFB0C8',
        activeTaskBorderColor: '#FFB0C8',
        doneTaskBkgColor: '#50D8A0',
        doneTaskBorderColor: '#50D8A0',
        critBkgColor: '#E85858',
        critBorderColor: '#E85858',
        sectionBkgColor: '#12121A',
        sectionBkgColor2: '#1A1A25',
        todayLineColor: '#F0C060',
        // 时序图
        actorBkg: '#12121A',
        actorBorder: '#FFB0C8',
        actorTextColor: '#E8E8EC',
        actorLineColor: '#9898A8',
        signalColor: '#FFB0C8',
        signalTextColor: '#E8E8EC',
        labelBoxBkgColor: '#1A1A25',
        labelBoxBorderColor: '#FFB0C8',
        labelTextColor: '#E8E8EC',
        loopTextColor: '#E8E8EC',
        noteBkgColor: '#1A1A25',
        noteBorderColor: '#50D8A0',
        noteTextColor: '#E8E8EC',
        // 状态图
        labelColor: '#E8E8EC',
        errorBkgColor: '#E85858',
        errorTextColor: '#E8E8EC',
      },
    })
    _mermaid = mermaid
    _mermaidLoaded = true
  })()

  return _mermaidLoadingPromise
}

/**
 * 主组件：懒加载 + 渲染 SVG + 注入 DOM。
 * 用唯一 id 避免 mermaid 的 DOM 冲突（同一消息里多个甘特图）。
 */
function MermaidRendererInner({ code }: MermaidRendererProps): ReactElement {
  const containerRef = useRef<HTMLDivElement>(null)
  const [loaded, setLoaded] = useState(_mermaidLoaded)
  const [svg, setSvg] = useState<string>('')
  const [renderError, setRenderError] = useState<string | null>(null)

  // 首次挂载：加载 mermaid
  useEffect(() => {
    if (!loaded) {
      ensureMermaidLoaded()
        .then(() => setLoaded(true))
        .catch((err: Error) => {
          console.error('[MermaidRenderer] 加载 mermaid 失败:', err)
          setRenderError(`加载 mermaid 失败: ${err.message}`)
        })
    }
  }, [loaded])

  // loaded 后渲染
  useEffect(() => {
    if (!loaded || !_mermaid) return
    let cancelled = false
    const id = `mermaid-${Math.random().toString(36).slice(2, 10)}`
    ;(async () => {
      try {
        const { svg: rendered } = await _mermaid.render(id, code)
        if (!cancelled) {
          setSvg(rendered)
          setRenderError(null)
        }
      } catch (err) {
        if (!cancelled) {
          const msg = err instanceof Error ? err.message : String(err)
          console.error('[MermaidRenderer] 渲染失败:', msg)
          setRenderError(msg)
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [loaded, code])

  if (renderError) {
    throw new Error(renderError)
  }

  return (
    <div
      ref={containerRef}
      className="mermaid-container overflow-x-auto"
      // mermaid 渲染的 SVG 已做 HTML 转义（securityLevel: 'strict'），安全注入
      dangerouslySetInnerHTML={svg ? { __html: svg } : undefined}
    >
      {!svg && (
        <div className="h-24 flex items-center justify-center">
          <div className="font-game text-[11px] text-px-text-dim tracking-wider animate-pulse">
            LOADING MERMAID...
          </div>
        </div>
      )}
    </div>
  )
}

export default function MermaidRenderer({ code }: MermaidRendererProps): ReactElement {
  return (
    <MermaidErrorBoundary code={code}>
      <div
        role="img"
        aria-label="Mermaid 图表"
        tabIndex={0}
        className="my-3 border-2 border-px-primary bg-px-bg p-3 shadow-pixel"
      >
        <MermaidRendererInner code={code} />
      </div>
    </MermaidErrorBoundary>
  )
}
