/// <reference types="vite/client" />

/** 由 vite.config.ts define 注入的应用版本号 */
declare const __APP_VERSION__: string

declare module '*.css' {
  const content: string
  export default content
}

interface AvatarConfig {
  id: string
  name: string
  systemPrompt: string
}

interface Conversation {
  id: string
  title: string
  avatar_id: string
  created_at: number
  updated_at: number
}

interface DbMessage {
  id: string
  conversation_id: string
  role: 'user' | 'assistant' | 'tool'
  content: string
  tool_call_id?: string
  image_urls?: string
  created_at: number
}

interface FileNode {
  name: string
  path: string
  type: 'file' | 'directory'
  children?: FileNode[]
}

interface SearchResult {
  path: string
  matches: string[]
}

/** 消息全文搜索结果（FTS5） */
interface MessageSearchResult {
  conversationId: string
  conversationTitle: string
  messageId: string
  snippet: string
  role: string
  createdAt: number
}

/** 解析后的文档内容（GAP9a） */
interface ParsedDocument {
  text: string
  images: string[]
  fileName: string
  fileType: 'pdf' | 'word' | 'pptx' | 'image' | 'text' | 'excel'
  /** 每页字符数，用于 Vision 数据按页码融入原文（PDF 专属） */
  perPageChars?: Array<{ num: number; chars: number }>
  /** 图表页截图对应的页码列表（与 images 一一对应） */
  imagePageNumbers?: number[]
  /** Excel sheet 名称列表（Excel 专属） */
  sheetNames?: string[]
  /**
   * Excel 专属：结构化数据（含 schema + 行），由 write-excel-data IPC
   * 落盘到 knowledge/_excel/<basename>.json 供 query_excel 工具使用。
   */
  structuredData?: ExcelStructuredData
}

/** Excel 列 schema */
interface ExcelColumnSchema {
  name: string
  dtype: 'number' | 'date-like' | 'string'
  uniqueCount: number
  samples: Array<string | number>
  min?: string | number
  max?: string | number
}

/** Excel sheet 结构 */
interface ExcelSheetData {
  name: string
  rowCount: number
  columns: ExcelColumnSchema[]
  rows: Array<Record<string, string | number | null>>
}

/** Excel 导入后产出的结构化数据 */
interface ExcelStructuredData {
  fileName: string
  importedAt: string
  sheets: ExcelSheetData[]
}

/** 批量导入结果（2026-04-13） */
interface BatchImportResult {
  imported: Array<{ fileName: string; targetPath: string }>
  skipped: Array<{ path: string; reason: string }>
  failed: Array<{ path: string; error: string }>
}

/** 统一 LLM 模型配置（OpenAI 兼容接口） */
interface ModelConfig {
  baseUrl: string
  model: string
  apiKey: string
}

/** 消息内容多模态类型 */
type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

/** 工具函数定义 */
interface LLMTool {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

interface ElectronAPI {
  ping: () => Promise<string>
  loadAvatar: (avatarId: string) => Promise<AvatarConfig>

  // 会话管理
  createConversation: (title: string, avatarId: string) => Promise<string>
  getConversations: (avatarId?: string) => Promise<Conversation[]>
  getConversation: (id: string) => Promise<Conversation | undefined>
  updateConversationTitle: (id: string, title: string) => Promise<void>
  deleteConversation: (id: string) => Promise<void>
  searchMessages: (query: string, avatarId?: string) => Promise<MessageSearchResult[]>

  // 消息管理
  saveMessage: (conversationId: string, role: 'user' | 'assistant' | 'tool', content: string, toolCallId?: string, imageUrls?: string[]) => Promise<string>
  getMessages: (conversationId: string) => Promise<DbMessage[]>

  // 设置管理
  getSetting: (key: string) => Promise<string | undefined>
  setSetting: (key: string, value: string) => Promise<void>

