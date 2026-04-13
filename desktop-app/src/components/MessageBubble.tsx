import { useState, useRef, useEffect, memo, type ComponentPropsWithoutRef, type ReactElement } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { ChatMessage } from '../stores/chatStore'
import AvatarImage from './AvatarImage'
import ChartRenderer from './ChartRenderer'

const REMARK_PLUGINS = [remarkGfm]

/**
 * 自定义 code 组件：拦截 `language-chart` 代码块，解析 JSON 后用 ECharts 渲染。
 * 其它 language 走默认 <code>/<pre> 样式（由 prose-pixel 主题处理）。
 */
function ChartCodeBlock(props: ComponentPropsWithoutRef<'code'> & { inline?: boolean }): ReactElement {
  const { inline, className, children, ...rest } = props
  const raw = String(children ?? '').replace(/\n$/, '')

  // inline code / 非 chart language 走默认渲染
  if (inline || !className || !className.includes('language-chart')) {
    return <code className={className} {...rest}>{children}</code>
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

const MARKDOWN_COMPONENTS = { code: ChartCodeBlock }

interface Props {
  message: ChatMessage
  previousUserMessage?: string
  onSaveAnswer?: (question: string, answer: string) => void
  /** 分身头像（用于 AI 消息气泡展示） */
  avatarImage?: string
  /** 分身名称（用于 AI 消息气泡展示） */
  avatarName?: string
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

const MessageBubble = memo(function MessageBubble({ message, previousUserMessage, onSaveAnswer, avatarImage, avatarName }: Props) {
  const isUser = message.role === 'user'
  const [saved, setSaved] = useState(false)
  const savedTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined)

  useEffect(() => () => { clearTimeout(savedTimerRef.current) }, [])

  const handleSave = () => {
    if (!onSaveAnswer || !previousUserMessage || saved) return
    onSaveAnswer(previousUserMessage, message.content)
    setSaved(true)
    clearTimeout(savedTimerRef.current)
    savedTimerRef.current = setTimeout(() => setSaved(false), 3000)
  }

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
            <p className="whitespace-pre-wrap">{message.content}</p>
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
              <ReactMarkdown
                remarkPlugins={REMARK_PLUGINS}
                urlTransform={safeUrlTransform}
                components={MARKDOWN_COMPONENTS}
              >
                {message.content}
              </ReactMarkdown>
            </div>
          )}
        </div>
      </div>
    </div>
  )
})

export default MessageBubble
