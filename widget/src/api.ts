/**
 * Soul Embed widget API 客户端。
 *
 * 与 widget-server.ts 严格对齐：
 *   - GET  /embed/:id/config        → fetchConfig()
 *   - POST /api/embed/:id/messages  → streamMessage()（SSE 透传 Anthropic Messages 协议）
 *
 * 不引入 SSE 解析库；用原生 fetch + ReadableStream 手写解析：
 *   1. response.body.getReader() 读字节
 *   2. TextDecoder('utf-8', { stream: true }) 解码
 *   3. 按 \n\n 切事件块；每块逐行找 `event: xxx` / `data: yyy`
 *   4. 对每个 content_block_delta 事件解析 delta.text 触发 onDelta
 *
 * 不依赖 EventSource（EventSource 不支持 POST + 自定义头）。
 *
 * @author zhi.qu
 * @date 2026-05-09
 */
import { ApiError, EmbedConfig, RateLimitError, ServerError } from './types'

const REQUEST_TIMEOUT_MS = 30_000

/** GET /embed/:id/config */
export async function fetchConfig(serverUrl: string, embedId: string): Promise<EmbedConfig> {
  const ctrl = new AbortController()
  const timer = window.setTimeout(() => ctrl.abort(), 10_000)
  try {
    const resp = await fetch(`${stripTrailingSlash(serverUrl)}/embed/${encodeURIComponent(embedId)}/config`, {
      method: 'GET',
      signal: ctrl.signal,
      // 不带 cookies；widget 不依赖任何身份
      credentials: 'omit',
      headers: { Accept: 'application/json' },
    })
    if (!resp.ok) {
      throw new ApiError(resp.status, `config fetch failed: ${resp.status}`)
    }
    const data = (await resp.json()) as Partial<EmbedConfig>
    if (!data || typeof data.embedId !== 'string' || typeof data.avatarId !== 'string') {
      throw new ApiError(500, 'config payload invalid')
    }
    return {
      embedId: data.embedId,
      avatarId: data.avatarId,
      name: typeof data.name === 'string' ? data.name : 'Soul Embed',
      greeting: typeof data.greeting === 'string' ? data.greeting : null,
      rateLimitPerMin: typeof data.rateLimitPerMin === 'number' ? data.rateLimitPerMin : 30,
    }
  } finally {
    window.clearTimeout(timer)
  }
}

/**
 * POST /api/embed/:id/messages —— 流式发送一条用户消息。
 *
 * @param onDelta 每收到一段 assistant 文本调一次（增量，非累计）
 * @param onConvoId 收到响应头 X-Soul-Conversation-Id 时调一次（用于后续轮次回传）
 */
export async function streamMessage(
  serverUrl: string,
  embedId: string,
  text: string,
  conversationId: string | null,
  onDelta: (chunk: string) => void,
  onConvoId: (id: string) => void,
): Promise<void> {
  const ctrl = new AbortController()
  const timer = window.setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS)
  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    }
    if (conversationId) {
      headers['X-Soul-Conversation-Id'] = conversationId
    }
    const resp = await fetch(
      `${stripTrailingSlash(serverUrl)}/api/embed/${encodeURIComponent(embedId)}/messages`,
      {
        method: 'POST',
        credentials: 'omit',
        signal: ctrl.signal,
        headers,
        body: JSON.stringify({
          messages: [{ role: 'user', content: text }],
          stream: true,
        }),
      },
    )

    const respConvoId = resp.headers.get('X-Soul-Conversation-Id')
    if (respConvoId) {
      onConvoId(respConvoId)
    }

    if (resp.status === 429) {
      const retry = Number(resp.headers.get('Retry-After') ?? '3')
      throw new RateLimitError(Number.isFinite(retry) && retry > 0 ? retry : 3)
    }
    if (!resp.ok) {
      // 尝试读 JSON 错误体（widget-server 的非 200 路径会回 application/json）
      let detail = ''
      try { detail = await resp.text() } catch { detail = '' }
      throw new ServerError(resp.status, detail || `server error: ${resp.status}`)
    }

    if (!resp.body) {
      throw new ApiError(500, 'response has no body')
    }

    await consumeSseStream(resp.body, onDelta)
  } finally {
    window.clearTimeout(timer)
  }
}

function stripTrailingSlash(s: string): string {
  return s.endsWith('/') ? s.slice(0, -1) : s
}

/**
 * 读 ReadableStream，按 SSE 协议切事件，对 content_block_delta 调 onDelta。
 *
 * 协议形态（与 widget-server 透传的 Anthropic Messages 协议对齐）：
 *
 *   event: content_block_delta
 *   data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hello"}}
 *
 *   event: message_stop
 *   data: {"type":"message_stop"}
 *
 * 解析策略：
 *   - 维护 buffer，按 \n\n 切完整事件块（半事件留在 buffer 等下一轮）
 *   - 每个事件块逐行；只关心 data: 开头的行，event: 行用作可选辅助
 *   - data 行可能多行；按 SSE 规范用 \n 拼接（这里我们只期望单行 JSON，但容错处理）
 */
async function consumeSseStream(
  body: ReadableStream<Uint8Array>,
  onDelta: (chunk: string) => void,
): Promise<void> {
  const reader = body.getReader()
  const decoder = new TextDecoder('utf-8')
  let buffer = ''

  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    // 切事件块
    let sepIdx: number
    while ((sepIdx = buffer.indexOf('\n\n')) !== -1) {
      const rawEvent = buffer.slice(0, sepIdx)
      buffer = buffer.slice(sepIdx + 2)
      processSseEvent(rawEvent, onDelta)
    }
  }
  // 最后一段 flush
  buffer += decoder.decode()
  if (buffer.trim().length > 0) {
    processSseEvent(buffer, onDelta)
  }
}

function processSseEvent(raw: string, onDelta: (chunk: string) => void): void {
  // 跳过空块 / 注释行（: 开头）
  const lines = raw.split(/\r?\n/)
  const dataLines: string[] = []
  for (const line of lines) {
    if (line.length === 0) continue
    if (line.startsWith(':')) continue
    if (line.startsWith('data:')) {
      // 标准 SSE：去掉 'data:' 后允许一个可选空格
      const v = line.slice(5).replace(/^ /, '')
      dataLines.push(v)
    }
    // event: 行不再使用——只看 data 内容里的 type 字段，避免双重判断
  }
  if (dataLines.length === 0) return
  const data = dataLines.join('\n')
  // [DONE] 终止标记（部分 OpenAI 风格透传产物）
  if (data === '[DONE]') return
  type SseEvent = { type?: string; delta?: { type?: string; text?: string } }
  let parsed: SseEvent | null = null
  try {
    parsed = JSON.parse(data) as SseEvent
  } catch {
    // 非 JSON 行（注释 / keep-alive）静默
    return
  }
  if (!parsed) return
  const delta = parsed.delta
  if (parsed.type === 'content_block_delta' && delta?.type === 'text_delta' && typeof delta.text === 'string') {
    onDelta(delta.text)
  }
  // 其他 event（message_start / message_stop / ping）无视
}
