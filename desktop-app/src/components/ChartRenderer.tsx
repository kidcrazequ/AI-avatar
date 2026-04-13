/**
 * ChartRenderer.tsx — ECharts 图表渲染器，包一层像素卡片，供聊天消息内联展示。
 *
 * 数据流：
 *   MessageBubble 的 react-markdown `code` component 拦截 ```chart 代码块
 *   → JSON.parse 得到 ECharts option
 *   → 传入本组件
 *   → 本组件动态 import echarts + 注册 pixel 主题 + 渲染
 *
 * 错误处理：
 *   - JSON 解析失败：由上游降级为原 <pre>（本组件不参与）
 *   - ECharts 初始化/渲染失败：ErrorBoundary 兜底显示原 JSON + 红框
 *
 * @author zhi.qu
 * @date 2026-04-13
 */

import { Component, useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react'

interface ChartRendererProps {
  /** ECharts option 对象（由 LLM 输出的 ```chart JSON 解析得来） */
  option: Record<string, unknown>
  /** 原始 JSON 字符串，用于错误降级展示 */
  rawJson?: string
}

interface ErrorBoundaryState {
  hasError: boolean
  errorMessage: string
}

class ChartErrorBoundary extends Component<
  { children: ReactNode; rawJson?: string },
  ErrorBoundaryState
> {
  constructor(props: { children: ReactNode; rawJson?: string }) {
    super(props)
    this.state = { hasError: false, errorMessage: '' }
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, errorMessage: error.message }
  }

  componentDidCatch(error: Error): void {
    console.error('[ChartRenderer] 渲染失败:', error)
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div
          role="alert"
          className="my-3 border-2 border-px-danger bg-px-bg p-3"
          aria-label="图表渲染失败"
        >
          <div className="font-game text-[11px] tracking-wider text-px-danger mb-2">
            ⚠ CHART RENDER FAILED
          </div>
          <div className="text-[12px] text-px-text-dim mb-2 font-body">
            {this.state.errorMessage || '未知错误'}
          </div>
          {this.props.rawJson && (
            <pre className="text-[11px] text-px-text-dim font-mono overflow-x-auto max-h-40">
              {this.props.rawJson}
            </pre>
          )}
        </div>
      )
    }
    return this.props.children
  }
}

/**
 * ECharts 懒加载状态：首次渲染时异步导入模块 + 注册主题。
 * 加载完成后缓存到模块级变量避免重复加载。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _echartsCore: any = null
let _echartsLoaded = false
let _echartsLoadingPromise: Promise<void> | null = null

async function ensureEchartsLoaded(): Promise<void> {
  if (_echartsLoaded) return
  if (_echartsLoadingPromise) return _echartsLoadingPromise

  _echartsLoadingPromise = (async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const core = (await import('echarts/core')) as any
    const charts = await import('echarts/charts')
    const components = await import('echarts/components')
    const renderers = await import('echarts/renderers')
    core.use([
      charts.LineChart,
      charts.BarChart,
      charts.PieChart,
      charts.ScatterChart,
      charts.RadarChart,
      charts.HeatmapChart,
      components.TitleComponent,
      components.TooltipComponent,
      components.GridComponent,
      components.LegendComponent,
      components.DataZoomComponent,
      components.MarkLineComponent,
      components.MarkPointComponent,
      components.AriaComponent,
      renderers.CanvasRenderer,
    ])
    const { registerPixelTheme } = await import('../lib/echarts-pixel-theme')
    registerPixelTheme()
    _echartsCore = core
    _echartsLoaded = true
  })()

  return _echartsLoadingPromise
}

/**
 * 主组件。必须给容器固定 width/height，否则 ECharts Canvas 会渲染为空。
 */
function ChartRendererInner({ option }: ChartRendererProps): ReactElement {
  const containerRef = useRef<HTMLDivElement>(null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const instanceRef = useRef<any>(null)
  const [loaded, setLoaded] = useState(_echartsLoaded)
  const [loadError, setLoadError] = useState<string | null>(null)

  // 首次挂载：加载 echarts
  useEffect(() => {
    if (!loaded) {
      ensureEchartsLoaded()
        .then(() => setLoaded(true))
        .catch((err: Error) => {
          console.error('[ChartRenderer] 加载 echarts 失败:', err)
          setLoadError(err.message)
        })
    }
  }, [loaded])

  /** 注入默认 grid 间距，防止 Y 轴 name 和 title/subtext 重叠 */
  function withSafeGrid(opt: Record<string, unknown>): Record<string, unknown> {
    const safe = { ...opt }
    if (!safe.grid) {
      safe.grid = { top: 80, left: 80 }
    } else if (typeof safe.grid === 'object' && !Array.isArray(safe.grid)) {
      const g = safe.grid as Record<string, unknown>
      if (g.top === undefined) g.top = 80
      if (g.left === undefined) g.left = 80
    }
    return safe
  }

  // loaded 后初始化 chart 实例
  useEffect(() => {
    if (!loaded || !containerRef.current || !_echartsCore) return

    instanceRef.current = _echartsCore.init(containerRef.current, 'pixel', {
      renderer: 'canvas',
    })
    instanceRef.current.setOption(withSafeGrid(option), true)

    const handleResize = () => instanceRef.current?.resize()
    window.addEventListener('resize', handleResize)
    return () => {
      window.removeEventListener('resize', handleResize)
      instanceRef.current?.dispose()
      instanceRef.current = null
    }
  }, [loaded, option])

  // option 变化时更新（只有 instance 已存在才 setOption）
  useEffect(() => {
    if (instanceRef.current) {
      instanceRef.current.setOption(withSafeGrid(option), true)
    }
  }, [option])

  if (loadError) {
    throw new Error(`加载 ECharts 失败: ${loadError}`)
  }

  return (
    <div
      ref={containerRef}
      style={{ width: '100%', height: '320px' }}
    >
      {!loaded && (
        <div className="h-full flex items-center justify-center">
          <div className="font-game text-[11px] text-px-text-dim tracking-wider animate-pulse">
            LOADING CHART...
          </div>
        </div>
      )}
    </div>
  )
}

export default function ChartRenderer({ option, rawJson }: ChartRendererProps): ReactElement {
  // 从 option 中提取标题用于 aria-label
  const titleText = (() => {
    const title = option.title as { text?: string; subtext?: string } | Array<{ text?: string }> | undefined
    if (!title) return '数据图表'
    if (Array.isArray(title)) return title[0]?.text || '数据图表'
    return title.text || '数据图表'
  })()

  return (
    <ChartErrorBoundary rawJson={rawJson}>
      <div
        role="img"
        aria-label={titleText}
        tabIndex={0}
        className="my-3 border-2 border-px-primary bg-px-bg p-3 shadow-pixel"
      >
        <ChartRendererInner option={option} rawJson={rawJson} />
      </div>
    </ChartErrorBoundary>
  )
}
