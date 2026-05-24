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
import { useArtifactStore } from '../stores/artifactStore'

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
      const rawMsg = this.state.errorMessage || ''
      const hint = explainInfographicError(rawMsg, this.props.dsl)
      return (
        <div
          role="alert"
          className="my-3 border-2 border-px-danger bg-px-bg p-3"
          aria-label="Infographic 渲染失败"
        >
          <div className="flex items-center justify-between mb-2">
            <div className="font-game text-[11px] tracking-wider text-px-danger">
              ⚠ 信息图渲染失败 · DSL {this.props.dsl.length} chars
            </div>
            <button
              type="button"
              onClick={() => { void navigator.clipboard?.writeText?.(this.props.dsl) }}
              className="font-game text-[10px] text-px-text-dim hover:text-px-primary px-2 py-0.5 border border-px-border hover:border-px-primary"
              title="复制完整 DSL 源码到剪贴板"
            >
              复制 DSL
            </button>
          </div>
          <div className="text-[13px] text-px-text leading-relaxed mb-2 font-body">
            {hint.headline}
          </div>
          {hint.suggestions.length > 0 && (
            <ul className="text-[12px] text-px-text-dim font-body list-disc pl-5 mb-2 space-y-0.5">
              {hint.suggestions.map((s, i) => (<li key={i}>{s}</li>))}
            </ul>
          )}
          <details className="text-[11px] text-px-text-dim/80 font-body mb-2">
            <summary className="cursor-pointer select-none hover:text-px-text-dim">
              查看技术错误信息（开发调试用）
            </summary>
            <div className="mt-1 font-mono text-[10px] break-all">{rawMsg || '未知错误'}</div>
          </details>
          <pre className="text-[11px] text-px-text-dim font-mono overflow-auto max-h-[600px] whitespace-pre-wrap break-all bg-px-surface/40 p-2 border border-px-border/40">
            {this.props.dsl}
          </pre>
        </div>
      )
    }
    return this.props.children
  }
}

/**
 * 把 @antv/infographic 抛出的底层异常翻译成人话 + 给出可操作建议。
 *
 * 触发点：
 *   - "Invalid SVG string"：DSL 字段名 / 缩进 / 类型错配，导致生成空 SVG。最常见 LLM
 *     在 compare-swot 里给 `items` 数组但 antv 只认 plain `text`（已有 coerce 兜底，
 *     但仍可能漏掉边角形态）；或 label 里夹 emoji 让文本测量失败。
 *   - "未导出 Infographic 类"：@antv/infographic 加载失败或被外部脚本污染。
 *
 * 注意：chatStore.sendMessage 末尾已经接了 validator + 自动追问（见 chatStore.ts
 * 「#C 方案」），所以这个红框可能只是"上一轮的废稿"——下一条助手消息通常已经把
 * 修正后的图发过来。提示文字里要点出这一点，避免用户以为分身完全没救。
 */
