/**
 * @soul/core — Soul 分身框架核心 SDK
 *
 * 提供分身管理、知识检索、技能路由、模板加载等核心能力。
 * 与运行环境无关，可用于 Electron、CLI、Node.js 服务等场景。
 *
 * @author zhi.qu
 * @date 2026-04-02
 */

export { SoulLoader } from './soul-loader'
export type { AvatarConfig } from './soul-loader'

export { AvatarManager } from './avatar-manager'
export type { Avatar } from './avatar-manager'

export { KnowledgeManager } from './knowledge-manager'
export type { FileNode, KnowledgeFileInfo, ImageKnowledgeInfo } from './knowledge-manager'

export { KnowledgeRetriever } from './knowledge-retriever'

export { SkillManager } from './skill-manager'
export type { Skill } from './skill-manager'

export { ToolRouter } from './tool-router'
export { SkillRouter } from './skill-router'
export type { ToolCallRequest, ToolCallResult } from './tool-router'

export { TemplateLoader } from './template-loader'

export * from './utils/markdown-parser'

export { cleanOcrHtml, cleanPdfFullText, cleanLlmOutput, detectFabricatedNumbers, stripDocxToc, mergeVisionIntoText } from './utils/ocr-html-cleaner'

export { splitIntoChapters, formatChapter, formatDocument, FORMAT_SYSTEM_PROMPT } from './document-formatter'
export type { Chapter, FormatProgress, LLMCallFn } from './document-formatter'

export { buildKnowledgeIndex, saveIndex, loadIndex, CONTEXT_PROMPT } from './knowledge-indexer'
export type { EmbeddingCallFn, IndexerConfig, IndexBuildProgress } from './knowledge-indexer'

export { retrieveAndBuildPrompt, ENTITY_EXTRACT_PROMPT } from './rag-answerer'
export type { RAGConfig } from './rag-answerer'

export { WikiCompiler } from './wiki-compiler'
export type {
  ChunkData, EntityInfo, EntityAppearance, ConceptPage,
  LintIssue, LintReport, WikiMeta, WikiAnswer, WikiCompileProgress,
  EvolutionDiff, EvolutionReport,
} from './wiki-compiler'

export { tokenize } from './knowledge-retriever'

export { consolidateMemory, getMemoryStats, shouldConsolidate, shouldWarnMemory, MEMORY_CHAR_LIMIT, MEMORY_WARN_THRESHOLD } from './memory-manager'
export type { MemoryStats } from './memory-manager'

export { SubAgentManager } from './sub-agent-manager'
export type { SubAgentTask, SubAgentStatus } from './sub-agent-manager'

export { assertSafeSegment, resolveUnderRoot } from './utils/path-security'

export { localDateString, collectFilesRecursive, DEFAULT_MAX_DIR_DEPTH } from './utils/common'

export { fetchWithTimeout, HttpError } from './utils/http'
export type { FetchWithTimeoutOptions } from './utils/http'
export { callVisionOcr, DEFAULT_VISION_MODEL, DEFAULT_VISION_CONCURRENCY, DEFAULT_VISION_PROMPT, DEFAULT_VISION_TIMEOUT_MS } from './utils/vision-ocr'
export type { VisionOcrOptions, VisionOcrResult, VisionOcrFailure } from './utils/vision-ocr'
export { loadTokensCache, saveTokensCache, TOKENS_FILE } from './utils/chunk-cache'
export { loadChartCache, saveChartCache, findChartCacheHit, insertChartCacheEntry, captureFileSnapshot, verifySnapshots, normalizeQueryForHash, hashQueryContent, CHART_CACHE_REL_PATH, DEFAULT_MAX_CHART_CACHE_ENTRIES } from './utils/chart-cache'
export type { ChartCacheEntry, ChartCache, FileSnapshot } from './utils/chart-cache'
export type { PersistedTokens } from './utils/chunk-cache'

