/**
 * Electron 主进程入口
 *
 * @author zhi.qu
 * @date 2026-04-03
 */

import { app, BrowserWindow, ipcMain, dialog, nativeImage, shell } from 'electron'

// V8 堆上限：默认 ~2GB，回归批跑 1063 题 + 知识检索器（3002 chunks）+ embeddings（29MB JSON
// → 50MB Map）+ chart cache 等多个大缓存常驻主进程，2GB 频繁 OOM。提到 8GB 留充足空间。
// 注：必须在 app.whenReady() 之前 appendSwitch，且 NODE_OPTIONS / --js-flags 命令行
// 在 Electron Mac 下经常被 cross-env / shell 嵌套引号丢失，appendSwitch 是最可靠的途径。
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=8192')
// macOS + Electron 41 偶发 Chromium GPU overlay mailbox 日志，禁用硬件加速避免渲染层反复报错。
app.disableHardwareAcceleration()

import path from 'path'
import fs from 'fs'
import os from 'os'
import { SoulLoader, KnowledgeManager, AvatarManager, SkillManager, SkillRouter, ToolRouter, KnowledgeRetriever, TemplateLoader, buildKnowledgeIndex, saveIndex, loadIndex, retrieveAndBuildPrompt, WikiCompiler, consolidateMemory, getMemoryStats, assertSafeSegment, localDateString, formatDocument, fetchWithTimeout, cleanPdfFullText, stripDocxToc, mergeVisionIntoText, detectFabricatedNumbers, callVisionOcr, loadChartCache, saveChartCache, findChartCacheHit, insertChartCacheEntry, captureFileSnapshot, CHART_CACHE_REL_PATH, McpClientManager, parseFrontmatterCore, extractFrontmatterFields, mergeFrontmatter, buildFrontmatterBlock, type WikiAnswer, type LLMCallFn, type ChartCacheEntry, type DocumentIR } from '@soul/core'
import { DatabaseManager, type McpServerRow } from './database'
import { TestManager, type TestCase, type TestReport } from './test-manager'
import { DocumentParser, isGarbledText } from './document-parser'
import {
  walkFolder,
  extractArchive,
  makeTempExtractDir,
  cleanupTempDir,
} from './folder-importer'
import { ScheduledTester } from './scheduled-tester'
import { CronScheduler, type CronTaskType } from './cron-scheduler'
import { Logger, redactSensitiveArgs } from './logger'
import { ToolResultSpool } from './tool-result-spool'
import { AttachmentStore, MAX_ATTACHMENT_FILE_BYTES } from './attachment-store'
import { createEmbeddingFn, createLLMFn } from './llm-factory'
import { SKILL_GEN_SYSTEM_PROMPT, buildSkillGenUserPrompt } from './skill-generator-prompt'
import { WorkspaceManager } from './workspace/WorkspaceManager'
import { PreviewManager } from './preview/PreviewManager'
import { VerifierAgent } from './verifier/VerifierAgent'
import { htmlToPptx } from './exporters/html-to-pptx'
import { superInlineHtml } from './exporters/inline-html'
import { PublicFileServer } from './exporters/public-file-server'
import { renderDocumentPdf } from './exporters/document-pdf-renderer'
import { renderDocumentDocx } from './exporters/document-docx-renderer'
import { applyTweaks } from './preview/tweaks-writer'
import { GitHubConnector } from './connectors/github-connector'
import { CommunitySkillManager } from './community-skill-manager'

let mainWindow: BrowserWindow | null = null

// assertSafeSegment 已从 @soul/core 统一导入

/**
 * 解析分身目录路径。
 * 开发环境直接指向仓库 avatars/；生产环境使用 userData/avatars/（首次启动自动创建空目录）。
 */
function resolveAvatarsPath(): string {
  const overridePath = process.env.SOUL_AVATARS_PATH
  if (overridePath) {
    return path.resolve(overridePath)
  }
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
let templatesPath: string
let soulLoader: SoulLoader
let db: DatabaseManager
let avatarManager: AvatarManager
let testManager: TestManager
let skillManager: SkillManager
let skillRouter: SkillRouter
let toolRouter: ToolRouter
let mcpManager: McpClientManager
let workspaceManager: WorkspaceManager
let previewManager: PreviewManager | null = null
let verifierAgent: VerifierAgent
let publicFileServer: PublicFileServer
let githubConnector: GitHubConnector
let communitySkillManager: CommunitySkillManager
const documentParser = new DocumentParser()
const scheduledTester = new ScheduledTester()
const cronScheduler = new CronScheduler()
let templateLoader: TemplateLoader
let backupIntervalId: ReturnType<typeof setInterval> | null = null
const bridgeMinuteWindow = new Map<string, number[]>()
const bridgeDailyTokens = new Map<string, { day: string; tokens: number }>()
const bridgeConversationTokens = new Map<string, number>()
const bridgeFileMinuteWindow = new Map<string, number[]>()
/** 限流默认阈值（设置面板可调） */
const BRIDGE_LIMITS = {
  perMinute: 20,
  perFilePerMinute: 5,
  perConversationTokens: 50_000,
  perAvatarDailyTokens: 100_000,
}
/**
 * 同会话内 LLM 产物 mNNNN 单调自增计数器。
 * Phase I（snip）用：每条消息打 [id:mNNNN] 锚点，便于裁剪上下文时按 ID 范围摘要。
 */
const messageSeqCounters = new Map<string, number>()

/** Logger 使用 userData 路径，需在 app ready 之后才能获取；先声明再赋值 */
let logger: Logger
/**
 * 工具结果落盘器（Stage 三 P2 #15）。
 * 同样依赖 userData 路径，在 initManagers 中创建。
 */
let toolResultSpool: ToolResultSpool

/**
 * 对话框附件落盘器（对话框附件扩展，2026-05-01）。
 * 文件本体落 userData/attachments/<convId>/<hash>.<ext>，元信息进 attachments 表。
 */
let attachmentStore: AttachmentStore

/**
 * 附件全文解析缓存（read_attachment / search_attachment 共享）。
 * 同一附件被反复 tool call 时不重复跑 documentParser.parseFile。
 *
 * 用 attachment.id 作 key（已含 hash 命名空间，无碰撞风险）；FIFO 简易上限 16 项，
 * 防止内存堆积（单文档解析结果通常 ~MB 级，16 项 ≈ 数十 MB 上限可接受）。
 */
const ATTACHMENT_PARSE_CACHE_LIMIT = 16
const attachmentParseCache = new Map<string, { fileType: string; text: string; perPageChars?: Array<{ num: number; chars: number }>; sheetNames?: string[] }>()
function rememberParsedAttachment(id: string, parsed: { fileType: string; text: string; perPageChars?: Array<{ num: number; chars: number }>; sheetNames?: string[] }) {
  if (attachmentParseCache.has(id)) attachmentParseCache.delete(id)
  attachmentParseCache.set(id, parsed)
  while (attachmentParseCache.size > ATTACHMENT_PARSE_CACHE_LIMIT) {
    const oldestKey = attachmentParseCache.keys().next().value
    if (oldestKey === undefined) break
    attachmentParseCache.delete(oldestKey)
  }
}

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
 * 根据会话 ID 解析工作区上下文（avatarId + workspace 根目录）。
 */
function resolveWorkspaceContext(conversationId: string): { avatarId: string; workspaceRoot: string } {
  const conv = getDb().getConversation(conversationId)
  if (!conv) {
    throw new Error(`会话不存在: ${conversationId}`)
  }
  const avatarId = conv.avatar_id
  assertSafeSegment(avatarId, '分身ID')
  const workspaceRoot = workspaceManager.ensure(avatarId, conversationId)
  if (conv.workspace_initialized !== 1) {
    getDb().markWorkspaceInitialized(conversationId)
  }
  return { avatarId, workspaceRoot }
}

/**
 * IPC 包装器：统一记录操作日志和错误日志。
 * 所有 ipcMain.handle 调用改由此函数注册，不改变业务逻辑。
 */
/** 含敏感参数（apiKey）的 channel，日志需脱敏 */
const SENSITIVE_CHANNELS = new Set([
  'consolidate-memory', 'build-knowledge-index', 'rag-retrieve',
  'compile-wiki', 'lint-knowledge', 'detect-evolution', 'enhance-knowledge-files',
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

/**
 * 工具调用审计包装器（Stage 三 P2 #16）。
 *
 * 用于 execute-tool-call IPC handler：
 *   1. 记录耗时（startedAt → finally）
 *   2. 调用 logger.toolCall() 写入 logs/tool-calls/<date>.jsonl
 *   3. 入参通过 redactSensitiveArgs 脱敏 + JSON 截断到 800 字符
 *   4. result 字符数 + ok/error 状态都进入审计
 *
 * 任何审计写入异常仅 console.warn，绝不影响主链路返回值。
 *
 * @author zhi.qu
 * @date 2026-04-29
 */
async function withToolCallAudit<T extends { content: string; error?: string }>(
  avatarId: string,
  conversationId: string,
  toolName: string,
  args: Record<string, unknown>,
  body: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now()
  let result: T | undefined
  let thrown: Error | undefined
  let originalContentLen = 0
  try {
    result = await body()
    // Stage 三 P2 #15: 工具结果超阈值时落盘，content 改为头尾摘要 + 路径提示。
    // 仅成功结果且 content 是非空字符串时才走 spool；error 路径不需要落盘。
    if (result && typeof result.content === 'string' && result.content.length > 0 && !result.error && toolResultSpool) {
      originalContentLen = result.content.length
      const sp = toolResultSpool.spool(conversationId, toolName, result.content)
      if (sp.spilled) {
        // 不可变模式重建 result 对象（保持 T 类型契约）
        result = { ...(result as object), content: sp.content } as T
        if (logger) {
          logger.activity(
            'tool-result-spool',
            `tool=${toolName} originalLen=${sp.originalLength} path=${sp.path}`,
          )
        }
      }
    }
    return result
  } catch (err) {
    thrown = err instanceof Error ? err : new Error(String(err))
    throw thrown
  } finally {
    try {
      if (logger) {
        let argsPreview = ''
        try {
          argsPreview = JSON.stringify(redactSensitiveArgs(args) ?? {})
        } catch {
          argsPreview = '[unstringifiable args]'
        }
        // resultLen 优先用 spool 之前的原始长度，便于审计真实工具产出体量；
        // 否则回退到当前 content 长度（错误路径或 spool 未触发场景）。
        const resultLen = originalContentLen > 0
          ? originalContentLen
          : (typeof result?.content === 'string' ? result.content.length : 0)
        logger.toolCall({
          ts: startedAt,
          avatarId,
          conversationId,
          toolName,
          durationMs: Date.now() - startedAt,
          ok: !thrown && !result?.error,
          argsPreview,
          resultLen,
          error: thrown ? thrown.message : result?.error,
        })
      }
    } catch (auditErr) {
      console.warn('[Main] tool-call audit 写入失败:', auditErr instanceof Error ? auditErr.message : String(auditErr))
    }
  }
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
  // show: false + ready-to-show 是 Electron 官方推荐的"优雅显示"模式。
  // 修复 Windows 安装版的 bug：BrowserWindow 默认 show: true 时窗口立即可见，
  // 但此时 WebContents 尚未完成首屏渲染和合成器初始化，OS 输入派发链未建立。
  // 用户看到 UI 立即点击会被合成层吞掉（hover 正常但 click 静默失败）；
  // 打开 DevTools 会强制 attach 输入 handler + 触发 reflow，事件链才被踹活。
  // backgroundColor 防止 show 之前出现系统默认白底闪烁。
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1024,
    minHeight: 680,
    icon: iconPath ? nativeImage.createFromPath(iconPath) : undefined,
    show: false,
    backgroundColor: '#0a0a0a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  // 等首屏渲染完成、合成器就绪后再显示，并在 Windows 上主动 focus 拿到 OS 输入焦点
  mainWindow.once('ready-to-show', () => {
    mainWindow?.show()
    mainWindow?.focus()
    if (logger) logger.activity('app-window-ready-to-show')
  })

  if (process.env.NODE_ENV === 'development') {
    mainWindow.loadURL('http://localhost:5173')
    mainWindow.webContents.openDevTools()
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))
  }

  // preview-preload 与 chat 主窗口的 preload 完全独立：用于 WebContentsView 内部的
  // window.claude / inspector / tweaks 协议
  const previewPreloadPath = path.join(__dirname, 'preview-preload.js')
  previewManager = new PreviewManager(mainWindow, previewPreloadPath)
  mainWindow.on('resize', () => {
    previewManager?.updateBounds()
  })

  mainWindow.on('closed', () => {
    mainWindow = null
    previewManager = null
    scheduledTester.stop()
    cronScheduler.cancelAll()
    if (logger) logger.activity('app-window-closed')
  })
}

function initManagers() {
  avatarsPath = resolveAvatarsPath()
  templatesPath = resolveTemplatesPath()
  logger = new Logger(app.getPath('userData'))
  // Stage 三 P2 #15: 工具返回值 spool（>12000 字符自动落盘到 userData/tool-results/）
  toolResultSpool = new ToolResultSpool(app.getPath('userData'))
  // 对话框附件存储（2026-05-01）：用户上传的 PDF / Word / 文本等文件落到
  // userData/attachments/<convId>/<hash>.<ext>，元信息进 attachments 表
  attachmentStore = new AttachmentStore(app.getPath('userData'))
  // 启动时清理 7 天前的 spool 文件，防止磁盘膨胀（异步包装防止初始化超时）
  setImmediate(() => {
    const stat = toolResultSpool.cleanup()
    if ((stat.removedFiles > 0 || stat.removedDirs > 0) && logger) {
      logger.activity('tool-result-spool:cleanup', `removedFiles=${stat.removedFiles} removedDirs=${stat.removedDirs}`)
    }
  })
  soulLoader = new SoulLoader(avatarsPath)
  db = new DatabaseManager()
  avatarManager = new AvatarManager(avatarsPath, templatesPath)
  testManager = new TestManager(avatarsPath)
  skillManager = new SkillManager(avatarsPath)
  communitySkillManager = new CommunitySkillManager(avatarsPath, logger)
  skillRouter = new SkillRouter(avatarsPath)
  // 创建 MCP 客户端管理器，并从 DB 加载所有 enabled=true 的 server 配置。
  // 连接是异步且非阻塞的，单个 server 失败不影响 app 启动。
  // 用户可在「设置 → 工具集成 → MCP」面板增删启停 server。
  const mcpInitialConfigs = db.listMcpServers()
    .filter((row) => row.enabled)
    .map(mcpRowToConfig)
  mcpManager = new McpClientManager(mcpInitialConfigs)
  // 注入跨分身委派依赖：让 delegate_task({ target_avatar }) 能现场加载目标分身的 systemPrompt
  // 同时注入 getSetting：让 web_search 等需要外部凭据的工具能读到 settings 表中的 API Key
  // 同时注入 mcpManager：让 list_mcp_tools / call_mcp_tool 工具能路由到 MCP server
  toolRouter = new ToolRouter(avatarsPath, {
    loadAvatarSystemPrompt: (id: string) => {
      const dir = path.join(avatarsPath, id)
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return undefined
      try {
        return soulLoader.loadAvatar(id).systemPrompt
      } catch (e) {
        if (logger) logger.activity('delegate', `loadAvatarSystemPrompt(${id}) 失败: ${e instanceof Error ? e.message : String(e)}`)
        return undefined
      }
    },
    listAvailableAvatars: () => {
      try {
        return fs.readdirSync(avatarsPath, { withFileTypes: true })
          .filter((d) => d.isDirectory() && !d.name.startsWith('.') && !d.name.startsWith('_'))
          .map((d) => d.name)
      } catch {
        return []
      }
    },
    getSetting: (key: string) => getDb().getSetting(key),
    mcpManager,
    // 决策 A1：注入文档渲染器，让 generate_document 工具能在主进程渲染 PDF/DOCX。
    // ToolRouter 与渲染器都在主进程，直接同进程函数调用，无 IPC 开销。
    documentRenderers: {
      renderPdf: (html, outputPath) => renderDocumentPdf(html, outputPath, { logger: logger ?? undefined }),
      renderDocx: (ir, outputPath) => renderDocumentDocx(ir, outputPath, { logger: logger ?? undefined }),
    },
  })
  workspaceManager = new WorkspaceManager(avatarsPath)
  templateLoader = new TemplateLoader(templatesPath)
  verifierAgent = new VerifierAgent(logger)
  publicFileServer = new PublicFileServer(logger)
  githubConnector = new GitHubConnector(db, workspaceManager)
  // 从设置中加载 bridge 限流阈值（用户在设置面板可改）
  loadBridgeLimits()
  logger.activity('app-init', `avatarsPath=${avatarsPath}`)
}

/**
 * 从 settings 表读取 bridge 限流阈值（Phase F 真实落地）。
 * 任何字段缺失时回退默认值；非数字字符串静默忽略。
 */
function loadBridgeLimits(): void {
  const fields: Array<keyof typeof BRIDGE_LIMITS> = ['perMinute', 'perFilePerMinute', 'perConversationTokens', 'perAvatarDailyTokens']
  for (const f of fields) {
    const v = parseInt(getDb().getSetting(`bridge_${f}`) ?? '', 10)
    if (Number.isFinite(v) && v > 0) BRIDGE_LIMITS[f] = v
  }
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
  // 关闭本地 HTTP 静态服务（Phase J' get_public_file_url 用）
  if (publicFileServer) {
    publicFileServer.stop().catch((err) => {
      console.warn('[Main] publicFileServer.stop() failed:', err instanceof Error ? err.message : String(err))
    })
  }
  // 关闭所有 MCP server 连接（stdio 子进程会被 SIGTERM）
  if (mcpManager) {
    mcpManager.closeAll().catch((err) => {
      console.warn('[Main] mcpManager.closeAll() failed:', err instanceof Error ? err.message : String(err))
    })
  }
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

function pushWindowAndCount(windowMap: Map<string, number[]>, key: string, now: number, windowMs: number): number {
  const list = windowMap.get(key) ?? []
  const next = list.filter((ts) => now - ts <= windowMs)
  next.push(now)
  windowMap.set(key, next)
  return next.length
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

  // 异步预热 chunk 缓存（fire-and-forget）：用 fs.promises.readFile 在
  // Node.js 线程池中读取文件，主线程不阻塞，不影响 UI 和 fetch stream。
  // 用户提问前 chunks 已就绪，不会出彩色伞。
  const retriever = toolRouter.getRetriever(avatarId)
  retriever.warmUpAsync().catch(err => {
    console.warn('[load-avatar] chunk 异步预热失败（不影响功能）:', err instanceof Error ? err.message : String(err))
  })

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
  // 先清磁盘附件目录，再删 DB（DB 删除会 CASCADE 清理 attachments / messages 行）
  // 反过来即使附件目录清理失败也不影响主流程：此处兜底捕获日志即可
  try {
    attachmentStore?.deleteAttachmentsByConversation(id)
  } catch (err) {
    if (logger) logger.error('delete-conversation:cleanup-attachments', err)
  }
  getDb().deleteConversation(id)
})

// ─── Workspace（L3 Phase A）──────────────────────────────────────────────────

wrapHandler('workspace:stat', (_, conversationId: string, relPath: string) => {
  const { avatarId } = resolveWorkspaceContext(conversationId)
  return workspaceManager.stat(avatarId, conversationId, relPath)
})

wrapHandler('workspace:read', (_, conversationId: string, relPath: string) => {
  const { avatarId } = resolveWorkspaceContext(conversationId)
  return workspaceManager.readFile(avatarId, conversationId, relPath)
})

wrapHandler('workspace:write', (_, conversationId: string, relPath: string, content: string) => {
  const { avatarId } = resolveWorkspaceContext(conversationId)
  return workspaceManager.writeFile(avatarId, conversationId, relPath, content)
})

wrapHandler('workspace:list', (_, conversationId: string, relPath = '.', depth = 1) => {
  const { avatarId } = resolveWorkspaceContext(conversationId)
  return workspaceManager.list(avatarId, conversationId, relPath, depth)
})

wrapHandler('workspace:copy', (_, conversationId: string, src: string, dest: string, move = false) => {
  const { avatarId } = resolveWorkspaceContext(conversationId)
  workspaceManager.copy(avatarId, conversationId, src, dest, move)
})

wrapHandler('workspace:move', (_, conversationId: string, src: string, dest: string) => {
  const { avatarId } = resolveWorkspaceContext(conversationId)
  workspaceManager.copy(avatarId, conversationId, src, dest, true)
})

wrapHandler('workspace:delete', (_, conversationId: string, relPath: string) => {
  const { avatarId } = resolveWorkspaceContext(conversationId)
  workspaceManager.delete(avatarId, conversationId, relPath)
})

wrapHandler('workspace:grep', (_, conversationId: string, relPath: string, pattern: string) => {
  const { avatarId } = resolveWorkspaceContext(conversationId)
  return workspaceManager.grep(avatarId, conversationId, relPath, pattern)
})

// ─── 消息管理 ────────────────────────────────────────────────────────────────

wrapHandler('save-message', (_, conversationId: string, role: 'user' | 'assistant' | 'tool', content: string, toolCallId?: string, imageUrls?: string[]) => {
  return getDb().saveMessage(conversationId, role, content, toolCallId, imageUrls)
})

wrapHandler('get-messages', (_, conversationId: string) => {
  return getDb().getMessages(conversationId)
})

// ─── Agent 任务列表持久化（Stage 三 P2 范围外 1）────────────────────────────

/**
 * agent-tasks:save: 整体覆盖式保存某会话的任务列表 JSON。
 *
 * 渲染进程在 setTasks/mergeTasks/attachToolCallToTask 后异步调用，
 * 失败不影响主链路（chatStore 内部捕获即可）。
 */
wrapHandler('agent-tasks:save', (_, conversationId: string, tasksJson: string) => {
  assertSafeSegment(conversationId, '会话ID')
  if (typeof tasksJson !== 'string') throw new Error('tasksJson 必须是字符串')
  return getDb().saveAgentTasks(conversationId, tasksJson)
})

/**
 * agent-tasks:get: 读取某会话的任务列表 JSON 字符串。
 *
 * 不存在返回 null。渲染进程在切入会话时调用一次，恢复 chatStore.tasks。
 */
wrapHandler('agent-tasks:get', (_, conversationId: string) => {
  assertSafeSegment(conversationId, '会话ID')
  return getDb().getAgentTasks(conversationId)
})

/** agent-tasks:clear: 清空某会话的任务列表（用户手动清空时） */
wrapHandler('agent-tasks:clear', (_, conversationId: string) => {
  assertSafeSegment(conversationId, '会话ID')
  return getDb().clearAgentTasks(conversationId)
})

// ─── 对话框附件（2026-05-01 对话框附件扩展）─────────────────────────────────
//
// 设计：
//   - save-attachment：base64 → buffer → AttachmentStore 落盘 + DocumentParser 抽取
//     outline+summary（前 500 字）+ DB.insertAttachment
//   - get-attachment-meta：按 ID 取元信息（id/name/mime/size/summary/outline/parsed_meta）
//   - list-attachments：列出某会话所有附件，供 ChatWindow 加载历史时恢复 chip
//
// 注意：解析失败不阻塞落盘，summary/outline 退化为 null，工具调用时再尝试解析。

/**
 * save-attachment: 用户上传文件 → 落盘 + 抽取摘要/大纲 + 写入 attachments 表。
 *
 * @param conversationId  归属会话 ID
 * @param name            原始文件名（必须含后缀以便选择解析器）
 * @param base64Data      base64 编码的文件二进制（不含 data: 前缀）
 * @param mime            可选 MIME 类型（前端提供更准确，省略时按后缀映射）
 * @returns AttachmentRow（含 id / hash / 大小 / 摘要 / 大纲）
 */
wrapHandler('save-attachment', async (_, conversationId: string, name: string, base64Data: string, mime?: string) => {
  assertSafeSegment(conversationId, '会话ID')
  if (typeof name !== 'string' || !name.trim()) throw new Error('name 必填')
  if (typeof base64Data !== 'string' || !base64Data) throw new Error('base64Data 必填')
  // 拒绝跨会话误用：保存前确认会话存在（避免渲染进程乱传 ID 导致孤儿目录）
  const conv = getDb().getConversation(conversationId)
  if (!conv) throw new Error(`会话不存在: ${conversationId}`)

  // base64 → buffer，超大附件先粗判大小（base64 ≈ 4/3 原始字节），避免无谓 decode
  const approxBytes = Math.floor(base64Data.length * 0.75)
  if (approxBytes > MAX_ATTACHMENT_FILE_BYTES + 1024) {
    const mb = Math.floor(MAX_ATTACHMENT_FILE_BYTES / (1024 * 1024))
    throw new Error(`附件过大（>${mb}MB），请压缩或拆分后再上传: ${name}`)
  }
  const buffer = Buffer.from(base64Data, 'base64')

  const saved = attachmentStore.saveAttachment(conversationId, name, buffer)
  const ext = saved.ext
  const finalMime = mime?.trim() || guessMimeFromExt(ext) || 'application/octet-stream'

  getDb().insertAttachment({
    id: saved.id,
    conversation_id: conversationId,
    name: saved.name,
    mime: finalMime,
    size: saved.size,
    hash: saved.hash,
    ext,
    created_at: saved.createdAt,
    summary: null,
    outline: null,
    parsed_meta: null,
  })

  if (logger) logger.activity('save-attachment', `conv=${conversationId} name=${name} size=${saved.size} hash=${saved.hash.slice(0, 12)}`)

  // 摘要 / 大纲在后台抽取，不阻塞 IPC 返回，避免大文件解析让前端长时间看不到附件 chip。
  // 失败仅记日志：read_attachment / search_attachment 时还会再次按需解析。
  setImmediate(() => {
    documentParser.parseFile(saved.storedPath)
      .then(parsed => {
        const text = parsed.text || ''
        const summary = text.slice(0, 500) || null
        const outline = extractOutline(text) || null
        const parsedMeta = JSON.stringify({
          fileType: parsed.fileType,
          textLength: text.length,
          imageCount: parsed.images.length,
          sheetNames: parsed.sheetNames ?? null,
          pageCount: parsed.perPageChars?.length ?? null,
        })
        try {
          getDb().updateAttachmentParseResult(saved.id, { summary, outline, parsed_meta: parsedMeta })
        } catch (writeErr) {
          if (logger) logger.error('save-attachment:write-meta', writeErr instanceof Error ? writeErr : new Error(String(writeErr)))
        }
      })
      .catch(parseErr => {
        if (logger) logger.activity('save-attachment:parse-skip', `${name}: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`)
      })
  })

  return getDb().getAttachmentById(saved.id)
})

/** get-attachment-meta: 按 ID 取元信息（不返回文件本体） */
wrapHandler('get-attachment-meta', (_, id: string) => {
  if (typeof id !== 'string' || !id) throw new Error('id 必填')
  return getDb().getAttachmentById(id)
})

/** list-attachments: 列出某会话所有附件元信息（按时间升序） */
wrapHandler('list-attachments', (_, conversationId: string) => {
  assertSafeSegment(conversationId, '会话ID')
  return getDb().listAttachmentsByConversation(conversationId)
})

/**
 * link-attachment-to-message: 把附件挂到刚保存的消息上。
 * 渲染进程在 saveMessage 拿到 messageId 后立即调一次，把上传时未关联的附件回填。
 */
wrapHandler('link-attachment-to-message', (_, messageId: string, attachmentIds: string[], conversationId: string) => {
  assertSafeSegment(conversationId, '会话ID')
  if (typeof messageId !== 'string' || !messageId) throw new Error('messageId 必填')
  if (!Array.isArray(attachmentIds)) throw new Error('attachmentIds 必须是数组')
  return getDb().linkAttachmentToMessage(messageId, attachmentIds, conversationId)
})

/**
 * open-attachment-file: 用系统默认应用打开附件本体（chip 点击）。
 * 必须先校验 attachment 属于已存在会话，再调 shell.openPath。
 */
wrapHandler('open-attachment-file', async (_, id: string) => {
  if (typeof id !== 'string' || !id) throw new Error('id 必填')
  const row = getDb().getAttachmentById(id)
  if (!row) throw new Error(`附件不存在: ${id}`)
  const abs = attachmentStore.getAttachmentAbsPath(row.conversation_id, row.hash, row.ext)
  const errMsg = await shell.openPath(abs)
  if (errMsg) throw new Error(`打开附件失败: ${errMsg}`)
  return { ok: true, path: abs }
})

/**
 * 抽取文档大纲：扫描所有 markdown 标题（# / ## / ###）并返回前 30 行。
 * 非 markdown 文档（PDF / Word 抽出来的纯文本）通常没有 # 标题，则退化为按
 * 「短行 + 全大写 / 数字编号」启发式抽取段落标题。
 */
function extractOutline(text: string): string {
  if (!text) return ''
  const lines = text.split(/\r?\n/)
  const headings: string[] = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    if (/^#{1,6}\s+\S/.test(trimmed)) {
      headings.push(trimmed)
    } else if (
      // 非 markdown 兜底：行 < 60 字、不含句号/逗号、像章节编号或全大写
      trimmed.length < 60
      && !/[，。,]$/.test(trimmed)
      && (/^第\s*[一二三四五六七八九十百千零0-9]+\s*[章节部分]/.test(trimmed)
        || /^[0-9]+(\.[0-9]+)*\s+\S/.test(trimmed)
        || /^[A-Z][A-Z0-9\s.-]{4,}$/.test(trimmed))
    ) {
      headings.push(trimmed)
    }
    if (headings.length >= 30) break
  }
  return headings.join('\n')
}