function explainInfographicError(
  rawMsg: string,
  dsl: string,
): { headline: string; suggestions: string[] } {
  const lower = rawMsg.toLowerCase()
  const isCompareSwot = /^\s*infographic\s+compare-swot\b/im.test(dsl)
  const hasEmojiInLabel = /^\s*-\s+label\s+.*[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/mu.test(dsl)

  if (lower.includes('invalid svg')) {
    const suggestions: string[] = []
    if (isCompareSwot) {
      suggestions.push('compare-swot 模板每块只接受 `text 一段文字`，不接受 `items` 数组——若 LLM 输出了 items 列表会渲染失败')
      suggestions.push('label 文本里出现 emoji（如 ✅ 🔵 🔴）有概率让 SVG 文本测量失败；改用纯文字标签如 "优势 / 劣势 / 机会 / 威胁"')
    } else {
      suggestions.push('检查 DSL 首行是否为 `infographic <模板名>`，缩进是否用 2 空格（不是 tab）')
      suggestions.push('字段名遵守模板规定：list 用 `lists`、compare 用 `compares`、hierarchy 用 `root + children`')
    }
    suggestions.push('系统已自动让 AI 重新生成一版——如果下一条消息出现了同主题的新图，本红框可以忽略')
    return {
      headline: '信息图代码格式不被图形库接受（生成了空 SVG）。',
      suggestions,
    }
  }

  if (lower.includes('未导出 infographic 类') || lower.includes('加载 @antv/infographic 失败')) {
    return {
      headline: '@antv/infographic 库加载失败 —— 这是渲染器层问题，不是 AI 答案错。',
      suggestions: [
        '尝试刷新 desktop-app（Cmd+R / 重启）',
        '检查 node_modules/@antv/infographic 是否存在；执行 `npm install` 重装',
      ],
    }
  }

  if (hasEmojiInLabel) {
    return {
      headline: 'label 文本里的 emoji 让信息图渲染失败。',
      suggestions: [
        '请 AI 改用纯文字标签（如 "优势 / 劣势 / 机会 / 威胁"）替换 emoji',
        '已加 emoji 标签是来自模型的格式偏好，与人格规则无关',
      ],
    }
  }

  return {
    headline: '信息图渲染失败，可能是 DSL 字段错配或数据缺失。',
    suggestions: [
      '系统已自动让 AI 重新生成一版——如果下一条消息出现了同主题的新图，本红框可以忽略',
      '若多次失败，可以追问"请改用 list-grid-badge-card 模板重新画"',
    ],
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
 * 把当前项目主题（CSS 变量 --px-bg / --px-surface / --px-primary / --px-text / ...）
 * 映射成 @antv/infographic 的 ThemeConfig。让 infographic 跟随当前主题模板的配色。
 *
 * 设计点：
 * - colorBg 用 --px-surface 而不是 --px-bg：surface 是"卡片层"，比 bg 略亮，避免
 *   信息图整张和聊天背景完全融合（之前 2026-05-22 "图给人很黑" 的根因就是 colorBg
 *   = #FFF 默认值在 dark mode 下被反色成低饱和度暗色，跟 px-bg #0A0A0F 几乎一样）。
 * - colorPrimary 用 --px-primary：antv 会基于此衍生整套调色板（卡片色、强调色等）。
 * - base.text.fill 用 --px-text：保证文字在 colorBg 上有足够对比。
 *
 * 返回 undefined 时（SSR / 变量缺失）回退到 @antv/infographic 默认主题。
 *
 * 局限：已渲染的旧 infographic 是静态 SVG，主题切换后不会自动重新渲染——仅新生成的
 * 信息图跟随当前主题。这跟"切换主题时聊天历史里 mermaid/chart 不重绘"行为一致。
 */
function buildInfographicThemeConfig(): Record<string, unknown> | undefined {
  if (typeof window === 'undefined' || typeof document === 'undefined') return undefined
  const cs = getComputedStyle(document.documentElement)
  const read = (name: string) => cs.getPropertyValue(name).trim()
  const bg = read('--px-surface') || read('--px-bg')
  const primary = read('--px-primary')
  const text = read('--px-text')
  if (!bg || !primary || !text) return undefined
  return {
    colorBg: bg,
    colorPrimary: primary,
    base: {
      text: { fill: text },
    },
  }
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
        // height: 'auto' 会让 @antv/infographic 生成含 `height="auto"` 的 SVG，
        // 而 SVG 规范不接受 "auto"（浏览器拒绝解析 → "Invalid SVG string"）。
        // 改用具体像素 + 实际渲染后 SVG 由 viewBox 自适应，体验等价但合法。
        height: 600,
        // 主题跟随项目当前 data-theme：从 :root 上的 CSS 变量读 --px-surface /
        // --px-primary / --px-text，映射成 antv ThemeConfig。antv 内部 generateThemeColors
        // 基于 colorPrimary 衍生整套调色板，卡片色自动匹配主题色调（2026-05-22 修复）。
        // 失败回退到 antv 默认主题（之前是固定 'light'，跟项目深底强烈割裂）。
        themeConfig: buildInfographicThemeConfig(),
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
      // eslint-disable-next-line no-console
      console.groupCollapsed(`[InfographicRenderer] 失败 DSL 完整内容（点击展开，共 ${dsl.length} chars）`)
      // eslint-disable-next-line no-console
      console.log(dsl)
      // eslint-disable-next-line no-console
      console.groupEnd()
      window.electronAPI?.logEvent?.('error', 'infographic-render-fail', `msg=${msg.slice(0, 200)} | dsl=${dsl.slice(0, 3800)}`)
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
          onZoom={() => {
            // 副面板 + Lightbox 不应同时显示——用户反馈：点击「放大」副面板没消失（2026-05-21）。
            // 放大优先级最高（全屏），打开 Lightbox 时把副面板关掉。
            useArtifactStore.getState().closeArtifact()
            setLightboxOpen(true)
          }}
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
