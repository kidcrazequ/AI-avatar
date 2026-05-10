/**
 * Anthropic Messages API ⇄ Soul Proxy 的轻量协议辅助（仅字符串与结构，不含业务）。
 *
 * @author zhi.qu
 * @date 2026-05-09
 */

/** SSE 单行：event + data（Anthropic stream 兼容） */
export function formatSseEvent(eventName: string, data: unknown): string {
  return `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`
}

export function extractLastUserTextFromAnthropic(messages: unknown): string {
  if (!Array.isArray(messages)) {
    throw new Error('messages 必须为非空数组')
  }
  const userMsgs = messages.filter((m): m is Record<string, unknown> =>
    Boolean(m) && typeof m === 'object' && (m as Record<string, unknown>).role === 'user',
  )
  const last = userMsgs[userMsgs.length - 1]
  if (!last) throw new Error('缺少 role=user 的消息')
  return extractTextBlock(last.content)
}

function extractTextBlock(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return String(content ?? '')
  const parts: string[] = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    const b = block as Record<string, unknown>
    if (b.type === 'text' && typeof b.text === 'string') {
      parts.push(b.text)
    }
  }
  if (parts.length === 0) {
    throw new Error('暂不支持非 text 的 user 内容块（请使用 text 块）')
  }
  return parts.join('')
}

/** 流式：单个文本 delta（index 0） */
export function textDeltaJson(text: string): Record<string, unknown> {
  return {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text },
  }
}
