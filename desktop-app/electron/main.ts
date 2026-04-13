/**
 * Electron 主进程入口
 *
 * @author zhi.qu
 * @date 2026-04-03
 */

import { app, BrowserWindow, ipcMain, dialog, nativeImage, shell } from 'electron'
import path from 'path'
import fs from 'fs'
import os from 'os'
import { SoulLoader, KnowledgeManager, AvatarManager, SkillManager, ToolRouter, KnowledgeRetriever, TemplateLoader, buildKnowledgeIndex, saveIndex, loadIndex, retrieveAndBuildPrompt, WikiCompiler, consolidateMemory, getMemoryStats, assertSafeSegment, localDateString, formatDocument, type WikiAnswer, type LLMCallFn } from '@soul/core'
import { DatabaseManager } from './database'
import { TestManager, type TestCase, type TestReport } from './test-manager'
import { DocumentParser } from './document-parser'
import {
  walkFolder,
  extractArchive,
  makeTempExtractDir,
  cleanupTempDir,
} from './folder-importer'
import { ScheduledTester } from './scheduled-tester'
import { CronScheduler, type CronTaskType } from './cron-scheduler'
import { Logger } from './logger'
import { createEmbeddingFn, createLLMFn } from './llm-factory'

let mainWindow: BrowserWindow | null = null

// assertSafeSegment 已从 @soul/core 统一导入

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
const wikiCompilers = new Map<string, WikiCompiler>()

let avatarsPath: string
let soulLoader: SoulLoader
let db: DatabaseManager
let avatarManager: AvatarManager
let testManager: TestManager
let skillManager: SkillManager
let toolRouter: ToolRouter
const documentParser = new DocumentParser()
const scheduledTester = new ScheduledTester()
const cronScheduler = new CronScheduler()
let templateLoader: TemplateLoader
let backupIntervalId: ReturnType<typeof setInterval> | null = null

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
/** 含敏感参数（apiKey）的 channel，日志需脱敏 */
const SENSITIVE_CHANNELS = new Set([
  'consolidate-memory', 'build-knowledge-index', 'rag-retrieve',
  'compile-wiki', 'lint-knowledge', 'detect-evolution',
])

function wrapHandler(
  channel: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic IPC dispatcher, 参数类型由各 handler 自行约束
  handler: (event: Electron.IpcMainInvokeEvent, ...args: any[]) => any
): void {
  ipcMain.handle(channel, async (event, ...args) => {
    const isHighFreq = ['save-message', 'get-messages', 'get-conversations', 'get-knowledge-tree'].includes(channel)
    if (!isHighFreq && logger) {
      let preview: string
      if (SENSITIVE_CHANNELS.has(channel)) {
        preview = `avatarId=${typeof args[0] === 'string' ? args[0] : '?'}`
      } else {
        preview = JSON.stringify(args).slice(0, 200)
      }
      logger.activity(channel, preview)
    }
    try {
      return await handler(event, ...args)
    } catch (err) {
      if (logger) logger.error(channel, err instanceof Error ? err : new Error(String(err)))
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
    width: 1280,
    height: 820,
    minWidth: 1024,
    minHeight: 680,
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
    cronScheduler.cancelAll()
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
    dialog.showErrorBox('初始化失败', `核心模块初始化失败：${error instanceof Error ? error.message : String(error)}\n\n应用将退出。`)
    app.quit()
    return
  }
  createWindow()
  if (mainWindow) {
    scheduledTester.setWindow(mainWindow)
    cronScheduler.setWindow(mainWindow)
  }

  // 从 DB 恢复已配置的 cron 定时任务（重启后自动续期）
  try {
    const cronTypes = ['memory-consolidate', 'knowledge-check', 'scheduled-test'] as const
    for (const type of cronTypes) {
      const intervalHours = parseInt(getDb().getSetting(`cron_${type}_interval`) ?? '0', 10) || 0
      if (intervalHours > 0) {
        const avatarId = getDb().getSetting(`cron_${type}_avatar`) ?? undefined
        if (!avatarId) continue
        cronScheduler.schedule({ type, intervalHours, avatarId, enabled: true })
      }
    }
  } catch (err) {
    console.error('[Main] 恢复 cron 任务失败:', err)
  }

  // 每日自动备份（每 24 小时一次，启动时立即执行一次）
  performDatabaseBackup().catch(err => {
    console.warn('[Main] 启动时备份失败:', err instanceof Error ? err.message : String(err))
  })
  backupIntervalId = setInterval(() => {
    performDatabaseBackup().catch(err => {
      console.warn('[Main] 定时备份失败:', err instanceof Error ? err.message : String(err))
    })
  }, 24 * 60 * 60 * 1000)
}).catch((error) => {
  console.error('[Main] app.whenReady() rejected:', error)
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  if (backupIntervalId) {
    clearInterval(backupIntervalId)
    backupIntervalId = null
  }
  scheduledTester.stop()
  cronScheduler.cancelAll()
  if (db) {
    try { db.close() } catch (e) { console.error('[Main] db.close() failed:', e) }
  }
  if (logger) logger.activity('app-quit')
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    if (!db) {
      try { initManagers() } catch (e) { console.error('[Main] re-init failed:', e) }
    }
    createWindow()
    if (mainWindow) {
      scheduledTester.setWindow(mainWindow)
      cronScheduler.setWindow(mainWindow)
    }
  }
})

// ─── 工具函数 ────────────────────────────────────────────────────────────────

const VALID_CRON_TYPES: readonly CronTaskType[] = ['memory-consolidate', 'knowledge-check', 'scheduled-test']

function isCronTaskType(type: string): type is CronTaskType {
  return VALID_CRON_TYPES.includes(type as CronTaskType)
}

/**
 * 原子写文件：先写临时文件再 rename，防止进程崩溃导致目标文件损坏。
 * 对记忆文件（MEMORY.md / USER.md）等关键数据使用此函数代替 writeFile。
 *
 * @param filePath  目标文件的绝对路径
 * @param content   文件内容
 */
async function atomicWriteFile(filePath: string, content: string): Promise<void> {
  const dir = path.dirname(filePath)
  const tmpPath = path.join(dir, `.tmp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`)
  try {
    await fs.promises.writeFile(tmpPath, content, 'utf-8')
    await fs.promises.rename(tmpPath, filePath)
  } catch (err) {
    // 确保临时文件不会残留
    // eslint-disable-next-line @typescript-eslint/no-empty-function -- 临时文件清理失败无需记录
    await fs.promises.unlink(tmpPath).catch(() => {})
    throw err
  }
}

const getKnowledgeManager = (avatarId: string): KnowledgeManager => {
  assertSafeSegment(avatarId, '分身ID')
  if (!knowledgeManagers.has(avatarId)) {
    const knowledgePath = path.join(avatarsPath, avatarId, 'knowledge')
    knowledgeManagers.set(avatarId, new KnowledgeManager(knowledgePath))
  }
  return knowledgeManagers.get(avatarId)!
}

