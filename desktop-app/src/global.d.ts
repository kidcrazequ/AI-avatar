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

/**
 * 对话框附件元信息（与 electron/database.ts 的 AttachmentRow 保持一致）。
 *
 * 本类型仅描述附件在 UI / IPC 层的持久化形态。文件本体由主进程
 * AttachmentStore 落到 userData/attachments/<convId>/<hash>.<ext>，渲染进程
 * 不直接访问。
 *
 * @author zhi.qu
 * @date 2026-05-01
 */
interface Attachment {
  id: string
  conversation_id: string
  /** 关联的消息 ID，未关联时为 null */
  message_id: string | null
  /** 用户上传时的原始文件名 */
  name: string
  mime: string
  size: number
  /** sha256 hex（小写，64 字符） */
  hash: string
  /** 后缀名（含点，小写；无后缀时为空字符串） */
  ext: string
  /** 解析器抽取的摘要（前 N 字 / 总结），可能为 null */
  summary: string | null
  /** 解析器抽取的文档大纲（多行 markdown 标题），可能为 null */
  outline: string | null
  /** 解析器附加的 JSON 元数据（页数、sheet 名等），存储为 JSON 字符串 */
  parsed_meta: string | null
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

interface WorkspaceListItem {
  path: string
  type: 'file' | 'directory'
  size: number
  mtimeMs: number
}

/** preview-preload 通过 ipcRenderer.send 上报的 inspector 选中元素信息 */
interface PreviewBlockReflectPayload {
  conversationId: string
  ccId: string
  tag: string
  classes: string
  id: string
  text: string
  reactComponentName?: string
  sourceHint?: { file: string; line: number } | null
  rect: { x: number; y: number; width: number; height: number }
}

interface PreviewTweaksAvailable {
  conversationId: string
  controls: Array<{ id: string; type: string; label?: string; value?: unknown }>
}

interface PreviewTweaksSave {
  conversationId: string
  values: Record<string, unknown>
}

interface VerifierResultPayload {
  conversationId: string
  ok: boolean
  url: string
  message: string
  errors: Array<{ level: string; text: string; source?: string; line?: number }>
  warnings: Array<{ level: string; text: string; source?: string; line?: number }>
  resourceFailures: Array<{ url: string; errorCode: number; errorDescription: string }>
  shots: Array<{ viewport: { name: string; width: number; height: number }; filePath?: string; width: number; height: number }>
  elapsedMs: number
  outputDir: string
}

interface ChatDownloadCardPayload {
  conversationId: string
  relativePath: string
  absolutePath: string
  sizeBytes: number
  mimeHint: string
}

interface WorkspaceGrepResult {
  file: string
  line: number
  text: string
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

  // Agent 任务列表持久化（Stage 三 P2 范围外 1）
  saveAgentTasks: (conversationId: string, tasksJson: string) => Promise<void>
  getAgentTasks: (conversationId: string) => Promise<string | null>
  clearAgentTasks: (conversationId: string) => Promise<void>

  // 对话框附件（2026-05-01 对话框附件扩展）
  /**
   * 上传文件附件到指定会话。base64Data 不含 data: 前缀。
   * 主进程会落盘 + 抽取 outline/summary + 写 attachments 表，返回完整元信息。
   */
  saveAttachment: (conversationId: string, name: string, base64Data: string, mime?: string) => Promise<Attachment>
  /** 按 ID 取附件元信息（不返回文件本体） */
  getAttachmentMeta: (id: string) => Promise<Attachment | undefined>
  /** 列出某会话所有附件元信息（按上传时间升序） */
  listAttachments: (conversationId: string) => Promise<Attachment[]>
  /** 把刚上传的附件挂到刚保存的 user 消息上。返回实际更新行数。 */
  linkAttachmentToMessage: (messageId: string, attachmentIds: string[], conversationId: string) => Promise<number>
  /** 用系统默认应用打开附件本体（chip 点击时调用） */
  openAttachmentFile: (id: string) => Promise<{ ok: true; path: string }>

