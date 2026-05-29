/**
 * Sync orchestration manager for Soul WebDAV cross-device sync (#16).
 *
 * Responsibilities:
 *  - Coordinate webdav-client + snapshot-builder + sync-history DAO
 *  - Run backup (build snapshot → upload → record history → retention prune)
 *  - Run restore (download → pre-restore safety backup → extract → swap files)
 *  - Manage automatic interval via cron-scheduler (#11)
 *  - Persist configuration to settings table (key/value, no new table)
 *
 * Single-instance: held by main.ts as a lazy singleton; not exported as default.
 *
 * 设计要点：
 *  - 配置全部写 settings 表，避免新增 schema 迁移
 *  - 密码用 credential-store 走 safeStorage 加密；明文仅在内存中短暂存在
 *  - cron 注册键固定为 'webdav-sync'（只 backup 走 cron，restore 永远手动）
 *  - 公开方法捕获错误返回结构化 result，避免 IPC 抛错栈泄露内部路径
 *  - 每个公开方法都受 `isRunning` 互斥锁保护，禁止并发触发同步
 *
 * @author zhi.qu
 * @date 2026-05-09
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type Database from 'better-sqlite3'

import { generateBackupFilename } from '@soul/core'

import {
  WEBDAV_PASSWORD_SETTING_KEY,
  decryptPassword,
  encryptPassword,
  getStorageBackendDisplay,
  isEncryptionAvailable,
} from './credential-store'
import {
  buildSnapshot,
  extractSnapshot,
  SnapshotTooLargeError,
} from './snapshot-builder'
import { WebDavClient, type WebDavCredentials, type WebDavLogger } from './webdav-client'

import type { SyncHistoryStore } from '../db-sync-history'

// ─── 公共类型 ────────────────────────────────────────────────────────────────

/** 自动同步间隔档位（与 INTERVAL_TO_CRON 一一对应） */
export type WebDavSyncInterval = 'off' | 'hourly' | 'every-6-hours' | 'daily'

/** 设置面板用的同步配置（不返回密码明文，仅 hasPassword 标记） */
export interface WebDavSyncConfig {
  enabled: boolean
  endpoint: string
  username: string
  basePath: string
  ignoreTlsErrors: boolean
  autoInterval: WebDavSyncInterval
  /** 远端保留份数，clamp 到 [1, 30]，默认 7 */
  retentionCount: number
  /** UI 用：是否已存有效密码 */
  hasPassword: boolean
}

/** 状态面板用的运行态信息 */
export interface WebDavSyncStatus {
  inProgress: boolean
  /** 最后一次完成的同步时间（unix ms），未发生过则 null */
  lastSyncAt: number | null
  lastSyncStatus: 'success' | 'failed' | null
  lastSyncDirection: 'backup' | 'restore' | null
  lastSyncError: string | null
  /** 当前设备的稳定 UUID */
  deviceId: string
  /** safeStorage 后端信息（UI 用于提示 Linux basic_text 警告） */
  storageBackend: string
  storageBackendSecure: boolean
  storageBackendHint: string
}

/** backupNow 返回值（错误不抛，统一以 ok=false 返回） */
export interface BackupNowResult {
  ok: boolean
  filename?: string
  totalBytes?: number
  durationMs?: number
  error?: string
}

/** restoreFrom 返回值（错误不抛，统一以 ok=false 返回） */
export interface RestoreFromResult {
  ok: boolean
  filename: string
  durationMs?: number
  error?: string
  /** 兜底备份位置，UI 可显示给用户 */
  preRestoreLocalPath?: string
}

/** applyExtractedSnapshot 内部：单个目录的暂存句柄（成功 commit / 失败 rollback） */
interface StagedDir {
  /** 失败回滚：删除已应用目录，改名还原本地原目录 */
  rollback(): Promise<void>
  /** 成功提交：删除 .restore-bak 暂存 */
  commit(): Promise<void>
}

/** 远端备份条目（IPC 直接透传给 UI） */
export interface RemoteBackupItem {
  filename: string
  size: number
  /** ISO 字符串；webdav 5.x lastmod 通常是 RFC1123，原样返回 */
  lastModified: string
}

/** setConfig 入参；password 是可选明文密码，传入即更新加密后的密文，传 null 清空 */
export interface SetConfigInput {
  enabled?: boolean
  endpoint?: string
  username?: string
  basePath?: string
  ignoreTlsErrors?: boolean
  autoInterval?: WebDavSyncInterval
  retentionCount?: number
  /** 明文密码；undefined 表示不修改，'' 或 null 表示清空 */
  password?: string | null
}

/** testConnection 可选覆盖参数；不填则用当前持久化配置 */
export interface TestConnectionInput {
  endpoint?: string
  username?: string
  password?: string
  basePath?: string
  ignoreTlsErrors?: boolean
}

/** 注入式 logger，便于单测替身（与 WebDavLogger / SnapshotLogger 同款风格） */
export interface SyncManagerLogger {
  info(msg: string, meta?: Record<string, unknown>): void
  warn(msg: string, err?: Error): void
  error(msg: string, err?: Error): void
}

/**
 * cron-scheduler 子集接口：本管理器只需要这 3 个方法，
 * 显式声明可让单测注入 fake，避免拉满 CronScheduler 的 BrowserWindow 依赖。
 */
export interface SyncManagerCronScheduler {
  scheduleCron(
    taskId: string,
    cronExpr: string,
    timezone: string,
    callback: () => Promise<void>,
  ): void
  cancelCron(taskId: string): void
  hasCronTask(taskId: string): boolean
}

