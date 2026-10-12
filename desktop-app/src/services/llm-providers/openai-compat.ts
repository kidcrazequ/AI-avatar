import { createParser } from 'eventsource-parser'

import type {
  ChatChunkCallback,
  ChatDoneCallback,
  ChatErrorCallback,
  LLMProvider,
  ProviderConfig,
  SystemBlock,
} from './types'
import { detectReasoning, reasoningBudgetTokens, type ChatOptions, type LLMMessage, type ToolCall } from '../llm-service'

/**
 * 把 SystemBlock[] 拍平成单条 role=system 消息。
 *
 * OpenAI 兼容协议不识别 cache_control 字段——DeepSeek 等是基于"前缀字节稳定"的自动命中机制，
 * 只要 systemBlocks 顺序稳定、内容稳定，拼接结果天然保持前缀稳定。
 *
 * 调用方应负责把"稳定的"放前面、"易变的"放后面，让 cache 命中前缀尽可能长。
 */
function applySystemBlocks(messages: LLMMessage[], systemBlocks: SystemBlock[]): LLMMessage[] {
  const nonSystem = messages.filter((m) => m.role !== 'system')
  const text = systemBlocks.map((b) => b.text).join('\n\n')
  if (text.length === 0) return nonSystem
  return [{ role: 'system' as const, content: text }, ...nonSystem]
}

/**
 * OpenAI-compatible Provider。
 *
 * 适配所有遵循 OpenAI /chat/completions 协议的服务端：
 *   DeepSeek / Qwen / OpenAI / Ollama / SiliconFlow / 其他兼容代理。
 *
 * 与原 LLMService 行为完全一致（逐行迁移，保留所有错误映射、cache 指标、reasoning round-trip）。
 * 后续 LLMService 退化为 dispatcher，按模型名路由到本 provider 或 ClaudeProvider。
 */

/** 默认请求超时（5 分钟），防止慢网或挂死连接无限等待 */
const DEFAULT_TIMEOUT_MS = 300_000

export class OpenAICompatProvider implements LLMProvider {
  private config: ProviderConfig

  constructor(config: ProviderConfig) {
    this.config = config
  }

  /** 统一 HTTP 错误处理，避免 chat/complete 中重复代码 */
  private async throwOnHttpError(response: Response): Promise<void> {
    if (response.ok) return
    const errorText = await response.text().catch(() => response.statusText)
    const { status } = response
    if (status === 401 || status === 403) {
      throw new Error(`API 密钥无效或已过期，请在设置中检查 (${status})`)
    } else if (status === 429) {
      throw new Error(`请求频率超限或额度用尽，请稍后重试 (429)`)
    } else if (status >= 500) {
      throw new Error(`服务端暂时不可用，请稍后重试 (${status})`)
    } else if (status === 400 && /must be (passed back|provided|sent back)|reasoning_content/i.test(errorText)) {
      // DeepSeek-Reasoner 等 thinking 模型要求多轮回传 reasoning_content；这是 client 实现 bug
      throw new Error(`reasoning_content 未在多轮 round-trip 中回传，请检查 client 是否在 assistant 消息中保留了 thinking 模型的 reasoning_content 字段 (400): ${errorText}`)
    } else if (status === 400 && /(unknown parameter|not supported|unsupported|invalid parameter).*?(reasoning_effort|thinking)/i.test(errorText)) {
      // 真正不支持 thinking 参数的模型
      throw new Error(`该模型或服务商不支持 thinking 参数，请切换普通模型或关闭 reasoning 配置 (400): ${errorText}`)
    } else {
      throw new Error(`API 请求失败 (${status}): ${errorText}`)
    }
  }

  async chat(
    messages: LLMMessage[],
    onChunk: ChatChunkCallback,
    onDone: ChatDoneCallback,
    onError: ChatErrorCallback,
    options: ChatOptions = {},
  ): Promise<void> {
    try {
      const effectiveMessages = options.systemBlocks
        ? applySystemBlocks(messages, options.systemBlocks)
        : messages
      const body: Record<string, unknown> = {
        model: this.config.model,
        messages: effectiveMessages.map(this.serializeMessage),
        stream: true,
      }

      if (options.tools && options.tools.length > 0) {
        body.tools = options.tools
        body.tool_choice = 'auto'
      }
      if (options.maxTokens !== undefined) body.max_tokens = options.maxTokens
      if (options.temperature !== undefined) body.temperature = options.temperature
      if (options.seed !== undefined) body.seed = options.seed
      const reasoning = detectReasoning(this.config.model)
      const reasoningEffort = options.reasoningEffort ?? reasoning.effort
      if (reasoning.enabled || options.reasoningEffort !== undefined) {
        body.reasoning_effort = reasoningEffort
        body.thinking = {
          type: 'enabled',
          budget_tokens: reasoningBudgetTokens(reasoningEffort),
        }
      }

      const timeoutSignal = AbortSignal.timeout(DEFAULT_TIMEOUT_MS)
      const mergedSignal = options.signal
        ? AbortSignal.any([options.signal, timeoutSignal])
        : timeoutSignal

      // 已显式通过 AbortSignal.timeout 做超时控制；throwOnHttpError 需要读取响应体
      // 映射到友好错误信息，fetchWithTimeout 会在 !ok 时直接抛出无法保留正文，故此处保留原生 fetch。
      const base = this.config.baseUrl.replace(/\/+$/, '')
      // eslint-disable-next-line no-restricted-globals
      const response = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: mergedSignal,
      })

