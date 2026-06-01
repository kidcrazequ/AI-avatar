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

/**
 * v17 会话 JSONL 事件联合类型（renderer 侧镜像）。
 *
 * 真源在 desktop-app/electron/conversation-jsonl-appender.ts；
 * 渲染进程不能 import electron/，所以这里 ambient 复刻，便于 EventViewer 强类型 switch。
 * 如果上游 schema 改动需要同步两侧。
 */
interface JsonlEventBase {
  conversationId: string
  ts: number
}
interface JsonlEventMessage extends JsonlEventBase {
  type: 'message'
  id: string
  role: 'user' | 'assistant' | 'tool'
  content: string
  toolCallId?: string | null
  imageUrls?: string[] | null
  reasoningContent?: string | null
}
interface JsonlEventConversationStarted extends JsonlEventBase {
  type: 'conversation_started'
  avatarId: string
  projectId: string
  title: string
}
interface JsonlEventMemoryUpdate extends JsonlEventBase {
  type: 'memory_update'
  avatarId: string
  updateCount: number
  summaryPreview: string
  totalByteSize: number
  consolidated: boolean
}
interface JsonlEventModelSwitch extends JsonlEventBase {
  type: 'model_switch'
  fromModel: string | null
  toModel: string | null
}
interface JsonlEventModeSwitch extends JsonlEventBase {
  type: 'mode_switch'
  fromMode: 'agent' | 'plan' | 'ask'
  toMode: 'agent' | 'plan' | 'ask'
}
interface JsonlEventSubAgentTask extends JsonlEventBase {
  type: 'sub_agent_task'
  taskId: string
  status: 'running' | 'done' | 'error' | 'lost' | 'denied'
  parentAvatarId: string
  targetAvatar?: string | null
  taskPreview: string
  error?: string | null
  agentType?: string | null
  denyReason?: string | null
}
type ConversationJsonlAnyEvent =
  | JsonlEventMessage
  | JsonlEventConversationStarted
  | JsonlEventMemoryUpdate
  | JsonlEventModelSwitch
  | JsonlEventModeSwitch
  | JsonlEventSubAgentTask
interface ReadEventsResult {
  events: ConversationJsonlAnyEvent[]
  parseErrors: number
}

interface Conversation {
  id: string
  title: string
  avatar_id: string
  /** Avatar 内项目分区，缺省为 `default` */
  project_id?: string
  created_at: number
  updated_at: number
}

/**
 * v17 Phase 2a：对话情景记忆 DTO（renderer 侧镜像）。
 * 真源在 packages/core/src/memory/episode-types.ts ConversationEpisode；
 * renderer 不能 import packages/core 的 sub-paths，这里 ambient 复刻。
 */
interface ConversationEpisodeDTO {
  schemaVersion: number
  conversationId: string
  avatarId: string
  title: string
  theme: string
  summary: string
  keyQuotes: string[]
  themes: string[]
  valence: number
  emotionType: 'joy' | 'sorrow' | 'anger' | 'fear' | 'wonder' | 'shame' | 'love'
  importance: number
  consolidationStatus: 'remembered' | 'blurred' | 'forgotten'
  consolidationNote: string
  conversationStartedAt: number
  conversationLastMessageAt: number
  extractedAt: number
  messageCount: number
}