/** 按后缀名兜底推断 MIME 类型，前端没传时用 */
function guessMimeFromExt(ext: string): string {
  const map: Record<string, string> = {
    '.pdf': 'application/pdf',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.ppt': 'application/vnd.ms-powerpoint',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.xls': 'application/vnd.ms-excel',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.csv': 'text/csv',
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.json': 'application/json',
    '.yaml': 'text/yaml',
    '.yml': 'text/yaml',
    '.toml': 'text/plain',
    '.xml': 'application/xml',
    '.html': 'text/html',
    '.htm': 'text/html',
    '.css': 'text/css',
    '.ts': 'text/x-typescript',
    '.tsx': 'text/x-typescript',
    '.js': 'text/javascript',
    '.jsx': 'text/javascript',
    '.py': 'text/x-python',
    '.java': 'text/x-java-source',
    '.go': 'text/x-go',
    '.rs': 'text/rust',
    '.sh': 'application/x-sh',
    '.sql': 'application/sql',
    '.env': 'text/plain',
  }
  return map[ext.toLowerCase()] || ''
}

// ─── 工具结果 spool 查看入口（Stage 三 P2 范围外 2）────────────────────────

/**
 * tool-results:list: 列出某会话所有 spool 文件（mtime 倒序）。
 * 供 SettingsPanel / 调试面板查看历史大返回值原文。
 */
wrapHandler('tool-results:list', (_, conversationId: string) => {
  assertSafeSegment(conversationId, '会话ID')
  if (!toolResultSpool) return []
  return toolResultSpool.listForConversation(conversationId)
})

/**
 * tool-results:open-folder: 在系统资源管理器中打开某会话的 spool 目录。
 * 不存在时返回错误信息，渲染层提示用户「该会话尚无大返回值落盘」。
 */
wrapHandler('tool-results:open-folder', async (_, conversationId: string) => {
  assertSafeSegment(conversationId, '会话ID')
  if (!toolResultSpool) return { success: false, error: 'spool 未初始化' }
  const dir = path.join(toolResultSpool.getRootDir(), conversationId)
  if (!fs.existsSync(dir)) {
    return { success: false, error: '该会话尚无落盘的大工具返回值' }
  }
  await shell.openPath(dir)
  return { success: true, path: dir }
})

/**
 * tool-results:read: 读取某个 spool 文件的内容（带大小上限保护）。
 * 渲染层用于在内嵌 viewer 中展示，避免用户必须打开外部编辑器。
 */
wrapHandler('tool-results:read', async (_, absPath: string, maxBytes = 200_000) => {
  if (typeof absPath !== 'string' || !absPath.startsWith(toolResultSpool?.getRootDir() ?? '___never___')) {
    throw new Error('非法路径：必须位于 tool-results 目录内')
  }
  const stat = fs.statSync(absPath)
  if (stat.size > maxBytes) {
    const fd = fs.openSync(absPath, 'r')
    try {
      const buf = Buffer.alloc(maxBytes)
      fs.readSync(fd, buf, 0, maxBytes, 0)
      return {
        content: buf.toString('utf-8') + `\n\n[... 文件较大（${stat.size} 字节），已截断到前 ${maxBytes} 字节，可在系统资源管理器中查看完整文件]`,
        truncated: true,
        size: stat.size,
      }
    } finally {
      fs.closeSync(fd)
    }
  }
  return { content: fs.readFileSync(absPath, 'utf-8'), truncated: false, size: stat.size }
})

// ─── 设置管理 ────────────────────────────────────────────────────────────────

wrapHandler('get-setting', (_, key: string) => {
  return getDb().getSetting(key)
})

wrapHandler('set-setting', (_, key: string, value: string) => {
  getDb().setSetting(key, value)
})

// ─── Window Claude Bridge（L3 Phase F）──────────────────────────────────────

/**
 * window.claude.complete 桥接（Phase F 真实实现）。
 *
 * 安全/限流：
 *   1. 起源校验：仅允许 file:// 来源 + persist:soul-preview 分区调用，防止主聊天页或外部网页滥用。
 *   2. 多层限流：每分钟次数、单文件每分钟次数、单会话累计 tokens、单分身每日 tokens。
 *   3. 独立频道日志：写入 logs/claudebridge-YYYY-MM-DD.log，便于审计与排查。
 *
 * 失败时抛 rate_limit:* 错误，让 HTML 工件内 catch 后降级。
 */