/**
 * 获取或创建分身的 WikiCompiler 实例（缓存复用）。
 *
 * @author zhi.qu
 * @date 2026-04-10
 */
const getWikiCompiler = (avatarId: string): WikiCompiler => {
  assertSafeSegment(avatarId, '分身ID')
  if (!wikiCompilers.has(avatarId)) {
    wikiCompilers.set(avatarId, new WikiCompiler(path.join(avatarsPath, avatarId)))
  }
  return wikiCompilers.get(avatarId)!
}

// ─── IPC 处理器 ──────────────────────────────────────────────────────────────

ipcMain.handle('ping', () => 'pong')

// 加载分身配置（GAP3/GAP6: 重新调用后 systemPrompt 会根据最新技能/知识/记忆重建）
wrapHandler('load-avatar', (_, avatarId: string) => {
  assertSafeSegment(avatarId, '分身ID')
  const config = soulLoader.loadAvatar(avatarId)
  // Feature 7: 缓存 system prompt 供子代理委派使用
  toolRouter.setSystemPrompt(avatarId, config.systemPrompt)
  return config
})

// ─── 会话管理 ────────────────────────────────────────────────────────────────

wrapHandler('create-conversation', (_, title: string, avatarId: string) => {
  assertSafeSegment(avatarId, '分身ID')
  return getDb().createConversation(title, avatarId)
})

wrapHandler('get-conversations', (_, avatarId?: string) => {
  if (avatarId) assertSafeSegment(avatarId, '分身ID')
  return getDb().getConversations(avatarId)
})

/**
 * search-messages: FTS5 全文搜索消息，返回匹配的片段和会话信息。
 */
wrapHandler('search-messages', (_, query: string, avatarId?: string) => {
  if (avatarId) assertSafeSegment(avatarId, '分身ID')
  return getDb().searchMessages(query, avatarId)
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
  // KnowledgeManager.assertSafePath() 已做完整的 path.resolve 前缀校验
  return getKnowledgeManager(avatarId).readFile(relativePath)
})

wrapHandler('write-knowledge-file', (_, avatarId: string, relativePath: string, content: string) => {
  const km = getKnowledgeManager(avatarId)
  km.writeFile(relativePath, content)
  if (!relativePath.toLowerCase().includes('readme')) {
    const fullPath = path.join(avatarsPath, avatarId, 'knowledge', relativePath)
    if (logger) logger.recordGenerated('knowledge', avatarId, fullPath, { relativePath })
  }
})

wrapHandler('search-knowledge', (_, avatarId: string, query: string) => {
  return getKnowledgeManager(avatarId).searchFiles(query)
})

wrapHandler('create-knowledge-file', (_, avatarId: string, relativePath: string, content?: string) => {
  getKnowledgeManager(avatarId).createFile(relativePath, content ?? '')
  const fullPath = path.join(avatarsPath, avatarId, 'knowledge', relativePath)
  if (logger) logger.recordGenerated('knowledge', avatarId, fullPath, { relativePath, action: 'create' })
})

wrapHandler('delete-knowledge-file', (_, avatarId: string, relativePath: string) => {
  getKnowledgeManager(avatarId).deleteFile(relativePath)
})

// ─── 记忆管理（GAP2）────────────────────────────────────────────────────────

wrapHandler('read-memory', async (_, avatarId: string) => {
  assertSafeSegment(avatarId, '分身ID')
  const memoryPath = path.join(avatarsPath, avatarId, 'memory', 'MEMORY.md')
  try {
    return await fs.promises.readFile(memoryPath, 'utf-8')
  } catch {
    return ''
  }
})

wrapHandler('write-memory', async (_, avatarId: string, content: string) => {
  assertSafeSegment(avatarId, '分身ID')
  const memoryPath = path.join(avatarsPath, avatarId, 'memory', 'MEMORY.md')
  const memoryDir = path.dirname(memoryPath)
  await fs.promises.mkdir(memoryDir, { recursive: true })
  await atomicWriteFile(memoryPath, content)
  if (logger) logger.recordGenerated('memory', avatarId, memoryPath)
})

/**
 * get-memory-stats: 返回 MEMORY.md 的容量统计信息。
 */
wrapHandler('get-memory-stats', async (_, avatarId: string) => {
  assertSafeSegment(avatarId, '分身ID')
  const memoryPath = path.join(avatarsPath, avatarId, 'memory', 'MEMORY.md')
  let content = ''
  try {
    content = await fs.promises.readFile(memoryPath, 'utf-8')
  } catch {
    content = ''
  }
  return getMemoryStats(content)
})

/**
 * consolidate-memory: 调用 LLM 整理记忆内容，精简到关键信息。
 * 只返回整理后内容，不写入文件——由调用方决定写入 MEMORY.md 还是 USER.md。
 */
wrapHandler('consolidate-memory', async (_, avatarId: string, content: string, apiKey: string, baseUrl: string) => {
  assertSafeSegment(avatarId, '分身ID')
  const chatModel = getDb().getSetting('chat_model') ?? 'deepseek-chat'
  const callLLM = createLLMFn(apiKey, baseUrl, chatModel)
  const consolidated = await consolidateMemory(content, callLLM)
  if (logger) logger.activity('consolidate-memory', `chars: ${content.length} → ${consolidated.length}`)
  return consolidated
})

// ─── 用户画像管理（Feature 3）────────────────────────────────────────────────

/** read-user-profile: 读取 memory/USER.md 用户画像文件 */
wrapHandler('read-user-profile', async (_, avatarId: string) => {
  assertSafeSegment(avatarId, '分身ID')
  const profilePath = path.join(avatarsPath, avatarId, 'memory', 'USER.md')
  try {
    return await fs.promises.readFile(profilePath, 'utf-8')
  } catch {
    return ''
  }
})

/** write-user-profile: 写入 memory/USER.md 用户画像文件 */
wrapHandler('write-user-profile', async (_, avatarId: string, content: string) => {
  assertSafeSegment(avatarId, '分身ID')
  const profilePath = path.join(avatarsPath, avatarId, 'memory', 'USER.md')
  const profileDir = path.dirname(profilePath)
  await fs.promises.mkdir(profileDir, { recursive: true })
  await atomicWriteFile(profilePath, content)
  if (logger) logger.recordGenerated('memory', avatarId, profilePath, { action: 'user-profile' })
})

// ─── 人格管理 ────────────────────────────────────────────────────────────────

wrapHandler('read-soul', async (_, avatarId: string) => {
  assertSafeSegment(avatarId, '分身ID')
  const soulPath = path.join(avatarsPath, avatarId, 'soul.md')
  try {
    return await fs.promises.readFile(soulPath, 'utf-8')
  } catch {
    return ''
  }
})

wrapHandler('write-soul', async (_, avatarId: string, content: string) => {
  assertSafeSegment(avatarId, '分身ID')
  const soulPath = path.join(avatarsPath, avatarId, 'soul.md')
  await fs.promises.writeFile(soulPath, content, 'utf-8')
  if (logger) logger.recordGenerated('soul', avatarId, soulPath)
})