  // 知识库管理
  getKnowledgeTree: (avatarId: string) => Promise<FileNode[]>
  readKnowledgeFile: (avatarId: string, relativePath: string) => Promise<string>
  writeKnowledgeFile: (avatarId: string, relativePath: string, content: string) => Promise<void>
  searchKnowledge: (avatarId: string, query: string) => Promise<SearchResult[]>
  // GAP7: 知识文件 CRUD
  createKnowledgeFile: (avatarId: string, relativePath: string, content?: string) => Promise<void>
  deleteKnowledgeFile: (avatarId: string, relativePath: string) => Promise<void>

  // 记忆管理（GAP2）
  readMemory: (avatarId: string) => Promise<string>
  writeMemory: (avatarId: string, content: string) => Promise<void>
  getMemoryStats: (avatarId: string) => Promise<{ chars: number; ratio: number; entries: number }>
  consolidateMemory: (avatarId: string, content: string, apiKey: string, baseUrl: string) => Promise<string>

  // 用户画像管理（Feature 3）
  readUserProfile: (avatarId: string) => Promise<string>
  writeUserProfile: (avatarId: string, content: string) => Promise<void>

  // 人格管理
  readSoul: (avatarId: string) => Promise<string>
  writeSoul: (avatarId: string, content: string) => Promise<void>

  // 模板管理
  getTemplate: (templateName: string) => Promise<string>
  getSoulCreationPrompt: (avatarName: string) => Promise<string>
  getSkillCreationPrompt: () => Promise<string>
  getTestCreationPrompt: () => Promise<string>
  listTemplates: () => Promise<string[]>

  // 分身管理
  listAvatars: () => Promise<Avatar[]>
  getAvatarSoulIntro: (targetAvatarId: string) => Promise<string | null>
  createAvatar: (id: string, soulContent: string, skills: string[], knowledgeFiles: Array<{ name: string; content: string }>) => Promise<void>
  writeSkillFile: (avatarId: string, fileName: string, content: string) => Promise<void>
  deleteAvatar: (id: string) => Promise<void>
  /** 保存分身头像：data URL（自定义）或 "default:<key>"（预置） */
  saveAvatarImage: (avatarId: string, dataUrl: string) => Promise<void>
  /** 读取分身头像，返回 data URL 或 "default:<key>"，无头像返回 null */
  getAvatarImage: (avatarId: string) => Promise<string | null>

  // 测试管理
  getTestCases: (avatarId: string) => Promise<TestCase[]>
  getTestCase: (avatarId: string, caseId: string) => Promise<TestCase | undefined>
  createTestCase: (avatarId: string, testCase: Omit<TestCase, 'filePath'>) => Promise<string>
  deleteTestCase: (avatarId: string, caseId: string) => Promise<void>
  saveTestReport: (avatarId: string, report: TestReport) => Promise<string | undefined>
  getLatestReport: (avatarId: string) => Promise<TestReport | null>
  getReportList: (avatarId: string) => Promise<Array<{ fileName: string; timestamp: number; passed: number; total: number }>>
  // BUG6 修复：移除虚假 onProgress 回调参数
  runTests: (avatarId: string, caseIds: string[]) => Promise<TestCase[]>

  // 技能管理
  getSkills: (avatarId: string) => Promise<Skill[]>
  getSkill: (avatarId: string, skillId: string) => Promise<Skill | undefined>
  updateSkill: (avatarId: string, skillId: string, content: string) => Promise<void>
  toggleSkill: (avatarId: string, skillId: string, enabled: boolean) => Promise<void>

  // 工具调用（GAP4）
  executeToolCall: (avatarId: string, name: string, args: Record<string, unknown>) => Promise<{ content: string; error?: string }>

  // 知识检索（GAP1）
  searchKnowledgeChunks: (avatarId: string, query: string, topN?: number) => Promise<Array<{ file: string; heading: string; content: string; score: number }>>