interface DbMessage {
  id: string
  conversation_id: string
  role: 'user' | 'assistant' | 'tool'
  content: string
  tool_call_id?: string
  image_urls?: string
  /** thinking 模型 reasoning_content；NULL/缺失表示该消息无思考过程（兼容历史无此列的行） */
  reasoning_content?: string | null
  /** v17：[UNCERTAIN] 标记内容 JSON 数组字符串；NULL/缺失 = 无 chip */
  uncertain_markers?: string | null
  /** v17：[RECONSIDER] 标记内容 JSON 数组字符串；NULL/缺失 = 无 chip */
  reconsider_markers?: string | null
  /** v19：本条 assistant 消息关联的工具调用时间线 JSON 字符串；NULL/缺失 = 没调工具或老数据 */
  tool_call_timeline_json?: string | null
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

/**
 * 用户自定义定时任务（#11 Scheduled Tasks，2026-05-09）。
 * 与 electron/db-schedules.ts 的 ScheduleRow 保持字段一致，仅枚举 enabled 用 0/1。
 */
/** Project（任务包，v18）— 分身下的子工作空间显式实体。 */
interface ProjectRow {
  id: string
  avatar_id: string
  name: string
  description: string
  archived: 0 | 1
  created_at: number
  updated_at: number
  conversation_count: number
}

interface ScheduleRow {
  id: string
  name: string
  avatar_id: string
  project_id: string
  conversation_id: string | null
  cron_expr: string
  timezone: string
  prompt_text: string
  enabled: 0 | 1
  next_run_at: number | null
  created_at: number
  updated_at: number
}

interface ScheduleRunRow {
  id: number
  schedule_id: string
  fired_at_utc: number
  status: 'running' | 'success' | 'failed' | 'missed'
  conversation_id: string | null
  duration_ms: number | null
  error_message: string | null
  created_at: number
}

/** 创建 schedule 入参（id / 时间戳由主进程生成） */
interface NewScheduleInput {
  name: string
  avatarId: string
  projectId?: string
  conversationId?: string | null
  cronExpr: string
  timezone?: string
  promptText: string
  enabled?: boolean
}

/** 更新 schedule 入参（仅传需要改的字段） */
interface UpdateScheduleInput {
  name?: string
  avatarId?: string
  projectId?: string
  conversationId?: string | null
  cronExpr?: string
  timezone?: string
  promptText?: string
  enabled?: boolean
}

/**
 * Web Embed 单条记录（#15 Web Embed widget，2026-05-09）。
 * 与 electron/db-embeds.ts 的 EmbedRow 保持字段一致；origin_whitelist 仍是 JSON
 * 字符串（数组），由 UI 层自己 JSON.parse / stringify。
 *
 * @author zhi.qu
 * @date 2026-05-09
 */
interface EmbedRow {
  id: string
  avatar_id: string
  name: string
  /** JSON 数组字符串，例如 '["http://localhost:3000"]'；DAO 层禁止包含 wildcard `*` */
  origin_whitelist: string
  enabled: 0 | 1
  rate_limit_per_min: number
  greeting: string | null
  created_at: number
  updated_at: number
}

/** 创建 embed 入参（id / 时间戳由主进程生成） */
interface NewEmbedInput {
  avatarId: string
  name: string
  /** Origin 列表（不允许包含 `*`，DAO 层会抛 Error） */
  originWhitelist: string[]
  /** 默认 30，clamp 到 [5, 300] */
  rateLimitPerMin?: number
  /** 超 500 字符截断；空字符串保存为 null */
  greeting?: string
  /** 默认 true */
  enabled?: boolean
}

/** 更新 embed 入参（仅传需要改的字段） */
interface UpdateEmbedInput {
  avatarId?: string
  name?: string
  originWhitelist?: string[]
  rateLimitPerMin?: number
  greeting?: string | null
  enabled?: boolean
}

/**
 * WebDAV 跨设备同步类型（#16 WebDAV cross-device sync，2026-05-09）。
 * 与 electron/sync/sync-manager.ts 的导出类型保持字段一致；密码字段绝不会
 * 通过 IPC 返回，UI 仅看到 hasPassword 标志。
 *
 * @author zhi.qu
 * @date 2026-05-09
 */
type WebDavSyncInterval = 'off' | 'hourly' | 'every-6-hours' | 'daily'

interface WebDavSyncConfig {
  enabled: boolean
  endpoint: string
  username: string
  basePath: string
  ignoreTlsErrors: boolean
  autoInterval: WebDavSyncInterval
  /** 远端保留份数，clamp 到 [1, 30]，默认 7 */
  retentionCount: number
  /** UI 用：是否已存有效密码（不返回明文） */
  hasPassword: boolean
}

interface WebDavSyncStatus {
  inProgress: boolean
  lastSyncAt: number | null
  lastSyncStatus: 'success' | 'failed' | null
  lastSyncDirection: 'backup' | 'restore' | null
  lastSyncError: string | null
  /** 当前设备的稳定 UUID */
  deviceId: string
  storageBackend: string
  storageBackendSecure: boolean
  storageBackendHint: string
}

interface BackupNowResult {
  ok: boolean
  filename?: string
  totalBytes?: number
  durationMs?: number
  error?: string
}

interface RestoreFromResult {
  ok: boolean
  filename: string
  durationMs?: number
  error?: string
  /** 兜底备份位置；UI 可显示给用户 */
  preRestoreLocalPath?: string
}

interface RemoteBackupItem {
  filename: string
  size: number
  /** ISO 字符串；webdav 5.x lastmod 通常是 RFC1123，原样返回 */
  lastModified: string
}

/** sync:set-config 入参；password 是可选明文密码 */
interface WebDavSetConfigInput {
  enabled?: boolean
  endpoint?: string
  username?: string
  basePath?: string
  ignoreTlsErrors?: boolean
  autoInterval?: WebDavSyncInterval
  retentionCount?: number
  /** undefined=不修改，''/null=清空，非空=加密保存 */
  password?: string | null
}

/** sync:test-connection 入参；不填则用持久化配置 */
interface WebDavTestConnectionInput {
  endpoint?: string
  username?: string
  password?: string
  basePath?: string
  ignoreTlsErrors?: boolean
}

/** 同步历史一行（与 electron/db-sync-history.ts 的 SyncHistoryRow 字段一致） */
interface SyncHistoryRow {
  id: number
  direction: 'backup' | 'restore'
  status: 'success' | 'failed' | 'in_progress'
  file_count: number
  total_bytes: number
  duration_ms: number
  remote_filename: string | null
  error_message: string | null
  created_at: number
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
  /** 所属分身 ID（用于全局搜索时跨分身跳转） */
  avatarId: string
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

/** 结构化长期记忆条目（memory/MEMORY.entries.json，与 @soul/core 对齐） */
interface StructuredMemoryEntryDTO {
  id: string
  createdAt: string
  updatedAt: string
  category: string
  content: string
  source?: string
}

interface StructuredMemoryDocumentDTO {
  schemaVersion: 1
  entries: StructuredMemoryEntryDTO[]
}

interface AsrStartResult {
  requestId: string
  endpoint: string
}

interface AsrPartialPayload {
  requestId: string
  text: string
  isFinal: boolean
}

interface AsrErrorPayload {
  requestId: string
  message: string
}

interface AsrEndPayload {
  requestId: string
  reason: 'stopped' | 'cancelled' | 'error' | 'server-final' | 'closed'
}

interface ElectronAPI {
  ping: () => Promise<string>
  loadAvatar: (avatarId: string, projectId?: string) => Promise<AvatarConfig>

