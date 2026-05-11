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

export { DEFAULT_AVATAR_PROJECT_ID } from './avatar-project'
export { resolveAvatarWorkspaceSessionRoot } from './avatar-workspace-paths'
export { CompositeKnowledgeRetriever, reciprocalRankFusion } from './composite-knowledge-retriever'

export { AvatarManager } from './avatar-manager'
export type { Avatar } from './avatar-manager'

export { KnowledgeManager } from './knowledge-manager'
export type { FileNode, KnowledgeFileInfo, ImageKnowledgeInfo } from './knowledge-manager'

export { KnowledgeRetriever } from './knowledge-retriever'

export { SkillManager } from './skill-manager'
export type { Skill } from './skill-manager'

export { ToolRouter } from './tool-router'
export { SkillRouter } from './skill-router'
export type { SkillIndexEntry, SkillIndex, RouteResult, RouteLog } from './skill-router'

export type {
  CommunitySkillSource,
  InstalledCommunityPack,
  CommunitySkillInfo,
  SkillSource,
  CommunitySkillSyncProgress,
} from './community-skill-types'
export type { ToolCallRequest, ToolCallResult, DocumentRendererHook, DocumentRenderContext } from './tool-router'

export { TemplateLoader } from './template-loader'

export * from './utils/markdown-parser'

export { cleanOcrHtml, cleanPdfFullText, cleanLlmOutput, detectFabricatedNumbers, stripDocxToc, mergeVisionIntoText } from './utils/ocr-html-cleaner'

export { splitIntoChapters, formatChapter, formatDocument, FORMAT_SYSTEM_PROMPT } from './document-formatter'
export type { Chapter, FormatProgress, LLMCallFn } from './document-formatter'

export { buildKnowledgeIndex, saveIndex, loadIndex, CONTEXT_PROMPT } from './knowledge-indexer'
export type { EmbeddingCallFn, IndexerConfig, IndexBuildProgress } from './knowledge-indexer'

export { ISS_DEFAULT_TOP_N, ISS_DEFAULT_PINNED_TOOL_NAMES, SkillReranker } from './skill-reranker'
export type { SkillRerankerOptions } from './skill-reranker'

export {
  PLAN_MODE_BLOCKED_TOOL_NAMES,
  GREY_ZONE_TOOL_NAMES,
  evaluateConversationModeToolPolicy,
  evaluateProxyTrustGreyDenial,
  shouldConfirmGreyZoneOnDesktop,
} from './tool-permission-policy'
export type {
  ConversationModeForTools,
  ToolCallTrustTier,
  ToolPermissionEval,
  ToolPermissionDenied,
  ToolPermissionAllowed,
} from './tool-permission-policy'
export type { ToolForRerank } from './skill-reranker-types'
export {
  stableToolDocHash,
  buildToolDocForEmbedding,
  parseSkillEmbeddingCacheJson,
  serializeSkillEmbeddingCacheJson,
  trimSkillEmbeddingCache,
} from './utils/skill-embedding-store'

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

export {
  STRUCTURED_MEMORY_FILENAME,
  STRUCTURED_MEMORY_MAX_ENTRIES,
  STRUCTURED_MEMORY_MAX_CONTENT_CHARS,
  parseStructuredMemoryDocumentJson,
  parseStructuredMemoryDocumentUnknown,
  assertStructuredMemoryDocumentPayload,
  normalizeStructuredMemoryDocumentUnknown,
  formatStructuredMemoryEntriesForPrompt,
  buildLongTermMemoryInjectionBody,
  getCombinedMemoryInjectionStats,
  serializeStructuredMemoryDocument,
  formatStructuredMemoryDateLabel,
  EMPTY_STRUCTURED_MEMORY_DOCUMENT,
} from './structured-memory'
export type { StructuredMemoryEntry, StructuredMemoryDocument } from './structured-memory'

