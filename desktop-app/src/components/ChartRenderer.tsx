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

import { Component, useCallback, useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react'
import LightboxModal from './LightboxModal'
import RendererToolbar from './RendererToolbar'
import { useArtifactStore } from '../stores/artifactStore'

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
      charts.GaugeChart,
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
  })().catch((err: unknown) => {
    // Reset so a future mount can retry the dynamic import instead of
    // latching every ChartRenderer instance on a permanent load failure.
    _echartsLoadingPromise = null
    throw err
  })

  return _echartsLoadingPromise
}

// ─── ECharts option 预处理 helpers（模块级，零 closure，effect 依赖友好）───

/**
 * 注入安全的 grid 间距，防止顶部元素互相覆盖。
 *
 * 之前只把缺省 grid.top 填 80，但当 LLM 同时输出 title.subtext + 双 Y 轴
 * （每个都有 name）时，80px 不够，subtext 会撞到 Y 轴 name（2026-05-21 用户反馈）。
 *
 * 现在按实际顶部元素动态算最小顶部空间，并**强制**覆盖 LLM 给的过小值
 * （之前只在 undefined 时填，给了 30 就保留 30）。各元素的空间预算来自
 * ECharts 默认字号 + 4px buffer，多次实测：
 *   - 基线（无 title 无轴名）           : 40
 *   - 有 title.text                    : +30
 *   - 有 title.subtext                 : +20
 *   - 有 yAxis.name（左轴或右轴）       : +20
 *   - 同时有左右两个 yAxis 且各自有 name : 再 +10（两行名称错位时的安全 padding）
 *
 * 左侧 grid.left 同样：有左 yAxis.name 时至少 70，否则保留 LLM 给的值（最小 40）。
 */
function computeMinGridTop(opt: Record<string, unknown>): number {
  let top = 40
  const title = opt.title
  if (title && typeof title === 'object' && !Array.isArray(title)) {
    const t = title as Record<string, unknown>
    if (typeof t.text === 'string' && t.text.trim().length > 0) top += 30
    if (typeof t.subtext === 'string' && t.subtext.trim().length > 0) top += 20
  } else if (Array.isArray(title)) {
    // title 数组形式：多 title 时按最长那个估算（用满字段就 + 50）
    top += title.length > 0 ? 50 : 0
  }
  const yAxis = opt.yAxis
  const yAxes = Array.isArray(yAxis) ? yAxis : (yAxis ? [yAxis] : [])
  const yAxesWithName = yAxes.filter(
    a => a && typeof a === 'object' && typeof (a as Record<string, unknown>).name === 'string'
       && ((a as Record<string, unknown>).name as string).trim().length > 0
  )
  if (yAxesWithName.length > 0) top += 20
  if (yAxesWithName.length >= 2) top += 10
  // v0.6.18: 有 xAxis 被推到 top（dual xAxis 场景）则需要给顶部标签 + 轴名让出 ~36px。
  // 注意 autoPositionDualAxes 在 withSafeGrid 之前跑，这里看到的 position 已经是修正后的。
  const xAxis = opt.xAxis
  const xAxes = Array.isArray(xAxis) ? xAxis : (xAxis ? [xAxis] : [])
  const hasTopXAxis = xAxes.some(
    a => a && typeof a === 'object' && (a as Record<string, unknown>).position === 'top'
  )
  if (hasTopXAxis) top += 36
  // 顶部空间上限：避免极端情况把图表挤太小。160 在 720p / 1080p 都够用。
  return Math.min(top, 160)
}

/**
 * 当存在 bottom legend 时，每个 grid 的 bottom 必须为 legend 留够空间。
 * 之前没处理这块，导致多 grid 布局下底部轴标签和图例直接重叠（2026-05-21 实测）。
 * 50px 在 720p / 1080p 下足够装单行 legend + label 间距。
 */
function computeMinGridBottom(opt: Record<string, unknown>): number {
  const legend = opt.legend
  const legends = Array.isArray(legend) ? legend : (legend ? [legend] : [])
  const hasBottomLegend = legends.some(l => {
    if (!l || typeof l !== 'object') return false
    const o = l as Record<string, unknown>
    // 'bottom' 字段存在 = 显式放底部；缺省也常是 bottom（ECharts 主题约定）
    if (typeof o.bottom !== 'undefined') return true
    if (o.top === undefined && o.left === undefined && o.right === undefined) return true
    return false
  })
  return hasBottomLegend ? 70 : 50
}

/**
 * 给单个 grid 对象应用安全的 top/bottom/left。**强制覆盖**过小的值，不只是缺省时填。
 */
