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
  saveMessage: (conversationId: string, role: 'user' | 'assistant' | 'tool', content: string, toolCallId?: string, imageUrls?: string[]) =>
    ipcRenderer.invoke('save-message', conversationId, role, content, toolCallId, imageUrls),
  getMessages: (conversationId: string) => ipcRenderer.invoke('get-messages', conversationId),

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
  openAttachmentFile: (id: string) =>
    ipcRenderer.invoke('open-attachment-file', id),

  // 文档生成（PDF / DOCX / Markdown）— 与 generate_document 工具配套
  renderDocumentPdf: (html: string, outputPath: string) =>
    ipcRenderer.invoke('document:render-pdf', html, outputPath),
  renderDocumentDocx: (ir: unknown, outputPath: string) =>
    ipcRenderer.invoke('document:render-docx', ir, outputPath),
  openDocument: (absolutePath: string) =>
    ipcRenderer.invoke('document:open', absolutePath),
  showDocumentInFolder: (absolutePath: string) =>
    ipcRenderer.invoke('document:show-in-folder', absolutePath),

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
  claudeBridgeComplete: (conversationId: string, input: string | { messages?: Array<{ role: string; content: string }> }, filePath?: string) =>
    ipcRenderer.invoke('claudebridge:complete', conversationId, input, filePath),
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
  writeKnowledgeFile: (avatarId: string, relativePath: string, content: string) => ipcRenderer.invoke('write-knowledge-file', avatarId, relativePath, content),
  searchKnowledge: (avatarId: string, query: string) => ipcRenderer.invoke('search-knowledge', avatarId, query),
  // GAP7: 知识文件 CRUD（之前缺失）
  createKnowledgeFile: (avatarId: string, relativePath: string, content?: string) => ipcRenderer.invoke('create-knowledge-file', avatarId, relativePath, content),
  deleteKnowledgeFile: (avatarId: string, relativePath: string) => ipcRenderer.invoke('delete-knowledge-file', avatarId, relativePath),

  // 记忆管理（GAP2）
  readMemory: (avatarId: string) => ipcRenderer.invoke('read-memory', avatarId),
  writeMemory: (avatarId: string, content: string) => ipcRenderer.invoke('write-memory', avatarId, content),
  getMemoryStats: (avatarId: string) => ipcRenderer.invoke('get-memory-stats', avatarId),
  consolidateMemory: (avatarId: string, content: string, apiKey: string, baseUrl: string) =>
    ipcRenderer.invoke('consolidate-memory', avatarId, content, apiKey, baseUrl),
  readMemoryStore: (avatarId: string) => ipcRenderer.invoke('read-memory-store', avatarId),
  writeMemoryStore: (avatarId: string, doc: StructuredMemoryDocumentDTO) =>
    ipcRenderer.invoke('write-memory-store', avatarId, doc),

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

    // Phase 1：生成器控制 + 进度订阅
    startGeneration: (avatarId: string, params: LifeStartGenerationParams) =>
      ipcRenderer.invoke('life:start-generation', avatarId, params),
    cancelGeneration: (avatarId: string) =>
      ipcRenderer.invoke('life:cancel-generation', avatarId),
    retryGeneration: (avatarId: string, params: LifeStartGenerationParams) =>
      ipcRenderer.invoke('life:retry-generation', avatarId, params),
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

  // 人格管理
  readSoul: (avatarId: string) => ipcRenderer.invoke('read-soul', avatarId),
  writeSoul: (avatarId: string, content: string) => ipcRenderer.invoke('write-soul', avatarId, content),

  // 分身管理
  listAvatars: () => ipcRenderer.invoke('list-avatars'),
  getAvatarSoulIntro: (targetAvatarId: string) => ipcRenderer.invoke('get-avatar-soul-intro', targetAvatarId),
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

  // RAG 检索阶段进度（用于 UI 显示 "正在检索…/正在分析关联组件…/正在拼装上下文…"），
  // 避免长 LLM 调用时用户看到彩虹伞以为应用挂死。返回 unsubscribe 函数。
  onRagProgress: (callback: (data: { avatarId: string; phase: string; detail?: string }) => void) => {
    const handler = (_: unknown, data: { avatarId: string; phase: string; detail?: string }) => callback(data)
    ipcRenderer.on('rag-progress', handler)
    return () => { ipcRenderer.removeListener('rag-progress', handler) }
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

  // 知识索引构建 + RAG 检索
  buildKnowledgeIndex: (avatarId: string, apiKey: string, baseUrl: string) =>
    ipcRenderer.invoke('build-knowledge-index', avatarId, apiKey, baseUrl),
  ragRetrieve: (avatarId: string, question: string, apiKey: string, baseUrl: string) =>
    ipcRenderer.invoke('rag-retrieve', avatarId, question, apiKey, baseUrl),

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

  // 日志系统
  logEvent: (level: 'info' | 'warn' | 'error', action: string, detail?: string) =>
    ipcRenderer.invoke('log-event', level, action, detail),
  getActivityLogs: (date?: string) => ipcRenderer.invoke('get-activity-logs', date),
  getErrorLogs: (date?: string) => ipcRenderer.invoke('get-error-logs', date),
  getGeneratedIndex: () => ipcRenderer.invoke('get-generated-index'),
  openLogsFolder: () => ipcRenderer.invoke('open-logs-folder'),
  openAvatarWorkspacesFolder: (avatarId: string) =>
    ipcRenderer.invoke('open-avatar-workspaces-folder', avatarId),
  exportErrorLog: (days?: number) => ipcRenderer.invoke('export-error-log', days),
  // 工具调用审计日志（Stage 三 P2 #16 / 范围外 3）
  readToolCallLog: (date?: string) => ipcRenderer.invoke('read-tool-call-log', date),
  // 数据库备份
  dbBackup: () => ipcRenderer.invoke('db-backup'),
  // 对话导出
  exportConversation: (conversationId: string, format: 'markdown' | 'pdf') =>
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
