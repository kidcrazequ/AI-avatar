/**
 * Electron 主进程入口
 *
 * @author zhi.qu
 * @date 2026-04-03
 */

import { app, BrowserWindow, ipcMain, dialog, nativeImage, shell } from 'electron'
import path from 'path'
import fs from 'fs'
import { SoulLoader, KnowledgeManager, AvatarManager, SkillManager, ToolRouter, KnowledgeRetriever, TemplateLoader, buildKnowledgeIndex, saveIndex, retrieveAndBuildPrompt } from '@soul/core'
import type { LLMCallFn, EmbeddingCallFn } from '@soul/core'
import { DatabaseManager } from './database'
import { TestManager } from './test-manager'
import { DocumentParser } from './document-parser'
import { ScheduledTester } from './scheduled-tester'
import { Logger } from './logger'

let mainWindow: BrowserWindow | null = null

/**
 * 解析分身目录路径。
 * 开发环境直接指向仓库 avatars/；生产环境使用 userData/avatars/（首次启动自动创建空目录）。
 */
function resolveAvatarsPath(): string {
  if (process.env.NODE_ENV === 'development') {
    return path.join(__dirname, '../../avatars')
  }
  const userAvatarsPath = path.join(app.getPath('userData'), 'avatars')
  if (!fs.existsSync(userAvatarsPath)) {
    fs.mkdirSync(userAvatarsPath, { recursive: true })
  }
  return userAvatarsPath
}

/**
 * 解析模板目录路径（Electron 专属路径逻辑，由 main.ts 负责，保持 @soul/core 无 Electron 依赖）
 */
function resolveTemplatesPath(): string {
  if (process.env.NODE_ENV === 'development') {
    return path.join(__dirname, '../../templates')
  }
  return path.join(process.resourcesPath, 'templates')
}

// ─── 单例 ────────────────────────────────────────────────────────────────────

const knowledgeManagers = new Map<string, KnowledgeManager>()

let avatarsPath: string
let soulLoader: SoulLoader
let db: DatabaseManager
let avatarManager: AvatarManager
let testManager: TestManager
let skillManager: SkillManager
let toolRouter: ToolRouter
const documentParser = new DocumentParser()
const scheduledTester = new ScheduledTester()
let templateLoader: TemplateLoader

/** Logger 使用 userData 路径，需在 app ready 之后才能获取；先声明再赋值 */
let logger: Logger

/**
 * 获取数据库实例；若 app.whenReady 初始化失败则延迟创建兜底。
 */
function getDb(): DatabaseManager {
  if (!db) {
    console.warn('[Main] db was undefined — creating lazily')
    db = new DatabaseManager()
  }
  return db
}

/**
 * IPC 包装器：统一记录操作日志和错误日志。
 * 所有 ipcMain.handle 调用改由此函数注册，不改变业务逻辑。
 */
function wrapHandler(
  channel: string,
  handler: (event: Electron.IpcMainInvokeEvent, ...args: any[]) => any
): void {
  ipcMain.handle(channel, async (event, ...args) => {
    // 对 save-message 等高频 channel 仅记录精简信息，避免日志膨胀
    const isHighFreq = ['save-message', 'get-messages', 'get-conversations', 'get-knowledge-tree'].includes(channel)
    if (!isHighFreq && logger) {
      const preview = JSON.stringify(args).slice(0, 200)
      logger.activity(channel, preview)
    }
    try {
      return await handler(event, ...args)
    } catch (err) {
      if (logger) logger.error(channel, err as Error)
      throw err
    }
  })
}

// ─── 窗口与初始化 ─────────────────────────────────────────────────────────────

/**
 * 解析应用图标路径（开发/生产环境适配）
 */
function resolveIconPath(): string | undefined {
  const iconName = process.platform === 'win32' ? 'icon.ico' : 'icon.png'
  if (process.env.NODE_ENV === 'development') {
    const devIcon = path.join(__dirname, '..', 'build', iconName)
    return fs.existsSync(devIcon) ? devIcon : undefined
  }
  const prodIcon = path.join(process.resourcesPath, iconName)
  return fs.existsSync(prodIcon) ? prodIcon : undefined
}

