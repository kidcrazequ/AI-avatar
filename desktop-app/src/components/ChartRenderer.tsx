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

// ─── ECharts option 预处理 helpers（模块级，零 closure，effect 依赖友好）───

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

/**
 * 防御性 schema 转换：检测 LLM 输出的 Chart.js 格式并自动转成 ECharts 格式。
 *
 * **背景**：本项目用 ECharts，但 LLM 训练数据里 Chart.js 更流行，会偶尔
 * drift 到 Chart.js 的 `{type, data: {labels, datasets}}` 格式。直接把这种
 * option 喂给 ECharts.setOption 会抛 "Cannot create property 'series' on
 * boolean 'true'" 这类晦涩错误（ECharts 内部 type coercion 失败）。这里检测
 * 后自动转换，给 LLM 兜底。
 *
 * 支持转换：line / bar / pie / doughnut / scatter / radar
 */
function detectChartJsFormat(opt: Record<string, unknown>): boolean {
  const dataField = opt.data
  return (
    typeof opt.type === 'string' &&
    typeof dataField === 'object' &&
    dataField !== null &&
    Array.isArray((dataField as Record<string, unknown>).labels) &&
    Array.isArray((dataField as Record<string, unknown>).datasets) &&
    // 防误判：ECharts 完整 option 同时不会缺这三个字段
    opt.series === undefined &&
    opt.xAxis === undefined &&
    opt.yAxis === undefined
  )
}

function convertChartJsToECharts(opt: Record<string, unknown>): Record<string, unknown> {
  const type = String(opt.type)
  const data = opt.data as Record<string, unknown>
  const labels = (data.labels as Array<string | number>) || []
  const datasets = (data.datasets as Array<Record<string, unknown>>) || []
  const options = (opt.options as Record<string, unknown>) || {}
  const plugins = (options.plugins as Record<string, unknown>) || {}
  const titlePlugin = (plugins.title as Record<string, unknown>) || {}
  const titleText = (titlePlugin.text as string) || (opt.title as string) || '数据图表'

  // null → '-'（ECharts 用 '-' 表示数据缺口，会在折线图里留 gap）
  const normalizeData = (arr: unknown[]): unknown[] =>
    arr.map((v) => (v === null || v === undefined ? '-' : v))

  if (type === 'pie' || type === 'doughnut') {
    const ds = datasets[0] || {}
    const dsData = (ds.data as Array<number | null>) || []
    const pieData = dsData.map((v, i) => ({
      name: String(labels[i] ?? `项 ${i + 1}`),
      value: v === null ? 0 : v,
    }))
    return {
      title: { text: titleText },
      series: [
        {
          type: 'pie',
          name: (ds.label as string) || '',
          data: pieData,
          radius: type === 'doughnut' ? ['45%', '70%'] : '70%',
        },
      ],
    }
  }

  // line / bar / scatter / radar / 其他笛卡尔系图
  return {
    title: { text: titleText },
    tooltip: { trigger: 'axis' },
    ...(datasets.length > 1 ? { legend: {} } : {}),
    xAxis: { type: 'category', data: labels },
    yAxis: { type: 'value' },
    series: datasets.map((ds) => ({
      type,
      name: (ds.label as string) || '',
      data: normalizeData((ds.data as unknown[]) || []),
    })),
  }
}

/** 进入 ECharts setOption 前的预处理：先做 schema 转换，再注入安全 grid */
function normalizeOption(opt: Record<string, unknown>): Record<string, unknown> {
  if (detectChartJsFormat(opt)) {
    console.warn('[ChartRenderer] 检测到 Chart.js 格式输入，自动转换为 ECharts。请检查 draw-chart skill 是否被 LLM 正确遵循。')
    return withSafeGrid(convertChartJsToECharts(opt))
  }
  return withSafeGrid(opt)
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

  // 所有 schema normalize / chart-js 转换 helpers 都提到组件外（withSafeGrid /
  // detectChartJsFormat / convertChartJsToECharts / normalizeOption），避免
  // 在组件 body 内造成 useEffect 的 stale closure 问题（react-hooks/exhaustive-deps）。

  // loaded 后初始化 chart 实例
  useEffect(() => {
    if (!loaded || !containerRef.current || !_echartsCore) return

    instanceRef.current = _echartsCore.init(containerRef.current, 'pixel', {
      renderer: 'canvas',
    })
    instanceRef.current.setOption(normalizeOption(option), true)

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
      instanceRef.current.setOption(normalizeOption(option), true)
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