export {
  mapTestCaseToQualityDimension,
  computeAvatarQualityScores,
} from './avatar-quality-scores'
export type {
  AvatarQualityAxis,
  AvatarTestOutcomeForQuality,
  AvatarQualityDimensionAggregate,
  AvatarQualityScores,
} from './avatar-quality-scores'

export { SubAgentManager } from './sub-agent-manager'
export type { SubAgentTask, SubAgentStatus } from './sub-agent-manager'

export { McpClientManager } from './mcp-client-manager'
export type {
  McpServerConfig,
  McpServerStatus,
  McpServerSnapshot,
  McpToolMeta,
  McpToolCallResult,
} from './mcp-client-manager'

export { assertSafeSegment, resolveUnderRoot } from './utils/path-security'

export { parseFrontmatterCore, extractFrontmatterFields, mergeFrontmatter, buildFrontmatterBlock } from './utils/knowledge-frontmatter'
export type { FrontmatterParseResult } from './utils/knowledge-frontmatter'

export { localDateString, collectFilesRecursive, DEFAULT_MAX_DIR_DEPTH } from './utils/common'

export {
  MAX_ATTACHMENT_SIZE_BYTES,
  INLINE_TEXT_BYTE_THRESHOLD,
  MAX_ATTACHMENT_COUNT_PER_MESSAGE,
  ATTACHMENT_DOCUMENT_EXTENSIONS,
  ATTACHMENT_TEXT_EXTENSIONS,
  ATTACHMENT_CODE_EXTENSIONS,
  ATTACHMENT_REJECTED_EXTENSIONS,
  ATTACHMENT_WHITELIST_EXTENSIONS,
  ATTACHMENT_SENSITIVE_EXTENSIONS,
  isAttachmentExtensionAllowed,
  buildAttachmentAcceptString,
  classifyAttachmentRoute,
} from './utils/attachment-types'
export type { AttachmentRoute } from './utils/attachment-types'

export { fetchWithTimeout, HttpError } from './utils/http'
export type { FetchWithTimeoutOptions } from './utils/http'
export {
  DOUBAO_ASR_PROTOCOL_VERSION,
  DOUBAO_ASR_BASE_HEADER_SIZE_WORDS,
  DOUBAO_ASR_BASE_HEADER_SIZE_BYTES,
  DOUBAO_ASR_DEFAULT_AUDIO,
  DoubaoAsrMessageType,
  DoubaoAsrMessageFlags,
  DoubaoAsrSerialization,
  DoubaoAsrCompressionCode,
  DoubaoAsrProtocolError,
  buildDoubaoAsrFullClientRequest,
  buildDoubaoAsrAudioOnlyRequest,
  parseDoubaoAsrServerResponse,
} from './audio/doubao-asr-protocol'
export type {
  JsonValue,
  JsonObject,
  DoubaoAsrCompression,
  DoubaoAsrAudioMetadata,
  DoubaoAsrFullClientRequestOptions,
  DoubaoAsrAudioOnlyRequestOptions,
  DoubaoAsrParsedServerResponse,
} from './audio/doubao-asr-protocol'
export { callVisionOcr, DEFAULT_VISION_MODEL, DEFAULT_VISION_CONCURRENCY, DEFAULT_VISION_PROMPT, DEFAULT_VISION_TIMEOUT_MS } from './utils/vision-ocr'
export type { VisionOcrOptions, VisionOcrResult, VisionOcrFailure } from './utils/vision-ocr'
export { loadTokensCache, saveTokensCache, TOKENS_FILE } from './utils/chunk-cache'
export { loadChartCache, saveChartCache, findChartCacheHit, insertChartCacheEntry, captureFileSnapshot, verifySnapshots, normalizeQueryForHash, hashQueryContent, CHART_CACHE_REL_PATH, DEFAULT_MAX_CHART_CACHE_ENTRIES } from './utils/chart-cache'
export type { ChartCacheEntry, ChartCache, FileSnapshot } from './utils/chart-cache'
export type { PersistedTokens } from './utils/chunk-cache'


