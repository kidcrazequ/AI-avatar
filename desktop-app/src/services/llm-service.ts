import { createParser } from 'eventsource-parser'

/**
 * 统一 LLM 服务（GAP5）
 * 基于 OpenAI 兼容接口，支持任意供应商（DeepSeek / Qwen / OpenAI / Ollama 等）。
 * 通过传入不同的 baseUrl + model + apiKey 实现多模型切换。
 */

export interface ModelConfig {
  baseUrl: string
  model: string
  apiKey: string
}

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | ContentPart[]
  tool_calls?: ToolCall[]
  tool_call_id?: string
  name?: string
}

export interface ToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

export interface LLMTool {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

/** 默认请求超时（5 分钟），防止慢网或挂死连接无限等待 */
const DEFAULT_TIMEOUT_MS = 300_000

export interface ChatOptions {
  tools?: LLMTool[]
  maxTokens?: number
  temperature?: number
  /**
   * 采样种子（OpenAI 兼容字段）。在支持的服务端（OpenAI / DeepSeek 新版等）下，
   * 同样的 messages + temperature + seed 会显著降低输出差异；
   * 不支持的服务端会忽略该字段（OpenAI 兼容协议允许未知字段），不影响调用。
   */
  seed?: number
  signal?: AbortSignal
}

/** 默认模型配置 */
export const DEFAULT_CHAT_MODEL: ModelConfig = {
  baseUrl: 'https://api.deepseek.com/v1',
  model: 'deepseek-chat',
  apiKey: '',
}

export const DEFAULT_VISION_MODEL: ModelConfig = {
  baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  model: 'qwen-vl-plus',
  apiKey: '',
}

export const DEFAULT_OCR_MODEL: ModelConfig = {
  baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  model: 'qwen-vl-ocr',
  apiKey: '',
}

/**
 * 创作模型默认配置（用于 soul.md / 技能 / 测试用例生成）。
 * 默认使用 Qwen-Max，中文创作能力优于 DeepSeek。
 * 如果用户未单独配置，系统自动回退到 chat 模型。
 */
export const DEFAULT_CREATION_MODEL: ModelConfig = {
  baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  model: 'qwen-max',
  apiKey: '',
}

/**
 * 选择最优模型：优先使用 creationModel，未配置则回退到 chatModel。
 */
export function resolveCreationModel(creationModel: ModelConfig, chatModel: ModelConfig): ModelConfig {
  if (creationModel.apiKey) return creationModel
  return chatModel
}

export class LLMService {
  private config: ModelConfig

  constructor(config: ModelConfig) {
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
    } else {
      throw new Error(`API 请求失败 (${status}): ${errorText}`)
    }
  }

  /**
   * 流式对话，支持工具调用。
   * onChunk: 每收到文本片段时回调
   * onToolCall: 收到工具调用时回调（非流式场景）
   * onDone: 完成时回调，携带完整回复文本和可能的工具调用列表
   * onError: 错误时回调
   */
  async chat(
    messages: LLMMessage[],
    onChunk: (text: string) => void,
    onDone: (fullText: string, toolCalls?: ToolCall[]) => void,
    onError: (error: Error) => void,
    options: ChatOptions = {}
  ): Promise<void> {
    try {
      const body: Record<string, unknown> = {
        model: this.config.model,
        messages: messages.map(this.serializeMessage),
        stream: true,
      }

      if (options.tools && options.tools.length > 0) {
        body.tools = options.tools
        body.tool_choice = 'auto'
      }
      if (options.maxTokens !== undefined) body.max_tokens = options.maxTokens
      if (options.temperature !== undefined) body.temperature = options.temperature
      if (options.seed !== undefined) body.seed = options.seed

      const timeoutSignal = AbortSignal.timeout(DEFAULT_TIMEOUT_MS)
      const mergedSignal = options.signal
        ? AbortSignal.any([options.signal, timeoutSignal])
        : timeoutSignal

      // 已显式通过 AbortSignal.timeout 做超时控制；throwOnHttpError 需要读取响应体
      // 映射到友好错误信息，fetchWithTimeout 会在 !ok 时直接抛出无法保留正文，故此处保留原生 fetch。
      // eslint-disable-next-line no-restricted-globals
      const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
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
      const toolCallsMap = new Map<number, ToolCall>()

      const parser = createParser({
        onEvent: (event) => {
          if (event.data === '[DONE]') return

          try {
            const data = JSON.parse(event.data)
            const delta = data.choices?.[0]?.delta

            if (!delta) return

            if (delta.content) {
              fullText += delta.content
              onChunk(delta.content)
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
            console.warn('[LLMService] SSE 事件解析失败:', event.data?.slice(0, 100), parseErr instanceof Error ? parseErr.message : String(parseErr))
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

      onDone(fullText, toolCalls)
    } catch (error) {
      // 区分网络错误和其他错误，给出更友好的提示
      if (error instanceof TypeError && error.message.includes('fetch')) {
        onError(new Error('网络连接失败，请检查网络和 API 地址'))
      } else if (error instanceof Error && error.name === 'AbortError') {
        onError(error)
      } else {
        onError(error instanceof Error ? error : new Error(String(error)))
      }
    }
  }

  /**
   * 非流式调用（用于 OCR/图片识别等单次请求场景）
   */
  async complete(messages: LLMMessage[], options: ChatOptions = {}): Promise<string> {
    const body: Record<string, unknown> = {
      model: this.config.model,
      messages: messages.map(this.serializeMessage),
      stream: false,
    }
    if (options.maxTokens !== undefined) body.max_tokens = options.maxTokens
    if (options.temperature !== undefined) body.temperature = options.temperature

    const timeoutSignal = AbortSignal.timeout(DEFAULT_TIMEOUT_MS)
    const mergedSignal = options.signal
      ? AbortSignal.any([options.signal, timeoutSignal])
      : timeoutSignal

    // 已显式通过 AbortSignal.timeout 做超时控制；throwOnHttpError 需要读取响应体
    // 映射到友好错误信息，fetchWithTimeout 会在 !ok 时直接抛出无法保留正文，故此处保留原生 fetch。
    // eslint-disable-next-line no-restricted-globals
    const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
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

  /** 将内部消息格式序列化为 API 请求格式（箭头函数避免 .map 丢失 this） */
  private serializeMessage = (msg: LLMMessage): Record<string, unknown> => {
    const base: Record<string, unknown> = { role: msg.role, content: msg.content }
    if (msg.tool_calls) base.tool_calls = msg.tool_calls
    if (msg.tool_call_id) base.tool_call_id = msg.tool_call_id
    if (msg.name) base.name = msg.name
    return base
  }
}