/** SyncManager 构造依赖 */
export interface SyncManagerDeps {
  db: Database.Database
  syncHistoryStore: SyncHistoryStore
  cronScheduler: SyncManagerCronScheduler
  logger: SyncManagerLogger
  /** Soul app version（来自 app.getVersion()） */
  appVersion: string
  /** Electron app.getPath('userData') */
  userDataPath: string
  /** 分身根目录 */
  avatarsRoot: string
  /** shared 目录（缺失则跳过该子树） */
  sharedRoot: string
  /** 会话 jsonl 根目录 */
  conversationsRoot: string
  /** 当前 SQLite schema 版本 */
  dbSchemaVersion: number
  /** 注入：调用 DatabaseManager.backup(destPath) 生成 SQLite 静态快照 */
  runDbBackup: (dest: string) => Promise<void>
  /** 注入：恢复完成后让主进程 relaunch */
  relaunchApp: () => void
  /** 可选：自定义友好设备名（UI 用，默认 os.hostname()） */
  deviceName?: string
}

// ─── 内部常量 ────────────────────────────────────────────────────────────────

const SETTING_KEYS = {
  enabled: 'webdav_enabled',
  endpoint: 'webdav_endpoint',
  username: 'webdav_username',
  basePath: 'webdav_base_path',
  ignoreTlsErrors: 'webdav_ignore_tls_errors',
  autoInterval: 'webdav_auto_interval',
  retentionCount: 'webdav_retention_count',
  lastSyncAt: 'webdav_last_sync_at',
  lastSyncStatus: 'webdav_last_sync_status',
  lastSyncDirection: 'webdav_last_sync_direction',
  lastSyncError: 'webdav_last_sync_error',
  deviceId: 'device_id',
  password: WEBDAV_PASSWORD_SETTING_KEY,
} as const

const DEFAULT_CONFIG: Omit<WebDavSyncConfig, 'hasPassword'> = {
  enabled: false,
  endpoint: '',
  username: '',
  basePath: '/soul-backup/',
  ignoreTlsErrors: false,
  autoInterval: 'off',
  retentionCount: 7,
}

/** 间隔档位 → cron 表达式（精度到分钟，时区固定 UTC 防跨时区漂移） */
const INTERVAL_TO_CRON: Record<Exclude<WebDavSyncInterval, 'off'>, string> = {
  hourly: '0 * * * *',
  'every-6-hours': '0 */6 * * *',
  daily: '0 9 * * *',
}

/** cron-scheduler 中本管理器固定的 taskId（与 #11 schedules 命名空间隔离） */
const CRON_TASK_ID = 'webdav-sync'

/** 备份文件名白名单（IPC 接收 filename 时校验，防注入） */
const BACKUP_FILENAME_PATTERN = /^soul-backup-.*\.zip$/

/** 任意 settings value 长度上限，避免极端值塞满 SQLite 单行 */
const MAX_SETTING_VALUE_LENGTH = 4096

// ─── SyncManager ─────────────────────────────────────────────────────────────

export class SyncManager {
  private readonly db: Database.Database
  private readonly syncHistoryStore: SyncHistoryStore
  private readonly cronScheduler: SyncManagerCronScheduler
  private readonly logger: SyncManagerLogger
  private readonly appVersion: string
  private readonly userDataPath: string
  private readonly avatarsRoot: string
  private readonly sharedRoot: string
  private readonly conversationsRoot: string
  private readonly dbSchemaVersion: number
  private readonly runDbBackup: (dest: string) => Promise<void>
  private readonly relaunchApp: () => void
  private readonly deviceName: string

  /** 同一时刻只允许一个 backup/restore 任务运行 */
  private isRunning = false

  constructor(deps: SyncManagerDeps) {
    this.db = deps.db
    this.syncHistoryStore = deps.syncHistoryStore
    this.cronScheduler = deps.cronScheduler
    this.logger = deps.logger
    this.appVersion = deps.appVersion
    this.userDataPath = deps.userDataPath
    this.avatarsRoot = deps.avatarsRoot
    this.sharedRoot = deps.sharedRoot
    this.conversationsRoot = deps.conversationsRoot
    this.dbSchemaVersion = deps.dbSchemaVersion
    this.runDbBackup = deps.runDbBackup
    this.relaunchApp = deps.relaunchApp
    this.deviceName = deps.deviceName ?? safeHostname()
  }

  // ─── 配置读写 ──────────────────────────────────────────────────────────────

  /**
   * 读取当前 WebDAV 同步配置。
   *
   * - 不返回密码明文，仅返回 hasPassword 标志
   * - 缺失字段会回退到 DEFAULT_CONFIG
   */
  async getConfig(): Promise<WebDavSyncConfig> {
    const cfg = this.readConfig()
    const hasPassword = this.readSetting(SETTING_KEYS.password) !== null
    return { ...cfg, hasPassword }
  }

  /**
   * 部分更新 WebDAV 同步配置。
   *
   * - password === undefined：保持原值
   * - password === '' 或 null：清空密码
   * - password 非空：用 credential-store 加密后写入
   *
   * 写入完成后由调用方决定是否调 registerAutoInterval()（main.ts 在 IPC 层包装时已统一调）。
   */
  async setConfig(input: SetConfigInput): Promise<WebDavSyncConfig> {
    if (input.enabled !== undefined) {
      this.writeSetting(SETTING_KEYS.enabled, input.enabled ? 'true' : 'false')
    }
    if (input.endpoint !== undefined) {
      this.writeSetting(SETTING_KEYS.endpoint, normalizeEndpoint(input.endpoint))
    }
    if (input.username !== undefined) {
      this.writeSetting(SETTING_KEYS.username, sanitizeShortString(input.username))
    }
    if (input.basePath !== undefined) {
      this.writeSetting(SETTING_KEYS.basePath, normalizeBasePath(input.basePath))
    }
    if (input.ignoreTlsErrors !== undefined) {
      this.writeSetting(SETTING_KEYS.ignoreTlsErrors, input.ignoreTlsErrors ? 'true' : 'false')
    }
    if (input.autoInterval !== undefined) {
      this.writeSetting(SETTING_KEYS.autoInterval, normalizeAutoInterval(input.autoInterval))
    }
    if (input.retentionCount !== undefined) {
      this.writeSetting(SETTING_KEYS.retentionCount, String(clampRetention(input.retentionCount)))
    }
    if (input.password !== undefined) {
      if (input.password === null || input.password === '') {
        this.deleteSetting(SETTING_KEYS.password)
      } else {
        if (!isEncryptionAvailable()) {
          throw new Error('safeStorage 加密不可用，无法保存 WebDAV 密码')
        }
        const cipher = encryptPassword(input.password)
        if (cipher === '') {
          this.deleteSetting(SETTING_KEYS.password)
        } else {
          this.writeSetting(SETTING_KEYS.password, cipher)
        }
      }
    }

    return this.getConfig()
  }

