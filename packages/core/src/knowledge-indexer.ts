/**
 * 知识索引模块：上下文摘要生成 + 向量嵌入 + JSON 持久化。
 *
 * 在知识导入后调用，为每个 chunk 生成：
 *   1. 上下文索引描述（1 句话摘要 + 同义词，供 BM25 增强）
 *   2. 向量 embedding（供 RRF 融合排序）
 * 索引持久化为 JSON 文件，桌面端和测试共用此模块。
 *
 * @author zhi.qu
 * @date 2026-04-03
 */

import fs from 'fs'
import path from 'path'
import type { KnowledgeRetriever } from './knowledge-retriever'
import type { LLMCallFn } from './document-formatter'

/**
 * Embedding 调用函数签名。
 * 调用方注入具体实现（桌面端/测试各自适配 DashScope API）。
 */
export type EmbeddingCallFn = (texts: string[]) => Promise<number[][]>

export interface IndexerConfig {
  callLLM: LLMCallFn
  callEmbedding: EmbeddingCallFn
}

export interface IndexBuildProgress {
  phase: 'context' | 'embedding'
  current: number
  total: number
  detail?: string
}

/**
 * 上下文索引描述生成 Prompt。
 * 为每个 chunk 生成 1 句话摘要 + 同义词，用于增强 BM25 检索召回。
 */
export const CONTEXT_PROMPT = `你是一个文档索引助手。请为以下文档片段生成索引描述，用于关键词检索匹配。

## 任务
1. 用 1 句话（不超过 60 字）概括本片段的主题
2. 在主题句后，用逗号补充 3-5 个用户可能搜索的同义词/近义词

## 示例
片段内容是"尺寸参数：高度2470mm、宽度989mm"
→ 尺寸参数包括高度和宽度数值，外形尺寸，占地面积，体积，长宽高

## 约束（不可违反）
1. 不添加原文中没有的数值、结论或建议
2. 不使用"建议"、"应该"、"需要注意"等主观措辞
3. 直接输出描述文字，不加引号、括号或前缀`

const INDEX_DIR_NAME = '_index'
const CONTEXTS_FILE = 'contexts.json'
const EMBEDDINGS_FILE = 'embeddings.json'

/**
 * 为知识库构建完整检索索引（上下文摘要 + 向量嵌入）。
 *
 * @param retriever     已加载知识文件的 KnowledgeRetriever 实例
 * @param config        LLM 和 Embedding 调用函数
 * @param onProgress    可选进度回调
 * @returns 生成的 contexts 和 embeddings Map
 */
export async function buildKnowledgeIndex(
  retriever: KnowledgeRetriever,
  config: IndexerConfig,
  onProgress?: (progress: IndexBuildProgress) => void,
): Promise<{ contexts: Map<string, string>; embeddings: Map<string, number[]> }> {
  const chunkKeys = retriever.getChunkKeys()

  // Phase 1: 上下文摘要
  const contextMap = new Map<string, string>()
  for (let i = 0; i < chunkKeys.length; i++) {
    const ck = chunkKeys[i]
    const prevHeading = i > 0 ? chunkKeys[i - 1].heading : '（无）'
    const nextHeading = i < chunkKeys.length - 1 ? chunkKeys[i + 1].heading : '（无）'

    if (onProgress) {
      onProgress({ phase: 'context', current: i + 1, total: chunkKeys.length, detail: ck.heading })
    }

    const userPrompt = `文档：${ck.file}
上一节：${prevHeading}
当前节：${ck.heading}
下一节：${nextHeading}

片段内容（前 300 字）：
${ck.contentPreview.slice(0, 300)}`

    try {
      const ctx = await config.callLLM(CONTEXT_PROMPT, userPrompt, 100)
      const cleaned = ctx.replace(/^["'「【\[（(]|["'」】\]）)]$/g, '').trim()
      contextMap.set(ck.key, cleaned)
    } catch (err) {
      console.warn(`[knowledge-indexer] chunk "${ck.heading}" 上下文生成失败：${(err as Error).message}`)
    }
  }
  retriever.setContexts(contextMap)

  // Phase 2: 向量嵌入（批量，每批 10 条）
  const embeddingMap = new Map<string, number[]>()
  const batchSize = 10
  for (let i = 0; i < chunkKeys.length; i += batchSize) {
    const batch = chunkKeys.slice(i, i + batchSize)
    const texts = batch.map(ck => {
      const ctx = contextMap.get(ck.key) || ''
      return (ctx + ' ' + ck.heading + ' ' + ck.contentPreview).slice(0, 500)
    })

    if (onProgress) {
      onProgress({
        phase: 'embedding',
        current: Math.min(i + batchSize, chunkKeys.length),
        total: chunkKeys.length,
      })
    }

    try {
      const embeddings = await config.callEmbedding(texts)
      for (let j = 0; j < batch.length; j++) {
        embeddingMap.set(batch[j].key, embeddings[j])
      }
    } catch (err) {
      console.warn(`[knowledge-indexer] Embedding 批次 ${i}-${i + batchSize} 失败：${(err as Error).message}`)
    }
  }
  retriever.setEmbeddings(embeddingMap)

  return { contexts: contextMap, embeddings: embeddingMap }
}

/**
 * 将索引持久化到磁盘（JSON 格式）。
 * 写入 `knowledgePath/_index/contexts.json` 和 `_index/embeddings.json`。
 */
export function saveIndex(
  knowledgePath: string,
  contexts: Map<string, string>,
  embeddings: Map<string, number[]>,
): void {
  const indexDir = path.join(knowledgePath, INDEX_DIR_NAME)
  if (!fs.existsSync(indexDir)) {
    fs.mkdirSync(indexDir, { recursive: true })
  }

  const contextsObj: Record<string, string> = {}
  for (const [k, v] of contexts) contextsObj[k] = v

  const embeddingsObj: Record<string, number[]> = {}
  for (const [k, v] of embeddings) embeddingsObj[k] = v

  fs.writeFileSync(
    path.join(indexDir, CONTEXTS_FILE),
    JSON.stringify(contextsObj),
    'utf-8',
  )
  fs.writeFileSync(
    path.join(indexDir, EMBEDDINGS_FILE),
    JSON.stringify(embeddingsObj),
    'utf-8',
  )
}

/**
 * 从磁盘加载持久化索引。
 * 任一文件不存在则返回 null。
 */
export function loadIndex(
  knowledgePath: string,
): { contexts: Map<string, string>; embeddings: Map<string, number[]> } | null {
  const indexDir = path.join(knowledgePath, INDEX_DIR_NAME)
  const contextsPath = path.join(indexDir, CONTEXTS_FILE)
  const embeddingsPath = path.join(indexDir, EMBEDDINGS_FILE)

  if (!fs.existsSync(contextsPath) || !fs.existsSync(embeddingsPath)) {
    return null
  }

  try {
    const contextsObj = JSON.parse(fs.readFileSync(contextsPath, 'utf-8')) as Record<string, string>
    const embeddingsObj = JSON.parse(fs.readFileSync(embeddingsPath, 'utf-8')) as Record<string, number[]>

    const contexts = new Map<string, string>()
    for (const [k, v] of Object.entries(contextsObj)) contexts.set(k, v)

    const embeddings = new Map<string, number[]>()
    for (const [k, v] of Object.entries(embeddingsObj)) embeddings.set(k, v)

    return { contexts, embeddings }
  } catch (err) {
    console.warn(`[knowledge-indexer] 索引加载失败：${(err as Error).message}`)
    return null
  }
}