// ─── 分身管理 ────────────────────────────────────────────────────────────────

wrapHandler('list-avatars', () => {
  return avatarManager.listAvatars()
})

/**
 * get-avatar-soul-intro: 获取指定分身的 soul.md 前 500 字简介。
 * 用于多分身 @提及功能，在当前对话中引入目标分身的身份上下文。
 *
 * @author zhi.qu
 * @date 2026-04-10
 */
wrapHandler('get-avatar-soul-intro', async (_, targetAvatarId: string) => {
  assertSafeSegment(targetAvatarId, '分身ID')
  const soulPath = path.join(avatarsPath, targetAvatarId, 'soul.md')
  try {
    const content = await fs.promises.readFile(soulPath, 'utf-8')
    return content.slice(0, 500)
  } catch {
    return null
  }
})

wrapHandler('create-avatar', (_, id: string, soulContent: string, skills: string[], knowledgeFiles: Array<{ name: string; content: string }>) => {
  avatarManager.createAvatar(id, soulContent, skills, knowledgeFiles)
  // 新分身自动安装默认技能（templates/skills/*.md）— 失败静默，不阻断创建流程
  try {
    installDefaultSkillsSync(id)
  } catch (err) {
    if (logger) logger.error('install-default-skills', err instanceof Error ? err : new Error(String(err)))
  }
  // 归档初始 soul.md
  const soulPath = path.join(avatarsPath, id, 'soul.md')
  if (logger) logger.recordGenerated('soul', id, soulPath, { action: 'create-avatar' })
})

wrapHandler('write-skill-file', (_, avatarId: string, fileName: string, content: string) => {
  assertSafeSegment(avatarId, '分身ID')
  assertSafeSegment(fileName, '技能文件名')
  avatarManager.writeSkillFile(avatarId, fileName, content)
  const skillPath = path.join(avatarsPath, avatarId, 'skills', fileName)
  if (logger) logger.recordGenerated('skill', avatarId, skillPath, { fileName })
})

// BUG4 修复：删除分身时同步清理 DB 中的会话和消息记录
wrapHandler('delete-avatar', (_, id: string) => {
  assertSafeSegment(id, '分身ID')
  getDb().deleteConversationsByAvatar(id)
  avatarManager.deleteAvatar(id)
  knowledgeManagers.delete(id)
  wikiCompilers.delete(id)
  toolRouter.invalidateRetriever(id)
})

wrapHandler('save-avatar-image', (_, avatarId: string, dataUrl: string) => {
  avatarManager.saveAvatarImage(avatarId, dataUrl)
})

wrapHandler('get-avatar-image', (_, avatarId: string) => {
  return avatarManager.getAvatarImage(avatarId)
})

// ─── 测试管理 ────────────────────────────────────────────────────────────────

wrapHandler('get-test-cases', (_, avatarId: string) => {
  assertSafeSegment(avatarId, '分身ID')
  return testManager.getTestCases(avatarId)
})

wrapHandler('get-test-case', (_, avatarId: string, caseId: string) => {
  assertSafeSegment(avatarId, '分身ID')
  return testManager.getTestCase(avatarId, caseId)
})

wrapHandler('create-test-case', (_, avatarId: string, testCase: Omit<TestCase, 'filePath'>) => {
  assertSafeSegment(avatarId, '分身ID')
  return testManager.createTestCase(avatarId, testCase)
})

wrapHandler('delete-test-case', (_, avatarId: string, caseId: string) => {
  assertSafeSegment(avatarId, '分身ID')
  testManager.deleteTestCase(avatarId, caseId)
})

wrapHandler('save-test-report', (_, avatarId: string, report: TestReport) => {
  assertSafeSegment(avatarId, '分身ID')
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
  assertSafeSegment(avatarId, '分身ID')
  return testManager.getLatestReport(avatarId)
})

wrapHandler('get-report-list', (_, avatarId: string) => {
  assertSafeSegment(avatarId, '分身ID')
  return testManager.getReportList(avatarId)
})

// BUG6 修复：runTests 仅返回测试用例数据，实际执行在渲染进程的 TestRunner 中完成
wrapHandler('run-tests', async (_, avatarId: string, caseIds: string[]) => {
  assertSafeSegment(avatarId, '分身ID')
  return testManager.getTestCases(avatarId).filter(c => caseIds.includes(c.id))
})

// ─── 技能管理 ────────────────────────────────────────────────────────────────

wrapHandler('get-skills', (_, avatarId: string) => {
  assertSafeSegment(avatarId, '分身ID')
  return skillManager.getSkills(avatarId)
})

wrapHandler('get-skill', (_, avatarId: string, skillId: string) => {
  assertSafeSegment(avatarId, '分身ID')
  assertSafeSegment(skillId, '技能ID')
  return skillManager.getSkill(avatarId, skillId)
})

wrapHandler('update-skill', (_, avatarId: string, skillId: string, content: string) => {
  assertSafeSegment(avatarId, '分身ID')
  assertSafeSegment(skillId, '技能ID')
  skillManager.updateSkill(avatarId, skillId, content)
  // 归档更新后的技能文件
  const skillPath = path.join(avatarsPath, avatarId, 'skills', `${skillId}.md`)
  if (logger) logger.recordGenerated('skill', avatarId, skillPath, { skillId })
})

wrapHandler('toggle-skill', (_, avatarId: string, skillId: string, enabled: boolean) => {
  assertSafeSegment(avatarId, '分身ID')
  assertSafeSegment(skillId, '技能ID')
  skillManager.toggleSkill(avatarId, skillId, enabled)
})

// ─── 工具调用（GAP4）────────────────────────────────────────────────────────

/**
 * execute-tool-call: 执行 LLM 发起的工具调用，返回结果字符串给渲染进程。
 * avatarId 用于定位该分身的知识库路径。
 */
wrapHandler('execute-tool-call', async (_, avatarId: string, name: string, args: Record<string, unknown>) => {
  assertSafeSegment(avatarId, '分身ID')
  // Feature 7: 子代理委派时需要 LLM 调用函数
  const apiKey = getDb().getSetting('chat_api_key') ?? ''
  const baseUrl = getDb().getSetting('chat_base_url') ?? 'https://api.deepseek.com/v1'
  const chatModel = getDb().getSetting('chat_model') ?? 'deepseek-chat'
  const callLLM = apiKey ? createLLMFn(apiKey, baseUrl, chatModel) : undefined
  return toolRouter.execute(avatarId, { name, arguments: args }, callLLM)
})

/**
 * search-knowledge-chunks: 供渲染进程直接调用的知识检索接口（GAP1）。
 * 返回按相关度排序的知识片段，供 UI 展示或注入上下文。
 */