function createWindow() {
  const iconPath = resolveIconPath()
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    icon: iconPath ? nativeImage.createFromPath(iconPath) : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  if (process.env.NODE_ENV === 'development') {
    mainWindow.loadURL('http://localhost:5173')
    mainWindow.webContents.openDevTools()
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
    scheduledTester.stop()
    if (logger) logger.activity('app-window-closed')
  })
}

function initManagers() {
  avatarsPath = resolveAvatarsPath()
  const templatesPath = resolveTemplatesPath()
  logger = new Logger(app.getPath('userData'))
  soulLoader = new SoulLoader(avatarsPath)
  db = new DatabaseManager()
  avatarManager = new AvatarManager(avatarsPath, templatesPath)
  testManager = new TestManager(avatarsPath)
  skillManager = new SkillManager(avatarsPath)
  toolRouter = new ToolRouter(avatarsPath)
  templateLoader = new TemplateLoader(templatesPath)
  logger.activity('app-init', `avatarsPath=${avatarsPath}`)
}

app.whenReady().then(() => {
  try {
    initManagers()
  } catch (error) {
    console.error('[Main] initManagers failed:', error)
  }
  createWindow()
  scheduledTester.setWindow(mainWindow!)
}).catch((error) => {
  console.error('[Main] app.whenReady() rejected:', error)
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    if (!db) {
      try { initManagers() } catch (e) { console.error('[Main] re-init failed:', e) }
    }
    createWindow()
  }
})

// ─── 工具函数 ────────────────────────────────────────────────────────────────

const getKnowledgeManager = (avatarId: string): KnowledgeManager => {
  if (!knowledgeManagers.has(avatarId)) {
    const knowledgePath = path.join(avatarsPath, avatarId, 'knowledge')
    knowledgeManagers.set(avatarId, new KnowledgeManager(knowledgePath))
  }
  return knowledgeManagers.get(avatarId)!
}

// ─── IPC 处理器 ──────────────────────────────────────────────────────────────

ipcMain.handle('ping', () => 'pong')

// 加载分身配置（GAP3/GAP6: 重新调用后 systemPrompt 会根据最新技能/知识/记忆重建）
wrapHandler('load-avatar', (_, avatarId: string) => {
  return soulLoader.loadAvatar(avatarId)
})

// ─── 会话管理 ────────────────────────────────────────────────────────────────

wrapHandler('create-conversation', (_, title: string, avatarId: string) => {
  return getDb().createConversation(title, avatarId)
})

wrapHandler('get-conversations', (_, avatarId?: string) => {
  return getDb().getConversations(avatarId)
})

wrapHandler('get-conversation', (_, id: string) => {
  return getDb().getConversation(id)
})

wrapHandler('update-conversation-title', (_, id: string, title: string) => {
  getDb().updateConversationTitle(id, title)
})

wrapHandler('delete-conversation', (_, id: string) => {
  getDb().deleteConversation(id)
})

// ─── 消息管理 ────────────────────────────────────────────────────────────────

wrapHandler('save-message', (_, conversationId: string, role: 'user' | 'assistant' | 'tool', content: string, toolCallId?: string, imageUrls?: string[]) => {
  return getDb().saveMessage(conversationId, role, content, toolCallId, imageUrls)
})

wrapHandler('get-messages', (_, conversationId: string) => {
  return getDb().getMessages(conversationId)
})

// ─── 设置管理 ────────────────────────────────────────────────────────────────

wrapHandler('get-setting', (_, key: string) => {
  return getDb().getSetting(key)
})

wrapHandler('set-setting', (_, key: string, value: string) => {
  getDb().setSetting(key, value)
})

// ─── 知识库管理 ──────────────────────────────────────────────────────────────

wrapHandler('get-knowledge-tree', (_, avatarId: string) => {
  return getKnowledgeManager(avatarId).getKnowledgeTree()
})

