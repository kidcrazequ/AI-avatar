// eslint-disable-next-line @typescript-eslint/triple-slash-reference -- 保留三斜线让 global 类型在 preload 沙箱生效
/// <reference path="../src/global.d.ts" />
import { contextBridge, ipcRenderer } from 'electron'

// BUG7 修复：移除 preload.ts 中的内联 ElectronAPI 接口声明，
// 统一以 src/global.d.ts 为权威类型定义。

contextBridge.exposeInMainWorld('electronAPI', {
  ping: () => ipcRenderer.invoke('ping'),
  loadAvatar: (avatarId: string, projectId?: string) => ipcRenderer.invoke('load-avatar', avatarId, projectId),

  // 会话管理
  createConversation: (title: string, avatarId: string, projectId?: string) =>
    ipcRenderer.invoke('create-conversation', title, avatarId, projectId),
  listProjectIds: (avatarId: string) => ipcRenderer.invoke('list-project-ids', avatarId),
  getConversations: (avatarId?: string) => ipcRenderer.invoke('get-conversations', avatarId),
  getConversation: (id: string) => ipcRenderer.invoke('get-conversation', id),
  updateConversationTitle: (id: string, title: string) => ipcRenderer.invoke('update-conversation-title', id, title),
  deleteConversation: (id: string) => ipcRenderer.invoke('delete-conversation', id),
  searchMessages: (query: string, avatarId?: string) => ipcRenderer.invoke('search-messages', query, avatarId),

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
    externalId?: string,
  ) =>
    ipcRenderer.invoke('save-message', conversationId, role, content, toolCallId, imageUrls, reasoning, uncertainMarkers, reconsiderMarkers, toolCallTimelineJson, externalId),
  getMessages: (conversationId: string) => ipcRenderer.invoke('get-messages', conversationId),
  forkConversation: (conversationId: string, messageId: string) => ipcRenderer.invoke('fork-conversation', conversationId, messageId),
  getConversationTree: (conversationId: string) => ipcRenderer.invoke('get-conversation-tree', conversationId),
  getRecentMessages: (conversationId: string, limit: number) => ipcRenderer.invoke('get-recent-messages', conversationId, limit),

  // 删除单条消息（v14，「重新生成」按钮专用）
  deleteMessage: (messageId: string) =>
    ipcRenderer.invoke('delete-message', messageId),

  // 原地更新单条消息 content（infographic hiddenRepair 修正回写专用，不动 role / 时间戳）
  updateMessageContent: (messageId: string, content: string) =>
    ipcRenderer.invoke('update-message-content', messageId, content),

  // 答案缓存（v14，同问不同答修复）
  getCachedAnswer: (cacheKey: string) =>
    ipcRenderer.invoke('answer-cache:get', cacheKey),
  saveCachedAnswer: (params: {
    cacheKey: string
    avatarId: string
    conversationId: string
    userContent: string
    assistantContent: string
    reasoningContent?: string | null
    model?: string | null
  }) => ipcRenderer.invoke('answer-cache:save', params),
  deleteCachedAnswer: (cacheKey: string) =>
    ipcRenderer.invoke('answer-cache:delete', cacheKey),

  // Agent 任务列表持久化（Stage 三 P2 范围外 1）
  saveAgentTasks: (conversationId: string, tasksJson: string) =>
    ipcRenderer.invoke('agent-tasks:save', conversationId, tasksJson),
  getAgentTasks: (conversationId: string) =>
    ipcRenderer.invoke('agent-tasks:get', conversationId),
  clearAgentTasks: (conversationId: string) =>
    ipcRenderer.invoke('agent-tasks:clear', conversationId),

  // 对话框附件（2026-05-01 对话框附件扩展）
  saveAttachment: (conversationId: string, name: string, base64Data: string, mime?: string) =>
    ipcRenderer.invoke('save-attachment', conversationId, name, base64Data, mime),
  getAttachmentMeta: (id: string) =>
    ipcRenderer.invoke('get-attachment-meta', id),
  listAttachments: (conversationId: string) =>
    ipcRenderer.invoke('list-attachments', conversationId),
  linkAttachmentToMessage: (messageId: string, attachmentIds: string[], conversationId: string) =>
    ipcRenderer.invoke('link-attachment-to-message', messageId, attachmentIds, conversationId),
  unlinkAttachmentsFromMessage: (messageId: string, conversationId: string) =>
    ipcRenderer.invoke('unlink-attachments-from-message', messageId, conversationId),
  openAttachmentFile: (id: string) =>
    ipcRenderer.invoke('open-attachment-file', id),

  // 文档相关（与 generate_document 工具配套）。
  // openDocument / showDocumentInFolder 接 (conversationId, filePath) —— 主进程
  // 反查 conversation 得 avatarId/projectId，自己 resolve 到 workspace exports/，
  // 完全不信任渲染层传入的绝对路径；filePath 必须以 'exports/' 开头。
  openDocument: (conversationId: string, filePath: string) =>
    ipcRenderer.invoke('document:open', conversationId, filePath),
  showDocumentInFolder: (conversationId: string, filePath: string) =>
    ipcRenderer.invoke('document:show-in-folder', conversationId, filePath),
  downloadDocument: (conversationId: string, filePath: string) =>
    ipcRenderer.invoke('document:download', conversationId, filePath),

  // 工具结果 spool 查看入口（Stage 三 P2 范围外 2）
  listToolResults: (conversationId: string) =>
    ipcRenderer.invoke('tool-results:list', conversationId),
  openToolResultsFolder: (conversationId: string) =>
    ipcRenderer.invoke('tool-results:open-folder', conversationId),
  readToolResult: (absPath: string, maxBytes?: number) =>
    ipcRenderer.invoke('tool-results:read', absPath, maxBytes),

  // 设置管理
  getSetting: (key: string) => ipcRenderer.invoke('get-setting', key),
  setSetting: (key: string, value: string) => ipcRenderer.invoke('set-setting', key, value),
  asrStart: () => ipcRenderer.invoke('asr:start'),
  asrPushPcm: (pcm: Uint8Array) => ipcRenderer.invoke('asr:push-pcm', pcm),
  asrStop: () => ipcRenderer.invoke('asr:stop'),
  asrCancel: () => ipcRenderer.invoke('asr:cancel'),
  onAsrPartial: (callback: (payload: AsrPartialPayload) => void) => {
    const handler = (_: unknown, payload: AsrPartialPayload) => callback(payload)
    ipcRenderer.on('asr:partial', handler)
    return () => { ipcRenderer.removeListener('asr:partial', handler) }
  },
  onAsrError: (callback: (payload: AsrErrorPayload) => void) => {
    const handler = (_: unknown, payload: AsrErrorPayload) => callback(payload)
    ipcRenderer.on('asr:error', handler)
    return () => { ipcRenderer.removeListener('asr:error', handler) }
  },
  onAsrEnd: (callback: (payload: AsrEndPayload) => void) => {
    const handler = (_: unknown, payload: AsrEndPayload) => callback(payload)
    ipcRenderer.on('asr:end', handler)
    return () => { ipcRenderer.removeListener('asr:end', handler) }
  },
  // 注意：window.claude.complete 桥接走 preview-preload.ts（persist:soul-preview 分区），
  // 不在主渲染进程暴露 claudeBridgeComplete——主聊天页 / XSS 无法触达 chat_api_key 背后的
  // LLM bridge（主进程同时按 session 白名单兜底校验）。下方仅保留设置面板用的限额/日志查询。
  claudeBridgeGetLimits: () => ipcRenderer.invoke('claudebridge:get-limits'),
  claudeBridgeSetLimits: (limits: Record<string, number>) => ipcRenderer.invoke('claudebridge:set-limits', limits),
  claudeBridgeReadLog: (date?: string) => ipcRenderer.invoke('claudebridge:read-log', date),

  soulProxyApiSseWrite: (jobId: string, raw: string) =>
    ipcRenderer.invoke('soul-proxy-api:sse-write', jobId, raw),
  soulProxyApiFinish: (jobId: string, payload: { error?: string; json?: unknown }) =>
    ipcRenderer.invoke('soul-proxy-api:finish', jobId, payload),
  onSoulProxyApiRunRequest: (callback: (payload: unknown) => void) => {
    const handler = (_: unknown, payload: unknown) => callback(payload)
    ipcRenderer.on('soul-proxy-api:run-request', handler)
    return () => { ipcRenderer.removeListener('soul-proxy-api:run-request', handler) }
  },
  proxyApiGenerateToken: () => ipcRenderer.invoke('proxy-api:generate-token'),

  // Preview pane (L3 Phase C/D/G)
  previewSetBounds: (bounds: { x: number; y: number; width: number; height: number }) =>
    ipcRenderer.invoke('preview:set-bounds', bounds),
  previewSetInspector: (target: 'user' | 'hidden', enabled: boolean) =>
    ipcRenderer.invoke('preview:set-inspector', target, enabled),
  previewSetUserVisible: (visible: boolean) =>
    ipcRenderer.invoke('preview:set-user-visible', visible),
  previewApplyTweaks: (conversationId: string, params: { path: string; blockId: string; values: Record<string, unknown> }) =>
    ipcRenderer.invoke('preview:apply-tweaks', conversationId, params),
  onPreviewBlockSelected: (callback: (payload: unknown) => void) => {
    const handler = (_: unknown, payload: unknown) => callback(payload)
    ipcRenderer.on('preview:block-selected', handler)
    return () => { ipcRenderer.removeListener('preview:block-selected', handler) }
  },
  onPreviewTweaksAvailable: (callback: (payload: unknown) => void) => {
    const handler = (_: unknown, payload: unknown) => callback(payload)
    ipcRenderer.on('preview:tweaks-available', handler)
    return () => { ipcRenderer.removeListener('preview:tweaks-available', handler) }
  },
  onPreviewTweaksSave: (callback: (payload: unknown) => void) => {
    const handler = (_: unknown, payload: unknown) => callback(payload)
    ipcRenderer.on('preview:tweaks-save', handler)
    return () => { ipcRenderer.removeListener('preview:tweaks-save', handler) }
  },
  onPreviewSizeChanged: (callback: (payload: { width: number; height: number }) => void) => {
    const handler = (_: unknown, payload: { width: number; height: number }) => callback(payload)
    ipcRenderer.on('preview:size-changed', handler)
    return () => { ipcRenderer.removeListener('preview:size-changed', handler) }
  },
  onPreviewLoaded: (callback: (payload: { conversationId: string; path: string; done?: boolean }) => void) => {
    const handler = (_: unknown, payload: { conversationId: string; path: string; done?: boolean }) => callback(payload)
    ipcRenderer.on('preview:loaded', handler)
    return () => { ipcRenderer.removeListener('preview:loaded', handler) }
  },
  onVerifierResult: (callback: (payload: unknown) => void) => {
    const handler = (_: unknown, payload: unknown) => callback(payload)
    ipcRenderer.on('verifier:result', handler)
    return () => { ipcRenderer.removeListener('verifier:result', handler) }
  },

  // Chat side cards (L3 Phase J'/G/I/K)
  onChatDownloadCard: (callback: (payload: { conversationId: string; relativePath: string; absolutePath: string; sizeBytes: number; mimeHint: string }) => void) => {
    const handler = (_: unknown, payload: { conversationId: string; relativePath: string; absolutePath: string; sizeBytes: number; mimeHint: string }) => callback(payload)
    ipcRenderer.on('chat:download-card', handler)
    return () => { ipcRenderer.removeListener('chat:download-card', handler) }
  },
  onChatFormRequest: (callback: (payload: { conversationId: string; payload: unknown }) => void) => {
    const handler = (_: unknown, payload: { conversationId: string; payload: unknown }) => callback(payload)
    ipcRenderer.on('chat:form-request', handler)
    return () => { ipcRenderer.removeListener('chat:form-request', handler) }
  },
  onChatRequestGithubPat: (callback: (payload: { conversationId: string }) => void) => {
    const handler = (_: unknown, payload: { conversationId: string }) => callback(payload)
    ipcRenderer.on('chat:request-github-pat', handler)
    return () => { ipcRenderer.removeListener('chat:request-github-pat', handler) }
  },
  onChatCanvaUploadCard: (callback: (payload: { conversationId: string; exportPath?: string }) => void) => {
    const handler = (_: unknown, payload: { conversationId: string; exportPath?: string }) => callback(payload)
    ipcRenderer.on('chat:canva-upload-card', handler)
    return () => { ipcRenderer.removeListener('chat:canva-upload-card', handler) }
  },
  onChatSnipAdded: (callback: (payload: { conversationId: string; fromId: string; toId: string }) => void) => {
    const handler = (_: unknown, payload: { conversationId: string; fromId: string; toId: string }) => callback(payload)
    ipcRenderer.on('chat:snip-added', handler)
    return () => { ipcRenderer.removeListener('chat:snip-added', handler) }
  },
  /**
   * 九层重构 #12 ask_question：主进程在收到 LLM 调用 ask_question 后推送，
   * ChatWindow 监听并渲染 AskQuestionCard。
   */
  onChatAskQuestion: (callback: (payload: { conversationId: string; question: string; options: string[]; allowCustom: boolean }) => void) => {
    const handler = (_: unknown, payload: { conversationId: string; question: string; options: string[]; allowCustom: boolean }) => callback(payload)
    ipcRenderer.on('chat:ask-question', handler)
    return () => { ipcRenderer.removeListener('chat:ask-question', handler) }
  },
  /**
   * 九层重构 #17 switch_mode：主进程在 LLM 调用 switch_mode 后广播，
   * chatStore 监听并更新 mode 字段，UI 自动刷新模式徽章。
   */
  onChatModeChanged: (callback: (payload: { conversationId: string; mode: 'agent' | 'plan' | 'ask'; reason?: string }) => void) => {
    const handler = (_: unknown, payload: { conversationId: string; mode: 'agent' | 'plan' | 'ask'; reason?: string }) => callback(payload)
    ipcRenderer.on('chat:mode-changed', handler)
    return () => { ipcRenderer.removeListener('chat:mode-changed', handler) }
  },

  // GitHub connector (L3 Phase K)
  githubStatus: () => ipcRenderer.invoke('github:status'),
  githubConnect: (token: string) => ipcRenderer.invoke('github:connect', token),
  githubDisconnect: () => ipcRenderer.invoke('github:disconnect'),

  // Snip context manager (L3 Phase I)
  snipList: (conversationId: string) => ipcRenderer.invoke('snip:list', conversationId),
  snipClear: (conversationId: string) => ipcRenderer.invoke('snip:clear', conversationId),
  snipNextMsgId: (conversationId: string) => ipcRenderer.invoke('snip:next-msg-id', conversationId),
  snipHydrate: (conversationId: string) => ipcRenderer.invoke('snip:hydrate', conversationId),

  // Workspace（L3 Phase A）
  workspaceStat: (conversationId: string, relativePath: string) =>
    ipcRenderer.invoke('workspace:stat', conversationId, relativePath),
  workspaceRead: (conversationId: string, relativePath: string) =>
    ipcRenderer.invoke('workspace:read', conversationId, relativePath),
  workspaceWrite: (conversationId: string, relativePath: string, content: string) =>
    ipcRenderer.invoke('workspace:write', conversationId, relativePath, content),
  workspaceList: (conversationId: string, relativePath = '.', depth = 1) =>
    ipcRenderer.invoke('workspace:list', conversationId, relativePath, depth),
  workspaceCopy: (conversationId: string, src: string, dest: string, move = false) =>
    ipcRenderer.invoke('workspace:copy', conversationId, src, dest, move),
  workspaceMove: (conversationId: string, src: string, dest: string) =>
    ipcRenderer.invoke('workspace:move', conversationId, src, dest),
  workspaceDelete: (conversationId: string, relativePath: string) =>
    ipcRenderer.invoke('workspace:delete', conversationId, relativePath),
  workspaceGrep: (conversationId: string, relativePath: string, pattern: string) =>
    ipcRenderer.invoke('workspace:grep', conversationId, relativePath, pattern),

  // 知识库管理
  getKnowledgeTree: (avatarId: string) => ipcRenderer.invoke('get-knowledge-tree', avatarId),
  readKnowledgeFile: (avatarId: string, relativePath: string) => ipcRenderer.invoke('read-knowledge-file', avatarId, relativePath),
  /** 原始源文件溯源：把 knowledge/xxx.md 解析成 _raw/xxx.pdf 的元信息（找不到返回 null） */
  resolveRawFile: (avatarId: string, mdRelativePath: string) =>
    ipcRenderer.invoke('knowledge:resolve-raw-file', avatarId, mdRelativePath),
  /** 原始源文件溯源：用系统默认应用打开 _raw/ 下的原始文件（路径越界由主进程拒绝） */
  openRawFile: (avatarId: string, rawRelPath: string) =>
    ipcRenderer.invoke('knowledge:open-raw-file', avatarId, rawRelPath),
  /** markdown 源文件兜底：raw_file 缺失时让 source citation 仍能跳转到 .md（系统默认 app 打开） */
  openMdFile: (avatarId: string, mdRelPath: string) =>
    ipcRenderer.invoke('knowledge:open-md-file', avatarId, mdRelPath),
  writeKnowledgeFile: (avatarId: string, relativePath: string, content: string) => ipcRenderer.invoke('write-knowledge-file', avatarId, relativePath, content),
  searchKnowledge: (avatarId: string, query: string) => ipcRenderer.invoke('search-knowledge', avatarId, query),
  /** @excel 引用面板用——getKnowledgeTree 跳过 _ 目录且只收 .md，这里专门列 xlsx + _excel/*.json */
  listKnowledgeExcelFiles: (avatarId: string) =>
    ipcRenderer.invoke('knowledge:list-excel-files', avatarId),
  // Lorebook keyword-trigger（SillyTavern 借鉴）：在 chatStore 装配 prompt 时调，
  // 命中 _triggers.yaml 配置的关键词后返回注入文本；未配置/未命中返回 null
  lorebookMatchAndBuild: (avatarId: string, userMessage: string) =>
    ipcRenderer.invoke('lorebook:match-and-build', avatarId, userMessage),
  // v18 Letta .af 借鉴：soul-pack 可移植打包
  // export/preview 走主进程的 showSaveDialog / showOpenDialog——渲染层不传路径，
  // 完全不持有文件系统句柄。import 需要先 preview 拿一次性 token 才能用。
  soulPackExportToFile: (avatarId: string, options?: { includeMemory?: boolean; includeLife?: boolean; includeWiki?: boolean; displayName?: string; description?: string; domain?: string; createdBy?: string }) =>
    ipcRenderer.invoke('soul-pack:export-to-file', avatarId, options),
  soulPackImportFromFile: (token: string, options?: { targetAvatarId?: string; force?: boolean; restoreMemory?: boolean; mode?: 'replace' | 'update' }) =>
    ipcRenderer.invoke('soul-pack:import-from-file', token, options),
  soulPackPreview: () =>
    ipcRenderer.invoke('soul-pack:preview'),

  // v18 OpenClaw 借鉴：Standing Orders 永久规则
  appendStandingOrder: (avatarId: string, order: string, source?: string) =>
    ipcRenderer.invoke('standing-orders:append', avatarId, order, source),
  readStandingOrders: (avatarId: string) =>
    ipcRenderer.invoke('standing-orders:read', avatarId),
  countStandingOrders: (avatarId: string) =>
    ipcRenderer.invoke('standing-orders:count', avatarId),
  palace: {
    getOverview: (avatarId: string) => ipcRenderer.invoke('palace:get-overview', avatarId),
    addCommitment: (avatarId: string, input: {
      title: string
      promise: string
      counterparty?: string
      direction?: string
      dueAt?: string
    }) => ipcRenderer.invoke('palace:add-commitment', avatarId, input),
    updateCommitment: (avatarId: string, id: string, patch: { status?: string; appendNote?: string }) =>
      ipcRenderer.invoke('palace:update-commitment', avatarId, id, patch),
    addInboxItem: (avatarId: string, input: {
      title: string
      content: string
      kind?: string
      target?: string
      source?: string
      confidence?: number
      tags?: string[]
    }) => ipcRenderer.invoke('palace:add-inbox-item', avatarId, input),
    updateInboxItem: (avatarId: string, id: string, patch: { status?: string; target?: string | null }) =>
      ipcRenderer.invoke('palace:update-inbox-item', avatarId, id, patch),
    writeRoom: (avatarId: string, input: unknown) =>
      ipcRenderer.invoke('palace:write-room', avatarId, input),
    deleteRoom: (avatarId: string, roomId: string) =>
      ipcRenderer.invoke('palace:delete-room', avatarId, roomId),
    listDirFiles: (avatarId: string, dir: string) =>
      ipcRenderer.invoke('palace:list-dir-files', avatarId, dir),
    readDirFile: (avatarId: string, dir: string, name: string) =>
      ipcRenderer.invoke('palace:read-dir-file', avatarId, dir, name),
    writeDirFile: (avatarId: string, dir: string, name: string, content: string) =>
      ipcRenderer.invoke('palace:write-dir-file', avatarId, dir, name, content),
    deleteDirFile: (avatarId: string, dir: string, name: string) =>
      ipcRenderer.invoke('palace:delete-dir-file', avatarId, dir, name),
    reveal: (avatarId: string) => ipcRenderer.invoke('palace:reveal', avatarId),
  },
  // 「职场」可用性（契约定名，勿改）：档案写入 + 导航角标 pending 数
  writePalaceProfile: (avatarId: string, target: 'profile' | 'company', content: string) =>
    ipcRenderer.invoke('palace:write-profile', avatarId, target, content),
  getPalacePendingCount: (avatarId: string) =>
    ipcRenderer.invoke('palace:pending-count', avatarId),
  // GAP7: 知识文件 CRUD（之前缺失）
  createKnowledgeFile: (avatarId: string, relativePath: string, content?: string) => ipcRenderer.invoke('create-knowledge-file', avatarId, relativePath, content),
  deleteKnowledgeFile: (avatarId: string, relativePath: string) => ipcRenderer.invoke('delete-knowledge-file', avatarId, relativePath),

  // 记忆管理（GAP2）
  readMemory: (avatarId: string) => ipcRenderer.invoke('read-memory', avatarId),
  searchMemory: (query: string) => ipcRenderer.invoke('search-memory', query),

  // Projects 任务包 CRUD（v18，#5 Step B1）
  projectsList: (avatarId?: string) => ipcRenderer.invoke('projects:list', avatarId),
  projectsCreate: (avatarId: string, name: string, description?: string) =>
    ipcRenderer.invoke('projects:create', avatarId, name, description),
  projectsUpdate: (id: string, patch: { name?: string; description?: string }) =>
    ipcRenderer.invoke('projects:update', id, patch),
  projectsArchive: (id: string, archived: boolean) =>
    ipcRenderer.invoke('projects:archive', id, archived),
  projectsDelete: (id: string, options?: { migrateConversationsTo?: string }) =>
    ipcRenderer.invoke('projects:delete', id, options),
  /** 读取 projects/<pid>/knowledge/{README,notes}.md（带老路径 fallback） */
  projectsReadContextFile: (avatarId: string, projectId: string, fileName: 'README.md' | 'notes.md') =>
    ipcRenderer.invoke('projects:read-context-file', avatarId, projectId, fileName),
  writeMemory: (avatarId: string, content: string) => ipcRenderer.invoke('write-memory', avatarId, content),
  getMemoryStats: (avatarId: string) => ipcRenderer.invoke('get-memory-stats', avatarId),
  consolidateMemory: (avatarId: string, content: string, apiKey: string, baseUrl: string) =>
    ipcRenderer.invoke('consolidate-memory', avatarId, content, apiKey, baseUrl),
  // A4：N 轮一次后台记忆复盘（回复送达后 fire-and-forget，未达轮数快速返回）
  runMemoryReview: (avatarId: string, conversationId: string, apiKey: string, baseUrl: string) =>
    ipcRenderer.invoke('run-memory-review', avatarId, conversationId, apiKey, baseUrl),

  // v17 Phase 2a：对话情景记忆
  extractConversationEpisode: (avatarId: string, conversationId: string, apiKey: string, baseUrl: string) =>
    ipcRenderer.invoke('extract-conversation-episode', avatarId, conversationId, apiKey, baseUrl),
  listConversationEpisodes: (avatarId: string) =>
    ipcRenderer.invoke('list-conversation-episodes', avatarId),
  readConversationEpisode: (avatarId: string, conversationId: string) =>
    ipcRenderer.invoke('read-conversation-episode', avatarId, conversationId),
  deleteConversationEpisode: (avatarId: string, conversationId: string) =>
    ipcRenderer.invoke('delete-conversation-episode', avatarId, conversationId),
  applyEpisodeForgetting: (avatarId: string) =>
    ipcRenderer.invoke('apply-episode-forgetting', avatarId),
  readMemoryStore: (avatarId: string) => ipcRenderer.invoke('read-memory-store', avatarId),
  writeMemoryStore: (avatarId: string, doc: StructuredMemoryDocumentDTO) =>
    ipcRenderer.invoke('write-memory-store', avatarId, doc),

  // v17 事件日志（JSONL 升 event 日志方案 B）：记忆更新 + 模型切换
  recordMemoryUpdateEvent: (
    conversationId: string,
    avatarId: string,
    payload: { updateCount: number; summaryPreview: string; totalByteSize: number; consolidated: boolean },
  ) => ipcRenderer.invoke('record-memory-update-event', conversationId, avatarId, payload),
  recordModelSwitchEvent: (
    conversationId: string,
    fromModel: string | null,
    toModel: string | null,
  ) => ipcRenderer.invoke('record-model-switch-event', conversationId, fromModel, toModel),
  recordModeSwitchEvent: (
    conversationId: string,
    fromMode: 'agent' | 'plan' | 'ask',
    toMode: 'agent' | 'plan' | 'ask',
  ) => ipcRenderer.invoke('record-mode-switch-event', conversationId, fromMode, toMode),
  readConversationEvents: (conversationId: string) =>
    ipcRenderer.invoke('read-conversation-events', conversationId),

  // 用户画像管理（Feature 3）
  readUserProfile: (avatarId: string) => ipcRenderer.invoke('read-user-profile', avatarId),
  writeUserProfile: (avatarId: string, content: string) => ipcRenderer.invoke('write-user-profile', avatarId, content),

  // ─── 人生经历（Avatar Life Experience，Phase 0+1） ──────────────────────────
  // namespace 风格便于 Phase 2/4 持续扩展（setTimeScale / advanceNow 等）
  life: {
    // Phase 0：读 / 删
    getManifest: (avatarId: string) => ipcRenderer.invoke('life:get-manifest', avatarId),
    listTimeline: (avatarId: string) => ipcRenderer.invoke('life:list-timeline', avatarId),
    readEpisode: (avatarId: string, episodeId: string) =>
      ipcRenderer.invoke('life:read-episode', avatarId, episodeId),
    getProgress: (avatarId: string) => ipcRenderer.invoke('life:get-progress', avatarId),
    readConsolidated: (avatarId: string) => ipcRenderer.invoke('life:read-consolidated', avatarId),
    deleteEpisode: (avatarId: string, episodeId: string) =>
      ipcRenderer.invoke('life:delete-episode', avatarId, episodeId),
    updateManifest: (avatarId: string, patch: LifeManifestUpdate) =>
      ipcRenderer.invoke('life:update-manifest', avatarId, patch),

    // Phase 1：生成器控制 + 进度订阅
    startGeneration: (avatarId: string, params: LifeStartGenerationParams) =>
      ipcRenderer.invoke('life:start-generation', avatarId, params),
    cancelGeneration: (avatarId: string) =>
      ipcRenderer.invoke('life:cancel-generation', avatarId),
    retryGeneration: (avatarId: string, params: LifeStartGenerationParams) =>
      ipcRenderer.invoke('life:retry-generation', avatarId, params),
    resetAndRegenerate: (avatarId: string, params: LifeStartGenerationParams) =>
      ipcRenderer.invoke('life:reset-and-regenerate', avatarId, params),
    /**
     * 订阅生成进度推送。
     * @returns unsubscribe 函数；调用即移除监听器
     */
    onProgress: (callback: (payload: LifeProgressPayload) => void) => {
      const listener = (_: unknown, payload: LifeProgressPayload) => callback(payload)
      ipcRenderer.on('life:progress', listener)
      return () => ipcRenderer.removeListener('life:progress', listener)
    },

    // Phase 2：持续生长控制
    /** 修改单分身 timeScale（0/1/12/52） */
    setTimeScale: (avatarId: string, timeScale: number) =>
      ipcRenderer.invoke('life:set-time-scale', avatarId, timeScale),
    /** 开关单分身的持续生长 */
    toggleGrowth: (avatarId: string, enabled: boolean) =>
      ipcRenderer.invoke('life:toggle-growth', avatarId, enabled),
    /** 调试用：立即推进单分身一次（同步等待结果） */
    advanceNow: (avatarId: string) =>
      ipcRenderer.invoke('life:advance-now', avatarId),
  },

  // ─── 知识库精读（deep-read）──────────────────────────────────────────────
  // namespace 风格同 life；长任务 fire-and-forget + 进度订阅 + 拉式状态
  deepRead: {
    prepare: (avatarId: string, filePath: string) =>
      ipcRenderer.invoke('deep-read:prepare', avatarId, filePath),
    start: (avatarId: string, params: DeepReadStartParams) =>
      ipcRenderer.invoke('deep-read:start', avatarId, params),
    cancel: (avatarId: string) => ipcRenderer.invoke('deep-read:cancel', avatarId),
    getStatus: (avatarId: string) => ipcRenderer.invoke('deep-read:get-status', avatarId),
    /**
     * 订阅精读进度推送。
     * @returns unsubscribe 函数；调用即移除监听器
     */
    onProgress: (callback: (payload: DeepReadProgressPayload) => void) => {
      const listener = (_: unknown, payload: DeepReadProgressPayload) => callback(payload)
      ipcRenderer.on('deep-read:progress', listener)
      return () => ipcRenderer.removeListener('deep-read:progress', listener)
    },
  },

  // 人格管理
  readSoul: (avatarId: string) => ipcRenderer.invoke('read-soul', avatarId),
  writeSoul: (avatarId: string, content: string) => ipcRenderer.invoke('write-soul', avatarId, content),

  // 分身管理
  listAvatars: () => ipcRenderer.invoke('list-avatars'),
  /** 读取分身的 defaultModel（avatar.config.json#defaultModel）；用于 LLMService dispatcher 路由 */
  getAvatarDefaultModel: (avatarId: string) => ipcRenderer.invoke('get-avatar-default-model', avatarId),
  listExpertPacks: () => ipcRenderer.invoke('expert-packs:list'),
  installExpertPack: (packId: string) => ipcRenderer.invoke('expert-packs:install', packId),
  isExpertPackInstalled: (packId: string) => ipcRenderer.invoke('expert-packs:is-installed', packId),
  checkExpertPackUpdate: (avatarId: string) => ipcRenderer.invoke('expert-packs:check-update', avatarId),
  generateMcpSettingsSnippet: () => ipcRenderer.invoke('mcp:generate-settings-snippet'),
  getAvatarSoulIntro: (targetAvatarId: string) => ipcRenderer.invoke('get-avatar-soul-intro', targetAvatarId),
  /**
   * agent-runtime: Phase 1+5 观测接入。返回当前 system prompt 拆成 4 段后的
   * cacheable 占比；仅在 SOUL_USE_NEW_RUNTIME=true 时返回真实数据。
   */
  getAgentRuntimePromptCacheStats: (
    avatarId: string,
    parts: { stableSystemPrompt: string; dynamicSystemPrompt?: string },
    knowledgeHits?: string[]
  ) => ipcRenderer.invoke('agent-runtime:prompt-cache-stats', avatarId, parts, knowledgeHits),
  agentTraceStart: (input: AgentRunTraceStartInput) =>
    ipcRenderer.invoke('agent-runtime:trace-start', input),
  agentTraceEvent: (runId: string, kind: AgentRunTraceEventKind, payload?: Record<string, unknown>) =>
    ipcRenderer.invoke('agent-runtime:trace-event', runId, { kind, payload }),
  agentTraceFinish: (runId: string, status: 'done' | 'error', payload?: Record<string, unknown>) =>
    ipcRenderer.invoke('agent-runtime:trace-finish', runId, status, payload),
  agentGatewayThread: (conversationId: string) =>
    ipcRenderer.invoke('agent-runtime:gateway-thread', conversationId),
  agentGatewayRun: (conversationId: string, runId: string) =>
    ipcRenderer.invoke('agent-runtime:gateway-run', conversationId, runId),
  agentGatewayRunEvents: (conversationId: string, runId: string, limit?: number) =>
    ipcRenderer.invoke('agent-runtime:gateway-run-events', conversationId, runId, limit),
  agentGatewayArtifacts: (conversationId: string) =>
    ipcRenderer.invoke('agent-runtime:gateway-artifacts', conversationId),
  agentGatewayAvatars: () =>
    ipcRenderer.invoke('agent-runtime:gateway-avatars'),
  agentGatewayAvatarCapabilities: (avatarId: string) =>
    ipcRenderer.invoke('agent-runtime:gateway-avatar-capabilities', avatarId),
  createAgentSkillDraft: (input: AgentSkillDraftCreateInput) =>
    ipcRenderer.invoke('agent-runtime:create-skill-draft', input),
  createAvatar: (id: string, soulContent: string, skills: string[], knowledgeFiles: Array<{ name: string; content: string }>) =>
    ipcRenderer.invoke('create-avatar', id, soulContent, skills, knowledgeFiles),
  writeSkillFile: (avatarId: string, fileName: string, content: string) =>
    ipcRenderer.invoke('write-skill-file', avatarId, fileName, content),
  deleteAvatar: (id: string) => ipcRenderer.invoke('delete-avatar', id),
  saveAvatarImage: (avatarId: string, dataUrl: string) =>
    ipcRenderer.invoke('save-avatar-image', avatarId, dataUrl),
  getAvatarImage: (avatarId: string) =>
    ipcRenderer.invoke('get-avatar-image', avatarId),

  // 测试管理
  getTestCases: (avatarId: string) => ipcRenderer.invoke('get-test-cases', avatarId),
  getTestCase: (avatarId: string, caseId: string) => ipcRenderer.invoke('get-test-case', avatarId, caseId),
  createTestCase: (avatarId: string, testCase: Omit<TestCase, 'filePath'>) => ipcRenderer.invoke('create-test-case', avatarId, testCase),
  deleteTestCase: (avatarId: string, caseId: string) => ipcRenderer.invoke('delete-test-case', avatarId, caseId),
  saveTestReport: (avatarId: string, report: TestReport) => ipcRenderer.invoke('save-test-report', avatarId, report),
  getLatestReport: (avatarId: string) => ipcRenderer.invoke('get-latest-report', avatarId),
  getReportList: (avatarId: string) => ipcRenderer.invoke('get-report-list', avatarId),
  // BUG6 修复：移除虚假的 onProgress 回调参数
  runTests: (avatarId: string, caseIds: string[]) => ipcRenderer.invoke('run-tests', avatarId, caseIds),

  // 技能管理
  getSkills: (avatarId: string) => ipcRenderer.invoke('get-skills', avatarId),
  getSkill: (avatarId: string, skillId: string) => ipcRenderer.invoke('get-skill', avatarId, skillId),
  updateSkill: (avatarId: string, skillId: string, content: string) => ipcRenderer.invoke('update-skill', avatarId, skillId, content),
  toggleSkill: (avatarId: string, skillId: string, enabled: boolean) => ipcRenderer.invoke('toggle-skill', avatarId, skillId, enabled),
  createSkill: (avatarId: string, skillId: string, content: string) => ipcRenderer.invoke('create-skill', avatarId, skillId, content),
  deleteSkill: (avatarId: string, skillId: string) => ipcRenderer.invoke('delete-skill', avatarId, skillId),
  generateSkillDraft: (description: string) => ipcRenderer.invoke('generate-skill-draft', description),
  // 工作流技能沉淀（对话 → 草稿 → 晋升）
  distillWorkflowSkillDraft: (input: { avatarId: string; conversationId: string; title?: string }) =>
    ipcRenderer.invoke('skill-draft:distill', input),
  listSkillDrafts: (avatarId: string) => ipcRenderer.invoke('skill-draft:list', avatarId),
  promoteSkillDraft: (input: { avatarId: string; filename: string; skillId?: string }) =>
    ipcRenderer.invoke('skill-draft:promote', input),
  deleteSkillDraft: (input: { avatarId: string; filename: string }) =>
    ipcRenderer.invoke('skill-draft:delete', input),
  // 公共技能浏览 + 一键启用（shared/skills/*.md ↔ skill-index.yaml）
  getAvailableSharedSkills: (avatarId: string) => ipcRenderer.invoke('get-available-shared-skills', avatarId),
  toggleSharedSkill: (avatarId: string, skillName: string, enable: boolean) => ipcRenderer.invoke('toggle-shared-skill', avatarId, skillName, enable),

  // ─── 社区技能管理 ─────────────────────────────────────────────
  communityListSources: () => ipcRenderer.invoke('community:list-sources'),
  communityAddSource: (source: { name: string; repo: string; ref: string; path?: string; file?: string; skills?: string[] }) =>
    ipcRenderer.invoke('community:add-source', source),
  communityRemoveSource: (name: string) => ipcRenderer.invoke('community:remove-source', name),
  communitySync: () => ipcRenderer.invoke('community:sync'),
  onCommunitySyncProgress: (callback: (progress: { sourceName: string; phase: string; detail?: string; total: number; current: number }) => void) => {
    const handler = (_: unknown, progress: { sourceName: string; phase: string; detail?: string; total: number; current: number }) => callback(progress)
    ipcRenderer.on('community:sync-progress', handler)
    return () => { ipcRenderer.removeListener('community:sync-progress', handler) }
  },
  communityListInstalled: () => ipcRenderer.invoke('community:list-installed'),
  communityEnableForAvatar: (avatarId: string, skillName: string, packName: string) =>
    ipcRenderer.invoke('community:enable-for-avatar', avatarId, skillName, packName),
  communityDisableForAvatar: (avatarId: string, skillName: string) =>
    ipcRenderer.invoke('community:disable-for-avatar', avatarId, skillName),

  // ─── skills.sh 技能市场 ───────────────────────────────────────
  skillsShSearch: (query: string, limit?: number) => ipcRenderer.invoke('skills-sh:search', query, limit),
  skillsShInstall: (avatarId: string, result: { source: string; skillId: string; id?: string }, options?: { overwrite?: boolean }) =>
    ipcRenderer.invoke('skills-sh:install', avatarId, result, options),
  skillsShDescribe: (source: string, skillId: string) => ipcRenderer.invoke('skills-sh:describe', source, skillId),
  skillsShOpenPage: (source: string, skillId: string) => ipcRenderer.invoke('skills-sh:open-page', source, skillId),
  onSkillsShInstallProgress: (callback: (p: { id: string; phase: string }) => void) => {
    const handler = (_: unknown, p: { id: string; phase: string }) => callback(p)
    ipcRenderer.on('skills-sh:install-progress', handler)
    return () => { ipcRenderer.removeListener('skills-sh:install-progress', handler) }
  },

  // 工具调用（GAP4）+ #7 trustTier（Proxy 走 proxy，灰名单主进程拒绝）
  executeToolCall: (
    avatarId: string,
    conversationId: string,
    name: string,
    args: Record<string, unknown>,
    meta?: { trustTier?: 'ui' | 'proxy' },
  ) => ipcRenderer.invoke('execute-tool-call', avatarId, conversationId, name, args, meta),

  /** #7：将会话 Ask/Plan/Agent 同步到主进程门禁 */
  syncConversationToolMode: (conversationId: string, mode: string) =>
    ipcRenderer.invoke('conversation:sync-tool-mode', conversationId, mode),

  // 知识检索（GAP1）
  searchKnowledgeChunks: (avatarId: string, query: string, topN?: number) =>
    ipcRenderer.invoke('search-knowledge-chunks', avatarId, query, topN),

  // 知识索引构建
  buildKnowledgeIndex: (avatarId: string, apiKey: string, baseUrl: string) =>
    ipcRenderer.invoke('build-knowledge-index', avatarId, apiKey, baseUrl),

  // 模板管理
  getTemplate: (templateName: string) => ipcRenderer.invoke('get-template', templateName),
  getSoulCreationPrompt: (avatarName: string) => ipcRenderer.invoke('get-soul-creation-prompt', avatarName),
  getSkillCreationPrompt: () => ipcRenderer.invoke('get-skill-creation-prompt'),
  getTestCreationPrompt: () => ipcRenderer.invoke('get-test-creation-prompt'),
  listTemplates: () => ipcRenderer.invoke('list-templates'),

  // 知识百科（Wiki 融合层）
  compileWiki: (avatarId: string, apiKey: string, baseUrl: string) =>
    ipcRenderer.invoke('compile-wiki', avatarId, apiKey, baseUrl),
  getWikiStatus: (avatarId: string) =>
    ipcRenderer.invoke('get-wiki-status', avatarId),
  getConceptPages: (avatarId: string) =>
    ipcRenderer.invoke('get-concept-pages', avatarId),
  readConceptPage: (avatarId: string, name: string) =>
    ipcRenderer.invoke('read-concept-page', avatarId, name),
  lintKnowledge: (avatarId: string, apiKey: string, baseUrl: string) =>
    ipcRenderer.invoke('lint-knowledge', avatarId, apiKey, baseUrl),
  getLintReport: (avatarId: string) =>
    ipcRenderer.invoke('get-lint-report', avatarId),
  saveWikiAnswer: (avatarId: string, qa: { id: string; question: string; answer: string; sources: string[]; savedAt: string }) =>
    ipcRenderer.invoke('save-wiki-answer', avatarId, qa),
  getWikiAnswers: (avatarId: string) =>
    ipcRenderer.invoke('get-wiki-answers', avatarId),
  preserveRawFile: (avatarId: string, originalFilePath: string) =>
    ipcRenderer.invoke('preserve-raw-file', avatarId, originalFilePath),
  detectEvolution: (avatarId: string, newContent: string, newFileName: string, apiKey: string, baseUrl: string) =>
    ipcRenderer.invoke('detect-evolution', avatarId, newContent, newFileName, apiKey, baseUrl),
  getEvolutionReport: (avatarId: string) =>
    ipcRenderer.invoke('get-evolution-report', avatarId),

  // 文档导入（GAP9a）
  showOpenDialog: (options: { title?: string; filters?: Array<{ name: string; extensions: string[] }>; properties?: string[] }) =>
    ipcRenderer.invoke('show-open-dialog', options),
  parseDocument: (filePath: string) =>
    ipcRenderer.invoke('parse-document', filePath),
  writeExcelData: (avatarId: string, basename: string, data: unknown) =>
    ipcRenderer.invoke('write-excel-data', avatarId, basename, data),

  // 批量 / 归档导入（2026-04-13）
  importFolder: (avatarId: string, folderPath: string) =>
    ipcRenderer.invoke('import-folder', avatarId, folderPath),
  importArchive: (avatarId: string, archivePath: string) =>
    ipcRenderer.invoke('import-archive', avatarId, archivePath),
  installDefaultSkills: (avatarId: string) =>
    ipcRenderer.invoke('install-default-skills', avatarId),
  onImportProgress: (callback: (data: { current: number; total: number; fileName: string; phase: string }) => void) => {
    const handler = (_: unknown, data: { current: number; total: number; fileName: string; phase: string }) => callback(data)
    ipcRenderer.on('knowledge-import-progress', handler)
    return () => { ipcRenderer.removeListener('knowledge-import-progress', handler) }
  },
  formatKnowledgeFile: (avatarId: string, relativePath: string) =>
    ipcRenderer.invoke('format-knowledge-file', avatarId, relativePath),
  onFileWritten: (callback: (data: { avatarId: string; fileName: string }) => void) => {
    const handler = (_: unknown, data: { avatarId: string; fileName: string }) => callback(data)
    ipcRenderer.on('knowledge-file-written', handler)
    return () => { ipcRenderer.removeListener('knowledge-file-written', handler) }
  },
  enhanceKnowledgeFiles: (avatarId: string, options: {
    llm: { apiKey: string; baseUrl: string; model: string }
    ocr?: { apiKey: string; baseUrl?: string }
    targetFiles?: string[]
  }) => ipcRenderer.invoke('enhance-knowledge-files', avatarId, options),
  onEnhanceProgress: (callback: (data: { current: number; total: number; fileName: string; phase: string }) => void) => {
    const handler = (_: unknown, data: { current: number; total: number; fileName: string; phase: string }) => callback(data)
    ipcRenderer.on('knowledge-enhance-progress', handler)
    return () => { ipcRenderer.removeListener('knowledge-enhance-progress', handler) }
  },

  // 定时自检（GAP14）
  startScheduledTest: (avatarId: string, intervalHours: number) =>
    ipcRenderer.invoke('start-scheduled-test', avatarId, intervalHours),
  stopScheduledTest: () =>
    ipcRenderer.invoke('stop-scheduled-test'),
  notifyTestResult: (passed: number, total: number, failed: number) =>
    ipcRenderer.invoke('notify-test-result', passed, total, failed),
  onScheduledTestTrigger: (callback: (avatarId: string) => void) => {
    const handler = (_: unknown, avatarId: string) => callback(avatarId)
    ipcRenderer.on('scheduled-test-trigger', handler)
    return () => { ipcRenderer.removeListener('scheduled-test-trigger', handler) }
  },
  onTestResultBadge: (callback: (data: { passed: number; total: number; failed: number }) => void) => {
    const handler = (_: unknown, data: { passed: number; total: number; failed: number }) => callback(data)
    ipcRenderer.on('test-result-badge', handler)
    return () => { ipcRenderer.removeListener('test-result-badge', handler) }
  },

  // 定时任务（Feature 8）
  scheduleCron: (type: string, intervalHours: number, avatarId?: string) =>
    ipcRenderer.invoke('schedule-cron', type, intervalHours, avatarId),
  cancelCron: (type: string) => ipcRenderer.invoke('cancel-cron', type),
  getCronConfig: () => ipcRenderer.invoke('get-cron-config'),
  onCronMemoryConsolidate: (callback: (avatarId: string) => void) => {
    const handler = (_: unknown, avatarId: string) => callback(avatarId)
    ipcRenderer.on('cron-memory-consolidate', handler)
    return () => { ipcRenderer.removeListener('cron-memory-consolidate', handler) }
  },
  onCronKnowledgeCheck: (callback: (avatarId: string) => void) => {
    const handler = (_: unknown, avatarId: string) => callback(avatarId)
    ipcRenderer.on('cron-knowledge-check', handler)
    return () => { ipcRenderer.removeListener('cron-knowledge-check', handler) }
  },

  // 用户自定义定时任务（#11 Scheduled Tasks）
  scheduleList: (avatarId?: string) => ipcRenderer.invoke('schedule:list', avatarId),
  scheduleGet: (id: string) => ipcRenderer.invoke('schedule:get', id),
  scheduleCreate: (input: unknown) => ipcRenderer.invoke('schedule:create', input),
  scheduleUpdate: (id: string, patch: unknown) => ipcRenderer.invoke('schedule:update', id, patch),
  scheduleDelete: (id: string) => ipcRenderer.invoke('schedule:delete', id),
  scheduleSetEnabled: (id: string, enabled: boolean) =>
    ipcRenderer.invoke('schedule:set-enabled', id, enabled),
  scheduleTriggerNow: (id: string) => ipcRenderer.invoke('schedule:trigger-now', id),
  scheduleGetNextRuns: (cronExpr: string, timezone: string, n: number) =>
    ipcRenderer.invoke('schedule:get-next-runs', cronExpr, timezone, n),
  scheduleListRuns: (scheduleId: string, limit?: number) =>
    ipcRenderer.invoke('schedule:list-runs', scheduleId, limit),
  scheduleRecordRunFinish: (
    runId: number,
    status: 'success' | 'failed' | 'missed',
    opts?: { conversationId?: string | null; durationMs?: number; errorMessage?: string },
  ) => ipcRenderer.invoke('schedule:record-run-finish', runId, status, opts),
  /**
   * 监听主进程 schedule:trigger 事件。
   * payload 含 { runId, scheduleId, firedAtUtc, avatarId, projectId, conversationId, promptText, manual, scheduleName }。
   * 渲染端在 sendMessage 完成后必须调 scheduleRecordRunFinish 闭环 status。
   */
  onScheduleTrigger: (callback: (payload: unknown) => void) => {
    const handler = (_: unknown, payload: unknown) => callback(payload)
    ipcRenderer.on('schedule:trigger', handler)
    return () => { ipcRenderer.removeListener('schedule:trigger', handler) }
  },

  // ─── Web Embed widget（#15 Web Embed widget，2026-05-09） ───────────────
  // 与 main.ts 的 embed:* handlers 对应。args 透传，类型由 src/global.d.ts 的
  // ElectronAPI 接口约束（同 schedule* 系列保持一致，避免在 preload 重复声明）。
  embedList: (opts?: { avatarId?: string; enabled?: boolean }) =>
    ipcRenderer.invoke('embed:list', opts),
  embedGet: (id: string) =>
    ipcRenderer.invoke('embed:get', id),
  embedCreate: (input: unknown) =>
    ipcRenderer.invoke('embed:create', input),
  embedUpdate: (id: string, input: unknown) =>
    ipcRenderer.invoke('embed:update', id, input),
  embedDelete: (id: string) =>
    ipcRenderer.invoke('embed:delete', id),
  embedSetEnabled: (id: string, enabled: boolean) =>
    ipcRenderer.invoke('embed:set-enabled', id, enabled),
  embedGetPort: () =>
    ipcRenderer.invoke('embed:get-port'),
  embedServerStart: () =>
    ipcRenderer.invoke('embed:server-start'),
  embedServerStop: () =>
    ipcRenderer.invoke('embed:server-stop'),

  // ─── WebDAV 跨设备同步（#16 WebDAV cross-device sync，2026-05-09） ──────
  // 与 main.ts 的 sync:* handlers 对应。args 透传，类型由 src/global.d.ts 的
  // ElectronAPI 接口约束（同 schedule* / embed* 系列保持一致）。
  syncGetConfig: () =>
    ipcRenderer.invoke('sync:get-config'),
  syncSetConfig: (input: unknown) =>
    ipcRenderer.invoke('sync:set-config', input),
  syncClearCredentials: () =>
    ipcRenderer.invoke('sync:clear-credentials'),
  syncTestConnection: (input?: unknown) =>
    ipcRenderer.invoke('sync:test-connection', input),
  syncBackupNow: () =>
    ipcRenderer.invoke('sync:backup-now'),
  syncListRemoteBackups: () =>
    ipcRenderer.invoke('sync:list-remote-backups'),
  syncRestoreFrom: (filename: string) =>
    ipcRenderer.invoke('sync:restore-from', filename),
  syncGetStatus: () =>
    ipcRenderer.invoke('sync:get-status'),
  syncListHistory: (opts?: { limit?: number; direction?: 'backup' | 'restore'; status?: 'success' | 'failed' | 'in_progress' }) =>
    ipcRenderer.invoke('sync:list-history', opts),
  syncClearHistory: () =>
    ipcRenderer.invoke('sync:clear-history'),

  // 日志系统
  logEvent: (level: 'info' | 'warn' | 'error', action: string, detail?: string) =>
    ipcRenderer.invoke('log-event', level, action, detail),
  logPerfEvent: (action: string, detail?: string) =>
    ipcRenderer.invoke('log-perf-event', action, detail),
  getActivityLogs: (date?: string) => ipcRenderer.invoke('get-activity-logs', date),
  getErrorLogs: (date?: string) => ipcRenderer.invoke('get-error-logs', date),
  getGeneratedIndex: () => ipcRenderer.invoke('get-generated-index'),
  openLogsFolder: () => ipcRenderer.invoke('open-logs-folder'),
  openAvatarWorkspacesFolder: (avatarId: string) =>
    ipcRenderer.invoke('open-avatar-workspaces-folder', avatarId),
  exportErrorLog: (days?: number) => ipcRenderer.invoke('export-error-log', days),
  // 工具调用审计日志（Stage 三 P2 #16 / 范围外 3）
  readToolCallLog: (date?: string) => ipcRenderer.invoke('read-tool-call-log', date),
  readPerfLog: (date?: string) => ipcRenderer.invoke('read-perf-log', date),
  // 数据库备份
  dbBackup: () => ipcRenderer.invoke('db-backup'),
  // 对话导出
  exportConversation: (conversationId: string, format: 'markdown' | 'html') =>
    ipcRenderer.invoke('export-conversation', conversationId, format),
  // 提示词模板
  createPromptTemplate: (avatarId: string, title: string, content: string) =>
    ipcRenderer.invoke('create-prompt-template', avatarId, title, content),
  getPromptTemplates: (avatarId: string) =>
    ipcRenderer.invoke('get-prompt-templates', avatarId),
  updatePromptTemplate: (id: string, avatarId: string, title: string, content: string) =>
    ipcRenderer.invoke('update-prompt-template', id, avatarId, title, content),
  deletePromptTemplate: (id: string, avatarId: string) =>
    ipcRenderer.invoke('delete-prompt-template', id, avatarId),

  // 图表答案 cache（chartConsistencyMode 同问同答）
  getChartCacheHit: (avatarId: string, queryHash: string) =>
    ipcRenderer.invoke('get-chart-cache-hit', avatarId, queryHash),
  saveChartCacheEntry: (avatarId: string, payload: { queryHash: string; queryPreview: string; assistantContent: string; excelBasenames?: string[] }) =>
    ipcRenderer.invoke('save-chart-cache-entry', avatarId, payload),

  // 检查更新
  checkUpdate: () => ipcRenderer.invoke('check-update'),

  // 联网搜索（@web 引用 backend）
  webSearch: (query: string) => ipcRenderer.invoke('web-search', query),

  // ─── MCP server 管理（设置面板「工具集成 → MCP」用） ─────────────────
  // 与 main.ts 的 ipc:'mcp:*' handlers 对应。返回类型见 main.ts 的 wrapHandler 实现。
  mcpListServers: () => ipcRenderer.invoke('mcp:list-servers'),
  mcpUpsertServer: (config: {
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
  }) => ipcRenderer.invoke('mcp:upsert-server', config),
  mcpTestConnect: (config: {
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
  }) => ipcRenderer.invoke('mcp:test-connect', config),
  mcpRemoveServer: (name: string) => ipcRenderer.invoke('mcp:remove-server', name),
  mcpReconnectServer: (name: string) => ipcRenderer.invoke('mcp:reconnect-server', name),
  mcpDisconnectServer: (name: string) => ipcRenderer.invoke('mcp:disconnect-server', name),

  // 批量回归测试（2026-04-30 子任务 5）
  regressionLoadOrGenerateBank: (avatarId: string, opts?: { force?: boolean }) =>
    ipcRenderer.invoke('regression-load-or-generate-bank', avatarId, opts),
  regressionListRuns: (avatarId: string) =>
    ipcRenderer.invoke('regression-list-runs', avatarId),
  regressionEnsureConversation: (avatarId: string, conversationId: string, title: string) =>
    ipcRenderer.invoke('regression-ensure-conversation', avatarId, conversationId, title),
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
    questionBankSource?: {
      sourcePath: string
      cached: boolean
      loadedAt: number
      generatedAt?: string
      totalQuestionCount: number
      selectedQuestionCount: number
    }
    reportMd: string
    reportHtml: string
  }) => ipcRenderer.invoke('regression-save-run-result', avatarId, payload),
  regressionCleanupConversations: (runId: string) =>
    ipcRenderer.invoke('regression-cleanup-conversations', runId),
  regressionOpenReport: (filePath: string) =>
    ipcRenderer.invoke('regression-open-report', filePath),
})