wrapHandler('search-knowledge-chunks', (_, avatarId: string, query: string, topN?: number) => {
  assertSafeSegment(avatarId, '分身ID')
  const retriever = toolRouter.getRetriever(avatarId)
  return retriever.searchChunks(query, topN ?? 5)
})

// ─── 知识索引与 RAG 检索 ────────────────────────────────────────────────────

/**
 * build-knowledge-index: 为指定分身的知识库构建检索索引（上下文摘要 + 向量嵌入）。
 * 索引持久化到 knowledge/_index/，并刷新 ToolRouter 中的缓存。
 */
wrapHandler('build-knowledge-index', async (_, avatarId: string, apiKey: string, baseUrl: string) => {
  assertSafeSegment(avatarId, '分身ID')
  const knowledgePath = path.join(avatarsPath, avatarId, 'knowledge')
  const retriever = new KnowledgeRetriever(knowledgePath)

  const callLLM = createLLMFn(apiKey, baseUrl, 'qwen-turbo')
  const callEmbedding = createEmbeddingFn(apiKey, baseUrl)

  // 加载已有索引用于增量更新，未存在时全量构建
  const existingIndex = loadIndex(knowledgePath)
  const { contexts, embeddings, hashes } = await buildKnowledgeIndex(
    retriever,
    { callLLM, callEmbedding },
    undefined,
    existingIndex,
  )

  saveIndex(knowledgePath, contexts, embeddings, hashes)
  toolRouter.invalidateRetriever(avatarId)

  return { contextCount: contexts.size, embeddingCount: embeddings.size }
})

/**
 * rag-retrieve: 对用户问题执行程序化 RAG（多跳检索 + 5 规则 prompt 构造）。
 * 返回增强后的 user 消息文本。
 */
wrapHandler('rag-retrieve', async (_, avatarId: string, question: string, apiKey: string, baseUrl: string) => {
  assertSafeSegment(avatarId, '分身ID')
  const retriever = toolRouter.getRetriever(avatarId)

  const callLLM = createLLMFn(apiKey, baseUrl, 'qwen-plus')
  const callEmbedding = createEmbeddingFn(apiKey, baseUrl)

  // Phase 2: 可选注入 wiki/concepts/ 百科内容（设置开关控制，默认关闭）
  let wikiChunks: Array<{ file: string; heading: string; content: string; score: number }> | undefined
  try {
    const wikiInject = getDb().getSetting('wiki_inject_rag')
    if (wikiInject === 'true') {
      const wikiConceptsPath = path.join(avatarsPath, avatarId, 'wiki', 'concepts')
      if (fs.existsSync(wikiConceptsPath)) {
        const wikiRetriever = new KnowledgeRetriever(wikiConceptsPath)
        wikiChunks = wikiRetriever.searchChunks(question, 3)
      }
    }
  } catch (wikiErr) {
    // wiki 注入失败不影响正常 RAG
    void wikiErr
  }

  return retrieveAndBuildPrompt(retriever, question, { callLLM, callEmbedding }, undefined, wikiChunks)
})

// ─── 知识百科（Wiki 融合层）───────────────────────────────────────────────────

/**
 * compile-wiki: 编译知识百科（实体提取 + 概念页生成）。
 * 在 avatar/wiki/ 下生成概念页，不影响 knowledge/ 中的任何内容。
 *
 * @author zhi.qu
 * @date 2026-04-09
 */
wrapHandler('compile-wiki', async (_, avatarId: string, apiKey: string, baseUrl: string) => {
  assertSafeSegment(avatarId, '分身ID')
  const avatarPath = path.join(avatarsPath, avatarId)
  const retriever = toolRouter.getRetriever(avatarId)
  const callLLM = createLLMFn(apiKey, baseUrl, 'qwen-plus')
  const wiki = new WikiCompiler(avatarPath)
  const chunks = retriever.getFullChunks()

  const pages = await wiki.compileConceptPages(chunks, callLLM)
  if (logger) logger.activity('compile-wiki', `avatarId=${avatarId}, pages=${pages.length}`)
  const meta = await wiki.getMeta()
  return { entityCount: meta?.entityCount ?? 0, conceptPageCount: pages.length }
})

/** get-wiki-status: 获取 wiki 编译状态 */
wrapHandler('get-wiki-status', async (_, avatarId: string) => {
  return getWikiCompiler(avatarId).getMeta()
})

/** get-concept-pages: 列出所有概念页 */
wrapHandler('get-concept-pages', async (_, avatarId: string) => {
  return getWikiCompiler(avatarId).getConceptPages()
})

/** read-concept-page: 读取指定概念页内容 */
wrapHandler('read-concept-page', async (_, avatarId: string, name: string) => {
  return getWikiCompiler(avatarId).readConceptPage(name)
})

/**
 * lint-knowledge: 知识自检（矛盾检测 + 重复检测）。
 * 结果保存在 avatar/wiki/lint-report.json，不修改 knowledge/ 中的任何文件。
 *
 * @author zhi.qu
 * @date 2026-04-09
 */
wrapHandler('lint-knowledge', async (_, avatarId: string, apiKey: string, baseUrl: string) => {
  assertSafeSegment(avatarId, '分身ID')
  const avatarPath = path.join(avatarsPath, avatarId)
  const retriever = toolRouter.getRetriever(avatarId)
  const callLLM = createLLMFn(apiKey, baseUrl, 'qwen-turbo')
  const wiki = new WikiCompiler(avatarPath)
  const chunks = retriever.getFullChunks()

  const report = await wiki.lintKnowledge(chunks, callLLM)
  if (logger) logger.activity('lint-knowledge', `avatarId=${avatarId}, issues=${report.issueCount}`)
  return report
})

/** get-lint-report: 获取最近的自检报告 */
wrapHandler('get-lint-report', async (_, avatarId: string) => {
  return getWikiCompiler(avatarId).getLintReport()
})

/** save-wiki-answer: 沉淀优质问答到 wiki/qa/ */
wrapHandler('save-wiki-answer', async (_, avatarId: string, qa: WikiAnswer) => {
  assertSafeSegment(avatarId, '分身ID')
  await getWikiCompiler(avatarId).sedimentAnswer(qa)
  if (logger) logger.activity('save-wiki-answer', `avatarId=${avatarId}, question=${qa.question.slice(0, 50)}`)
})

/** get-wiki-answers: 获取所有沉淀的问答 */
wrapHandler('get-wiki-answers', async (_, avatarId: string) => {
  return getWikiCompiler(avatarId).getAnswers()
})

/**
 * detect-evolution: 检测新导入文件与已有知识的演化差异。
 * 仅报告差异，不修改任何现有文件。
 *
 * @author zhi.qu
 * @date 2026-04-09
 */
