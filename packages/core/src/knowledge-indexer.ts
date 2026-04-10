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
import crypto from 'crypto'
import type { KnowledgeRetriever } from './knowledge-retriever'
import type { LLMCallFn } from './document-formatter'

/** 写入临时文件后原子 rename，防止进程中断导致索引损坏 */
function atomicWriteSync(filePath: string, data: string): void {
  const tmpPath = filePath + `.${crypto.randomBytes(4).toString('hex')}.tmp`
  fs.writeFileSync(tmpPath, data, 'utf-8')
  try {
    fs.renameSync(tmpPath, filePath)
  } catch (err) {
    try { fs.unlinkSync(tmpPath) } catch { /* 清理失败不阻塞 */ }
    throw err
  }
}

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
/** 保存每个 chunk 内容的快速 hash，用于增量 embedding 跳过未变更 chunk */
const HASHES_FILE = 'hashes.json'

/**
 * 对字符串生成简单的 FNV-1a 32bit hash（16 进制），用于增量 embedding 比对。
 * 不需要密码强度，只需快速判断内容是否变更。
 */
function fnv1a(str: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i)
    hash = (hash * 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/**
 * 为知识库构建完整检索索引（上下文摘要 + 向量嵌入）。
 * 支持增量更新：若传入 existingIndex，将复用未变更 chunk 的 embedding，仅重建变更/新增的 chunk。
 *
 * @param retriever     已加载知识文件的 KnowledgeRetriever 实例
 * @param config        LLM 和 Embedding 调用函数
 * @param onProgress    可选进度回调
 * @param existingIndex 上次构建的索引（由 loadIndex 加载），用于增量跳过
 * @returns 生成的 contexts 和 embeddings Map
 */
export async function buildKnowledgeIndex(
  retriever: KnowledgeRetriever,
  config: IndexerConfig,
  onProgress?: (progress: IndexBuildProgress) => void,
  existingIndex?: { contexts: Map<string, string>; embeddings: Map<string, number[]>; hashes: Map<string, string> } | null,
): Promise<{ contexts: Map<string, string>; embeddings: Map<string, number[]>; hashes: Map<string, string> }> {
  const chunkKeys = retriever.getChunkKeys()

  // Phase 1: 上下文摘要（跳过 hash 未变更的 chunk）
  const contextMap = new Map<string, string>()
  const hashMap = new Map<string, string>()

  for (let i = 0; i < chunkKeys.length; i++) {
    const ck = chunkKeys[i]
    // 计算 chunk 内容 hash
    const contentForHash = ck.heading + '|' + ck.contentPreview
    const newHash = fnv1a(contentForHash)
    hashMap.set(ck.key, newHash)

    // 如果已有索引且 hash 未变更，直接复用旧上下文
    if (existingIndex && existingIndex.hashes.get(ck.key) === newHash && existingIndex.contexts.has(ck.key)) {
      contextMap.set(ck.key, existingIndex.contexts.get(ck.key)!)
      if (onProgress) {
        onProgress({ phase: 'context', current: i + 1, total: chunkKeys.length, detail: `[cached] ${ck.heading}` })
      }
      continue
    }

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
      console.warn(`[knowledge-indexer] chunk "${ck.heading}" 上下文生成失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }
  retriever.setContexts(contextMap)

  // Phase 2: 向量嵌入（批量，每批 10 条，跳过 hash 未变更的 chunk）
  const embeddingMap = new Map<string, number[]>()

  // 先把未变更的 embedding 直接复制过来
  if (existingIndex) {
    for (const ck of chunkKeys) {
      const newHash = hashMap.get(ck.key)
      if (existingIndex.hashes.get(ck.key) === newHash && existingIndex.embeddings.has(ck.key)) {
        embeddingMap.set(ck.key, existingIndex.embeddings.get(ck.key)!)
      }
    }
  }

  // 只对需要重新生成 embedding 的 chunk 分批处理
  const needEmbedding = chunkKeys.filter(ck => !embeddingMap.has(ck.key))
  const batchSize = 10

  for (let i = 0; i < needEmbedding.length; i += batchSize) {
    const batch = needEmbedding.slice(i, i + batchSize)
    const texts = batch.map(ck => {
      const ctx = contextMap.get(ck.key) || ''
      return (ctx + ' ' + ck.heading + ' ' + ck.contentPreview).slice(0, 500)
    })

    if (onProgress) {
      onProgress({
        phase: 'embedding',
        current: Math.min(i + batchSize, needEmbedding.length),
        total: needEmbedding.length,
      })
    }

    try {
      const embeddings = await config.callEmbedding(texts)
      if (!Array.isArray(embeddings) || embeddings.length !== batch.length) {
        console.warn(`[knowledge-indexer] Embedding 批次 ${i}-${i + batchSize} 返回长度不匹配：期望 ${batch.length}，实际 ${Array.isArray(embeddings) ? embeddings.length : 'N/A'}`)
        continue
      }
      for (let j = 0; j < batch.length; j++) {
        embeddingMap.set(batch[j].key, embeddings[j])
      }
    } catch (err) {
      console.warn(`[knowledge-indexer] Embedding 批次 ${i}-${i + batchSize} 失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }
  retriever.setEmbeddings(embeddingMap)

  return { contexts: contextMap, embeddings: embeddingMap, hashes: hashMap }
}

/**
 * 将索引持久化到磁盘（JSON 格式）。
 * 写入 `knowledgePath/_index/contexts.json`、`_index/embeddings.json` 和 `_index/hashes.json`。
 */
export function saveIndex(
  knowledgePath: string,
  contexts: Map<string, string>,
  embeddings: Map<string, number[]>,
  hashes?: Map<string, string>,
): void {
  const indexDir = path.join(knowledgePath, INDEX_DIR_NAME)
  if (!fs.existsSync(indexDir)) {
    fs.mkdirSync(indexDir, { recursive: true })
  }

  const contextsObj: Record<string, string> = {}
  for (const [k, v] of contexts) contextsObj[k] = v

  const embeddingsObj: Record<string, number[]> = {}
  for (const [k, v] of embeddings) embeddingsObj[k] = v

  // 原子写入：先写临时文件再 rename，防止进程崩溃时索引文件损坏
  atomicWriteSync(path.join(indexDir, CONTEXTS_FILE), JSON.stringify(contextsObj))
  atomicWriteSync(path.join(indexDir, EMBEDDINGS_FILE), JSON.stringify(embeddingsObj))

  if (hashes) {
    const hashesObj: Record<string, string> = {}
    for (const [k, v] of hashes) hashesObj[k] = v
    atomicWriteSync(path.join(indexDir, HASHES_FILE), JSON.stringify(hashesObj))
  }
}

/**
 * 从磁盘加载持久化索引（含 hashes 用于增量比对）。
 * 任一文件不存在则返回 null。
 */
export function loadIndex(
  knowledgePath: string,
): { contexts: Map<string, string>; embeddings: Map<string, number[]>; hashes: Map<string, string> } | null {
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

    // hashes 文件可选（旧版索引没有此文件）
    const hashes = new Map<string, string>()
    const hashesPath = path.join(indexDir, HASHES_FILE)
    if (fs.existsSync(hashesPath)) {
      try {
        const hashesObj = JSON.parse(fs.readFileSync(hashesPath, 'utf-8')) as Record<string, string>
        for (const [k, v] of Object.entries(hashesObj)) hashes.set(k, v)
      } catch {
        // hashes 文件损坏则忽略，全量重建
      }
    }

    return { contexts, embeddings, hashes }
  } catch (err) {
    console.warn(`[knowledge-indexer] 索引加载失败：${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}