  // 知识索引构建 + RAG 检索
  buildKnowledgeIndex: (avatarId: string, apiKey: string, baseUrl: string) => Promise<{ contextCount: number; embeddingCount: number }>
  ragRetrieve: (avatarId: string, question: string, apiKey: string, baseUrl: string) => Promise<string>

  // 知识百科（Wiki 融合层）
  compileWiki: (avatarId: string, apiKey: string, baseUrl: string) => Promise<{ entityCount: number; conceptPageCount: number }>
  getWikiStatus: (avatarId: string) => Promise<WikiMeta | null>
  getConceptPages: (avatarId: string) => Promise<Array<{ name: string; entity: string; generatedAt: string }>>
  readConceptPage: (avatarId: string, name: string) => Promise<string>
  lintKnowledge: (avatarId: string, apiKey: string, baseUrl: string) => Promise<WikiLintReport>
  getLintReport: (avatarId: string) => Promise<WikiLintReport | null>
  saveWikiAnswer: (avatarId: string, qa: WikiAnswerData) => Promise<void>
  getWikiAnswers: (avatarId: string) => Promise<WikiAnswerData[]>
  preserveRawFile: (avatarId: string, originalFilePath: string) => Promise<string>
  detectEvolution: (avatarId: string, newContent: string, newFileName: string, apiKey: string, baseUrl: string) => Promise<WikiEvolutionReport>
  getEvolutionReport: (avatarId: string) => Promise<WikiEvolutionReport | null>

  // 文档导入（GAP9a）
  showOpenDialog: (options: { title?: string; filters?: Array<{ name: string; extensions: string[] }>; properties?: string[] }) => Promise<{ canceled: boolean; filePaths: string[] }>
  parseDocument: (filePath: string) => Promise<ParsedDocument>
  writeExcelData: (avatarId: string, basename: string, data: ExcelStructuredData) => Promise<string>

  // 批量 / 归档导入（2026-04-13）
  importFolder: (avatarId: string, folderPath: string) => Promise<BatchImportResult>
  importArchive: (avatarId: string, archivePath: string) => Promise<BatchImportResult>
  installDefaultSkills: (avatarId: string) => Promise<string[]>
  onImportProgress: (callback: (data: { current: number; total: number; fileName: string; phase: string }) => void) => (() => void)
  enhanceKnowledgeFiles: (avatarId: string, options: {
    llm: { apiKey: string; baseUrl: string; model: string }
    ocr?: { apiKey: string; baseUrl?: string }
    targetFiles?: string[]
  }) => Promise<{
    enhanced: number
    failed: number
    total: number
    fabricatedWarnings: number
    fabricatedDetails: Array<{ file: string; values: string[] }>
    ocrFailures: number
    indexBuilt: boolean
    contextCount?: number
    embeddingCount?: number
  }>
  onEnhanceProgress: (callback: (data: { current: number; total: number; fileName: string; phase: string }) => void) => (() => void)

  // 定时自检（GAP14）
  startScheduledTest: (avatarId: string, intervalHours: number) => Promise<void>
  stopScheduledTest: () => Promise<void>
  notifyTestResult: (passed: number, total: number, failed: number) => Promise<void>
  onScheduledTestTrigger: (callback: (avatarId: string) => void) => (() => void)
  onTestResultBadge: (callback: (data: { passed: number; total: number; failed: number }) => void) => (() => void)

  // 定时任务（Feature 8）
  scheduleCron: (type: string, intervalHours: number, avatarId?: string) => Promise<void>
  cancelCron: (type: string) => Promise<void>
  getCronConfig: () => Promise<Array<{ type: string; intervalHours: number; avatarId?: string; enabled: boolean }>>
  onCronMemoryConsolidate: (callback: (avatarId: string) => void) => (() => void)
  onCronKnowledgeCheck: (callback: (avatarId: string) => void) => (() => void)