wrapHandler('claudebridge:complete', async (event, conversationId: string, input: string | { messages?: Array<{ role: string; content: string }> }, filePath?: string) => {
  const now = Date.now()
  const { avatarId } = resolveWorkspaceContext(conversationId)

  // 1) 起源校验：senderFrame 必须存在且是 file:// 协议
  const frame = event.senderFrame
  const senderUrl = frame ? frame.url : ''
  if (!senderUrl.startsWith('file://')) {
    if (logger) logger.channel('claudebridge', 'origin-rejected', `avatarId=${avatarId}, senderUrl=${senderUrl}`)
    throw new Error(`claudebridge: 拒绝非 file:// 起源的调用 (${senderUrl || 'unknown'})`)
  }

  // 2) 限流（多层）
  const minuteCount = pushWindowAndCount(bridgeMinuteWindow, avatarId, now, 60_000)
  if (minuteCount > BRIDGE_LIMITS.perMinute) {
    if (logger) logger.channel('claudebridge', 'rate-limit-minute', `avatarId=${avatarId}, count=${minuteCount}/${BRIDGE_LIMITS.perMinute}`)
    throw new Error(`rate_limit: 每分钟调用次数已超过 ${BRIDGE_LIMITS.perMinute} 次`)
  }
  if (filePath) {
    const perFile = pushWindowAndCount(bridgeFileMinuteWindow, `${avatarId}:${filePath}`, now, 60_000)
    if (perFile > BRIDGE_LIMITS.perFilePerMinute) {
      if (logger) logger.channel('claudebridge', 'rate-limit-file', `file=${filePath}, count=${perFile}/${BRIDGE_LIMITS.perFilePerMinute}`)
      throw new Error(`rate_limit: 单文件每分钟调用次数已超过 ${BRIDGE_LIMITS.perFilePerMinute} 次`)
    }
  }
  const convTotal = bridgeConversationTokens.get(conversationId) ?? 0
  if (convTotal > BRIDGE_LIMITS.perConversationTokens) {
    if (logger) logger.channel('claudebridge', 'rate-limit-conv-tokens', `conv=${conversationId}, total=${convTotal}/${BRIDGE_LIMITS.perConversationTokens}`)
    throw new Error(`rate_limit: 对话累计 tokens 已超过 ${BRIDGE_LIMITS.perConversationTokens}`)
  }
  const day = localDateString()
  const dayState = bridgeDailyTokens.get(avatarId) ?? { day, tokens: 0 }
  if (dayState.day === day && dayState.tokens > BRIDGE_LIMITS.perAvatarDailyTokens) {
    if (logger) logger.channel('claudebridge', 'rate-limit-daily', `avatarId=${avatarId}, daily=${dayState.tokens}/${BRIDGE_LIMITS.perAvatarDailyTokens}`)
    throw new Error(`rate_limit: 分身每日 tokens 已超过 ${BRIDGE_LIMITS.perAvatarDailyTokens}`)
  }

  // 3) 调用 LLM
  const apiKey = getDb().getSetting('chat_api_key') ?? ''
  const baseUrl = getDb().getSetting('chat_base_url') ?? 'https://api.deepseek.com/v1'
  if (!apiKey) throw new Error('未配置 chat_api_key')
  const bridgeModel = getDb().getSetting('bridge_model') ?? getDb().getSetting('chat_model') ?? 'deepseek-chat'
  const callLLM = createLLMFn(apiKey, baseUrl, bridgeModel)
  const prompt = typeof input === 'string'
    ? input
    : (input.messages ?? []).map((m) => `[${m.role}] ${m.content}`).join('\n')
  const text = await callLLM('你是 HTML 工件内的轻量补全助手，回复简洁直接。', prompt, 1024)

  // 4) 计费记账
  const outputTokensEstimate = Math.ceil(text.length / 2)
  bridgeConversationTokens.set(conversationId, convTotal + outputTokensEstimate)
  const sameDay = dayState.day === day
  const nextDayTokens = (sameDay ? dayState.tokens : 0) + outputTokensEstimate
  bridgeDailyTokens.set(avatarId, { day, tokens: nextDayTokens })

  if (logger) {
    logger.channel('claudebridge', 'complete', `avatarId=${avatarId}, conv=${conversationId}, file=${filePath ?? '-'}, outTokens≈${outputTokensEstimate}, daily=${nextDayTokens}`)
  }
  return text
})

/** 设置面板可调阈值的便捷 IPC */
wrapHandler('claudebridge:get-limits', () => ({ ...BRIDGE_LIMITS }))
wrapHandler('claudebridge:set-limits', (_event, limits: Partial<typeof BRIDGE_LIMITS>) => {
  for (const k of Object.keys(limits) as Array<keyof typeof BRIDGE_LIMITS>) {
    const v = Number(limits[k])
    if (!Number.isFinite(v) || v <= 0) continue
    BRIDGE_LIMITS[k] = Math.floor(v)
    getDb().setSetting(`bridge_${k}`, String(Math.floor(v)))
  }
  return { ...BRIDGE_LIMITS }
})
wrapHandler('claudebridge:read-log', (_event, date?: string) => {
  return logger ? logger.readChannelLog('claudebridge', date) : ''
})

// ─── 预览面板 IPC（L3 Phase C/D）─────────────────────────────────────────────

/** 渲染进程报告 PreviewPane 的实际位置（屏幕坐标） */
wrapHandler('preview:set-bounds', (_event, bounds: { x: number; y: number; width: number; height: number }) => {
  if (!bounds || typeof bounds !== 'object') return
  previewManager?.setUserBounds(bounds)
})

/** 渲染进程切换 inspector 模式（cmd+click 选中元素） */
wrapHandler('preview:set-inspector', (_event, target: 'user' | 'hidden', enabled: boolean) => {
  if (target !== 'user' && target !== 'hidden') return
  previewManager?.setInspector(target, !!enabled)
})

/** 渲染进程切换 user view 显隐（折叠预览面板时用） */
wrapHandler('preview:set-user-visible', (_event, visible: boolean) => {
  previewManager?.setUserVisible(!!visible)
})

/** 渲染进程主动调用：把 Tweaks 表单收集的值写回 EDITMODE 块 */
wrapHandler('preview:apply-tweaks', (_event, conversationId: string, params: { path: string; blockId: string; values: Record<string, unknown> }) => {
  const { avatarId } = resolveWorkspaceContext(conversationId)
  const abs = workspaceManager.resolveCrossProjectPath(avatarId, conversationId, params.path)
  return applyTweaks({ htmlAbsPath: abs, blockId: params.blockId, newValues: params.values })
})

// ─── GitHub Connector IPC（L3 Phase K）───────────────────────────────────────

wrapHandler('github:status', () => ({
  connected: githubConnector.isConnected(),
  login: githubConnector.getCurrentLogin(),
}))
wrapHandler('github:connect', async (_event, token: string) => {
  return githubConnector.connect(token)
})
wrapHandler('github:disconnect', () => {
  githubConnector.disconnect()
})

// ─── snip 上下文管理 IPC（L3 Phase I）────────────────────────────────────────

wrapHandler('snip:list', (_event, conversationId: string) => {
  const raw = getDb().getSetting(`pending_snips_${conversationId}`) || '[]'
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
})
wrapHandler('snip:clear', (_event, conversationId: string) => {
  getDb().setSetting(`pending_snips_${conversationId}`, '[]')
})
/** 给消息分配 mNNNN 锚点（按会话单调自增） */
wrapHandler('snip:next-msg-id', (_event, conversationId: string) => {
  const cur = messageSeqCounters.get(conversationId) ?? 0
  const next = cur + 1
  messageSeqCounters.set(conversationId, next)
  // 持久化最新计数到 settings，重启后能从正确位置继续
  getDb().setSetting(`msg_seq_${conversationId}`, String(next))
  return `m${String(next).padStart(4, '0')}`
})
/** 应用启动时载入会话最近的 mNNNN 计数 */
wrapHandler('snip:hydrate', (_event, conversationId: string) => {
  const v = parseInt(getDb().getSetting(`msg_seq_${conversationId}`) ?? '0', 10) || 0
  messageSeqCounters.set(conversationId, v)
  return v
})

// ─── 知识库管理 ──────────────────────────────────────────────────────────────

wrapHandler('get-knowledge-tree', (_, avatarId: string) => {
  return getKnowledgeManager(avatarId).getKnowledgeTree()
})

wrapHandler('read-knowledge-file', (_, avatarId: string, relativePath: string) => {
  // KnowledgeManager.assertSafePath() 已做完整的 path.resolve 前缀校验
  return getKnowledgeManager(avatarId).readFile(relativePath)
})

/**
 * 从 .md 顶部 frontmatter 中提取 `raw_file` 字段的轻量实现。
 *
 * 设计意图：
 * - 主进程不能 import `src/` 下的 `parseFrontmatter`（src/ 属于渲染层 Vite 构建产物，
 *   主进程构建走 esbuild，混引会引入 Vite/electron 复杂依赖）。
 * - 此处只针对单个字段做行级正则匹配，避免重复实现完整 YAML 解析。
 *
 * 安全约束：
 * - 仅做字符串解析，不做路径解析；越界校验留给 handler 调用方。
 * - 必须先确认前 2 行是 `---`（CRLF/LF 兼容），再在闭合 `---` 之间匹配 `raw_file:`。
 *
 * @param src .md 文件全文
 * @returns trim 后的 raw_file 值；frontmatter 不存在或字段缺失返回 null
 */
