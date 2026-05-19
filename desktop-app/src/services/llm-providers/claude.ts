import Anthropic from '@anthropic-ai/sdk'
import type { MessageParam, MessageStreamEvent, TextBlockParam, ImageBlockParam, Base64ImageSource, ToolUseBlockParam, ToolResultBlockParam, Tool as AnthropicTool } from '@anthropic-ai/sdk/resources/messages'

import type {
  ChatChunkCallback,
  ChatDoneCallback,
  ChatErrorCallback,
  LLMProvider,
  ProviderConfig,
  SystemBlock,
} from './types'
import type { ChatOptions, ContentPart, LLMMessage, LLMTool, ToolCall } from '../llm-service'

/** Anthropic 单次请求 cache breakpoint 上限（超出会被服务端拒绝） */
const MAX_CACHE_BREAKPOINTS = 4

/**
 * Anthropic Claude Provider。
 *
 * 协议转换要点（与 OpenAI-compat 的差异）：
 *   - system 是独立顶层字段，不混入 messages[]
 *   - 图片以 content block 形式传入：{type:'image', source:{type:'base64'|'url',...}}
 *   - 工具：name + input_schema（vs OpenAI 的 type:'function'+function:{...parameters}）
 *   - assistant tool_use 是 content block，回传时通过 tool_result block 关联 tool_use_id
 *   - 流式事件：content_block_delta + tool_use 的 input 是 partial_json 拼接，需要在 stop 时 JSON.parse
 *
 * 限制（v1）：
 *   - 不支持 thinking 多轮 round-trip（thinking block 需 signature，无法仅从 reasoning_content 重建）；
 *     thinking 内容仅作为 reasoningText 显示，下一轮请求中不会回传给 API
 *
 * Phase 2 起：支持 `options.systemBlocks` 结构化 system；cacheable 段尾部插入
 * `cache_control: { type: 'ephemeral' }`，单次请求最多 4 个 breakpoint。
 */

const DEFAULT_TIMEOUT_MS = 300_000
const DEFAULT_MAX_TOKENS = 4096

export class ClaudeProvider implements LLMProvider {
  private client: Anthropic
  private model: string

  constructor(config: ProviderConfig) {
    this.client = new Anthropic({
      apiKey: config.apiKey,
      baseURL: config.baseUrl || 'https://api.anthropic.com',
      // Electron renderer 等同浏览器环境，但本地存储 key 不会发往第三方
      dangerouslyAllowBrowser: true,
      timeout: DEFAULT_TIMEOUT_MS,
    })
    this.model = config.model
  }

