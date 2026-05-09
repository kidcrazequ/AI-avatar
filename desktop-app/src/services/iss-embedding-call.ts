/**
 * 渲染进程侧 DashScope-compatible embedding 调用（与 electron/llm-factory#createEmbeddingFn 协议一致）。
 * 使用 `@soul/core/browser` 的 fetchWithTimeout，禁止裸 fetch。
 *
 * @author zhi.qu
 * @date 2026-05-09
 */

import { fetchWithTimeout, HttpError } from '@soul/core/browser'

/** 与 @soul/core knowledge-indexer / skill-reranker 对齐的注入签名（仅类型，避免运行时拉取 indexer）。 */
export type IssEmbeddingCallFn = (texts: string[]) => Promise<number[][]>

const EMBED_TIMEOUT_MS = 120_000

/**
 * @param apiKey DashScope API Key（通常与 OCR 槽位同源）
 * @param baseUrl 兼容模式入口，例如 https://dashscope.aliyuncs.com/compatible-mode/v1
 */
export function createIssEmbeddingCallFn(apiKey: string, baseUrl: string): IssEmbeddingCallFn {
  const root = baseUrl.replace(/\/$/, '')
  return async (texts: string[]): Promise<number[][]> => {
    if (!apiKey.trim()) {
      throw new HttpError('ISS embedding: API Key 为空', 'network')
    }
    const res = await fetchWithTimeout(`${root}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'text-embedding-v3',
        input: texts,
        dimension: 512,
      }),
      timeoutMs: EMBED_TIMEOUT_MS,
    })
    const data = (await res.json()) as { data?: Array<{ embedding: number[] }> }
    const rows = data.data
    if (!Array.isArray(rows) || rows.length !== texts.length) {
      throw new HttpError('ISS embedding: 响应形状异常', 'http', res.status)
    }
    return rows.map(r => r.embedding)
  }
}
