/**
 * Feature flags for the agent-runtime evolution.
 *
 * Defaults to OFF — every new Phase ships behind a flag so the legacy path
 * keeps working. Plan §9 mandates ≥2 weeks of parallel run before flipping
 * a default in production.
 */

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on'])

function readFlag(name: string): boolean {
  const raw = (typeof process !== 'undefined' && process.env?.[name]) || ''
  return TRUE_VALUES.has(raw.toLowerCase())
}

/** Master flag for the new agent runtime (Phase 1-9 except Phase 10). */
export function isNewRuntimeEnabled(): boolean {
  return readFlag('SOUL_USE_NEW_RUNTIME')
}

/** Flag for the new document ingestion pipeline (Phase 10). */
export function isNewIngestEnabled(): boolean {
  return readFlag('SOUL_USE_NEW_INGEST')
}

/**
 * 渐进式披露 RAG（借鉴 Pi）：小知识库整库进 cacheable stable prompt（享 prompt cache）、
 * 大库维持 agentic on-demand search_knowledge。注意"删除 pre-message BM25 注入"已于
 * 2026-05-13 在 chat 路径落地（agentic-only），此 flag 仅 gate "小库进 stable cache"
 * 这一 Phase-2 优化（召回敏感、需 eval 守门），默认 OFF。
 */
export function isProgressiveDisclosureRagEnabled(): boolean {
  return readFlag('SOUL_USE_PROGRESSIVE_DISCLOSURE_RAG')
}