  // 文档生成（PDF / DOCX / Markdown）— 与 generate_document 工具配套（2026-05-08）
  /**
   * 把 generateDocument 渲染好的完整 HTML 字符串落成 PDF 文件。
   * outputPath 必须为绝对路径（已经 generateDocument 安全校验）。
   */
  renderDocumentPdf: (html: string, outputPath: string) => Promise<{ size: number }>
  /**
   * 把 DocumentIR（@soul/core 的统一中间表示）渲染为 .docx 文件。
   * 主进程使用 docx@9.x；中文字体按平台自动选择。
   */
  renderDocumentDocx: (ir: unknown, outputPath: string) => Promise<{ size: number }>
  /**
   * 用系统默认应用打开生成的文档（FileCard 主按钮）。
   * 返回 shell.openPath 的错误描述：成功为 ''，失败为非空字符串。
   */
  openDocument: (absolutePath: string) => Promise<string>
  /** 在系统资源管理器/Finder 中显示生成的文档（FileCard 次按钮） */
  showDocumentInFolder: (absolutePath: string) => Promise<{ ok: boolean; error?: string }>

  // 工具结果 spool 查看入口（Stage 三 P2 范围外 2）
  listToolResults: (conversationId: string) => Promise<Array<{ file: string; size: number; mtime: number }>>
  openToolResultsFolder: (conversationId: string) => Promise<{ success: boolean; error?: string; path?: string }>
  readToolResult: (absPath: string, maxBytes?: number) => Promise<{ content: string; truncated: boolean; size: number }>

  // 设置管理
  getSetting: (key: string) => Promise<string | undefined>
  setSetting: (key: string, value: string) => Promise<void>
  claudeBridgeComplete: (conversationId: string, input: string | { messages?: Array<{ role: string; content: string }> }, filePath?: string) => Promise<string>
  claudeBridgeGetLimits: () => Promise<{ perMinute: number; perFilePerMinute: number; perConversationTokens: number; perAvatarDailyTokens: number }>
  claudeBridgeSetLimits: (limits: Record<string, number>) => Promise<{ perMinute: number; perFilePerMinute: number; perConversationTokens: number; perAvatarDailyTokens: number }>
  claudeBridgeReadLog: (date?: string) => Promise<string>

  // Preview pane (L3 Phase C/D/G)
  previewSetBounds: (bounds: { x: number; y: number; width: number; height: number }) => Promise<void>
  previewSetInspector: (target: 'user' | 'hidden', enabled: boolean) => Promise<void>
  previewSetUserVisible: (visible: boolean) => Promise<void>
  previewApplyTweaks: (conversationId: string, params: { path: string; blockId: string; values: Record<string, unknown> }) => Promise<{ changed: boolean; bytes: number; backupPath?: string }>
  onPreviewBlockSelected: (callback: (payload: PreviewBlockReflectPayload) => void) => (() => void)
  onPreviewTweaksAvailable: (callback: (payload: PreviewTweaksAvailable) => void) => (() => void)
  onPreviewTweaksSave: (callback: (payload: PreviewTweaksSave) => void) => (() => void)
  onPreviewSizeChanged: (callback: (payload: { width: number; height: number }) => void) => (() => void)
  onPreviewLoaded: (callback: (payload: { conversationId: string; path: string; done?: boolean }) => void) => (() => void)
  onVerifierResult: (callback: (payload: VerifierResultPayload) => void) => (() => void)

  // Chat side cards (L3 Phase J'/G/I/K)
  onChatDownloadCard: (callback: (payload: ChatDownloadCardPayload) => void) => (() => void)
  onChatFormRequest: (callback: (payload: { conversationId: string; payload: unknown }) => void) => (() => void)
  onChatRequestGithubPat: (callback: (payload: { conversationId: string }) => void) => (() => void)
  onChatCanvaUploadCard: (callback: (payload: { conversationId: string; exportPath?: string }) => void) => (() => void)
  onChatSnipAdded: (callback: (payload: { conversationId: string; fromId: string; toId: string }) => void) => (() => void)
  /** 九层重构 #12 ask_question：tool-router 推送多选卡片 payload，由 ChatWindow 渲染 AskQuestionCard */
  onChatAskQuestion: (callback: (payload: { conversationId: string; question: string; options: string[]; allowCustom: boolean }) => void) => (() => void)
  /** 九层重构 #17 switch_mode：tool-router 推送模式切换通知，chatStore 监听并更新 mode */
  onChatModeChanged: (callback: (payload: { conversationId: string; mode: 'agent' | 'plan' | 'ask'; reason?: string }) => void) => (() => void)

