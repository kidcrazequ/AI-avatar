/**
 * Electron 主进程入口
 *
 * @author zhi.qu
 * @date 2026-04-03
 */

import { app, BrowserWindow, ipcMain, dialog, nativeImage, shell, session as electronSession } from 'electron'

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
import crypto from 'crypto'
import { SoulLoader, KnowledgeManager, AvatarManager, SkillManager, SkillRouter, ToolRouter, KnowledgeRetriever, TemplateLoader, buildKnowledgeIndex, saveIndex, loadIndex, retrieveAndBuildPrompt, WikiCompiler, consolidateMemory, getCombinedMemoryInjectionStats, parseStructuredMemoryDocumentJson, serializeStructuredMemoryDocument, assertStructuredMemoryDocumentPayload, formatStructuredMemoryEntriesForPrompt, STRUCTURED_MEMORY_FILENAME, assertSafeSegment, resolveUnderRoot, localDateString, formatDocument, fetchWithTimeout, cleanPdfFullText, stripDocxToc, mergeVisionIntoText, detectFabricatedNumbers, callVisionOcr, loadChartCache, saveChartCache, findChartCacheHit, insertChartCacheEntry, captureFileSnapshot, CHART_CACHE_REL_PATH, McpClientManager, parseFrontmatterCore, extractFrontmatterFields, mergeFrontmatter, buildFrontmatterBlock, readLifeManifest, readLifeTimeline, readLifeEpisode, readLifeConsolidated, readLifeProgress, deleteLifeEpisode, updateLifeManifest, resetGeneratedLife, generateLife, writeLifeManifest, advanceLife, advanceAllAvatars, DEFAULT_AVATAR_PROJECT_ID, evaluateConversationModeToolPolicy, evaluateProxyTrustGreyDenial, shouldConfirmGreyZoneOnDesktop, type AdvanceLifeResult, type AdvanceAllAvatarsResult, type LifeLLMConfig, type LifeUserParams, type LifeProgress, type LifeManifest, type LifeManifestUpdate, type WikiAnswer, type LLMCallFn, type ChartCacheEntry, type DocumentIR, type ConversationModeForTools, type ToolCallTrustTier, type SubAgentTask, type SubAgentDispatchContext, writeConversationEpisode, readConversationEpisode, listConversationEpisodes, deleteConversationEpisode, shouldExtractEpisode, extractConversationEpisode, applyEpisodeAlgorithmicForgetting, loadTriggers, matchTriggers, buildTriggerInjection, appendStandingOrder, readStandingOrders, countStandingOrders, applyDailySummaryAllDates, exportSoulPack, importSoulPack, serializeSoulPack, parseSoulPack, type ExportSoulPackOptions, type ImportSoulPackOptions, type ImportSoulPackResult } from '@soul/core'
import { DatabaseManager, type McpServerRow, type SubAgentTaskRow } from './database'
import { ConversationJsonlAppender } from './conversation-jsonl-appender'
import { readConversationEvents } from './conversation-event-reader'
import { ScheduleStore, type ScheduleRow, type NewScheduleInput, type UpdateScheduleInput, type ScheduleRunRow, type RunStatus } from './db-schedules'
import { EmbedStore, type NewEmbedInput, type UpdateEmbedInput } from './db-embeds'
import { SyncHistoryStore, type SyncDirection, type SyncStatus as SyncRunStatus } from './db-sync-history'
import { SyncManager, isSafeBackupFilename, type SetConfigInput as SyncSetConfigInput, type TestConnectionInput as SyncTestConnectionInput } from './sync/sync-manager'
import { WidgetServer } from './widget-server'
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
import { registerSoulProxyIpcHandlers, startSoulProxyServer, stopSoulProxyServer } from './proxy-server'
import { setConversationToolMode, getConversationToolMode } from './conversation-tool-mode-registry'
import { DoubaoAsrSession } from './asr-session'
import { getPromptCacheStats } from './agent-runtime-bridge'

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

/**
 * 解析可选专家包目录。生产环境作为只读资源随应用打包，安装时复制到用户 avatars/。
 */
function resolveExpertPacksPath(): string {
  if (process.env.NODE_ENV === 'development') {
    return path.join(__dirname, '../../expert-packs')
  }
  return path.join(process.resourcesPath, 'expert-packs')
}

// ─── 单例 ────────────────────────────────────────────────────────────────────

const knowledgeManagers = new Map<string, KnowledgeManager>()
const wikiCompilers = new Map<string, WikiCompiler>()

let avatarsPath: string
let templatesPath: string
let expertPacksPath: string
let soulLoader: SoulLoader
let db: DatabaseManager
/** 对话 JSONL 双写器单例，init 后赋值；IPC 处理器据此追加 v17 事件 */
let jsonlAppender: ConversationJsonlAppender
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
/**
 * 用户自定义定时任务存储（#11 Scheduled Tasks）。
 * 在 initManagers 之后通过 getScheduleStore() lazy 创建（依赖 db）。
 */
let scheduleStore: ScheduleStore | null = null
function getScheduleStore(): ScheduleStore {
  if (!scheduleStore) {
    scheduleStore = new ScheduleStore(getDb().getRawDb())
  }
  return scheduleStore
}
/**
 * Web Embed widget 配置存储（#15 Web Embed widget · 子任务 2）。
 * 在 initManagers 之后通过 getEmbedStore() lazy 创建（依赖 db）。
 */
let embedStore: EmbedStore | null = null
function getEmbedStore(): EmbedStore {
  if (!embedStore) {
    embedStore = new EmbedStore(getDb().getRawDb())
  }
  return embedStore
}
/**
 * Web Embed widget HTTP 服务器单例（#15 Web Embed widget · 子任务 2）。
 * 默认关闭；用户在设置中开启或调用 IPC `embed:server-start` 时启动。
 */
let widgetServer: WidgetServer | null = null
/**
 * WebDAV 同步历史存储（#16 WebDAV cross-device sync · 子任务 3）。
 * 在 initManagers 之后通过 getSyncHistoryStore() lazy 创建（依赖 db）。
 */
let syncHistoryStore: SyncHistoryStore | null = null
function getSyncHistoryStore(): SyncHistoryStore {
  if (!syncHistoryStore) {
    syncHistoryStore = new SyncHistoryStore(getDb().getRawDb())
  }
  return syncHistoryStore
}
/**
 * WebDAV 同步管理器（#16 WebDAV cross-device sync · 子任务 4）。
 * 在 initManagers 之后通过 getSyncManager() lazy 创建（依赖 db / cron / logger）。
 */
let syncManager: SyncManager | null = null
function getSyncManager(): SyncManager {
  if (!syncManager) {
    // 兼容 dev / prod：sharedRoot 与 avatarsPath 同级（dev 指向仓库 shared/，prod 指向 userData/shared/）
    const sharedRoot = path.join(avatarsPath, '..', 'shared')
    const conversationsRoot = path.join(app.getPath('userData'), 'conversations')
    syncManager = new SyncManager({
      db: getDb().getRawDb(),
      syncHistoryStore: getSyncHistoryStore(),
      cronScheduler,
      logger: {
        info: (msg, meta) => {
          if (logger) logger.activity('webdav-sync', meta ? `${msg} ${JSON.stringify(meta)}` : msg)
        },
        warn: (msg, err) => {
          if (logger) logger.logEvent('warn', 'webdav-sync', err ? `${msg}: ${err.message}` : msg)
        },
        error: (msg, err) => {
          if (logger) logger.error(`webdav-sync:${msg}`, err ?? new Error(msg))
        },
      },
      appVersion: app.getVersion(),
      userDataPath: app.getPath('userData'),
      avatarsRoot: avatarsPath,
      sharedRoot,
      conversationsRoot,
      dbSchemaVersion: 12,
      runDbBackup: (dest: string) => getDb().backup(dest),
      relaunchApp: () => {
        app.relaunch()
        setImmediate(() => app.exit(0))
      },
    })
  }
  return syncManager
}
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
/** 当前豆包 ASR 流式会话：MVP 保持全局单会话互斥，避免多输入框抢同一麦克风/WS。 */
let activeAsrSession: DoubaoAsrSession | null = null

/**
 * 写入崩溃诊断日志。
 *
 * 这里不能只依赖 Logger：uncaughtException / renderer crash 可能发生在 initManagers
 * 之前，或发生在 Logger 自身不可用时。fallback 直接追加到 userData/logs/error-YYYY-MM-DD.log，
 * 保证 Windows 安装版出现“窗口直接消失”时仍能留下 crash / oom / GPU 进程退出原因。
 *
 * @author zhi.qu
 * @date 2026-05-11
 */
function writeCrashDiagnostic(source: string, detail: unknown): void {
  const error = detail instanceof Error ? detail : new Error(String(detail))
  const lines = [
    `[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] CRASH ${source} | ${error.message}`,
    error.stack ?? '',
  ].filter(Boolean)

  try {
    if (logger) {
      logger.error(source, error)
      return
    }
  } catch {
    // Logger 失效时继续走文件 fallback，避免二次异常吞掉真正的崩溃原因。
  }

  try {
    const logDir = path.join(app.getPath('userData'), 'logs')
    fs.mkdirSync(logDir, { recursive: true })
    fs.appendFileSync(
      path.join(logDir, `error-${localDateString(new Date())}.log`),
      `${lines.join('\n')}\n`,
      'utf8',
    )
  } catch {
    // 崩溃兜底路径不能再抛异常。
  }
}

/**
 * 注册主进程级崩溃保护。
 *
 * @author zhi.qu
 * @date 2026-05-11
 */
function registerProcessCrashHandlers(): void {
  process.on('uncaughtException', (err) => {
    writeCrashDiagnostic('process:uncaughtException', err)
    try {
      dialog.showErrorBox('AI分身运行异常', `主进程出现未捕获异常：${err.message}\n\n错误已写入 logs/error-${localDateString(new Date())}.log`)
    } catch {
      // 对话框显示失败时只保留日志。
    }
  })

  process.on('unhandledRejection', (reason) => {
    writeCrashDiagnostic('process:unhandledRejection', reason)
  })

  app.on('child-process-gone', (_event, details) => {
    writeCrashDiagnostic('app:child-process-gone', JSON.stringify(details))
  })
}
registerProcessCrashHandlers()

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

function isAllowedMediaPermissionOrigin(requestingUrl: string): boolean {
  try {
    const url = new URL(requestingUrl)
    if (url.protocol === 'file:') return true
    return process.env.NODE_ENV === 'development' && url.origin === 'http://localhost:5173'
  } catch {
    return false
  }
}

function registerMediaPermissionHandler(): void {
  electronSession.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    if (permission !== 'media') {
      callback(false)
      return
    }
    const requestingUrl = details.requestingUrl || webContents.getURL()
    const isMainWindow = mainWindow !== null && webContents.id === mainWindow.webContents.id
    const allowed = isMainWindow && isAllowedMediaPermissionOrigin(requestingUrl)
    if (logger) {
      logger.activity('media-permission', `allowed=${allowed} url=${requestingUrl}`)
    }
    callback(allowed)
  })
}

/**
 * 根据会话 ID 解析工作区上下文（avatarId + projectId + workspace 根目录）。
 */
