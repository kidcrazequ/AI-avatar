/**
 * soul 自有 proxy 的客户端（AstrBot 借鉴 · ⑦ 适配器地基 · P-a）。
 *
 * IM 适配器（飞书等）只负责收发平台消息，"叫 soul 出答案"这半边统一走这里——调用 soul
 * 已有的 Anthropic 兼容 proxy（`POST /v1/messages`），拿到分身的完整回复文本。这样适配器
 * 完全自包含、不碰渲染层/核心 sendMessage，proxy 挂了也不影响 UI。
 *
 * 走非流式：bot 场景一次性回全文，最简且够用（proxy 侧 JOB 超时 5min 与本处默认对齐）。
 */

import { fetchWithTimeout } from '@soul/core'

export interface RunViaSoulProxyOptions {
  /** proxy 基址，如 http://127.0.0.1:18888 */
  baseUrl: string
  /** proxy_api_token（Bearer 鉴权） */
  token: string
  /** x-soul-conversation-id：决定哪个分身应答（会话绑定分身）；适配器负责维护 平台会话↔soul会话 映射 */
  conversationId: string
  /** 用户消息文本 */
  text: string
  /** Anthropic model 字段（透传，可选） */
  model?: string
  /** max_tokens（默认 4096） */
  maxTokens?: number
  /** 超时毫秒（默认 5 分钟，与 proxy JOB_TIMEOUT 对齐） */
  timeoutMs?: number
}

/**
 * 从 Anthropic Messages 响应中提取并拼接所有 text 块。容错：非对象 / content 非数组 /
 * 非 text 块 / text 缺失 一律安全跳过，返回已拼接文本（可能为空串）。
 */
export function extractAnthropicText(json: unknown): string {
  if (!json || typeof json !== 'object') return ''
  const content = (json as { content?: unknown }).content
  if (!Array.isArray(content)) return ''
  return content
    .filter((c): c is { type: string; text: string } =>
      !!c && typeof c === 'object' && (c as { type?: unknown }).type === 'text' && typeof (c as { text?: unknown }).text === 'string')
    .map(c => c.text)
    .join('')
}

/**
 * 调用 soul proxy（非流式）拿分身完整回复文本。
 * 非 2xx 由 fetchWithTimeout 抛 HttpError；调用方（适配器）负责兜底并回平台。
 */
export async function runViaSoulProxy(opts: RunViaSoulProxyOptions): Promise<string> {
  const body = {
    model: opts.model ?? 'soul',
    max_tokens: opts.maxTokens ?? 4096,
    messages: [{ role: 'user', content: opts.text }],
    stream: false,
  }
  const res = await fetchWithTimeout(`${opts.baseUrl.replace(/\/+$/, '')}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${opts.token}`,
      'x-soul-conversation-id': opts.conversationId,
    },
    body: JSON.stringify(body),
    timeoutMs: opts.timeoutMs ?? 5 * 60 * 1000,
  })
  const json: unknown = await res.json()
  return extractAnthropicText(json)
}