wrapHandler('detect-evolution', async (_, avatarId: string, newContent: string, newFileName: string, apiKey: string, baseUrl: string) => {
  assertSafeSegment(avatarId, '分身ID')
  const avatarPath = path.join(avatarsPath, avatarId)
  const retriever = toolRouter.getRetriever(avatarId)
  const callLLM = createLLMFn(apiKey, baseUrl, 'qwen-turbo')
  const wiki = new WikiCompiler(avatarPath)
  const existingChunks = retriever.getFullChunks()

  const report = await wiki.detectEvolution(newContent, newFileName, existingChunks, callLLM)
  if (logger) logger.activity('detect-evolution', `avatarId=${avatarId}, file=${newFileName}, diffs=${report.diffs.length}`)
  return report
})

/** get-evolution-report: 获取最近的知识演化检测报告 */
wrapHandler('get-evolution-report', async (_, avatarId: string) => {
  return getWikiCompiler(avatarId).getEvolutionReport()
})

/**
 * preserve-raw-file: 保存原始导入文件到 knowledge/_raw/。
 * 保留原始 PDF/Word 等文件供追溯，不影响 .md 知识文件过滤。
 *
 * @author zhi.qu
 * @date 2026-04-09
 */
wrapHandler('preserve-raw-file', async (_, avatarId: string, originalFilePath: string) => {
  assertSafeSegment(avatarId, '分身ID')
  const resolved = path.resolve(originalFilePath)
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    throw new Error(`文件不存在或不是文件: ${originalFilePath}`)
  }
  const homedir = os.homedir()
  if (!resolved.startsWith(homedir + path.sep) && resolved !== homedir) {
    throw new Error(`安全限制：仅允许保存用户主目录下的文件`)
  }
  // 排除敏感目录，防止泄露密钥、凭证等
  const SENSITIVE_DIRS = ['.ssh', '.gnupg', '.aws', '.env', '.credentials']
  const relToHome = path.relative(homedir, resolved)
  const firstSegment = relToHome.split(path.sep)[0]
  if (SENSITIVE_DIRS.includes(firstSegment)) {
    throw new Error(`安全限制：禁止访问敏感目录 ${firstSegment}`)
  }
  const knowledgePath = path.join(avatarsPath, avatarId, 'knowledge')
  const relativePath = await WikiCompiler.preserveRawFile(knowledgePath, resolved)
  if (logger) logger.activity('preserve-raw-file', `avatarId=${avatarId}, file=${relativePath}`)
  return relativePath
})

// ─── 文档导入（GAP9a）────────────────────────────────────────────────────────

/** 打开系统文件选择对话框，返回用户选中的文件路径 */
wrapHandler('show-open-dialog', async (_, options: Electron.OpenDialogOptions) => {
  const win = mainWindow ?? BrowserWindow.getFocusedWindow()
  if (!win) return { canceled: true, filePaths: [] }
  return dialog.showOpenDialog(win, options)
})

/**
 * parse-document: 解析文件（PDF/Word/Excel/图片/文本）。
 * 返回提取的文本和图片（base64 data URL），图片由渲染进程进一步 OCR。
 */
wrapHandler('parse-document', async (_, filePath: string) => {
  if (!path.isAbsolute(filePath)) {
    throw new Error(`非法文件路径（必须为绝对路径）: ${filePath}`)
  }
  // parseFile 内部已有 fs.promises.stat 校验，无需重复同步检查
  return documentParser.parseFile(filePath)
})

/**
 * write-excel-data: Excel 导入时把结构化 JSON 写到 knowledge/_excel/<basename>.json。
 * structuredData 随 parseDocument 返回，由渲染进程传回主进程落盘。
 * 该 JSON 供 tool-router 的 query_excel 工具精确过滤行。
 */
wrapHandler('write-excel-data', (_, avatarId: string, basename: string, data: unknown) => {
  assertSafeSegment(avatarId, '分身ID')
  assertSafeSegment(basename, 'Excel 文件名')
  const excelDir = path.join(avatarsPath, avatarId, 'knowledge', '_excel')
  if (!fs.existsSync(excelDir)) {
    fs.mkdirSync(excelDir, { recursive: true })
  }
  const jsonPath = path.join(excelDir, `${basename}.json`)
  fs.writeFileSync(jsonPath, JSON.stringify(data, null, 2), 'utf-8')
  if (logger) logger.activity('write-excel-data', `avatarId=${avatarId}, file=${basename}.json`)
  return jsonPath
})

// ─── 批量 / 归档导入（Feature: 2026-04-13）───────────────────────────────────

/**
 * 批量导入返回结果。
 */
interface BatchImportResult {
  imported: Array<{ fileName: string; targetPath: string }>
  skipped: Array<{ path: string; reason: string }>
  failed: Array<{ path: string; error: string }>
}

/**
 * 批量导入核心：给定候选文件列表，逐个 parse → 写入 knowledge/。
 * 跳过 LLM 格式化以避免每文件调一次 LLM（批量场景用户要的是快而不是精）。
 * 单文件导入仍走 KnowledgePanel.handleImportDocument 路径享受 LLM 格式化。
 */
async function batchImportFiles(
  avatarId: string,
  files: string[],
): Promise<{
  imported: Array<{ fileName: string; targetPath: string }>
  failed: Array<{ path: string; error: string }>
}> {
  assertSafeSegment(avatarId, '分身ID')
  const knowledgePath = path.join(avatarsPath, avatarId, 'knowledge')
  if (!fs.existsSync(knowledgePath)) {
    throw new Error(`分身 knowledge 目录不存在: ${avatarId}`)
  }

  const imported: Array<{ fileName: string; targetPath: string }> = []
  const failed: Array<{ path: string; error: string }> = []
  const total = files.length

  for (let i = 0; i < files.length; i++) {
    const filePath = files[i]
    const fileName = path.basename(filePath)

    // 进度事件：解析中
    mainWindow?.webContents.send('knowledge-import-progress', {
      current: i,
      total,
      fileName,
      phase: 'parsing',
    })

    try {
      const parsed = await documentParser.parseFile(filePath)
      // 批量导入跳过 LLM formatDocument：直接用 parsed.text 作为内容
      // 图片在批量模式下跳过 OCR（渲染进程才有 ocrModel）
      // 批量导入的文件默认标记 rag_only，不塞进 system prompt（防止 2.9M 字符撑爆上下文）
      // 只通过 search_knowledge / query_excel 按需检索
      const frontmatter = `---\nrag_only: true\nsource: ${parsed.fileType}\n---\n\n`
      const header = `# ${parsed.fileName}\n\n> 导入自: ${parsed.fileName}\n> 类型: ${parsed.fileType}\n> 批量导入（未经 LLM 格式化）\n\n---\n\n`
      const finalContent = frontmatter + header + (parsed.text || '_（无文本内容）_')

      // 目标文件名：清理非法字符后 + .md
      const baseName = fileName
        .replace(/\.[^.]+$/, '')
        .replace(/[^a-zA-Z0-9\u4e00-\u9fa5_-]/g, '_')
      const relativePath = `${baseName}.md`

      // 直接调 KnowledgeManager 写入
      const kmgr = knowledgeManagers.get(avatarId) ?? new KnowledgeManager(knowledgePath)
      knowledgeManagers.set(avatarId, kmgr)
      kmgr.writeFile(relativePath, finalContent)

      imported.push({ fileName, targetPath: relativePath })

      // 进度事件：已写入
      mainWindow?.webContents.send('knowledge-import-progress', {
        current: i + 1,
        total,
        fileName,
        phase: 'written',
      })
    } catch (err) {
      failed.push({ path: filePath, error: err instanceof Error ? err.message : String(err) })
      mainWindow?.webContents.send('knowledge-import-progress', {
        current: i + 1,
        total,
        fileName,
        phase: 'failed',
      })
    }
  }

  return { imported, failed }
}