function resolveWorkspaceContext(
  conversationId: string,
): { avatarId: string; projectId: string; workspaceRoot: string } {
  const conv = getDb().getConversation(conversationId)
  if (!conv) {
    throw new Error(`会话不存在: ${conversationId}`)
  }
  const avatarId = conv.avatar_id
  assertSafeSegment(avatarId, '分身ID')
  const rawPid = typeof conv.project_id === 'string' && conv.project_id.trim().length > 0
    ? conv.project_id.trim()
    : DEFAULT_AVATAR_PROJECT_ID
  assertSafeSegment(rawPid, 'projectId')
  const workspaceRoot = workspaceManager.ensure(avatarId, rawPid, conversationId)
  if (conv.workspace_initialized !== 1) {
    getDb().markWorkspaceInitialized(conversationId)
  }
  return { avatarId, projectId: rawPid, workspaceRoot }
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
  let rendererCrashReloaded = false
  // show: false + ready-to-show 是 Electron 官方推荐的"优雅显示"模式。
  // 修复 Windows 安装版的 bug：BrowserWindow 默认 show: true 时窗口立即可见，
  // 但此时 WebContents 尚未完成首屏渲染和合成器初始化，OS 输入派发链未建立。
  // 用户看到 UI 立即点击会被合成层吞掉（hover 正常但 click 静默失败）；
  // 打开 DevTools 会强制 attach 输入 handler + 触发 reflow，事件链才被踹活。
  // backgroundColor 防止 show 之前出现系统默认白底闪烁。
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 960,
    minHeight: 600,
    fullscreen: false,
    kiosk: false,
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

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    writeCrashDiagnostic('webContents:render-process-gone', JSON.stringify(details))
    const shouldReload = ['crashed', 'oom', 'abnormal-exit'].includes(details.reason)
    if (shouldReload && !rendererCrashReloaded && !mainWindow?.isDestroyed()) {
      rendererCrashReloaded = true
      setTimeout(() => {
        if (!mainWindow?.isDestroyed()) {
          mainWindow.webContents.reload()
        }
      }, 500)
    }
  })

  mainWindow.webContents.on('unresponsive', () => {
    writeCrashDiagnostic('webContents:unresponsive', 'renderer became unresponsive')
  })

  mainWindow.webContents.on('responsive', () => {
    if (logger) logger.activity('webContents:responsive')
  })

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
  expertPacksPath = resolveExpertPacksPath()
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
  // 对话消息 JSONL 双写器（2026-05-09 #2 SQLite + JSONL 双写）：
  // 在 SQLite 主存储成功提交后异步追加 JSONL 备份文件，写入失败仅 warn 不阻塞。
  // logger 适配器：Logger 没有 warn() 方法，统一通过 logEvent('warn', ...) 走活动日志。
  jsonlAppender = ConversationJsonlAppender.getInstance(app.getPath('userData'), {
    warn: (msg, err) => logger.logEvent('warn', msg, err instanceof Error ? err.message : err === undefined ? undefined : String(err)),
  })
  db = new DatabaseManager(undefined, jsonlAppender)

  // v15 子分身派发持久化：把上次运行残留的 running 任务标记为 lost。
  // LLM 调用不可恢复，仅做状态修正，让 UI 不再展示"永远 running"的僵尸行。
  try {
    const lost = db.markOrphanRunningAsLost()
    if (lost > 0) {
      logger.activity('sub-agent', `应用启动时标记 ${lost} 条孤儿 running → lost`)
    }
  } catch (e) {
    logger.logEvent('warn', '[sub-agent] markOrphanRunningAsLost 失败', e instanceof Error ? e.message : String(e))
  }

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

  const resolveConversationProjectIdFromDb = (cid: string): string => {
    assertSafeSegment(cid, 'conversationId')
    const row = getDb().getConversation(cid)
    const p =
      typeof row?.project_id === 'string' && row.project_id.trim().length > 0
        ? row.project_id.trim()
        : DEFAULT_AVATAR_PROJECT_ID
    assertSafeSegment(p, 'projectId')
    return p
  }

  // v15 子分身派发 sink（Managed-Agents 借鉴第 1 步）：
  // SubAgentManager 在 running/done/error 各触发一次本闭包，sink 把任务镜像到
  // sqlite + JSONL。sink 内部所有异常都吞掉，确保子分身派发链路不被备份失败打断。
  const subAgentTaskSink = (task: SubAgentTask, ctx: SubAgentDispatchContext) => {
    try {
      const row: SubAgentTaskRow = {
        id: task.id,
        conversation_id: ctx.conversationId,
        parent_avatar_id: ctx.parentAvatarId,
        target_avatar: ctx.targetAvatar,
        task: task.task,
        // SubAgentManager 仅会传 'running' | 'done' | 'error'，与表约束一致；'lost' 由 markOrphan 单独写
        status: task.status as 'running' | 'done' | 'error',
        result: task.result ?? null,
        error: task.error ?? null,
        started_at: task.startedAt ?? Date.now(),
        finished_at: task.finishedAt ?? null,
        // task() 工具的 agent_type 参数通过 ctx 透传到这里（2026-05-22 Mavis 借鉴）；
        // 未传 → null（保持旧行为）；'verifier' / 'explore' / 'plan' / 'worker' → 落库
        agent_type: ctx.agentType ?? null,
      }
      db.upsertSubAgentTask(row)
    } catch (e) {
      logger.logEvent('warn', '[sub-agent] sqlite sink 写失败', e instanceof Error ? e.message : String(e))
    }
    // JSONL 事件：fire-and-forget，jsonlAppender 内部已 warn 兜底
    void jsonlAppender.appendSubAgentEvent(ctx.conversationId, {
      type: 'sub_agent_task',
      taskId: task.id,
      conversationId: ctx.conversationId,
      status: task.status as 'running' | 'done' | 'error',
      parentAvatarId: ctx.parentAvatarId,
      targetAvatar: ctx.targetAvatar,
      // task 描述截断到 ~500 字符防止单行过大；完整 task 在 sqlite
      taskPreview: task.task.length > 500 ? task.task.slice(0, 500) + '…' : task.task,
      error: task.error ?? null,
      // task() 工具传 agent_type 时透传到 JSONL；未传保持 null（向后兼容）
      agentType: ctx.agentType ?? null,
      ts: Date.now(),
    })
  }

  // 注入跨分身委派依赖：让 delegate_task({ target_avatar }) 能现场加载目标分身的 systemPrompt
  // 同时注入 getSetting：让 web_search 等需要外部凭据的工具能读到 settings 表中的 API Key
  // 同时注入 mcpManager：让 list_mcp_tools / call_mcp_tool 工具能路由到 MCP server
  // 同时注入 subAgentTaskSink：让子分身派发任务镜像到 sqlite + JSONL（v15）
  toolRouter = new ToolRouter(avatarsPath, {
    loadAvatarSystemPrompt: (id: string) => {
      const dir = path.join(avatarsPath, id)
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return undefined
      try {
        const webEnabled = getDb().getSetting('web_search_enabled') === 'true'
        return soulLoader.loadAvatar(id, undefined, webEnabled).systemPrompt
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
    resolveConversationProjectId: resolveConversationProjectIdFromDb,
    subAgentTaskSink,
  })
  workspaceManager = new WorkspaceManager(avatarsPath, resolveConversationProjectIdFromDb)
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

app.whenReady().then(async () => {
  try {
    initManagers()
  } catch (error) {
    console.error('[Main] initManagers failed:', error)
    dialog.showErrorBox('初始化失败', `核心模块初始化失败：${error instanceof Error ? error.message : String(error)}\n\n应用将退出。`)
    app.quit()
    return
  }

  createWindow()
  registerMediaPermissionHandler()
  if (mainWindow) {
    scheduledTester.setWindow(mainWindow)
    cronScheduler.setWindow(mainWindow)
  }

  registerSoulProxyIpcHandlers(ipcMain)
  ipcMain.handle('proxy-api:generate-token', () => crypto.randomBytes(32).toString('hex'))
  startSoulProxyServer({ getDb, getMainWindow: () => mainWindow, logger })

  // 启动 widget-server（默认关闭，需用户在设置中显式开启）。
  // 与 proxy-server 同款「显式启用」语义；启动失败仅记日志，不阻断主进程。
  const widgetEnabled = getDb().getSetting('widget_server_enabled') === 'true'
  if (widgetEnabled) {
    try {
      widgetServer = new WidgetServer({
        getDb,
        getEmbedStore,
        logger,
      })
      const { port } = await widgetServer.start()
      logger.activity('widget-server', `started on port ${port}`)
    } catch (err) {
      logger.error('widget-server.start', err instanceof Error ? err : new Error(String(err)))
    }
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

  // 从 DB 恢复用户自定义定时任务（#11 Scheduled Tasks 冷启动恢复）。
  // 应用关闭期间错过的触发不补跑（policy）；已有 next_run_at 但已过期的标 missed 但不发送，
  // 避免开机时一次性涌出大量历史消息。
  try {
    restoreSchedulesFromDb()
  } catch (err) {
    console.error('[Main] 恢复用户 schedules 失败:', err)
    if (logger) logger.error('schedules-restore', err instanceof Error ? err : new Error(String(err)))
  }

  // 注册 WebDAV 自动同步 cron（#16 子任务 4）。
  // 失败仅 warn，不阻塞主进程；实际触发逻辑由 SyncManager.registerAutoInterval 内部决定。
  try {
    getSyncManager().registerAutoInterval().catch((err: unknown) => {
      if (logger) logger.error('webdav-sync-restore', err instanceof Error ? err : new Error(String(err)))
    })
  } catch (err) {
    if (logger) logger.error('webdav-sync-restore', err instanceof Error ? err : new Error(String(err)))
  }

  // 「人生持续生长」每日 0:30 触发一次（Phase 2）。
  // 不需要从 DB 恢复——只要主进程跑就一直注册（用户可通过 toggleGrowth 关闭单分身）。
  try {
    cronScheduler.scheduleDailyCallback('life-advance-all', 0, 30, async () => {
      await runLifeAdvanceAllAvatars().catch((err) => {
        if (logger) logger.error('life-advance-all', err instanceof Error ? err : new Error(String(err)))
      })
    })
    if (logger) logger.activity('life-advance-all', '已注册 daily 0:30 cron')
  } catch (err) {
    console.error('[Main] 注册 life-advance-all cron 失败:', err)
  }

  // v17 Phase 2c+：对话情景记忆"渐进遗忘"每日 0:35 跑一次（让 life-advance-all 先跑完）。
  // 不需要 LLM——纯算法层，sigmoid 重算 status，无成本。任何分身没 episodes 就空转跳过。
  try {
    cronScheduler.scheduleDailyCallback('episode-forgetting-all', 0, 35, async () => {
      await runEpisodeForgettingAllAvatars().catch((err) => {
        if (logger) logger.error('episode-forgetting-all', err instanceof Error ? err : new Error(String(err)))
      })
    })
    if (logger) logger.activity('episode-forgetting-all', '已注册 daily 0:35 cron')
  } catch (err) {
    console.error('[Main] 注册 episode-forgetting-all cron 失败:', err)
  }

  // v18 OpenHuman 借鉴：每日 0:40 跑 daily summary（在 forgetting 0:35 之后 5 分钟，
  // 确保用最新 status 的 episode 集合合并）。机械合并零 LLM 成本；forgotten 自动剔除。
  try {
    cronScheduler.scheduleDailyCallback('daily-summary-all', 0, 40, async () => {
      await runDailySummaryAllAvatars().catch((err) => {
        if (logger) logger.error('daily-summary-all', err instanceof Error ? err : new Error(String(err)))
      })
    })
    if (logger) logger.activity('daily-summary-all', '已注册 daily 0:40 cron')
  } catch (err) {
    console.error('[Main] 注册 daily-summary-all cron 失败:', err)
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
  stopSoulProxyServer(logger)
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

interface ExpertPackMeta {
  id: string
  name: string
  description: string
  domain: string
  version: string
  author: string
  sourceAvatarId: string
  redline: string
  installable: boolean
  /**
   * 安装后写入 avatar.config.json#defaultModel，作为该分身在 LLMService dispatcher 的首选模型。
   * 字段缺失时分身回落到全局 chat slot；字段以 claude-* 起始时需用户已在设置中配置 Anthropic key。
   */
  defaultModel?: string
}

interface ExpertPackView extends ExpertPackMeta {
  installed: boolean
  installedAvatarId?: string
  avatarImage?: string
}

interface InstalledAvatarConfig {
  expertPack?: {
    id: string
    version: string
    installedAt: string
  }
  [key: string]: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readJsonObject(filePath: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

function readExpertPackMeta(packDir: string): ExpertPackMeta | null {
  const metaPath = path.join(packDir, 'expert-pack.json')
  const raw = readJsonObject(metaPath)
  if (!raw) return null

  const required = ['id', 'name', 'description', 'domain', 'version', 'author', 'sourceAvatarId', 'redline'] as const
  for (const key of required) {
    if (typeof raw[key] !== 'string' || raw[key].trim() === '') return null
  }

  const defaultModel = typeof raw.defaultModel === 'string' && raw.defaultModel.trim().length > 0
    ? raw.defaultModel.trim()
    : undefined

  return {
    id: raw.id as string,
    name: raw.name as string,
    description: raw.description as string,
    domain: raw.domain as string,
    version: raw.version as string,
    author: raw.author as string,
    sourceAvatarId: raw.sourceAvatarId as string,
    redline: raw.redline as string,
    installable: raw.installable !== false,
    defaultModel,
  }
}

function readAvatarImageFromDir(avatarPath: string): string | undefined {
  try {
    const pngPath = path.join(avatarPath, 'avatar.png')
    if (fs.existsSync(pngPath)) {
      const stat = fs.statSync(pngPath)
      if (stat.size > 512 * 1024) return undefined
      const buf = fs.readFileSync(pngPath)
      return `data:image/png;base64,${buf.toString('base64')}`
    }
    const txtPath = path.join(avatarPath, 'avatar.txt')
    if (fs.existsSync(txtPath)) {
      const content = fs.readFileSync(txtPath, 'utf-8').trim()
      if (content.startsWith('default:')) return content
    }
  } catch {
    return undefined
  }
  return undefined
}

function findInstalledAvatarForPack(packId: string): string | undefined {
  const directAvatarPath = path.join(avatarsPath, packId)
  if (fs.existsSync(path.join(directAvatarPath, 'CLAUDE.md'))) return packId

  try {
    const entries = fs.readdirSync(avatarsPath, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const configPath = path.join(avatarsPath, entry.name, 'avatar.config.json')
      const config = readJsonObject(configPath)
      const expertPack = isRecord(config?.expertPack) ? config.expertPack : null
      if (expertPack && expertPack.id === packId) return entry.name
    }
  } catch (err) {
    if (logger) logger.error('expert-pack.find-installed', err instanceof Error ? err : new Error(String(err)))
  }

  return undefined
}

function listExpertPacks(): ExpertPackView[] {
  if (!fs.existsSync(expertPacksPath)) return []

  const packs: ExpertPackView[] = []
  const entries = fs.readdirSync(expertPacksPath, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const packDir = path.join(expertPacksPath, entry.name)
    const meta = readExpertPackMeta(packDir)
    if (!meta) continue
    const installedAvatarId = findInstalledAvatarForPack(meta.id)
    packs.push({
      ...meta,
      installed: Boolean(installedAvatarId),
      installedAvatarId,
      avatarImage: readAvatarImageFromDir(packDir),
    })
  }

  return packs.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
}

function shouldCopyExpertPackPath(src: string): boolean {
  const rel = path.relative(expertPacksPath, src)
  const parts = rel.split(path.sep)
  return !parts.includes('workspaces') &&
    !parts.includes('runs') &&
    !(parts.includes('tests') && parts.includes('reports')) &&
    !parts.some(part => part === '.cache' || part === '.DS_Store')
}

async function writeInstalledAvatarConfig(avatarId: string, pack: ExpertPackMeta): Promise<void> {
  const configPath = path.join(avatarsPath, avatarId, 'avatar.config.json')
  const existing = readJsonObject(configPath) ?? {}
  const config: InstalledAvatarConfig = {
    ...existing,
    expertPack: {
      id: pack.id,
      version: pack.version,
      installedAt: localDateString(),
    },
    // 仅在 pack 声明了 defaultModel 时写入；保留用户对已安装分身的人工覆盖
    ...(pack.defaultModel && !existing.defaultModel ? { defaultModel: pack.defaultModel } : {}),
  }
  await atomicWriteFile(configPath, `${JSON.stringify(config, null, 2)}\n`)
}

async function installExpertPack(packId: string): Promise<{ avatarId: string; installed: boolean }> {
  assertSafeSegment(packId, '专家包 ID')
  const installedAvatarId = findInstalledAvatarForPack(packId)
  if (installedAvatarId) return { avatarId: installedAvatarId, installed: false }

  const packDir = resolveUnderRoot(expertPacksPath, packId)
  const pack = readExpertPackMeta(packDir)
  if (!pack || !pack.installable) {
    throw new Error(`专家包不存在或不可安装：${packId}`)
  }

  const avatarId = pack.sourceAvatarId || pack.id
  assertSafeSegment(avatarId, '分身 ID')
  const targetDir = resolveUnderRoot(avatarsPath, avatarId)
  if (fs.existsSync(targetDir)) {
    throw new Error(`分身 "${avatarId}" 已存在，无法安装专家包`)
  }

  await fs.promises.mkdir(path.dirname(targetDir), { recursive: true })
  fs.cpSync(packDir, targetDir, {
    recursive: true,
    filter: (src) => shouldCopyExpertPackPath(src),
  })
  await writeInstalledAvatarConfig(avatarId, pack)
  if (logger) logger.recordGenerated('avatar', avatarId, targetDir, { action: 'install-expert-pack', packId })
  return { avatarId, installed: true }
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

// agent-runtime 桥接：Phase 1 + Phase 5 观测接入。
// flag off 时不工作；flag on 时计算分段 prompt 的 cacheable 占比，供 renderer 打 log。
wrapHandler(
  'agent-runtime:prompt-cache-stats',
  (
    _,
    avatarId: string,
    parts: { stableSystemPrompt: string; dynamicSystemPrompt?: string },
    knowledgeHits?: string[]
  ) => {
    assertSafeSegment(avatarId, '分身ID')
    return getPromptCacheStats(avatarId, avatarsPath, parts, knowledgeHits ?? [])
  }
)

// 加载分身配置（GAP3/GAP6: 重新调用后 systemPrompt 会根据最新技能/知识/记忆重建）
wrapHandler('load-avatar', (_, avatarId: string, projectId?: string) => {
  assertSafeSegment(avatarId, '分身ID')
  const pid =
    typeof projectId === 'string' && projectId.trim().length > 0
      ? projectId.trim()
      : DEFAULT_AVATAR_PROJECT_ID
  if (pid !== DEFAULT_AVATAR_PROJECT_ID) {
    assertSafeSegment(pid, 'projectId')
  }
  const webEnabled = getDb().getSetting('web_search_enabled') === 'true'
  const config = soulLoader.loadAvatar(avatarId, pid === DEFAULT_AVATAR_PROJECT_ID ? undefined : pid, webEnabled)
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

wrapHandler('create-conversation', (_, title: string, avatarId: string, projectId?: string) => {
  assertSafeSegment(avatarId, '分身ID')
  const pid =
    typeof projectId === 'string' && projectId.trim().length > 0
      ? projectId.trim()
      : DEFAULT_AVATAR_PROJECT_ID
  if (pid !== DEFAULT_AVATAR_PROJECT_ID) assertSafeSegment(pid, 'projectId')
  const conversationId = getDb().createConversation(title, avatarId, pid)
  // v17 事件：会话创建。让 JSONL 自身能定位"这个文件最初什么时候、谁创建的"——
  // 不依赖 sqlite 也能从 JSONL 重建基础元信息。
  if (jsonlAppender) {
    void jsonlAppender.appendConversationStartedEvent(conversationId, {
      type: 'conversation_started',
      conversationId,
      avatarId,
      projectId: pid,
      title,
      ts: Date.now(),
    })
  }
  return conversationId
})

wrapHandler('list-project-ids', (_, avatarId: string) => {
  assertSafeSegment(avatarId, '分身ID')
  // 真源合并（2026-05-24 修复 P1 #4）：
  //   ① projects 表中所有 name（含未关联 conversation 的"空 project"）
  //   ② conversations 反推（容老数据：v18 之前 projects 表不存在，project_id 散在 conversations 里）
  //
  // 原实现只走 ②，导致 ProjectManagerPanel 新建的空 project 不出现在侧栏，
  // 用户没法新建对话到空 project 里。改为合并后，新建空 project 立刻可见；
  // 老数据反推路径仍保留，保证向后兼容。
  const db = getDb()
  const fromTable = db.listProjects(avatarId).map((p) => p.name)
  const fromConvs = db.listProjectIdsForAvatar(avatarId)
  return [...new Set([...fromTable, ...fromConvs])].sort()
})

// ─── Projects 任务包 CRUD（v18，#5 Step B1）──────────────────────────────
wrapHandler('projects:list', (_, avatarId?: string) => {
  if (avatarId) assertSafeSegment(avatarId, '分身ID')
  return getDb().listProjects(avatarId)
})
wrapHandler('projects:create', async (_, avatarId: string, name: string, description?: string) => {
  assertSafeSegment(avatarId, '分身ID')
  const id = getDb().createProject(avatarId, name, description ?? '')
  // 副作用：在知识库下建立 projects/<name>/ 模板目录（README.md / notes.md / decisions/.gitkeep）
  // 失败不阻塞 create（DB 已经写入）；只 warn
  try {
    const km = getKnowledgeManager(avatarId)
    const readme = `# 任务包：${name}\n\n${description ?? ''}\n\n## 关键资料\n\n（把本任务包独有的资料放在这个目录下；分身在引用 @project-context 时会优先看这里。）\n\n## 决策记录\n\n参见 \`decisions/\` 子目录（grill-against-knowledge 写 ADR 时会自动落到这里）。\n`
    km.writeFile(`projects/${name}/README.md`, readme)
    km.writeFile(`projects/${name}/notes.md`, `# ${name} · 工作笔记\n\n（记录会议纪要、客户反馈、临时想法。）\n`)
    km.writeFile(`projects/${name}/decisions/.gitkeep`, '')
  } catch (err) {
    console.warn('[projects:create] 创建知识库模板失败（不影响 DB）:', err instanceof Error ? err.message : String(err))
  }
  return id
})
wrapHandler('projects:update', (_, id: string, patch: { name?: string; description?: string }) => {
  // rename 时同步迁移 knowledge/projects/<old>/ → <new>/（2026-05-24 修复 P1 #4）：
  // ChatWindow 注入 project 上下文时读 `projects/<pid>/README.md`，如果只改 DB 不动 knowledge 目录，
  // 改名后 project 上下文会全部丢失。
  //
  // 顺序很重要：必须先读旧 name → 改 DB（会校验 name 合法性）→ 再 mv 目录。
  // DB 校验失败时不动目录；目录 mv 失败时 DB 已 committed，仅 warn 并提示用户手动迁移。
  const db = getDb()
  const before = db.getProject(id)
  db.updateProject(id, patch)
  if (before && patch.name && patch.name !== before.name) {
    try {
      const km = getKnowledgeManager(before.avatar_id)
      km.renameDirectory(`projects/${before.name}`, `projects/${patch.name}`)
    } catch (mvErr) {
      const msg = mvErr instanceof Error ? mvErr.message : String(mvErr)
      console.warn(
        `[projects:update] knowledge 目录迁移失败（DB 已更新；请手动 mv "projects/${before.name}" → "projects/${patch.name}"）:`,
        msg,
      )
    }
  }
})
wrapHandler('projects:archive', (_, id: string, archived: boolean) => {
  getDb().archiveProject(id, !!archived)
})
wrapHandler('projects:delete', (_, id: string, options?: { migrateConversationsTo?: string }) => {
  getDb().deleteProject(id, options)
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
  try {
    getDb().deleteCachedAnswersByConversation(id)
  } catch (err) {
    if (logger) logger.error('delete-conversation:cleanup-cache', err)
  }
  getDb().deleteConversation(id)
})

// ─── Workspace（L3 Phase A）──────────────────────────────────────────────────

wrapHandler('workspace:stat', (_, conversationId: string, relPath: string) => {
  const { avatarId, projectId } = resolveWorkspaceContext(conversationId)
  return workspaceManager.stat(avatarId, projectId, conversationId, relPath)
})

wrapHandler('workspace:read', (_, conversationId: string, relPath: string) => {
  const { avatarId, projectId } = resolveWorkspaceContext(conversationId)
  return workspaceManager.readFile(avatarId, projectId, conversationId, relPath)
})

wrapHandler('workspace:write', (_, conversationId: string, relPath: string, content: string) => {
  const { avatarId, projectId } = resolveWorkspaceContext(conversationId)
  return workspaceManager.writeFile(avatarId, projectId, conversationId, relPath, content)
})

wrapHandler('workspace:list', (_, conversationId: string, relPath = '.', depth = 1) => {
  const { avatarId, projectId } = resolveWorkspaceContext(conversationId)
  return workspaceManager.list(avatarId, projectId, conversationId, relPath, depth)
})

wrapHandler('workspace:copy', (_, conversationId: string, src: string, dest: string, move = false) => {
  const { avatarId, projectId } = resolveWorkspaceContext(conversationId)
  workspaceManager.copy(avatarId, projectId, conversationId, src, dest, move)
})

wrapHandler('workspace:move', (_, conversationId: string, src: string, dest: string) => {
  const { avatarId, projectId } = resolveWorkspaceContext(conversationId)
  workspaceManager.copy(avatarId, projectId, conversationId, src, dest, true)
})

wrapHandler('workspace:delete', (_, conversationId: string, relPath: string) => {
  const { avatarId, projectId } = resolveWorkspaceContext(conversationId)
  workspaceManager.delete(avatarId, projectId, conversationId, relPath)
})

wrapHandler('workspace:grep', (_, conversationId: string, relPath: string, pattern: string) => {
  const { avatarId, projectId } = resolveWorkspaceContext(conversationId)
  return workspaceManager.grep(avatarId, projectId, conversationId, relPath, pattern)
})

// ─── 消息管理 ────────────────────────────────────────────────────────────────

wrapHandler('save-message', (
  _,
  conversationId: string,
  role: 'user' | 'assistant' | 'tool',
  content: string,
  toolCallId?: string,
  imageUrls?: string[],
  reasoning?: string,
  uncertainMarkers?: string[],
  reconsiderMarkers?: string[],
  toolCallTimelineJson?: string,
) => {
  return getDb().saveMessage(conversationId, role, content, toolCallId, imageUrls, reasoning, uncertainMarkers, reconsiderMarkers, toolCallTimelineJson)
})

wrapHandler('get-messages', (_, conversationId: string) => {
  return getDb().getMessages(conversationId)
})

// 删除单条消息（v14，「重新生成」按钮专用）
wrapHandler('delete-message', (_, messageId: string) => {
  return getDb().deleteMessage(messageId)
})

// ─── 答案缓存（v14，同问不同答修复）─────────────────────────────────────
wrapHandler('answer-cache:get', (_, cacheKey: string) => {
  return getDb().getCachedAnswer(cacheKey)
})
wrapHandler(
  'answer-cache:save',
  (
    _,
    params: {
      cacheKey: string
      avatarId: string
      conversationId: string
      userContent: string
      assistantContent: string
      reasoningContent?: string | null
      model?: string | null
    },
  ) => {
    getDb().saveCachedAnswer(params)
  },
)
wrapHandler('answer-cache:delete', (_, cacheKey: string) => {
  return getDb().deleteCachedAnswer(cacheKey)
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

function toAsrPcmBytes(input: unknown): Uint8Array {
  if (input instanceof Uint8Array) return input
  if (input instanceof ArrayBuffer) return new Uint8Array(input)
  throw new Error('asr:push-pcm 需要 Uint8Array 或 ArrayBuffer')
}

// ─── 豆包流式 ASR（#12 子任务 2）─────────────────────────────────────────────

wrapHandler('asr:start', async (event) => {
  if (activeAsrSession?.active) {
    throw new Error('已有豆包 ASR 会话正在进行')
  }
  const session = new DoubaoAsrSession({
    getSetting: (key) => getDb().getSetting(key),
    logger,
    webContents: event.sender,
    onEnd: (endedSession) => {
      if (activeAsrSession === endedSession) activeAsrSession = null
    },
  })
  activeAsrSession = session
  try {
    return await session.start()
  } catch (error) {
    if (activeAsrSession === session) activeAsrSession = null
    throw error
  }
})

wrapHandler('asr:push-pcm', (_event, pcm: unknown) => {
  if (!activeAsrSession?.active) throw new Error('豆包 ASR 会话未启动')
  activeAsrSession.pushPcm(toAsrPcmBytes(pcm))
  return { ok: true }
})

wrapHandler('asr:stop', () => {
  if (!activeAsrSession?.active) return { ok: true, ignored: true }
  activeAsrSession.stop()
  return { ok: true }
})

wrapHandler('asr:cancel', () => {
  if (!activeAsrSession?.active) return { ok: true, ignored: true }
  activeAsrSession.cancel()
  activeAsrSession = null
  return { ok: true }
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
  const { avatarId, projectId } = resolveWorkspaceContext(conversationId)
  const abs = workspaceManager.resolveCrossProjectPath(avatarId, projectId, conversationId, params.path)
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

/**
 * knowledge:open-md-file
 *
 * 用途：用系统默认应用打开 `<avatar>/knowledge/` 下任意 .md 源文件。
 * 与 `open-raw-file` 的区别：
 *   - open-raw-file 严格限制在 `_raw/` 子目录（原始 PDF/Excel/PPT）
 *   - open-md-file 只要求落在 knowledge 根内（兜底场景：raw_file frontmatter 写了但
 *     `_raw/` 实际缺失时，让 source citation chip 至少能跳到 markdown 源）
 *
 * 安全策略：
 *   1. avatarId 经 `assertSafeSegment` 校验；
 *   2. 解析后绝对路径必须以 `<knowledge>/` 为前缀；
 *   3. 仅接受 .md 后缀，防止借此打开任意非 markdown 文件；
 *   4. 文件不存在直接 ok:false，不调 shell.openPath。
 */
wrapHandler('knowledge:open-md-file', async (_, avatarId: string, mdRelPath: string) => {
  assertSafeSegment(avatarId, '分身ID')
  const knowledgePath = path.join(avatarsPath, avatarId, 'knowledge')
  const absPath = path.resolve(knowledgePath, mdRelPath)
  const knowledgeRoot = knowledgePath + path.sep
  if (!absPath.startsWith(knowledgeRoot)) {
    const msg = `md 路径越界：${mdRelPath}`
    if (logger) logger.error('knowledge:open-md-file', new Error(msg))
    return { ok: false, error: msg }
  }
  if (!absPath.toLowerCase().endsWith('.md')) {
    return { ok: false, error: `仅支持 .md 源文件：${mdRelPath}` }
  }
  if (!fs.existsSync(absPath)) {
    return { ok: false, error: `markdown 源不存在：${mdRelPath}` }
  }
  const openErr = await shell.openPath(absPath)
  if (openErr) {
    if (logger) logger.error('knowledge:open-md-file', new Error(`shell.openPath 失败：${openErr}`))
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

// v18 Letta .af 借鉴：soul-pack 可移植打包格式
// export-to-file：把分身打包并写到指定路径（renderer 通过 showSaveDialog 拿路径）
// import-from-file：从指定路径读 JSON 解析并写回 avatars/
wrapHandler('soul-pack:export-to-file', (_, avatarId: string, outputFilePath: string, options?: ExportSoulPackOptions) => {
  assertSafeSegment(avatarId, '分身ID')
  if (typeof outputFilePath !== 'string' || !outputFilePath) {
    throw new Error('outputFilePath 不能为空')
  }
  const pack = exportSoulPack(avatarsPath, avatarId, options ?? {})
  const json = serializeSoulPack(pack)
  fs.mkdirSync(path.dirname(outputFilePath), { recursive: true })
  fs.writeFileSync(outputFilePath, json, 'utf-8')
  return {
    outputFilePath,
    size: Buffer.byteLength(json, 'utf-8'),
    filesCount: pack.files.length,
    binaryRefsCount: pack.binary_refs.length,
    memoryIncluded: pack.memory_included,
  }
})
wrapHandler('soul-pack:import-from-file', (_, inputFilePath: string, options?: ImportSoulPackOptions): ImportSoulPackResult => {
  if (typeof inputFilePath !== 'string' || !inputFilePath) {
    throw new Error('inputFilePath 不能为空')
  }
  const json = fs.readFileSync(inputFilePath, 'utf-8')
  const pack = parseSoulPack(json)
  return importSoulPack(avatarsPath, pack, options ?? {})
})
/** 预览 pack 元数据（不实际 import），让 UI 给用户确认 */
wrapHandler('soul-pack:preview', (_, inputFilePath: string) => {
  if (typeof inputFilePath !== 'string' || !inputFilePath) {
    throw new Error('inputFilePath 不能为空')
  }
  const json = fs.readFileSync(inputFilePath, 'utf-8')
  const pack = parseSoulPack(json)
  return {
    name: pack.name,
    display_name: pack.display_name,
    description: pack.description,
    domain: pack.domain,
    created_at: pack.created_at,
    created_by: pack.created_by,
    pack_version: pack.pack_version,
    schema_version: pack.schema_version,
    filesCount: pack.files.length,
    binaryRefsCount: pack.binary_refs.length,
    memoryIncluded: pack.memory_included,
    externalSkillsShared: pack.external_skills.shared.length,
    externalSkillsCommunity: pack.external_skills.community.length,
    manifestSha256: pack.manifest_sha256,
  }
})

// v18 OpenClaw 借鉴：Standing Orders 永久规则 CRUD（只读 + append，不提供 remove）
wrapHandler('standing-orders:append', (_, avatarId: string, order: string, source?: string) => {
  assertSafeSegment(avatarId, '分身ID')
  return appendStandingOrder(avatarsPath, avatarId, order, source ?? 'manual')
})
wrapHandler('standing-orders:read', (_, avatarId: string) => {
  assertSafeSegment(avatarId, '分身ID')
  return readStandingOrders(avatarsPath, avatarId)
})
wrapHandler('standing-orders:count', (_, avatarId: string) => {
  assertSafeSegment(avatarId, '分身ID')
  return countStandingOrders(avatarsPath, avatarId)
})

// Lorebook keyword-trigger（SillyTavern 借鉴）：按 user message 关键词被动注入知识片段
// 配置：avatars/<id>/knowledge/_triggers.yaml；缺失时返回 null（功能未启用）
wrapHandler('lorebook:match-and-build', (_, avatarId: string, userMessage: string) => {
  assertSafeSegment(avatarId, '分身ID')
  if (typeof userMessage !== 'string' || userMessage.length === 0) return null
  const knowledgePath = path.join(avatarsPath, avatarId, 'knowledge')
  const cfg = loadTriggers(knowledgePath)
  if (!cfg || cfg.triggers.length === 0) return null
  const matches = matchTriggers(userMessage, cfg)
  if (matches.length === 0) return null
  const retriever = new KnowledgeRetriever(knowledgePath)
  return buildTriggerInjection(matches, retriever, cfg.total_max_chars)
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
 * search-memory: 跨分身搜索 MEMORY.md，返回每个匹配条目的行号 + 上下文。
 *
 * 实现简单：遍历 avatarsPath/*\/memory/MEMORY.md，按行匹配 query 子串（忽略大小写）。
 * 不建索引（memory 文件普遍 < 50KB，遍历足够快）。
 */
wrapHandler('search-memory', async (_, query: string): Promise<Array<{
  avatarId: string
  lineNo: number
  line: string
  context: string
}>> => {
  const q = (query || '').trim().toLowerCase()
  if (!q) return []
  if (q.length > 200) throw new Error('搜索词不能超过 200 字符')
  let entries: string[]
  try {
    entries = await fs.promises.readdir(avatarsPath)
  } catch {
    return []
  }
  const hits: Array<{ avatarId: string; lineNo: number; line: string; context: string }> = []
  for (const avatarId of entries) {
    try {
      const memoryPath = path.join(avatarsPath, avatarId, 'memory', 'MEMORY.md')
      const stat = await fs.promises.stat(memoryPath).catch(() => null)
      if (!stat?.isFile()) continue
      const text = await fs.promises.readFile(memoryPath, 'utf-8')
      const lines = text.split('\n')
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].toLowerCase().includes(q)) {
          // 上下文：当前行 + 上下各 1 行
          const ctxStart = Math.max(0, i - 1)
          const ctxEnd = Math.min(lines.length - 1, i + 1)
          const context = lines.slice(ctxStart, ctxEnd + 1).join('\n')
          hits.push({ avatarId, lineNo: i + 1, line: lines[i], context })
          if (hits.length >= 50) return hits // 全局 cap，避免单关键词扫出几百条
        }
      }
    } catch {
      // 单个分身读失败不影响其他
    }
  }
  return hits
})

/**
 * v17 事件：记忆更新（chat-driven 路径，[MEMORY_UPDATE] 标签触发的写入）。
 *
 * 调用时机：chatStore 写完 MEMORY.md 之后；用户在 MemoryPanel 手动编辑不会触发本事件。
 * summaryPreview 由 chatStore 截断后传入（500 字符上限）。
 */
wrapHandler('record-memory-update-event', async (
  _,
  conversationId: string,
  avatarId: string,
  payload: { updateCount: number; summaryPreview: string; totalByteSize: number; consolidated: boolean },
) => {
  assertSafeSegment(conversationId, 'conversationId')
  assertSafeSegment(avatarId, '分身ID')
  if (!jsonlAppender) return
  // fire-and-forget：appender 内部已 warn 兜底
  void jsonlAppender.appendMemoryUpdateEvent(conversationId, {
    type: 'memory_update',
    conversationId,
    avatarId,
    updateCount: payload.updateCount,
    summaryPreview: payload.summaryPreview,
    totalByteSize: payload.totalByteSize,
    consolidated: payload.consolidated,
    ts: Date.now(),
  })
})

/**
 * v17 事件：会话模型切换（用户在 ChatWindow 顶栏循环切换 conversationModelOverride）。
 *
 * fromModel/toModel 为 null 表示"使用分身 default"。两者相等时仍写一行，
 * 调试场景能看到"用户点了切换但实际值没变"的操作意图。
 */
wrapHandler('record-model-switch-event', async (
  _,
  conversationId: string,
  fromModel: string | null,
  toModel: string | null,
) => {
  assertSafeSegment(conversationId, 'conversationId')
  if (!jsonlAppender) return
  void jsonlAppender.appendModelSwitchEvent(conversationId, {
    type: 'model_switch',
    conversationId,
    fromModel,
    toModel,
    ts: Date.now(),
  })
})

/**
 * v17 事件 viewer：读取会话 JSONL 事件流。
 *
 * 渲染进程通过本 IPC 拿到已归一化的 ConversationJsonlAnyEvent[]——
 * 旧消息行自动补 type='message'，损坏行计入 parseErrors 不污染主数据。
 * 单纯只读，不修改任何文件。
 */
wrapHandler('read-conversation-events', async (_, conversationId: string) => {
  assertSafeSegment(conversationId, 'conversationId')
  return readConversationEvents(app.getPath('userData'), conversationId, {
    warn: (msg, err) =>
      logger?.logEvent('warn', msg, err instanceof Error ? err.message : err === undefined ? undefined : String(err)),
  })
})

/**
 * v17 事件：会话工具模式切换（Ask / Plan / Agent）。
 *
 * 与 conversation:sync-tool-mode（影响主进程工具门禁）不同——本 IPC 只写日志，不改门禁。
 * chatStore.setMode 在同档变化时已经短路，所以本 IPC 收到的请求一定是真实切换。
 * 非法 mode 仅 warn 后忽略，不写非法事件。
 */
wrapHandler('record-mode-switch-event', async (
  _,
  conversationId: string,
  fromMode: string,
  toMode: string,
) => {
  assertSafeSegment(conversationId, 'conversationId')
  const valid = (m: string): m is 'agent' | 'plan' | 'ask' => m === 'agent' || m === 'plan' || m === 'ask'
  if (!valid(fromMode) || !valid(toMode)) {
    if (logger) logger.logEvent('warn', 'record-mode-switch-event', `非法 mode 已忽略 from=${fromMode} to=${toMode}`)
    return
  }
  if (!jsonlAppender) return
  void jsonlAppender.appendModeSwitchEvent(conversationId, {
    type: 'mode_switch',
    conversationId,
    fromMode,
    toMode,
    ts: Date.now(),
  })
})

wrapHandler('read-memory-store', async (_, avatarId: string) => {
  assertSafeSegment(avatarId, '分身ID')
  const structuredPath = path.join(avatarsPath, avatarId, 'memory', STRUCTURED_MEMORY_FILENAME)
  try {
    const raw = await fs.promises.readFile(structuredPath, 'utf-8')
    const doc = parseStructuredMemoryDocumentJson(raw)
    return doc ?? { schemaVersion: 1 as const, entries: [] }
  } catch {
    return { schemaVersion: 1 as const, entries: [] }
  }
})

wrapHandler('write-memory-store', async (_, avatarId: string, payload: unknown) => {
  assertSafeSegment(avatarId, '分身ID')
  try {
    const doc = assertStructuredMemoryDocumentPayload(payload)
    const memoryDir = path.join(avatarsPath, avatarId, 'memory')
    await fs.promises.mkdir(memoryDir, { recursive: true })
    const structuredPath = path.join(memoryDir, STRUCTURED_MEMORY_FILENAME)
    await atomicWriteFile(structuredPath, serializeStructuredMemoryDocument(doc))
    if (logger) logger.recordGenerated('memory', avatarId, structuredPath)
  } catch (err) {
    const msg = err instanceof Error ? err : new Error(String(err))
    if (logger) logger.error('write-memory-store', msg)
    throw err
  }
})

/**
 * get-memory-stats: 返回注入用「结构化 + MEMORY.md」组合的容量统计（与 SoulLoader 长期记忆体积对齐）。
 */
wrapHandler('get-memory-stats', async (_, avatarId: string) => {
  assertSafeSegment(avatarId, '分身ID')
  const memoryDir = path.join(avatarsPath, avatarId, 'memory')
  const memoryPath = path.join(memoryDir, 'MEMORY.md')
  const structuredPath = path.join(memoryDir, STRUCTURED_MEMORY_FILENAME)
  let legacy = ''
  try {
    legacy = await fs.promises.readFile(memoryPath, 'utf-8')
  } catch {
    legacy = ''
  }
  let structuredMd = ''
  let structuredCount = 0
  try {
    const raw = await fs.promises.readFile(structuredPath, 'utf-8')
    const doc = parseStructuredMemoryDocumentJson(raw)
    if (doc && doc.entries.length > 0) {
      structuredMd = formatStructuredMemoryEntriesForPrompt(doc.entries)
      structuredCount = doc.entries.length
    }
  } catch {
    // 结构化文件可选，读失败视同无条目
  }
  return getCombinedMemoryInjectionStats(structuredMd, legacy, structuredCount)
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

/**
 * v17 Phase 2a：对话情景记忆 IPC（extract / list / read / delete）。
 *
 * 抽取流程：拿 DB 里 user/assistant 消息（不含 tool）→ 调注入的 LLM 抽出 episode →
 * 写到 avatars/<id>/memory/episodes/<conv>.json。
 *
 * 触发时机由 chatStore 决定（lazy on next message-save），主进程不主动调度。
 * api_key / base_url 由调用方传入（与 consolidate-memory 同模式）。
 *
 * shouldExtractEpisode 在 chatStore 已先判过；这里再判一次防御重复抽取（幂等）。
 */
wrapHandler('extract-conversation-episode', async (
  _,
  avatarId: string,
  conversationId: string,
  apiKey: string,
  baseUrl: string,
): Promise<{ ok: boolean; reason?: string; messageCount?: number }> => {
  assertSafeSegment(avatarId, '分身ID')
  assertSafeSegment(conversationId, 'conversationId')

  const dbMessages = getDb().getMessages(conversationId)
  const transcript = dbMessages
    .filter((m): m is typeof m & { role: 'user' | 'assistant' } => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({
      role: m.role,
      content: m.content,
      ts: m.created_at,
    }))
  if (transcript.length === 0) {
    return { ok: false, reason: '会话无 user/assistant 消息，跳过抽取' }
  }

  const existing = await readConversationEpisode(avatarsPath, avatarId, conversationId)
  if (!shouldExtractEpisode(existing, transcript.length)) {
    return { ok: false, reason: '消息条数未变化，跳过抽取', messageCount: transcript.length }
  }

  const conversation = getDb().getConversation(conversationId)
  const conversationTitle = conversation?.title ?? `对话 ${conversationId.slice(0, 8)}`

  const chatModel = getDb().getSetting('chat_model') ?? 'deepseek-chat'
  const callLLM = createLLMFn(apiKey, baseUrl, chatModel)

  const result = await extractConversationEpisode(
    { conversationId, avatarId, conversationTitle, transcript },
    callLLM,
  )
  if (!result.ok) {
    if (logger) logger.activity('extract-conversation-episode', `failed: ${result.errorReason}`)
    return { ok: false, reason: result.errorReason }
  }

  await writeConversationEpisode(avatarsPath, result.episode)
  if (logger) {
    logger.activity(
      'extract-conversation-episode',
      `avatar=${avatarId} conv=${conversationId} title="${result.episode.title}" importance=${result.episode.importance}`,
    )
  }
  return { ok: true, messageCount: transcript.length }
})

wrapHandler('list-conversation-episodes', async (_, avatarId: string) => {
  assertSafeSegment(avatarId, '分身ID')
  return listConversationEpisodes(avatarsPath, avatarId)
})

wrapHandler('read-conversation-episode', async (_, avatarId: string, conversationId: string) => {
  assertSafeSegment(avatarId, '分身ID')
  assertSafeSegment(conversationId, 'conversationId')
  return readConversationEpisode(avatarsPath, avatarId, conversationId)
})

wrapHandler('delete-conversation-episode', async (_, avatarId: string, conversationId: string) => {
  assertSafeSegment(avatarId, '分身ID')
  assertSafeSegment(conversationId, 'conversationId')
  await deleteConversationEpisode(avatarsPath, avatarId, conversationId)
})

// ─── 人生经历（Avatar Life Experience，Phase 0）──────────────────────────────
//
// 仅暴露读取 / 删除骨架；生成、推进、reconsolidate 等写操作由 Phase 1/2 注册。
// 所有 handler 强制 assertSafeSegment(avatarId)，episodeId 由 store 层
// assertSafeEpisodeId 兜底校验，复用 read-memory 模式（不存在文件返回 null/空）。
//
// @author zhi.qu
// @date 2026-05-09

/** life:get-manifest: 读取 life/manifest.json，不存在返回 null */
wrapHandler('life:get-manifest', async (_, avatarId: string) => {
  assertSafeSegment(avatarId, '分身ID')
  return readLifeManifest(avatarsPath, avatarId)
})

/** life:list-timeline: 读取 life/timeline.json，不存在返回 [] */
wrapHandler('life:list-timeline', async (_, avatarId: string) => {
  assertSafeSegment(avatarId, '分身ID')
  return readLifeTimeline(avatarsPath, avatarId)
})

/** life:read-episode: 读取 life/episodes/<id>.md 正文，不存在返回 null */
wrapHandler('life:read-episode', async (_, avatarId: string, episodeId: string) => {
  assertSafeSegment(avatarId, '分身ID')
  return readLifeEpisode(avatarsPath, avatarId, episodeId)
})

/** life:get-progress: 读取 life/progress.json，不存在返回 null */
wrapHandler('life:get-progress', async (_, avatarId: string) => {
  assertSafeSegment(avatarId, '分身ID')
  return readLifeProgress(avatarsPath, avatarId)
})

/** life:read-consolidated: 读取 life/consolidated.md，不存在返回空字符串 */
wrapHandler('life:read-consolidated', async (_, avatarId: string) => {
  assertSafeSegment(avatarId, '分身ID')
  return readLifeConsolidated(avatarsPath, avatarId)
})

/**
 * life:delete-episode: 删除单个 episode 的 .md 文件，并从 timeline 中移除条目。
 * 返回 boolean 表示是否实际移除了 timeline 条目（幂等：不存在不报错）。
 *
 * Phase 0 只做底层删除；Phase 2 grower 之后会接入 "删除后局部重生成" 链路。
 */
wrapHandler('life:delete-episode', async (_, avatarId: string, episodeId: string) => {
  assertSafeSegment(avatarId, '分身ID')
  const removed = await deleteLifeEpisode(avatarsPath, avatarId, episodeId)
  if (logger) {
    logger.activity('life:delete-episode', `avatar=${avatarId} episode=${episodeId} removed=${removed}`)
  }
  return removed
})

wrapHandler('life:update-manifest', async (_, avatarId: string, patch: LifeManifestUpdate) => {
  assertSafeSegment(avatarId, '分身ID')
  const updated = await updateLifeManifest(avatarsPath, avatarId, patch)
  if (logger) {
    logger.activity('life:update-manifest', `avatar=${avatarId} persona=${updated.personaName}`)
  }
  return updated
})

// ─── 人生经历（Avatar Life Experience，Phase 1）──────────────────────────────
//
// 生成器 IPC：start / cancel / retry。
// - 生成本身在主进程后台跑（不阻塞 IPC 调用），通过 webContents.send('life:progress')
//   实时推进度到渲染端
// - 每个分身在 lifeAbortControllers 里维护一个 AbortController，cancel/retry 时复用
// - retry = cancel + 重新调用 generateLife（generator 内部断点续传，已完成的不重生成）
//
// @author zhi.qu
// @date 2026-05-09

/**
 * 用户在创建向导第 5 步选择的人生骨架参数。
 * 通过 IPC 透传给主进程，再喂给 generator 的 LifeUserParams。
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
  nameSource?: 'avatarName' | 'user' | 'aiSuggested'
}

/** 每个 avatarId 对应一个 AbortController；start 时新建，cancel/retry 时取消 */
const lifeAbortControllers = new Map<string, AbortController>()

/**
 * 构造 LifeLLMConfig：从 SQLite settings 读 creation_* / chat_*，creation 缺失则
 * fallback 到 chat。creationConfigured 旗标决定 generator 内部走哪套并写
 * progress.usedFallback。
 */
function buildLifeLLMConfig(): LifeLLMConfig {
  const chatApiKey = getDb().getSetting('chat_api_key') ?? ''
  const chatBaseUrl = getDb().getSetting('chat_base_url') ?? 'https://api.deepseek.com/v1'
  const chatModel = getDb().getSetting('chat_model') ?? 'deepseek-chat'
  if (!chatApiKey) {
    throw new Error('未配置 chat_api_key，请先在设置里填入 LLM API Key（人生生成至少需要对话模型）')
  }
  const chatLLM: LLMCallFn = createLLMFn(chatApiKey, chatBaseUrl, chatModel)

  const creationApiKey = getDb().getSetting('creation_api_key') ?? ''
  const creationBaseUrl = getDb().getSetting('creation_base_url') ?? chatBaseUrl
  const creationModel = getDb().getSetting('creation_model') ?? chatModel
  const creationConfigured = creationApiKey.length > 0
  const creationLLM: LLMCallFn = creationConfigured
    ? createLLMFn(creationApiKey, creationBaseUrl, creationModel)
    : chatLLM

  return { creationLLM, chatLLM, creationConfigured }
}

/**
 * 启动单个分身的人生生成（内部函数，被 start / retry 复用）。
 * 启动 + 立即返回；后台异步跑 generateLife。
 *
 * @returns started=true 表示已启动；usedFallback 表示是否走的 chatModel
 */
function spawnLifeGeneration(avatarId: string, params: LifeStartGenerationParams): { started: true; usedFallback: boolean } {
  if (typeof params.currentAge !== 'number' || params.currentAge < 1 || params.currentAge > 100) {
    throw new Error(`非法 currentAge: ${params.currentAge}（应在 1-100）`)
  }
  if (![0, 1, 12, 52].includes(params.timeScale)) {
    throw new Error(`非法 timeScale: ${params.timeScale}（应为 0/1/12/52）`)
  }

  const llms = buildLifeLLMConfig()
  const userParams: LifeUserParams = {
    currentAge: params.currentAge,
    timeScale: params.timeScale,
    growthEnabled: params.growthEnabled !== false,
    extraHints: params.extraHints ?? '',
    personaName: params.personaName,
    personaNameConfirmed: params.personaNameConfirmed,
    nameSource: params.nameSource,
  }

  const ac = new AbortController()
  lifeAbortControllers.set(avatarId, ac)

  // 后台异步执行；不 await，直接返回让 IPC 响应
  // 进度通过 onProgress → webContents.send 推送
  void (async () => {
    try {
      await generateLife({
        avatarsRoot: avatarsPath,
        avatarId,
        avatarName: params.avatarName,
        userParams,
        llms,
        onProgress: (progress: LifeProgress) => {
          mainWindow?.webContents.send('life:progress', { avatarId, progress })
        },
        abortSignal: ac.signal,
      })
      if (logger) logger.activity('life:start-generation', `avatar=${avatarId} 完成`)
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        if (logger) logger.activity('life:start-generation', `avatar=${avatarId} 已取消`)
      } else if (logger) {
        logger.error('life:start-generation', err instanceof Error ? err : new Error(String(err)))
      }
    } finally {
      lifeAbortControllers.delete(avatarId)
    }
  })()

  return { started: true, usedFallback: !llms.creationConfigured }
}

/**
 * life:start-generation: 异步启动初始化生成 Pipeline。
 * IPC 调用立即返回 { started: true, usedFallback }；进度通过 'life:progress' 事件推送。
 */
wrapHandler('life:start-generation', async (_, avatarId: string, params: LifeStartGenerationParams) => {
  assertSafeSegment(avatarId, '分身ID')
  if (lifeAbortControllers.has(avatarId)) {
    throw new Error(`分身 ${avatarId} 的人生生成已在进行中，请先取消再重试`)
  }
  return spawnLifeGeneration(avatarId, params)
})

/**
 * life:cancel-generation: 取消正在进行的生成。已落盘的 manifest/timeline/episodes
 * 都保留，progress.json 会被 generator 写为最后一次状态（含 lastError）。
 */
wrapHandler('life:cancel-generation', async (_, avatarId: string) => {
  assertSafeSegment(avatarId, '分身ID')
  const ac = lifeAbortControllers.get(avatarId)
  if (!ac) {
    return { cancelled: false }
  }
  ac.abort()
  lifeAbortControllers.delete(avatarId)
  if (logger) logger.activity('life:cancel-generation', `avatar=${avatarId}`)
  return { cancelled: true }
})

/**
 * life:retry-generation: 取消（如果有）+ 重新启动 generateLife。
 * generator 内部按 progress.json 断点续传，已完成的 episode 不会重新生成。
 */
wrapHandler('life:retry-generation', async (_, avatarId: string, params: LifeStartGenerationParams) => {
  assertSafeSegment(avatarId, '分身ID')
  const existing = lifeAbortControllers.get(avatarId)
  if (existing) {
    existing.abort()
    lifeAbortControllers.delete(avatarId)
    // 让 spawn 的 finally 完成清理后再启动新的
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  return spawnLifeGeneration(avatarId, params)
})

/**
 * life:reset-and-regenerate: 清空 timeline/episodes/consolidated/progress/manifest，
 * 然后重新启动生成，让 Stage 0 基于 soul.md 重新生成人生骨架。
 */
wrapHandler('life:reset-and-regenerate', async (_, avatarId: string, params: LifeStartGenerationParams) => {
  assertSafeSegment(avatarId, '分身ID')
  const existing = lifeAbortControllers.get(avatarId)
  if (existing) {
    existing.abort()
    lifeAbortControllers.delete(avatarId)
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  await resetGeneratedLife(avatarsPath, avatarId, new Date(), { preserveManifest: false })
  if (logger) logger.activity('life:reset-and-regenerate', `avatar=${avatarId}`)
  return spawnLifeGeneration(avatarId, params)
})

// ─── 持续生长（Phase 2，cron Stage 4） ──────────────────────────────────────
//
// 三个 IPC：
// - life:set-time-scale  改 manifest.timeScale（合法 0/1/12/52）
// - life:toggle-growth    改 manifest.growthEnabled
// - life:advance-now      调试：立即推进单分身一次
//
// 一个 cron 触发的内部函数 runLifeAdvanceAllAvatars，daily 0:30 跑一次。

/**
 * 修改单分身的 timeScale。
 * 合法值 0 / 1 / 12 / 52。修改后立即落盘 manifest.json。
 */
wrapHandler('life:set-time-scale', async (_, avatarId: string, timeScale: number) => {
  assertSafeSegment(avatarId, '分身ID')
  if (![0, 1, 12, 52].includes(timeScale)) {
    throw new Error(`非法 timeScale: ${timeScale}（应为 0/1/12/52）`)
  }
  const manifest = await readLifeManifest(avatarsPath, avatarId)
  if (!manifest) {
    throw new Error(`分身 ${avatarId} 尚未创建人生骨架（缺 manifest.json）`)
  }
  const updated: LifeManifest = { ...manifest, timeScale }
  await writeLifeManifest(avatarsPath, avatarId, updated)
  if (logger) logger.activity('life:set-time-scale', `avatar=${avatarId} → ${timeScale}×`)
  return { ok: true, timeScale }
})

/**
 * 修改单分身的 growthEnabled。关闭后 cron 推进时跳过该分身。
 */
wrapHandler('life:toggle-growth', async (_, avatarId: string, enabled: boolean) => {
  assertSafeSegment(avatarId, '分身ID')
  const manifest = await readLifeManifest(avatarsPath, avatarId)
  if (!manifest) {
    throw new Error(`分身 ${avatarId} 尚未创建人生骨架（缺 manifest.json）`)
  }
  const updated: LifeManifest = { ...manifest, growthEnabled: !!enabled }
  await writeLifeManifest(avatarsPath, avatarId, updated)
  if (logger) logger.activity('life:toggle-growth', `avatar=${avatarId} → ${enabled ? 'on' : 'off'}`)
  return { ok: true, growthEnabled: !!enabled }
})

/**
 * 调试用：立即推进单个分身。
 * 调用方（LifePanel "立即推进" 按钮）期望同步等待结果，便于显示新增 episode 数。
 * 与 cron 的 advanceLife 共享同一个内存级生长锁，并发安全。
 */
wrapHandler('life:advance-now', async (_, avatarId: string) => {
  assertSafeSegment(avatarId, '分身ID')
  const llms = buildLifeLLMConfig()
  const result = await advanceLife({
    avatarsRoot: avatarsPath,
    avatarId,
    llms,
    onProgress: (progress: LifeProgress) => {
      mainWindow?.webContents.send('life:progress', { avatarId, progress })
    },
  })
  if (logger) {
    logger.activity(
      'life:advance-now',
      `avatar=${avatarId} advanced=${result.advanced} new=${result.newEpisodes} failed=${result.failedEpisodes} reason=${result.skipReason ?? ''}`,
    )
  }
  return result
})

/**
 * cron 内部：遍历所有分身，逐个推进。
 * 每个分身独立 try/catch，单分身失败不影响其他分身。
 */
async function runLifeAdvanceAllAvatars(): Promise<AdvanceAllAvatarsResult> {
  const avatars = avatarManager.listAvatars()
  const avatarIds = avatars.map(a => a.id)
  if (avatarIds.length === 0) {
    return { total: 0, advanced: 0, skipped: 0, failed: 0, details: [] }
  }
  // 没配 chat_api_key 时不做任何尝试（buildLifeLLMConfig 会 throw），避免 cron 反复报错
  let llms: LifeLLMConfig
  try {
    llms = buildLifeLLMConfig()
  } catch (err) {
    if (logger) logger.activity('life-advance-all', `跳过：${err instanceof Error ? err.message : String(err)}`)
    return { total: avatarIds.length, advanced: 0, skipped: avatarIds.length, failed: 0, details: [] }
  }

  const summary = await advanceAllAvatars({
    avatarsRoot: avatarsPath,
    avatarIds,
    llms,
    onAvatarProgress: (avatarId, progress) => {
      mainWindow?.webContents.send('life:progress', { avatarId, progress })
    },
    onAvatarSettled: (avatarId, settle) => {
      if ('error' in settle) {
        if (logger) logger.error('life-advance-all', new Error(`avatar=${avatarId} ${settle.error}`))
      }
    },
  })
  if (logger) {
    logger.activity(
      'life-advance-all',
      `total=${summary.total} advanced=${summary.advanced} skipped=${summary.skipped} failed=${summary.failed}`,
    )
  }
  return summary
}

/**
 * v17 Phase 2c+：对话情景记忆遗忘 cron 实现 + 单分身可单测的 helper。
 *
 * 对每个分身：
 *   1. 列出所有 episodes（store 已经在解析失败时跳过损坏文件）
 *   2. applyEpisodeAlgorithmicForgetting 纯算法重算 status
 *   3. 只把 status 变化的条目写回（changedIds），减少磁盘写
 *
 * 任何一个分身处理失败都不阻塞其他分身——cron 视角"尽力做完一轮"。
 */
async function applyEpisodeForgettingForAvatar(avatarId: string): Promise<{
  total: number
  changed: number
  byStatus: { remembered: number; blurred: number; forgotten: number }
}> {
  const episodes = await listConversationEpisodes(avatarsPath, avatarId)
  if (episodes.length === 0) {
    return { total: 0, changed: 0, byStatus: { remembered: 0, blurred: 0, forgotten: 0 } }
  }
  const { episodes: updated, changedIds } = applyEpisodeAlgorithmicForgetting(episodes)
  // 仅写回 status 变化的 episode
  const changedSet = new Set(changedIds)
  for (const ep of updated) {
    if (changedSet.has(ep.conversationId)) {
      try {
        await writeConversationEpisode(avatarsPath, ep)
      } catch (err) {
        if (logger) {
          logger.activity(
            'episode-forgetting',
            `avatar=${avatarId} conv=${ep.conversationId} 写回失败: ${err instanceof Error ? err.message : String(err)}`,
          )
        }
      }
    }
  }
  const byStatus = { remembered: 0, blurred: 0, forgotten: 0 }
  for (const ep of updated) byStatus[ep.consolidationStatus] += 1
  return { total: updated.length, changed: changedIds.length, byStatus }
}

/**
 * cron 内部：遍历所有分身，逐个跑遗忘算法。
 * 每个分身独立 try/catch，单分身失败不影响其他分身。
 */
async function runEpisodeForgettingAllAvatars(): Promise<{
  totalAvatars: number
  totalEpisodes: number
  totalChanged: number
}> {
  const avatars = avatarManager.listAvatars()
  let totalEpisodes = 0
  let totalChanged = 0
  for (const a of avatars) {
    try {
      const r = await applyEpisodeForgettingForAvatar(a.id)
      totalEpisodes += r.total
      totalChanged += r.changed
      if (r.total > 0 && logger) {
        logger.activity(
          'episode-forgetting',
          `avatar=${a.id} total=${r.total} changed=${r.changed} R=${r.byStatus.remembered} B=${r.byStatus.blurred} F=${r.byStatus.forgotten}`,
        )
      }
    } catch (err) {
      if (logger) logger.error('episode-forgetting', new Error(`avatar=${a.id} ${err instanceof Error ? err.message : String(err)}`))
    }
  }
  if (logger) {
    logger.activity(
      'episode-forgetting-all',
      `avatars=${avatars.length} episodes=${totalEpisodes} changed=${totalChanged}`,
    )
  }
  return { totalAvatars: avatars.length, totalEpisodes, totalChanged }
}

/**
 * v18 OpenHuman 借鉴：每分身扫 episode → 按日期分组 → 机械合并写 daily summary。
 * 零 LLM 调用；纯函数级开销可忽略，单分身 50 episodes 实测 < 20ms。
 *
 * 设计：每次 cron 重写所有日期的 summary——因为 forgetter 可能把昨天的 episode
 * 改成 blurred，需要让 summary 同步。避免遗留过期 markdown。
 */
async function runDailySummaryAllAvatars(): Promise<{
  totalAvatars: number
  totalDates: number
}> {
  const avatars = avatarManager.listAvatars()
  let totalDates = 0
  for (const a of avatars) {
    try {
      const episodes = await listConversationEpisodes(avatarsPath, a.id)
      if (episodes.length === 0) continue
      const r = applyDailySummaryAllDates(avatarsPath, a.id, episodes)
      totalDates += r.written.length
      if (r.written.length > 0 && logger) {
        logger.activity(
          'daily-summary',
          `avatar=${a.id} dates_written=${r.written.length} skipped=${r.skipped.length}`,
        )
      }
    } catch (err) {
      if (logger) logger.error('daily-summary', new Error(`avatar=${a.id} ${err instanceof Error ? err.message : String(err)}`))
    }
  }
  if (logger) {
    logger.activity('daily-summary-all', `avatars=${avatars.length} dates=${totalDates}`)
  }
  return { totalAvatars: avatars.length, totalDates }
}

/**
 * v17 IPC：手动触发单分身的对话记忆遗忘计算（调试/UI 用）。
 *
 * 用户可在 UI 里"立即整理记忆"看到 status 变化数；和 cron 跑的是同一个 helper。
 */
wrapHandler('apply-episode-forgetting', async (_, avatarId: string) => {
  assertSafeSegment(avatarId, '分身ID')
  return applyEpisodeForgettingForAvatar(avatarId)
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
 * 读取分身 `defaultModel` 字段（avatar.config.json）。
 *
 * 用于 LLMService dispatcher 路由：当字段以 `claude-` 起始时，chatStore
 * 会改用 ClaudeProvider + Anthropic 凭据；否则继续走 OpenAI-compat slot。
 *
 * 字段缺失或文件不存在返回 null（chatStore 自动 fallback 到全局 chat slot）。
 */
wrapHandler('get-avatar-default-model', (_, avatarId: string) => {
  assertSafeSegment(avatarId, '分身 ID')
  const configPath = path.join(avatarsPath, avatarId, 'avatar.config.json')
  const cfg = readJsonObject(configPath)
  if (!cfg) return null
  const model = cfg.defaultModel
  return typeof model === 'string' && model.trim().length > 0 ? model.trim() : null
})

wrapHandler('expert-packs:list', () => {
  return listExpertPacks()
})

wrapHandler('expert-packs:install', async (_, packId: string) => {
  return installExpertPack(packId)
})

wrapHandler('expert-packs:is-installed', (_, packId: string) => {
  assertSafeSegment(packId, '专家包 ID')
  return Boolean(findInstalledAvatarForPack(packId))
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

// 公共技能（shared/skills/）浏览 + 一键启用 ────────────────────────────────────
wrapHandler('get-available-shared-skills', (_, avatarId: string) => {
  assertSafeSegment(avatarId, '分身ID')
  return skillManager.getAvailableSharedSkills(avatarId)
})

wrapHandler('toggle-shared-skill', (_, avatarId: string, skillName: string, enable: boolean) => {
  assertSafeSegment(avatarId, '分身ID')
  skillManager.toggleSharedSkill(avatarId, skillName, enable)
  if (logger) logger.activity('toggle-shared-skill', `avatarId=${avatarId}, skillName=${skillName}, enable=${enable}`)
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
 * #7：渲染进程同步当前会话的工具模式（Ask/Plan/Agent），供主进程 execute-tool-call 门禁读取。
 */
wrapHandler('conversation:sync-tool-mode', (_, conversationId: string, mode: string) => {
  assertSafeSegment(conversationId, '会话ID')
  if (mode !== 'agent' && mode !== 'plan' && mode !== 'ask') {
    logger.logEvent('warn', 'conversation:sync-tool-mode', `非法 mode 已忽略: ${mode}`)
    return
  }
  setConversationToolMode(conversationId, mode as ConversationModeForTools)
})

/**
 * #7：灰名单工具在桌面端弹出系统确认框；无可用主窗口则拒绝执行。
 */
async function approveGreyZoneToolInMainProcess(toolName: string): Promise<boolean> {
  const win = mainWindow
  if (!win || win.isDestroyed()) return false
  try {
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning',
      buttons: ['取消', `允许执行「${toolName}」`],
      defaultId: 0,
      cancelId: 0,
      title: 'Soul · 高风险工具',
      message: `模型请求执行高风险工具：${toolName}`,
      detail:
        '若并非您本意，请点击「取消」。来自远程 API（Proxy）的同类请求不会弹出此框，且已被默认拒绝。',
    })
    const ok = response === 1
    if (ok) logger.activity('tool-permission-grey-approved', toolName)
    return ok
  } catch (e) {
    logger.error('tool-permission-grey-dialog', e instanceof Error ? e : new Error(String(e)))
    return false
  }
}

/**
 * execute-tool-call: 执行 LLM 发起的工具调用，返回结果字符串给渲染进程。
 * avatarId 用于定位该分身的知识库路径。
 * meta.trustTier：`proxy` = 远程入口（与 chatStore.sendMessage 的 Proxy 选项对齐），灰名单工具一律拒绝。
 */
wrapHandler(
  'execute-tool-call',
  async (
    _,
    avatarId: string,
    conversationId: string,
    name: string,
    args: Record<string, unknown>,
    meta?: { trustTier?: ToolCallTrustTier },
  ) => {
  return withToolCallAudit(avatarId, conversationId, name, args, async () => {
  assertSafeSegment(avatarId, '分身ID')
  assertSafeSegment(conversationId, '会话ID')
  const wsCtx = resolveWorkspaceContext(conversationId)
  const { workspaceRoot, projectId: convProjectId, avatarId: convAvatarId } = wsCtx
  if (convAvatarId !== avatarId) {
    return { content: '', error: '当前会话不属于所选分身，请切换会话后再试' }
  }

  const trustTier: ToolCallTrustTier = meta?.trustTier === 'proxy' ? 'proxy' : 'ui'
  const modeForTools = getConversationToolMode(conversationId)
  const modeDecision = evaluateConversationModeToolPolicy(modeForTools, name)
  if (modeDecision.denied) {
    return { content: '', error: modeDecision.message }
  }
  const proxyDecision = evaluateProxyTrustGreyDenial(trustTier, name)
  if (proxyDecision.denied) {
    return { content: '', error: proxyDecision.message }
  }
  if (trustTier === 'ui' && shouldConfirmGreyZoneOnDesktop(name)) {
    const confirmed = await approveGreyZoneToolInMainProcess(name)
    if (!confirmed) {
      return { content: '', error: `用户已取消高风险工具「${name}」的执行。` }
    }
  }

  // ─── read_tool_result: 读取 ToolResultSpool 落盘的工具结果文件 ──────────
  // spool 路径在 userData/tool-results/<conv>/<tool>-<ts>.txt，不在 workspace 下，
  // 用 read_lines 会被路径安全策略拒绝。本工具专门处理 spool 路径，仅允许 spool root 下。
  //
  // 参数兼容：
  //   path     - spool 文件绝对路径（推荐，spool 提示中给出的完整路径）
  //   call_id  - 兜底，等价 spool 文件 basename（不含 .txt）。
  //              LLM 经常把"工具名-时间戳"误当作 call_id 传，这里映射到 spool 文件解决。
  if (name === 'read_tool_result') {
    const rawPath = (args.path as string) ?? ''
    const callId = typeof args.call_id === 'string' ? args.call_id.trim() : ''
    const startLine = typeof args.start_line === 'number' && Number.isFinite(args.start_line)
      ? Math.max(1, Math.floor(args.start_line))
      : (typeof args.offset === 'number' && Number.isFinite(args.offset) ? Math.max(1, Math.floor(args.offset)) : 1)
    const endLineArg = typeof args.end_line === 'number' && Number.isFinite(args.end_line)
      ? Math.floor(args.end_line)
      : (typeof args.limit === 'number' && Number.isFinite(args.limit) ? startLine + Math.max(1, Math.floor(args.limit)) - 1 : undefined)

    const spoolRoot = toolResultSpool.getRootDir()
    let abs: string
    if (rawPath) {
      abs = path.resolve(rawPath)
    } else if (callId && conversationId) {
      // call_id 兼容：等价于 spool 文件 basename（与 ToolResultSpool.spool 的 ${safeName}-${ts} 对齐）
      const safeName = callId.replace(/\.txt$/i, '').replace(/[^\w.-]/g, '_')
      abs = path.join(spoolRoot, conversationId, `${safeName}.txt`)
    } else {
      return { content: '', error: '需要 path（spool 文件绝对路径）或 call_id（spool 文件名，不含 .txt）' }
    }

    if (!abs.startsWith(spoolRoot + path.sep) && abs !== spoolRoot) {
      return { content: '', error: `路径不在 tool-results 目录下，请使用 spool 提示的完整路径：${rawPath || callId}` }
    }
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      return { content: '', error: `tool-result 文件不存在或已被清理: ${rawPath || callId}` }
    }
    const lines = fs.readFileSync(abs, 'utf-8').split(/\r?\n/)
    const totalLines = lines.length
    if (startLine > totalLines) {
      return { content: '', error: `start_line=${startLine} 超过总行数 ${totalLines}` }
    }
    const requestedEnd = endLineArg ?? startLine + 199
    const cappedEnd = Math.min(totalLines, Math.min(requestedEnd, startLine + 3999))
    const sliced = lines.slice(startLine - 1, cappedEnd)
    const body = sliced.map((line, idx) => `${startLine + idx}|${line}`).join('\n')
    if (requestedEnd > cappedEnd) {
      return { content: `${body}\n[truncated: 返回 ${startLine}-${cappedEnd}/${totalLines}，受 4000 行硬上限或文件末尾限制]` }
    }
    return { content: body }
  }

  // ─── L3 桌面能力工具：完整版实现 ───────────────────────────────────────
  // 预览：加载 HTML / 评估 JS / 抓日志 / 截图
  if (name === 'show_to_user' || name === 'show_html') {
    const rawPath = (args.path as string) ?? ''
    if (!rawPath) return { content: '', error: '缺少 path 参数' }
    const absPath = workspaceManager.resolveCrossProjectPath(convAvatarId, convProjectId, conversationId, rawPath)
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
          const abs = workspaceManager.resolveSafe(convAvatarId, convProjectId, conversationId, sp)
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
    const absPath = workspaceManager.resolveCrossProjectPath(convAvatarId, convProjectId, conversationId, rawPath)
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
    const absIn = workspaceManager.resolveCrossProjectPath(convAvatarId, convProjectId, conversationId, targetPath)
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
    const absOut = workspaceManager.resolveSafe(convAvatarId, convProjectId, conversationId, outputPath)
    fs.mkdirSync(path.dirname(absOut), { recursive: true })
    if (sourcePath) {
      const absIn = workspaceManager.resolveCrossProjectPath(convAvatarId, convProjectId, conversationId, sourcePath)
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
    const absIn = workspaceManager.resolveCrossProjectPath(convAvatarId, convProjectId, conversationId, inputPath)
    const absOut = workspaceManager.resolveSafe(convAvatarId, convProjectId, conversationId, outputPath)
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
    const absIn = workspaceManager.resolveCrossProjectPath(convAvatarId, convProjectId, conversationId, sourcePath)
    const pdfWin = new BrowserWindow({ show: false, webPreferences: { partition: 'persist:soul-print' } })
    try {
      await pdfWin.loadFile(absIn)
      // 等动画/字体稳定
      await new Promise<void>((resolve) => setTimeout(resolve, 300))
      const pdfBuffer = await pdfWin.webContents.printToPDF({ printBackground: true, preferCSSPageSize: true })
      const outputPath = (args.output_path as string) || `export/${path.basename(sourcePath, path.extname(sourcePath))}.pdf`
      const absOut = workspaceManager.resolveSafe(convAvatarId, convProjectId, conversationId, outputPath)
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
    const absOut = workspaceManager.resolveSafe(convAvatarId, convProjectId, conversationId, outputPath)
    const inputPath = (args.input_path as string) || ''
    const mode = (args.mode as string) === 'screenshots' ? 'screenshots' : 'editable'
    if (!inputPath) {
      return { content: '', error: '缺少 input_path 参数（HTML 文件相对路径）' }
    }
    const absIn = workspaceManager.resolveCrossProjectPath(convAvatarId, convProjectId, conversationId, inputPath)
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
    const abs = workspaceManager.resolveCrossProjectPath(convAvatarId, convProjectId, conversationId, rel)
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
    const abs = workspaceManager.resolveCrossProjectPath(convAvatarId, convProjectId, conversationId, rel)
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
    const abs = workspaceManager.resolveCrossProjectPath(convAvatarId, convProjectId, conversationId, rel)
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
    const result = await toolRouter.execute(avatarId, { name, arguments: args }, undefined, conversationId, convProjectId)
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
    const result = await toolRouter.execute(avatarId, { name, arguments: args }, undefined, conversationId, convProjectId)
    if (result.error) return result
    try {
      const parsed = JSON.parse(result.content) as { mode?: string; reason?: string }
      if (parsed.mode === 'agent' || parsed.mode === 'plan' || parsed.mode === 'ask') {
        setConversationToolMode(conversationId, parsed.mode as ConversationModeForTools)
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
    const destPath = workspaceManager.resolveSafe(convAvatarId, convProjectId, conversationId, path.join(directory, kind))
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
    const abs = workspaceManager.resolveCrossProjectPath(convAvatarId, convProjectId, conversationId, targetPath)
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
    const r = await githubConnector.importFiles(convAvatarId, convProjectId, conversationId, owner, repo, files, ref)
    return { content: JSON.stringify(r, null, 2) }
  }

  // Canva：本地导出 + 打开浏览器，引导用户拖拽上传
  if (name === 'send_to_canva' || name === 'canva_open_upload') {
    const exportPath = typeof args.export_path === 'string' ? args.export_path : undefined
    if (exportPath) {
      const abs = workspaceManager.resolveCrossProjectPath(convAvatarId, convProjectId, conversationId, exportPath)
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
    const abs = workspaceManager.resolveCrossProjectPath(convAvatarId, convProjectId, conversationId, filePathArg)
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
  return toolRouter.execute(avatarId, { name, arguments: args }, callLLM, conversationId, convProjectId)
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
  const { contexts, embeddings, hashes, tokens } = await buildKnowledgeIndex(
    retriever,
    { callLLM, callEmbedding },
    undefined,
    existingIndex,
  )

  saveIndex(knowledgePath, contexts, embeddings, hashes, tokens)
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
    // Phase 5: 人生记忆是分身人格的一部分（注入 system prompt），manifest 变化
    // 意味着人生事件被推进 / reconsolidate / timeScale 被改 → 缓存应失效。
    // 文件不存在时 captureFileSnapshot 自动返回 (mtime=0,size=0)，无人生分身也安全。
    captureFileSnapshot(path.join(avatarRoot, 'life', 'manifest.json')),
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
    saveIndex(knowledgePath, idxResult.contexts, idxResult.embeddings, idxResult.hashes, idxResult.tokens)
    toolRouter.invalidateRetriever(avatarId)
  } catch (err) {
    if (logger) logger.error('batch-import-build-index', err instanceof Error ? err : new Error(String(err)))
  }

  // 2026-05-18: wiki/concepts/ 自动重编译（PAP 学习笔记借鉴）。
  // 用户主动 import 后顺便更新实体概念页；fire-and-forget，失败仅 warn 不影响 import 流程。
  // 默认 off（compileConceptPages 调 LLM 单分身约 100K tokens，避免静默烧钱）；
  // 用户在「设置 → 知识库」开启 wiki_auto_compile_on_import 后才跑。
  // 手动触发仍走 compile-wiki IPC。
  const autoCompile = getDb().getSetting('wiki_auto_compile_on_import') === 'true'
  if (autoCompile) {
    const apiKey = getDb().getSetting('chat_api_key') || ''
    const baseUrl = getDb().getSetting('chat_base_url') || 'https://api.deepseek.com/v1'
    if (apiKey) {
      mainWindow?.webContents.send('knowledge-import-progress', {
        current: 0, total: 0, fileName: '', phase: '编译实体概念页（wiki）...',
      })
      const avatarPath = path.join(avatarsPath, avatarId)
      const callLLM = createLLMFn(apiKey, baseUrl, 'qwen-plus')
      const wiki = new WikiCompiler(avatarPath)
      const chunks = toolRouter.getRetriever(avatarId).getFullChunks()
      wiki.compileConceptPages(chunks, callLLM)
        .then((pages) => {
          if (logger) logger.activity('wiki-auto-compile', `avatarId=${avatarId}, pages=${pages.length} (after import)`)
        })
        .catch((err) => {
          if (logger) logger.error('wiki-auto-compile', err instanceof Error ? err : new Error(String(err)))
        })
    }
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
      saveIndex(knowledgePath, idxResult.contexts, idxResult.embeddings, idxResult.hashes, idxResult.tokens)
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

// ─── Scheduled Tasks 用户自定义定时任务（#11，2026-05-09） ────────────────────
//
// 与上方内置三类 cron 完全隔离的命名空间 schedule:*：
//   schedule:list / get / create / update / delete / set-enabled
//   schedule:trigger-now / get-next-runs / list-runs / record-run-finish
//
// 触发链路：cronScheduler.scheduleCron 到点 → fireScheduleCallback → recordRunStart
// → webContents.send('schedule:trigger', { runId, scheduleId, ... }) → 渲染端调 sendMessage
// → 渲染端调 IPC 'schedule:record-run-finish' 更新 status / conversation_id / duration_ms。

/**
 * 将一条 schedule 注册到 cronScheduler，并 setNextRunAt 写回 DB。
 * 失败抛错（cron 表达式非法等），由调用方决定如何对外暴露。
 */
function registerScheduleInScheduler(row: ScheduleRow): void {
  cronScheduler.scheduleCron(row.id, row.cron_expr, row.timezone, (firedAtUtc) => {
    fireScheduleCallback(row.id, firedAtUtc, /*manual*/ false).catch((err) => {
      console.error(`[schedule:${row.id}] cron 触发失败:`, err)
      if (logger) logger.error('schedule-fire', err instanceof Error ? err : new Error(String(err)))
    })
  })
  // 回写下次触发时间（UI 展示用，运行时仍以 croner 为准）
  try {
    const next = cronScheduler.getNextRuns(row.cron_expr, row.timezone, 1)
    getScheduleStore().setNextRunAt(row.id, next[0] ?? null)
  } catch (err) {
    // getNextRuns 在极少数边界情况下可能没有下一次触发，仅记日志不影响调度
    console.warn(`[schedule:${row.id}] getNextRuns 失败:`, err instanceof Error ? err.message : String(err))
  }
}

/**
 * 触发一次 schedule（cron 到点 / 立即触发 共享路径）。
 *
 * 步骤：
 *   1. recordRunStart 写 running 行（UNIQUE 冲突 = 同时刻被重复触发，直接 return 跳过）
 *   2. webContents.send 通知渲染端跑 sendMessage；payload 含 runId 让渲染端 record-run-finish
 *   3. 不在主进程里等待 sendMessage 完成（fire-and-forget）
 *
 * @param scheduleId schedules.id
 * @param firedAtUtc 触发时刻 Unix ms
 * @param manual true = trigger-now 路径；用于审计
 */
async function fireScheduleCallback(
  scheduleId: string,
  firedAtUtc: number,
  manual: boolean,
): Promise<void> {
  const store = getScheduleStore()
  const schedule = store.get(scheduleId)
  if (!schedule) {
    if (logger) logger.activity('schedule-fire-missing', `${scheduleId} not found`)
    return
  }
  if (!schedule.enabled && !manual) {
    // 禁用状态下 cron 触发：理论上 cancel 应已生效，这里多一层防御
    return
  }

  const startResult = store.recordRunStart(scheduleId, firedAtUtc)
  if (startResult.conflict || startResult.runId === null) {
    if (logger) logger.activity('schedule-fire-dedup', `${scheduleId}@${firedAtUtc}`)
    return
  }

  // 更新下次触发时间预览（不影响 croner 实际调度）
  try {
    const next = cronScheduler.getNextRuns(schedule.cron_expr, schedule.timezone, 1, firedAtUtc + 1)
    store.setNextRunAt(scheduleId, next[0] ?? null)
  } catch (err) {
    console.warn(`[schedule:${scheduleId}] 计算 next_run_at 失败:`, err instanceof Error ? err.message : String(err))
  }

  // 通知渲染端：渲染端会调 sendMessage 然后 record-run-finish
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('schedule:trigger', {
      runId: startResult.runId,
      scheduleId,
      firedAtUtc,
      avatarId: schedule.avatar_id,
      projectId: schedule.project_id,
      conversationId: schedule.conversation_id,
      promptText: schedule.prompt_text,
      manual,
      scheduleName: schedule.name,
    })
    if (logger) logger.activity('schedule-fire', `${scheduleId} runId=${startResult.runId} manual=${manual}`)
  } else {
    // 没有渲染端可用：直接标失败，避免 running 行永远悬空
    store.recordRunFinish(startResult.runId, 'failed', {
      errorMessage: '主窗口不可用，无法触发渲染端 sendMessage',
    })
  }
}

/**
 * 启动时遍历所有 enabled schedules 注册到 cronScheduler。
 * 失败的单条任务记录日志后继续（不影响其他任务）。
 */
function restoreSchedulesFromDb(): void {
  const rows = getScheduleStore().listEnabled()
  let ok = 0
  let bad = 0
  for (const row of rows) {
    try {
      registerScheduleInScheduler(row)
      ok++
    } catch (err) {
      bad++
      console.error(`[Main] 恢复 schedule ${row.id} 失败:`, err)
      if (logger) logger.error('schedule-restore-one', err instanceof Error ? err : new Error(String(err)))
    }
  }
  if (logger) logger.activity('schedules-restored', `ok=${ok} failed=${bad} total=${rows.length}`)
}

/** 字符串校验：cron 字段长度上限，避免 DoS */
function assertScheduleField(value: unknown, name: string, maxLen: number, allowEmpty = false): string {
  if (typeof value !== 'string') {
    throw new Error(`${name} 必须为字符串`)
  }
  if (!allowEmpty && value.trim().length === 0) {
    throw new Error(`${name} 不能为空`)
  }
  if (value.length > maxLen) {
    throw new Error(`${name} 长度超出上限 ${maxLen}`)
  }
  return value
}

/** schedule:list - 列出所有 schedules（可按 avatarId 过滤） */
wrapHandler('schedule:list', (_, avatarId?: string): ScheduleRow[] => {
  if (avatarId) assertSafeSegment(avatarId, '分身ID')
  return getScheduleStore().list({ avatarId })
})

/** schedule:get - 单个 schedule */
wrapHandler('schedule:get', (_, id: string): ScheduleRow | null => {
  return getScheduleStore().get(id) ?? null
})

/** schedule:create - 创建 schedule + 立即注册调度（若 enabled） */
wrapHandler('schedule:create', (_, input: NewScheduleInput): ScheduleRow => {
  // 字段校验：避免渲染端非法输入污染 DB
  assertScheduleField(input?.name, 'name', 200)
  assertSafeSegment(input.avatarId, '分身ID')
  if (input.projectId) assertSafeSegment(input.projectId, 'projectId')
  assertScheduleField(input.cronExpr, 'cronExpr', 200)
  assertScheduleField(input.promptText, 'promptText', 8000)
  if (input.timezone) assertScheduleField(input.timezone, 'timezone', 64)

  // 提前用 croner 校验 cron 表达式合法性，避免存了非法值后续无法注册
  cronScheduler.getNextRuns(input.cronExpr, input.timezone ?? 'Asia/Shanghai', 1)

  const row = getScheduleStore().create(input)
  if (row.enabled === 1) {
    try {
      registerScheduleInScheduler(row)
    } catch (err) {
      // 注册失败：撤销 DB 写入，避免 DB 与运行时不一致
      getScheduleStore().delete(row.id)
      throw err
    }
  }
  return row
})

/** schedule:update - 更新（取消旧调度 + 注册新调度 + DB write） */
wrapHandler('schedule:update', (_, id: string, patch: UpdateScheduleInput): ScheduleRow => {
  const existing = getScheduleStore().get(id)
  if (!existing) throw new Error(`schedule 不存在: ${id}`)

  if (patch.name !== undefined) assertScheduleField(patch.name, 'name', 200)
  if (patch.avatarId !== undefined) assertSafeSegment(patch.avatarId, '分身ID')
  if (patch.projectId !== undefined) assertSafeSegment(patch.projectId, 'projectId')
  if (patch.cronExpr !== undefined) assertScheduleField(patch.cronExpr, 'cronExpr', 200)
  if (patch.promptText !== undefined) assertScheduleField(patch.promptText, 'promptText', 8000)
  if (patch.timezone !== undefined) assertScheduleField(patch.timezone, 'timezone', 64)

  const nextCronExpr = patch.cronExpr ?? existing.cron_expr
  const nextTimezone = patch.timezone ?? existing.timezone
  // 校验新表达式合法
  cronScheduler.getNextRuns(nextCronExpr, nextTimezone, 1)

  getScheduleStore().update(id, patch)
  cronScheduler.cancelCron(id)
  const updated = getScheduleStore().get(id)!
  if (updated.enabled === 1) {
    registerScheduleInScheduler(updated)
  } else {
    // 禁用：清空 next_run_at，避免 UI 误以为还会触发
    getScheduleStore().setNextRunAt(id, null)
  }
  return getScheduleStore().get(id)!
})

/** schedule:delete - 删除 schedule（FK CASCADE 自动清 runs） */
wrapHandler('schedule:delete', (_, id: string): boolean => {
  cronScheduler.cancelCron(id)
  return getScheduleStore().delete(id)
})

/** schedule:set-enabled - 启停（不删除） */
wrapHandler('schedule:set-enabled', (_, id: string, enabled: boolean): ScheduleRow => {
  const existing = getScheduleStore().get(id)
  if (!existing) throw new Error(`schedule 不存在: ${id}`)
  getScheduleStore().update(id, { enabled })
  cronScheduler.cancelCron(id)
  const updated = getScheduleStore().get(id)!
  if (updated.enabled === 1) {
    registerScheduleInScheduler(updated)
  } else {
    getScheduleStore().setNextRunAt(id, null)
  }
  return getScheduleStore().get(id)!
})

/** schedule:trigger-now - 立即触发一次（人工调试用） */
wrapHandler('schedule:trigger-now', async (_, id: string): Promise<{ runId: number | null; conflict: boolean }> => {
  const existing = getScheduleStore().get(id)
  if (!existing) throw new Error(`schedule 不存在: ${id}`)
  const firedAtUtc = Date.now()
  await fireScheduleCallback(id, firedAtUtc, /*manual*/ true)
  // 取这次触发对应的 run（按 fired_at_utc 倒序第一个 status=running，可能已被渲染端 finish 掉）
  const runs = getScheduleStore().listRuns(id, 1)
  const top = runs[0]
  if (top && Math.abs(top.fired_at_utc - firedAtUtc) < 1500) {
    return { runId: top.id, conflict: false }
  }
  return { runId: null, conflict: true }
})

/** schedule:get-next-runs - 计算下 n 次触发时间（UI 预览用，不写 DB） */
wrapHandler('schedule:get-next-runs', (_, cronExpr: string, timezone: string, n: number): number[] => {
  assertScheduleField(cronExpr, 'cronExpr', 200)
  assertScheduleField(timezone, 'timezone', 64)
  const safeN = Math.max(0, Math.min(10, Math.floor(n)))
  return cronScheduler.getNextRuns(cronExpr, timezone, safeN)
})

/** schedule:list-runs - 历史触发日志，最多 limit 条 */
wrapHandler('schedule:list-runs', (_, scheduleId: string, limit?: number): ScheduleRunRow[] => {
  const safeLimit = Math.max(1, Math.min(500, Math.floor(limit ?? 100)))
  return getScheduleStore().listRuns(scheduleId, safeLimit)
})

/** schedule:record-run-finish - 渲染端 sendMessage 完成后回填 status/conversation/duration */
wrapHandler('schedule:record-run-finish', (
  _,
  runId: number,
  status: Exclude<RunStatus, 'running'>,
  opts?: { conversationId?: string | null; durationMs?: number; errorMessage?: string },
): boolean => {
  if (!Number.isInteger(runId) || runId <= 0) throw new Error('runId 非法')
  if (!['success', 'failed', 'missed'].includes(status)) throw new Error(`status 非法: ${status}`)
  return getScheduleStore().recordRunFinish(runId, status, opts)
})

// ─── Web Embed widget（#15 · 子任务 2） ───────────────────────────────────────
//
// 命名空间 embed:*：
//   embed:list / get / create / update / delete / set-enabled
//   embed:get-port / server-start / server-stop
//
// 与 schedule:* 同款风格：DAO 操作走 EmbedStore，server 启停走 WidgetServer 单例。
// 所有 id 入参用 assertEmbedId 校验（前缀 emb_ + 字母数字下划线），防止路径穿越。

/** 校验来自渲染进程的 embed_id：必须是 emb_ 前缀 + 字母数字下划线 */
function assertEmbedId(id: string): void {
  if (!id || typeof id !== 'string' || !/^emb_[a-zA-Z0-9_]+$/.test(id)) {
    throw new Error('非法 embed_id')
  }
}

/** embed:list - 列出 embeds，可按 avatarId / enabled 过滤 */
wrapHandler('embed:list', (_, opts?: { avatarId?: string; enabled?: boolean }) => {
  return getEmbedStore().list(opts)
})

/** embed:get - 单个 embed */
wrapHandler('embed:get', (_, id: string) => {
  assertEmbedId(id)
  return getEmbedStore().get(id)
})

/** embed:create - 创建 embed（id 由 store 自动生成；origin 含 * DAO 层抛错） */
wrapHandler('embed:create', (_, input: NewEmbedInput) => {
  if (!input?.avatarId || !input?.name) {
    throw new Error('avatarId 与 name 必填')
  }
  return getEmbedStore().create(input)
})

/** embed:update - 部分更新 embed */
wrapHandler('embed:update', (_, id: string, input: UpdateEmbedInput) => {
  assertEmbedId(id)
  const row = getEmbedStore().update(id, input)
  if (!row) throw new Error('embed 不存在')
  return row
})

/** embed:delete - 删除 embed */
wrapHandler('embed:delete', (_, id: string) => {
  assertEmbedId(id)
  return getEmbedStore().delete(id)
})

/** embed:set-enabled - 单独切换启停 */
wrapHandler('embed:set-enabled', (_, id: string, enabled: boolean) => {
  assertEmbedId(id)
  const row = getEmbedStore().setEnabled(id, enabled)
  if (!row) throw new Error('embed 不存在')
  return row
})

/** embed:get-port - 当前 widget-server 监听端口（未启动返回 null） */
wrapHandler('embed:get-port', () => {
  return widgetServer?.getPort() ?? null
})

/** embed:server-start - 显式启动 widget-server，并把 settings 标 enabled */
wrapHandler('embed:server-start', async () => {
  if (widgetServer?.isRunning()) {
    return { port: widgetServer.getPort() }
  }
  if (!widgetServer) {
    widgetServer = new WidgetServer({
      getDb,
      getEmbedStore,
      logger,
    })
  }
  const { port } = await widgetServer.start()
  getDb().setSetting('widget_server_enabled', 'true')
  return { port }
})

/** embed:server-stop - 显式关闭 widget-server，并把 settings 标 disabled */
wrapHandler('embed:server-stop', async () => {
  if (widgetServer?.isRunning()) {
    await widgetServer.stop()
  }
  getDb().setSetting('widget_server_enabled', 'false')
  return { ok: true }
})

// ─── WebDAV 跨设备同步（#16 · 子任务 4） ─────────────────────────────────────
//
// 命名空间 sync:*（实际 10 个 IPC）：
//   sync:get-config / set-config / clear-credentials / test-connection
//   sync:backup-now / list-remote-backups / restore-from / get-status
//   sync:list-history / clear-history
//
// 与 schedule:* / embed:* 同款风格：
//   - 业务编排走 SyncManager 单例（lazy 创建）
//   - 路径校验：filename 必须匹配 isSafeBackupFilename 白名单（防 IPC 注入）
//   - 错误统一通过 wrapHandler 走 logger.error；SyncManager 内部不抛栈给上层
//
// restore-from 在拿到 ok=true 后由本层主导 app.relaunch + app.exit，
// 这样渲染端能先收到 ack 再退出，不丢响应。

/** sync:get-config - 读取当前 WebDAV 同步配置（不含密码明文） */
wrapHandler('sync:get-config', () => {
  return getSyncManager().getConfig()
})

/** sync:set-config - 部分更新 WebDAV 同步配置；写入后立即重注册 cron */
wrapHandler('sync:set-config', async (_, input: SyncSetConfigInput) => {
  if (input === null || typeof input !== 'object') {
    throw new Error('input 必须为对象')
  }
  const cfg = await getSyncManager().setConfig(input)
  await getSyncManager().registerAutoInterval()
  return cfg
})

/** sync:clear-credentials - 清空 WebDAV 密码（不影响其他配置项） */
wrapHandler('sync:clear-credentials', async () => {
  await getSyncManager().clearCredentials()
  return { ok: true }
})

/** sync:test-connection - 测试 WebDAV 连接；input 为空时用持久化配置 */
wrapHandler('sync:test-connection', (_, input?: SyncTestConnectionInput) => {
  if (input !== undefined && (input === null || typeof input !== 'object')) {
    throw new Error('input 必须为对象或 undefined')
  }
  return getSyncManager().testConnection(input)
})

/** sync:backup-now - 立即触发一次备份；并发时抛 sync_already_running */
wrapHandler('sync:backup-now', () => {
  return getSyncManager().backupNow()
})

/** sync:list-remote-backups - 列出远端可用备份（按 lastModified 倒序） */
wrapHandler('sync:list-remote-backups', () => {
  return getSyncManager().listRemoteBackups()
})

/** sync:restore-from - 从远端备份恢复；ok=true 后立即 relaunch */
wrapHandler('sync:restore-from', async (_, filename: string) => {
  if (typeof filename !== 'string' || !isSafeBackupFilename(filename)) {
    throw new Error('非法备份文件名')
  }
  const result = await getSyncManager().restoreFrom(filename)
  if (result.ok) {
    // 推迟到 setImmediate 让 IPC 响应先到达渲染端
    setImmediate(() => {
      try {
        app.relaunch()
        app.exit(0)
      } catch (err) {
        if (logger) logger.error('sync:restore-from-relaunch', err instanceof Error ? err : new Error(String(err)))
      }
    })
  }
  return result
})

/** sync:get-status - 当前同步状态 + safeStorage 后端信息 */
wrapHandler('sync:get-status', () => {
  return getSyncManager().getStatus()
})

/** sync:list-history - 同步历史最近 30 条（设置面板"同步历史"列表用） */
wrapHandler('sync:list-history', (_, opts?: { limit?: number; direction?: SyncDirection; status?: SyncRunStatus }) => {
  const limit = (opts?.limit !== undefined && Number.isFinite(opts.limit) && opts.limit > 0)
    ? Math.min(Math.floor(opts.limit), 100)
    : 30
  return getSyncHistoryStore().list({ limit, direction: opts?.direction, status: opts?.status })
})

/** sync:clear-history - 清空同步历史（运维 / 用户手动重置用） */
wrapHandler('sync:clear-history', () => {
  return getSyncHistoryStore().clear()
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
 * 打开当前分身的工作区根目录（workspaces/）。
 * 用户可在这里按会话目录查找 exports/ 下的 PDF / Excel / Word 等产物。
 */
wrapHandler('open-avatar-workspaces-folder', async (_, avatarId: string) => {
  assertSafeSegment(avatarId, '分身ID')
  const workspacesDir = path.join(avatarsPath, avatarId, 'workspaces')
  if (!fs.existsSync(workspacesDir)) {
    fs.mkdirSync(workspacesDir, { recursive: true })
  }
  const errMsg = await shell.openPath(workspacesDir)
  if (errMsg) return { success: false, error: errMsg, path: workspacesDir }
  return { success: true, path: workspacesDir }
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
/**
 * web-search: 联网搜索（@web 引用的 backend）。
 *
 * 实现：调 DuckDuckGo Instant Answer API（免 key / 免 CORS / 稳定）。
 * 局限：DDG IA 对 long-tail 查询返回稀疏；想要更准的结果用户应当配 MCP Tavily/Brave server。
 *
 * 返回 markdown 化结果（标题 + 摘要 + 链接），供前端作为 inline file 引用。
 */
wrapHandler('web-search', async (_, query: string): Promise<{
  query: string
  results: Array<{ title: string; snippet: string; url: string }>
  abstract?: string
  abstractSource?: string
}> => {
  const q = (query || '').trim()
  if (!q) throw new Error('搜索关键词不能为空')
  if (q.length > 200) throw new Error('搜索关键词不能超过 200 字符')
  const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(q)}&format=json&no_html=1&skip_disambig=1`
  const res = await fetchWithTimeout(url, {
    headers: { 'User-Agent': 'Soul-Desktop' },
    timeoutMs: 8000,
  })
  if (!res.ok) throw new Error(`DuckDuckGo 返回 ${res.status}`)
  const data = await res.json() as {
    Abstract?: string
    AbstractSource?: string
    AbstractURL?: string
    Heading?: string
    RelatedTopics?: Array<{ Text?: string; FirstURL?: string; Topics?: Array<{ Text?: string; FirstURL?: string }> }>
    Results?: Array<{ Text?: string; FirstURL?: string }>
  }
  const results: Array<{ title: string; snippet: string; url: string }> = []
  for (const r of data.Results || []) {
    if (r.Text && r.FirstURL) results.push({ title: r.Text.split(' - ')[0] || r.Text, snippet: r.Text, url: r.FirstURL })
  }
  for (const r of data.RelatedTopics || []) {
    if (r.Topics) {
      for (const sub of r.Topics) {
        if (sub.Text && sub.FirstURL) {
          results.push({ title: sub.Text.split(' - ')[0] || sub.Text, snippet: sub.Text, url: sub.FirstURL })
        }
      }
    } else if (r.Text && r.FirstURL) {
      results.push({ title: r.Text.split(' - ')[0] || r.Text, snippet: r.Text, url: r.FirstURL })
    }
    if (results.length >= 15) break
  }
  return {
    query: q,
    results: results.slice(0, 15),
    abstract: data.Abstract || undefined,
    abstractSource: data.AbstractSource || undefined,
  }
})

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

/**
 * mcp:test-connect — 测试 MCP server 配置但不持久化到 DB。
 *
 * 实现：addServer（mcpManager 内部已支持 enabled 触发 connect），等 ready 拿到 snapshot，
 * 然后 removeServer 清理。整个过程不写 DB。
 *
 * 用户场景：编辑表单时点"测试"，不希望先保存才能验证。
 *
 * 返回：snapshot（含 toolCount / tools / error / status）；失败时也返回（含 error 信息）。
 */
wrapHandler('mcp:test-connect', async (_event, input: McpServerInput) => {
  if (!mcpManager) throw new Error('mcpManager 未初始化')
  if (!input?.name || !/^[a-zA-Z0-9_-]{1,32}$/.test(input.name)) {
    throw new Error('server 名称非法，仅允许 [a-zA-Z0-9_-]，长度 1~32')
  }
  // 用临时名（前缀 __test__）避免和真实 server 冲突 + 不污染 DB
  const testName = `__test__${Date.now().toString(36).slice(-8)}`
  try {
    await mcpManager.addServer({
      name: testName,
      enabled: true, // 测试时强制启用，否则不会连
      transport: input.transport,
      command: input.command,
      args: input.args,
      env: input.env,
      cwd: input.cwd,
      url: input.url,
      timeoutMs: input.timeoutMs,
      description: input.description,
    })
    const snapshot = mcpManager.getSnapshot(testName)
    return snapshot
  } finally {
    // 不管成功失败都清理
    try { await mcpManager.removeServer(testName) } catch { /* ignore */ }
  }
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
