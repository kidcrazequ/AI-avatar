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

import { Component, useCallback, useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react'
import LightboxModal from './LightboxModal'
import RendererToolbar from './RendererToolbar'
import { svgElementToPngDataUrl } from '../utils/export-image'

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
 * 主组件：懒加载 + 创建 Infographic 实例 + 渲染 DSL + 接入工具栏（放大/导出/复制）。
 *
 * 容器需要明确尺寸否则 SVG 会渲染为 0 高度。
 *
 * 与 Mermaid 不同的是：@antv/infographic 是命令式 API，SVG 直接挂到容器 DOM 上。
 * Lightbox 复用策略：render 完成后用 requestAnimationFrame 抢一帧，把
 * containerRef.current.innerHTML 快照成静态 SVG 字符串，注入弹窗。Infographic
 * 本身是静态信息图（无交互），快照足以满足放大查看场景。
 */
function InfographicRendererCore({ dsl }: InfographicRendererProps): ReactElement {
  const containerRef = useRef<HTMLDivElement>(null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const instanceRef = useRef<any>(null)
  const [loaded, setLoaded] = useState(_loaded)
  const [renderError, setRenderError] = useState<string | null>(null)
  /** 渲染完成后的 SVG 字符串快照，仅供 Lightbox 注入（toolbar 直接用 live DOM） */
  const [svgSnapshot, setSvgSnapshot] = useState<string>('')
  const [lightboxOpen, setLightboxOpen] = useState(false)

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

    let cancelled = false
    let rafId: number | null = null

    try {
      // 销毁前一个实例（DSL 变化时）
      if (instanceRef.current && typeof instanceRef.current.destroy === 'function') {
        try {
          instanceRef.current.destroy()
        } catch (e) {
          // 实例可能已被外部销毁；清理路径下错误可忽略，仅记录便于排障
          console.warn('[InfographicRenderer] 旧实例 destroy 失败，可忽略:', e)
        }
      }
      // 清空容器避免 SVG 重影。此处不主动 setSvgSnapshot('')：
      //   1) react-hooks/set-state-in-effect 不允许在 effect body 直接 setState；
      //   2) DSL 变化场景极少（消息固化后不再变），race window 仅 1 帧可接受；
      //   3) RAF 回调里会用新值覆盖旧 snapshot。
      containerRef.current.innerHTML = ''

      instanceRef.current = new _Infographic({
        container: containerRef.current,
        width: '100%',
        height: 'auto',
        // editable: false — 聊天消息里不需要编辑器，会污染 hover 状态
      })
      instanceRef.current.render(dsl)
      // 不再 setRenderError(null)：违反 react-hooks/set-state-in-effect。
      // 恢复路径改为外层 InfographicRenderer 的 key={dsl}：dsl 变化时
      // 整个 ErrorBoundary 卸载重建，renderError state 自然回到初始 null。

      // 抢下一帧让 SVG 完成挂载，再快照 outerHTML 给 Lightbox 用
      // 注：直接同步读 innerHTML 在某些 infographic 模板上拿到的是空，需 raf 等绘制
      rafId = requestAnimationFrame(() => {
        if (cancelled || !containerRef.current) return
        const svgEl = containerRef.current.querySelector('svg')
        if (svgEl) {
          setSvgSnapshot(containerRef.current.innerHTML)
        }
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[InfographicRenderer] 渲染失败:', msg)
      // 这里 setState 是为了下一次 render 时 if(renderError) throw → ErrorBoundary 接管。
      // 这是 React 官方推荐的"async error → ErrorBoundary"模式，
      // react-hooks/set-state-in-effect 在该用例下属误报，安全 disable。
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setRenderError(msg)
    }

    return () => {
      cancelled = true
      if (rafId !== null) cancelAnimationFrame(rafId)
      if (instanceRef.current && typeof instanceRef.current.destroy === 'function') {
        try {
          instanceRef.current.destroy()
        } catch (e) {
          console.warn('[InfographicRenderer] cleanup destroy 失败，可忽略:', e)
        }
        instanceRef.current = null
      }
    }
  }, [loaded, dsl])

  /** 工具栏导出 PNG：从 bubble 内的真实 SVG DOM 节点转换 */
  const getPngDataUrl = useCallback(async (): Promise<string> => {
    const svgEl = containerRef.current?.querySelector('svg')
    if (!svgEl) throw new Error('Infographic SVG 尚未渲染')
    return svgElementToPngDataUrl(svgEl as SVGElement)
  }, [])

  if (renderError) {
    throw new Error(renderError)
  }

  return (
    <div
      role="img"
      aria-label="Infographic 信息图"
      tabIndex={0}
      className="my-3 border-2 border-px-primary bg-px-bg p-3 shadow-pixel group relative"
    >
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

      {svgSnapshot && (
        <RendererToolbar
          onZoom={() => setLightboxOpen(true)}
          getPngDataUrl={getPngDataUrl}
          filenameBase="infographic"
          ariaLabelPrefix="Infographic 信息图"
        />
      )}

      {svgSnapshot && (
        <LightboxModal
          isOpen={lightboxOpen}
          onClose={() => setLightboxOpen(false)}
          title="INFOGRAPHIC"
        >
          <div
            className="w-[90vw] h-[80vh] flex items-center justify-center
              [&_svg]:!max-w-none [&_svg]:!max-h-full [&_svg]:!w-full [&_svg]:!h-auto"
            // 快照来源是 @antv/infographic 自己生成的 SVG，可信注入
            dangerouslySetInnerHTML={{ __html: svgSnapshot }}
          />
        </LightboxModal>
      )}
    </div>
  )
}

export default function InfographicRenderer({ dsl }: InfographicRendererProps): ReactElement {
  // key={dsl} 让 dsl 变化时整体卸载重建：
  //   1) ErrorBoundary 内部 hasError 重置为 false（class state 在 unmount 时丢弃）
  //   2) Core 的 renderError state 也回到初始 null，无需在 effect 内手动清理
  return (
    <InfographicErrorBoundary dsl={dsl} key={dsl}>
      <InfographicRendererCore dsl={dsl} />
    </InfographicErrorBoundary>
  )
}
