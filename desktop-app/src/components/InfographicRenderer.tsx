/**
 * InfographicRenderer.tsx — AntV Infographic 渲染器（信息图：列表/对比/序列/SWOT/思维导图等 84+ 模板）。
 *
 * 数据流：
 *   MessageBubble 的 react-markdown `code` component 拦截 ```infographic 代码块
 *   → 传入本组件
 *   → 本组件动态 import @antv/infographic + new Infographic({ container }).render(dsl)
 *   → 渲染出 SVG 注入容器
 *
 * 错误处理：
 *   - DSL 语法错误：ErrorBoundary 兜底 + 红框显示原始代码 + 错误消息
 *   - 流式输出未完成：MessageBubble 层通过启发式（首行 `infographic` 关键字 + 至少 2 行）预校验
 *
 * 为什么不复用 ChartRenderer 模式以外的实现：
 *   - 和 ChartRenderer / MermaidRenderer 三件套保持一致的懒加载 + 错误边界 + 像素外框风格
 *   - 用户在聊天里看到的所有可视化都有统一的 "border-2 border-px-primary bg-px-bg p-3 shadow-pixel" 容器
 *
 * @author claude
 * @date 2026-04-16
 */

import { Component, useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react'

interface InfographicRendererProps {
  /** 完整的 infographic DSL 源码（不含 ```infographic fence） */
  dsl: string
}

interface ErrorBoundaryState {
  hasError: boolean
  errorMessage: string
}

class InfographicErrorBoundary extends Component<
  { children: ReactNode; dsl: string },
  ErrorBoundaryState
> {
  constructor(props: { children: ReactNode; dsl: string }) {
    super(props)
    this.state = { hasError: false, errorMessage: '' }
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, errorMessage: error.message }
  }

  componentDidCatch(error: Error): void {
    console.error('[InfographicRenderer] 渲染失败:', error)
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div
          role="alert"
          className="my-3 border-2 border-px-danger bg-px-bg p-3"
          aria-label="Infographic 渲染失败"
        >
          <div className="font-game text-[11px] tracking-wider text-px-danger mb-2">
            ⚠ INFOGRAPHIC RENDER FAILED
          </div>
          <div className="text-[12px] text-px-text-dim mb-2 font-body">
            {this.state.errorMessage || '未知错误'}
          </div>
          <pre className="text-[11px] text-px-text-dim font-mono overflow-x-auto max-h-40">
            {this.props.dsl}
          </pre>
        </div>
      )
    }
    return this.props.children
  }
}

/**
 * @antv/infographic 懒加载 + 单例缓存。
 * 整包 ESM 包含 ~93 个内置模板和资源，首次加载较大（实测 1-2 MB），
 * 不打入初始 bundle，等用户真正聊到信息图时才加载。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _Infographic: any = null
let _loaded = false
let _loadingPromise: Promise<void> | null = null

async function ensureInfographicLoaded(): Promise<void> {
  if (_loaded) return
  if (_loadingPromise) return _loadingPromise

  _loadingPromise = (async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod = (await import('@antv/infographic')) as any
    _Infographic = mod.Infographic
    if (!_Infographic) {
      throw new Error('@antv/infographic 未导出 Infographic 类')
    }
    _loaded = true
  })()

  return _loadingPromise
}

/**
 * 主组件：懒加载 + 创建 Infographic 实例 + 渲染 DSL。
 * 容器需要明确尺寸否则 SVG 会渲染为 0 高度。
 */
function InfographicRendererInner({ dsl }: InfographicRendererProps): ReactElement {
  const containerRef = useRef<HTMLDivElement>(null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const instanceRef = useRef<any>(null)
  const [loaded, setLoaded] = useState(_loaded)
  const [renderError, setRenderError] = useState<string | null>(null)

  // 首次挂载：加载 @antv/infographic
  useEffect(() => {
    if (!loaded) {
      ensureInfographicLoaded()
        .then(() => setLoaded(true))
        .catch((err: Error) => {
          console.error('[InfographicRenderer] 加载 @antv/infographic 失败:', err)
          setRenderError(`加载 @antv/infographic 失败: ${err.message}`)
        })
    }
  }, [loaded])

  // loaded 后创建实例并渲染
  useEffect(() => {
    if (!loaded || !_Infographic || !containerRef.current) return

    try {
      // 销毁前一个实例（DSL 变化时）
      if (instanceRef.current && typeof instanceRef.current.destroy === 'function') {
        try { instanceRef.current.destroy() } catch { /* ignore */ }
      }
      // 清空容器避免 SVG 重影
      containerRef.current.innerHTML = ''

      instanceRef.current = new _Infographic({
        container: containerRef.current,
        width: '100%',
        height: 'auto',
        // editable: false — 聊天消息里不需要编辑器，会污染 hover 状态
      })
      instanceRef.current.render(dsl)
      setRenderError(null)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[InfographicRenderer] 渲染失败:', msg)
      setRenderError(msg)
    }

    return () => {
      if (instanceRef.current && typeof instanceRef.current.destroy === 'function') {
        try { instanceRef.current.destroy() } catch { /* ignore */ }
        instanceRef.current = null
      }
    }
  }, [loaded, dsl])

  if (renderError) {
    throw new Error(renderError)
  }

  return (
    <div
      ref={containerRef}
      className="infographic-container overflow-x-auto min-h-[120px]"
    >
      {!loaded && (
        <div className="h-24 flex items-center justify-center">
          <div className="font-game text-[11px] text-px-text-dim tracking-wider animate-pulse">
            LOADING INFOGRAPHIC...
          </div>
        </div>
      )}
    </div>
  )
}

export default function InfographicRenderer({ dsl }: InfographicRendererProps): ReactElement {
  return (
    <InfographicErrorBoundary dsl={dsl}>
      <div
        role="img"
        aria-label="Infographic 信息图"
        tabIndex={0}
        className="my-3 border-2 border-px-primary bg-px-bg p-3 shadow-pixel"
      >
        <InfographicRendererInner dsl={dsl} />
      </div>
    </InfographicErrorBoundary>
  )
}