  // 会话管理
  createConversation: (title: string, avatarId: string, projectId?: string) => Promise<string>
  listProjectIds: (avatarId: string) => Promise<string[]>
  getConversations: (avatarId?: string) => Promise<Conversation[]>
  getConversation: (id: string) => Promise<Conversation | undefined>
  updateConversationTitle: (id: string, title: string) => Promise<void>
  deleteConversation: (id: string) => Promise<void>
  searchMessages: (query: string, avatarId?: string) => Promise<MessageSearchResult[]>

  // 消息管理
  saveMessage: (
    conversationId: string,
    role: 'user' | 'assistant' | 'tool',
    content: string,
    toolCallId?: string,
    imageUrls?: string[],
    reasoning?: string,
    uncertainMarkers?: string[],
    reconsiderMarkers?: string[],
    toolCallTimelineJson?: string,
    /** 可选外部 ID（hidden repair 闭环需要前后端 ID 一致；不传则 DB 自生成） */
    externalId?: string,
  ) => Promise<string>
  getMessages: (conversationId: string) => Promise<DbMessage[]>
  /** 只取会话最近 limit 条消息（按时间升序），用于只需尾部上下文的场景（如 @会话引用） */
  getRecentMessages: (conversationId: string, limit: number) => Promise<DbMessage[]>

  // 删除单条消息（v14，「重新生成」按钮专用）
  deleteMessage: (messageId: string) => Promise<number>

  // 原地更新单条消息 content（infographic hiddenRepair 修正回写专用，不动 role / 时间戳）
  updateMessageContent: (messageId: string, content: string) => Promise<number>

  // 答案缓存（v14，同问不同答修复）
  getCachedAnswer: (cacheKey: string) => Promise<{
    assistantContent: string
    reasoningContent: string | null
    model: string | null
  } | null>
  saveCachedAnswer: (params: {
    cacheKey: string
    avatarId: string
    conversationId: string
    userContent: string
    assistantContent: string
    reasoningContent?: string | null
    model?: string | null
  }) => Promise<void>
  deleteCachedAnswer: (cacheKey: string) => Promise<number>

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
  unlinkAttachmentsFromMessage: (messageId: string, conversationId: string) => Promise<number>
  /** 用系统默认应用打开附件本体（chip 点击时调用） */
  openAttachmentFile: (id: string) => Promise<{ ok: true; path: string }>