  async chat(
    messages: LLMMessage[],
    onChunk: ChatChunkCallback,
    onDone: ChatDoneCallback,
    onError: ChatErrorCallback,
    options: ChatOptions = {},
  ): Promise<void> {
    try {
      const { system: fallbackSystem, claudeMessages } = convertMessages(messages)
      const system = options.systemBlocks
        ? buildSystemBlocks(options.systemBlocks)
        : fallbackSystem
      const tools = options.tools && options.tools.length > 0 ? convertTools(options.tools) : undefined

      const stream = this.client.messages.stream({
        model: this.model,
        system,
        messages: claudeMessages,
        max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
        tools,
        ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
      }, {
        signal: options.signal,
      })

      let fullText = ''
      let reasoningText = ''
      /** 按 content_block 的 index 累积 tool_use 的 partial_json */
      const toolUseAcc = new Map<number, { id: string; name: string; partialJson: string }>()
      let normalizedUsage: import('./types').NormalizedUsage | undefined

      for await (const event of stream as AsyncIterable<MessageStreamEvent>) {
        if (event.type === 'content_block_start') {
          const block = event.content_block
          if (block.type === 'tool_use') {
            toolUseAcc.set(event.index, {
              id: block.id,
              name: block.name,
              partialJson: '',
            })
          }
        } else if (event.type === 'content_block_delta') {
          const delta = event.delta
          if (delta.type === 'text_delta') {
            fullText += delta.text
            onChunk(delta.text, 'content')
          } else if (delta.type === 'thinking_delta') {
            reasoningText += delta.thinking
            onChunk(delta.thinking, 'reasoning')
          } else if (delta.type === 'input_json_delta') {
            const acc = toolUseAcc.get(event.index)
            if (acc) acc.partialJson += delta.partial_json
          }
        } else if (event.type === 'message_delta' && event.usage) {
          // 在 final 事件累积 usage（cache_read/creation 字段是 Anthropic prompt cache 命中指标）
          const u = event.usage
          const cacheRead = (u as { cache_read_input_tokens?: number }).cache_read_input_tokens ?? 0
          const cacheCreation = (u as { cache_creation_input_tokens?: number }).cache_creation_input_tokens ?? 0
          const input = u.input_tokens ?? 0
          // Anthropic 把 cache_read / cache_creation 与 input_tokens 分开计；总 input = 三者之和
          const totalInput = input + cacheRead + cacheCreation
          const hitRatio = totalInput > 0 ? cacheRead / totalInput : 0
          // eslint-disable-next-line no-console
          console.info(
            `[llm-cache] provider=anthropic input_tokens=${input} cache_read=${cacheRead} cache_creation=${cacheCreation} hit_ratio=${(hitRatio * 100).toFixed(1)}% output_tokens=${u.output_tokens ?? '?'}`,
          )
          normalizedUsage = {
            inputTokens: input,
            outputTokens: u.output_tokens ?? 0,
            cacheReadTokens: cacheRead,
            cacheCreationTokens: cacheCreation,
          }
        }
      }

      const toolCalls = toolUseAcc.size > 0
        ? Array.from(toolUseAcc.entries())
            .sort(([a], [b]) => a - b)
            .map(([, v]): ToolCall => ({
              id: v.id,
              type: 'function',
              function: { name: v.name, arguments: v.partialJson || '{}' },
            }))
        : undefined

      onDone(fullText, toolCalls, reasoningText || undefined, normalizedUsage)
    } catch (error) {
      onError(mapAnthropicError(error))
    }
  }

  async complete(messages: LLMMessage[], options: ChatOptions = {}): Promise<string> {
    try {
      const { system: fallbackSystem, claudeMessages } = convertMessages(messages)
      const system = options.systemBlocks
        ? buildSystemBlocks(options.systemBlocks)
        : fallbackSystem
      const response = await this.client.messages.create({
        model: this.model,
        system,
        messages: claudeMessages,
        max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
        ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
      }, {
        signal: options.signal,
      })

      // 提取首个 text block；忽略 tool_use / thinking 块（complete 不应触发工具）
      const textBlock = response.content.find((b) => b.type === 'text')
      return textBlock && textBlock.type === 'text' ? textBlock.text : ''
    } catch (error) {
      throw mapAnthropicError(error)
    }
  }
}

/**
 * OpenAI 消息序列 → Anthropic { system, messages }。
 *
 * 处理：
 *   - role=system → 合并到 system 字段（多个则按顺序拼接）
 *   - role=user/assistant 字符串 content → 直接传入
 *   - role=user/assistant ContentPart[] → 转 text/image block
 *   - role=assistant + tool_calls → 合成 assistant 消息，附 tool_use blocks
 *   - role=tool → 重写为 role=user + tool_result block（Claude 协议要求）
 */
function convertMessages(messages: LLMMessage[]): {
  system: string | undefined
  claudeMessages: MessageParam[]
} {
  const systemParts: string[] = []
  const out: MessageParam[] = []

  for (const msg of messages) {
    if (msg.role === 'system') {
      if (typeof msg.content === 'string') systemParts.push(msg.content)
      else systemParts.push(stringifyContent(msg.content))
      continue
    }

    if (msg.role === 'tool') {
      const text = typeof msg.content === 'string' ? msg.content : stringifyContent(msg.content)
      const block: ToolResultBlockParam = {
        type: 'tool_result',
        tool_use_id: msg.tool_call_id ?? '',
        content: text,
      }
      out.push({ role: 'user', content: [block] })
      continue
    }

    if (msg.role === 'assistant') {
      const blocks: Array<TextBlockParam | ToolUseBlockParam> = []
      if (typeof msg.content === 'string') {
        if (msg.content.length > 0) blocks.push({ type: 'text', text: msg.content })
      } else {
        for (const part of msg.content) {
          if (part.type === 'text' && part.text.length > 0) {
            blocks.push({ type: 'text', text: part.text })
          }
          // assistant 不会带 image_url；忽略
        }
      }
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          let input: unknown
          try {
            input = JSON.parse(tc.function.arguments || '{}')
          } catch {
            input = {}
          }
          blocks.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.function.name,
            input: input as Record<string, unknown>,
          })
        }
      }
      if (blocks.length === 0) blocks.push({ type: 'text', text: '' })
      out.push({ role: 'assistant', content: blocks })
      continue
    }

    // role === 'user'
    if (typeof msg.content === 'string') {
      out.push({ role: 'user', content: msg.content })
    } else {
      const blocks: Array<TextBlockParam | ImageBlockParam> = []
      for (const part of msg.content) {
        if (part.type === 'text') {
          blocks.push({ type: 'text', text: part.text })
        } else if (part.type === 'image_url') {
          blocks.push(imageBlockFromUrl(part.image_url.url))
        }
      }
      out.push({ role: 'user', content: blocks })
    }
  }

  return {
    system: systemParts.length > 0 ? systemParts.join('\n\n') : undefined,
    claudeMessages: out,
  }
}