  // GitHub connector (L3 Phase K)
  githubStatus: () => Promise<{ connected: boolean; login: string | null }>
  githubConnect: (token: string) => Promise<{ login: string }>
  githubDisconnect: () => Promise<void>

  // Snip context manager (L3 Phase I)
  snipList: (conversationId: string) => Promise<Array<{ from: string; to: string; reason: string; addedAt: number }>>
  snipClear: (conversationId: string) => Promise<void>
  snipNextMsgId: (conversationId: string) => Promise<string>
  snipHydrate: (conversationId: string) => Promise<number>

  // Workspace（L3 Phase A）
  workspaceStat: (conversationId: string, relativePath: string) => Promise<WorkspaceListItem>
  workspaceRead: (conversationId: string, relativePath: string) => Promise<string>
  workspaceWrite: (conversationId: string, relativePath: string, content: string) => Promise<string>
  workspaceList: (conversationId: string, relativePath?: string, depth?: number) => Promise<WorkspaceListItem[]>
  workspaceCopy: (conversationId: string, src: string, dest: string, move?: boolean) => Promise<void>
  workspaceMove: (conversationId: string, src: string, dest: string) => Promise<void>
  workspaceDelete: (conversationId: string, relativePath: string) => Promise<void>
  workspaceGrep: (conversationId: string, relativePath: string, pattern: string) => Promise<WorkspaceGrepResult[]>

  // 知识库管理
  getKnowledgeTree: (avatarId: string) => Promise<FileNode[]>
  readKnowledgeFile: (avatarId: string, relativePath: string) => Promise<string>
  /** 解析 knowledge/<file>.md → 原始源文件元信息（PDF/Excel/PPT），找不到时返回 null。详见 src/types/raw-file-anchor.ts */
  resolveRawFile: (avatarId: string, mdRelativePath: string) => Promise<{ rawRelPath: string; displayName: string; ext: string; exists: boolean } | null>
  /** 用系统默认应用打开 knowledge/_raw/ 下的原始文件。详见 src/types/raw-file-anchor.ts */
  openRawFile: (avatarId: string, rawRelPath: string) => Promise<{ ok: boolean; error?: string }>
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