  /** 清空持久化的 WebDAV 凭据（不影响其他 webdav_* 配置项） */
  async clearCredentials(): Promise<void> {
    this.deleteSetting(SETTING_KEYS.password)
    this.logger.info('webdav credentials cleared')
  }

  /**
   * 测试 WebDAV 连接是否可用。
   *
   * 不修改任何持久化状态；input 为空时使用当前持久化配置。
   * 任何错误都不抛，统一以 { ok: false, reason } 返回，避免 IPC 抛错。
   */
  async testConnection(input?: TestConnectionInput): Promise<{ ok: boolean; reason?: string }> {
    try {
      const creds = this.resolveCredentials(input)
      const client = new WebDavClient(creds, this.toWebDavLogger())
      const result = await client.testConnection()
      if (result.ok) return { ok: true }
      return { ok: false, reason: result.reason }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      this.logger.warn('testConnection failed', err instanceof Error ? err : undefined)
      return { ok: false, reason }
    }
  }

  // ─── 备份 / 恢复 / 列表 ────────────────────────────────────────────────────

  /**
   * 立即执行一次备份。
   *
   * 流程：
   *   1. 读 config + 解密密码（失败立即返回）
   *   2. record sync_history 一条 in_progress
   *   3. buildSnapshot → tmp 目录
   *   4. WebDavClient.connect → ensureBasePath → putBackup
   *   5. retention 维护：listBackups 后按 lastModified 倒序保留 retentionCount 条
   *   6. update sync_history 为 success + 写 last_sync_* settings
   *   7. 删除 tmp 目录；任何错误都改 sync_history 为 failed 并返回 ok=false
   */
  async backupNow(): Promise<BackupNowResult> {
    if (this.isRunning) {
      throw new Error('sync_already_running')
    }
    this.isRunning = true
    const startedAt = Date.now()
    let historyId: number | null = null
    let tmpDir: string | null = null

    try {
      const creds = this.resolveCredentials()
      const deviceId = this.getOrCreateDeviceId()
      const filename = generateBackupFilename(deviceId, new Date())

      const historyRow = this.syncHistoryStore.record({
        direction: 'backup',
        status: 'in_progress',
        remote_filename: filename,
        created_at: startedAt,
      })
      historyId = historyRow.id

      tmpDir = await fs.promises.mkdtemp(path.join(this.userDataPath, 'sync-tmp-'))
      const zipPath = path.join(tmpDir, filename)

      this.logger.info('backupNow: building snapshot', {
        zipPath,
        avatarsRoot: this.avatarsRoot,
        sharedRoot: this.sharedRoot,
      })

      const buildResult = await buildSnapshot({
        outputZipPath: zipPath,
        avatarsRoot: this.avatarsRoot,
        sharedRoot: this.sharedRoot,
        conversationsRoot: this.conversationsRoot,
        deviceId,
        deviceName: this.deviceName,
        appVersion: this.appVersion,
        dbSchemaVersion: this.dbSchemaVersion,
        runDbBackup: this.runDbBackup,
        logger: this.toSnapshotLogger(),
      })

      // 上传：将整个 zip 一次性读入再 putBackup（webdav 5.x putFileContents 接 Buffer）
      const buffer = await fs.promises.readFile(zipPath)
      const client = new WebDavClient(creds, this.toWebDavLogger())
      await client.ensureBasePath()
      await client.putBackup(filename, buffer, buffer.byteLength)

      // 远端 retention 维护（保留最近 N 条）
      await this.pruneRemoteBackups(client, clampRetention(this.readConfig().retentionCount))

      const durationMs = Date.now() - startedAt
      this.syncHistoryStore.update(historyId, {
        status: 'success',
        file_count: buildResult.manifest.entries.length,
        total_bytes: buildResult.zipBytes,
        duration_ms: durationMs,
        error_message: null,
      })
      this.persistLastSync('backup', 'success', startedAt + durationMs, null)

      this.logger.info('backupNow: success', {
        filename,
        bytes: buildResult.zipBytes,
        durationMs,
      })

      return {
        ok: true,
        filename,
        totalBytes: buildResult.zipBytes,
        durationMs,
      }
    } catch (err) {
      const durationMs = Date.now() - startedAt
      const errorMessage = describeError(err)
      this.logger.error(
        'backupNow failed',
        err instanceof Error ? err : new Error(String(err)),
      )
      if (historyId !== null) {
        this.syncHistoryStore.update(historyId, {
          status: 'failed',
          duration_ms: durationMs,
          error_message: errorMessage,
        })
      }
      this.persistLastSync('backup', 'failed', startedAt + durationMs, errorMessage)
      return { ok: false, error: errorMessage, durationMs }
    } finally {
      if (tmpDir) {
        await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch((e: unknown) => {
          this.logger.warn(
            `backupNow: tmpDir cleanup failed: ${tmpDir}`,
            e instanceof Error ? e : new Error(String(e)),
          )
        })
      }
      this.isRunning = false
    }
  }

  /**
   * 列出远端可用备份（按 lastModified 倒序，最新在前）。
   *
   * 任何错误都抛出由调用方决定如何展示（典型场景：UI 弹错提示）。
   */
  async listRemoteBackups(): Promise<RemoteBackupItem[]> {
    const creds = this.resolveCredentials()
    const client = new WebDavClient(creds, this.toWebDavLogger())
    await client.ensureBasePath()
    const items = await client.listBackups()
    items.sort((a, b) => compareLastModifiedDesc(a.lastModified, b.lastModified))
    return items.map((it) => ({
      filename: it.filename,
      size: it.size,
      lastModified: it.lastModified,
    }))
  }

