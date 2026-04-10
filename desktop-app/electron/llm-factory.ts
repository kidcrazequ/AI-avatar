/**
 * LLM/Embedding API 工厂函数
 *
 * 集中创建与后台 LLM/Embedding API 交互的函数适配器，统一管理超时配置。
 * 禁止在其他模块内联 fetch 调用 LLM/Embedding API，必须通过此工厂创建函数，
 * 确保所有 API 调用都有超时保护，防止挂起。
 *
 * @author zhi.qu
 * @date 2026-04-10
 */

import type { LLMCallFn, EmbeddingCallFn } from '@soul/core'

/** 索引构建/RAG 等后台 API 调用的超时时间（3 分钟） */
export const BACKEND_API_TIMEOUT_MS = 180_000

/**
 * 创建 EmbeddingCallFn 适配器，用于知识索引构建中的向量嵌入调用。
 * 使用 DashScope text-embedding-v3（512 维）。
 *
 * @param apiKey  API 密钥
 * @param baseUrl API 基础 URL（如 https://dashscope.aliyuncs.com/compatible-mode/v1）
 */
export function createEmbeddingFn(apiKey: string, baseUrl: string): EmbeddingCallFn {
  return async (texts: string[]): Promise<number[][]> => {
    const response = await fetch(`${baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'text-embedding-v3',
        input: texts,
        dimension: 512,
      }),
      signal: AbortSignal.timeout(BACKEND_API_TIMEOUT_MS),
    })
    if (!response.ok) {
      throw new Error(`Embedding API 失败 (${response.status})`)
    }
    const data = await response.json() as { data: Array<{ embedding: number[] }> }
    return data.data.map(d => d.embedding)
  }
}

/**
 * 创建 LLMCallFn 适配器，用于索引构建和 RAG 中的 LLM 调用。
 *
 * @param apiKey  API 密钥
 * @param baseUrl API 基础 URL
 * @param model   模型名称（如 'qwen-turbo'）
 */
export function createLLMFn(apiKey: string, baseUrl: string, model: string): LLMCallFn {
  return async (systemPrompt: string, userPrompt: string, maxTokens = 200): Promise<string> => {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        stream: false,
        max_tokens: maxTokens,
      }),
      signal: AbortSignal.timeout(BACKEND_API_TIMEOUT_MS),
    })
    if (!response.ok) {
      throw new Error(`LLM API 失败 (${response.status})`)
    }
    const data = await response.json() as { choices: Array<{ message: { content: string } }> }
    return data.choices?.[0]?.message?.content ?? ''
  }
}