  /**
   * 人生经历（Avatar Life Experience，Phase 0+1）。
   * namespace 风格保留扩展空间：Phase 2 加 setTimeScale / toggleGrowth / advanceNow。
   */
  life: {
    // ─── Phase 0：读 / 删 ─────────────────────────────────────────────────
    /** 读取 life/manifest.json，不存在返回 null */
    getManifest: (avatarId: string) => Promise<LifeManifest | null>
    /** 读取 life/timeline.json，不存在返回 [] */
    listTimeline: (avatarId: string) => Promise<LifeTimelineEntry[]>
    /** 读取 life/episodes/<id>.md 正文，不存在返回 null */
    readEpisode: (avatarId: string, episodeId: string) => Promise<string | null>
    /** 读取 life/progress.json，不存在返回 null */
    getProgress: (avatarId: string) => Promise<LifeProgress | null>
    /** 读取 life/consolidated.md，不存在返回空字符串 */
    readConsolidated: (avatarId: string) => Promise<string>
    /** 删除单个 episode 的 .md 并从 timeline 移除条目，返回是否实际从 timeline 移除 */
    deleteEpisode: (avatarId: string, episodeId: string) => Promise<boolean>

    // ─── Phase 1：生成器控制 + 进度订阅 ────────────────────────────────────
    /**
     * 异步启动初始化生成 Pipeline。
     * IPC 立即返回，后台跑生成；进度通过 onProgress 订阅。
     * @throws 当分身已在生成中、currentAge / timeScale 非法、或 chat_api_key 未配置
     */
    startGeneration: (avatarId: string, params: LifeStartGenerationParams) => Promise<LifeStartGenerationResult>
    /** 取消正在进行的生成；已落盘的 manifest/timeline/episodes 全部保留 */
    cancelGeneration: (avatarId: string) => Promise<LifeCancelGenerationResult>
    /** 取消（如有）+ 重新启动 generateLife（内部按 progress.json 断点续传） */
    retryGeneration: (avatarId: string, params: LifeStartGenerationParams) => Promise<LifeStartGenerationResult>
    /**
     * 订阅 'life:progress' 事件。
     * @returns unsubscribe 函数
     */
    onProgress: (callback: (payload: LifeProgressPayload) => void) => () => void

    // ─── Phase 2：持续生长控制 ────────────────────────────────────────────
    /**
     * 修改单分身 timeScale（合法 0/1/12/52）。
     * 修改后立即落盘 manifest.json，下次 cron 推进即按新速率算。
     */
    setTimeScale: (avatarId: string, timeScale: number) => Promise<LifeSetTimeScaleResult>
    /** 开关单分身的持续生长。关闭后 cron 跳过该分身 */
    toggleGrowth: (avatarId: string, enabled: boolean) => Promise<LifeToggleGrowthResult>
    /**
     * 调试用：立即推进单分身一次（同步等待）。
     * 返回 AdvanceLifeResult，advanced=false 时 skipReason 说明跳过原因。
     */
    advanceNow: (avatarId: string) => Promise<LifeAdvanceNowResult>
  }

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
  createSkill: (avatarId: string, skillId: string, content: string) => Promise<Skill>
  deleteSkill: (avatarId: string, skillId: string) => Promise<void>
  generateSkillDraft: (description: string) => Promise<{ draft: string; suggestedId: string }>

  // ─── 社区技能管理 ─────────────────────────────────────────────
  /** 读取 sources.yaml 返回源列表 */
  communityListSources: () => Promise<CommunitySkillSource[]>
  /** 添加新的技能源到 sources.yaml */
  communityAddSource: (source: CommunitySkillSource) => Promise<void>
  /** 从 sources.yaml 移除技能源 */
  communityRemoveSource: (name: string) => Promise<void>
  /** 执行同步（等同于 soul-sync.sh） */
  communitySync: () => Promise<InstalledCommunityPack[]>
  /** 同步进度推送回调 */
  onCommunitySyncProgress: (callback: (progress: CommunitySkillSyncProgress) => void) => (() => void)
  /** 列出已安装的社区技能包 */
  communityListInstalled: () => Promise<InstalledCommunityPack[]>
  /** 为某分身启用指定社区技能 */
  communityEnableForAvatar: (avatarId: string, skillName: string, packName: string) => Promise<void>
  /** 为某分身禁用指定社区技能 */
  communityDisableForAvatar: (avatarId: string, skillName: string) => Promise<void>

  // RAG 检索阶段进度
  onRagProgress: (callback: (data: { avatarId: string; phase: string; detail?: string }) => void) => () => void

  // 工具调用（GAP4）
  executeToolCall: (avatarId: string, conversationId: string, name: string, args: Record<string, unknown>) => Promise<{ content: string; error?: string }>

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
  formatKnowledgeFile: (avatarId: string, relativePath: string) => Promise<{ success: boolean; error?: string }>
  onFileWritten: (callback: (data: { avatarId: string; fileName: string }) => void) => (() => void)
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
  /**
   * 查询 chart 答案 cache（chartConsistencyMode 同问同答）。
   * 命中 → { hit:true, assistantContent, createdAt }；未命中/快照失效 → { hit:false }
   */
  getChartCacheHit: (avatarId: string, queryHash: string) => Promise<
    | { hit: true; assistantContent: string; createdAt: number }
    | { hit: false }
  >
  /**
   * 写入 chart 答案 cache。主进程侧自动快照 <avatar>/soul.md 与
   * payload.excelBasenames 指向的 <avatar>/knowledge/_excel/<basename>.json。
   */
  saveChartCacheEntry: (avatarId: string, payload: {
    queryHash: string
    queryPreview: string
    assistantContent: string
    excelBasenames?: string[]
  }) => Promise<void>
  checkUpdate: () => Promise<{ hasUpdate: boolean; currentVersion: string; latestVersion?: string; downloadUrl?: string; releaseNotes?: string }>
  /** 用系统文件管理器打开日志目录，返回目录路径 */
  openLogsFolder: () => Promise<string>
  /** 用系统文件管理器打开当前分身的 workspaces 根目录 */
  openAvatarWorkspacesFolder: (avatarId: string) => Promise<{ success: boolean; error?: string; path?: string }>
  /** 将最近 N 天错误日志导出到桌面，返回导出结果 */
  exportErrorLog: (days?: number) => Promise<{ success: boolean; message?: string; filePath?: string }>
  /** 读取指定日期的工具调用审计日志（jsonl 字符串），默认今天，不存在返回 '' */
  readToolCallLog: (date?: string) => Promise<string>