  /**
   * 从远端备份恢复到本地。
   *
   * 流程（单步实现，main.ts 在 IPC 层拿到 ok=true 再 relaunch）：
   *   1. 校验 filename 合法（只允许 soul-backup-*.zip）
   *   2. 读 config + 解密密码
   *   3. record sync_history 一条 restore in_progress
   *   4. WebDavClient.getBackup(filename) → tmp 目录
   *   5. 预先做本地兜底备份（buildSnapshot 到 userData/sync-pre-restore/<ts>/）
   *      - 失败仅 warn，不阻塞恢复主链路
   *   6. extractSnapshot → tmp/extracted/
   *   7. 应用解压结果：先关 db 由 main.ts 在 IPC 层做（这里假设调用方已调用过）
   *      - 复制 snapshot/avatars / shared / conversations
   *      - 替换 SQLite 文件
   *   8. update sync_history 为 success + 写 last_sync_*
   *   9. relaunchApp() —— 注释：MVP 不在此处真正调用 relaunch，由 main.ts IPC 层主导
   *
   * 注意：本方法 **不会** 关闭 DB 与子服务，调用方（main.ts IPC 层）必须在拿到 ok=true 之后
   * 立刻 app.relaunch + app.exit；下次启动会用替换后的 DB 文件重新初始化。
   */
  async restoreFrom(filename: string): Promise<RestoreFromResult> {
    if (!isSafeBackupFilename(filename)) {
      throw new Error(`非法备份文件名: ${filename}`)
    }
    if (this.isRunning) {
      throw new Error('sync_already_running')
    }
    this.isRunning = true
    const startedAt = Date.now()
    let historyId: number | null = null
    let tmpDir: string | null = null
    let preRestoreLocalPath: string | undefined

    try {
      const creds = this.resolveCredentials()

      const historyRow = this.syncHistoryStore.record({
        direction: 'restore',
        status: 'in_progress',
        remote_filename: filename,
        created_at: startedAt,
      })
      historyId = historyRow.id

      tmpDir = await fs.promises.mkdtemp(path.join(this.userDataPath, 'sync-tmp-'))

      const client = new WebDavClient(creds, this.toWebDavLogger())
      this.logger.info('restoreFrom: downloading', { filename })
      const remoteBuffer = await client.getBackup(filename)
      const downloadedZip = path.join(tmpDir, filename)
      await fs.promises.writeFile(downloadedZip, remoteBuffer)

      // 兜底备份：恢复前先把当前数据完整打到 userData/sync-pre-restore/<timestamp>/
      preRestoreLocalPath = await this.buildPreRestoreBackup(historyId).catch((e: unknown) => {
        this.logger.warn(
          'restoreFrom: pre-restore backup failed (continuing)',
          e instanceof Error ? e : new Error(String(e)),
        )
        return undefined
      })

      // 解压 + 校验
      const extractedDir = path.join(tmpDir, 'extracted')
      const { manifest } = await extractSnapshot({
        zipPath: downloadedZip,
        outputDir: extractedDir,
        logger: this.toSnapshotLogger(),
      })

      // 应用解压结果到本地
      await this.applyExtractedSnapshot(extractedDir)

      const durationMs = Date.now() - startedAt
      this.syncHistoryStore.update(historyId, {
        status: 'success',
        file_count: manifest.entries.length,
        total_bytes: manifest.totalBytes,
        duration_ms: durationMs,
        error_message: null,
      })
      this.persistLastSync('restore', 'success', startedAt + durationMs, null)

      this.logger.info('restoreFrom: success', {
        filename,
        durationMs,
        preRestoreLocalPath,
      })

      // MVP：不在本方法直接调用 relaunchApp，由 main.ts IPC 层在拿到 ok=true 后触发，
      // 这样上层可以先 ack 给 IPC 调用方再退出，避免渲染端拿不到响应。
      return {
        ok: true,
        filename,
        durationMs,
        preRestoreLocalPath,
      }
    } catch (err) {
      const durationMs = Date.now() - startedAt
      const errorMessage = describeError(err)
      this.logger.error(
        'restoreFrom failed',
        err instanceof Error ? err : new Error(String(err)),
      )
      if (historyId !== null) {
        this.syncHistoryStore.update(historyId, {
          status: 'failed',
          duration_ms: durationMs,
          error_message: errorMessage,
        })
      }
      this.persistLastSync('restore', 'failed', startedAt + durationMs, errorMessage)
      return {
        ok: false,
        filename,
        durationMs,
        error: errorMessage,
        preRestoreLocalPath,
      }
    } finally {
      if (tmpDir) {
        await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch((e: unknown) => {
          this.logger.warn(
            `restoreFrom: tmpDir cleanup failed: ${tmpDir}`,
            e instanceof Error ? e : new Error(String(e)),
          )
        })
      }
      this.isRunning = false
    }
  }

  /** 当前同步状态（设置面板顶部状态条用） */
  async getStatus(): Promise<WebDavSyncStatus> {
    const display = getStorageBackendDisplay()
    return {
      inProgress: this.isRunning,
      lastSyncAt: parseLong(this.readSetting(SETTING_KEYS.lastSyncAt)),
      lastSyncStatus: parseLastStatus(this.readSetting(SETTING_KEYS.lastSyncStatus)),
      lastSyncDirection: parseLastDirection(this.readSetting(SETTING_KEYS.lastSyncDirection)),
      lastSyncError: this.readSetting(SETTING_KEYS.lastSyncError),
      deviceId: this.getOrCreateDeviceId(),
      storageBackend: display.backend,
      storageBackendSecure: display.secure,
      storageBackendHint: display.hint,
    }
  }

