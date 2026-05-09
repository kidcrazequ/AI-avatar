/**
 * Soul Embed widget Preact 主组件。
 *
 * 状态机：
 *   idle ──发送──> streaming ──完成──> idle
 *                       │
 *                       ├─429─> rate_limited（3s 后回 idle）
 *                       └─5xx/网络错误─> 自动 1s/2s/4s 三次重试 ──仍失败──> error
 *
 *   首次拉 config 失败 → config_failed（终态，不再重试）
 *
 * 渲染：
 *   - 顶部 header：avatar 名 + powered by Soul
 *   - 中部消息列表：user 右对齐蓝底；assistant 左对齐灰底（走 markdown.ts 渲染）
 *   - 流式时 assistant 末尾显示闪烁光标
 *   - 底部 textarea + 发送按钮（流式中禁用）
 *   - 首次无消息显示 greeting
 *
 * @author zhi.qu
 * @date 2026-05-09
 */
import { useEffect, useMemo, useRef, useState, useCallback } from 'preact/hooks'
import { fetchConfig, streamMessage } from './api'
import { renderMarkdown } from './markdown'
import { ApiError, EmbedConfig, Message, RateLimitError, WidgetStatus } from './types'

interface AppProps {
  embedId: string
  serverUrl: string
}

const RETRY_DELAYS_MS = [1_000, 2_000, 4_000]
const RATE_LIMIT_COOLDOWN_MS = 3_000

let __soulMsgIdCounter = 0
function nextMessageId(): string {
  __soulMsgIdCounter += 1
  return `m_${Date.now().toString(36)}_${__soulMsgIdCounter}`
}

