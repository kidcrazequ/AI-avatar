/**
 * @soul/core 浏览器子入口（仅导出对浏览器环境安全的纯函数）。
 *
 * 背景：默认入口 ./index 会带出 ToolRouter / ChartCache / chunk-cache 等模块，
 *      这些模块顶层 import 了 fs / path 并访问 process.env / process.pid，
 *      渲染进程经 Vite 预打包后会触发 `process is not defined` 等运行时错误。
 *
 * 约束：本文件只允许 re-export 不依赖 Node 内建模块、不访问 process 全局的纯函数；
 *      凡是需要文件系统、子进程、Electron 资源路径的能力，必须通过 IPC 在主进程暴露。
 *
 * 渲染进程使用方式：`import { localDateString } from '@soul/core/browser'`
 *
 * @author zhi.qu
 * @date 2026-04-30
 */

// ─── 日期工具 ────────────────────────────────────────────────────────────────
export { localDateString } from './utils/local-date'

// ─── 查询哈希（图表缓存 key 用） ─────────────────────────────────────────────
export { hashQueryContent, normalizeQueryForHash } from './utils/query-hash'

// ─── 记忆容量常量与统计（无 IO 副作用） ──────────────────────────────────────
export {
  MEMORY_CHAR_LIMIT,
  MEMORY_WARN_THRESHOLD,
  getMemoryStats,
  shouldConsolidate,
  shouldWarnMemory,
} from './memory-manager'
export type { MemoryStats } from './memory-manager'

export {
  STRUCTURED_MEMORY_FILENAME,
  STRUCTURED_MEMORY_MAX_ENTRIES,
  STRUCTURED_MEMORY_MAX_CONTENT_CHARS,
  formatStructuredMemoryDateLabel,
  getCombinedMemoryInjectionStats,
  buildLongTermMemoryInjectionBody,
  formatStructuredMemoryEntriesForPrompt,
} from './structured-memory'
export type { StructuredMemoryEntry, StructuredMemoryDocument } from './structured-memory'

// ─── OCR / Markdown 清洗（纯字符串处理） ────────────────────────────────────
export {
  cleanOcrHtml,
  cleanPdfFullText,
  cleanLlmOutput,
  detectFabricatedNumbers,
  stripDocxToc,
  mergeVisionIntoText,
} from './utils/ocr-html-cleaner'

// ─── 文档章节切分 / LLM 格式化（仅依赖 ocr-html-cleaner，无 fs/path/process） ─
export {
  splitIntoChapters,
  formatChapter,
  formatDocument,
  FORMAT_SYSTEM_PROMPT,
} from './document-formatter'
export type { Chapter, FormatProgress, LLMCallFn } from './document-formatter'

// ─── 视觉 OCR（基于 fetchWithTimeout，浏览器原生 fetch 可用） ───────────────
export {
  callVisionOcr,
  DEFAULT_VISION_MODEL,
  DEFAULT_VISION_CONCURRENCY,
  DEFAULT_VISION_PROMPT,
  DEFAULT_VISION_TIMEOUT_MS,
} from './utils/vision-ocr'
export type { VisionOcrOptions, VisionOcrResult, VisionOcrFailure } from './utils/vision-ocr'

// ─── HTTP 工具（纯 fetch 封装） ─────────────────────────────────────────────
export { fetchWithTimeout, HttpError } from './utils/http'
export type { FetchWithTimeoutOptions } from './utils/http'

// ─── 知识库 frontmatter 工具（纯字符串处理） ────────────────────────────────
export {
  parseFrontmatterCore,
  extractFrontmatterFields,
  mergeFrontmatter,
  buildFrontmatterBlock,
} from './utils/knowledge-frontmatter'
export type { FrontmatterParseResult } from './utils/knowledge-frontmatter'

// ─── 对话框附件常量与路由（纯静态白名单 + 纯函数） ──────────────────────────
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

// ─── ISS（Intelligent Skill Selection）纯函数入口（无 fs/path） ───────────────
export {
  ISS_DEFAULT_TOP_N,
  ISS_DEFAULT_PINNED_TOOL_NAMES,
  SkillReranker,
} from './skill-reranker'
export type { EmbeddingCallFn as IssEmbeddingCallFn, SkillRerankerOptions } from './skill-reranker'
export type { ToolForRerank } from './skill-reranker-types'

// ─── #7 工具权限策略（纯函数，渲染进程与 execute-tool-call 对齐） ───────────
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
} from './tool-permission-policy'

// ─── 测试中心评分与溯源校验（纯函数）─────────────────────────────────────────
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

export {
  extractParsedSourceAnchors,
} from './source-anchor'

export {
  stableToolDocHash,
  buildToolDocForEmbedding,
  parseSkillEmbeddingCacheJson,
  serializeSkillEmbeddingCacheJson,
  trimSkillEmbeddingCache,
} from './utils/skill-embedding-store'