  // ─── MCP server 管理 ─────────────────────────────────────────────
  /** 列出所有 MCP server（合并 DB 配置 + 运行时状态） */
  mcpListServers: () => Promise<McpServerListItem[]>
  /** 创建或更新 server（同时写 DB + 重建连接） */
  mcpUpsertServer: (config: McpServerInput) => Promise<McpServerSnapshot | null>
  /** 删除 server */
  mcpRemoveServer: (name: string) => Promise<{ ok: boolean }>
  /** 重新连接（不改 DB） */
  mcpReconnectServer: (name: string) => Promise<McpServerSnapshot | null>
  /** 临时断开（不改 DB） */
  mcpDisconnectServer: (name: string) => Promise<McpServerSnapshot | null>

  // ─── 批量回归测试（2026-04-30 子任务 5）───────────────────────────────
  /**
   * 读题库或现场生成。
   * - cached=true: 用了已有 question-bank.json
   * - cached=false: 现场调用 generateQuestionBank 生成并落盘
   */
  regressionLoadOrGenerateBank: (avatarId: string, opts?: { force?: boolean }) => Promise<{
    bank: RegressionQuestionBank
    cached: boolean
    bankPath: string
  }>
  /** 列历史 run（按 startedAt 倒序），不存在返回 [] */
  regressionListRuns: (avatarId: string) => Promise<RegressionRunMeta[]>
  /** 注册指定 ID 的临时会话；conversationId 必须以 'regression-' 开头 */
  regressionEnsureConversation: (avatarId: string, conversationId: string, title: string) => Promise<{ ok: true }>
  /** 落盘 run 结果（result.json + report.md + report.html + metadata.json） */
  regressionSaveRunResult: (avatarId: string, payload: {
    runId: string
    startedAt: number
    finishedAt: number
    totalCases: number
    passCount: number
    failCount: number
    errorCount: number
    resultJson: string
    questionBankJson?: string
    questionBankSource?: RegressionQuestionBankSource
    reportMd: string
    reportHtml: string
  }) => Promise<{
    runDir: string
    resultJsonPath: string
    reportMdPath: string
    reportHtmlPath: string
    metadataPath: string
  }>
  /** 清理 regression-{runId}-* 会话（CASCADE 删消息），返回删除数 */
  regressionCleanupConversations: (runId: string) => Promise<{ deleted: number }>
  /** 系统默认浏览器打开 report.html（限制必须在 avatars/{id}/tests/runs/ 下） */
  regressionOpenReport: (filePath: string) => Promise<{ ok: true }>
}

// ─── 批量回归相关数据类型（2026-04-30 子任务 5）─────────────────────────

/** 题库数据结构（与 electron/kb-question-generator.ts QuestionBank 对应） */
interface RegressionQuestionBank {
  generatedAt: string
  generatedBy: string
  avatarId: string
  knowledgeSnapshot: {
    excelFiles: number
    mdFiles: number
    totalRows: number
    totalChapters: number
  }
  summary: Partial<Record<string, number>>
  questions: Array<{
    id: string
    category: string
    prompt: string
    /** 嵌套数组语义为 OR：任一命中即视为该子句通过；string 项为强制 AND */
    expectedTools?: (string | string[])[]
    expectedSkills?: string[]
    expectedValue?: { value: number; unit?: string; tolerancePct: number }
    mustContain?: string[]
    mustNotContain?: string[]
    sourceFile?: string
    sourceSection?: string
    sourceCell?: { sheet: string; rowIndex: number; column: string }
  }>
}

/** 本次回归运行使用的题库来源信息 */
interface RegressionQuestionBankSource {
  sourcePath: string
  cached: boolean
  loadedAt: number
  generatedAt?: string
  totalQuestionCount: number
  selectedQuestionCount: number
}

/** 历史 run 元数据（regression-list-runs 返回） */
interface RegressionRunMeta {
  runId: string
  startedAt: number
  finishedAt: number
  totalCases: number
  passCount: number
  failCount: number
  errorCount: number
  reportHtmlPath: string
  reportMdPath: string
  resultJsonPath: string
}

/** UI 输入的 MCP server 配置 */
interface McpServerInput {
  name: string
  enabled: boolean
  transport: 'stdio' | 'http' | 'sse'
  command?: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  url?: string
  timeoutMs?: number
  description?: string
}

/** runtime 给 UI 的 server 快照 */
interface McpServerSnapshot {
  name: string
  status: 'idle' | 'connecting' | 'connected' | 'error' | 'disconnected'
  transport: 'stdio' | 'http' | 'sse'
  description?: string
  toolCount: number
  tools: Array<{ qualifiedName: string; serverName: string; toolName: string; description: string; inputSchema: unknown }>
  error?: string
  lastConnectedAt?: number
}

/** mcp:list-servers 返回的合并视图（DB 配置 + 运行时状态） */
interface McpServerListItem {
  name: string
  enabled: boolean
  transport: 'stdio' | 'http' | 'sse'
  command?: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  url?: string
  timeout_ms?: number
  description?: string
  created_at: number
  updated_at: number
  status: 'idle' | 'connecting' | 'connected' | 'error' | 'disconnected'
  toolCount: number
  tools: McpServerSnapshot['tools']
  error?: string
  lastConnectedAt?: number
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
  /** 系统内置技能（来自 templates/skills/），不允许 UI 删除 */
  isBuiltin: boolean
  /** 技能来源：local=分身专属，shared=公共，community=社区 */
  source?: 'local' | 'shared' | 'community'
  /** 社区技能来源 URL（source='community' 时有值） */
  origin?: string
}

/** 社区技能源（对应 sources.yaml 中的一项） */
interface CommunitySkillSource {
  name: string
  repo: string
  ref: string
  path?: string
  file?: string
  skills?: string[]
}

/** 已安装的社区技能包 */
interface InstalledCommunityPack {
  name: string
  repo: string
  ref: string
  commit: string
  syncedAt: string
  skillCount: number
  skills: CommunitySkillInfo[]
}

/** 社区技能信息 */
interface CommunitySkillInfo {
  name: string
  file: string
  description: string
  domain: string
}

/** 社区技能同步进度 */
interface CommunitySkillSyncProgress {
  sourceName: string
  phase: 'cloning' | 'checking-out' | 'copying' | 'done' | 'error'
  detail?: string
  total: number
  current: number
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

// ─── 人生经历（Avatar Life Experience，Phase 0） ─────────────────────────────
//
// 平行声明 packages/core/src/life/types.ts 中的类型，供渲染端组件使用。
// 修改本节时必须同步更新 packages/core/src/life/types.ts，字段顺序保持一致
// 便于人工 diff（与既有 Avatar / Skill / TestCase 同模式）。
//
// @author zhi.qu
// @date 2026-05-09

type LifeEventCategory =
  | 'formative'
  | 'daily'
  | 'trauma'
  | 'joy'
  | 'professional'
  | 'loss'

type LifeEmotionType =
  | 'joy'
  | 'sorrow'
  | 'anger'
  | 'fear'
  | 'wonder'
  | 'shame'
  | 'love'

type LifeConsolidationStatus = 'remembered' | 'blurred' | 'forgotten'

type LifeGenerationStatus =
  | 'pending'
  | 'generating'
  | 'complete'
  | 'failed'
  | 'growing'

type LifePipelineStage =
  | 'idle'
  | 'manifest'
  | 'outline'
  | 'episodes'
  | 'forgetting'
  | 'growing'
  | 'complete'
  | 'failed'

interface LifeArcItem {
  age: number
  shift?: string
  milestone?: string
}

interface LifeRelationship {
  role: string
  name: string
  description: string
}

/** 人生骨架 manifest.json 的完整 schema（与 plan 1.1 节一致） */
interface LifeManifest {
  schemaVersion: number
  personaName: string
  birthYear: number
  birthMonth: number
  birthDay: number
  initialAge: number
  initialAgeBornAt: string
  timeScale: number
  lastAdvancedAt: string
  currentAgeMonths: number
  growthEnabled: boolean
  gender: string
  birthplace: string
  familyBackground: string
  personalityArc: LifeArcItem[]
  professionalSpine: LifeArcItem[]
  majorRelationships: LifeRelationship[]
  createdAt: string
  totalEpisodes: number
  totalChars: number
  generationStatus: LifeGenerationStatus
  lastConsolidatedAt: string
  consolidationCounter: number
}

/** 时间轴单项 timeline.json[i] 的 schema（与 plan 1.2 节一致） */
interface LifeTimelineEntry {
  id: string
  age: number
  year: number
  month: number
  title: string
  summary: string
  category: LifeEventCategory
  themes: string[]
  importance: number
  emotion: number
  emotionType: LifeEmotionType
  wordCount: number
  consolidationStatus: LifeConsolidationStatus
  consolidationNote: string
}

interface LifeFailedEpisode {
  id: string
  error: string
  failedAt: string
}

/** 生成进度 progress.json 的 schema */
interface LifeProgress {
  stage: LifePipelineStage
  completedEpisodes: number
  totalEpisodes: number
  usedFallback: boolean
  lastError: string
  updatedAt: string
  failedEpisodes: LifeFailedEpisode[]
  consolidationLastTotalEpisodes: number
}

/**
 * 创建向导第 5 步「人生剧本」用户输入参数（Phase 1 IPC 入参）。
 * 与主进程 main.ts:LifeStartGenerationParams 保持一致。
 */
interface LifeStartGenerationParams {
  /** 18-80 岁 */
  currentAge: number
  /** 1.0 / 12.0 / 52.0 / 0 */
  timeScale: number
  /** 是否启用持续生长 */
  growthEnabled: boolean
  /** 用户额外要求（可空） */
  extraHints?: string
  /** 分身展示名（用于 prompt） */
  avatarName: string
}

/**
 * 'life:progress' IPC 事件 payload。
 * 主进程 webContents.send 时附带 avatarId 用于多分身并发场景区分。
 */
interface LifeProgressPayload {
  avatarId: string
  progress: LifeProgress
}

/** life:start-generation / retry-generation 的返回 */
interface LifeStartGenerationResult {
  started: true
  /** creationModel 缺失走 chatModel 时为 true，UI 顶部黄色提示读这个 */
  usedFallback: boolean
}

/** life:cancel-generation 的返回 */
interface LifeCancelGenerationResult {
  cancelled: boolean
}

/**
 * life:set-time-scale 返回。
 * timeScale 仅会是 0 / 1 / 12 / 52；前端可据此刷新 LifeTimeScaleModal 当前选项。
 */
interface LifeSetTimeScaleResult {
  ok: true
  timeScale: number
}

/** life:toggle-growth 返回 */
interface LifeToggleGrowthResult {
  ok: true
  growthEnabled: boolean
}

/**
 * life:advance-now 返回。
 * 与主进程 advanceLife 的 AdvanceLifeResult 形态一致。
 * advanced=false 时 skipReason 解释跳过原因，前端用来给用户友好提示。
 */
interface LifeAdvanceNowResult {
  advanced: boolean
  skipReason?:
    | 'no-manifest'
    | 'growth-disabled'
    | 'time-frozen'
    | 'generation-in-progress'
    | 'sub-month-delta'
    | 'locked'
  avatarDeltaMonths: number
  newEpisodes: number
  failedEpisodes: number
  reconsolidated: boolean
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