/** 把 ContentPart[] 串成纯文本（fallback；image 用「[image]」占位） */
function stringifyContent(parts: ContentPart[]): string {
  return parts
    .map((p) => (p.type === 'text' ? p.text : '[image]'))
    .join('')
}

/**
 * 将 OpenAI 的 image_url 转成 Claude image block。
 *
 * 支持两种输入：
 *   - data:image/png;base64,xxx → base64 source
 *   - https://... → url source
 */
function imageBlockFromUrl(url: string): ImageBlockParam {
  const dataUrlMatch = /^data:([^;]+);base64,(.+)$/.exec(url)
  if (dataUrlMatch) {
    return {
      type: 'image',
      source: {
        type: 'base64',
        media_type: dataUrlMatch[1] as Base64ImageSource['media_type'],
        data: dataUrlMatch[2],
      },
    }
  }
  return {
    type: 'image',
    source: { type: 'url', url },
  }
}

/** OpenAI tools → Claude tools */
function convertTools(tools: LLMTool[]): AnthropicTool[] {
  return tools.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters as AnthropicTool['input_schema'],
  }))
}

/**
 * SystemBlock[] → Anthropic system 参数（TextBlockParam[]）。
 *
 * cacheable=true 的段在尾部插入 `cache_control: { type: 'ephemeral' }`，
 * 服务端最多识别 4 个 breakpoint——超过的标记会被静默丢弃，
 * 因此在客户端就先截断到前 4 个 cacheable，明确报警。
 */
function buildSystemBlocks(blocks: SystemBlock[]): TextBlockParam[] {
  const out: TextBlockParam[] = []
  let cacheBreakpointsUsed = 0
  for (const block of blocks) {
    if (!block.text || block.text.length === 0) continue
    const text: TextBlockParam = { type: 'text', text: block.text }
    if (block.cacheable && cacheBreakpointsUsed < MAX_CACHE_BREAKPOINTS) {
      text.cache_control = { type: 'ephemeral' }
      cacheBreakpointsUsed += 1
    } else if (block.cacheable) {
      console.warn(`[claude-provider] cache breakpoint 超过上限 ${MAX_CACHE_BREAKPOINTS}，本段标记被忽略`)
    }
    out.push(text)
  }
  return out
}

/** Anthropic SDK error → 与 OpenAICompat 一致的人类可读 Error */
function mapAnthropicError(error: unknown): Error {
  if (error instanceof Anthropic.APIError) {
    const status = error.status ?? 0
    const msg = error.message || ''
    if (status === 401 || status === 403) {
      return new Error(`Anthropic API 密钥无效或已过期，请在设置中检查 (${status})`)
    }
    if (status === 429) {
      return new Error(`Anthropic 请求频率超限或额度用尽，请稍后重试 (429)`)
    }
    if (status >= 500) {
      return new Error(`Anthropic 服务端暂时不可用，请稍后重试 (${status})`)
    }
    return new Error(`Anthropic API 请求失败 (${status}): ${msg}`)
  }
  if (error instanceof Error) {
    if (error.name === 'AbortError') return error
    if (error.message.includes('fetch') || error.message.includes('network')) {
      return new Error('网络连接失败，请检查网络和 API 地址')
    }
    return error
  }
  return new Error(String(error))
}