/**
 * import-folder: 导入整个文件夹。walk → batch parse → write。
 * 所有步骤在主进程完成，避免 N 次 IPC 往返。
 */
wrapHandler('import-folder', async (_, avatarId: string, folderPath: string): Promise<BatchImportResult> => {
  assertSafeSegment(avatarId, '分身ID')
  if (!path.isAbsolute(folderPath)) {
    throw new Error(`非法文件夹路径（必须为绝对路径）: ${folderPath}`)
  }
  // 安全限制：仅允许用户主目录下
  const homedir = os.homedir()
  const resolved = path.resolve(folderPath)
  if (!resolved.startsWith(homedir + path.sep) && resolved !== homedir) {
    throw new Error(`安全限制：仅允许导入用户主目录下的文件夹`)
  }

  const { files, skipped } = await walkFolder(resolved)
  const { imported, failed } = await batchImportFiles(avatarId, files)
  return { imported, skipped, failed }
})

/**
 * import-archive: 解压归档到临时目录，然后走 walkFolder + batchImportFiles，最后清理 temp。
 * 支持 .zip / .tar.gz / .tgz / .7z / .rar。
 */
wrapHandler('import-archive', async (_, avatarId: string, archivePath: string): Promise<BatchImportResult> => {
  assertSafeSegment(avatarId, '分身ID')
  if (!path.isAbsolute(archivePath)) {
    throw new Error(`非法归档路径（必须为绝对路径）: ${archivePath}`)
  }
  const homedir = os.homedir()
  const resolved = path.resolve(archivePath)
  if (!resolved.startsWith(homedir + path.sep) && resolved !== homedir) {
    throw new Error(`安全限制：仅允许导入用户主目录下的归档`)
  }

  const tempDir = await makeTempExtractDir()
  try {
    mainWindow?.webContents.send('knowledge-import-progress', {
      current: 0,
      total: 0,
      fileName: path.basename(archivePath),
      phase: 'extracting',
    })
    await extractArchive(resolved, tempDir)

    const { files, skipped } = await walkFolder(tempDir)
    const { imported, failed } = await batchImportFiles(avatarId, files)
    return { imported, skipped, failed }
  } finally {
    await cleanupTempDir(tempDir)
  }
})

/**
 * enhance-knowledge-files: 对批量导入的知识文件逐个补跑 LLM 格式化。
 * 识别条件：文件含 `rag_only: true` frontmatter + `批量导入` 标记。
 * 格式化完成后保留 rag_only frontmatter（大文件不适合塞 system prompt）。
 * 通过 knowledge-enhance-progress 事件上报进度。
 */
wrapHandler('enhance-knowledge-files', async (_, avatarId: string, apiKey: string, baseUrl: string, model: string, targetFiles?: string[]): Promise<{ enhanced: number; failed: number; total: number }> => {
  assertSafeSegment(avatarId, '分身ID')
  const knowledgePath = path.join(avatarsPath, avatarId, 'knowledge')
  if (!fs.existsSync(knowledgePath)) {
    throw new Error(`分身 knowledge 目录不存在: ${avatarId}`)
  }

  let allFiles: string[]

  /** 检查文件是否已经被增强过（source: enhanced），支持断点续跑 */
  function isAlreadyEnhanced(filePath: string): boolean {
    try {
      const head = fs.readFileSync(filePath, 'utf-8').slice(0, 200)
      return head.includes('source: enhanced')
    } catch { return false }
  }

  if (targetFiles && targetFiles.length > 0) {
    // 指定了文件列表（批量导入后自动调用），跳过已增强的（断点续跑）
    allFiles = targetFiles
      .map(f => path.join(knowledgePath, f))
      .filter(f => fs.existsSync(f) && !isAlreadyEnhanced(f))
  } else {
    // 手动点 ENHANCE 按钮，扫描所有需要增强的文件（含 rag_only + 批量导入标记，排除已增强的）
    allFiles = []
    function scanDir(dir: string): void {
      const entries = fs.readdirSync(dir, { withFileTypes: true })
      for (const entry of entries) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory() && !entry.name.startsWith('_')) {
          scanDir(full)
        } else if (entry.isFile() && entry.name.endsWith('.md')) {
          const content = fs.readFileSync(full, 'utf-8')
          if (content.includes('rag_only: true') && content.includes('批量导入') && !content.includes('source: enhanced')) {
            allFiles.push(full)
          }
        }
      }
    }
    scanDir(knowledgePath)
  }

  if (allFiles.length === 0) {
    return { enhanced: 0, failed: 0, total: 0 }
  }

  const callLLM: LLMCallFn = createLLMFn(apiKey, baseUrl, model)
  let enhanced = 0
  let failed = 0
  const total = allFiles.length

  for (let i = 0; i < allFiles.length; i++) {
    const filePath = allFiles[i]
    const fileName = path.basename(filePath)
    const relPath = path.relative(knowledgePath, filePath)

    mainWindow?.webContents.send('knowledge-enhance-progress', {
      current: i,
      total,
      fileName,
      phase: 'formatting',
    })

    try {
      const raw = fs.readFileSync(filePath, 'utf-8')
      // 去掉 frontmatter：匹配开头的 ---\n...\n---，允许各种空白
      let body = raw
      const fmEnd = raw.match(/^---\r?\n[\s\S]*?\r?\n---\s*\r?\n/)
      if (fmEnd) {
        body = raw.slice(fmEnd[0].length)
      }
      // 去掉批量导入 header（# 标题 + > 导入自... + ---），取 --- 之后的纯内容
      const headerEnd = body.indexOf('\n---\n')
      const plainText = headerEnd >= 0 ? body.slice(headerEnd + 5).trim() : body.trim()

      if (!plainText || plainText.trim().length < 50) {
        // 内容太少，跳过
        mainWindow?.webContents.send('knowledge-enhance-progress', {
          current: i + 1, total, fileName, phase: 'skipped',
        })
        continue
      }

      const docTitle = fileName.replace(/\.md$/, '')
      const formatted = await formatDocument(
        plainText,
        docTitle,
        fileName,
        callLLM,
        (progress) => {
          mainWindow?.webContents.send('knowledge-enhance-progress', {
            current: i,
            total,
            fileName,
            phase: `formatting (${progress.current}/${progress.total})`,
          })
        },
      )

      // 写回：保留 rag_only frontmatter，替换内容
      const newContent = `---\nrag_only: true\nsource: enhanced\n---\n\n${formatted}`
      fs.writeFileSync(filePath, newContent, 'utf-8')
      enhanced++

      mainWindow?.webContents.send('knowledge-enhance-progress', {
        current: i + 1, total, fileName, phase: 'done',
      })
    } catch (err) {
      failed++
      console.error(`[enhance] ${relPath} 格式化失败:`, err instanceof Error ? err.message : String(err))
      mainWindow?.webContents.send('knowledge-enhance-progress', {
        current: i + 1, total, fileName, phase: 'failed',
      })
    }
  }

  return { enhanced, failed, total }
})