wrapHandler('read-knowledge-file', (_, avatarId: string, relativePath: string) => {
  return getKnowledgeManager(avatarId).readFile(relativePath)
})

wrapHandler('write-knowledge-file', (_, avatarId: string, relativePath: string, content: string) => {
  const km = getKnowledgeManager(avatarId)
  km.writeFile(relativePath, content)
  // 归档生成的知识文件（仅非 README 文件）
  if (!relativePath.toLowerCase().includes('readme')) {
    const fullPath = path.join(avatarsPath, avatarId, 'knowledge', relativePath)
    if (logger) logger.recordGenerated('knowledge', avatarId, fullPath, { relativePath })
  }
})

wrapHandler('search-knowledge', (_, avatarId: string, query: string) => {
  return getKnowledgeManager(avatarId).searchFiles(query)
})

// GAP7 修复：注册缺失的知识文件 CRUD IPC
wrapHandler('create-knowledge-file', (_, avatarId: string, relativePath: string, content?: string) => {
  getKnowledgeManager(avatarId).createFile(relativePath, content ?? '')
  const fullPath = path.join(avatarsPath, avatarId, 'knowledge', relativePath)
  if (logger) logger.recordGenerated('knowledge', avatarId, fullPath, { relativePath, action: 'create' })
})

wrapHandler('delete-knowledge-file', (_, avatarId: string, relativePath: string) => {
  getKnowledgeManager(avatarId).deleteFile(relativePath)
})

// ─── 记忆管理（GAP2）────────────────────────────────────────────────────────

wrapHandler('read-memory', (_, avatarId: string) => {
  const memoryPath = path.join(avatarsPath, avatarId, 'memory', 'MEMORY.md')
  try {
    return fs.readFileSync(memoryPath, 'utf-8')
  } catch {
    return ''
  }
})

wrapHandler('write-memory', (_, avatarId: string, content: string) => {
  const memoryPath = path.join(avatarsPath, avatarId, 'memory', 'MEMORY.md')
  const memoryDir = path.dirname(memoryPath)
  if (!fs.existsSync(memoryDir)) {
    fs.mkdirSync(memoryDir, { recursive: true })
  }
  fs.writeFileSync(memoryPath, content, 'utf-8')
  if (logger) logger.recordGenerated('memory', avatarId, memoryPath)
})

// ─── 人格管理 ────────────────────────────────────────────────────────────────

wrapHandler('read-soul', (_, avatarId: string) => {
  const soulPath = path.join(avatarsPath, avatarId, 'soul.md')
  try {
    return fs.readFileSync(soulPath, 'utf-8')
  } catch {
    return ''
  }
})

wrapHandler('write-soul', (_, avatarId: string, content: string) => {
  const soulPath = path.join(avatarsPath, avatarId, 'soul.md')
  fs.writeFileSync(soulPath, content, 'utf-8')
  if (logger) logger.recordGenerated('soul', avatarId, soulPath)
})

// ─── 分身管理 ────────────────────────────────────────────────────────────────

wrapHandler('list-avatars', () => {
  return avatarManager.listAvatars()
})

wrapHandler('create-avatar', (_, id: string, soulContent: string, skills: string[], knowledgeFiles: Array<{ name: string; content: string }>) => {
  avatarManager.createAvatar(id, soulContent, skills, knowledgeFiles)
  // 归档初始 soul.md
  const soulPath = path.join(avatarsPath, id, 'soul.md')
  if (logger) logger.recordGenerated('soul', id, soulPath, { action: 'create-avatar' })
})

wrapHandler('write-skill-file', (_, avatarId: string, fileName: string, content: string) => {
  avatarManager.writeSkillFile(avatarId, fileName, content)
  const skillPath = path.join(avatarsPath, avatarId, 'skills', fileName)
  if (logger) logger.recordGenerated('skill', avatarId, skillPath, { fileName })
})

// BUG4 修复：删除分身时同步清理 DB 中的会话和消息记录
wrapHandler('delete-avatar', (_, id: string) => {
  getDb().deleteConversationsByAvatar(id)
  avatarManager.deleteAvatar(id)
  knowledgeManagers.delete(id)
})