  // 文档生成（PDF / DOCX / Markdown）— 与 generate_document 工具配套（2026-05-08）
  /**
   * 用系统默认应用打开 generate_document/export_excel 生成的文档（FileCard 主按钮）。
   * 主进程按 (conversationId, filePath) 自查 conversation → workspace exports/ 路径，
   * 不接收任意绝对路径。filePath 必须以 'exports/' 开头。
   * 返回 shell.openPath 的错误描述：成功为 ''，失败为非空字符串。
   */
  openDocument: (conversationId: string, filePath: string) => Promise<string>
  /** 在系统资源管理器/Finder 中显示文档（FileCard 次按钮）。签名同 openDocument。 */
  showDocumentInFolder: (conversationId: string, filePath: string) => Promise<{ ok: boolean; error?: string }>

  // 工具结果 spool 查看入口（Stage 三 P2 范围外 2）
  listToolResults: (conversationId: string) => Promise<Array<{ file: string; size: number; mtime: number }>>
  openToolResultsFolder: (conversationId: string) => Promise<{ success: boolean; error?: string; path?: string }>
  readToolResult: (absPath: string, maxBytes?: number) => Promise<{ content: string; truncated: boolean; size: number }>

  // 设置管理
  getSetting: (key: string) => Promise<string | undefined>
  setSetting: (key: string, value: string) => Promise<void>
  asrStart: () => Promise<AsrStartResult>
  asrPushPcm: (pcm: Uint8Array) => Promise<{ ok: boolean }>
  asrStop: () => Promise<{ ok: boolean; ignored?: boolean }>
  asrCancel: () => Promise<{ ok: boolean; ignored?: boolean }>
  onAsrPartial: (callback: (payload: AsrPartialPayload) => void) => (() => void)
  onAsrError: (callback: (payload: AsrErrorPayload) => void) => (() => void)
  onAsrEnd: (callback: (payload: AsrEndPayload) => void) => (() => void)
  // claudeBridgeComplete 仅在 preview-preload.ts（persist:soul-preview）暴露，主渲染进程不再提供
  claudeBridgeGetLimits: () => Promise<{ perMinute: number; perFilePerMinute: number; perConversationTokens: number; perAvatarDailyTokens: number; maxInputChars: number }>
  claudeBridgeSetLimits: (limits: Record<string, number>) => Promise<{ perMinute: number; perFilePerMinute: number; perConversationTokens: number; perAvatarDailyTokens: number; maxInputChars: number }>
  claudeBridgeReadLog: (date?: string) => Promise<string>