export { resolvePolicy, shouldEnableChartConsistencyMode, deriveSeedFromContent, CHART_CONSISTENCY_HINT, CHART_KEYWORDS, TIME_RANGE_KEYWORDS, DETERMINISTIC_TEMPERATURE } from './consistency-policy'
export type { ConsistencyMode, ConsistencyPolicy, ResolvePolicyOptions } from './consistency-policy'
export { ToolBudget, DEFAULT_TOOL_POLICY, buildToolPolicyPromptHints, normalizeQueryExcelArgs } from './tool-budget'
export type { ToolPolicy, ToolBudgetConsumeResult, ToolBudgetMessage } from './tool-budget'
export { buildApiMessages } from './prompt-builder'
export { rerankChunksWithDiversity, computeJaccardSimilarity } from './rag-rerank'
export type { RerankableChunk, RerankOptions } from './rag-rerank'
export type { BuildApiMessagesOptions, HistoryMessageLike, ApiMessageLike } from './prompt-builder'
export { DYNAMIC_SYSTEM_PROMPT_MARKER, combineSystemPromptSections, splitSystemPromptSections, normalizeSystemPromptSections } from './prompt-sections'
export type { SystemPromptSections } from './prompt-sections'
export { buildKnowledgeLinkGraph, extractExplicitLinks, expandLinkedFiles, selectRelevantSnippet } from './link-graph'
export type { LinkGraph, KnowledgeLinkEntry, LinkedFileCandidate, ExpandLinkedFilesOptions, SelectRelevantSnippetOptions } from './link-graph'
export { routeConversation } from './conversation-router'
export type { RouteConversationOptions, RoutingDecision, ContextStrategy } from './conversation-router'

export { detectProvider, getProviderCapabilities, normalizeMessagesForProvider } from './provider-capabilities'
export type { ProviderName, ProviderCapabilities, BasicChatMessageLike } from './provider-capabilities'

export { buildKnowledgeSourceAnchor, buildWholeFileKnowledgeAnchor, buildExcelSourceAnchor, formatKnowledgeSourceAnchor, formatExcelSourceAnchor, formatSourceAnchor, buildSourceAnchorPromptHint, buildSourceAnchorReferenceBlock, extractSourceAnchors, extractSourceAnchorsFromContent, extractSourceAnchorsFromMessages, extractParsedSourceAnchors, parseSourceAnchor, splitTextBySourceAnchors, normalizeSourceAnchorsInText, normalizeAvailableSourceAnchors, rewriteSourceAnchorsInText, filterSourceAnchorsInText, isSourceAnchorCoveredByAvailable, isSourceAnchorCoveredByAnyAvailable, filterSourceAnchorsByAvailableContext, ensureAnswerSourceCoverage, SOURCE_ANCHOR_REGEX } from './source-anchor'