/**
 * install-default-skills: 把 templates/skills/*.md 拷贝到指定分身的 skills/ 目录。
 * 跳过已存在的技能文件（不覆盖用户自定义）。用于：
 *   1. 创建新分身时自动调用（见 create-avatar handler）
 *   2. 一次性回填脚本（scripts/retrofit-skills.ts）
 */
wrapHandler('install-default-skills', (_, avatarId: string) => {
  assertSafeSegment(avatarId, '分身ID')
  return installDefaultSkillsSync(avatarId)
})

/**
 * 同步版本，供 create-avatar handler 内部直接调用。
 * 返回拷贝的文件名列表。
 */
function installDefaultSkillsSync(avatarId: string): string[] {
  const templatesPath = resolveTemplatesPath()
  const srcDir = path.join(templatesPath, 'skills')
  if (!fs.existsSync(srcDir) || !fs.statSync(srcDir).isDirectory()) {
    return [] // 模板目录不存在，视为无默认技能
  }
  const destDir = path.join(avatarsPath, avatarId, 'skills')
  if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true })
  }

  const installed: string[] = []
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue
    const destPath = path.join(destDir, entry.name)
    if (fs.existsSync(destPath)) continue // 不覆盖用户自定义
    const content = fs.readFileSync(path.join(srcDir, entry.name), 'utf-8')
    fs.writeFileSync(destPath, content, 'utf-8')
    installed.push(entry.name)
  }
  if (logger && installed.length > 0) {
    logger.activity('install-default-skills', `avatarId=${avatarId}, installed=${installed.join(',')}`)
  }
  return installed
}

// ─── 定时自检（GAP14）────────────────────────────────────────────────────────

/**
 * start-scheduled-test: 启动定时自检（每 N 小时触发一次）。
 * intervalHours = 0 表示停止。
 */
wrapHandler('start-scheduled-test', (_, avatarId: string, intervalHours: number) => {
  assertSafeSegment(avatarId, '分身ID')
  // 与 CronScheduler 的 scheduled-test 互斥，避免双重触发
  cronScheduler.cancel('scheduled-test')
  getDb().setSetting('cron_scheduled-test_interval', '0')

  scheduledTester.start(avatarId, intervalHours)
  getDb().setSetting(`scheduled_test_avatar`, avatarId)
  getDb().setSetting(`scheduled_test_interval`, String(intervalHours))
})

wrapHandler('stop-scheduled-test', () => {
  scheduledTester.stop()
  getDb().setSetting(`scheduled_test_interval`, '0')
})

// ─── 定时任务（Feature 8）────────────────────────────────────────────────────

/**
 * schedule-cron: 启动或更新定时任务。
 * type: 'memory-consolidate' | 'knowledge-check' | 'scheduled-test'
 * intervalHours: 0 表示禁用
 */
wrapHandler('schedule-cron', (_, type: string, intervalHours: number, avatarId?: string) => {
  if (!isCronTaskType(type)) {
    throw new Error(`无效的定时任务类型: ${type}`)
  }
  if (avatarId) assertSafeSegment(avatarId, '分身ID')
  if (intervalHours > 0 && type !== 'scheduled-test' && !avatarId) {
    throw new Error(`任务 ${type} 启用时必须提供分身ID`)
  }
  // 与 ScheduledTester 的 scheduled-test 互斥，避免双重触发
  if (type === 'scheduled-test') {
    scheduledTester.stop()
    getDb().setSetting('scheduled_test_interval', '0')
  }
  cronScheduler.schedule({
    type,
    intervalHours,
    avatarId,
    enabled: intervalHours > 0,
  })
  getDb().setSetting(`cron_${type}_interval`, String(intervalHours))
  if (avatarId) getDb().setSetting(`cron_${type}_avatar`, avatarId)
})

/** cancel-cron: 取消指定类型的定时任务 */
wrapHandler('cancel-cron', (_, type: string) => {
  if (!isCronTaskType(type)) {
    throw new Error(`无效的定时任务类型: ${type}`)
  }
  cronScheduler.cancel(type)
  getDb().setSetting(`cron_${type}_interval`, '0')
  getDb().setSetting(`cron_${type}_avatar`, '')
})

/** get-cron-config: 读取定时任务配置 */
wrapHandler('get-cron-config', () => {
  const types: CronTaskType[] = ['memory-consolidate', 'knowledge-check', 'scheduled-test']
  return types.map(type => ({
    type,
    intervalHours: parseInt(getDb().getSetting(`cron_${type}_interval`) ?? '0', 10) || 0,
    avatarId: getDb().getSetting(`cron_${type}_avatar`),
    enabled: cronScheduler.getRunningTypes().includes(type),
  }))
})

// ─── 数据库备份 ────────────────────────────────────────────────────────────────

/**
 * db-backup: 手动触发数据库备份，或由定时任务调用。
 * 备份文件保存到 userData/backups/soul-YYYY-MM-DD.db，最多保留 7 份。
 *
 * @author zhi.qu
 * @date 2026-04-10
 */
wrapHandler('db-backup', async () => {
  await performDatabaseBackup()
})

/**
 * 执行数据库备份并清理过期备份（内部工具函数，供 IPC 和定时任务复用）。
 * 每日一份，超过 7 份则删除最旧的文件。
 */
async function performDatabaseBackup(): Promise<string> {
  const backupDir = path.join(app.getPath('userData'), 'backups')
  await fs.promises.mkdir(backupDir, { recursive: true })

  const today = localDateString() // YYYY-MM-DD 本地时区
  const destPath = path.join(backupDir, `soul-${today}.db`)
  await getDb().backup(destPath)

  // 清理超出保留数量（7份）的旧备份
  try {
    const files = (await fs.promises.readdir(backupDir))
      .filter(f => f.startsWith('soul-') && f.endsWith('.db'))
      .sort() // 按文件名升序（日期升序），最旧在前
    const MAX_BACKUPS = 7
    if (files.length > MAX_BACKUPS) {
      const toDelete = files.slice(0, files.length - MAX_BACKUPS)
      for (const f of toDelete) {
        await fs.promises.unlink(path.join(backupDir, f)).catch(() => { /* 忽略删除失败 */ })
      }
    }
  } catch (cleanErr) {
    console.warn('[Main] 清理旧备份失败:', cleanErr instanceof Error ? cleanErr.message : String(cleanErr))
  }

  if (logger) logger.activity('db-backup', `dest=${destPath}`)
  return destPath
}

