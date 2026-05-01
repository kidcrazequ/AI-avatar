/**
 * warmup-tokens-cache.ts — 预生成 BM25 中文分词缓存
 *
 * 不调 retriever.searchChunks（其内部 RRF 融合 / BM25 cache 构建会让进度无法观测，
 * 且某些 chunk 可能让 segmentit 退化成 O(n²) 卡住几分钟）。
 * 自己手动遍历 chunks 调 tokenize，每个 chunk 设 8000 字符上限，逐条打印进度，
 * 完成后直接调 saveTokensCache 落盘。
 *
 * 用法：
 *   cd desktop-app
 *   NODE_OPTIONS=--max-old-space-size=8192 npx tsx scripts/warmup-tokens-cache.ts <avatar-id>
 *
 * 例：
 *   NODE_OPTIONS=--max-old-space-size=8192 npx tsx scripts/warmup-tokens-cache.ts 小堵-工商储专家
 *
 * @author zhi.qu
 * @date 2026-04-30
 */

import path from 'path'
import fs from 'fs'
import {
  KnowledgeRetriever,
  loadIndex,
  saveTokensCache,
  tokenize,
} from '@soul/core'

/** 与 retriever 内部一致的 3000 字符上限（防止 segmentit 对超长 chunk 退化） */
const TOKENIZE_MAX_CHARS = 3000

async function warmup(avatarId: string): Promise<void> {
  const repoRoot = path.resolve(__dirname, '..', '..')
  const knowledgePath = path.join(repoRoot, 'avatars', avatarId, 'knowledge')
  const indexDir = path.join(knowledgePath, '_index')

  console.log(`[warmup-tokens] 知识库: ${knowledgePath}`)

  const retriever = new KnowledgeRetriever(knowledgePath)
  const existingIndex = loadIndex(knowledgePath)
  if (existingIndex) {
    retriever.setContexts(existingIndex.contexts)
    console.log(`[warmup-tokens] 旧索引: ${existingIndex.contexts.size} contexts, ${existingIndex.embeddings.size} embeddings, ${existingIndex.tokens.size} tokens`)
  }

  // 直接读所有 chunks（不走 searchChunks，避免内部黑盒）
  const ck = retriever.getChunkKeys()
  console.log(`[warmup-tokens] 共 ${ck.length} chunks 待分词`)

  // 文件内容缓存（同一文件多个 chunk 共享，避免重复 readFileSync）
  const fileCache = new Map<string, string>()
  const getContent = (relFile: string): string => {
    let cached = fileCache.get(relFile)
    if (cached !== undefined) return cached
    try {
      cached = fs.readFileSync(path.join(knowledgePath, relFile), 'utf-8')
    } catch {
      cached = ''
    }
    fileCache.set(relFile, cached)
    return cached
  }

  const tokensMap = new Map<string, string[]>(existingIndex?.tokens ?? [])
  const t0 = Date.now()
  let slowestMs = 0
  let slowestKey = ''
  let cacheHit = 0
  let processed = 0

  for (let i = 0; i < ck.length; i++) {
    const c = ck[i]
    const cacheKey = c.key

    // 命中缓存：跳过
    if (tokensMap.has(cacheKey)) {
      cacheHit++
      continue
    }

    // 重建 chunk 的 searchableText（与 retriever 内部一致：context + heading + content）
    const fileContent = getContent(c.file)
    const ctx = existingIndex?.contexts.get(cacheKey) ?? ''
    const rawText = (ctx ? ctx + ' ' : '') + c.heading + ' ' + fileContent
    const safeText = rawText.length > TOKENIZE_MAX_CHARS
      ? rawText.slice(0, TOKENIZE_MAX_CHARS)
      : rawText

    const t1 = Date.now()
    const tokens = tokenize(safeText.toLowerCase())
    const ms = Date.now() - t1
    if (ms > slowestMs) { slowestMs = ms; slowestKey = cacheKey }
    if (ms > 2000) {
      console.log(`[SLOW ${ms}ms] ${safeText.length} chars → ${tokens.length} tokens — ${cacheKey.slice(0, 80)}`)
    }

    tokensMap.set(cacheKey, tokens)
    processed++

    if ((i + 1) % 200 === 0) {
      const elapsed = ((Date.now() - t0) / 1000).toFixed(0)
      console.log(`[warmup-tokens] ${i + 1}/${ck.length} (+${elapsed}s, cached: ${cacheHit}, new: ${processed}, slowest: ${slowestMs}ms)`)
    }
  }

  console.log('')
  console.log(`[warmup-tokens] tokenize 完成 — 总耗时 ${Math.round((Date.now() - t0) / 1000)}s`)
  console.log(`[warmup-tokens]   cache hit: ${cacheHit}, new tokenize: ${processed}, slowest: ${slowestMs}ms (${slowestKey.slice(0, 60)})`)

  // 落盘
  saveTokensCache(indexDir, tokensMap)
  console.log(`[warmup-tokens] ✓ tokens.json 已写入 ${indexDir} — ${tokensMap.size} entries`)
}

async function main(): Promise<void> {
  const avatarId = process.argv[2]
  if (!avatarId) {
    console.error('用法: NODE_OPTIONS=--max-old-space-size=8192 npx tsx scripts/warmup-tokens-cache.ts <avatar-id>')
    process.exit(1)
  }
  await warmup(avatarId)
}

void main().catch((err) => {
  console.error('[warmup-tokens] FAIL')
  console.error(err instanceof Error ? err.stack ?? err.message : String(err))
  process.exit(1)
})