function extractRawFileFromFrontmatter(src: string): string | null {
  if (!src.startsWith('---\n') && !src.startsWith('---\r\n')) {
    return null
  }
  const endMatch = src.match(/\n---\r?\n/)
  if (!endMatch || endMatch.index === undefined) {
    return null
  }
  const fmText = src.slice(4, endMatch.index)
  for (const line of fmText.split(/\r?\n/)) {
    const m = line.match(/^\s*raw_file\s*:\s*(.+?)\s*$/)
    if (m) {
      // 去除 YAML 风格的成对引号
      const value = m[1].trim().replace(/^["']|["']$/g, '')
      return value.length > 0 ? value : null
    }
  }
  return null
}

/**
 * knowledge:resolve-raw-file
 *
 * 用途：渲染层从 LLM 引用的 `[来源: knowledge/<file>.md#L12-L20]` anchor 解析出
 *       原始 PDF/Excel/PPT 路径（写在 .md 顶部 frontmatter `raw_file` 字段）。
 *       UI 据此展示「📎 原始文件」chip。
 *
 * 安全策略（双层防护）：
 *   1. KnowledgeManager.readFile 内部用 `resolveUnderRoot` 校验 mdRelativePath 不越出
 *      `<avatar>/knowledge/`；
 *   2. 解析 frontmatter 拿到的 `raw_file` 必须落在 `<knowledge>/_raw/` 目录下，
 *      防止恶意 frontmatter 写 `raw_file: ../../../etc/passwd` 越权。
 *
 * 任何一层校验失败、frontmatter 缺字段、或 .md 不存在都返回 null，由渲染层降级展示。
 */
wrapHandler('knowledge:resolve-raw-file', (_, avatarId: string, mdRelativePath: string) => {
  const km = getKnowledgeManager(avatarId)
  let mdContent: string
  try {
    mdContent = km.readFile(mdRelativePath)
  } catch (err) {
    if (logger) logger.activity('knowledge:resolve-raw-file', `read .md 失败 avatarId=${avatarId} path=${mdRelativePath} err=${err instanceof Error ? err.message : String(err)}`)
    return null
  }
  const rawValue = extractRawFileFromFrontmatter(mdContent)
  if (!rawValue) return null

  const knowledgePath = path.join(avatarsPath, avatarId, 'knowledge')
  const rawAbsPath = path.resolve(knowledgePath, rawValue)
  const rawRoot = path.join(knowledgePath, '_raw') + path.sep
  if (!rawAbsPath.startsWith(rawRoot)) {
    if (logger) logger.error('knowledge:resolve-raw-file', new Error(`raw_file 路径越界：${rawValue} → ${rawAbsPath}`))
    return null
  }

  const displayName = path.basename(rawAbsPath)
  const ext = path.extname(rawAbsPath).slice(1).toLowerCase()
  const exists = fs.existsSync(rawAbsPath)
  // 统一用相对 knowledge/ 的相对路径（POSIX 风格保持与入参 _raw/xxx 一致）
  const rawRelPath = path.relative(knowledgePath, rawAbsPath).split(path.sep).join('/')
  return { rawRelPath, displayName, ext, exists }
})

/**
 * knowledge:open-raw-file
 *
 * 用途：用系统默认应用打开 `<avatar>/knowledge/_raw/` 下的原始文件（PDF/Excel/PPT…）。
 *
 * 安全策略：
 *   1. avatarId 经 `assertSafeSegment` 校验（不含 `/` `\` `..` `\0` 且非保留名）；
 *   2. 解析后的绝对路径必须以 `<knowledge>/_raw/` 为前缀，否则拒绝（防止
 *      渲染层伪造 `rawRelPath: ../../etc/passwd`）；
 *   3. 文件不存在直接返回 ok:false，不调 shell.openPath（避免 macOS 弹错误对话框）。
 */
wrapHandler('knowledge:open-raw-file', async (_, avatarId: string, rawRelPath: string) => {
  assertSafeSegment(avatarId, '分身ID')
  const knowledgePath = path.join(avatarsPath, avatarId, 'knowledge')
  const absPath = path.resolve(knowledgePath, rawRelPath)
  const rawRoot = path.join(knowledgePath, '_raw') + path.sep
  if (!absPath.startsWith(rawRoot)) {
    const msg = `raw 路径越界：${rawRelPath}`
    if (logger) logger.error('knowledge:open-raw-file', new Error(msg))
    return { ok: false, error: msg }
  }
  if (!fs.existsSync(absPath)) {
    return { ok: false, error: `原始文件不存在：${rawRelPath}` }
  }
  // shell.openPath：成功返回 ''，失败返回错误描述字符串
  const openErr = await shell.openPath(absPath)
  if (openErr) {
    if (logger) logger.error('knowledge:open-raw-file', new Error(`shell.openPath 失败：${openErr}`))
    return { ok: false, error: openErr }
  }
  return { ok: true }
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
  // 收集该分身下所有会话 ID，先清磁盘附件目录，再走 DB CASCADE 清空
  try {
    if (attachmentStore) {
      const convIds = getDb().getConversations(id).map(c => c.id)
      for (const cid of convIds) {
        try {
          attachmentStore.deleteAttachmentsByConversation(cid)
        } catch (e) {
          if (logger) logger.error('delete-avatar:cleanup-attachments', e)
        }
      }
    }
  } catch (err) {
    if (logger) logger.error('delete-avatar:list-conversations-for-cleanup', err)
  }
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
  const skills = skillManager.getSkills(avatarId)
  return skills.map((s: any) => ({
    ...s,
    source: s.source || 'local',
  }))
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

wrapHandler('create-skill', (_, avatarId: string, skillId: string, content: string) => {
  assertSafeSegment(avatarId, '分身ID')
  const created = skillManager.createSkill(avatarId, skillId, content)
  if (logger) logger.recordGenerated('skill', avatarId, created.filePath, { skillId, action: 'create' })
  return created
})

wrapHandler('delete-skill', (_, avatarId: string, skillId: string) => {
  assertSafeSegment(avatarId, '分身ID')
  assertSafeSegment(skillId, '技能ID')
  skillManager.deleteSkill(avatarId, skillId)
  if (logger) logger.activity('delete-skill', `avatarId=${avatarId}, skillId=${skillId}`)
})

/**
 * generate-skill-draft: 用 LLM 把用户的自然语言描述转成 skill markdown 草稿。
 * 参考 templates/skill-template.md 的格式 + templates/skills/*.md 的 few-shot 示例。
 * 返回 { draft, suggestedId }，前端把 draft 预填到编辑器，suggestedId 预填到 ID 输入框。
 */
wrapHandler('generate-skill-draft', async (_, description: string) => {
  if (!description || description.trim().length === 0) {
    throw new Error('请提供技能描述')
  }
  const apiKey = getDb().getSetting('chat_api_key') ?? ''
  const baseUrl = getDb().getSetting('chat_base_url') ?? 'https://api.deepseek.com/v1'
  const chatModel = getDb().getSetting('chat_model') ?? 'deepseek-chat'
  if (!apiKey) {
    throw new Error('未配置 chat_api_key，请先在设置里填入 LLM API Key')
  }
  // 复用 createLLMFn（已修复 fetchJsonWithTimeout 的 body 读取超时问题）
  const callLLM = createLLMFn(apiKey, baseUrl, chatModel)
  const userPrompt = buildSkillGenUserPrompt(templatesPath, description)
  // 8192 tokens 足够生成一份完整 skill，单次调用通常 < 60s
  const draft = await callLLM(SKILL_GEN_SYSTEM_PROMPT, userPrompt, 8192)

  // 从 frontmatter 里提取 name 字段作为 suggestedId（若失败则给空字符串让用户手填）
  let suggestedId = ''
  const nameMatch = draft.match(/^---\s*\n[\s\S]*?\nname:\s*([A-Za-z0-9_-]+)\s*\n[\s\S]*?\n---/m)
  if (nameMatch) suggestedId = nameMatch[1]

  if (logger) logger.activity('generate-skill-draft', `description.len=${description.length}, draft.len=${draft.length}, suggestedId=${suggestedId}`)
  return { draft, suggestedId }
})

// ─── 社区技能管理 ─────────────────────────────────────────────────────────────
wrapHandler('community:list-sources', () => {
  return communitySkillManager.listSources()
})

wrapHandler('community:add-source', (_, source: { name: string; repo: string; ref: string; path?: string; file?: string; skills?: string[] }) => {
  communitySkillManager.addSource(source)
})

wrapHandler('community:remove-source', (_, name: string) => {
  communitySkillManager.removeSource(name)
})

wrapHandler('community:sync', async () => {
  const results = await communitySkillManager.sync((progress) => {
    if (mainWindow) mainWindow.webContents.send('community:sync-progress', progress)
  })
  return results
})

wrapHandler('community:list-installed', () => {
  return communitySkillManager.listInstalled()
})

wrapHandler('community:enable-for-avatar', (_, avatarId: string, skillName: string, packName: string) => {
  assertSafeSegment(avatarId, '分身ID')
  communitySkillManager.enableForAvatar(avatarId, skillName, packName)
})

wrapHandler('community:disable-for-avatar', (_, avatarId: string, skillName: string) => {
  assertSafeSegment(avatarId, '分身ID')
  communitySkillManager.disableForAvatar(avatarId, skillName)
})

// ─── 工具调用（GAP4）────────────────────────────────────────────────────────

/**
 * execute-tool-call: 执行 LLM 发起的工具调用，返回结果字符串给渲染进程。
 * avatarId 用于定位该分身的知识库路径。
 */
wrapHandler('execute-tool-call', async (_, avatarId: string, conversationId: string, name: string, args: Record<string, unknown>) => {
  return withToolCallAudit(avatarId, conversationId, name, args, async () => {
  assertSafeSegment(avatarId, '分身ID')
  assertSafeSegment(conversationId, '会话ID')
  const { workspaceRoot } = resolveWorkspaceContext(conversationId)

  // ─── L3 桌面能力工具：完整版实现 ───────────────────────────────────────
  // 预览：加载 HTML / 评估 JS / 抓日志 / 截图
  if (name === 'show_to_user' || name === 'show_html') {
    const rawPath = (args.path as string) ?? ''
    if (!rawPath) return { content: '', error: '缺少 path 参数' }
    const absPath = workspaceManager.resolveCrossProjectPath(avatarId, conversationId, rawPath)
    await previewManager?.load(name === 'show_to_user' ? 'user' : 'hidden', absPath, conversationId)
    if (name === 'show_to_user') {
      // 通知聊天面板：用户预览已切换，可弹出 inspector 入口
      mainWindow?.webContents.send('preview:loaded', { conversationId, path: rawPath })
    }
    return { content: `已在预览中打开: ${rawPath}` }
  }
  if (name === 'eval_js' || name === 'eval_js_user_view') {
    const code = (args.code as string) ?? ''
    if (!code) return { content: '', error: '缺少 code 参数' }
    const output = await previewManager?.eval(name === 'eval_js_user_view' ? 'user' : 'hidden', code)
    return { content: typeof output === 'string' ? output : JSON.stringify(output ?? null, null, 2) }
  }
  if (name === 'get_webview_logs') {
    return { content: (previewManager?.getLogs() ?? []).join('\n') || '暂无日志' }
  }
  if (name === 'screenshot_user_view') {
    const shot = await previewManager?.screenshot('user')
    return { content: JSON.stringify(shot ?? {}, null, 2) }
  }
  if (name === 'save_screenshot') {
    const savePath = typeof args.save_path === 'string' ? args.save_path : `screenshots/${Date.now()}.png`
    const shot = await previewManager?.screenshot('hidden', path.join(workspaceRoot, savePath))
    return { content: JSON.stringify({ ...shot, savePath }, null, 2) }
  }
  if (name === 'multi_screenshot') {
    /**
     * 真实多步截图：
     *   args.steps = [{ action: 'eval' | 'wait' | 'screenshot', code?, ms?, save_path? }, ...]
     * 在 hidden view 中按顺序执行；每个 screenshot step 落盘到 workspace/screenshots/。
     */
    const steps = Array.isArray(args.steps) ? args.steps as Array<{ action: string; code?: string; ms?: number; save_path?: string }> : []
    if (!previewManager) return { content: '', error: 'previewManager 未初始化' }
    const out: Array<{ index: number; action: string; result?: unknown; path?: string; width?: number; height?: number; error?: string }> = []
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i]
      try {
        if (step.action === 'eval') {
          const r = await previewManager.eval('hidden', step.code || '')
          out.push({ index: i, action: 'eval', result: typeof r === 'string' ? r : JSON.stringify(r) })
        } else if (step.action === 'wait') {
          await new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, Math.min(10_000, step.ms ?? 200))))
          out.push({ index: i, action: 'wait' })
        } else if (step.action === 'screenshot') {
          const sp = step.save_path || `screenshots/multi-${Date.now()}-${i}.png`
          const abs = workspaceManager.resolveSafe(avatarId, conversationId, sp)
          const shot = await previewManager.screenshot('hidden', abs)
          out.push({ index: i, action: 'screenshot', path: sp, width: shot.width, height: shot.height })
        } else {
          out.push({ index: i, action: step.action, error: `未知 action: ${step.action}` })
        }
      } catch (stepErr) {
        out.push({ index: i, action: step.action, error: stepErr instanceof Error ? stepErr.message : String(stepErr) })
      }
    }
    return { content: JSON.stringify({ steps: out }, null, 2) }
  }
  if (name === 'done') {
    const rawPath = (args.path as string) ?? ''
    if (!rawPath) return { content: '', error: '缺少 path 参数' }
    const absPath = workspaceManager.resolveCrossProjectPath(avatarId, conversationId, rawPath)
    await previewManager?.load('user', absPath, conversationId)
    mainWindow?.webContents.send('preview:loaded', { conversationId, path: rawPath, done: true })
    return { content: `done: ${rawPath}\n${(previewManager?.getLogs() ?? []).slice(-20).join('\n')}` }
  }

  // VerifierAgent：真实多视口校验
  if (name === 'fork_verifier_agent') {
    const targetPath = typeof args.path === 'string' ? args.path : (typeof args.task === 'string' ? args.task : '')
    if (!targetPath) {
      return { content: '', error: '缺少 path 参数' }
    }
    const absIn = workspaceManager.resolveCrossProjectPath(avatarId, conversationId, targetPath)
    const verifyOutDir = path.join(workspaceRoot, '.verifier', String(Date.now()))
    const result = await verifierAgent.verify({
      url: `file://${absIn}`,
      outputDir: verifyOutDir,
      parentWindow: mainWindow,
    })
    // 把 result 推到聊天面板，让 UI 渲染验证卡片（成功/失败 + 截图缩略图）
    mainWindow?.webContents.send('verifier:result', { conversationId, ...result, outputDir: verifyOutDir })
    return {
      content: JSON.stringify({
        ok: result.ok,
        message: result.message,
        errors: result.errors.slice(0, 10),
        warnings: result.warnings.slice(0, 5),
        resourceFailures: result.resourceFailures.slice(0, 10),
        shots: result.shots.map((s) => ({ viewport: s.viewport.name, file: s.filePath ? path.join('.verifier', path.basename(verifyOutDir), s.filePath) : undefined, width: s.width, height: s.height })),
        elapsedMs: result.elapsedMs,
      }, null, 2),
    }
  }

  // 导出：HTML
  if (name === 'save_as_html') {
    const outputPath = (args.output_path as string) || (args.path as string) || `export/${Date.now()}.html`
    const html = typeof args.html === 'string' ? args.html : ''
    const sourcePath = typeof args.input_path === 'string' ? args.input_path : undefined
    const absOut = workspaceManager.resolveSafe(avatarId, conversationId, outputPath)
    fs.mkdirSync(path.dirname(absOut), { recursive: true })
    if (sourcePath) {
      const absIn = workspaceManager.resolveCrossProjectPath(avatarId, conversationId, sourcePath)
      fs.copyFileSync(absIn, absOut)
    } else {
      fs.writeFileSync(absOut, html, 'utf-8')
    }
    return { content: `已导出 HTML: ${outputPath}` }
  }

  // 导出：超级内联 HTML（真实 jsdom 解析 + 资源内联）
  if (name === 'super_inline_html') {
    const inputPath = (args.input_path as string) || (args.path as string) || ''
    if (!inputPath) return { content: '', error: '缺少 input_path 参数' }
    const outputPath = (args.output_path as string) || `export/inlined-${Date.now()}.html`
    const absIn = workspaceManager.resolveCrossProjectPath(avatarId, conversationId, inputPath)
    const absOut = workspaceManager.resolveSafe(avatarId, conversationId, outputPath)
    const result = await superInlineHtml({
      inputPath: absIn,
      outputPath: absOut,
      resourceBaseDir: path.dirname(absIn),
    })
    return {
      content: JSON.stringify({
        outputPath,
        inlinedCss: result.inlinedCss,
        inlinedScripts: result.inlinedScripts,
        inlinedImages: result.inlinedImages,
        inlinedFonts: result.inlinedFonts,
        warnings: result.warnings,
      }, null, 2),
    }
  }

  // 导出：PDF（已是真实 printToPDF，保留）
  if (name === 'save_as_pdf') {
    const sourcePath = (args.source_path as string) ?? (args.input_path as string) ?? ''
    if (!sourcePath) return { content: '', error: '缺少 source_path 参数' }
    const absIn = workspaceManager.resolveCrossProjectPath(avatarId, conversationId, sourcePath)
    const pdfWin = new BrowserWindow({ show: false, webPreferences: { partition: 'persist:soul-print' } })
    try {
      await pdfWin.loadFile(absIn)
      // 等动画/字体稳定
      await new Promise<void>((resolve) => setTimeout(resolve, 300))
      const pdfBuffer = await pdfWin.webContents.printToPDF({ printBackground: true, preferCSSPageSize: true })
      const outputPath = (args.output_path as string) || `export/${path.basename(sourcePath, path.extname(sourcePath))}.pdf`
      const absOut = workspaceManager.resolveSafe(avatarId, conversationId, outputPath)
      fs.mkdirSync(path.dirname(absOut), { recursive: true })
      fs.writeFileSync(absOut, pdfBuffer)
      return { content: `已导出 PDF: ${outputPath}` }
    } finally {
      try { pdfWin.close() } catch {}
    }
  }

  // 导出：PPTX 真实可编辑（pptxgenjs + jsdom）+ 截图模式（hidden BrowserWindow per-slide）
  if (name === 'gen_pptx' || name === 'export_pptx') {
    const outputPath = (args.save_to_project_path as string) || (args.output_path as string) || `export/${Date.now()}.pptx`
    const absOut = workspaceManager.resolveSafe(avatarId, conversationId, outputPath)
    const inputPath = (args.input_path as string) || ''
    const mode = (args.mode as string) === 'screenshots' ? 'screenshots' : 'editable'
    if (!inputPath) {
      return { content: '', error: '缺少 input_path 参数（HTML 文件相对路径）' }
    }
    const absIn = workspaceManager.resolveCrossProjectPath(avatarId, conversationId, inputPath)
    if (!fs.existsSync(absIn)) return { content: '', error: `输入 HTML 不存在: ${inputPath}` }
    const htmlContent = fs.readFileSync(absIn, 'utf-8')

    if (mode === 'screenshots') {
      // 用 hidden BrowserWindow 渲染 + 按 .slide 截图
      const slideSelector = (args.page_selector as string) || '.slide,.pptx-slide,section.slide'
      const win = new BrowserWindow({
        width: Number(args.viewport_width) || 1920,
        height: Number(args.viewport_height) || 1080,
        show: false,
        webPreferences: { offscreen: true, partition: 'persist:soul-pptx' },
      })
      try {
        await win.loadFile(absIn)
        await new Promise<void>((resolve) => setTimeout(resolve, 400))
        const slideCount = (await win.webContents.executeJavaScript(`document.querySelectorAll(${JSON.stringify(slideSelector)}).length`, true)) as number
        const shots: string[] = []
        for (let i = 0; i < slideCount; i++) {
          const scrollScript = `(function(sel, idx){var list=document.querySelectorAll(sel);if(list[idx]){list[idx].scrollIntoView({block:'start',behavior:'instant'});}})(${JSON.stringify(slideSelector)}, ${i})`
          await win.webContents.executeJavaScript(scrollScript, true)
          await new Promise<void>((resolve) => setTimeout(resolve, 150))
          const img = await win.webContents.capturePage()
          shots.push(img.toDataURL())
        }
        const result = await htmlToPptx({
          htmlContent,
          outputPath: absOut,
          slideScreenshots: shots,
          resourceBaseDir: path.dirname(absIn),
        })
        return { content: `已导出 PPTX（screenshots 模式）: ${outputPath}, 幻灯片 ${result.slideCount} 页` }
      } finally {
        try { win.close() } catch {}
      }
    }

    const result = await htmlToPptx({
      htmlContent,
      outputPath: absOut,
      pageSelector: typeof args.page_selector === 'string' ? args.page_selector : undefined,
      resourceBaseDir: path.dirname(absIn),
    })
    return {
      content: JSON.stringify({
        outputPath,
        slideCount: result.slideCount,
        selectorUsed: result.selectorUsed,
        warnings: result.warnings,
      }, null, 2),
    }
  }

  // 文件下载卡片：把文件信息推到聊天面板，UI 渲染下载/打开按钮
  if (name === 'present_fs_item_for_download') {
    const rel = (args.path as string) ?? ''
    if (!rel) return { content: '', error: '缺少 path 参数' }
    const abs = workspaceManager.resolveCrossProjectPath(avatarId, conversationId, rel)
    if (!fs.existsSync(abs)) return { content: '', error: `文件不存在: ${rel}` }
    const stat = fs.statSync(abs)
    mainWindow?.webContents.send('chat:download-card', {
      conversationId,
      relativePath: rel,
      absolutePath: abs,
      sizeBytes: stat.size,
      mimeHint: path.extname(abs).slice(1),
    })
    return { content: `已生成下载卡片: ${rel} (${(stat.size / 1024).toFixed(1)} KB)` }
  }

  // 打印：在新窗口加载并自动调起打印对话框
  if (name === 'open_for_print') {
    const rel = (args.project_relative_file_path as string) || (args.path as string) || ''
    if (!rel) return { content: '', error: '缺少 project_relative_file_path 参数' }
    const abs = workspaceManager.resolveCrossProjectPath(avatarId, conversationId, rel)
    // 同 createWindow 的优雅显示模式：show: false + ready-to-show 避免 Windows 启动竞态
    // 导致打印窗口显示但合成器未就绪、window.print() 拿不到焦点
    const printWin = new BrowserWindow({
      width: 1200,
      height: 900,
      show: false,
      backgroundColor: '#ffffff',
      webPreferences: { partition: 'persist:soul-print' },
    })
    printWin.once('ready-to-show', () => {
      printWin.show()
      printWin.focus()
    })
    await printWin.loadFile(abs)
    // 在已加载页面里调用 window.print()，让用户走系统打印对话框
    try { await printWin.webContents.executeJavaScript('setTimeout(()=>window.print(),200)', true) } catch {}
    return { content: `已打开打印窗口: ${rel}` }
  }

  // 真实 HTTP 服务：把 workspace 文件挂成 http://127.0.0.1/f/<token>，1 小时 TTL
  if (name === 'get_public_file_url') {
    const rel = (args.project_relative_file_path as string) || (args.path as string) || ''
    if (!rel) return { content: '', error: '缺少 project_relative_file_path 参数' }
    const abs = workspaceManager.resolveCrossProjectPath(avatarId, conversationId, rel)
    const ttlMs = Number.isFinite(args.ttl_ms) ? Math.max(60_000, Math.min(24 * 60 * 60_000, Number(args.ttl_ms))) : undefined
    const url = await publicFileServer.register(abs, ttlMs)
    return { content: url }
  }

  // questions_v2：保持把表单 schema 抛回前端的契约，但同时 push 一条专门的 form 消息
  if (name === 'questions_v2') {
    mainWindow?.webContents.send('chat:form-request', { conversationId, payload: args })
    return { content: JSON.stringify({ type: 'form_request', payload: args }, null, 2) }
  }

  /**
   * ask_question：交给 tool-router 做参数校验后，把生成的 payload 推到前端，
   * 让 ChatWindow 渲染 AskQuestionCard。LLM 收到的 content 仍由 tool-router 返回。
   */
  if (name === 'ask_question') {
    const result = await toolRouter.execute(avatarId, { name, arguments: args }, undefined, conversationId)
    if (result.error) return result
    try {
      const parsed = JSON.parse(result.content) as { type?: string; question?: string; options?: string[]; allow_custom?: boolean }
      if (parsed.type === 'ask_question' && parsed.question && Array.isArray(parsed.options)) {
        mainWindow?.webContents.send('chat:ask-question', {
          conversationId,
          question: parsed.question,
          options: parsed.options,
          allowCustom: parsed.allow_custom === true,
        })
      }
    } catch (parseErr) {
      logger.warn('ask_question', `payload 解析失败（忽略 UI 推送）: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`)
    }
    return result
  }

  /**
   * switch_mode：交给 tool-router 校验后，向前端广播模式切换事件。
   * 前端 chatStore 监听后更新 mode 字段，并刷新 UI 徽章。
   */
  if (name === 'switch_mode') {
    const result = await toolRouter.execute(avatarId, { name, arguments: args }, undefined, conversationId)
    if (result.error) return result
    try {
      const parsed = JSON.parse(result.content) as { mode?: string; reason?: string }
      if (parsed.mode === 'agent' || parsed.mode === 'plan' || parsed.mode === 'ask') {
        mainWindow?.webContents.send('chat:mode-changed', {
          conversationId,
          mode: parsed.mode,
          reason: parsed.reason,
        })
      }
    } catch (parseErr) {
      logger.warn('switch_mode', `payload 解析失败（忽略 UI 推送）: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`)
    }
    return result
  }

  // copy_starter_component：单文件 / 目录都支持
  if (name === 'copy_starter_component') {
    const kind = (args.kind as string) ?? ''
    if (!kind) return { content: '', error: '缺少 kind 参数' }
    assertSafeSegment(kind, 'starter kind')
    const srcPath = path.join(avatarsPath, '..', 'shared', 'starter-components', kind)
    if (!fs.existsSync(srcPath)) return { content: '', error: `starter 不存在: ${kind}` }
    const directory = typeof args.directory === 'string' ? args.directory : ''
    const destPath = workspaceManager.resolveSafe(avatarId, conversationId, path.join(directory, kind))
    fs.mkdirSync(path.dirname(destPath), { recursive: true })
    if (fs.statSync(srcPath).isDirectory()) {
      fs.cpSync(srcPath, destPath, { recursive: true, force: true })
    } else {
      fs.copyFileSync(srcPath, destPath)
    }
    return { content: `已复制 starter: ${path.relative(workspaceRoot, destPath).replace(/\\/g, '/')}` }
  }

  // Tweaks 协议：写回 EDITMODE-BEGIN/END 块
  if (name === 'apply_tweaks') {
    const targetPath = (args.path as string) || ''
    const blockId = (args.block_id as string) || ''
    const newValues = (args.values as Record<string, unknown>) || {}
    if (!targetPath || !blockId) return { content: '', error: '缺少 path / block_id 参数' }
    const abs = workspaceManager.resolveCrossProjectPath(avatarId, conversationId, targetPath)
    const r = applyTweaks({ htmlAbsPath: abs, blockId, newValues })
    return { content: JSON.stringify({ changed: r.changed, bytes: r.bytes, backupPath: r.backupPath ? path.relative(workspaceRoot, r.backupPath).replace(/\\/g, '/') : undefined }, null, 2) }
  }

  // GitHub Connector：真实 Octokit
  if (name === 'connect_github') {
    const token = (args.pat as string) || (args.token as string) || ''
    if (!token) {
      // 让 UI 弹出输入框：发送一条 system 消息让 ChatWindow 弹出 PAT 输入对话框
      mainWindow?.webContents.send('chat:request-github-pat', { conversationId })
      return { content: '请在弹出的对话框中粘贴 GitHub Personal Access Token（需要 repo 范围）。' }
    }
    const r = await githubConnector.connect(token)
    return { content: `已连接 GitHub 账户：${r.login}` }
  }
  if (name === 'github_list_repos') {
    if (!githubConnector.isConnected()) return { content: '', error: 'GitHub 未连接，请先调用 connect_github。' }
    const perPage = Number.isFinite(args.per_page) ? Number(args.per_page) : 30
    const repos = await githubConnector.listRepos(perPage)
    return { content: JSON.stringify(repos, null, 2) }
  }
  if (name === 'github_get_tree') {
    if (!githubConnector.isConnected()) return { content: '', error: 'GitHub 未连接，请先调用 connect_github。' }
    const owner = (args.owner as string) || ''
    const repo = (args.repo as string) || ''
    if (!owner || !repo) return { content: '', error: '缺少 owner / repo 参数' }
    const ref = typeof args.ref === 'string' ? args.ref : undefined
    const tree = await githubConnector.getTree(owner, repo, ref)
    return { content: JSON.stringify(tree, null, 2) }
  }
  if (name === 'github_read_file') {
    if (!githubConnector.isConnected()) return { content: '', error: 'GitHub 未连接，请先调用 connect_github。' }
    const owner = (args.owner as string) || ''
    const repo = (args.repo as string) || ''
    const filePath = (args.path as string) || ''
    if (!owner || !repo || !filePath) return { content: '', error: '缺少 owner / repo / path 参数' }
    const ref = typeof args.ref === 'string' ? args.ref : undefined
    const text = await githubConnector.readFile(owner, repo, filePath, ref)
    return { content: text }
  }
  if (name === 'github_import_files') {
    if (!githubConnector.isConnected()) return { content: '', error: 'GitHub 未连接，请先调用 connect_github。' }
    const owner = (args.owner as string) || ''
    const repo = (args.repo as string) || ''
    const files = Array.isArray(args.files) ? (args.files as Array<{ path: string; saveAs?: string }>) : []
    if (!owner || !repo || files.length === 0) return { content: '', error: '缺少 owner / repo / files 参数' }
    const ref = typeof args.ref === 'string' ? args.ref : undefined
    const r = await githubConnector.importFiles(avatarId, conversationId, owner, repo, files, ref)
    return { content: JSON.stringify(r, null, 2) }
  }

  // Canva：本地导出 + 打开浏览器，引导用户拖拽上传
  if (name === 'send_to_canva' || name === 'canva_open_upload') {
    const exportPath = typeof args.export_path === 'string' ? args.export_path : undefined
    if (exportPath) {
      const abs = workspaceManager.resolveCrossProjectPath(avatarId, conversationId, exportPath)
      if (fs.existsSync(abs)) {
        await shell.showItemInFolder(abs)
      }
    }
    await shell.openExternal('https://www.canva.com/upload')
    mainWindow?.webContents.send('chat:canva-upload-card', { conversationId, exportPath })
    return { content: `已打开 Canva 上传页 (https://www.canva.com/upload)；如已导出 ${exportPath ?? '文件'}，可拖拽到 Canva 完成导入。` }
  }

  // 文档解析：复用 documentParser
  if (name === 'read_pdf' || name === 'read_docx' || name === 'read_pptx') {
    const filePathArg = (args.path as string) || (args.file as string) || ''
    if (!filePathArg) return { content: '', error: '缺少 path 参数' }
    const abs = workspaceManager.resolveCrossProjectPath(avatarId, conversationId, filePathArg)
    if (!fs.existsSync(abs)) return { content: '', error: `文件不存在: ${filePathArg}` }
    const parsed = await documentParser.parseFile(abs)
    return {
      content: JSON.stringify({
        fileName: parsed.fileName,
        fileType: parsed.fileType,
        textPreview: parsed.text.slice(0, 8000),
        textLength: parsed.text.length,
        imageCount: parsed.images.length,
        sheetNames: parsed.sheetNames,
      }, null, 2),
    }
  }

  // ─── 对话框附件按需读取（Tool-use 路径） ────────────────────────────
  // read_attachment：按 attachment_id 读取对话框上传的附件，支持 char_range / page_range 分段切片
  if (name === 'read_attachment') {
    const attachmentId = String(args.id ?? '').trim()
    if (!attachmentId) return { content: '', error: '缺少 id 参数（形如 att_xxx）' }
    const row = getDb().getAttachmentById(attachmentId)
    if (!row) return { content: '', error: `附件不存在或已删除: ${attachmentId}` }
    if (row.conversation_id !== conversationId) {
      // 防越权：附件按会话隔离，禁止跨会话读取
      return { content: '', error: '附件不属于当前会话，无权限读取' }
    }

    let parsed = attachmentParseCache.get(attachmentId)
    if (!parsed) {
      try {
        const abs = attachmentStore.getAttachmentAbsPath(row.conversation_id, row.hash, row.ext)
        if (!fs.existsSync(abs)) return { content: '', error: `附件文件已丢失: ${row.name}` }
        const result = await documentParser.parseFile(abs)
        parsed = {
          fileType: result.fileType,
          text: result.text,
          perPageChars: result.perPageChars,
          sheetNames: result.sheetNames,
        }
        rememberParsedAttachment(attachmentId, parsed)
      } catch (parseErr) {
        const msg = parseErr instanceof Error ? parseErr.message : String(parseErr)
        return { content: '', error: `附件解析失败: ${msg}` }
      }
    }

    const fullText = parsed.text || ''
    const totalChars = fullText.length
    const DEFAULT_RETURN_CHARS = 16_000

    // page_range（仅 PDF 且 perPageChars 可用时）
    const pageRange = Array.isArray(args.page_range) ? args.page_range as unknown[] : null
    if (pageRange && pageRange.length === 2) {
      if (!parsed.perPageChars || parsed.perPageChars.length === 0) {
        return { content: '', error: 'page_range 仅对 PDF 等带分页信息的附件有效，本附件无分页元数据，请改用 char_range' }
      }
      const from = Math.max(1, Math.floor(Number(pageRange[0])))
      const to = Math.max(from, Math.floor(Number(pageRange[1])))
      let cursor = 0
      let startChar = -1
      let endChar = -1
      for (const p of parsed.perPageChars) {
        if (p.num === from) startChar = cursor
        cursor += p.chars
        if (p.num === to) { endChar = cursor; break }
      }
      if (startChar < 0) return { content: '', error: `page_range 起始页 ${from} 超出文档总页数（共 ${parsed.perPageChars.length} 页）` }
      if (endChar < 0) endChar = totalChars
      const sliced = fullText.slice(startChar, endChar)
      return {
        content: JSON.stringify({
          attachmentId,
          name: row.name,
          fileType: parsed.fileType,
          totalPages: parsed.perPageChars.length,
          totalChars,
          pageRange: [from, to],
          charRange: [startChar, endChar],
          text: sliced.length > DEFAULT_RETURN_CHARS ? sliced.slice(0, DEFAULT_RETURN_CHARS) : sliced,
          truncated: sliced.length > DEFAULT_RETURN_CHARS,
          hint: sliced.length > DEFAULT_RETURN_CHARS ? `本次返回前 ${DEFAULT_RETURN_CHARS} 字，剩余 ${sliced.length - DEFAULT_RETURN_CHARS} 字可用 char_range 续读` : undefined,
        }, null, 2),
      }
    }

    // char_range（默认前 16000 字）
    let start = 0
    let end = Math.min(totalChars, DEFAULT_RETURN_CHARS)
    const charRange = Array.isArray(args.char_range) ? args.char_range as unknown[] : null
    if (charRange && charRange.length === 2) {
      const s = Math.max(0, Math.floor(Number(charRange[0])))
      const e = Math.max(s, Math.floor(Number(charRange[1])))
      start = s
      end = Math.min(totalChars, e)
      // 单次切片硬上限 32k 字，避免 LLM 上下文炸
      const HARD_SLICE_LIMIT = 32_000
      if (end - start > HARD_SLICE_LIMIT) end = start + HARD_SLICE_LIMIT
    }
    const sliced = fullText.slice(start, end)
    return {
      content: JSON.stringify({
        attachmentId,
        name: row.name,
        fileType: parsed.fileType,
        totalChars,
        totalPages: parsed.perPageChars?.length,
        sheetNames: parsed.sheetNames,
        charRange: [start, end],
        text: sliced,
        truncated: end < totalChars,
        hint: end < totalChars ? `本次返回 ${start}-${end} 字，全文共 ${totalChars} 字，可用 char_range:[${end}, ${Math.min(totalChars, end + DEFAULT_RETURN_CHARS)}] 续读` : undefined,
      }, null, 2),
    }
  }

  // search_attachment：在已上传附件中按关键词全文检索，返回命中行号 + 上下文
  if (name === 'search_attachment') {
    const attachmentId = String(args.id ?? '').trim()
    const keyword = String(args.keyword ?? '')
    if (!attachmentId) return { content: '', error: '缺少 id 参数' }
    if (!keyword) return { content: '', error: '缺少 keyword 参数' }
    const row = getDb().getAttachmentById(attachmentId)
    if (!row) return { content: '', error: `附件不存在或已删除: ${attachmentId}` }
    if (row.conversation_id !== conversationId) {
      return { content: '', error: '附件不属于当前会话，无权限读取' }
    }

    let parsed = attachmentParseCache.get(attachmentId)
    if (!parsed) {
      try {
        const abs = attachmentStore.getAttachmentAbsPath(row.conversation_id, row.hash, row.ext)
        if (!fs.existsSync(abs)) return { content: '', error: `附件文件已丢失: ${row.name}` }
        const result = await documentParser.parseFile(abs)
        parsed = {
          fileType: result.fileType,
          text: result.text,
          perPageChars: result.perPageChars,
          sheetNames: result.sheetNames,
        }
        rememberParsedAttachment(attachmentId, parsed)
      } catch (parseErr) {
        const msg = parseErr instanceof Error ? parseErr.message : String(parseErr)
        return { content: '', error: `附件解析失败: ${msg}` }
      }
    }

    const maxHits = Math.min(100, Math.max(1, Number.isFinite(args.max_hits) ? Number(args.max_hits) : 20))
    const lines = (parsed.text || '').split(/\r?\n/)
    const hits: Array<{ line: number; text: string; context: string }> = []
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes(keyword)) {
        const ctxStart = Math.max(0, i - 1)
        const ctxEnd = Math.min(lines.length, i + 2)
        hits.push({
          line: i + 1,
          text: lines[i].slice(0, 240),
          context: lines.slice(ctxStart, ctxEnd).join('\n').slice(0, 600),
        })
        if (hits.length >= maxHits) break
      }
    }
    return {
      content: JSON.stringify({
        attachmentId,
        name: row.name,
        keyword,
        totalHits: hits.length,
        truncated: hits.length >= maxHits,
        hits,
        hint: hits.length === 0 ? `关键词 "${keyword}" 未命中，可尝试拆分为更短的子词，或先用 read_attachment 看大纲` : undefined,
      }, null, 2),
    }
  }

  // snip：把指定 [id:mNNNN] 范围内的消息从聊天上下文中移除（实际是写入 pending_snips 设置表）
  if (name === 'snip') {
    const fromId = String(args.from_id ?? '').trim()
    const toId = String(args.to_id ?? '').trim()
    if (!fromId || !toId) return { content: '', error: '缺少 from_id / to_id 参数（格式: mNNNN）' }
    if (!/^m\d{4,6}$/.test(fromId) || !/^m\d{4,6}$/.test(toId)) {
      return { content: '', error: 'from_id / to_id 必须形如 m0001（小写 m + 4-6 位数字）' }
    }
    const key = `pending_snips_${conversationId}`
    const existing = getDb().getSetting(key) || '[]'
    let list: Array<{ from: string; to: string; reason: string; addedAt: number }>
    try {
      list = JSON.parse(existing)
      if (!Array.isArray(list)) list = []
    } catch {
      list = []
    }
    list.push({
      from: fromId,
      to: toId,
      reason: typeof args.reason === 'string' ? args.reason : '',
      addedAt: Date.now(),
    })
    getDb().setSetting(key, JSON.stringify(list))
    mainWindow?.webContents.send('chat:snip-added', { conversationId, fromId, toId })
    return { content: `已登记 snip：${fromId} → ${toId}（在下一次发送时会从上下文裁剪）` }
  }

  // Feature 7: 子代理委派时需要 LLM 调用函数
  const apiKey = getDb().getSetting('chat_api_key') ?? ''
  const baseUrl = getDb().getSetting('chat_base_url') ?? 'https://api.deepseek.com/v1'
  const chatModel = getDb().getSetting('chat_model') ?? 'deepseek-chat'
  const callLLM = apiKey ? createLLMFn(apiKey, baseUrl, chatModel) : undefined
  return toolRouter.execute(avatarId, { name, arguments: args }, callLLM, conversationId)
  })
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
  const _ragT0 = Date.now()
  const retriever = toolRouter.getRetriever(avatarId)
  console.log(`[rag-retrieve] getRetriever: ${Date.now() - _ragT0}ms`)

  const callLLM = createLLMFn(apiKey, baseUrl, 'qwen-turbo')  // 实体提取用 turbo 即可，plus 单次 ~177s 太慢
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

  // ─── Skill 路由（Layer 1 + Layer 2）──────────────────────────────
  // 在 RAG 检索之前先用 grep 路由选 skill，把选中 skill 的完整 SKILL.md
  // 注入到 RAG 结果里。LLM 一次性看到 RAG context + 技能指令，不需要
  // 额外一轮 load_skill 工具调用，省一次 LLM 往返。
  skillRouter.loadIndex(avatarId)
  const routeResult = skillRouter.route(avatarId, question)
  console.log(`[rag-retrieve] skillRouter: ${routeResult.log.durationMs}ms → ${routeResult.selectedSkill ?? 'none'}`)

  console.log(`[rag-retrieve] before retrieveAndBuildPrompt: ${Date.now() - _ragT0}ms`)
  const onProgress = (phase: string, detail?: string): void => {
    try {
      mainWindow?.webContents.send('rag-progress', { avatarId, phase, detail })
    } catch (sendErr) {
      void sendErr
    }
  }

  // Skill 路由命中时单独推一条事件，让前端 ToolCallTimeline 能展示「★ 加载技能 X」这一步。
  // 注意：'skill-loaded' 不在 RAGProgressPhase 枚举里，是渲染端约定的伪 phase；
  // 这里直接绕过 retrieveAndBuildPrompt 的 onProgress 类型限制，单独 send。
  if (routeResult.selectedSkill) {
    try {
      mainWindow?.webContents.send('rag-progress', {
        avatarId,
        phase: 'skill-loaded',
        detail: `加载技能：${routeResult.selectedSkill}`,
      })
    } catch (sendErr) {
      void sendErr
    }
  }

  let result = await retrieveAndBuildPrompt(retriever, question, { callLLM, callEmbedding, onProgress }, undefined, wikiChunks)

  // 如果路由命中了 skill，把 SKILL.md 内容注入到 RAG 结果前面
  // LLM 会看到 "技能指令 + RAG 参考 + 用户问题" 一次性完成，不需要 load_skill 工具
  if (routeResult.skillContent) {
    result = `[系统提示] 根据你的问题，自动加载了技能「${routeResult.selectedSkill}」的完整定义。\n请严格按照以下技能指令执行。\n\n---\n\n${routeResult.skillContent}\n\n---\n\n${result}`
  }

  console.log(`[rag-retrieve] total: ${Date.now() - _ragT0}ms`)
  toolRouter.saveRetrieverTokens(avatarId)
  return result
})

