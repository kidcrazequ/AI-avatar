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

export interface ChatOptions {
  tools?: LLMTool[]
  maxTokens?: number
  temperature?: number
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

export class LLMService {
  private config: ModelConfig

  constructor(config: ModelConfig) {
    this.config = config
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
      if (options.maxTokens) body.max_tokens = options.maxTokens
      if (options.temperature !== undefined) body.temperature = options.temperature

      const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify(body),
      })

      if (!response.ok) {
        const errorText = await response.text().catch(() => response.statusText)
        throw new Error(`API 请求失败 (${response.status}): ${errorText}`)
      }

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
            const delta = data.choices[0]?.delta

            if (!delta) return

            // 普通文本内容
            if (delta.content) {
              fullText += delta.content
              onChunk(delta.content)
            }

            // 工具调用（增量拼接）
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
          } catch {
            // 忽略解析错误的单个事件
          }
        },
      })

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        parser.feed(decoder.decode(value, { stream: true }))
      }

      const toolCalls = toolCallsMap.size > 0
        ? Array.from(toolCallsMap.values()).sort((a, b) => {
            const ai = parseInt(a.id.replace(/\D/g, '') || '0')
            const bi = parseInt(b.id.replace(/\D/g, '') || '0')
            return ai - bi
          })
        : undefined

      onDone(fullText, toolCalls)
    } catch (error) {
      onError(error as Error)
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
    if (options.maxTokens) body.max_tokens = options.maxTokens

    const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      const errorText = await response.text().catch(() => response.statusText)
      throw new Error(`API 请求失败 (${response.status}): ${errorText}`)
    }

    const data = await response.json()
    return data.choices[0]?.message?.content ?? ''
  }

  /** 将内部消息格式序列化为 API 请求格式 */
  private serializeMessage(msg: LLMMessage): Record<string, unknown> {
    const base: Record<string, unknown> = { role: msg.role }

    if (typeof msg.content === 'string') {
      base.content = msg.content
    } else {
      base.content = msg.content
    }

    if (msg.tool_calls) base.tool_calls = msg.tool_calls
    if (msg.tool_call_id) base.tool_call_id = msg.tool_call_id
    if (msg.name) base.name = msg.name

    return base
  }
}
