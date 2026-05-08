import { createElement, useState, useRef, useEffect, useMemo, memo, type ComponentPropsWithoutRef, type ReactElement, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { ChatMessage, useChatStore } from '../stores/chatStore'
import AvatarImage from './AvatarImage'
import ChartRenderer from './ChartRenderer'
import MermaidRenderer from './MermaidRenderer'
import InfographicRenderer from './InfographicRenderer'
import LightboxModal from './LightboxModal'
import { renderChildrenWithCitations } from './source-citation-utils'
import FileCard from './FileCard'

const REMARK_PLUGINS = [remarkGfm]

/**
 * mermaid 流式检测：生成中代码块的结尾特征。
 * mermaid 没有统一的结束标记，用启发式：以已知关键字开头 + 最后一行是否完整。
 */
const MERMAID_KEYWORDS = /^(gantt|flowchart|graph|sequenceDiagram|stateDiagram|classDiagram|erDiagram|journey|gitGraph|pie|mindmap|timeline|quadrantChart|kanban|sankey|requirementDiagram|C4Context|xychart|block|architecture)\b/i
function isMermaidComplete(code: string): boolean {
  const trimmed = code.trim()
  if (trimmed.length < 10) return false
  if (!MERMAID_KEYWORDS.test(trimmed)) return false
  // 至少有 2 行内容（声明 + 至少一行定义）
  const lines = trimmed.split('\n').filter(l => l.trim().length > 0)
  return lines.length >= 2
}

/**
 * @antv/infographic DSL 流式检测：首行必须是 `infographic <template-name>`。
 * 流式接收时未结束的 fragment 不渲染，避免 LLM 还在打字时就 SVG 报错。
 */
function isInfographicComplete(code: string): boolean {
  const trimmed = code.trim()
  if (trimmed.length < 15) return false
  // 首行必须是 `infographic xxx-xxx` 格式
  const firstLine = trimmed.split('\n')[0].trim()
  if (!/^infographic\s+[a-z][a-z0-9-]+/.test(firstLine)) return false
  // 至少有 data 块开始（说明已经开始填数据，不是只写了模板名）
  return /\n\s*data\b/.test(trimmed) || /\n\s*-/.test(trimmed)
}

/**
 * 自定义 code 组件：拦截 `language-chart` / `language-mermaid` / `language-infographic`
 * 三类代码块，分别用 ECharts / Mermaid / @antv/infographic 渲染。
 * 其它 language 走默认 <code>/<pre> 样式。
 */
function ChartCodeBlock(props: ComponentPropsWithoutRef<'code'> & { inline?: boolean }): ReactElement {
  const { inline, className, children, ...rest } = props
  const raw = String(children ?? '').replace(/\n$/, '')

  // inline code 直接走默认渲染
  if (inline || !className) {
    return <code className={className} {...rest}>{children}</code>
  }

  // mermaid 分支（甘特/流程/时序/思维导图/看板/饼图/状态机/ER/类/git 等）
  if (className.includes('language-mermaid')) {
    if (!isMermaidComplete(raw)) {
      return (
        <pre className="my-3 border-2 border-px-primary/30 bg-px-bg p-3 overflow-x-auto animate-pulse">
          <div className="font-game text-[11px] tracking-wider text-px-text-dim mb-2">
            ⏳ MERMAID 图表生成中...
          </div>
          <code className="text-[12px] text-px-text-dim font-mono">{raw}</code>
        </pre>
      )
    }
    return <MermaidRenderer code={raw} />
  }

  // infographic 分支（信息图/列表/对比/序列/SWOT/思维导图等 84+ 模板）
  if (className.includes('language-infographic')) {
    if (!isInfographicComplete(raw)) {
      return (
        <pre className="my-3 border-2 border-px-primary/30 bg-px-bg p-3 overflow-x-auto animate-pulse">
          <div className="font-game text-[11px] tracking-wider text-px-text-dim mb-2">
            ⏳ INFOGRAPHIC 信息图生成中...
          </div>
          <code className="text-[12px] text-px-text-dim font-mono">{raw}</code>
        </pre>
      )
    }
    return <InfographicRenderer dsl={raw} />
  }

  // 非 chart / 非 mermaid / 非 infographic 代码块走默认渲染
  if (!className.includes('language-chart')) {
    return <code className={className} {...rest}>{children}</code>
  }

  // 流式输出检测：尝试 JSON.parse，失败且花括号未闭合时视为"正在生成"
  const trimmed = raw.trim()
  const openBraces = (trimmed.match(/{/g) || []).length
  const closeBraces = (trimmed.match(/}/g) || []).length
  const isIncomplete = openBraces > closeBraces || !trimmed.endsWith('}')
  if (isIncomplete) {
    return (
      <pre className="my-3 border-2 border-px-primary/30 bg-px-bg p-3 overflow-x-auto animate-pulse">
        <div className="font-game text-[11px] tracking-wider text-px-text-dim mb-2">
          ⏳ 图表生成中...
        </div>
        <code className="text-[12px] text-px-text-dim font-mono">{raw}</code>
      </pre>
    )
  }

  // 尝试解析 chart JSON（JSON.parse 独立于 JSX，规避 react-hooks/error-boundaries 规则）
  let parsedOption: Record<string, unknown> | null = null
  let parseError: string | null = null
  try {
    parsedOption = JSON.parse(raw) as Record<string, unknown>
  } catch (err) {
    parseError = (err as Error).message
    console.warn('[MessageBubble] chart JSON 解析失败:', parseError)
  }

  if (parsedOption) {
    return <ChartRenderer option={parsedOption} rawJson={raw} />
  }

  // JSON 解析失败：降级为带红框的原始代码块，提示用户图表数据格式错误
  return (
    <pre className="my-3 border-2 border-px-danger bg-px-bg p-3 overflow-x-auto">
      <div className="font-game text-[11px] tracking-wider text-px-danger mb-2">
        ⚠ CHART JSON 解析失败{parseError ? `: ${parseError}` : ''}
      </div>
      <code className="text-[12px] text-px-text-dim font-mono">{raw}</code>
    </pre>
  )
}

/**
 * inline-text 容器渲染拦截：把 children 中的纯文本子节点里
 * `[来源: knowledge/...]` 切出来替换成可点击的 SourceCitation chip。
 * 其余 inline 元素（<strong>、<em> 等）原样保留。
 *
 * 必须覆盖 markdown 里所有可能"承载段落级文本"的容器：
 *   - p          段落
 *   - li         列表项（react-markdown 默认不把列表项内文本包进 p）
 *   - td / th    表格单元格
 *   - blockquote 引用块
 *
 * 用闭包注入 avatarId + messageId（构造唯一 React key），所以不能写成模块级常量，
 * 由 MessageBubble 内 useMemo 构造。
 */
function buildMarkdownComponents(avatarId: string, messageId: string) {
  // react-markdown 对每个 tag 的 component 入参类型严格区分（HTMLLIElement /
  // HTMLQuoteElement 等不兼容）。用最宽的"任意属性 + children + node"形状
  // 接住，内部用 createElement 透传给真实 tag，避免泛型类型推导踩坑。
  type ContainerProps = { children?: ReactNode; node?: unknown } & Record<string, unknown>

  function makeContainerRenderer(
    tag: 'p' | 'li' | 'td' | 'th' | 'blockquote',
    keySuffix: string,
  ): (props: ContainerProps) => ReactElement {
    return function MarkdownContainer(props: ContainerProps): ReactElement {
      const { children, node: _node, ...rest } = props
      void _node
      const processed: ReactNode = renderChildrenWithCitations(children, avatarId, `${messageId}-${keySuffix}`)
      return createElement(tag, rest, processed)
    }
  }

  // react-markdown 的 components 表对 value 类型用了 union of per-tag
  // FunctionComponent，这里我们的统一 renderer 形状对 TS 来说不严格匹配每个
  // tag 的 props 类型，但运行时完全等价（只透传属性 + children）。统一用
  // `as unknown as` 桥接，避免 5 个 tag 各写一份重复实现。
  type MarkdownComponentLike = (props: ContainerProps) => ReactElement
  const p = makeContainerRenderer('p', 'p') as unknown as MarkdownComponentLike
  const li = makeContainerRenderer('li', 'li') as unknown as MarkdownComponentLike
  const td = makeContainerRenderer('td', 'td') as unknown as MarkdownComponentLike
  const th = makeContainerRenderer('th', 'th') as unknown as MarkdownComponentLike
  const blockquote = makeContainerRenderer('blockquote', 'bq') as unknown as MarkdownComponentLike

  return {
    code: ChartCodeBlock,
    p,
    li,
    td,
    th,
    blockquote,
  } as Record<string, unknown>
}

/** 超过此字符数的助手消息显示折叠按钮 */
const COLLAPSE_THRESHOLD = 600
/** 折叠状态下显示的首段字符数 */
const COLLAPSED_PREVIEW_CHARS = 300
const THINK_BLOCK_REGEX = /<think>([\s\S]*?)<\/think>/gi

interface Props {
  message: ChatMessage
  previousUserMessage?: string
  onSaveAnswer?: (question: string, answer: string) => void
  /** 分身头像（用于 AI 消息气泡展示） */
  avatarImage?: string
  /** 分身名称（用于 AI 消息气泡展示） */
  avatarName?: string
  /** 当前对话所属分身 ID，用于 [来源:] chip 解析原始 PDF/Excel/PPT 文件 */
  avatarId: string
}

/**
 * 在不破坏 markdown 结构的前提下把长文本截到 N 字符附近。
 * 优先在段落（\n\n）或行尾切断，次选在标点处，最后兜底硬切。
 * 截断后追加省略号，让折叠预览更自然。
 */
function truncateAtBoundary(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  const head = text.slice(0, maxChars)
  // 优先段落边界
  const paraBreak = head.lastIndexOf('\n\n')
  if (paraBreak > maxChars * 0.5) return head.slice(0, paraBreak) + '\n\n...'
  // 其次行尾
  const lineBreak = head.lastIndexOf('\n')
  if (lineBreak > maxChars * 0.6) return head.slice(0, lineBreak) + '\n\n...'
  // 再其次中文标点
  const punctMatch = head.match(/[。！？；，]\s*(?=[^。！？；，]*$)/)
  if (punctMatch && punctMatch.index !== undefined && punctMatch.index > maxChars * 0.7) {
    return head.slice(0, punctMatch.index + 1) + '...'
  }
  // 兜底硬切
  return head + '...'
}

/**
 * 剥离用户消息开头的 [id:mNNNN] 锚点，仅用于 UI 显示。
 * 锚点由 chatStore 在发送时注入（用于 snip 工具按 ID 范围裁剪上下文），
 * 数据库与发送给 LLM 的内容仍保留锚点，只在气泡渲染时隐藏。
 */
const ID_ANCHOR_PREFIX = /^\[id:m\d+\]\s*/
function stripIdAnchor(content: string): string {
  return content.replace(ID_ANCHOR_PREFIX, '')
}

/** 兜底抽取内联 <think> 块，兼容未走 reasoning_content delta 的服务端 */
function extractThinking(content: string): { thinking: string; clean: string } {
  const thinking: string[] = []
  const clean = content.replace(THINK_BLOCK_REGEX, (_, block: string) => {
    const trimmed = block.trim()
    if (trimmed) thinking.push(trimmed)
    return ''
  }).trim()
  return { thinking: thinking.join('\n\n'), clean }
}

/** 仅允许安全协议的链接 */
function safeUrlTransform(url: string): string {
  try {
    const parsed = new URL(url)
    if (['http:', 'https:', 'mailto:'].includes(parsed.protocol)) return url
  } catch (parseErr) {
    // 非法 URL 是常见的 markdown 输入，静默降级为空字符串
    void parseErr
  }
  return ''
}

const MessageBubble = memo(function MessageBubble({ message, previousUserMessage, onSaveAnswer, avatarImage, avatarName, avatarId }: Props) {
  const isUser = message.role === 'user'
  const [saved, setSaved] = useState(false)
  const savedTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  /** 用户上传图片放大查看：null = 关闭，否则展示对应索引的图片 */
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null)

  useEffect(() => () => { clearTimeout(savedTimerRef.current) }, [])

  // 折叠状态从 chatStore 读取，跨 Virtuoso 卸载/HMR 持久
  // 用 selector 只订阅自己这条消息的折叠态，避免其他消息 toggle 时被无谓重渲染
  const collapsed = useChatStore((s) => s.collapsedMessageIds.has(message.id))
  const toggleMessageCollapsed = useChatStore((s) => s.toggleMessageCollapsed)
  const extractedThinking = isUser
    ? { thinking: '', clean: stripIdAnchor(message.content) }
    : extractThinking(message.content)
  const contentForDisplay = extractedThinking.clean
  const reasoning = message.reasoning?.trim() || extractedThinking.thinking
  // 助手消息超过阈值时允许折叠（用户消息通常很短，不折叠）
  const canCollapse = !isUser && contentForDisplay.length > COLLAPSE_THRESHOLD
  // 折叠态展示前 N 字符（尽量在段落边界切断，避免切到 markdown 语法中间）
  const displayContent = canCollapse && collapsed
    ? truncateAtBoundary(contentForDisplay, COLLAPSED_PREVIEW_CHARS)
    : contentForDisplay

  const handleSave = () => {
    if (!onSaveAnswer || !previousUserMessage || saved) return
    onSaveAnswer(previousUserMessage, contentForDisplay)
    setSaved(true)
    clearTimeout(savedTimerRef.current)
    savedTimerRef.current = setTimeout(() => setSaved(false), 3000)
  }

  /**
   * markdown 组件渲染器：闭包注入 avatarId + messageId 以拦截 [来源:] chip。
   * avatarId/messageId 都是稳定值，仅在切换分身/消息时重建。
   */
  const markdownComponents = useMemo(
    () => buildMarkdownComponents(avatarId, message.id),
    [avatarId, message.id],
  )

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start gap-3'} animate-fade-in`}>
      {/* AI 消息左侧小头像 */}
      {!isUser && (
        <div className="flex-shrink-0 mt-6">
          <AvatarImage avatarImage={avatarImage} name={avatarName ?? '专家'} size="sm" />
        </div>
      )}

      <div className={`max-w-[75%] ${isUser ? 'items-end' : 'items-start'} flex flex-col`}>
        {/* 角色标签 */}
        <div className={`font-game text-[12px] tracking-widest mb-1.5
          ${isUser ? 'text-right text-px-primary' : 'text-left text-px-accent'}`}>
          {isUser ? '你' : (avatarName ?? '专家')}
        </div>

        {/* 消息体 */}
        <div
          className={`relative group px-5 py-4 border-2 font-body text-[14px] leading-relaxed
            ${isUser
              ? 'bg-px-primary/10 text-px-text border-px-primary/30 shadow-pixel-brand'
              : 'bg-px-surface text-px-text border-px-border shadow-pixel-white'
            }`}
        >
          {/* 助手消息的 SAVE 按钮（hover 时显示） */}
          {!isUser && onSaveAnswer && previousUserMessage && (
            <button
              onClick={handleSave}
              disabled={saved}
              className="absolute top-2 right-2 opacity-0 group-hover:opacity-100
                font-game text-[10px] tracking-wider px-2 py-0.5
                border border-px-border bg-px-elevated text-px-text-dim
                hover:text-px-primary hover:border-px-primary
                focus:opacity-100
                disabled:text-px-success disabled:border-px-success
                transition-opacity"
              aria-label={saved ? '已沉淀' : '沉淀到知识百科'}
              title="沉淀到知识百科"
            >
              {saved ? 'SAVED' : 'SAVE'}
            </button>
          )}

          {isUser ? (
            <div className="flex flex-col gap-2">
              {/* 用户上传的图片缩略图（点击在应用内 Lightbox 查看大图） */}
              {message.imageUrls && message.imageUrls.length > 0 && (
                <div className="flex gap-2 flex-wrap">
                  {message.imageUrls.map((url, i) => (
                    <button
                      key={`img-${i}`}
                      type="button"
                      onClick={() => setLightboxIndex(i)}
                      className="block p-0 bg-transparent border-2 border-px-border hover:border-px-primary
                        focus:outline-none focus:border-px-primary cursor-pointer transition-none"
                      aria-label={`查看图片 ${i + 1} 大图`}
                    >
                      <img
                        src={url}
                        alt={`附图 ${i + 1}`}
                        className="w-20 h-20 object-cover block"
                      />
                    </button>
                  ))}
                </div>
              )}
              {contentForDisplay && (
                <p className="whitespace-pre-wrap">{contentForDisplay}</p>
              )}
              {/* Lightbox：用户上传图片的应用内放大查看，不再跳浏览器 */}
              {lightboxIndex !== null && message.imageUrls && message.imageUrls[lightboxIndex] && (
                <LightboxModal
                  isOpen={true}
                  onClose={() => setLightboxIndex(null)}
                  title="USER IMAGE"
                  subtitle={
                    message.imageUrls.length > 1
                      ? `第 ${lightboxIndex + 1} 张 / 共 ${message.imageUrls.length} 张`
                      : undefined
                  }
                >
                  <img
                    src={message.imageUrls[lightboxIndex]}
                    alt={`附图 ${lightboxIndex + 1}`}
                    className="max-w-full max-h-[80vh] object-contain block"
                  />
                </LightboxModal>
              )}
            </div>
          ) : (
            <div className="prose prose-sm prose-invert max-w-none prose-pixel
              prose-headings:font-game prose-headings:font-bold prose-headings:tracking-wider prose-headings:text-px-text
              prose-p:text-px-text prose-p:leading-[1.75] prose-p:text-[14px] prose-p:font-body
              prose-code:text-px-accent prose-code:bg-px-bg prose-code:px-1.5 prose-code:py-0.5 prose-code:border prose-code:border-px-border prose-code:text-[13px] prose-code:font-mono
              prose-pre:bg-px-bg prose-pre:text-px-text prose-pre:border-2 prose-pre:border-px-border prose-pre:font-mono
              prose-table:border-2 prose-table:border-px-border
              prose-th:border-2 prose-th:border-px-border prose-th:bg-px-elevated prose-th:text-px-text prose-th:px-3 prose-th:py-2 prose-th:font-game
              prose-td:border-2 prose-td:border-px-border prose-td:px-3 prose-td:py-2 prose-td:text-px-text-sec prose-td:font-body
              prose-strong:font-bold prose-strong:text-px-text
              prose-a:text-px-primary prose-a:no-underline hover:prose-a:underline
              prose-li:text-px-text-sec prose-li:marker:text-px-primary prose-li:font-body">
              {reasoning && (
                <details className="not-prose mb-2 border border-px-border/40 bg-px-bg/50 px-3 py-2">
                  <summary className="font-game text-[10px] tracking-wider text-px-text-dim cursor-pointer">
                    [▷] THINKING ({reasoning.length} 字)
                  </summary>
                  <pre className="mt-2 text-[12px] text-px-text-dim font-mono whitespace-pre-wrap leading-relaxed">
                    {reasoning}
                  </pre>
                </details>
              )}
              <ReactMarkdown
                remarkPlugins={REMARK_PLUGINS}
                urlTransform={safeUrlTransform}
                components={markdownComponents}
              >
                {displayContent}
              </ReactMarkdown>
              {canCollapse && (
                <div className="mt-3 -mb-1 pt-2 border-t border-px-border/40 flex items-center justify-between">
                  <span className="font-game text-[10px] text-px-text-dim tracking-wider">
                    {collapsed
                      ? `${contentForDisplay.length} 字 · 已折叠`
                      : `${contentForDisplay.length} 字`}
                  </span>
                  <button
                    type="button"
                    onClick={() => toggleMessageCollapsed(message.id)}
                    className="font-game text-[10px] tracking-wider px-2 py-0.5
                      border border-px-border bg-px-elevated text-px-text-dim
                      hover:text-px-primary hover:border-px-primary
                      transition-none"
                    aria-label={collapsed ? '展开完整消息' : '折叠消息'}
                    aria-expanded={!collapsed}
                  >
                    {collapsed ? '[▶] 展开' : '[▼] 收起'}
                  </button>
                </div>
              )}
              {/* 决策 B3：generate_document / export_excel 落盘文件卡片 */}
              {message.documentAttachments && message.documentAttachments.length > 0 && (
                <div className="not-prose flex flex-col">
                  {message.documentAttachments.map((att, i) => (
                    <FileCard key={`doc-${message.id}-${i}`} attachment={att} />
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
})

export default MessageBubble