  /**
   * 根据当前 config 注册 / 取消自动同步 cron 任务。
   *
   * 启动时与 setConfig 后都需要调用。enabled=false 或 autoInterval='off' 时取消任务。
   */
  async registerAutoInterval(): Promise<void> {
    this.cronScheduler.cancelCron(CRON_TASK_ID)
    const cfg = this.readConfig()
    if (!cfg.enabled || cfg.autoInterval === 'off') {
      this.logger.info('auto sync disabled')
      return
    }
    const expr = INTERVAL_TO_CRON[cfg.autoInterval]
    this.cronScheduler.scheduleCron(CRON_TASK_ID, expr, 'UTC', async () => {
      if (this.isRunning) {
        this.logger.warn('auto sync skipped: another sync already running')
        return
      }
      try {
        const result = await this.backupNow()
        if (!result.ok) {
          this.logger.warn(`auto sync failed: ${result.error ?? 'unknown'}`)
        } else {
          this.logger.info(`auto sync done: ${result.filename}`)
        }
      } catch (err) {
        this.logger.warn(
          'auto sync threw',
          err instanceof Error ? err : new Error(String(err)),
        )
      }
    })
    this.logger.info(`auto sync registered: interval=${cfg.autoInterval} cron='${expr}'`)
  }

  // ─── 内部辅助 ──────────────────────────────────────────────────────────────

  /**
   * 一次性读取所有配置字段；密码字段不在此返回（需要时另行解密）。
   */
  private readConfig(): Omit<WebDavSyncConfig, 'hasPassword'> {
    const enabledStr = this.readSetting(SETTING_KEYS.enabled)
    const ignoreTlsStr = this.readSetting(SETTING_KEYS.ignoreTlsErrors)
    const intervalStr = this.readSetting(SETTING_KEYS.autoInterval)
    const retentionStr = this.readSetting(SETTING_KEYS.retentionCount)

    return {
      enabled: enabledStr === 'true',
      endpoint: this.readSetting(SETTING_KEYS.endpoint) ?? DEFAULT_CONFIG.endpoint,
      username: this.readSetting(SETTING_KEYS.username) ?? DEFAULT_CONFIG.username,
      basePath: this.readSetting(SETTING_KEYS.basePath) ?? DEFAULT_CONFIG.basePath,
      ignoreTlsErrors: ignoreTlsStr === 'true',
      autoInterval: parseAutoInterval(intervalStr),
      retentionCount: parseRetention(retentionStr),
    }
  }

  /**
   * 解析最终用于 WebDavClient 的凭据；override 字段优先于持久化配置。
   *
   * password 优先级：override.password ?? 解密(settings) ?? ''
   * 解密失败抛错，由调用方决定是否清空 setting。
   */
  private resolveCredentials(override?: TestConnectionInput): WebDavCredentials {
    const cfg = this.readConfig()
    const endpoint = override?.endpoint !== undefined ? normalizeEndpoint(override.endpoint) : cfg.endpoint
    const username = override?.username !== undefined ? sanitizeShortString(override.username) : cfg.username
    const basePath = override?.basePath !== undefined ? normalizeBasePath(override.basePath) : cfg.basePath
    const ignoreTlsErrors =
      override?.ignoreTlsErrors !== undefined ? override.ignoreTlsErrors : cfg.ignoreTlsErrors

    let password: string
    if (override?.password !== undefined) {
      password = override.password
    } else {
      const cipher = this.readSetting(SETTING_KEYS.password)
      password = cipher !== null ? decryptPassword(cipher) : ''
    }

    if (!endpoint) throw new Error('WebDAV endpoint 未配置')
    if (!username) throw new Error('WebDAV username 未配置')
    if (!basePath) throw new Error('WebDAV basePath 未配置')

    return { endpoint, username, password, basePath, ignoreTlsErrors }
  }

  /**
   * 远端按 retention 阈值删除最旧的备份。
   *
   * 排序规则：lastModified 倒序保留前 retainCount 条；其余调用 deleteBackup 删除。
   * 单条删除失败仅 warn，不影响其他文件。
   */
  private async pruneRemoteBackups(client: WebDavClient, retainCount: number): Promise<void> {
    if (retainCount <= 0) return
    let items: Awaited<ReturnType<WebDavClient['listBackups']>>
    try {
      items = await client.listBackups()
    } catch (err) {
      this.logger.warn(
        'prune: listBackups failed (skipping retention this round)',
        err instanceof Error ? err : new Error(String(err)),
      )
      return
    }
    if (items.length <= retainCount) return
    items.sort((a, b) => compareLastModifiedDesc(a.lastModified, b.lastModified))
    const toDelete = items.slice(retainCount)
    for (const it of toDelete) {
      try {
        await client.deleteBackup(it.filename)
      } catch (err) {
        this.logger.warn(
          `prune: deleteBackup failed for ${it.filename}`,
          err instanceof Error ? err : new Error(String(err)),
        )
      }
    }
    this.logger.info(`prune: removed ${toDelete.length} old backups, kept ${retainCount}`)
  }