// ─── 测试管理 ────────────────────────────────────────────────────────────────

wrapHandler('get-test-cases', (_, avatarId: string) => {
  return testManager.getTestCases(avatarId)
})

wrapHandler('get-test-case', (_, avatarId: string, caseId: string) => {
  return testManager.getTestCase(avatarId, caseId)
})

wrapHandler('create-test-case', (_, avatarId: string, testCase: any) => {
  return testManager.createTestCase(avatarId, testCase)
})

wrapHandler('delete-test-case', (_, avatarId: string, caseId: string) => {
  testManager.deleteTestCase(avatarId, caseId)
})

wrapHandler('save-test-report', (_, avatarId: string, report: any) => {
  const reportPath = testManager.saveTestReport(avatarId, report)
  // reportPath 可能是字符串路径，也可能 undefined（取决于实现），容错处理
  if (reportPath && logger) {
    logger.recordGenerated('test-report', avatarId, reportPath, {
      passed: report.passedCases,
      total: report.totalCases,
    })
  }
})

wrapHandler('get-latest-report', (_, avatarId: string) => {
  return testManager.getLatestReport(avatarId)
})

wrapHandler('get-report-list', (_, avatarId: string) => {
  return testManager.getReportList(avatarId)
})

// BUG6 修复：runTests 仅返回测试用例数据，实际执行在渲染进程的 TestRunner 中完成
wrapHandler('run-tests', async (_, avatarId: string, caseIds: string[]) => {
  return testManager.getTestCases(avatarId).filter(c => caseIds.includes(c.id))
})

// ─── 技能管理 ────────────────────────────────────────────────────────────────

wrapHandler('get-skills', (_, avatarId: string) => {
  return skillManager.getSkills(avatarId)
})

wrapHandler('get-skill', (_, avatarId: string, skillId: string) => {
  return skillManager.getSkill(avatarId, skillId)
})

wrapHandler('update-skill', (_, avatarId: string, skillId: string, content: string) => {
  skillManager.updateSkill(avatarId, skillId, content)
  // 归档更新后的技能文件
  const skillPath = path.join(avatarsPath, avatarId, 'skills', `${skillId}.md`)
  if (logger) logger.recordGenerated('skill', avatarId, skillPath, { skillId })
})

wrapHandler('toggle-skill', (_, avatarId: string, skillId: string, enabled: boolean) => {
  skillManager.toggleSkill(avatarId, skillId, enabled)
})

// ─── 工具调用（GAP4）────────────────────────────────────────────────────────

/**
 * execute-tool-call: 执行 LLM 发起的工具调用，返回结果字符串给渲染进程。
 * avatarId 用于定位该分身的知识库路径。
 */
wrapHandler('execute-tool-call', async (_, avatarId: string, name: string, args: Record<string, unknown>) => {
  return toolRouter.execute(avatarId, { name, arguments: args })
})

/**
 * search-knowledge-chunks: 供渲染进程直接调用的知识检索接口（GAP1）。
 * 返回按相关度排序的知识片段，供 UI 展示或注入上下文。
 */
wrapHandler('search-knowledge-chunks', (_, avatarId: string, query: string, topN?: number) => {
  const knowledgePath = path.join(avatarsPath, avatarId, 'knowledge')
  const retriever = new KnowledgeRetriever(knowledgePath)
  return retriever.searchChunks(query, topN ?? 5)
})

// ─── 知识索引与 RAG 检索 ────────────────────────────────────────────────────

/**
 * DashScope Embedding API 调用（text-embedding-v3，512 维）。
 * apiKey 和 baseUrl 从渲染进程传入的 modelConfig 获取。
 */