  /** P0+ Anthropic 兼容 Proxy（主进程 HTTP → renderer sendMessage） */
  soulProxyApiSseWrite: (jobId: string, raw: string) => Promise<{ ok: boolean; error?: string }>
  soulProxyApiFinish: (jobId: string, payload: { error?: string; json?: unknown }) => Promise<{ ok: boolean; error?: string }>
  onSoulProxyApiRunRequest: (callback: (payload: unknown) => void) => (() => void)
  /** 生成随机 Proxy Bearer Token（写入设置前调用） */
  proxyApiGenerateToken: () => Promise<string>

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
  /** raw_file 缺失时的兜底：打开 knowledge 根下任意 .md 源文件（路径必须落在 knowledge 内） */
  openMdFile: (avatarId: string, mdRelPath: string) => Promise<{ ok: boolean; error?: string }>
  writeKnowledgeFile: (avatarId: string, relativePath: string, content: string) => Promise<void>
  searchKnowledge: (avatarId: string, query: string) => Promise<SearchResult[]>
  /** @excel 引用面板：列 knowledge/ 下 xlsx/xls 以及 _excel/*.json，绕开 getKnowledgeTree 的 _ 目录与 .md 限制 */
  listKnowledgeExcelFiles: (avatarId: string) => Promise<Array<{
    path: string
    name: string
    kind: 'xlsx' | 'excel-json'
  }>>
  // Lorebook keyword-trigger（SillyTavern 借鉴）：装配 prompt 时按关键词被动注入知识片段
  lorebookMatchAndBuild: (avatarId: string, userMessage: string) => Promise<{
    text: string
    charCount: number
    entries: Array<{ knowledge: string; hits: string[]; chars: number; truncated: boolean }>
  } | null>
  // v18 OpenClaw 借鉴：Standing Orders 永久工作流规则
  appendStandingOrder: (avatarId: string, order: string, source?: string) => Promise<{
    ok: boolean
    error?: string
    total?: number
  }>
  readStandingOrders: (avatarId: string) => Promise<string>
  countStandingOrders: (avatarId: string) => Promise<number>
  // v18 Letta .af 借鉴：soul-pack 可移植打包格式
  // 主进程主导文件对话框：renderer 不传任何路径，避免任意文件读写。
  // import 流：preview → token → import；token 5 分钟过期 + 一次性消费。
  soulPackExportToFile: (
    avatarId: string,
    options?: {
      includeMemory?: boolean
      includeLife?: boolean
      includeWiki?: boolean
      displayName?: string
      description?: string
      domain?: string
      createdBy?: string
    },
  ) => Promise<
    | { ok: true; outputFilePath: string; size: number; filesCount: number; binaryRefsCount: number; memoryIncluded: boolean }
    | { ok: false; canceled: true; error?: string }
  >
  soulPackImportFromFile: (
    token: string,
    options?: {
      targetAvatarId?: string
      force?: boolean
      restoreMemory?: boolean
    },
  ) => Promise<{
    avatarId: string
    filesWritten: string[]
    binaryRefsMissing: Array<{ path: string; sha256: string; size: number; mime?: string }>
    externalSkillsRequired: {
      shared: string[]
      community: Array<{ name: string; repo: string; ref: string; skills: string[] }>
    }
    memoryRestored: boolean
    warnings: string[]
  }>
  soulPackPreview: () => Promise<
    | {
      ok: true
      /** 一次性 path token，调 soulPackImportFromFile 时传回——同一 token 只能用一次 */
      token: string
      name: string
      display_name: string
      description: string
      domain?: string
      created_at: string
      created_by?: string
      pack_version: string
      schema_version: number
      filesCount: number
      binaryRefsCount: number
      memoryIncluded: boolean
      externalSkillsShared: number
      externalSkillsCommunity: number
      manifestSha256: string
    }
    | { ok: false; canceled: true; error?: string }
  >;
  // GAP7: 知识文件 CRUD
  createKnowledgeFile: (avatarId: string, relativePath: string, content?: string) => Promise<void>
  deleteKnowledgeFile: (avatarId: string, relativePath: string) => Promise<void>

  // 记忆管理（GAP2）
  readMemory: (avatarId: string) => Promise<string>
  /** 跨分身搜索 MEMORY.md（按行匹配） */
  searchMemory: (query: string) => Promise<Array<{ avatarId: string; lineNo: number; line: string; context: string }>>

  // Projects 任务包 CRUD（v18，#5 Step B1）
  projectsList: (avatarId?: string) => Promise<ProjectRow[]>
  projectsCreate: (avatarId: string, name: string, description?: string) => Promise<string>
  projectsUpdate: (id: string, patch: { name?: string; description?: string }) => Promise<void>
  projectsArchive: (id: string, archived: boolean) => Promise<void>
  projectsDelete: (id: string, options?: { migrateConversationsTo?: string }) => Promise<void>
  /** 读 projects/<pid>/knowledge/{README,notes}.md，缺失时回退老路径 knowledge/projects/<pid>/<file> */
  projectsReadContextFile: (avatarId: string, projectId: string, fileName: 'README.md' | 'notes.md') => Promise<string>
  writeMemory: (avatarId: string, content: string) => Promise<void>
  getMemoryStats: (avatarId: string) => Promise<{ chars: number; ratio: number; entries: number }>
  consolidateMemory: (avatarId: string, content: string, apiKey: string, baseUrl: string) => Promise<string>

  /**
   * v17 Phase 2a：触发一次对话情景记忆抽取。
   *
   * 主进程读 DB 拿 transcript，调注入的 LLM 生成 episode，写到
   * avatars/<id>/memory/episodes/<conv>.json。
   * 如果消息条数和已存在 episode 一致，跳过抽取（幂等）。
   */
  extractConversationEpisode: (
    avatarId: string,
    conversationId: string,
    apiKey: string,
    baseUrl: string,
  ) => Promise<{ ok: boolean; reason?: string; messageCount?: number }>

  /** v17 Phase 2a：列出某分身所有对话情景记忆（按 importance desc）。 */
  listConversationEpisodes: (avatarId: string) => Promise<ConversationEpisodeDTO[]>

