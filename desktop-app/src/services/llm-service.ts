import { ClaudeProvider } from './llm-providers/claude'
import { OpenAICompatProvider } from './llm-providers/openai-compat'
import type { LLMProvider, SystemBlock } from './llm-providers/types'

// 重新导出，让调用方从 llm-service 一处取就行
export type { SystemBlock }

/**
 * 统一 LLM 服务（GAP5）
 * 自 2026-05 起 LLMService 退化为薄 facade：内部委托给 LLMProvider 实现。
 *
 * - OpenAI-compat（DeepSeek / Qwen / OpenAI / Ollama 等）→ OpenAICompatProvider
 * - Anthropic Claude（claude-*）→ ClaudeProvider（子任务 4 引入）
 *
 * 对外接口（chat / complete / 类型导出）保持不变，调用方无需感知 provider 切换。
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
  /**
   * 思维链文本（DeepSeek-Reasoner 等 thinking 模型）
   * 必须在多轮 round-trip 中原样回传到 assistant 消息，否则 API 会直接 400。
   */
  reasoning_content?: string
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

export type ReasoningEffort = 'low' | 'medium' | 'high'

/** 已知支持 thinking/reasoning 输出的模型名匹配 */
const REASONING_MODEL_REGEX = /(^|[-/])(deepseek-reasoner|deepseek-r1|o1|o3|gpt-5|qwen-?qwq|glm-4-thinking)|claude.*thinking/i

export function detectReasoning(modelName: string): { enabled: boolean; effort: ReasoningEffort } {
  return REASONING_MODEL_REGEX.test(modelName)
    ? { enabled: true, effort: 'medium' }
    : { enabled: false, effort: 'low' }
}

/** thinking budget token 预算（由 Provider 内部使用） */
export function reasoningBudgetTokens(effort: ReasoningEffort): number {
  if (effort === 'high') return 16000
  if (effort === 'medium') return 8000
  return 2000
}

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
  /** reasoning 模型可显式覆盖思考强度；未设置时按模型名自动检测 */
  reasoningEffort?: ReasoningEffort
  signal?: AbortSignal
  /**
   * 结构化 system prompt 分段（Phase 2）。
   *
   * 提供时**取代** messages 中 role=system 的消息；Claude 上会按 cacheable 标记插入
   * cache_control；OpenAI-compat 拍平成单条 system message。
   *
   * 未提供时 provider 仍按 messages 中的 system 消息处理（兼容老调用方式）。
   */
  systemBlocks?: SystemBlock[]
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

/**
 * 模型名是否为 Anthropic Claude 系列。
 * 用于 LLMService dispatcher 选择 Provider。
 */
export function isClaudeModel(model: string): boolean {
  return /^claude-/i.test(model)
}

/**
 * Anthropic 凭据（独立于 OpenAI-compat slot 的 sibling 设置）。
 *
 * 由调用方（chatStore 等）从 SQLite settings 读取 `anthropic_api_key` / `anthropic_base_url` 并注入。
 * 仅在选用 Claude 模型时使用——OpenAI-compat 走 ModelConfig 中已有的 apiKey/baseUrl。
 */
export interface AnthropicCredentials {
  apiKey: string
  baseUrl: string
}

export class LLMService {
  private provider: LLMProvider

  /**
   * @param config OpenAI-compat 配置（baseUrl + model + apiKey）。
   *               model 名匹配 `claude-*` 时此处的 apiKey/baseUrl 会被忽略，改用第 2 参数。
   * @param anthropicCreds 选用 Claude 模型时必传；否则忽略。
   *                       未提供而 model 是 claude-* 时构造抛错，避免静默走错路径。
   */
  constructor(config: ModelConfig, anthropicCreds?: AnthropicCredentials) {
    if (isClaudeModel(config.model)) {
      if (!anthropicCreds || !anthropicCreds.apiKey) {
        throw new Error(`未配置 Anthropic API Key，无法使用模型 ${config.model}。请在设置 → 外部 API 凭据 → Anthropic Claude 填写 API Key`)
      }
      this.provider = new ClaudeProvider({
        apiKey: anthropicCreds.apiKey,
        baseUrl: anthropicCreds.baseUrl || 'https://api.anthropic.com',
        model: config.model,
      })
    } else {
      this.provider = new OpenAICompatProvider(config)
    }
  }

  /**
   * 流式对话，支持工具调用。
   * 委托给 Provider，对外签名与历史完全一致。
   */
  async chat(
    messages: LLMMessage[],
    onChunk: (text: string, kind?: 'content' | 'reasoning') => void,
    onDone: (
      fullText: string,
      toolCalls?: ToolCall[],
      reasoningText?: string,
      usage?: import('./llm-providers/types').NormalizedUsage,
    ) => void,
    onError: (error: Error) => void,
    options: ChatOptions = {},
  ): Promise<void> {
    return this.provider.chat(messages, onChunk, onDone, onError, options)
  }

  /** 非流式调用（用于 OCR/图片识别等单次请求场景） */
  async complete(messages: LLMMessage[], options: ChatOptions = {}): Promise<string> {
    return this.provider.complete(messages, options)
  }
}