function createEmbeddingFn(apiKey: string, baseUrl: string): EmbeddingCallFn {
  return async (texts: string[]): Promise<number[][]> => {
    const response = await fetch(`${baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'text-embedding-v3',
        input: texts,
        dimension: 512,
      }),
    })
    if (!response.ok) {
      throw new Error(`Embedding API 失败 (${response.status})`)
    }
    const data = await response.json() as { data: Array<{ embedding: number[] }> }
    return data.data.map(d => d.embedding)
  }
}

/**
 * 创建 LLMCallFn 适配器，用于索引构建和 RAG 中的 LLM 调用。
 */
function createLLMFn(apiKey: string, baseUrl: string, model: string): LLMCallFn {
  return async (systemPrompt: string, userPrompt: string, maxTokens = 200): Promise<string> => {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        stream: false,
        max_tokens: maxTokens,
      }),
    })
    if (!response.ok) {
      throw new Error(`LLM API 失败 (${response.status})`)
    }
    const data = await response.json() as { choices: Array<{ message: { content: string } }> }
    return data.choices?.[0]?.message?.content ?? ''
  }
}

/**
 * build-knowledge-index: 为指定分身的知识库构建检索索引（上下文摘要 + 向量嵌入）。
 * 索引持久化到 knowledge/_index/，并刷新 ToolRouter 中的缓存。
 */
wrapHandler('build-knowledge-index', async (_, avatarId: string, apiKey: string, baseUrl: string) => {
  const knowledgePath = path.join(avatarsPath, avatarId, 'knowledge')
  const retriever = new KnowledgeRetriever(knowledgePath)

  const callLLM = createLLMFn(apiKey, baseUrl, 'qwen-turbo')
  const callEmbedding = createEmbeddingFn(apiKey, baseUrl)

  const { contexts, embeddings } = await buildKnowledgeIndex(
    retriever,
    { callLLM, callEmbedding },
  )

  saveIndex(knowledgePath, contexts, embeddings)
  toolRouter.invalidateRetriever(avatarId)

  return { contextCount: contexts.size, embeddingCount: embeddings.size }
})

/**
 * rag-retrieve: 对用户问题执行程序化 RAG（多跳检索 + 5 规则 prompt 构造）。
 * 返回增强后的 user 消息文本。
 */
wrapHandler('rag-retrieve', async (_, avatarId: string, question: string, apiKey: string, baseUrl: string) => {
  const retriever = toolRouter.getRetriever(avatarId)

  const callLLM = createLLMFn(apiKey, baseUrl, 'qwen-plus')
  const callEmbedding = createEmbeddingFn(apiKey, baseUrl)

  const embeddingMap = retriever.getEmbeddings()
  return retrieveAndBuildPrompt(retriever, question, { callLLM, callEmbedding }, embeddingMap)
})

// ─── 文档导入（GAP9a）────────────────────────────────────────────────────────

/** 打开系统文件选择对话框，返回用户选中的文件路径 */
wrapHandler('show-open-dialog', async (_, options: Electron.OpenDialogOptions) => {
  return dialog.showOpenDialog(mainWindow!, options)
})

/**
 * parse-document: 解析文件（PDF/Word/图片/文本）。
 * 返回提取的文本和图片（base64 data URL），图片由渲染进程进一步 OCR。
 */
wrapHandler('parse-document', async (_, filePath: string) => {
  return documentParser.parseFile(filePath)
})

// ─── 定时自检（GAP14）────────────────────────────────────────────────────────

/**
 * start-scheduled-test: 启动定时自检（每 N 小时触发一次）。
 * intervalHours = 0 表示停止。
 */
wrapHandler('start-scheduled-test', (_, avatarId: string, intervalHours: number) => {
  scheduledTester.start(avatarId, intervalHours)
  getDb().setSetting(`scheduled_test_avatar`, avatarId)
  getDb().setSetting(`scheduled_test_interval`, String(intervalHours))
})

wrapHandler('stop-scheduled-test', () => {
  scheduledTester.stop()
  getDb().setSetting(`scheduled_test_interval`, '0')
})

// ─── 模板管理 ────────────────────────────────────────────────────────────────

/** 获取指定模板文件的原始内容 */
wrapHandler('get-template', (_, templateName: string) => {
  return templateLoader.getTemplate(templateName)
})

/** 获取生成 soul.md 时的 system prompt（包含模板约束） */
wrapHandler('get-soul-creation-prompt', (_, avatarName: string) => {
  return templateLoader.buildSoulCreationPrompt(avatarName)
})

/** 获取生成技能文件时的 system prompt（包含模板约束） */
wrapHandler('get-skill-creation-prompt', () => {
  return templateLoader.buildSkillCreationPrompt()
})

/** 获取生成测试用例时的 system prompt（包含模板约束） */
wrapHandler('get-test-creation-prompt', () => {
  return templateLoader.buildTestCaseCreationPrompt()
})

/** 列出所有可用模板文件名 */
wrapHandler('list-templates', () => {
  return templateLoader.listTemplates()
})

/** notify-test-result: 渲染进程测试完成后通知主进程更新红点状态 */
wrapHandler('notify-test-result', (_, passed: number, total: number, failed: number) => {
  scheduledTester.notifyTestResult(passed > 0 && failed === 0, total, failed)
})

// ─── 日志系统 IPC ─────────────────────────────────────────────────────────────

/**
 * log-event: 渲染进程主动上报日志（LLM 调用、面板操作等无法在主进程捕获的事件）
 */
ipcMain.handle('log-event', (_, level: 'info' | 'warn' | 'error', action: string, detail?: string) => {
  if (logger) logger.logEvent(level, action, detail)
})

/** 读取指定日期（默认今天）的操作时间线日志 */
ipcMain.handle('get-activity-logs', (_, date?: string) => {
  return logger ? logger.readActivityLog(date) : ''
})

/** 读取指定日期（默认今天）的错误日志 */
ipcMain.handle('get-error-logs', (_, date?: string) => {
  return logger ? logger.readErrorLog(date) : ''
})

/** 读取生成文档归档索引 */
ipcMain.handle('get-generated-index', () => {
  return logger ? logger.readGeneratedIndex() : []
})

/**
 * open-logs-folder: 用系统文件管理器打开日志目录。
 * Windows 用户可直接定位到文件夹后发送给开发者。
 */
ipcMain.handle('open-logs-folder', async () => {
  const logsDir = path.join(app.getPath('userData'), 'logs')
  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true })
  }
  await shell.openPath(logsDir)
  return logsDir
})

/**
 * export-error-log: 将最近 N 天的错误日志合并后复制到用户桌面，
 * 文件名带时间戳，方便用户直接发送给开发者排查问题。
 * @param days 导出最近几天（默认 3 天）
 */
ipcMain.handle('export-error-log', async (_, days = 3) => {
  const logsDir = path.join(app.getPath('userData'), 'logs')
  const desktopDir = app.getPath('desktop')
  const lines: string[] = []

  // 收集最近 N 天的错误日志
  for (let i = 0; i < days; i++) {
    const date = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10)
    const errorFile = path.join(logsDir, `error-${date}.log`)
    if (fs.existsSync(errorFile)) {
      const content = fs.readFileSync(errorFile, 'utf-8').trim()
      if (content) {
        lines.push(`\n========== ${date} ==========\n${content}`)
      }
    }
  }

  if (lines.length === 0) {
    return { success: false, message: '最近没有错误日志' }
  }

  // 添加设备信息头部，方便定位问题
  const header = [
    `AI 分身 - 错误日志导出`,
    `导出时间：${new Date().toLocaleString('zh-CN')}`,
    `系统平台：${process.platform} ${process.arch}`,
    `应用版本：${app.getVersion()}`,
    `Electron：${process.versions.electron}`,
    `Node：${process.versions.node}`,
    '='.repeat(40),
    '',
  ].join('\n')

  const content = header + lines.join('\n')
  const ts = Date.now()
  const exportFile = path.join(desktopDir, `AI分身-错误日志-${ts}.txt`)
  fs.writeFileSync(exportFile, content, 'utf-8')

  // 打开桌面目录让用户看到文件
  await shell.openPath(desktopDir)

  if (logger) logger.activity('export-error-log', `exported to ${exportFile}`)
  return { success: true, filePath: exportFile }
})