  /** v17 Phase 2a：读取单条 episode，不存在返回 null。 */
  readConversationEpisode: (avatarId: string, conversationId: string) => Promise<ConversationEpisodeDTO | null>

  /** v17 Phase 2a：删除单条 episode（幂等）。 */
  deleteConversationEpisode: (avatarId: string, conversationId: string) => Promise<void>

  /**
   * v17 Phase 2c+：手动触发单分身的对话情景记忆遗忘计算。
   *
   * 与每日 0:35 cron 同一算法；返回更新统计（哪些条目 status 变化、各状态数量）。
   */
  applyEpisodeForgetting: (avatarId: string) => Promise<{
    total: number
    changed: number
    byStatus: { remembered: number; blurred: number; forgotten: number }
  }>
  readMemoryStore: (avatarId: string) => Promise<StructuredMemoryDocumentDTO>
  writeMemoryStore: (avatarId: string, doc: StructuredMemoryDocumentDTO) => Promise<void>

  /**
   * v17 事件日志：记忆更新（JSONL 升 event 日志方案 B）。
   *
   * chatStore 在 writeMemory 成功后调用本方法记录元信息（不含正文，避免单行过大；
   * 正文在 MEMORY.md）。用户手动 MemoryPanel 编辑不会调用本方法。
   */
  recordMemoryUpdateEvent: (
    conversationId: string,
    avatarId: string,
    payload: { updateCount: number; summaryPreview: string; totalByteSize: number; consolidated: boolean },
  ) => Promise<void>

  /**
   * v17 事件日志：会话模型切换。
   *
   * fromModel/toModel 为 null 表示"使用分身 default"。
   */
  recordModelSwitchEvent: (
    conversationId: string,
    fromModel: string | null,
    toModel: string | null,
  ) => Promise<void>

  /**
   * v17 事件日志：会话工具模式切换（Ask / Plan / Agent）。
   *
   * 与 syncConversationToolMode（门禁同步）不同，本 IPC 仅做日志，不改门禁状态。
   * chatStore.setMode 已对同档短路，调用本方法时一定是真实切换。
   */
  recordModeSwitchEvent: (
    conversationId: string,
    fromMode: 'agent' | 'plan' | 'ask',
    toMode: 'agent' | 'plan' | 'ask',
  ) => Promise<void>

  /**
   * v17 事件 viewer：读取会话 JSONL 事件流。
   *
   * 旧消息行（无 type）由 reader 归一化为 type='message'；
   * 损坏行计入 parseErrors，不污染 events 数组。文件不存在返回空。
   */
  readConversationEvents: (conversationId: string) => Promise<ReadEventsResult>

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
    /** 更新 manifest.json 中可编辑的人生设定 */
    updateManifest: (avatarId: string, patch: LifeManifestUpdate) => Promise<LifeManifest>

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
    /** 清空已生成事件并基于现有 manifest 从零重建 */
    resetAndRegenerate: (avatarId: string, params: LifeStartGenerationParams) => Promise<LifeStartGenerationResult>
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
  /** 读取分身的 defaultModel（avatar.config.json#defaultModel）；用于 LLMService dispatcher 路由 */
  getAvatarDefaultModel: (avatarId: string) => Promise<string | null>
  listExpertPacks: () => Promise<ExpertPack[]>
  installExpertPack: (packId: string) => Promise<ExpertPackInstallResult>
  isExpertPackInstalled: (packId: string) => Promise<boolean>
  /** 借鉴 Pi check-update：比对已安装分身的包版本与当前分发版本，判断是否有更新 */
  checkExpertPackUpdate: (avatarId: string) => Promise<ExpertPackUpdateCheck>
  /** 借鉴 Pi 可脚本化 seam：生成把分身暴露成 MCP server 的一键配置片段 */
  generateMcpSettingsSnippet: () => Promise<McpSettingsSnippet>
  getAvatarSoulIntro: (targetAvatarId: string) => Promise<string | null>
  /**
   * agent-runtime: Phase 1+5 观测接入。
   * 返回 system prompt 拆成 4 段后的 cacheable 占比；
   * 仅在 SOUL_USE_NEW_RUNTIME=true 时返回真实数据。
   */
  getAgentRuntimePromptCacheStats: (
    avatarId: string,
    parts: { stableSystemPrompt: string; dynamicSystemPrompt?: string },
    knowledgeHits?: string[]
  ) => Promise<{
    enabled: boolean
    avatarId: string
    totalChars: number
    cacheableChars: number
    cacheableRatio: number
    segmentCount: number
    segments: Array<{ id: string; version: string; cacheable: boolean; chars: number }>
  }>
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
  /** 列出 shared/skills/*.md，标注是否已在当前分身 skill-index.yaml 中引用 */
  getAvailableSharedSkills: (avatarId: string) => Promise<Array<{
    name: string
    filename: string
    description: string
    domain: string
    enabled: boolean
  }>>
  /** 启用 / 禁用公共技能：写入或删除分身 skill-index.yaml 中的 shared_skills 条目 */
  toggleSharedSkill: (avatarId: string, skillName: string, enable: boolean) => Promise<void>

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

