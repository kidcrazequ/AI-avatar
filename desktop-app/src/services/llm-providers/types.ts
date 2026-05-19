/**
 * LLM Provider 抽象接口。
 *
 * 同一组 messages / tools / 回调签名跨 provider 复用；
 * 各 provider（OpenAI-compat、Anthropic）实现自己的 HTTP/SSE 细节。
 *
 * 设计要点：
 *   - 保持与原 LLMService.chat / complete 完全一致的回调形态，避免 chatStore 大改
 *   - 跨 provider 共享 LLMMessage / ToolCall / ChatOptions（type-only import，无运行时循环）
 */

import type { LLMMessage, ToolCall, ChatOptions } from '../llm-service'

export type ChatChunkCallback = (text: string, kind?: 'content' | 'reasoning') => void
/**
 * onDone 第四个参数 usage：provider 把本轮归一化 token 用量透传出来，
 * 上层（chatStore）据此 emit telemetry / cost-tracker。可为 undefined（mock provider 等）。
 */
export type ChatDoneCallback = (
  fullText: string,
  toolCalls?: ToolCall[],
  reasoningText?: string,
  usage?: NormalizedUsage,
) => void
export type ChatErrorCallback = (error: Error) => void

/**
 * 跨 provider 的统一 usage 视图（归一化后）。
 *
 * 各家原始字段差异：
 *   - OpenAI/DeepSeek：prompt_tokens / completion_tokens / prompt_cache_hit_tokens / prompt_cache_miss_tokens
 *   - Anthropic：input_tokens / output_tokens / cache_creation_input_tokens / cache_read_input_tokens
 *
 * Provider 内部按需归一化为本类型，方便上层做成本看板。
 */
export interface NormalizedUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheCreationTokens?: number
}

/**
 * Provider 实例化配置（最小公共集）。
 *
 * 不同 provider 对字段的解读不同：
 *   - OpenAI-compat：baseUrl + model + apiKey 一一映射 fetch 调用
 *   - Anthropic：baseUrl 默认 https://api.anthropic.com，model 用 claude-* 命名
 */
export interface ProviderConfig {
  baseUrl: string
  model: string
  apiKey: string
}

/**
 * 结构化 system prompt 分段。
 *
 * Phase 2 引入：用于在 Claude 上精确标记 cache_control 边界。
 *
 * cacheable=true 时：
 *   - Anthropic：在该 block 后插入 `cache_control: { type: 'ephemeral' }`，享受 prompt cache
 *   - OpenAI-compat：忽略；DeepSeek 等的 prefix cache 是字节级自动命中，只要前缀稳定即可
 *
 * Anthropic 最多 4 个 cache breakpoint；超过的 cacheable 段将被截断（保留前 4 个），
 * 调用方应按"稳定 → 易变"顺序排列 blocks。
 */
export interface SystemBlock {
  text: string
  /** Anthropic：是否在此段尾部插入 cache_control 标记 */
  cacheable?: boolean
}

/**
 * Provider 统一接口。
 *
 * 现有 LLMService 的 chat / complete 方法签名直接继承到此，
 * 因此 LLMService 可以在不改对外接口的前提下，内部委托给 Provider。
 */
export interface LLMProvider {
  /** 流式对话；通过回调返回内容片段、最终文本、工具调用、reasoning 文本 */
  chat(
    messages: LLMMessage[],
    onChunk: ChatChunkCallback,
    onDone: ChatDoneCallback,
    onError: ChatErrorCallback,
    options?: ChatOptions,
  ): Promise<void>

  /** 非流式调用（OCR / 图片识别等单次请求） */
  complete(messages: LLMMessage[], options?: ChatOptions): Promise<string>
}
