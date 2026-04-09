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