  // 日志系统
  logEvent: (level: 'info' | 'warn' | 'error', action: string, detail?: string) => Promise<void>
  getActivityLogs: (date?: string) => Promise<string>
  getErrorLogs: (date?: string) => Promise<string>
  getGeneratedIndex: () => Promise<GeneratedRecord[]>
  // 数据库备份
  dbBackup: () => Promise<void>
  // 对话导出
  exportConversation: (conversationId: string, format: 'markdown' | 'pdf') => Promise<void>
  // 提示词模板
  createPromptTemplate: (avatarId: string, title: string, content: string) => Promise<string>
  getPromptTemplates: (avatarId: string) => Promise<PromptTemplate[]>
  updatePromptTemplate: (id: string, avatarId: string, title: string, content: string) => Promise<void>
  deletePromptTemplate: (id: string, avatarId: string) => Promise<void>
  checkUpdate: () => Promise<{ hasUpdate: boolean; currentVersion: string; latestVersion?: string; downloadUrl?: string; releaseNotes?: string }>
  /** 用系统文件管理器打开日志目录，返回目录路径 */
  openLogsFolder: () => Promise<string>
  /** 将最近 N 天错误日志导出到桌面，返回导出结果 */
  exportErrorLog: (days?: number) => Promise<{ success: boolean; message?: string; filePath?: string }>
}

interface Avatar {
  id: string
  name: string
  description: string
  createdAt: number
  /** 头像图片：data URL（自定义上传）或 "default:<key>"（预置头像） */
  avatarImage?: string
}

interface TestCase {
  id: string
  name: string
  category: string
  timeout: number
  prompt: string
  rubrics: string[]
  mustContain: string[]
  mustNotContain: string[]
  filePath: string
}

interface TestResult {
  caseId: string
  caseName: string
  passed: boolean
  score: number
  response: string
  feedback: string
  timestamp: number
  duration: number
}

interface TestReport {
  avatarId: string
  totalCases: number
  passedCases: number
  failedCases: number
  averageScore: number
  results: TestResult[]
  timestamp: number
  duration: number
}

interface Skill {
  id: string
  name: string
  level: string
  version: string
  description: string
  enabled: boolean
  filePath: string
  content: string
}

/** Wiki 编译元数据 */
interface WikiMeta {
  lastCompiled: string
  entityCount: number
  conceptPageCount: number
  qaCount: number
}

/** Wiki Lint 自检问题 */
interface WikiLintIssue {
  type: 'contradiction' | 'gap' | 'duplicate'
  severity: 'warning' | 'error'
  description: string
  locations: Array<{ file: string; heading: string; excerpt: string }>
}

/** Wiki Lint 自检报告 */
interface WikiLintReport {
  timestamp: string
  totalChunks: number
  totalFiles: number
  issueCount: number
  issues: WikiLintIssue[]
}

/** Wiki 沉淀的问答数据 */
interface WikiAnswerData {
  id: string
  question: string
  answer: string
  sources: string[]
  savedAt: string
}

/**
 * 知识演化差异项。
 *
 * @author zhi.qu
 * @date 2026-04-09
 */
interface WikiEvolutionDiff {
  entity: string
  type: 'new' | 'updated' | 'contradiction'
  description: string
  oldSource: { file: string; excerpt: string }
  newExcerpt: string
}

/**
 * 知识演化检测报告。
 *
 * @author zhi.qu
 * @date 2026-04-09
 */
interface WikiEvolutionReport {
  timestamp: string
  newFile: string
  diffs: WikiEvolutionDiff[]
}

interface Window {
  electronAPI: ElectronAPI
}

/** 生成文档归档记录（与 electron/logger.ts 的 GeneratedRecord 保持一致） */
interface GeneratedRecord {
  type: 'soul' | 'skill' | 'memory' | 'knowledge' | 'test-report'
  avatarId: string
  originalPath: string
  archivedFile: string
  createdAt: string
  meta?: Record<string, unknown>
}

/** 提示词模板（与 electron/database.ts 的 PromptTemplate 保持一致） */
interface PromptTemplate {
  id: string
  avatar_id: string
  title: string
  content: string
  created_at: number
}