// ─── 图表答案持久化 cache（chartConsistencyMode 同问同答） ───────────────────
/**
 * 构造一条 ChartCacheEntry，自动给关键文件做 (mtimeMs, size) 快照：
 *  - <avatar>/soul.md（人格改 → 缓存应失效）
 *  - <avatar>/knowledge/_excel/<basename>.json（每条 excelBasename 对应一个）
 * excelBasenames 由渲染进程从对话里出现过的 query_excel.args.file 收集；
 * 不存在的 basename 也会被快照（mtime=0,size=0），"原不存在现存在"同样视为失效。
 */
function buildChartCacheEntry(
  avatarRoot: string,
  payload: { queryHash: string; queryPreview: string; assistantContent: string; excelBasenames?: string[] },
): ChartCacheEntry {
  const fileSnapshots = [
    captureFileSnapshot(path.join(avatarRoot, 'soul.md')),
  ]
  for (const basename of payload.excelBasenames ?? []) {
    assertSafeSegment(basename, 'Excel basename')
    fileSnapshots.push(
      captureFileSnapshot(path.join(avatarRoot, 'knowledge', '_excel', `${basename}.json`)),
    )
  }
  return {
    queryHash: payload.queryHash,
    queryPreview: payload.queryPreview.slice(0, 200),
    assistantContent: payload.assistantContent,
    fileSnapshots,
    createdAt: Date.now(),
  }
}

/**
 * get-chart-cache-hit: 查询并验证 chart 答案 cache。
 * 命中 → { hit:true, assistantContent, createdAt }；未命中 / 快照失效 → { hit:false }
 */
wrapHandler('get-chart-cache-hit', (_, avatarId: string, queryHash: string) => {
  assertSafeSegment(avatarId, '分身ID')
  if (typeof queryHash !== 'string' || !/^[0-9a-f]{8}$/.test(queryHash)) {
    return { hit: false as const }
  }
  const cachePath = path.join(avatarsPath, avatarId, CHART_CACHE_REL_PATH)
  const cache = loadChartCache(cachePath)
  const entry = findChartCacheHit(cache, queryHash)
  if (!entry) return { hit: false as const }
  return { hit: true as const, assistantContent: entry.assistantContent, createdAt: entry.createdAt }
})