// ─── 人生经历（Avatar Life Experience） ──────────────────────────────────────
export type {
  LifeManifest,
  LifeTimelineEntry,
  LifeEpisode,
  LifeProgress,
  LifeFailedEpisode,
  LifeArcItem,
  LifeRelationship,
  LifeEventCategory,
  LifeEmotionType,
  LifeConsolidationStatus,
  LifeGenerationStatus,
  LifePipelineStage,
  LifePersonaNameSource,
  LifeManifestUpdate,
} from './life/types'
export {
  getLifeDir,
  getLifeManifestPath,
  getLifeTimelinePath,
  getLifeConsolidatedPath,
  getLifeProgressPath,
  getLifeEpisodesDir,
  getLifeEpisodePath,
  ensureLifeDir,
  readLifeManifest,
  readLifeTimeline,
  readLifeEpisode,
  readLifeConsolidated,
  readLifeProgress,
  listLifeEpisodeIds,
  writeLifeManifest,
  writeLifeTimeline,
  appendLifeTimelineEntry,
  writeLifeEpisode,
  deleteLifeEpisode,
  updateLifeManifest,
  resetGeneratedLife,
  writeLifeConsolidated,
  writeLifeProgress,
} from './life/store'
// 人生生成器（Phase 1）：4 Stage Pipeline + 单事件 + 遗忘机制
export {
  generateLife,
  generateEpisode,
  appendNewEpisodeForGrowth,
  partitionAgeStages,
  DEFAULT_OUTLINE_TARGET_COUNTS,
  // 透传 forgetter 导出（Phase 2 grower 复用）
  applyAlgorithmicForgetting,
  generateConsolidated,
  DEFAULT_FORGETTING_WEIGHTS,
  CONSOLIDATED_MAX_CHARS,
} from './life/generator'
export type {
  GenerateLifeOptions,
  GenerateEpisodeOptions,
  AppendNewEpisodeForGrowthOptions,
  LifeLLMConfig,
  LifeUserParams,
  ForgettingWeights,
} from './life/generator'
// Prompt 模板（main.ts 不直接用，但测试 / Phase 2 grower 自定义 prompt 时复用）
export {
  buildManifestPrompt,
  buildOutlinePrompt,
  buildEpisodePrompt,
  buildConsolidatedPrompt,
  MANIFEST_SYSTEM_PROMPT,
  OUTLINE_SYSTEM_PROMPT,
  EPISODE_SYSTEM_PROMPT,
  CONSOLIDATED_SYSTEM_PROMPT,
} from './life/prompts'
export type {
  BuildManifestPromptOptions,
  BuildOutlinePromptOptions,
  BuildEpisodePromptOptions,
  BuildConsolidatedPromptOptions,
} from './life/prompts'
// 持续生长（Phase 2，cron Stage 4）
export {
  eventDensityPerMonth,
  monthsToYears,
  DEFAULT_DENSITY_WEIGHTS,
} from './life/density'
export type { DensityWeights } from './life/density'
export {
  advanceLife,
  advanceAllAvatars,
  computeAvatarDeltaMonths,
  samplePendingMonths,
  shouldReconsolidate,
  DEFAULT_RECONSOLIDATE_THRESHOLDS,
  __clearGrowthLocksForTesting,
} from './life/grower'
export type {
  AdvanceLifeOptions,
  AdvanceLifeResult,
  AdvanceAllAvatarsOptions,
  AdvanceAllAvatarsResult,
  ReconsolidateThresholds,
} from './life/grower'
export type { KnowledgeSourceAnchor, ExcelSourceAnchor, SourceAnchor, ParsedSourceAnchor, SourceAnchorSegment, NormalizeSourceAnchorsResult, RewriteSourceAnchorsResult, SourceCoverageResult, FilterAvailableSourceAnchorsResult, SourceAnchorReferenceBlockOptions, EnsureSourceCoverageOptions } from './source-anchor'

// 文档生成模块（PDF / DOCX / Markdown 三格式渲染）
export { validateIR, CALLOUT_LEVELS } from './document/ir-schema'
export type {
  DocumentBlock,
  DocumentBlockType,
  DocumentIR,
  DocumentMetadata,
  HeadingLevel as DocumentHeadingLevel,
  CalloutLevel,
  TableCellValue,
  IRValidationError,
  IRValidationResult,
} from './document/ir-schema'
export { parseIR } from './document/ir-parser'
export type { IRParseResult } from './document/ir-parser'
export { renderMarkdown } from './document/renderers/markdown-renderer'
export { renderHtml, escapeHtml, sanitizeUrl } from './document/renderers/html-renderer'
export type { RenderHtmlOptions } from './document/renderers/html-renderer'
export { loadTemplateCss, resolveTemplatePath } from './document/renderers/template-loader'

export * from './sync/snapshot-manifest'