/**
 * export-conversation: 将会话导出为 Markdown 文件，通过系统保存对话框让用户选择路径。
 *
 * @author zhi.qu
 * @date 2026-04-10
 */
wrapHandler('export-conversation', async (_, conversationId: string, format: 'markdown' | 'pdf') => {
  const messages = getDb().getMessages(conversationId)
  const conversation = getDb().getConversation(conversationId)
  const title = conversation?.title ?? '对话'

  if (format === 'markdown') {
    const lines: string[] = [
      `# ${title}`,
      '',
      `> 导出时间：${new Date().toLocaleString('zh-CN')}`,
      '',
      '---',
      '',
    ]
    // 过滤 tool/system 角色，只导出 user 和 assistant 消息
    for (const msg of messages.filter(m => m.role === 'user' || m.role === 'assistant')) {
      const role = msg.role === 'user' ? '你' : '专家'
      lines.push(`## ${role}`, '', msg.content, '')
    }
    const content = lines.join('\n')

    const { canceled, filePath } = await dialog.showSaveDialog({
      title: '导出对话为 Markdown',
      defaultPath: `${title}.md`,
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    })
    if (canceled || !filePath) return
    await fs.promises.writeFile(filePath, content, 'utf-8')
    if (logger) logger.activity('export-conversation', `format=markdown file=${filePath}`)
    await shell.openPath(path.dirname(filePath))
  } else {
    throw new Error('PDF 导出暂不支持，请使用 Markdown 格式')
  }
})

// ─── 提示词模板库 ─────────────────────────────────────────────────────────────

/**
 * 提示词模板 CRUD IPC 处理器。
 *
 * @author zhi.qu
 * @date 2026-04-10
 */
wrapHandler('create-prompt-template', (_, avatarId: string, title: string, content: string) => {
  assertSafeSegment(avatarId, '分身ID')
  return getDb().createPromptTemplate(avatarId, title, content)
})

wrapHandler('get-prompt-templates', (_, avatarId: string) => {
  assertSafeSegment(avatarId, '分身ID')
  return getDb().getPromptTemplates(avatarId)
})

wrapHandler('update-prompt-template', (_, id: string, avatarId: string, title: string, content: string) => {
  assertSafeSegment(avatarId, '分身ID')
  getDb().updatePromptTemplate(id, avatarId, title, content)
})

wrapHandler('delete-prompt-template', (_, id: string, avatarId: string) => {
  assertSafeSegment(avatarId, '分身ID')
  getDb().deletePromptTemplate(id, avatarId)
})

// ─── 模板管理 ────────────────────────────────────────────────────────────────

/** 获取指定模板文件的原始内容 */
wrapHandler('get-template', (_, templateName: string) => {
  assertSafeSegment(templateName, '模板名称')
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
  scheduledTester.notifyTestResult(passed, total, failed)
})

// ─── 日志系统 IPC ─────────────────────────────────────────────────────────────

/**
 * log-event: 渲染进程主动上报日志（LLM 调用、面板操作等无法在主进程捕获的事件）
 * 使用 ipcMain.handle 避免 wrapHandler 循环记录日志
 */
ipcMain.handle('log-event', (_, level: 'info' | 'warn' | 'error', action: string, detail?: string) => {
  if (logger) logger.logEvent(level, action, detail)
})

wrapHandler('get-activity-logs', (_, date?: string) => {
  return logger ? logger.readActivityLog(date) : ''
})

wrapHandler('get-error-logs', (_, date?: string) => {
  return logger ? logger.readErrorLog(date) : ''
})

wrapHandler('get-generated-index', () => {
  return logger ? logger.readGeneratedIndex() : []
})

wrapHandler('open-logs-folder', async () => {
  const logsDir = path.join(app.getPath('userData'), 'logs')
  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true })
  }
  await shell.openPath(logsDir)
  return logsDir
})

wrapHandler('export-error-log', async (_, days = 3) => {
  const normalizedDays = Number.isFinite(days) ? Math.max(1, Math.min(30, Math.floor(days))) : 3
  const logsDir = path.join(app.getPath('userData'), 'logs')
  const desktopDir = app.getPath('desktop')
  const lines: string[] = []

  for (let i = 0; i < normalizedDays; i++) {
    const date = localDateString(new Date(Date.now() - i * 86400000))
    const errorFile = path.join(logsDir, `error-${date}.log`)
    try {
      const content = (await fs.promises.readFile(errorFile, 'utf-8')).trim()
      if (content) {
        lines.push(`\n========== ${date} ==========\n${content}`)
      }
    } catch (readErr) {
      // 文件不存在，跳过
      void readErr
    }
  }

  if (lines.length === 0) {
    return { success: false, message: '最近没有错误日志' }
  }

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
  await fs.promises.writeFile(exportFile, content, 'utf-8')

  await shell.openPath(desktopDir)

  return { success: true, filePath: exportFile }
})

/**
 * check-update: 从 GitHub Releases 获取最新版本号，与本地版本比较。
 * 轻量实现：只检查版本号 + 返回下载链接，不自动下载安装。
 */
wrapHandler('check-update', async (): Promise<{
  hasUpdate: boolean
  currentVersion: string
  latestVersion?: string
  downloadUrl?: string
  releaseNotes?: string
}> => {
  const currentVersion = app.getVersion()
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 10000)
    const res = await fetch(
      'https://api.github.com/repos/kidcrazequ/AI-avatar/releases/latest',
      {
        headers: { 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'Soul-Desktop' },
        signal: controller.signal,
      },
    )
    clearTimeout(timeout)
    if (!res.ok) {
      console.warn(`[check-update] GitHub API 返回 ${res.status}`)
      return { hasUpdate: false, currentVersion }
    }
    const data = await res.json() as { tag_name?: string; html_url?: string; body?: string }
    const latestVersion = (data.tag_name || '').replace(/^v/, '')
    if (!latestVersion) return { hasUpdate: false, currentVersion }

    const hasUpdate = compareVersions(latestVersion, currentVersion) > 0
    return {
      hasUpdate,
      currentVersion,
      latestVersion,
      downloadUrl: hasUpdate ? data.html_url : undefined,
      releaseNotes: hasUpdate ? (data.body || '').slice(0, 500) : undefined,
    }
  } catch (err) {
    // 网络失败静默，不影响启动
    console.warn('[check-update] 检查更新失败:', err instanceof Error ? err.message : String(err))
    return { hasUpdate: false, currentVersion }
  }
})

/** 简单语义化版本比较：返回 1(a>b) / 0(a==b) / -1(a<b) */
function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] || 0
    const nb = pb[i] || 0
    if (na > nb) return 1
    if (na < nb) return -1
  }
  return 0
}