/**
 * save-chart-cache-entry: 写入 chart 答案 cache。主进程侧自动给 soul.md 和
 * excelBasenames 指向的 _excel/<basename>.json 做快照。
 */
wrapHandler('save-chart-cache-entry', (_, avatarId: string, payload: { queryHash: string; queryPreview: string; assistantContent: string; excelBasenames?: string[] }) => {
  assertSafeSegment(avatarId, '分身ID')
  if (!payload || typeof payload.queryHash !== 'string' || !/^[0-9a-f]{8}$/.test(payload.queryHash)) {
    return
  }
  if (typeof payload.queryPreview !== 'string' || typeof payload.assistantContent !== 'string') {
    return
  }
  const avatarRoot = path.join(avatarsPath, avatarId)
  const cachePath = path.join(avatarRoot, CHART_CACHE_REL_PATH)
  const cache = loadChartCache(cachePath)
  const entry = buildChartCacheEntry(avatarRoot, payload)
  const next = insertChartCacheEntry(cache, entry)
  saveChartCache(cachePath, next)
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
  // wiki 编译是离线批量任务，需要更强的实体抽取 / 概念聚合能力，保留 plus
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
 * 批量导入核心：逐文件完整处理（解析 → 清洗 → LLM 格式化 → 写入）。
 * 每完成一个文件立即可搜索，中断后下次跳过已完成文件（断点续导）。
 * 无 API Key 时降级为原始文本写入（仍然可用，只是未经 LLM 格式化）。
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

  // OCR API Key（批量导入只做解析 + 清洗 + OCR，不做 LLM 格式化）
  // LLM 格式化不影响检索质量（BM25 + 向量都作用在原始文本上），仅影响人工浏览时的可读性。
  // 格式化由用户在知识库文件查看器中按需对单个文件操作（ENHANCE 按钮）。
  const ocrApiKey = getDb().getSetting('ocr_api_key') || ''
  const ocrBaseUrl = getDb().getSetting('ocr_base_url') || 'https://dashscope.aliyuncs.com/compatible-mode/v1'

  const imported: Array<{ fileName: string; targetPath: string }> = []
  const failed: Array<{ path: string; error: string }> = []
  const total = files.length
  const kmgr = knowledgeManagers.get(avatarId) ?? new KnowledgeManager(knowledgePath)
  knowledgeManagers.set(avatarId, kmgr)

  const batchStartTime = Date.now()
  for (let i = 0; i < files.length; i++) {
    const filePath = files[i]
    const fileName = path.basename(filePath)
    const baseName = fileName
      .replace(/\.[^.]+$/, '')
      .replace(/[^a-zA-Z0-9\u4e00-\u9fa5_-]/g, '_')
    const relativePath = `${baseName}.md`

    // 断点续导：跳过已存在且已完成的文件
    const targetFullPath = path.join(knowledgePath, relativePath)
    if (fs.existsSync(targetFullPath)) {
      try {
        const head = fs.readFileSync(targetFullPath, 'utf-8').slice(0, 300)
        if (head.includes('source: enhanced') || (head.includes('source: ') && !head.includes('批量导入'))) {
          imported.push({ fileName, targetPath: relativePath })
          mainWindow?.webContents.send('knowledge-import-progress', {
            current: i + 1, total, fileName, phase: 'skipped (已完成)',
          })
          continue
        }
      } catch { /* 读取失败则重新导入 */ }
    }

    // 进度事件：解析中
    mainWindow?.webContents.send('knowledge-import-progress', {
      current: i, total, fileName, phase: `解析中 (${i + 1}/${total})`,
    })

    const fileStartTime = Date.now()
    try {
      const t0 = Date.now()
      const parsed = await documentParser.parseFile(filePath)
      const parseMs = Date.now() - t0

      // 保留原始文件到 _raw/
      let rawRelPath: string | null = null
      try {
        rawRelPath = await WikiCompiler.preserveRawFile(knowledgePath, filePath)
      } catch (rawErr) {
        if (logger) logger.activity('batch-import-preserve-raw', `${fileName}: ${rawErr instanceof Error ? rawErr.message : String(rawErr)}`)
      }

      // 清洗文本
      let cleanedText = cleanPdfFullText(parsed.text || '')
      if (parsed.fileType === 'word') {
        cleanedText = stripDocxToc(cleanedText)
      }

      // OCR 图表页（如果有图片且配置了 OCR API Key）
      let ocrMs = 0
      if (parsed.images.length > 0 && ocrApiKey) {
        mainWindow?.webContents.send('knowledge-import-progress', {
          current: i, total, fileName, phase: `OCR ${parsed.images.length} 张图 (${i + 1}/${total})`,
        })
        const ocrT0 = Date.now()
        try {
          const ocrOutcome = await callVisionOcr(parsed.images, {
            apiKey: ocrApiKey, baseUrl: ocrBaseUrl,
          })
          if (ocrOutcome.results.length > 0) {
            if (parsed.perPageChars) {
              // PDF 路径：按页号 merge 回原文本（保留 perPage 结构）
              const visionForMerge: Array<{ pageNum: number; content: string }> = []
              for (let vi = 0; vi < ocrOutcome.results.length; vi++) {
                const content = ocrOutcome.results[vi]
                if (content === null) continue
                visionForMerge.push({
                  pageNum: parsed.imagePageNumbers?.[vi] ?? (vi + 1),
                  content,
                })
              }
              if (visionForMerge.length > 0) {
                cleanedText = mergeVisionIntoText(cleanedText, visionForMerge, parsed.perPageChars)
              }
            } else {
              // 纯图片 / 图片型 docx 路径：无 perPage 结构，把 OCR 结果直接作为正文
              // 修复：此前 perPageChars 为空时整段 merge 被跳过，导致所有 .jpg/.png/.docx 图片
              // 解析出的 OCR 结果被静默丢弃，md 永远为空
              const ocrTexts = ocrOutcome.results.filter((r): r is string => r !== null && r.trim().length > 0)
              if (ocrTexts.length > 0) {
                const joined = ocrTexts.join('\n\n')
                cleanedText = cleanedText.trim() ? `${cleanedText}\n\n${joined}` : joined
              }
            }
          }
        } catch (ocrErr) {
          if (logger) logger.activity('batch-import-ocr', `${fileName} OCR 失败: ${ocrErr instanceof Error ? ocrErr.message : String(ocrErr)}`)
        }
        ocrMs = Date.now() - ocrT0
      }

      // 批量导入跳过 LLM 格式化（不影响检索，格式化由用户按需操作）
      const finalBody = cleanedText
      const sourceTag = parsed.fileType
      const fmtMs = 0

      // 写入文件（与单文件导入一致：大文件标 rag_only，小文件直接进 system prompt）
      const RAG_ONLY_THRESHOLD = 50_000  // 50KB 以上标 rag_only
      const isLargeFile = finalBody.length > RAG_ONLY_THRESHOLD
      const systemMeta: Record<string, unknown> = {}
      if (isLargeFile) systemMeta.rag_only = true
      systemMeta.source = sourceTag
      if (rawRelPath) systemMeta.raw_file = rawRelPath
      const enhanced = extractFrontmatterFields(fileName, finalBody)
      const fmBlock = buildFrontmatterBlock(mergeFrontmatter(systemMeta, enhanced))
      const finalContent = fmBlock + '\n\n' + finalBody
      kmgr.writeFile(relativePath, finalContent)

      // Excel 结构化 JSON 落盘（与单文件导入路径 KnowledgePanel.tsx:271 等价）
      // 缺这一步会导致 query_excel 工具找不到 _excel/<basename>.json 数据，无法精确过滤行
      if (parsed.structuredData) {
        try {
          const excelDir = path.join(knowledgePath, '_excel')
          if (!fs.existsSync(excelDir)) fs.mkdirSync(excelDir, { recursive: true })
          fs.writeFileSync(
            path.join(excelDir, `${baseName}.json`),
            JSON.stringify(parsed.structuredData, null, 2),
            'utf-8',
          )
        } catch (excelErr) {
          if (logger) logger.activity('batch-import-excel-json', `${fileName}: ${excelErr instanceof Error ? excelErr.message : String(excelErr)}`)
        }
      }

      const totalMs = Date.now() - fileStartTime
      const textLen = Math.round(cleanedText.length / 1024)
      console.log(`[batch-import] ✓ ${i + 1}/${total} ${fileName} — ${totalMs}ms (解析 ${parseMs}ms, OCR ${ocrMs}ms, 格式化 ${fmtMs}ms) ${textLen}KB`)

      imported.push({ fileName, targetPath: relativePath })
      mainWindow?.webContents.send('knowledge-import-progress', {
        current: i + 1, total, fileName, phase: `✓ ${Math.round(totalMs / 1000)}s (${i + 1}/${total})`,
      })
      // 每完成一个文件通知渲染进程刷新文件树
      mainWindow?.webContents.send('knowledge-file-written', { avatarId, fileName: relativePath })
    } catch (err) {
      failed.push({ path: filePath, error: err instanceof Error ? err.message : String(err) })
      mainWindow?.webContents.send('knowledge-import-progress', {
        current: i + 1, total, fileName, phase: 'failed',
      })
    }
  }

  const batchTotalSec = Math.round((Date.now() - batchStartTime) / 1000)
  console.log(`[batch-import] 完成: ${imported.length} 成功 / ${failed.length} 失败 / 共 ${total} 文件 — 总耗时 ${batchTotalSec}s (${Math.round(batchTotalSec / 60)}分${batchTotalSec % 60}秒)`)

  // 更新 README.md 索引（与单文件导入一致）
  if (imported.length > 0) {
    try {
      const readmePath = path.join(knowledgePath, 'README.md')
      let readme = ''
      try { readme = fs.readFileSync(readmePath, 'utf-8') } catch { /* 不存在则新建 */ }

      // README 不存在或为空时，生成完整模板
      const displayName = avatarId.replace(/-/g, ' ')
      if (!readme.trim()) {
        readme = `# ${displayName} 知识库

本目录存放 ${displayName} 分身的领域知识文件。分身在工作时会基于这些文件内容进行回答。

## 使用说明

1. 所有知识文件采用 **Markdown 格式**，分身可以直接读取
2. 添加新知识时，可通过顶部 IMPORT / FOLDER / ARCHIVE 按钮导入原始文档（PDF / DOCX / Excel 等）
3. 分身回答时会标注知识来源，格式为 \`[来源: knowledge/文件名]\`
4. 如果知识库中没有相关内容，分身会明确告知并建议补充

## 目录结构

\`\`\`
knowledge/
├── README.md          # 本文件（知识库索引）
├── _raw/              # 原始文档存档（PDF / DOCX 等）
├── _index/            # 检索索引（自动生成，勿手动修改）
└── *.md               # 知识文件（Markdown 格式）
\`\`\`

## 知识文件命名规范

- 使用 **中文名称 + 简短后缀** 命名，如 \`产品名-用户手册.md\`、\`场景名-最佳实践.md\`
- 文件名不使用空格，用 \`-\` 或 \`_\` 分隔

## 知识质量标准

- 每个知识文件开头包含来源说明（原始文档名称和版本）
- 关键数值已标注单位
- 图片中的数据已被 OCR 识别并写入 Markdown
- 本 README 的知识文件索引已同步更新
`
      }

      const newEntries = imported
        .filter(f => !readme.includes(f.targetPath))
        .map(f => `| ${f.targetPath.replace(/\.md$/, '')} | [${f.targetPath}](${f.targetPath}) | 批量导入 |`)
      if (newEntries.length > 0) {
        if (!readme.includes('| 文件 |') && !readme.includes('| --- |')) {
          readme += '\n## 知识文件索引\n\n| 文件 | 路径 | 来源 |\n| --- | --- | --- |\n'
        }
        readme += newEntries.join('\n') + '\n'
        fs.writeFileSync(readmePath, readme, 'utf-8')
      }
    } catch (readmeErr) {
      console.warn('[batch-import] README.md 更新失败（不影响导入）:', readmeErr instanceof Error ? readmeErr.message : String(readmeErr))
    }
  }

  return { imported, failed }
}

/** 批量导入完成后构建检索索引（BM25 tokens + contexts + embeddings） */
async function buildIndexAfterBatchImport(avatarId: string): Promise<void> {
  const knowledgePath = path.join(avatarsPath, avatarId, 'knowledge')
  const idxApiKey = getDb().getSetting('ocr_api_key') || getDb().getSetting('chat_api_key') || ''
  const idxBaseUrl = getDb().getSetting('ocr_base_url') || getDb().getSetting('chat_base_url') || 'https://dashscope.aliyuncs.com/compatible-mode/v1'
  if (!idxApiKey) return
  try {
    mainWindow?.webContents.send('knowledge-import-progress', {
      current: 0, total: 0, fileName: '', phase: '构建检索索引...',
    })
    const retriever = new KnowledgeRetriever(knowledgePath)
    const existingIndex = loadIndex(knowledgePath)
    const idxResult = await buildKnowledgeIndex(
      retriever,
      { callLLM: createLLMFn(idxApiKey, idxBaseUrl, 'qwen-turbo'), callEmbedding: createEmbeddingFn(idxApiKey, idxBaseUrl) },
      undefined,
      existingIndex,
    )
    saveIndex(knowledgePath, idxResult.contexts, idxResult.embeddings, idxResult.hashes)
    toolRouter.invalidateRetriever(avatarId)
  } catch (err) {
    if (logger) logger.error('batch-import-build-index', err instanceof Error ? err : new Error(String(err)))
  }
}

/**
 * import-folder: 导入整个文件夹。walk → 逐文件完整处理 → 构建索引。
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

  const { files, skipped, tempDirs } = await walkFolder(resolved)
  try {
    const { imported, failed } = await batchImportFiles(avatarId, files)
    // 批量导入完成后自动构建索引（每个文件已完整处理，索引一次性构建更高效）
    if (imported.length > 0) {
      await buildIndexAfterBatchImport(avatarId)
    }
    return { imported, skipped, failed }
  } finally {
    for (const td of tempDirs) await cleanupTempDir(td)
  }
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
  let nestedTempDirs: string[] = []
  try {
    mainWindow?.webContents.send('knowledge-import-progress', {
      current: 0,
      total: 0,
      fileName: path.basename(archivePath),
      phase: 'extracting',
    })
    await extractArchive(resolved, tempDir)

    const { files, skipped, tempDirs } = await walkFolder(tempDir)
    nestedTempDirs = tempDirs
    const { imported, failed } = await batchImportFiles(avatarId, files)
    if (imported.length > 0) {
      await buildIndexAfterBatchImport(avatarId)
    }
    return { imported, skipped, failed }
  } finally {
    await cleanupTempDir(tempDir)
    // walkFolder 解压嵌套归档时在 os.tmpdir() 下创建独立临时目录，需单独清理
    for (const td of nestedTempDirs) await cleanupTempDir(td)
  }
})

/**
 * format-knowledge-file: 对单个知识文件执行 LLM 格式化（从 _raw/ 重新解析 → 清洗 → 格式化 → 写回）。
 * 由用户在知识库文件查看器中按需点击"格式化"按钮触发。
 */
wrapHandler('format-knowledge-file', async (_, avatarId: string, relativePath: string): Promise<{ success: boolean; error?: string }> => {
  assertSafeSegment(avatarId, '分身ID')
  const knowledgePath = path.join(avatarsPath, avatarId, 'knowledge')
  const filePath = path.join(knowledgePath, relativePath)
  if (!fs.existsSync(filePath)) throw new Error(`文件不存在: ${relativePath}`)

  // 读取 API Key（creation > ocr > chat）
  const creationApiKey = getDb().getSetting('creation_api_key') || ''
  const creationBaseUrl = getDb().getSetting('creation_base_url') || 'https://dashscope.aliyuncs.com/compatible-mode/v1'
  const creationModel = getDb().getSetting('creation_model') || 'qwen-plus'
  const ocrApiKey = getDb().getSetting('ocr_api_key') || ''
  const ocrBaseUrl = getDb().getSetting('ocr_base_url') || 'https://dashscope.aliyuncs.com/compatible-mode/v1'
  const fmtApiKey = creationApiKey || ocrApiKey || getDb().getSetting('chat_api_key') || ''
  const fmtBaseUrl = creationApiKey ? creationBaseUrl : ocrApiKey ? ocrBaseUrl : (getDb().getSetting('chat_base_url') || 'https://dashscope.aliyuncs.com/compatible-mode/v1')
  const fmtModel = creationApiKey ? creationModel : ocrApiKey ? 'qwen-plus' : (getDb().getSetting('chat_model') ?? 'deepseek-chat')
  if (!fmtApiKey) throw new Error('未配置 API Key，无法格式化')
  const callLLM: LLMCallFn = createLLMFn(fmtApiKey, fmtBaseUrl, fmtModel)

  // 从 _raw/ 重新解析原始文件（如果有）或用当前 .md 的纯文本
  const rawDir = path.join(knowledgePath, '_raw')
  let rawText = ''
  let parsedFileType = 'text'

  // 尝试从 frontmatter 找到 raw_file
  const currentContent = fs.readFileSync(filePath, 'utf-8')
  const fmMatch = currentContent.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  let rawFilePath: string | null = null
  if (fmMatch) {
    const rawFileMatch = fmMatch[1].match(/^\s*raw_file\s*:\s*(.+?)\s*$/m)
    if (rawFileMatch) {
      const candidate = path.join(knowledgePath, rawFileMatch[1].trim())
      if (fs.existsSync(candidate)) rawFilePath = candidate
    }
  }

  if (rawFilePath) {
    const parsed = await documentParser.parseFile(rawFilePath)
    rawText = parsed.text || ''
    parsedFileType = parsed.fileType

    // OCR 图表页
    if (parsed.images.length > 0 && ocrApiKey) {
      try {
        const ocrOutcome = await callVisionOcr(parsed.images, { apiKey: ocrApiKey, baseUrl: ocrBaseUrl })
        if (ocrOutcome.results.length > 0) {
          if (parsed.perPageChars) {
            const visionForMerge: Array<{ pageNum: number; content: string }> = []
            for (let vi = 0; vi < ocrOutcome.results.length; vi++) {
              const content = ocrOutcome.results[vi]
              if (content === null) continue
              visionForMerge.push({ pageNum: parsed.imagePageNumbers?.[vi] ?? (vi + 1), content })
            }
            if (visionForMerge.length > 0) {
              rawText = mergeVisionIntoText(
                parsedFileType === 'word' ? stripDocxToc(cleanPdfFullText(rawText)) : cleanPdfFullText(rawText),
                visionForMerge, parsed.perPageChars,
              )
            }
          } else {
            // 纯图片 / 图片型 docx：无 perPage 结构，OCR 结果直接作正文
            const ocrTexts = ocrOutcome.results.filter((r): r is string => r !== null && r.trim().length > 0)
            if (ocrTexts.length > 0) {
              const joined = ocrTexts.join('\n\n')
              rawText = rawText.trim() ? `${rawText}\n\n${joined}` : joined
            }
          }
        }
      } catch {}
    }

    if (!rawText) rawText = cleanPdfFullText(parsed.text || '')
    else rawText = parsedFileType === 'word' ? stripDocxToc(cleanPdfFullText(rawText)) : cleanPdfFullText(rawText)
  } else {
    // 没有 _raw/ 原始文件，用 .md 中的纯文本
    let body = currentContent
    const fmEnd = currentContent.match(/^---\r?\n[\s\S]*?\r?\n---\s*\r?\n/)
    if (fmEnd) body = currentContent.slice(fmEnd[0].length)
    rawText = body.trim()
  }

  if (!rawText || rawText.length < 500) {
    return { success: false, error: rawText ? '文件内容过短（< 500 字符），无需格式化' : '文件无文字内容（纯图片/扫描件），格式化无效' }
  }

  if (isGarbledText(rawText)) {
    return { success: false, error: '文件内容为乱码（PDF 字体编码异常），请配置 OCR API Key 后重新导入原始 PDF' }
  }

  const baseName = relativePath.replace(/\.md$/, '')
  const formatted = await formatDocument(rawText, baseName, relativePath, callLLM)

  // 数值校验：检测 LLM 是否编造了原文中不存在的数值
  const fabricated = detectFabricatedNumbers(formatted, rawText)
  if (fabricated.length > 0 && logger) {
    logger.activity('format-file-fabrication', `${relativePath}: ${fabricated.length} 个疑似编造数值: ${fabricated.slice(0, 5).join(', ')}`)
  }

  // 写回（合并旧 frontmatter 保留用户自定义字段，修复此前整段重建丢字段的缺陷）
  const oldMeta = fmMatch ? parseFrontmatterCore(currentContent).meta : {}
  const isLarge = formatted.length > 50_000
  const newSystemMeta: Record<string, unknown> = { source: 'enhanced' }
  if (isLarge) newSystemMeta.rag_only = true
  const enhanced = extractFrontmatterFields(
    path.basename(filePath, path.extname(filePath)),
    formatted,
  )
  const mergedMeta = mergeFrontmatter(oldMeta, mergeFrontmatter(newSystemMeta, enhanced))
  const fmBlock = buildFrontmatterBlock(mergedMeta)
  fs.writeFileSync(filePath, fmBlock + '\n\n' + formatted, 'utf-8')

  return { success: true }
})

/**
 * enhance-knowledge-files: 对批量导入的知识文件补跑完整管线。
 * 完整管线：从 _raw/ 重新解析原始文件 → OCR → 清洗 → LLM 格式化 → 数值校验 → 写回。
 * 识别条件：文件含 `rag_only: true` frontmatter + `批量导入` 标记。
 * 格式化完成后保留 rag_only frontmatter（大文件不适合塞 system prompt）。
 * 索引构建和演化检测由调用方（渲染进程）在所有文件增强完成后统一执行。
 * 通过 knowledge-enhance-progress 事件上报进度。
 *
 * @author zhi.qu
 * @date 2026-04-14
 */
interface EnhanceKnowledgeOptions {
  /** LLM 格式化用的模型（必填）*/
  llm: { apiKey: string; baseUrl: string; model: string }
  /** Vision OCR 模型（可选，缺失则跳过图表页 OCR）*/
  ocr?: { apiKey: string; baseUrl?: string }
  /** 指定文件列表（批量导入后自动调用传入），省略时扫描全库 */
  targetFiles?: string[]
}

interface EnhanceKnowledgeResult {
  enhanced: number
  failed: number
  total: number
  /** 疑似编造数值的总数（跨所有文件累计）*/
  fabricatedWarnings: number
  /** 每个命中文件的具体疑似编造值（file 路径 + 值列表），便于前端展示抽屉 */
  fabricatedDetails: Array<{ file: string; values: string[] }>
  /** 跨所有文件累计的 OCR 单图失败数 */
  ocrFailures: number
  /** 是否在 ENHANCE 完成后重建了检索索引 */
  indexBuilt: boolean
  /** 索引上下文摘要数量（仅当 indexBuilt=true）*/
  contextCount?: number
  /** 索引向量数量（仅当 indexBuilt=true）*/
  embeddingCount?: number
}

wrapHandler('enhance-knowledge-files', async (_, avatarId: string, options: EnhanceKnowledgeOptions): Promise<EnhanceKnowledgeResult> => {
  assertSafeSegment(avatarId, '分身ID')
  const knowledgePath = path.join(avatarsPath, avatarId, 'knowledge')
  if (!fs.existsSync(knowledgePath)) {
    throw new Error(`分身 knowledge 目录不存在: ${avatarId}`)
  }

  const { apiKey, baseUrl, model } = options.llm
  const ocrApiKey = options.ocr?.apiKey
  const ocrBaseUrl = options.ocr?.baseUrl
  const targetFiles = options.targetFiles

  const rawDir = path.join(knowledgePath, '_raw')

  let allFiles: string[]

  /** 检查文件是否已经被增强过（source: enhanced），支持断点续跑 */
  function isAlreadyEnhanced(filePath: string): boolean {
    try {
      const head = fs.readFileSync(filePath, 'utf-8').slice(0, 200)
      return head.includes('source: enhanced')
    } catch { return false }
  }

  /**
   * 在 _raw/ 中查找与 .md 文件名最匹配的原始文件。
   * 匹配策略：.md 文件名去掉 .md 后缀和非法字符替换后的 baseName，
   * 在 _raw/ 中找 baseName 前缀匹配的文件（可能带时间戳后缀）。
   */
  function findRawFile(mdFileName: string): string | null {
    if (!fs.existsSync(rawDir)) return null
    const mdBase = mdFileName.replace(/\.md$/, '')
    const rawEntries = fs.readdirSync(rawDir)
    // 精确匹配（清理后的 baseName 完全一致）
    for (const entry of rawEntries) {
      const entryBase = entry.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9\u4e00-\u9fa5_-]/g, '_')
      if (entryBase === mdBase) return path.join(rawDir, entry)
    }
    // 前缀匹配（带时间戳后缀的副本，如 xxx-1776069859495.pdf）
    for (const entry of rawEntries) {
      const entryBase = entry.replace(/-\d{10,}(\.[^.]+)$/, '$1').replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9\u4e00-\u9fa5_-]/g, '_')
      if (entryBase === mdBase) return path.join(rawDir, entry)
    }
    return null
  }

  if (targetFiles && targetFiles.length > 0) {
    allFiles = targetFiles
      .map(f => path.join(knowledgePath, f))
      .filter(f => fs.existsSync(f) && !isAlreadyEnhanced(f))
  } else {
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
    return {
      enhanced: 0, failed: 0, total: 0,
      fabricatedWarnings: 0, fabricatedDetails: [],
      ocrFailures: 0, indexBuilt: false,
    }
  }

  const callLLM: LLMCallFn = createLLMFn(apiKey, baseUrl, model)
  let enhanced = 0
  let failed = 0
  let fabricatedWarnings = 0
  let ocrFailures = 0
  const fabricatedDetails: Array<{ file: string; values: string[] }> = []
  const total = allFiles.length

  for (let i = 0; i < allFiles.length; i++) {
    const filePath = allFiles[i]
    const fileName = path.basename(filePath)
    const relPath = path.relative(knowledgePath, filePath)

    mainWindow?.webContents.send('knowledge-enhance-progress', {
      current: i, total, fileName, phase: 'preparing',
    })

    try {
      // 优先从 frontmatter 的 raw_file 字段读取原始文件相对路径（精确，新文件）。
      // 老文件（无 raw_file 字段）fallback 到 findRawFile 按文件名反查（脆弱但兼容）。
      let rawFilePath: string | null = null
      try {
        const head = fs.readFileSync(filePath, 'utf-8').slice(0, 500)
        const fmMatch = head.match(/^---\r?\n([\s\S]*?)\r?\n---/)
        if (fmMatch) {
          const rawFileMatch = fmMatch[1].match(/^\s*raw_file\s*:\s*(.+?)\s*$/m)
          if (rawFileMatch) {
            const candidate = path.join(knowledgePath, rawFileMatch[1].trim())
            if (fs.existsSync(candidate)) rawFilePath = candidate
          }
        }
      } catch (fmErr) {
        // 读 frontmatter 失败不中断 ENHANCE，静默 fallback 到 findRawFile 按名反查
        if (logger) logger.activity('enhance-read-frontmatter', `${relPath}: ${fmErr instanceof Error ? fmErr.message : String(fmErr)}`)
      }
      if (!rawFilePath) rawFilePath = findRawFile(fileName)

      let rawText = ''
      let parsedImages: string[] = []
      let parsedPerPageChars: Array<{ num: number; chars: number }> | undefined
      let parsedImagePageNumbers: number[] | undefined
      let parsedFileType: string = 'text'

      if (rawFilePath) {
        mainWindow?.webContents.send('knowledge-enhance-progress', {
          current: i, total, fileName, phase: 'parsing raw file',
        })
        try {
          const parsed = await documentParser.parseFile(rawFilePath)
          rawText = parsed.text || ''
          parsedImages = parsed.images
          parsedPerPageChars = parsed.perPageChars
          parsedImagePageNumbers = parsed.imagePageNumbers
          parsedFileType = parsed.fileType
        } catch (parseErr) {
          if (logger) logger.error('enhance-reparse', parseErr instanceof Error ? parseErr : new Error(String(parseErr)))
          // 解析失败回退到 .md 中的纯文本
        }
      }

      // 如果没有从 _raw/ 解析出内容，回退到 .md 文件中的纯文本
      if (!rawText) {
        const raw = fs.readFileSync(filePath, 'utf-8')
        let body = raw
        const fmEnd = raw.match(/^---\r?\n[\s\S]*?\r?\n---\s*\r?\n/)
        if (fmEnd) body = raw.slice(fmEnd[0].length)
        const headerEnd = body.indexOf('\n---\n')
        rawText = headerEnd >= 0 ? body.slice(headerEnd + 5).trim() : body.trim()
      }

      if (!rawText || rawText.trim().length < 50) {
        mainWindow?.webContents.send('knowledge-enhance-progress', {
          current: i + 1, total, fileName, phase: 'skipped',
        })
        continue
      }

      // OCR：如果有图表页截图且配置了 Vision API Key。
      // 共享 callVisionOcr 并发调用（默认并发 3），单图失败不中断。
      // 失败数量累计到 ocrFailures 供汇总上报，成功结果按原序保留（用于 mergeVisionIntoText
      // 和 imagePageNumbers 的下标对齐，失败位是 null，mergeVisionIntoText 调用前过滤掉）。
      let visionResultsRaw: Array<string | null> = []
      if (parsedImages.length > 0 && ocrApiKey) {
        mainWindow?.webContents.send('knowledge-enhance-progress', {
          current: i, total, fileName, phase: `OCR 0/${parsedImages.length}`,
        })
        const visionBase = ocrBaseUrl || 'https://dashscope.aliyuncs.com/compatible-mode/v1'
        const ocrOutcome = await callVisionOcr(parsedImages, {
          apiKey: ocrApiKey,
          baseUrl: visionBase,
          onProgress: (done, totalImgs) => {
            mainWindow?.webContents.send('knowledge-enhance-progress', {
              current: i, total, fileName, phase: `OCR ${done}/${totalImgs}`,
            })
          },
        })
        visionResultsRaw = ocrOutcome.results
        if (ocrOutcome.failures.length > 0) {
          ocrFailures += ocrOutcome.failures.length
          if (logger) {
            logger.activity('enhance-ocr-failures', `${relPath}: ${ocrOutcome.failures.length}/${parsedImages.length} 张图 OCR 失败`)
          }
        }
      }

      // 清洗
      let cleanedText = cleanPdfFullText(rawText)
      if (parsedFileType === 'word') {
        cleanedText = stripDocxToc(cleanedText)
      }

      // 合并 Vision OCR 结果到清洗后的文本。
      // visionResultsRaw 中失败的位是 null，过滤后按原下标对应 imagePageNumbers。
      if (visionResultsRaw.length > 0) {
        if (parsedPerPageChars) {
          const visionForMerge: Array<{ pageNum: number; content: string }> = []
          for (let vi = 0; vi < visionResultsRaw.length; vi++) {
            const content = visionResultsRaw[vi]
            if (content === null) continue
            visionForMerge.push({
              pageNum: parsedImagePageNumbers?.[vi] ?? (vi + 1),
              content,
            })
          }
          if (visionForMerge.length > 0) {
            cleanedText = mergeVisionIntoText(cleanedText, visionForMerge, parsedPerPageChars)
          }
        } else {
          // 纯图片 / 图片型 docx：无 perPage 结构，OCR 结果直接作正文
          const ocrTexts = visionResultsRaw.filter((r): r is string => r !== null && r.trim().length > 0)
          if (ocrTexts.length > 0) {
            const joined = ocrTexts.join('\n\n')
            cleanedText = cleanedText.trim() ? `${cleanedText}\n\n${joined}` : joined
          }
        }
      }

      // LLM 逐章格式化
      mainWindow?.webContents.send('knowledge-enhance-progress', {
        current: i, total, fileName, phase: 'formatting',
      })
      const docTitle = fileName.replace(/\.md$/, '')
      const formatted = await formatDocument(
        cleanedText, docTitle, fileName, callLLM,
        (progress) => {
          mainWindow?.webContents.send('knowledge-enhance-progress', {
            current: i, total, fileName,
            phase: `formatting (${progress.current}/${progress.total})`,
          })
        },
      )

      // 数值校验（需要原始文本做比对基准）
      if (rawFilePath) {
        const visionAllText = visionResultsRaw.filter((r): r is string => r !== null).join('\n')
        const fabricated = detectFabricatedNumbers(formatted, rawText + '\n' + visionAllText)
        if (fabricated.length > 0) {
          fabricatedWarnings += fabricated.length
          fabricatedDetails.push({ file: relPath, values: fabricated })
          if (logger) logger.activity('enhance-fabrication-check', `${relPath}: ${fabricated.length} 个疑似编造数值: ${fabricated.slice(0, 5).join(', ')}`)
        }
      }

      // 合并旧 frontmatter 保留用户字段，增强字段
      const oldContent = fs.readFileSync(filePath, 'utf-8')
      const oldMeta = parseFrontmatterCore(oldContent).meta
      const enhancedFields = extractFrontmatterFields(fileName, formatted)
      const mergedMeta = mergeFrontmatter(oldMeta, mergeFrontmatter({ rag_only: true, source: 'enhanced' }, enhancedFields))
      const newContent = buildFrontmatterBlock(mergedMeta) + '\n\n' + formatted
      fs.writeFileSync(filePath, newContent, 'utf-8')
      enhanced++

      mainWindow?.webContents.send('knowledge-enhance-progress', {
        current: i + 1, total, fileName, phase: 'done',
      })
    } catch (err) {
      failed++
      if (logger) logger.error('enhance-knowledge-file', err instanceof Error ? err : new Error(`${relPath}: ${String(err)}`))
      mainWindow?.webContents.send('knowledge-enhance-progress', {
        current: i + 1, total, fileName, phase: 'failed',
      })
    }
  }

  if (logger && ocrFailures > 0) {
    logger.activity('enhance-summary', `OCR 累计失败 ${ocrFailures} 张（跨 ${total} 文件）`)
  }

  // 全部文件增强完成后在主进程内直接重建检索索引（原子化、减少 IPC round trip）。
  // OCR Key 优先用于 embedding 调用（通常 DashScope Key 同时支持 LLM 和 Embedding）。
  let indexBuilt = false
  let contextCount: number | undefined
  let embeddingCount: number | undefined
  if (enhanced > 0) {
    const indexApiKey = ocrApiKey || apiKey
    const indexBaseUrl = ocrBaseUrl || baseUrl
    try {
      mainWindow?.webContents.send('knowledge-enhance-progress', {
        current: total, total, fileName: '', phase: 'rebuilding index',
      })
      const retriever = new KnowledgeRetriever(knowledgePath)
      const idxCallLLM = createLLMFn(indexApiKey, indexBaseUrl, 'qwen-turbo')
      const idxCallEmbedding = createEmbeddingFn(indexApiKey, indexBaseUrl)
      const existingIndex = loadIndex(knowledgePath)
      const idxResult = await buildKnowledgeIndex(
        retriever,
        { callLLM: idxCallLLM, callEmbedding: idxCallEmbedding },
        undefined,
        existingIndex,
      )
      saveIndex(knowledgePath, idxResult.contexts, idxResult.embeddings, idxResult.hashes)
      toolRouter.invalidateRetriever(avatarId)
      indexBuilt = true
      contextCount = idxResult.contexts.size
      embeddingCount = idxResult.embeddings.size
    } catch (idxErr) {
      if (logger) logger.error('enhance-index-rebuild', idxErr instanceof Error ? idxErr : new Error(String(idxErr)))
    }
  }

  return {
    enhanced, failed, total,
    fabricatedWarnings, fabricatedDetails,
    ocrFailures, indexBuilt,
    contextCount, embeddingCount,
  }
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
  // templatesPath 是模块级变量，由 initManagers 初始化
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