export function App(props: AppProps) {
  const { embedId, serverUrl } = props
  const [config, setConfig] = useState<EmbedConfig | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [status, setStatus] = useState<WidgetStatus>('idle')
  const [statusMsg, setStatusMsg] = useState<string>('')
  const conversationIdRef = useRef<string | null>(null)
  const bodyRef = useRef<HTMLDivElement | null>(null)

  // 初次挂载：拉取公开配置
  useEffect(() => {
    let cancelled = false
    fetchConfig(serverUrl, embedId)
      .then((cfg) => {
        if (cancelled) return
        setConfig(cfg)
      })
      .catch(() => {
        if (cancelled) return
        setStatus('config_failed')
        setStatusMsg('服务暂不可用')
      })
    return () => {
      cancelled = true
    }
  }, [embedId, serverUrl])

  // 消息列表变化或流式追加时，自动滚到底部
  useEffect(() => {
    const el = bodyRef.current
    if (el) {
      el.scrollTop = el.scrollHeight
    }
  }, [messages, status])

  /**
   * 真正发起一次流式请求，并把 assistant 的 delta 累积到指定的消息 id 上。
   *
   * 不管成功/失败都不在这里改 status，外层 sendMessage 统一管。
   */
  const startStream = useCallback(
    async (text: string, assistantId: string): Promise<void> => {
      await streamMessage(
        serverUrl,
        embedId,
        text,
        conversationIdRef.current,
        (chunk) => {
          setMessages((prev) =>
            prev.map((m) => (m.id === assistantId ? { ...m, content: m.content + chunk } : m)),
          )
        },
        (cid) => {
          conversationIdRef.current = cid
        },
      )
    },
    [embedId, serverUrl],
  )

  const sendMessage = useCallback(async () => {
    const text = input.trim()
    if (text.length === 0) return
    if (status === 'streaming' || status === 'rate_limited' || status === 'config_failed') return

    setInput('')
    const userMsg: Message = { id: nextMessageId(), role: 'user', content: text }
    const assistantId = nextMessageId()
    const assistantMsg: Message = { id: assistantId, role: 'assistant', content: '', streaming: true }
    setMessages((prev) => [...prev, userMsg, assistantMsg])
    setStatus('streaming')
    setStatusMsg('')

    let attempt = 0
    let lastErr: unknown = null
    while (attempt <= RETRY_DELAYS_MS.length) {
      try {
        await startStream(text, assistantId)
        // 流式成功结束
        setMessages((prev) =>
          prev.map((m) => (m.id === assistantId ? { ...m, streaming: false } : m)),
        )
        setStatus('idle')
        setStatusMsg('')
        return
      } catch (err) {
        lastErr = err
        if (err instanceof RateLimitError) {
          // 限流不重试，直接进入 cooldown
          setMessages((prev) => prev.filter((m) => m.id !== assistantId))
          setStatus('rate_limited')
          setStatusMsg(`请稍后再试（${err.retryAfterSec}s）`)
          window.setTimeout(() => {
            setStatus((cur) => (cur === 'rate_limited' ? 'idle' : cur))
            setStatusMsg('')
          }, Math.max(RATE_LIMIT_COOLDOWN_MS, err.retryAfterSec * 1000))
          return
        }
        // 4xx（除 429）不重试
        if (err instanceof ApiError && err.status >= 400 && err.status < 500 && err.status !== 429) {
          break
        }
        // 5xx / 网络错误：可重试
        if (attempt < RETRY_DELAYS_MS.length) {
          setStatusMsg('网络错误，正在重试...')
          await sleep(RETRY_DELAYS_MS[attempt])
          attempt++
          // 清空已收到的 assistant 内容，重头来
          setMessages((prev) =>
            prev.map((m) => (m.id === assistantId ? { ...m, content: '' } : m)),
          )
          continue
        }
        break
      }
    }
    // 走到这说明所有重试均失败
    setMessages((prev) => prev.filter((m) => m.id !== assistantId))
    setStatus('error')
    const fallback = lastErr instanceof Error ? lastErr.message : '未知错误'
    setStatusMsg(`发送失败：${fallback}`)
  }, [input, status, startStream])

  const onKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault()
        void sendMessage()
      }
    },
    [sendMessage],
  )

  const showGreeting = useMemo(
    () => messages.length === 0 && config?.greeting,
    [messages.length, config?.greeting],
  )

  const disabled = status === 'streaming' || status === 'rate_limited' || status === 'config_failed'

  return (
    <div class="root">
      <div class="header">
        <div class="title">{config?.name ?? 'Soul'}</div>
        <div class="powered">powered by Soul</div>
      </div>
      <div class="body" ref={bodyRef}>
        {showGreeting ? <div class="greeting">{config?.greeting}</div> : null}
        {messages.map((m) => (
          <Bubble key={m.id} message={m} />
        ))}
        {status === 'config_failed' ? (
          <div class="notice error">服务暂不可用，请稍后再试</div>
        ) : null}
        {status === 'error' ? <div class="notice error">{statusMsg || '发送失败'}</div> : null}
        {status === 'rate_limited' ? <div class="notice warn">{statusMsg || '请稍后再试'}</div> : null}
        {status === 'streaming' && statusMsg ? <div class="notice warn">{statusMsg}</div> : null}
      </div>
      <div class="footer">
        <textarea
          value={input}
          disabled={disabled}
          placeholder={disabled ? '请稍候...' : '输入消息，Enter 发送'}
          onInput={(e) => setInput((e.currentTarget as HTMLTextAreaElement).value)}
          onKeyDown={onKeyDown}
          rows={1}
        />
        <button type="button" disabled={disabled || input.trim().length === 0} onClick={() => void sendMessage()}>
          发送
        </button>
      </div>
    </div>
  )
}

function Bubble(props: { message: Message }) {
  const { message } = props
  if (message.role === 'user') {
    return <div class="bubble user">{message.content}</div>
  }
  // assistant: 走 markdown 渲染（已 escape）
  const html = renderMarkdown(message.content)
  return (
    <div class="bubble assistant">
      <span dangerouslySetInnerHTML={{ __html: html }} />
      {message.streaming ? <span class="cursor" /> : null}
    </div>
  )
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}
