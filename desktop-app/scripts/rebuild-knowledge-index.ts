/**
 * rebuild-knowledge-index.ts — 一次性知识库索引重建脚本
 *
 * 背景：批量导入完成后 _index/tokens.json 未被刷新（buildIndexAfterBatchImport
 * 在某些路径未触发）。本脚本绕过 Electron UI，直接调用 @soul/core 的
 * buildKnowledgeIndex 完成增量索引重建。
 *
 * 用法：
 *   cd desktop-app
 *   npx tsx scripts/rebuild-knowledge-index.ts <avatar-id>
 *
 * 例：
 *   npx tsx scripts/rebuild-knowledge-index.ts 小堵-工商储专家
 *
 * 行为：
 *   - 从 ~/Library/Application Support/soul-desktop/xiaodu.db 读取 API key
 *     （通过 sqlite3 CLI，避免 better-sqlite3 native binding 不匹配）
 *   - 用 chat_api_key + chat_base_url 跑 buildKnowledgeIndex（增量：已有 hash 不变更的 chunk 跳过）
 *   - 写入 avatars/<id>/knowledge/_index/{tokens.json, contexts.json, embeddings.json}
 *
 * 注意：
 *   - 此脚本不依赖 Electron 应用是否在跑（直接读 SQLite + 直接写文件）
 *   - 跑完后桌面端下次启动会自动加载新索引
 *
 * @author zhi.qu
 * @date 2026-04-30
 */

import path from 'path'
import os from 'os'
import { execFileSync } from 'child_process'
import {
  KnowledgeRetriever,
  buildKnowledgeIndex,
  saveIndex,
  loadIndex,
} from '@soul/core'
import { createLLMFn, createEmbeddingFn } from '../electron/llm-factory'

interface DbSettings {
  chatApiKey: string
  chatBaseUrl: string
  chatModel: string
  ocrApiKey: string
  ocrBaseUrl: string
}

/**
 * 从 SQLite settings 表读 API key。
 * 用 sqlite3 CLI 而非 better-sqlite3：后者在 Node 24 + Electron 36 之间
 * NODE_MODULE_VERSION 不匹配，CLI 是无依赖兜底。
 */
function readSettings(dbPath: string): DbSettings {
  const query = `SELECT key, value FROM settings WHERE key IN ('chat_api_key','chat_base_url','chat_model','ocr_api_key','ocr_base_url');`
  let raw: string
  try {
    raw = execFileSync('sqlite3', [dbPath, query], { encoding: 'utf-8' })
  } catch (err) {
    throw new Error(`读取 SQLite 失败（路径: ${dbPath}）: ${err instanceof Error ? err.message : String(err)}`)
  }
  const map: Record<string, string> = {}
  for (const line of raw.split('\n')) {
    const idx = line.indexOf('|')
    if (idx > 0) {
      map[line.slice(0, idx)] = line.slice(idx + 1)
    }
  }
  const chatApiKey = map.chat_api_key ?? ''
  const chatBaseUrl = map.chat_base_url ?? ''
  const chatModel = map.chat_model ?? ''
  // ocr 兜底（嵌入用，DashScope text-embedding-v3 走 chat 同账号也行）
  const ocrApiKey = map.ocr_api_key ?? chatApiKey
  const ocrBaseUrl = map.ocr_base_url ?? chatBaseUrl
  if (!chatApiKey) throw new Error('未找到 chat_api_key（请先在桌面端"设置"中配置 API Key）')
  if (!chatModel) throw new Error('未找到 chat_model（请先在桌面端"设置"中配置聊天模型）')
  return { chatApiKey, chatBaseUrl, chatModel, ocrApiKey, ocrBaseUrl }
}

async function rebuild(avatarId: string): Promise<void> {
  const repoRoot = path.resolve(__dirname, '..', '..')
  const knowledgePath = path.join(repoRoot, 'avatars', avatarId, 'knowledge')
  const dbPath = path.join(os.homedir(), 'Library', 'Application Support', 'soul-desktop', 'xiaodu.db')

  console.log(`[rebuild-index] 知识库: ${knowledgePath}`)
  console.log(`[rebuild-index] SQLite:  ${dbPath}`)
  console.log('')

  const settings = readSettings(dbPath)
  console.log(`[rebuild-index] LLM:    ${settings.chatModel} @ ${settings.chatBaseUrl}`)
  console.log(`[rebuild-index] Embed:  text-embedding-v3 @ ${settings.ocrBaseUrl}`)

  const callLLM = createLLMFn(settings.chatApiKey, settings.chatBaseUrl, settings.chatModel)
  const callEmbedding = createEmbeddingFn(settings.ocrApiKey, settings.ocrBaseUrl)

  const retriever = new KnowledgeRetriever(knowledgePath)
  const totalChunks = retriever.getChunkKeys().length
  console.log(`[rebuild-index] 共 ${totalChunks} chunks 待处理`)

  const existingIndex = loadIndex(knowledgePath)
  console.log(`[rebuild-index] 已有索引: ${existingIndex ? `${existingIndex.contexts.size} contexts` : '无（全量构建）'}`)
  console.log('')

  let lastReportedPct = -1
  const t0 = Date.now()

  const result = await buildKnowledgeIndex(
    retriever,
    { callLLM, callEmbedding },
    (progress) => {
      // 进度节流：每 5% 打一次
      const pct = Math.floor(((progress.current ?? 0) / Math.max(1, progress.total ?? 1)) * 100)
      if (pct !== lastReportedPct && pct % 5 === 0) {
        lastReportedPct = pct
        const elapsed = ((Date.now() - t0) / 1000).toFixed(0)
        console.log(`[rebuild-index] [${pct}%] phase=${progress.phase} ${progress.current}/${progress.total} (+${elapsed}s)`)
      }
    },
    existingIndex,
  )

  saveIndex(knowledgePath, result.contexts, result.embeddings, result.hashes)
  const totalSec = Math.round((Date.now() - t0) / 1000)

  console.log('')
  console.log(`[rebuild-index] ✓ 完成 — 总耗时 ${totalSec}s (${Math.floor(totalSec / 60)}分${totalSec % 60}秒)`)
  console.log(`[rebuild-index]   contexts: ${result.contexts.size}, embeddings: ${result.embeddings.size}`)
  console.log(`[rebuild-index]   _index 已写入: ${path.join(knowledgePath, '_index/')}`)
}

async function main(): Promise<void> {
  const avatarId = process.argv[2]
  if (!avatarId) {
    console.error('用法: npx tsx scripts/rebuild-knowledge-index.ts <avatar-id>')
    console.error('例:   npx tsx scripts/rebuild-knowledge-index.ts 小堵-工商储专家')
    process.exit(1)
  }
  await rebuild(avatarId)
}

void main().catch((err) => {
  console.error('[rebuild-index] FAIL')
  console.error(err instanceof Error ? err.stack ?? err.message : String(err))
  process.exit(1)
})
