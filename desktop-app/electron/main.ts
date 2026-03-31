import { app, BrowserWindow, ipcMain, dialog } from 'electron'
import path from 'path'
import fs from 'fs'
import { SoulLoader } from './soul-loader'
import { DatabaseManager } from './database'
import { KnowledgeManager } from './knowledge-manager'
import { AvatarManager } from './avatar-manager'
import { TestManager } from './test-manager'
import { SkillManager } from './skill-manager'
import { ToolRouter } from './tool-router'
import { KnowledgeRetriever } from './knowledge-retriever'
import { DocumentParser } from './document-parser'
import { ScheduledTester } from './scheduled-tester'

let mainWindow: BrowserWindow | null = null

/**
 * BUG2 修复：生产环境使用 userData/avatars 作为运行时路径；
 * 首次启动时从 process.resourcesPath 中的打包资源初始化。
 */
function resolveAvatarsPath(): string {
  if (process.env.NODE_ENV === 'development') {
    return path.join(__dirname, '../../avatars')
  }
  const userAvatarsPath = path.join(app.getPath('userData'), 'avatars')
  const resourceAvatarsPath = path.join(process.resourcesPath, 'avatars')
  // BUG3 修复：首次运行时从打包资源初始化用户数据目录
  if (!fs.existsSync(userAvatarsPath) && fs.existsSync(resourceAvatarsPath)) {
    fs.cpSync(resourceAvatarsPath, userAvatarsPath, { recursive: true })
  }
  return userAvatarsPath
}

// 知识库管理器缓存
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

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
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
  })
}