function applyMinGrid(g: Record<string, unknown>, minTop: number, minBottom: number): Record<string, unknown> {
  const out = { ...g }
  const num = (v: unknown): number =>
    typeof v === 'number' ? v : (typeof v === 'string' ? Number(v) : NaN)
  const existingTop = num(out.top)
  out.top = Number.isFinite(existingTop) ? Math.max(existingTop, minTop) : minTop
  const existingBottom = num(out.bottom)
  out.bottom = Number.isFinite(existingBottom) ? Math.max(existingBottom, minBottom) : minBottom
  const existingLeft = num(out.left)
  out.left = Number.isFinite(existingLeft) ? Math.max(existingLeft, 40) : 80
  return out
}

function withSafeGrid(opt: Record<string, unknown>): Record<string, unknown> {
  const safe = { ...opt }
  const minTop = computeMinGridTop(opt)
  const minBottom = computeMinGridBottom(opt)

  // 关键修复（2026-05-21 用户反馈"图又覆盖了"）：多 grid 子图布局下，
  // grid 是数组形式（[{...}, {...}]），之前的代码只走 `else if (!Array.isArray)`
  // 分支，整个绕过 → LLM 给的过小 top/bottom 直接生效 → 标题/轴名/legend 全撞一团。
  // 现在数组形式逐项应用 min top / min bottom。
  if (Array.isArray(safe.grid)) {
    safe.grid = safe.grid.map(g =>
      typeof g === 'object' && g !== null
        ? applyMinGrid(g as Record<string, unknown>, minTop, minBottom)
        : g
    )
  } else if (typeof safe.grid === 'object' && safe.grid !== null) {
    safe.grid = applyMinGrid(safe.grid as Record<string, unknown>, minTop, minBottom)
  } else {
    safe.grid = { top: minTop, bottom: minBottom, left: 80 }
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

/**
 * v0.6.16: 强制剥掉 LLM 显式指定的颜色，让像素主题 palette 接管。
 *
 * 背景：draw-chart skill 已明确写 "不得硬编码颜色"，但 LLM 训练数据里
 * Chart.js / 通用 ECharts 例子大量使用蓝色 itemStyle.color，LLM 经常
 * 复制粘贴默认蓝色覆盖主题。实测 215 机型截图：line 是默认蓝 #5470C6，
 * 与 LED 粉主题色不协调。
 *
 * 策略：剥掉 opt.color (top level) + 每个 series 的 color / itemStyle.color /
 * lineStyle.color，让 theme palette 完全接管。如果用户真的需要自定义颜色，
 * 应该改主题而不是单图覆盖（否则颜色一致性失控）。
 *
 * markPoint / markLine 的 color 不剥（这俩是注释类元素，需要醒目对比色）。
 */
function stripExplicitSeriesColors(opt: Record<string, unknown>): Record<string, unknown> {
  const stripped = { ...opt }

  // 剥 top-level color（覆盖整个主题 palette）
  if ('color' in stripped) delete stripped.color

  if (Array.isArray(stripped.series)) {
    stripped.series = (stripped.series as Array<Record<string, unknown>>).map(s => {
      const cleanSeries = { ...s }
      if ('color' in cleanSeries) delete cleanSeries.color
      if (cleanSeries.itemStyle && typeof cleanSeries.itemStyle === 'object') {
        const cleanItemStyle = { ...cleanSeries.itemStyle as Record<string, unknown> }
        if ('color' in cleanItemStyle) delete cleanItemStyle.color
        cleanSeries.itemStyle = cleanItemStyle
      }
      if (cleanSeries.lineStyle && typeof cleanSeries.lineStyle === 'object') {
        const cleanLineStyle = { ...cleanSeries.lineStyle as Record<string, unknown> }
        if ('color' in cleanLineStyle) delete cleanLineStyle.color
        cleanSeries.lineStyle = cleanLineStyle
      }
      return cleanSeries
    })
  }

  return stripped
}

/**
 * 双轴自动定位（v0.6.18 修复 2026-05-21 ENS-L262 抗震图踩坑）。
 *
 * LLM 经常给 2 个 yAxis（如"加速度" + "温度"）或 2 个 xAxis（如"测量点" + "温度阶段"）
 * 但**忘记**给第 2 个设 `position: 'right'` / `position: 'top'`。ECharts 默认 yAxis 全在左、
 * xAxis 全在底，两组刻度+轴名直接叠成一团（实测 ENS-L262 截图：刻度 60/50/40/30/20/10 和
 * 3/2/1 完全交叉重叠，轴名"加速度m/s²"和"温度°C"互相覆盖）。
 *
 * 防御策略：检测到 ≥2 个 yAxis/xAxis 时，**第 2 个**没设 position 就强制对面侧。
 * 已设 position 的尊重 LLM 选择（边缘情况：3 个 yAxis 这种基本不存在）。
 */
function autoPositionDualAxes(opt: Record<string, unknown>): Record<string, unknown> {
  const out = { ...opt }
  const pushToOpposite = (
    axes: unknown[],
    opposite: 'right' | 'top',
  ): unknown[] =>
    axes.map((a, i) => {
      if (i === 0) return a
      if (i !== 1) return a // 仅处理第 2 个
      if (!a || typeof a !== 'object') return a
      const ao = a as Record<string, unknown>
      if (ao.position !== undefined) return ao
      return { ...ao, position: opposite }
    })

  if (Array.isArray(out.yAxis) && out.yAxis.length >= 2) {
    out.yAxis = pushToOpposite(out.yAxis, 'right')
  }
  if (Array.isArray(out.xAxis) && out.xAxis.length >= 2) {
    out.xAxis = pushToOpposite(out.xAxis, 'top')
  }
  return out
}

/**
 * 强制 yAxis.name 居中 + 旋转（v0.6.18）。
 *
 * draw-chart skill 明文要求 LLM 给带 name 的 yAxis 配 `nameLocation: 'middle' + nameGap: 40 +
 * nameRotate: ±90`，否则轴名浮在轴顶部争抢标题空间。但 LLM 经常漏配 —— 现在渲染器兜底：
 *   - 有 name 且无 nameLocation → 强制 middle
 *   - 有 name 且无 nameRotate → 按 position（left/right）自动选 90/-90
 *   - 有 name 且无 nameGap → 强制 40
 *
 * 已显式配置的字段保留 LLM 选择（让进阶用户能微调）。
 */
function enforceYAxisNameLayout(opt: Record<string, unknown>): Record<string, unknown> {
  const out = { ...opt }
  const fixOne = (y: unknown): unknown => {
    if (!y || typeof y !== 'object') return y
    const yo = y as Record<string, unknown>
    if (typeof yo.name !== 'string' || yo.name.trim() === '') return yo
    const isRight = yo.position === 'right'
    const fixed: Record<string, unknown> = { ...yo }
    if (fixed.nameLocation === undefined) fixed.nameLocation = 'middle'
    if (fixed.nameGap === undefined) fixed.nameGap = 40
    if (fixed.nameRotate === undefined) fixed.nameRotate = isRight ? -90 : 90
    return fixed
  }
  if (Array.isArray(out.yAxis)) {
    out.yAxis = out.yAxis.map(fixOne)
  } else if (out.yAxis && typeof out.yAxis === 'object') {
    out.yAxis = fixOne(out.yAxis)
  }
  return out
}

/**
 * 强制 legend 位置为底部居中（主题默认值）。
 * LLM 经常写 legend.top / legend.right 把图例放到标题旁边导致文字重叠。
 * 实测 215 机型截图：legend "设备侧效率" 的粉色圆点叠在标题文字中间。
 */
function forceLegendBottom(opt: Record<string, unknown>): Record<string, unknown> {
  if (opt.legend && typeof opt.legend === 'object' && !Array.isArray(opt.legend)) {
    const legend = { ...opt.legend as Record<string, unknown> }
    delete legend.top
    delete legend.right
    delete legend.left
    legend.bottom = 12
    // 不删 legend.show 等其他合法字段
    return { ...opt, legend }
  }
  return opt
}

/** 进入 ECharts setOption 前的预处理：
 *  schema 转换 → 剥颜色 → 双轴对面侧定位 → yAxis 轴名居中 → 强制 legend 底部 → 安全 grid
 */
function normalizeOption(opt: Record<string, unknown>): Record<string, unknown> {
  let result = opt
  if (detectChartJsFormat(result)) {
    console.warn('[ChartRenderer] 检测到 Chart.js 格式输入，自动转换为 ECharts。请检查 draw-chart skill 是否被 LLM 正确遵循。')
    result = convertChartJsToECharts(result)
  }
  result = stripExplicitSeriesColors(result)
  result = autoPositionDualAxes(result)
  result = enforceYAxisNameLayout(result)
  result = forceLegendBottom(result)
  return withSafeGrid(result)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type EchartsInstance = any

interface ChartRendererInnerProps extends ChartRendererProps {
  /** 容器宽度（CSS 字符串）。默认 100% 适配气泡版；Lightbox 大图传 '85vw' */
  width?: string
  /** 容器高度（CSS 字符串）。默认 320px；Lightbox 大图传 '80vh' */
  height?: string
  /** 实例就绪后回调外部，方便外部拿到 instance 调 getDataURL 等 API */
  onInstanceReady?: (instance: EchartsInstance) => void
}

/**
 * 主组件。必须给容器固定 width/height，否则 ECharts Canvas 会渲染为空。
 *
 * 同一个 ChartRendererInner 既可以渲染气泡内的小图（320px）也可以渲染弹窗里的
 * 大图（80vh）。Lightbox 打开时会创建第二份 ECharts 实例，确保 tooltip / hover
 * 在大图上仍然交互正常（canvas 实例不能被两个容器复用）。
 */
function ChartRendererInner({
  option,
  width = '100%',
  height = '320px',
  onInstanceReady,
}: ChartRendererInnerProps): ReactElement {
  const containerRef = useRef<HTMLDivElement>(null)
  const instanceRef = useRef<EchartsInstance>(null)
  const [loaded, setLoaded] = useState(_echartsLoaded)
  const [loadError, setLoadError] = useState<string | null>(null)
  // useCallback 让父组件传入的 onInstanceReady 即使重渲染也不触发 effect 重跑
  const onInstanceReadyRef = useRef(onInstanceReady)
  useEffect(() => { onInstanceReadyRef.current = onInstanceReady }, [onInstanceReady])

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
    // 通过 ref 调用，避免 onInstanceReady 引用变化导致 effect 重跑 → instance 反复创建销毁
    onInstanceReadyRef.current?.(instanceRef.current)

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
      style={{ width, height }}
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

/**
 * 外层组件：错误边界 + 工具栏 + Lightbox 状态管理。
 * Lightbox 打开时多渲染一份 ChartRendererInner，得到大尺寸的独立 ECharts 实例。
 */
function ChartRendererCore({ option, rawJson }: ChartRendererProps): ReactElement {
  const bubbleInstanceRef = useRef<EchartsInstance>(null)
  const [hasRendered, setHasRendered] = useState(false)
  const [lightboxOpen, setLightboxOpen] = useState(false)

  // 从 option 中提取标题用于 aria-label / 弹窗副标题
  const titleText = (() => {
    const title = option.title as { text?: string; subtext?: string } | Array<{ text?: string }> | undefined
    if (!title) return '数据图表'
    if (Array.isArray(title)) return title[0]?.text || '数据图表'
    return title.text || '数据图表'
  })()

  const handleInstanceReady = useCallback((inst: EchartsInstance) => {
    bubbleInstanceRef.current = inst
    setHasRendered(true)
  }, [])

  /** 用 ECharts 自带的 getDataURL 导出 PNG，比 SVG → Canvas 路径更可靠 */
  const getPngDataUrl = useCallback(async (): Promise<string> => {
    const inst = bubbleInstanceRef.current
    if (!inst) throw new Error('ECharts 实例未初始化')
    return inst.getDataURL({
      type: 'png',
      pixelRatio: 2, // 高分屏锐化
      backgroundColor: '#0A0A0F', // px.bg，避免透明 PNG 在白底应用里看不清
    })
  }, [])

  return (
    <div
      role="img"
      aria-label={titleText}
      tabIndex={0}
      className="my-3 border-2 border-px-primary bg-px-bg p-3 shadow-pixel group relative"
    >
      <ChartRendererInner
        option={option}
        rawJson={rawJson}
        onInstanceReady={handleInstanceReady}
      />

      {hasRendered && (
        <RendererToolbar
          onZoom={() => {
            // 副面板 + Lightbox 不应同时显示——放大打开 Lightbox 时关掉副面板（2026-05-21）。
            useArtifactStore.getState().closeArtifact()
            setLightboxOpen(true)
          }}
          getPngDataUrl={getPngDataUrl}
          filenameBase="chart"
          ariaLabelPrefix={titleText}
        />
      )}

      {hasRendered && (
        <LightboxModal
          isOpen={lightboxOpen}
          onClose={() => setLightboxOpen(false)}
          title="DATA CHART"
          subtitle={titleText !== '数据图表' ? titleText : undefined}
        >
          {/* 大图版独立 ECharts 实例：不传 onInstanceReady，让外层导出仍走气泡版的实例 */}
          <ChartRendererInner option={option} width="85vw" height="80vh" />
        </LightboxModal>
      )}
    </div>
  )
}

export default function ChartRenderer({ option, rawJson }: ChartRendererProps): ReactElement {
  return (
    <ChartErrorBoundary key={rawJson ?? JSON.stringify(option)} rawJson={rawJson}>
      <ChartRendererCore option={option} rawJson={rawJson} />
    </ChartErrorBoundary>
  )
}