  // 工具调用（GAP4）+ #7 Permission
  executeToolCall: (
    avatarId: string,
    conversationId: string,
    name: string,
    args: Record<string, unknown>,
    meta?: { trustTier?: 'ui' | 'proxy' },
  ) => Promise<{ content: string; error?: string }>
  syncConversationToolMode: (conversationId: string, mode: string) => Promise<void>

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

  // 用户自定义定时任务（#11 Scheduled Tasks，2026-05-09）
  scheduleList: (avatarId?: string) => Promise<ScheduleRow[]>
  scheduleGet: (id: string) => Promise<ScheduleRow | null>
  scheduleCreate: (input: NewScheduleInput) => Promise<ScheduleRow>
  scheduleUpdate: (id: string, patch: UpdateScheduleInput) => Promise<ScheduleRow>
  scheduleDelete: (id: string) => Promise<boolean>
  scheduleSetEnabled: (id: string, enabled: boolean) => Promise<ScheduleRow>
  scheduleTriggerNow: (id: string) => Promise<{ runId: number | null; conflict: boolean }>
  /** 计算 cron 表达式的下 n 次触发 Unix ms（UI 预览，不写 DB；n 自动 clamp 到 0-10） */
  scheduleGetNextRuns: (cronExpr: string, timezone: string, n: number) => Promise<number[]>
  scheduleListRuns: (scheduleId: string, limit?: number) => Promise<ScheduleRunRow[]>
  scheduleRecordRunFinish: (
    runId: number,
    status: 'success' | 'failed' | 'missed',
    opts?: { conversationId?: string | null; durationMs?: number; errorMessage?: string },
  ) => Promise<boolean>
  /** schedule 触发事件订阅（payload 字段见 schedule-trigger-handler.ScheduleTriggerPayload） */
  onScheduleTrigger: (callback: (payload: unknown) => void) => (() => void)

  // ─── Web Embed widget（#15 Web Embed widget，2026-05-09） ───────────────
  /** 列出 embeds，可按 avatarId / enabled 过滤 */
  embedList: (opts?: { avatarId?: string; enabled?: boolean }) => Promise<EmbedRow[]>
  /** 单个 embed，未找到返回 null */
  embedGet: (id: string) => Promise<EmbedRow | null>
  /** 创建 embed；origin 含 `*` 主进程 DAO 层抛错 */
  embedCreate: (input: NewEmbedInput) => Promise<EmbedRow>
  /** 部分更新 embed */
  embedUpdate: (id: string, input: UpdateEmbedInput) => Promise<EmbedRow>
  /** 删除 embed，返回是否真的删除（未找到返回 false） */
  embedDelete: (id: string) => Promise<boolean>
  /** 单独切换启停 */
  embedSetEnabled: (id: string, enabled: boolean) => Promise<EmbedRow>
  /** 当前 widget-server 监听端口（未启动返回 null） */
  embedGetPort: () => Promise<number | null>
  /** 显式启动 widget-server，并把 settings 标 enabled */
  embedServerStart: () => Promise<{ port: number }>
  /** 显式关闭 widget-server，并把 settings 标 disabled */
  embedServerStop: () => Promise<{ ok: true }>