  /**
   * 恢复前的本地兜底备份。
   *
   * 落盘到 userData/sync-pre-restore/<historyId>-<timestamp>/local-pre-restore.zip
   *
   * 默认尝试构建；任何错误抛出，由调用方决定是否继续 restore。
   */
  private async buildPreRestoreBackup(historyId: number): Promise<string> {
    const ts = new Date().toISOString().replace(/[:.]/g, '-')
    const dir = path.join(this.userDataPath, 'sync-pre-restore', `${historyId}-${ts}`)
    await fs.promises.mkdir(dir, { recursive: true })
    const zipPath = path.join(dir, 'local-pre-restore.zip')

    const deviceId = this.getOrCreateDeviceId()
    try {
      await buildSnapshot({
        outputZipPath: zipPath,
        avatarsRoot: this.avatarsRoot,
        sharedRoot: this.sharedRoot,
        conversationsRoot: this.conversationsRoot,
        deviceId,
        deviceName: this.deviceName,
        appVersion: this.appVersion,
        dbSchemaVersion: this.dbSchemaVersion,
        runDbBackup: this.runDbBackup,
        logger: this.toSnapshotLogger(),
      })
      this.logger.info(`pre-restore backup created: ${zipPath}`)
      return zipPath
    } catch (err) {
      // 体积超限：无法生成兜底备份，但不应阻塞 restore 主链路。
      if (err instanceof SnapshotTooLargeError) {
        this.logger.warn(
          `pre-restore backup skipped (snapshot too large: ${err.actualBytes}/${err.maxBytes})`,
        )
        await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => undefined)
        throw err
      }
      throw err
    }
  }

  /**
   * 把 extractedDir/snapshot/* 应用到当前 userData。
   *
   * 注意：本函数 **不会** 关闭 DB 与运行中的服务，调用方必须先在 IPC 层 close 资源。
   *
   * 顺序刻意把 SQLite 替换放在最前（步骤 1）：DB 是唯一可能因主进程仍持有句柄而
   * 替换失败的资源（Windows 下尤甚）。先替换 DB，一旦失败就在「还没动任何不可逆
   * 删除」前抛错退出，避免出现「avatars 已被远端替换、DB 仍是旧的」的半恢复脏状态
   * ——即把原先的「半恢复数据丢失」收敛为「全有或全无」的干净失败。restoreFrom 的
   * catch 会保留 pre-restore 兜底备份，本地数据原样不动。
   *
   * （彻底让 Windows「DB 占用时也能恢复」需要先关闭 DB 或走启动期 staged swap，
   *  作为后续单独任务，不在本函数范围内。）
   * 步骤：
   *  1. 替换 SQLite 文件 dbPath ← snapshot/xiaodu-snapshot.db（最易失败，放最前）
   *  2. 替换 avatarsRoot ← snapshot/avatars/（不可逆 rm，必须在 DB 替换成功后才执行）
   *  3. 替换 sharedRoot   ← snapshot/shared/   （目标存在则保留，仅覆写新文件）
   *  4. 复制 snapshot/conversations/*.jsonl ← conversationsRoot
   *
   * 使用 fs.cp（recursive: true, force: true）；为了减少误删风险，
   * shared 目录采取「合并覆盖」而非「先删再写」。
   */
  private async applyExtractedSnapshot(extractedDir: string): Promise<void> {
    const snapshotRoot = path.join(extractedDir, 'snapshot')

    // 1. SQLite 文件替换（最前）：这是唯一可能因句柄占用而失败的步骤。
    //    一旦失败就在不可逆的 avatars rm 之前抛错退出，保证「全有或全无」。
    const snapshotDb = path.join(snapshotRoot, 'xiaodu-snapshot.db')
    if (!(await fileExists(snapshotDb))) {
      throw new Error('restore: snapshot/xiaodu-snapshot.db missing in zip')
    }
    const targetDb = path.join(this.userDataPath, 'xiaodu.db')
    // 先把目标文件移到 .restore-bak.<ts>，再 copy 新文件，最大限度避免半成品
    const bakPath = `${targetDb}.restore-bak.${Date.now()}`
    let oldDbBak: string | null = null
    if (await fileExists(targetDb)) {
      try {
        await fs.promises.rename(targetDb, bakPath)
      } catch (err) {
        // 主进程仍持有 db handle 时 rename 在 Windows 下会失败；改 copy
        this.logger.warn(
          `restore: rename old db failed, falling back to copy+unlink (${describeError(err)})`,
        )
        await fs.promises.copyFile(targetDb, bakPath)
      }
      oldDbBak = bakPath
    }

    // DB 覆盖 + 后续文件替换包在同一 try 内：DB 已切到远端快照后，只要 avatars/shared/
    // conversations 任一步失败，就把 DB 回滚到恢复前状态，避免「DB 已恢复、文件未完整恢复」
    // 的脏状态（下次启动会读到与磁盘文件不一致的库）。
    // 2-4. avatars / shared / conversations：每个目录先「改名暂存」再应用快照（stageDir）。
    //   任一步失败时把已应用目录逆序回滚、再回滚 DB，保证文件树「全有或全无」，消除
    //   「avatars 已替换、conversations 失败、DB 已回滚」这类半恢复脏状态。
    const staged: StagedDir[] = []
    try {
      // 覆盖目标 DB：句柄被占用时此处会抛错，此时 avatars 尚未被触碰 → 干净失败。
      await fs.promises.copyFile(snapshotDb, targetDb)
      this.logger.info(`restore: SQLite replaced (old kept at ${bakPath})`)

      // avatars：整目录替换（保证旧分身不残留）。shared/conversations：合并覆盖
      // （开发场景下通常包含未同步的本地资源，故保留本地后再叠加快照）。
      staged.push(
        await this.stageDir('avatars', path.join(snapshotRoot, 'avatars'), this.avatarsRoot, 'replace'),
      )
      staged.push(
        await this.stageDir('shared', path.join(snapshotRoot, 'shared'), this.sharedRoot, 'merge'),
      )
      staged.push(
        await this.stageDir(
          'conversations',
          path.join(snapshotRoot, 'conversations'),
          this.conversationsRoot,
          'merge',
        ),
      )

      // 文件树全部应用成功 → 提交（删除各 .restore-bak 暂存），best-effort。
      for (const s of staged) {
        await s.commit().catch((cmErr) => {
          this.logger.warn(
            'restore: staged backup cleanup failed',
            cmErr instanceof Error ? cmErr : new Error(String(cmErr)),
          )
        })
      }
    } catch (applyErr) {
      // 逆序回滚已应用的目录（best-effort，单个失败不阻断其余回滚）。
      for (const s of staged.reverse()) {
        await s.rollback().catch((rbErr) => {
          this.logger.error(
            'restore: file-tree rollback failed',
            rbErr instanceof Error ? rbErr : new Error(String(rbErr)),
          )
        })
      }
      // 回滚 DB：把旧库还原回 xiaodu.db（恢复前无库则删除新写入的库），best-effort。
      await this.rollbackRestoredDb(targetDb, oldDbBak).catch((rbErr) => {
        this.logger.error(
          'restore: DB rollback failed',
          rbErr instanceof Error ? rbErr : new Error(String(rbErr)),
        )
      })
      throw applyErr
    }
  }

  /**
   * 把一个快照目录「改名暂存 → 应用」，返回 commit/rollback 句柄，供 applyExtractedSnapshot
   * 做文件树级 all-or-nothing 替换。
   *
   * - 快照里没有该目录：保持本地不动（兼容旧行为），返回空操作句柄。
   * - mode='replace'（avatars）：本地整目录改名暂存后，仅写快照内容（旧内容不残留）。
   * - mode='merge'（shared/conversations）：本地改名暂存后先拷回本地原内容，再叠加快照覆盖，
   *   与旧「合并覆盖」语义一致，同时保证可回滚。
   *
   * 本方法自身具备原子性：应用过程中任一步失败会先把自己回滚干净再抛错，
   * 不会把已改名的本地目录遗留成 .restore-bak。
   */
  private async stageDir(
    label: string,
    snapshotDir: string,
    targetRoot: string,
    mode: 'replace' | 'merge',
  ): Promise<StagedDir> {
    if (!(await dirExists(snapshotDir))) {
      this.logger.warn(`restore: snapshot/${label}/ missing, keeping local ${label}/`)
      return { rollback: async () => undefined, commit: async () => undefined }
    }

    const bak = `${targetRoot}.restore-bak.${Date.now()}`
    const hadLocal = await dirExists(targetRoot)
    if (hadLocal) {
      await fs.promises.rename(targetRoot, bak)
    }

    try {
      await fs.promises.mkdir(targetRoot, { recursive: true })
      // merge：先把本地原内容拷回（保留未同步的本地资源），再用快照覆盖。
      if (mode === 'merge' && hadLocal) {
        await fs.promises.cp(bak, targetRoot, { recursive: true, force: true })
      }
      await fs.promises.cp(snapshotDir, targetRoot, { recursive: true, force: true })
    } catch (err) {
      // 本目录应用失败：先自我回滚再抛，避免遗留半拷贝目录与改名后的暂存。
      await fs.promises.rm(targetRoot, { recursive: true, force: true }).catch(() => undefined)
      if (hadLocal) await fs.promises.rename(bak, targetRoot).catch(() => undefined)
      throw err
    }

    this.logger.info(`restore: ${label} ${mode === 'replace' ? 'replaced' : 'merged'} from snapshot`)
    return {
      // 回滚：删除已应用目录；恢复前有本地目录则改名还原，恢复前本就没有（hadLocal=false）
      // 则停在「目录不存在」——这正是恢复前的原状，仍满足「全有或全无」。
      rollback: async () => {
        await fs.promises.rm(targetRoot, { recursive: true, force: true })
        if (hadLocal) await fs.promises.rename(bak, targetRoot)
      },
      commit: async () => {
        if (hadLocal) await fs.promises.rm(bak, { recursive: true, force: true })
      },
    }
  }

  /**
   * 恢复期 DB 回滚：把 oldDbBak 还原回 targetDb；恢复前本就无库（oldDbBak=null）时
   * 删除已写入的新库，回到「无本地库」原状。供 applyExtractedSnapshot 失败路径调用。
   */
  private async rollbackRestoredDb(targetDb: string, oldDbBak: string | null): Promise<void> {
    if (oldDbBak && (await fileExists(oldDbBak))) {
      await fs.promises.copyFile(oldDbBak, targetDb)
      this.logger.warn('restore: 后续步骤失败，已将 DB 回滚到恢复前状态')
    } else {
      await fs.promises.rm(targetDb, { force: true })
      this.logger.warn('restore: 后续步骤失败，已删除新写入的 DB（恢复前本地无库）')
    }
  }

  /** 写入或更新一条 setting；已存在则覆盖。 */
  private writeSetting(key: string, value: string): void {
    const truncated =
      value.length > MAX_SETTING_VALUE_LENGTH ? value.slice(0, MAX_SETTING_VALUE_LENGTH) : value
    this.db
      .prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
      .run(key, truncated)
  }

  /** 读取一条 setting，未配置返回 null。 */
  private readSetting(key: string): string | null {
    const row = this.db
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get(key) as { value?: string } | undefined
    if (!row || typeof row.value !== 'string') return null
    return row.value
  }

  /** 删除一条 setting。 */
  private deleteSetting(key: string): void {
    this.db.prepare('DELETE FROM settings WHERE key = ?').run(key)
  }

  /** 取或创建 device_id；首次访问时生成 UUIDv4 并写入 settings。 */
  private getOrCreateDeviceId(): string {
    const existing = this.readSetting(SETTING_KEYS.deviceId)
    if (existing && existing.length > 0) return existing
    const id = crypto.randomUUID()
    this.writeSetting(SETTING_KEYS.deviceId, id)
    this.logger.info(`device_id generated: ${id}`)
    return id
  }

  /** 持久化最后一次同步结果到 settings 表（用于状态面板与 cron 决策）。 */
  private persistLastSync(
    direction: 'backup' | 'restore',
    status: 'success' | 'failed',
    finishedAtMs: number,
    error: string | null,
  ): void {
    this.writeSetting(SETTING_KEYS.lastSyncAt, String(finishedAtMs))
    this.writeSetting(SETTING_KEYS.lastSyncStatus, status)
    this.writeSetting(SETTING_KEYS.lastSyncDirection, direction)
    if (error === null || error === '') {
      this.deleteSetting(SETTING_KEYS.lastSyncError)
    } else {
      this.writeSetting(SETTING_KEYS.lastSyncError, error.slice(0, MAX_SETTING_VALUE_LENGTH))
    }
  }

  /** 适配 SyncManagerLogger → WebDavLogger（webdav-client 只用 info / warn）。 */
  private toWebDavLogger(): WebDavLogger {
    return {
      info: (msg: string) => this.logger.info(msg),
      warn: (msg: string, err?: Error) => this.logger.warn(msg, err),
    }
  }

  /** 适配 SyncManagerLogger → SnapshotLogger（同样只用 info / warn）。 */
  private toSnapshotLogger(): { info(msg: string): void; warn(msg: string, err?: Error): void } {
    return {
      info: (msg: string) => this.logger.info(msg),
      warn: (msg: string, err?: Error) => this.logger.warn(msg, err),
    }
  }

  /**
   * 显式公开 relaunchApp 钩子：main.ts IPC 层在拿到 restoreFrom ok=true 后调用，
   * 以便 SyncManager 内部不直接耦合 Electron app。
   */
  triggerRelaunch(): void {
    try {
      this.relaunchApp()
    } catch (err) {
      this.logger.error(
        'triggerRelaunch failed',
        err instanceof Error ? err : new Error(String(err)),
      )
    }
  }
}

