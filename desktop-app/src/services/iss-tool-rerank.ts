/**
 * ISS：在 sendMessage 工具列表注入 LLM 前按需重排（设置 + localStorage 缓存 + embedding）。
 *
 * @author zhi.qu
 * @date 2026-05-09
 */

import {
  ISS_DEFAULT_TOP_N,
  SkillReranker,
  parseSkillEmbeddingCacheJson,
  serializeSkillEmbeddingCacheJson,
  trimSkillEmbeddingCache,
  type ToolForRerank,
} from '@soul/core/browser'
import type { LLMTool } from './llm-service'
import { createIssEmbeddingCallFn } from './iss-embedding-call'

const LS_KEY = 'soul.iss.skill-embeddings.v1'

export const ISS_SETTING_ENABLED = 'iss_skill_rerank_enabled'
export const ISS_SETTING_TOP_N = 'iss_skill_rerank_top_n'

function clampTopN(n: number): number {
  if (!Number.isFinite(n)) return ISS_DEFAULT_TOP_N
  return Math.min(64, Math.max(5, Math.floor(n)))
}

/**
 * 读取设置并尝试 ISS；失败或非 agent 全量工具场景则原样返回。
 *
 * @param userText 当前用户消息纯文本（作 query）
 */
export async function maybeRerankToolsWithIss(userText: string, tools: LLMTool[]): Promise<LLMTool[]> {
  if (tools.length === 0) return tools

  let enabledStr: string | undefined
  let topStr: string | undefined
  let ocrKey: string | undefined
  let ocrBase: string | undefined
  try {
    ;[enabledStr, topStr, ocrKey, ocrBase] = await Promise.all([
      window.electronAPI.getSetting(ISS_SETTING_ENABLED),
      window.electronAPI.getSetting(ISS_SETTING_TOP_N),
      window.electronAPI.getSetting('ocr_api_key'),
      window.electronAPI.getSetting('ocr_base_url'),
    ])
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    window.electronAPI.logEvent('warn', 'iss-settings-read-failed', msg)
    return tools
  }

  const enabled = enabledStr !== 'false'
  if (!enabled) return tools

  const topN = clampTopN(parseInt(topStr ?? String(ISS_DEFAULT_TOP_N), 10))
  if (tools.length <= topN) return tools

  const apiKey = (ocrKey ?? '').trim()
  if (!apiKey) {
    window.electronAPI.logEvent('info', 'iss-skip-no-embedding-key', `tools=${tools.length}`)
    return tools
  }

  const baseUrl = (ocrBase ?? 'https://dashscope.aliyuncs.com/compatible-mode/v1').trim()
  const embedFn = createIssEmbeddingCallFn(apiKey, baseUrl)

  let rawCache: string | null = null
  try {
    rawCache = typeof localStorage !== 'undefined' ? localStorage.getItem(LS_KEY) : null
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    window.electronAPI.logEvent('warn', 'iss-localstorage-read-failed', msg)
  }

  const cache = parseSkillEmbeddingCacheJson(rawCache)

  const asRerank: ToolForRerank[] = tools.map(t => ({
    type: 'function' as const,
    function: {
      name: t.function.name,
      description: t.function.description,
      parameters: t.function.parameters,
    },
  }))

  try {
    const reranker = new SkillReranker(embedFn, cache, { topN })
    const out = await reranker.rerank(userText, asRerank)
    const byName = new Map(tools.map(t => [t.function.name, t]))
    const ordered: LLMTool[] = []
    for (const o of out) {
      const hit = byName.get(o.function.name)
      if (hit) ordered.push(hit)
    }
    trimSkillEmbeddingCache(cache, 640)
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(LS_KEY, serializeSkillEmbeddingCacheJson(cache))
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      window.electronAPI.logEvent('warn', 'iss-localstorage-write-failed', msg)
    }
    window.electronAPI.logEvent('info', 'iss-rerank-done', `before=${tools.length} after=${ordered.length} topN=${topN}`)
    return ordered
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    window.electronAPI.logEvent('warn', 'iss-rerank-failed', msg)
    return tools
  }
}
