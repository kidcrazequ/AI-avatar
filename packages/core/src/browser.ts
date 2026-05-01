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