  // ─── WebDAV 跨设备同步（#16 WebDAV cross-device sync，2026-05-09） ──────
  /** 读取当前 WebDAV 同步配置（不含密码明文） */
  syncGetConfig: () => Promise<WebDavSyncConfig>
  /** 部分更新 WebDAV 同步配置；写入后立即重注册 cron */
  syncSetConfig: (input: WebDavSetConfigInput) => Promise<WebDavSyncConfig>
  /** 清空 WebDAV 密码（不影响其他配置项） */
  syncClearCredentials: () => Promise<{ ok: true }>
  /** 测试 WebDAV 连接；input 为空时用持久化配置 */
  syncTestConnection: (input?: WebDavTestConnectionInput) => Promise<{ ok: boolean; reason?: string }>
  /** 立即触发一次备份；并发时主进程抛 sync_already_running */
  syncBackupNow: () => Promise<BackupNowResult>
  /** 列出远端可用备份（按 lastModified 倒序） */
  syncListRemoteBackups: () => Promise<RemoteBackupItem[]>
  /** 从远端备份恢复；ok=true 后主进程自动 relaunch + exit */
  syncRestoreFrom: (filename: string) => Promise<RestoreFromResult>
  /** 当前同步状态 + safeStorage 后端信息 */
  syncGetStatus: () => Promise<WebDavSyncStatus>
  /** 同步历史最近 limit 条（默认 30，最多 100） */
  syncListHistory: (opts?: {
    limit?: number
    direction?: 'backup' | 'restore'
    status?: 'success' | 'failed' | 'in_progress'
  }) => Promise<SyncHistoryRow[]>
  /** 清空同步历史；返回删除条数 */
  syncClearHistory: () => Promise<number>

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
  /** @web 引用：联网搜索（DuckDuckGo Instant Answer） */
  webSearch: (query: string) => Promise<{
    query: string
    results: Array<{ title: string; snippet: string; url: string }>
    abstract?: string
    abstractSource?: string
  }>
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
  /** 测试连接：临时 addServer 拿 snapshot 后立即 remove，不写 DB */
  mcpTestConnect: (config: McpServerInput) => Promise<McpServerSnapshot | null>
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

interface ExpertPack {
  id: string
  name: string
  description: string
  domain: string
  version: string
  author: string
  sourceAvatarId: string
  redline: string
  installable: boolean
  installed: boolean
  installedAvatarId?: string
  /** 头像图片：data URL（自定义上传）或 "default:<key>"（预置头像） */
  avatarImage?: string
  /** 借鉴 Pi 整包分发：发现用关键词（可选） */
  keywords?: string[]
  /** 借鉴 Pi 版本钉：包来源 git/npm（可选） */
  source?: string
  /** 借鉴 Pi 版本钉：来源 ref（tag/branch/commit，可选） */
  sourceRef?: string
}

interface ExpertPackInstallResult {
  avatarId: string
  installed: boolean
}

interface ExpertPackUpdateCheck {
  hasUpdate: boolean
  installedVersion: string | null
  availableVersion: string | null
  packId?: string
  reason?: 'not-an-expert-pack-avatar' | 'invalid-pack-id' | 'source-pack-not-found'
}

interface McpSettingsSnippet {
  serverName: string
  config: { command: string; args: string[]; env: Record<string, string> }
  /** 完整 mcpServers JSON 片段（可直接粘贴到 MCP 客户端 settings）。注意：含本机绝对路径，仅供本地配置用，禁止上报/上传 */
  json: string
  /** dev 环境是否解析到真实 bin 路径；false 时 json 内为占位路径，需用户在解包环境替换 */
  binResolved: boolean
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

interface AvatarQualityScoresReport {
  redline: { passRatePercent: number; passedCount: number; totalCount: number; averageScore: number } | null
  knowledgeCompleteness: { passRatePercent: number; passedCount: number; totalCount: number; averageScore: number } | null
  citationAccuracy: { passRatePercent: number; passedCount: number; totalCount: number; averageScore: number } | null
  otherRanCount: number
}

interface TestResult {
  caseId: string
  caseName: string
  category?: string
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
  qualityScores?: AvatarQualityScoresReport
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
  displayName: string
  personaName: string
  realNameConfirmed: boolean
  nameSource: LifePersonaNameSource
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

type LifePersonaNameSource = 'avatarName' | 'user' | 'aiSuggested'

interface LifeManifestUpdate {
  displayName?: string
  personaName?: string
  realNameConfirmed?: boolean
  nameSource?: LifePersonaNameSource
  gender?: string
  birthplace?: string
  familyBackground?: string
  personalityArc?: LifeArcItem[]
  professionalSpine?: LifeArcItem[]
  majorRelationships?: LifeRelationship[]
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
  /** 用户确认的人生经历使用名；未提供时默认 avatarName */
  personaName?: string
  /** personaName 是否已经用户确认 */
  personaNameConfirmed?: boolean
  /** personaName 来源 */
  nameSource?: LifePersonaNameSource
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
