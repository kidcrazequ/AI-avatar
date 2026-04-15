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

/** 索引构建/RAG 等后台 API 调用的超时时间（5 分钟） */
export const BACKEND_API_TIMEOUT_MS = 300_000

/**
 * 内部专用的 fetch+json 超时包装：同一个 AbortController 同时覆盖
 * 连接建立 + 响应 body 读取两阶段。
 *
 * 为何不用 `@soul/core` 的 `fetchWithTimeout`：后者在 fetch() resolve
 * （response headers 到达）后的 finally 块里 clearTimeout，但调用方后续
 * 的 `response.json()` 读取 body 时已经没有任何超时保护。遇到慢吐流的
 * LLM 服务端（实测见过 32 分钟慢写 8192 tokens 的情况），整个等待可以
 * 远超设定超时。这里的 wrapper 把 fetch 和 json 两步放在同一个
 * AbortController 的 finally/clearTimeout scope 内，保证 5 分钟超时
 * 对整个请求-响应周期生效。
 */
async function fetchJsonWithTimeout<T>(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs)
  try {
    const response = await fetch(url, { ...init, signal: controller.signal })
    if (!response.ok) {
      const body = await response.text().catch(() => '')
      throw new Error(`HTTP ${response.status} ${response.statusText}: ${body.slice(0, 200)}`)
    }
    return await response.json() as T
  } catch (err) {
    if (err instanceof Error && (err.name === 'AbortError' || err.message === 'timeout')) {
      throw new Error(`请求超时 (${timeoutMs}ms): ${url}`)
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 创建 EmbeddingCallFn 适配器，用于知识索引构建中的向量嵌入调用。
 * 使用 DashScope text-embedding-v3（512 维）。
 *
 * @param apiKey  API 密钥
 * @param baseUrl API 基础 URL（如 https://dashscope.aliyuncs.com/compatible-mode/v1）
 */
export function createEmbeddingFn(apiKey: string, baseUrl: string): EmbeddingCallFn {
  return async (texts: string[]): Promise<number[][]> => {
    const data = await fetchJsonWithTimeout<{ data: Array<{ embedding: number[] }> }>(
      `${baseUrl}/embeddings`,
      {
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
      },
      BACKEND_API_TIMEOUT_MS,
    )
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
    const data = await fetchJsonWithTimeout<{ choices: Array<{ message: { content: string } }> }>(
      `${baseUrl}/chat/completions`,
      {
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
      },
      BACKEND_API_TIMEOUT_MS,
    )
    return data.choices?.[0]?.message?.content ?? ''
  }
}