// ─── 模块级辅助函数 ──────────────────────────────────────────────────────────

/** 备份文件名严格白名单：必须形如 soul-backup-*.zip 且不含路径分隔符。 */
export function isSafeBackupFilename(name: string): boolean {
  if (typeof name !== 'string') return false
  if (name.length === 0 || name.length > 256) return false
  if (name.includes('/') || name.includes('\\')) return false
  return BACKUP_FILENAME_PATTERN.test(name)
}

/** 比较两条 lastModified（RFC1123 / ISO 通吃）：晚的排前面。 */
function compareLastModifiedDesc(a: string, b: string): number {
  const ta = Date.parse(a)
  const tb = Date.parse(b)
  if (Number.isNaN(ta) && Number.isNaN(tb)) return 0
  if (Number.isNaN(ta)) return 1
  if (Number.isNaN(tb)) return -1
  return tb - ta
}

/** 错误描述：尽量提取人类可读信息，避免泄露内部路径。 */
function describeError(err: unknown): string {
  if (err instanceof Error) {
    return err.message.slice(0, MAX_SETTING_VALUE_LENGTH)
  }
  return String(err).slice(0, MAX_SETTING_VALUE_LENGTH)
}

/** 文件存在 + 是普通文件 */
async function fileExists(p: string): Promise<boolean> {
  try {
    const stat = await fs.promises.stat(p)
    return stat.isFile()
  } catch {
    return false
  }
}