app.whenReady().then(() => {
  avatarsPath = resolveAvatarsPath()
  soulLoader = new SoulLoader(avatarsPath)
  db = new DatabaseManager()
  avatarManager = new AvatarManager(avatarsPath)
  testManager = new TestManager(avatarsPath)
  skillManager = new SkillManager(avatarsPath)
  toolRouter = new ToolRouter(avatarsPath)
  createWindow()
  scheduledTester.setWindow(mainWindow!)
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
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
ipcMain.handle('load-avatar', async (_, avatarId: string) => {
  return soulLoader.loadAvatar(avatarId)
})

// ─── 会话管理 ────────────────────────────────────────────────────────────────

ipcMain.handle('create-conversation', (_, title: string, avatarId: string) => {
  return db.createConversation(title, avatarId)
})

ipcMain.handle('get-conversations', (_, avatarId?: string) => {
  return db.getConversations(avatarId)
})

ipcMain.handle('get-conversation', (_, id: string) => {
  return db.getConversation(id)
})

ipcMain.handle('update-conversation-title', (_, id: string, title: string) => {
  db.updateConversationTitle(id, title)
})

ipcMain.handle('delete-conversation', (_, id: string) => {
  db.deleteConversation(id)
})

// ─── 消息管理 ────────────────────────────────────────────────────────────────

ipcMain.handle('save-message', (_, conversationId: string, role: 'user' | 'assistant' | 'tool', content: string, toolCallId?: string, imageUrls?: string[]) => {
  return db.saveMessage(conversationId, role, content, toolCallId, imageUrls)
})

ipcMain.handle('get-messages', (_, conversationId: string) => {
  return db.getMessages(conversationId)
})

// ─── 设置管理 ────────────────────────────────────────────────────────────────

ipcMain.handle('get-setting', (_, key: string) => {
  return db.getSetting(key)
})

ipcMain.handle('set-setting', (_, key: string, value: string) => {
  db.setSetting(key, value)
})

// ─── 知识库管理 ──────────────────────────────────────────────────────────────

ipcMain.handle('get-knowledge-tree', (_, avatarId: string) => {
  return getKnowledgeManager(avatarId).getKnowledgeTree()
})

ipcMain.handle('read-knowledge-file', (_, avatarId: string, relativePath: string) => {
  return getKnowledgeManager(avatarId).readFile(relativePath)
})

ipcMain.handle('write-knowledge-file', (_, avatarId: string, relativePath: string, content: string) => {
  getKnowledgeManager(avatarId).writeFile(relativePath, content)
})

ipcMain.handle('search-knowledge', (_, avatarId: string, query: string) => {
  return getKnowledgeManager(avatarId).searchFiles(query)
})

// GAP7 修复：注册缺失的知识文件 CRUD IPC
ipcMain.handle('create-knowledge-file', (_, avatarId: string, relativePath: string, content?: string) => {
  getKnowledgeManager(avatarId).createFile(relativePath, content ?? '')
})

ipcMain.handle('delete-knowledge-file', (_, avatarId: string, relativePath: string) => {
  getKnowledgeManager(avatarId).deleteFile(relativePath)
})

// ─── 记忆管理（GAP2）────────────────────────────────────────────────────────

ipcMain.handle('read-memory', (_, avatarId: string) => {
  const memoryPath = path.join(avatarsPath, avatarId, 'memory', 'MEMORY.md')
  try {
    return fs.readFileSync(memoryPath, 'utf-8')
  } catch {
    return ''
  }
})

ipcMain.handle('write-memory', (_, avatarId: string, content: string) => {
  const memoryPath = path.join(avatarsPath, avatarId, 'memory', 'MEMORY.md')
  const memoryDir = path.dirname(memoryPath)
  if (!fs.existsSync(memoryDir)) {
    fs.mkdirSync(memoryDir, { recursive: true })
  }
  fs.writeFileSync(memoryPath, content, 'utf-8')
})

// ─── 分身管理 ────────────────────────────────────────────────────────────────

ipcMain.handle('list-avatars', () => {
  return avatarManager.listAvatars()
})

ipcMain.handle('create-avatar', (_, id: string, soulContent: string, skills: string[], knowledgeFiles: Array<{ name: string; content: string }>) => {
  avatarManager.createAvatar(id, soulContent, skills, knowledgeFiles)
})

ipcMain.handle('write-skill-file', (_, avatarId: string, fileName: string, content: string) => {
  avatarManager.writeSkillFile(avatarId, fileName, content)
})

// BUG4 修复：删除分身时同步清理 DB 中的会话和消息记录
ipcMain.handle('delete-avatar', (_, id: string) => {
  db.deleteConversationsByAvatar(id)
  avatarManager.deleteAvatar(id)
  knowledgeManagers.delete(id)
})

// ─── 测试管理 ────────────────────────────────────────────────────────────────

ipcMain.handle('get-test-cases', (_, avatarId: string) => {
  return testManager.getTestCases(avatarId)
})

ipcMain.handle('get-test-case', (_, avatarId: string, caseId: string) => {
  return testManager.getTestCase(avatarId, caseId)
})

ipcMain.handle('create-test-case', (_, avatarId: string, testCase: any) => {
  return testManager.createTestCase(avatarId, testCase)
})

ipcMain.handle('delete-test-case', (_, avatarId: string, caseId: string) => {
  testManager.deleteTestCase(avatarId, caseId)
})

ipcMain.handle('save-test-report', (_, avatarId: string, report: any) => {
  testManager.saveTestReport(avatarId, report)
})

ipcMain.handle('get-latest-report', (_, avatarId: string) => {
  return testManager.getLatestReport(avatarId)
})

ipcMain.handle('get-report-list', (_, avatarId: string) => {
  return testManager.getReportList(avatarId)
})

// BUG6 修复：runTests 仅返回测试用例数据，实际执行在渲染进程的 TestRunner 中完成
// 进度事件通过 webContents.send 推送，不通过回调参数传递
ipcMain.handle('run-tests', async (_, avatarId: string, caseIds: string[]) => {
  return testManager.getTestCases(avatarId).filter(c => caseIds.includes(c.id))
})

// ─── 技能管理 ────────────────────────────────────────────────────────────────

ipcMain.handle('get-skills', (_, avatarId: string) => {
  return skillManager.getSkills(avatarId)
})

ipcMain.handle('get-skill', (_, avatarId: string, skillId: string) => {
  return skillManager.getSkill(avatarId, skillId)
})

ipcMain.handle('update-skill', (_, avatarId: string, skillId: string, content: string) => {
  skillManager.updateSkill(avatarId, skillId, content)
})

ipcMain.handle('toggle-skill', (_, avatarId: string, skillId: string, enabled: boolean) => {
  skillManager.toggleSkill(avatarId, skillId, enabled)
})

// ─── 工具调用（GAP4）────────────────────────────────────────────────────────

/**
 * execute-tool-call: 执行 LLM 发起的工具调用，返回结果字符串给渲染进程。
 * avatarId 用于定位该分身的知识库路径。
 */
ipcMain.handle('execute-tool-call', async (_, avatarId: string, name: string, args: Record<string, unknown>) => {
  return toolRouter.execute(avatarId, { name, arguments: args })
})

/**
 * search-knowledge-chunks: 供渲染进程直接调用的知识检索接口（GAP1）。
 * 返回按相关度排序的知识片段，供 UI 展示或注入上下文。
 */
ipcMain.handle('search-knowledge-chunks', (_, avatarId: string, query: string, topN?: number) => {
  const knowledgePath = path.join(avatarsPath, avatarId, 'knowledge')
  const retriever = new KnowledgeRetriever(knowledgePath)
  return retriever.searchChunks(query, topN ?? 5)
})

// ─── 文档导入（GAP9a）────────────────────────────────────────────────────────

/** 打开系统文件选择对话框，返回用户选中的文件路径 */
ipcMain.handle('show-open-dialog', async (_, options: Electron.OpenDialogOptions) => {
  return dialog.showOpenDialog(mainWindow!, options)
})

/**
 * parse-document: 解析文件（PDF/Word/图片/文本）。
 * 返回提取的文本和图片（base64 data URL），图片由渲染进程进一步 OCR。
 */
ipcMain.handle('parse-document', async (_, filePath: string) => {
  return documentParser.parseFile(filePath)
})

// ─── 定时自检（GAP14）────────────────────────────────────────────────────────

/**
 * start-scheduled-test: 启动定时自检（每 N 小时触发一次）。
 * intervalHours = 0 表示停止。
 */
ipcMain.handle('start-scheduled-test', (_, avatarId: string, intervalHours: number) => {
  scheduledTester.start(avatarId, intervalHours)
  db.setSetting(`scheduled_test_avatar`, avatarId)
  db.setSetting(`scheduled_test_interval`, String(intervalHours))
})

ipcMain.handle('stop-scheduled-test', () => {
  scheduledTester.stop()
  db.setSetting(`scheduled_test_interval`, '0')
})

/** notify-test-result: 渲染进程测试完成后通知主进程更新红点状态 */
ipcMain.handle('notify-test-result', (_, passed: number, total: number, failed: number) => {
  scheduledTester.notifyTestResult(passed > 0 && failed === 0, total, failed)
})
