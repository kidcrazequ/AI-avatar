import { contextBridge, ipcRenderer } from 'electron'

// BUG7 修复：移除 preload.ts 中的内联 ElectronAPI 接口声明，
// 统一以 src/global.d.ts 为权威类型定义。

contextBridge.exposeInMainWorld('electronAPI', {
  ping: () => ipcRenderer.invoke('ping'),
  loadAvatar: (avatarId: string) => ipcRenderer.invoke('load-avatar', avatarId),

  // 会话管理
  createConversation: (title: string, avatarId: string) => ipcRenderer.invoke('create-conversation', title, avatarId),
  getConversations: (avatarId?: string) => ipcRenderer.invoke('get-conversations', avatarId),
  getConversation: (id: string) => ipcRenderer.invoke('get-conversation', id),
  updateConversationTitle: (id: string, title: string) => ipcRenderer.invoke('update-conversation-title', id, title),
  deleteConversation: (id: string) => ipcRenderer.invoke('delete-conversation', id),

  // 消息管理
  saveMessage: (conversationId: string, role: 'user' | 'assistant' | 'tool', content: string, toolCallId?: string, imageUrls?: string[]) =>
    ipcRenderer.invoke('save-message', conversationId, role, content, toolCallId, imageUrls),
  getMessages: (conversationId: string) => ipcRenderer.invoke('get-messages', conversationId),

  // 设置管理
  getSetting: (key: string) => ipcRenderer.invoke('get-setting', key),
  setSetting: (key: string, value: string) => ipcRenderer.invoke('set-setting', key, value),

  // 知识库管理
  getKnowledgeTree: (avatarId: string) => ipcRenderer.invoke('get-knowledge-tree', avatarId),
  readKnowledgeFile: (avatarId: string, relativePath: string) => ipcRenderer.invoke('read-knowledge-file', avatarId, relativePath),
  writeKnowledgeFile: (avatarId: string, relativePath: string, content: string) => ipcRenderer.invoke('write-knowledge-file', avatarId, relativePath, content),
  searchKnowledge: (avatarId: string, query: string) => ipcRenderer.invoke('search-knowledge', avatarId, query),
  // GAP7: 知识文件 CRUD（之前缺失）
  createKnowledgeFile: (avatarId: string, relativePath: string, content?: string) => ipcRenderer.invoke('create-knowledge-file', avatarId, relativePath, content),
  deleteKnowledgeFile: (avatarId: string, relativePath: string) => ipcRenderer.invoke('delete-knowledge-file', avatarId, relativePath),

  // 记忆管理（GAP2）
  readMemory: (avatarId: string) => ipcRenderer.invoke('read-memory', avatarId),
  writeMemory: (avatarId: string, content: string) => ipcRenderer.invoke('write-memory', avatarId, content),

  // 人格管理
  readSoul: (avatarId: string) => ipcRenderer.invoke('read-soul', avatarId),
  writeSoul: (avatarId: string, content: string) => ipcRenderer.invoke('write-soul', avatarId, content),

  // 分身管理
  listAvatars: () => ipcRenderer.invoke('list-avatars'),
  createAvatar: (id: string, soulContent: string, skills: string[], knowledgeFiles: Array<{ name: string; content: string }>) =>
    ipcRenderer.invoke('create-avatar', id, soulContent, skills, knowledgeFiles),
  writeSkillFile: (avatarId: string, fileName: string, content: string) =>
    ipcRenderer.invoke('write-skill-file', avatarId, fileName, content),
  deleteAvatar: (id: string) => ipcRenderer.invoke('delete-avatar', id),

  // 测试管理
  getTestCases: (avatarId: string) => ipcRenderer.invoke('get-test-cases', avatarId),
  getTestCase: (avatarId: string, caseId: string) => ipcRenderer.invoke('get-test-case', avatarId, caseId),
  createTestCase: (avatarId: string, testCase: any) => ipcRenderer.invoke('create-test-case', avatarId, testCase),
  deleteTestCase: (avatarId: string, caseId: string) => ipcRenderer.invoke('delete-test-case', avatarId, caseId),
  saveTestReport: (avatarId: string, report: any) => ipcRenderer.invoke('save-test-report', avatarId, report),
  getLatestReport: (avatarId: string) => ipcRenderer.invoke('get-latest-report', avatarId),
  getReportList: (avatarId: string) => ipcRenderer.invoke('get-report-list', avatarId),
  // BUG6 修复：移除虚假的 onProgress 回调参数
  runTests: (avatarId: string, caseIds: string[]) => ipcRenderer.invoke('run-tests', avatarId, caseIds),

  // 技能管理
  getSkills: (avatarId: string) => ipcRenderer.invoke('get-skills', avatarId),
  getSkill: (avatarId: string, skillId: string) => ipcRenderer.invoke('get-skill', avatarId, skillId),
  updateSkill: (avatarId: string, skillId: string, content: string) => ipcRenderer.invoke('update-skill', avatarId, skillId, content),
  toggleSkill: (avatarId: string, skillId: string, enabled: boolean) => ipcRenderer.invoke('toggle-skill', avatarId, skillId, enabled),

  // 工具调用（GAP4）
  executeToolCall: (avatarId: string, name: string, args: Record<string, unknown>) =>
    ipcRenderer.invoke('execute-tool-call', avatarId, name, args),

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

  // 定时自检（GAP14）
  startScheduledTest: (avatarId: string, intervalHours: number) =>
    ipcRenderer.invoke('start-scheduled-test', avatarId, intervalHours),
  stopScheduledTest: () =>
    ipcRenderer.invoke('stop-scheduled-test'),
  notifyTestResult: (passed: number, total: number, failed: number) =>
    ipcRenderer.invoke('notify-test-result', passed, total, failed),
  onScheduledTestTrigger: (callback: (avatarId: string) => void) => {
    ipcRenderer.on('scheduled-test-trigger', (_, avatarId) => callback(avatarId))
  },
  onTestResultBadge: (callback: (data: { passed: boolean; total: number; failed: number }) => void) => {
    ipcRenderer.on('test-result-badge', (_, data) => callback(data))
  },

  // 日志系统
  logEvent: (level: 'info' | 'warn' | 'error', action: string, detail?: string) =>
    ipcRenderer.invoke('log-event', level, action, detail),
  getActivityLogs: (date?: string) => ipcRenderer.invoke('get-activity-logs', date),
  getErrorLogs: (date?: string) => ipcRenderer.invoke('get-error-logs', date),
  getGeneratedIndex: () => ipcRenderer.invoke('get-generated-index'),
  openLogsFolder: () => ipcRenderer.invoke('open-logs-folder'),
  exportErrorLog: (days?: number) => ipcRenderer.invoke('export-error-log', days),
})