/** 目录存在 + 是目录 */
async function dirExists(p: string): Promise<boolean> {
  try {
    const stat = await fs.promises.stat(p)
    return stat.isDirectory()
  } catch {
    return false
  }
}

/** 用户输入端短字符串 sanitizer：截断到 256 字符，去掉换行。 */
function sanitizeShortString(s: string): string {
  return s.replace(/[\r\n\t]/g, ' ').trim().slice(0, 256)
}

/** endpoint 规范化：去尾部斜杠、限长度。 */
function normalizeEndpoint(s: string): string {
  const cleaned = sanitizeShortString(s)
  return cleaned.replace(/\/+$/, '')
}

/** basePath 规范化：保证以 / 开头，去末尾 /，根目录 → '/'. */
function normalizeBasePath(s: string): string {
  const cleaned = sanitizeShortString(s) || '/soul-backup'
  const withSlash = cleaned.startsWith('/') ? cleaned : `/${cleaned}`
  const trimmed = withSlash.replace(/\/+$/, '')
  return trimmed === '' ? '/' : trimmed
}

/** 容错解析 autoInterval；非法值回退到 'off'. */
function parseAutoInterval(raw: string | null | undefined): WebDavSyncInterval {
  if (raw === 'hourly' || raw === 'every-6-hours' || raw === 'daily' || raw === 'off') return raw
  return 'off'
}

/** 强校验 autoInterval；非法直接抛错（用于写入路径）。 */
function normalizeAutoInterval(raw: string): WebDavSyncInterval {
  if (raw === 'hourly' || raw === 'every-6-hours' || raw === 'daily' || raw === 'off') return raw
  throw new Error(`非法 autoInterval: ${raw}`)
}

/** clamp retention 到 [1, 30]，非数字回退 7 */
function clampRetention(n: unknown): number {
  if (typeof n !== 'number' || !Number.isFinite(n)) return DEFAULT_CONFIG.retentionCount
  const v = Math.floor(n)
  if (v < 1) return 1
  if (v > 30) return 30
  return v
}

/** 解析持久化的 retention（字符串 → 数字 + clamp） */
function parseRetention(raw: string | null | undefined): number {
  if (raw === null || raw === undefined) return DEFAULT_CONFIG.retentionCount
  const v = parseInt(raw, 10)
  if (!Number.isFinite(v)) return DEFAULT_CONFIG.retentionCount
  return clampRetention(v)
}

/** 解析持久化的时间戳；非法返回 null */
function parseLong(raw: string | null): number | null {
  if (raw === null) return null
  const v = parseInt(raw, 10)
  return Number.isFinite(v) ? v : null
}

/** 容错解析 lastSyncStatus */
function parseLastStatus(raw: string | null): 'success' | 'failed' | null {
  if (raw === 'success' || raw === 'failed') return raw
  return null
}

/** 容错解析 lastSyncDirection */
function parseLastDirection(raw: string | null): 'backup' | 'restore' | null {
  if (raw === 'backup' || raw === 'restore') return raw
  return null
}

/** os.hostname() 兜底：极端环境拿不到主机名时返回 'unknown-device' */
function safeHostname(): string {
  try {
    const name = os.hostname()
    return name && name.length > 0 ? name.slice(0, 64) : 'unknown-device'
  } catch {
    return 'unknown-device'
  }
}