/**
 * read-tool-call-log: 读取指定日期（默认今天）的工具调用审计日志（jsonl）。
 *
 * 供 SettingsPanel「工具调用审计」入口展示，
 * 渲染层按行 split 成数组 + JSON.parse 后渲染表格。
 */
wrapHandler('read-tool-call-log', (_, date?: string) => {
  return logger ? logger.readToolCallLog(date) : ''
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

/**
 * 文档生成 IPC：把渲染进程构造好的 HTML（PDF）/ IR（DOCX）落盘。
 *
 * 决策 A1（依赖注入）：tool-router 在渲染进程实例化时通过 documentRenderers
 * 注入这两个 IPC 客户端，最终走到主进程的 renderDocumentPdf/Docx。
 *
 * 路径安全：传入的 outputPath 必须是已经过 workspaceManager.resolveSafe
 * 校验的绝对路径（generateDocument 已做双重防护：assertSafeSegment + resolveUnderRoot）。
 *
 * @author zhi.qu
 * @date 2026-05-08
 */
wrapHandler('document:render-pdf', async (_, html: string, outputPath: string) => {
  if (typeof html !== 'string' || html.length === 0) {
    throw new Error('document:render-pdf 缺少 html')
  }
  if (typeof outputPath !== 'string' || !path.isAbsolute(outputPath)) {
    throw new Error('document:render-pdf 缺少绝对 outputPath')
  }
  return renderDocumentPdf(html, outputPath, { logger: logger ?? undefined })
})

wrapHandler('document:render-docx', async (_, ir: DocumentIR, outputPath: string) => {
  if (!ir || typeof ir !== 'object') {
    throw new Error('document:render-docx 缺少 ir')
  }
  if (typeof outputPath !== 'string' || !path.isAbsolute(outputPath)) {
    throw new Error('document:render-docx 缺少绝对 outputPath')
  }
  return renderDocumentDocx(ir, outputPath, { logger: logger ?? undefined })
})

/**
 * 用系统默认应用打开生成的文档（FileCard 主按钮）。
 * 返回错误信息字符串（成功为空串），与 shell.openPath 的语义一致。
 */
wrapHandler('document:open', async (_, absolutePath: string) => {
  if (typeof absolutePath !== 'string' || !path.isAbsolute(absolutePath)) {
    return '缺少绝对路径'
  }
  if (!fs.existsSync(absolutePath)) {
    return `文件不存在: ${absolutePath}`
  }
  return shell.openPath(absolutePath)
})

/**
 * 在文件夹中显示生成的文档（FileCard 次按钮）。
 * 与 document:open 互补：不打开文件，只在系统资源管理器/Finder 中高亮。
 */
wrapHandler('document:show-in-folder', async (_, absolutePath: string) => {
  if (typeof absolutePath !== 'string' || !path.isAbsolute(absolutePath)) {
    return { ok: false, error: '缺少绝对路径' }
  }
  if (!fs.existsSync(absolutePath)) {
    return { ok: false, error: `文件不存在: ${absolutePath}` }
  }
  shell.showItemInFolder(absolutePath)
  return { ok: true }
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
    const res = await fetchWithTimeout(
      'https://api.github.com/repos/kidcrazequ/AI-avatar/releases/latest',
      {
        headers: { 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'Soul-Desktop' },
        timeoutMs: 10000,
      },
    )
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

// ─── MCP server 管理 IPC ──────────────────────────────────────────────────────
//
// 让渲染进程「设置 → 工具集成 → MCP」面板能 CRUD MCP server 配置。
// 数据流：
//   UI ──IPC──▶ main ──db.upsertMcpServer──▶ SQLite  ─┐
//                  └──mcpManager.addServer──▶ 实时连接 ┘
//
// IPC channels（5 个）:
//   mcp:list-servers      — 列出所有 server 状态快照
//   mcp:upsert-server     — 创建或更新 server（同时写 DB + 重建连接）
//   mcp:remove-server     — 删除 server（同时清 DB + 断开连接）
//   mcp:reconnect-server  — 重新连接（不改 DB）
//   mcp:disconnect-server — 临时断开（不改 DB，下次启动仍会自动连）

/**
 * 把 DB row 转成 McpClientManager 需要的 config（字段命名归一）。
 * row.timeout_ms (snake) → config.timeoutMs (camel)
 */
function mcpRowToConfig(row: McpServerRow) {
  return {
    name: row.name,
    enabled: row.enabled,
    transport: row.transport,
    command: row.command,
    args: row.args,
    env: row.env,
    cwd: row.cwd,
    url: row.url,
    timeoutMs: row.timeout_ms,
    description: row.description,
  }
}

/** UI 输入的 server 配置（与 McpServerRow 类似但 timeout 用 camelCase） */
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

wrapHandler('mcp:list-servers', () => {
  if (!mcpManager) return []
  const dbRows = getDb().listMcpServers()
  const liveSnapshots = mcpManager.listServers()
  // 合并 DB 配置 + 运行时状态：DB 是配置真相源，runtime 提供 status / tools
  return dbRows.map((row) => {
    const live = liveSnapshots.find((s) => s.name === row.name)
    return {
      ...row,
      status: live?.status ?? 'idle',
      toolCount: live?.toolCount ?? 0,
      tools: live?.tools ?? [],
      error: live?.error,
      lastConnectedAt: live?.lastConnectedAt,
    }
  })
})

wrapHandler('mcp:upsert-server', async (_event, input: McpServerInput) => {
  if (!mcpManager) throw new Error('mcpManager 未初始化')
  if (!input?.name || !/^[a-zA-Z0-9_-]{1,32}$/.test(input.name)) {
    throw new Error('server 名称非法，仅允许 [a-zA-Z0-9_-]，长度 1~32')
  }
  // 1. 持久化（先写 DB，确保 UI 刷新后能看到）
  getDb().upsertMcpServer({
    name: input.name,
    enabled: input.enabled,
    transport: input.transport,
    command: input.command,
    args: input.args,
    env: input.env,
    cwd: input.cwd,
    url: input.url,
    timeout_ms: input.timeoutMs,
    description: input.description,
  })
  // 2. 重建运行时连接（addServer 内部已处理「先 remove 再 add」）
  await mcpManager.addServer({
    name: input.name,
    enabled: input.enabled,
    transport: input.transport,
    command: input.command,
    args: input.args,
    env: input.env,
    cwd: input.cwd,
    url: input.url,
    timeoutMs: input.timeoutMs,
    description: input.description,
  })
  return mcpManager.getSnapshot(input.name)
})

wrapHandler('mcp:remove-server', async (_event, name: string) => {
  if (!mcpManager) throw new Error('mcpManager 未初始化')
  if (typeof name !== 'string' || !name.trim()) throw new Error('缺少 name 参数')
  await mcpManager.removeServer(name)
  getDb().deleteMcpServer(name)
  return { ok: true }
})

wrapHandler('mcp:reconnect-server', async (_event, name: string) => {
  if (!mcpManager) throw new Error('mcpManager 未初始化')
  if (typeof name !== 'string' || !name.trim()) throw new Error('缺少 name 参数')
  await mcpManager.reconnectServer(name)
  return mcpManager.getSnapshot(name)
})

wrapHandler('mcp:disconnect-server', async (_event, name: string) => {
  if (!mcpManager) throw new Error('mcpManager 未初始化')
  if (typeof name !== 'string' || !name.trim()) throw new Error('缺少 name 参数')
  await mcpManager.disconnectServer(name)
  return mcpManager.getSnapshot(name)
})

// ─── 批量回归测试 IPC（2026-04-30 子任务 5）────────────────────────────
//
// 设计：主进程只做 fs IO + SQLite，不做聚合/渲染（避免主进程 import src/services）；
// 渲染进程的 BatchRegressionPanel 调 batch-regression-runner / batch-report-generator
// 完成核心业务，主进程仅持久化已渲染好的 markdown/html 文本。
//
// 6 个 IPC 通道：
//   1. regression-load-or-generate-bank — 读题库或现场生成
//   2. regression-list-runs              — 列历史 run（按时间倒序）
//   3. regression-ensure-conversation    — 注册指定 ID 的临时会话（绕过 createConversation 自动 ID）
//   4. regression-save-run-result        — 落盘 run 结果（result.json + report.md + report.html + metadata.json）
//   5. regression-cleanup-conversations  — 清理 regression-{runId}-* 会话（CASCADE 删消息）
//   6. regression-open-report            — 在系统默认浏览器打开 report.html（安全限制：必须在 tests/runs/ 下）

/** 题库文件相对路径（基于 avatars/{id}/） */
const QUESTION_BANK_REL_PATH = 'tests/generated/question-bank.json'
/** 历史 run 根目录相对路径 */
const RUNS_DIR_REL_PATH = 'tests/runs'

/**
 * 1. 读题库 JSON；若文件不存在或 force=true，调 kb-question-generator 现场生成并落盘。
 *
 * 返回完整 QuestionBank（含 questions 数组），渲染进程直接喂给运行器。
 * 题库较大（1000+ 题，~500KB JSON）通过一次 IPC 传输是可接受的（远小于 Electron IPC 100MB 上限）。
 */
wrapHandler('regression-load-or-generate-bank', async (_, avatarId: string, opts?: { force?: boolean }) => {
  assertSafeSegment(avatarId, '分身ID')
  const bankPath = path.join(avatarsPath, avatarId, QUESTION_BANK_REL_PATH)
  const force = opts?.force === true

  if (!force && fs.existsSync(bankPath)) {
    try {
      const text = fs.readFileSync(bankPath, 'utf-8')
      return { bank: JSON.parse(text), cached: true, bankPath }
    } catch (err) {
      if (logger) logger.activity('regression-load-bank', `cached read failed, regenerating: ${err instanceof Error ? err.message : String(err)}`)
      // 落到下面的生成逻辑
    }
  }

  // 现场生成（避免 main.ts 直接依赖 src/services；electron/kb-question-generator.ts 已在主进程域内）
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- 动态加载避免循环依赖
  const { generateQuestionBank, writeQuestionBankFile } = require('./kb-question-generator')
  const knowledgePath = path.join(avatarsPath, avatarId, 'knowledge')
  if (!fs.existsSync(knowledgePath)) {
    throw new Error(`分身 knowledge 目录不存在: ${avatarId}`)
  }
  const bank = await generateQuestionBank({
    avatarId,
    knowledgePath,
    seed: 42,
  })
  const written = await writeQuestionBankFile(avatarsPath, bank)
  return { bank, cached: false, bankPath: written }
})

/**
 * 2. 列出历史 run（按 startedAt 倒序）。
 * 不存在 tests/runs 目录返回空数组（首次使用场景）。
 */
wrapHandler('regression-list-runs', (_, avatarId: string) => {
  assertSafeSegment(avatarId, '分身ID')
  const runsDir = path.join(avatarsPath, avatarId, RUNS_DIR_REL_PATH)
  if (!fs.existsSync(runsDir)) return []

  const out: Array<{
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
  }> = []

  for (const name of fs.readdirSync(runsDir)) {
    const runDir = path.join(runsDir, name)
    if (!fs.statSync(runDir).isDirectory()) continue
    const metaPath = path.join(runDir, 'metadata.json')
    if (!fs.existsSync(metaPath)) continue
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'))
      out.push({
        runId: typeof meta.runId === 'string' ? meta.runId : name,
        startedAt: typeof meta.startedAt === 'number' ? meta.startedAt : 0,
        finishedAt: typeof meta.finishedAt === 'number' ? meta.finishedAt : 0,
        totalCases: typeof meta.totalCases === 'number' ? meta.totalCases : 0,
        passCount: typeof meta.passCount === 'number' ? meta.passCount : 0,
        failCount: typeof meta.failCount === 'number' ? meta.failCount : 0,
        errorCount: typeof meta.errorCount === 'number' ? meta.errorCount : 0,
        reportHtmlPath: path.join(runDir, 'report.html'),
        reportMdPath: path.join(runDir, 'report.md'),
        resultJsonPath: path.join(runDir, 'result.json'),
      })
    } catch (err) {
      if (logger) logger.activity('regression-list-runs', `跳过损坏的 metadata.json: ${name} - ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return out.sort((a, b) => b.startedAt - a.startedAt)
})

/**
 * 3. 注册指定 ID 的临时会话（INSERT OR IGNORE）。
 *
 * 必要性：runner 用 `regression-{runId}-{idx}` 做 conversationId 才能精确过滤遥测事件，
 * 但 saveMessage 受外键约束 conversation 必须先存在。原 createConversation 自动生成 ID 不满足。
 */
wrapHandler('regression-ensure-conversation', (_, avatarId: string, conversationId: string, title: string) => {
  assertSafeSegment(avatarId, '分身ID')
  if (typeof conversationId !== 'string' || !conversationId.startsWith('regression-')) {
    throw new Error(`非法 conversationId（必须以 regression- 开头）: ${conversationId}`)
  }
  if (typeof title !== 'string' || title.length === 0) title = '回归测试'
  getDb().ensureConversation(conversationId, title.slice(0, 200), avatarId)
  return { ok: true }
})

/**
 * 4. 落盘 run 结果。
 *
 * 渲染进程已经渲染完成 markdown/html，主进程只透传写盘 + 写一份 metadata.json 用于列表查询。
 * 文件结构：avatars/{id}/tests/runs/{runId}/{result.json, report.md, report.html, metadata.json, question-bank.json}
 */
interface RegressionQuestionBankSource {
  sourcePath: string
  cached: boolean
  loadedAt: number
  generatedAt?: string
  totalQuestionCount: number
  selectedQuestionCount: number
}

interface RegressionSavePayload {
  runId: string
  startedAt: number
  finishedAt: number
  totalCases: number
  passCount: number
  failCount: number
  errorCount: number
  /** 完整 BatchRunResult 的 JSON 序列化（含每个 case 的 assertions） */
  resultJson: string
  /** 本次运行使用的完整题库快照 JSON */
  questionBankJson?: string
  /** 本次运行使用的题库来源信息 */
  questionBankSource?: RegressionQuestionBankSource
  /** 渲染好的 markdown */
  reportMd: string
  /** 渲染好的 html */
  reportHtml: string
}

wrapHandler('regression-save-run-result', (_, avatarId: string, payload: RegressionSavePayload) => {
  assertSafeSegment(avatarId, '分身ID')
  if (!payload || typeof payload !== 'object') throw new Error('payload 缺失')
  const {
    runId,
    startedAt,
    finishedAt,
    totalCases,
    passCount,
    failCount,
    errorCount,
    resultJson,
    questionBankJson,
    questionBankSource,
    reportMd,
    reportHtml,
  } = payload
  if (typeof runId !== 'string' || runId.length === 0) throw new Error('runId 非法')
  assertSafeSegment(runId, 'runId')

  const runDir = path.join(avatarsPath, avatarId, RUNS_DIR_REL_PATH, runId)
  fs.mkdirSync(runDir, { recursive: true })

  const resultJsonPath = path.join(runDir, 'result.json')
  const reportMdPath = path.join(runDir, 'report.md')
  const reportHtmlPath = path.join(runDir, 'report.html')
  const metadataPath = path.join(runDir, 'metadata.json')
  const questionBankPath = path.join(runDir, 'question-bank.json')

  fs.writeFileSync(resultJsonPath, resultJson, 'utf-8')
  if (typeof questionBankJson === 'string' && questionBankJson.length > 0) {
    JSON.parse(questionBankJson)
    fs.writeFileSync(questionBankPath, questionBankJson, 'utf-8')
  }
  fs.writeFileSync(reportMdPath, reportMd, 'utf-8')
  fs.writeFileSync(reportHtmlPath, reportHtml, 'utf-8')
  fs.writeFileSync(metadataPath, JSON.stringify({
    runId, avatarId, startedAt, finishedAt,
    totalCases, passCount, failCount, errorCount,
    questionBankSource,
    questionBankSnapshotPath: fs.existsSync(questionBankPath) ? questionBankPath : undefined,
    savedAt: Date.now(),
  }, null, 2), 'utf-8')

  return { runDir, resultJsonPath, reportMdPath, reportHtmlPath, metadataPath }
})

/**
 * 5. 清理 regression-{runId}-* 会话（CASCADE 删除关联消息）。
 * 跑完回归后调用，避免污染用户的对话历史。
 */
wrapHandler('regression-cleanup-conversations', (_, runId: string) => {
  if (typeof runId !== 'string' || runId.length === 0) throw new Error('runId 非法')
  assertSafeSegment(runId, 'runId')
  const deleted = getDb().deleteConversationsByPrefix(`regression-${runId}-`)
  return { deleted }
})

/**
 * 6. 在系统默认浏览器打开 report.html。
 * 安全限制：filePath 必须在 avatarsPath/{id}/tests/runs/ 下，避免任意文件打开。
 */
wrapHandler('regression-open-report', async (_, filePath: string) => {
  if (typeof filePath !== 'string' || filePath.length === 0) throw new Error('filePath 缺失')
  const resolved = path.resolve(filePath)
  // 必须在 avatarsPath 下且包含 tests/runs/
  if (!resolved.startsWith(avatarsPath) || !resolved.includes(`${path.sep}tests${path.sep}runs${path.sep}`)) {
    throw new Error(`非法报告路径（必须在 avatars/{id}/tests/runs/ 下）: ${resolved}`)
  }
  if (!fs.existsSync(resolved)) {
    throw new Error(`报告文件不存在: ${resolved}`)
  }
  const result = await shell.openPath(resolved)
  if (result) throw new Error(`打开失败: ${result}`)
  return { ok: true }
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