      await this.throwOnHttpError(response)

      const reader = response.body?.getReader()
      if (!reader) throw new Error('无法读取响应流')

      const decoder = new TextDecoder()
      let fullText = ''
      let reasoningText = ''
      const toolCallsMap = new Map<number, ToolCall>()
      let normalizedUsage: import('./types').NormalizedUsage | undefined

      const parser = createParser({
        onEvent: (event) => {
          if (event.data === '[DONE]') return

          try {
            const data = JSON.parse(event.data)

            // DeepSeek / OpenAI 兼容协议：usage 在 stream 最后一条非 [DONE] chunk 里。
            // prompt_cache_hit_tokens / prompt_cache_miss_tokens 是 DeepSeek 自动 prefix-cache 命中字段。
            if (data.usage && (data.usage.prompt_cache_hit_tokens !== undefined || data.usage.prompt_tokens !== undefined)) {
              const u = data.usage
              const total = u.prompt_tokens ?? 0
              const hit = u.prompt_cache_hit_tokens ?? 0
              const miss = u.prompt_cache_miss_tokens ?? (total - hit)
              const hitRatio = total > 0 ? hit / total : 0
              // eslint-disable-next-line no-console
              console.info(
                `[llm-cache] provider=openai-compat prompt_tokens=${total} cache_hit=${hit} cache_miss=${miss} hit_ratio=${(hitRatio * 100).toFixed(1)}% completion=${u.completion_tokens ?? '?'}`,
              )
              // OpenAI/DeepSeek 的 prompt_tokens 已含 cache hit；归一化时把 inputTokens 拆成 miss + cacheRead
              normalizedUsage = {
                inputTokens: miss,
                outputTokens: u.completion_tokens ?? 0,
                cacheReadTokens: hit,
              }
            }

            const delta = data.choices?.[0]?.delta
            if (!delta) return

            if (delta.reasoning_content) {
              reasoningText += delta.reasoning_content
              onChunk(delta.reasoning_content, 'reasoning')
            }

            if (delta.content) {
              fullText += delta.content
              onChunk(delta.content, 'content')
            }

            if (delta.tool_calls) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index ?? 0
                if (!toolCallsMap.has(idx)) {
                  toolCallsMap.set(idx, {
                    id: tc.id ?? `call_${idx}`,
                    type: 'function',
                    function: { name: tc.function?.name ?? '', arguments: '' },
                  })
                }
                const existing = toolCallsMap.get(idx)!
                if (tc.function?.name) existing.function.name = tc.function.name
                if (tc.function?.arguments) existing.function.arguments += tc.function.arguments
              }
            }
          } catch (parseErr) {
            console.warn('[OpenAICompat] SSE 事件解析失败:', event.data?.slice(0, 100), parseErr instanceof Error ? parseErr.message : String(parseErr))
          }
        },
      })

      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          parser.feed(decoder.decode(value, { stream: true }))
        }
      } finally {
        // eslint-disable-next-line @typescript-eslint/no-empty-function -- reader 可能已被取消或网络已断，忽略失败
        reader.cancel().catch(() => {})
      }

      const toolCalls = toolCallsMap.size > 0
        ? Array.from(toolCallsMap.entries())
            .sort(([a], [b]) => a - b)
            .map(([, v]) => v)
        : undefined

      onDone(fullText, toolCalls, reasoningText || undefined, normalizedUsage)
    } catch (error) {
      if (error instanceof TypeError && error.message.includes('fetch')) {
        onError(new Error('网络连接失败，请检查网络和 API 地址'))
      } else if (error instanceof Error && error.name === 'AbortError') {
        onError(error)
      } else {
        onError(error instanceof Error ? error : new Error(String(error)))
      }
    }
  }

  async complete(messages: LLMMessage[], options: ChatOptions = {}): Promise<string> {
    const effectiveMessages = options.systemBlocks
      ? applySystemBlocks(messages, options.systemBlocks)
      : messages
    const body: Record<string, unknown> = {
      model: this.config.model,
      messages: effectiveMessages.map(this.serializeMessage),
      stream: false,
    }
    if (options.maxTokens !== undefined) body.max_tokens = options.maxTokens
    if (options.temperature !== undefined) body.temperature = options.temperature

    const timeoutSignal = AbortSignal.timeout(DEFAULT_TIMEOUT_MS)
    const mergedSignal = options.signal
      ? AbortSignal.any([options.signal, timeoutSignal])
      : timeoutSignal

    const base = this.config.baseUrl.replace(/\/+$/, '')
    // eslint-disable-next-line no-restricted-globals
    const response = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: mergedSignal,
    })

    await this.throwOnHttpError(response)

    let data: { choices?: Array<{ message?: { content?: string } }> }
    try {
      data = await response.json()
    } catch (jsonErr) {
      throw new Error(`API 响应解析失败：${jsonErr instanceof Error ? jsonErr.message : String(jsonErr)}`)
    }
    return data.choices?.[0]?.message?.content ?? ''
  }

  private serializeMessage = (msg: LLMMessage): Record<string, unknown> => {
    const base: Record<string, unknown> = { role: msg.role, content: msg.content }
    if (msg.tool_calls) base.tool_calls = msg.tool_calls
    if (msg.tool_call_id) base.tool_call_id = msg.tool_call_id
    if (msg.name) base.name = msg.name
    if (msg.reasoning_content !== undefined) base.reasoning_content = msg.reasoning_content
    return base
  }
}
