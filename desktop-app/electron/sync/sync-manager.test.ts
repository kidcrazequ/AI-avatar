/**
 * Tests for SyncManager (#16 WebDAV cross-device sync · 子任务 6) — full backup orchestration with mocks.
 *
 * 验证点（共 12 条用例）：
 *   1. getConfig 返回默认值（enabled=false / autoInterval=off / retentionCount=7 / hasPassword=false）
 *   2. setConfig + getConfig 持久化往返；password 不返回明文（hasPassword=true）
 *   3. setConfig 不传 password 时保留原密码（仍能 backupNow）
 *   4. clearCredentials 清除 password（hasPassword=false）
 *   5. testConnection 透传 WebDavClient.testConnection 结果（mock 返回 ok=false → SyncManager 同步返回）
 *   6. backupNow 全链路成功：filename / totalBytes / sync_history success 记录 / settings.last_sync_*
 *   7. backupNow 失败回写 sync_history failed；返回 ok=false + error
 *   8. backupNow 并发互斥：第二次抛 sync_already_running
 *   9. registerAutoInterval 'off' → cancelCron 调用、scheduleCron 不调用
 *  10. registerAutoInterval 'daily' → scheduleCron 调用一次 + cron='0 9 * * *' + tz='UTC'
 *  11. restoreFrom 拒绝非法 filename（不含 soul-backup- 前缀）
 *  12. deviceId 持久化：多次 getStatus 返回同一 deviceId
 *
 * 设计：
 *   - mock 注入路径
 *     1) electron.safeStorage：require.cache 注入 fake（与 credential-store.test.ts 同款）
 *     2) ./webdav-client：require.cache 注入 fake class，行为通过 fakeWebDavState 切换
 *   - 真 better-sqlite3 + in-memory db；ABI 不兼容时优雅 skip 整个 suite
 *   - cronScheduler / runDbBackup / relaunchApp 用闭包 fake
 *
 * @author zhi.qu
 * @date 2026-05-09
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

// ─── 1) 注入 electron.safeStorage stub（必须在 require('./credential-store') 之前） ─

interface MockSafeStorageState {
  available: boolean
  backend: string
}
const mockSafeStorage: MockSafeStorageState = {
  available: true,
  backend: 'mock-keychain',
}

const electronStubExports = {
  safeStorage: {
    isEncryptionAvailable: (): boolean => mockSafeStorage.available,
    encryptString: (plain: string): Buffer => Buffer.from(`ENC:${plain}`, 'utf-8'),
    decryptString: (cipher: Buffer): string => {
      const s = cipher.toString('utf-8')
      if (!s.startsWith('ENC:')) throw new Error('mock decrypt: bad cipher prefix')
      return s.slice(4)
    },
    getSelectedStorageBackend: (): string => mockSafeStorage.backend,
  },
}

const electronResolvedId = (() => {
  try {
    return require.resolve('electron')
  } catch {
    return 'electron'
  }
})()
require.cache[electronResolvedId] = {
  id: electronResolvedId,
  filename: electronResolvedId,
  loaded: true,
  exports: electronStubExports,
  parent: null,
  children: [],
  paths: [],
} as unknown as NodeJS.Module

// ─── 2) 注入 ./webdav-client stub（必须在 require('./sync-manager') 之前） ───────

interface FakeWebDavBehavior {
  testConnection: () => Promise<{ ok: true } | { ok: false; reason: string }>
  ensureBasePath: () => Promise<void>
  putBackup: (filename: string, data: Buffer, totalBytes: number) => Promise<void>
  listBackups: () => Promise<Array<{ filename: string; size: number; lastModified: string }>>
  getBackup: (filename: string) => Promise<Buffer>
  deleteBackup: (filename: string) => Promise<void>
}

interface FakeWebDavCallLog {
  putBackup: Array<{ filename: string; bytes: number }>
  deleteBackup: string[]
  ensureBasePath: number
  testConnection: number
  listBackups: number
  getBackup: string[]
  constructed: Array<{ endpoint: string; username: string; basePath: string }>
}

let fakeWebDavBehavior: FakeWebDavBehavior = {
  testConnection: async () => ({ ok: true as const }),
  ensureBasePath: async () => undefined,
  putBackup: async () => undefined,
  listBackups: async () => [],
  getBackup: async () => Buffer.from(''),
  deleteBackup: async () => undefined,
}
let fakeWebDavCallLog: FakeWebDavCallLog = {
  putBackup: [],
  deleteBackup: [],
  ensureBasePath: 0,
  testConnection: 0,
  listBackups: 0,
  getBackup: [],
  constructed: [],
}

function resetFakeWebDav(behavior?: Partial<FakeWebDavBehavior>): void {
  fakeWebDavBehavior = {
    testConnection: async () => ({ ok: true as const }),
    ensureBasePath: async () => undefined,
    putBackup: async () => undefined,
    listBackups: async () => [],
    getBackup: async () => Buffer.from(''),
    deleteBackup: async () => undefined,
    ...behavior,
  }
  fakeWebDavCallLog = {
    putBackup: [],
    deleteBackup: [],
    ensureBasePath: 0,
    testConnection: 0,
    listBackups: 0,
    getBackup: [],
    constructed: [],
  }
}

class FakeWebDavClient {
  constructor(creds: { endpoint: string; username: string; basePath: string }) {
    fakeWebDavCallLog.constructed.push({
      endpoint: creds.endpoint,
      username: creds.username,
      basePath: creds.basePath,
    })
  }
  async testConnection(): Promise<{ ok: true } | { ok: false; reason: string }> {
    fakeWebDavCallLog.testConnection += 1
    return fakeWebDavBehavior.testConnection()
  }
  async ensureBasePath(): Promise<void> {
    fakeWebDavCallLog.ensureBasePath += 1
    await fakeWebDavBehavior.ensureBasePath()
  }
  async putBackup(filename: string, data: Buffer, totalBytes: number): Promise<void> {
    fakeWebDavCallLog.putBackup.push({ filename, bytes: totalBytes })
    await fakeWebDavBehavior.putBackup(filename, data, totalBytes)
  }
  async listBackups(): Promise<Array<{ filename: string; size: number; lastModified: string }>> {
    fakeWebDavCallLog.listBackups += 1
    return fakeWebDavBehavior.listBackups()
  }
  async getBackup(filename: string): Promise<Buffer> {
    fakeWebDavCallLog.getBackup.push(filename)
    return fakeWebDavBehavior.getBackup(filename)
  }
  async deleteBackup(filename: string): Promise<void> {
    fakeWebDavCallLog.deleteBackup.push(filename)
    await fakeWebDavBehavior.deleteBackup(filename)
  }
}

const fakeWebDavExports = {
  WebDavClient: FakeWebDavClient,
  MAX_BACKUP_BYTES: 500 * 1024 * 1024,
}

const webdavClientResolvedId = (() => {
  try {
    return require.resolve('./webdav-client')
  } catch {
    return path.join(__dirname, 'webdav-client')
  }
})()
require.cache[webdavClientResolvedId] = {
  id: webdavClientResolvedId,
  filename: webdavClientResolvedId,
  loaded: true,
  exports: fakeWebDavExports,
  parent: null,
  children: [],
  paths: [],
} as unknown as NodeJS.Module

// ─── 3) better-sqlite3 ABI 探测 + 真模块加载 ─────────────────────────────────

type DatabaseModule = typeof import('better-sqlite3')
type DatabaseInstance = ReturnType<DatabaseModule>

let DatabaseCtor: DatabaseModule | null = null
let SyncManagerMod: typeof import('./sync-manager') | null = null
let SyncHistoryStoreMod: typeof import('../db-sync-history') | null = null
let loadError: string | null = null
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  DatabaseCtor = require('better-sqlite3') as DatabaseModule
  const probe = new DatabaseCtor(':memory:')
  probe.close()
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  SyncHistoryStoreMod = require('../db-sync-history') as typeof import('../db-sync-history')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  SyncManagerMod = require('./sync-manager') as typeof import('./sync-manager')
} catch (err) {
  loadError = err instanceof Error ? err.message : String(err)
}
const skipReason = loadError
  ? `跳过：本测试需要 better-sqlite3 原生绑定与当前 Node ABI 匹配（${loadError.split('\n')[0]}）`
  : null

// ─── 4) 测试夹具 ─────────────────────────────────────────────────────────────

interface CapturedLog {
  info: string[]
  warn: string[]
  error: string[]
}

interface FakeCronCall {
  taskId: string
  cronExpr: string
  timezone: string
  callback: () => Promise<void>
}

interface MakeManagerOpts {
  /** 预先种入 settings 的字段 */
  presetSettings?: Record<string, string>
  /** 自定义 deviceName（默认 macbook-test） */
  deviceName?: string
}

function setupSchema(db: DatabaseInstance): void {
  db.pragma('foreign_keys = ON')
  // 与 createBaseSchema 中 settings + sync_history 表保持一致
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sync_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      direction TEXT NOT NULL,
      status TEXT NOT NULL,
      file_count INTEGER NOT NULL DEFAULT 0,
      total_bytes INTEGER NOT NULL DEFAULT 0,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      remote_filename TEXT,
      error_message TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sync_history_created_at ON sync_history(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_sync_history_direction_status ON sync_history(direction, status);
  `)
}

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `soul-syncmgr-test-${prefix}-`))
}

interface ManagerHarness {
  manager: import('./sync-manager').SyncManager
  db: DatabaseInstance
  history: import('../db-sync-history').SyncHistoryStore
  captured: CapturedLog
  cronCalls: FakeCronCall[]
  cronCancels: string[]
  workDir: string
  cleanup: () => void
  /** 写一份小 db 占位文件（runDbBackup 依赖） */
  runDbBackupCalls: number
  relaunchCalls: { count: number }
}

function makeManager(opts?: MakeManagerOpts): ManagerHarness {
  if (!DatabaseCtor || !SyncManagerMod || !SyncHistoryStoreMod) {
    throw new Error('依赖未加载（应已 skip）')
  }
  const db = new DatabaseCtor(':memory:')
  setupSchema(db)
  if (opts?.presetSettings) {
    const stmt = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
    for (const [k, v] of Object.entries(opts.presetSettings)) stmt.run(k, v)
  }

  const history = new SyncHistoryStoreMod.SyncHistoryStore(db)

  const captured: CapturedLog = { info: [], warn: [], error: [] }
  const logger = {
    info: (msg: string) => captured.info.push(msg),
    warn: (msg: string) => captured.warn.push(msg),
    error: (msg: string) => captured.error.push(msg),
  }

  const cronCalls: FakeCronCall[] = []
  const cronCancels: string[] = []
  const cronScheduler = {
    scheduleCron: (
      taskId: string,
      cronExpr: string,
      timezone: string,
      callback: () => Promise<void>,
    ): void => {
      cronCalls.push({ taskId, cronExpr, timezone, callback })
    },
    cancelCron: (taskId: string): void => {
      cronCancels.push(taskId)
    },
    hasCronTask: (taskId: string): boolean => cronCalls.some((c) => c.taskId === taskId),
  }

  const workDir = makeTempDir('mgr')
  const avatarsRoot = path.join(workDir, 'avatars')
  const sharedRoot = path.join(workDir, 'shared')
  const conversationsRoot = path.join(workDir, 'conversations')
  // 至少放一个文件，让 buildSnapshot 能成功收集
  fs.mkdirSync(avatarsRoot, { recursive: true })
  fs.writeFileSync(path.join(avatarsRoot, 'a.txt'), Buffer.from('A'))

  const runDbBackupCounter = { count: 0 }
  const relaunchCounter = { count: 0 }

  const manager = new SyncManagerMod.SyncManager({
    db,
    syncHistoryStore: history,
    cronScheduler,
    logger,
    appVersion: '0.1.0',
    userDataPath: workDir,
    avatarsRoot,
    sharedRoot,
    conversationsRoot,
    dbSchemaVersion: 12,
    runDbBackup: async (dest: string) => {
      runDbBackupCounter.count += 1
      await fs.promises.writeFile(dest, Buffer.alloc(64, 0x44))
    },
    relaunchApp: () => {
      relaunchCounter.count += 1
    },
    deviceName: opts?.deviceName ?? 'macbook-test',
  })

  return {
    manager,
    db,
    history,
    captured,
    cronCalls,
    cronCancels,
    workDir,
    cleanup: () => {
      try {
        db.close()
      } catch (closeErr) {
        // 测试结束时 db 可能已关；记一下避免空 catch 触犯 no-restricted-syntax 规则
        void closeErr
      }
      fs.rmSync(workDir, { recursive: true, force: true })
    },
    get runDbBackupCalls(): number {
      return runDbBackupCounter.count
    },
    relaunchCalls: relaunchCounter,
  }
}

// ─── 用例 ────────────────────────────────────────────────────────────────────

test('sync-manager: getConfig 默认值（未配置时）', { skip: skipReason ?? false }, async () => {
  resetFakeWebDav()
  const h = makeManager()
  try {
    const cfg = await h.manager.getConfig()
    assert.equal(cfg.enabled, false)
    assert.equal(cfg.endpoint, '')
    assert.equal(cfg.username, '')
    assert.equal(cfg.basePath, '/soul-backup/')
    assert.equal(cfg.ignoreTlsErrors, false)
    assert.equal(cfg.autoInterval, 'off')
    assert.equal(cfg.retentionCount, 7)
    assert.equal(cfg.hasPassword, false)
  } finally {
    h.cleanup()
  }
})

test('sync-manager: setConfig + getConfig 持久化往返；password 不回显明文', { skip: skipReason ?? false }, async () => {
  resetFakeWebDav()
  const h = makeManager()
  try {
    const updated = await h.manager.setConfig({
      enabled: true,
      endpoint: 'https://dav.example.com/dav/',
      username: 'me@example.com',
      basePath: '/soul-backup',
      ignoreTlsErrors: true,
      autoInterval: 'hourly',
      retentionCount: 14,
      password: 'super-secret',
    })

    assert.equal(updated.enabled, true)
    assert.equal(updated.endpoint, 'https://dav.example.com/dav') // 末尾斜杠被去
    assert.equal(updated.username, 'me@example.com')
    assert.equal(updated.basePath, '/soul-backup')
    assert.equal(updated.ignoreTlsErrors, true)
    assert.equal(updated.autoInterval, 'hourly')
    assert.equal(updated.retentionCount, 14)
    assert.equal(updated.hasPassword, true, 'hasPassword 应为 true')

    // 再次读取应一致
    const re = await h.manager.getConfig()
    assert.deepEqual(re, updated)

    // 关键：返回结构没有任何字段叫 password / passwordPlain
    const allKeys = Object.keys(re)
    assert.ok(!allKeys.includes('password'), `不应回显 password 字段：${allKeys.join(',')}`)
  } finally {
    h.cleanup()
  }
})

test('sync-manager: setConfig 不传 password 时保留原密码（仍能 backupNow）', { skip: skipReason ?? false }, async () => {
  resetFakeWebDav()
  const h = makeManager()
  try {
    await h.manager.setConfig({
      enabled: true,
      endpoint: 'https://dav.example.com/dav/',
      username: 'me@example.com',
      basePath: '/soul-backup',
      password: 'first-password',
    })
    // 不带 password 再 set 一次（仅改 retentionCount）
    await h.manager.setConfig({ retentionCount: 9 })
    const cfg = await h.manager.getConfig()
    assert.equal(cfg.hasPassword, true, '未传 password 时不应清除原值')
    assert.equal(cfg.retentionCount, 9)

    const result = await h.manager.backupNow()
    assert.equal(result.ok, true, `backupNow 应成功：error=${result.error}`)
  } finally {
    h.cleanup()
  }
})

test('sync-manager: clearCredentials 清除 password', { skip: skipReason ?? false }, async () => {
  resetFakeWebDav()
  const h = makeManager()
  try {
    await h.manager.setConfig({
      endpoint: 'https://dav.example.com/dav/',
      username: 'a@b.c',
      basePath: '/sb',
      password: 'pw',
    })
    assert.equal((await h.manager.getConfig()).hasPassword, true)
    await h.manager.clearCredentials()
    assert.equal((await h.manager.getConfig()).hasPassword, false)
  } finally {
    h.cleanup()
  }
})

test('sync-manager: testConnection 透传 WebDavClient.testConnection 结果', { skip: skipReason ?? false }, async () => {
  resetFakeWebDav({
    testConnection: async () => ({ ok: false as const, reason: 'mock-fail-401' }),
  })
  const h = makeManager()
  try {
    await h.manager.setConfig({
      endpoint: 'https://dav.example.com/dav/',
      username: 'a@b.c',
      basePath: '/sb',
      password: 'pw',
    })
    const r = await h.manager.testConnection()
    assert.equal(r.ok, false)
    if (!r.ok) {
      assert.equal(r.reason, 'mock-fail-401')
    }
    assert.equal(fakeWebDavCallLog.testConnection, 1)
  } finally {
    h.cleanup()
  }
})

test('sync-manager: backupNow 全链路成功 → ok=true / sync_history success / settings.last_sync_*', { skip: skipReason ?? false }, async () => {
  resetFakeWebDav()
  const h = makeManager()
  try {
    await h.manager.setConfig({
      enabled: true,
      endpoint: 'https://dav.example.com/dav/',
      username: 'a@b.c',
      basePath: '/sb',
      password: 'pw',
      retentionCount: 5,
    })
    const initialHist = h.history.list().length

    const result = await h.manager.backupNow()
    assert.equal(result.ok, true, `backupNow 应成功：error=${result.error}`)
    assert.ok(result.filename && /^soul-backup-.+\.zip$/.test(result.filename), `filename：${result.filename}`)
    assert.ok(typeof result.totalBytes === 'number' && result.totalBytes > 0)
    assert.equal(fakeWebDavCallLog.putBackup.length, 1)
    assert.equal(fakeWebDavCallLog.putBackup[0].filename, result.filename)
    assert.ok(fakeWebDavCallLog.ensureBasePath >= 1)

    // sync_history 多一条 success
    const hist = h.history.list()
    assert.equal(hist.length, initialHist + 1)
    const last = hist[0]
    assert.equal(last.direction, 'backup')
    assert.equal(last.status, 'success')
    assert.equal(last.remote_filename, result.filename ?? null)

    // settings.last_sync_*
    const status = await h.manager.getStatus()
    assert.equal(status.lastSyncStatus, 'success')
    assert.equal(status.lastSyncDirection, 'backup')
    assert.equal(status.lastSyncError, null)
    assert.ok(status.lastSyncAt !== null && status.lastSyncAt > 0)
  } finally {
    h.cleanup()
  }
})

test('sync-manager: backupNow 失败回写 sync_history failed + 返回 ok=false', { skip: skipReason ?? false }, async () => {
  resetFakeWebDav({
    putBackup: async () => {
      throw new Error('UPLOAD_FAILED_TEST')
    },
  })
  const h = makeManager()
  try {
    await h.manager.setConfig({
      enabled: true,
      endpoint: 'https://dav.example.com/dav/',
      username: 'a@b.c',
      basePath: '/sb',
      password: 'pw',
    })

    const result = await h.manager.backupNow()
    assert.equal(result.ok, false)
    assert.match(result.error ?? '', /UPLOAD_FAILED_TEST/)

    const hist = h.history.list()
    assert.equal(hist.length, 1)
    assert.equal(hist[0].status, 'failed')
    assert.match(hist[0].error_message ?? '', /UPLOAD_FAILED_TEST/)

    const status = await h.manager.getStatus()
    assert.equal(status.lastSyncStatus, 'failed')
    assert.match(status.lastSyncError ?? '', /UPLOAD_FAILED_TEST/)
  } finally {
    h.cleanup()
  }
})

test('sync-manager: backupNow 并发互斥：第二次抛 sync_already_running', { skip: skipReason ?? false }, async () => {
  // 让 putBackup 卡一会儿，便于触发并发
  // 用 holder 对象避免 `let resolveHold: (() => void) | null` 在 strict 模式下被 control-flow narrow 为 never
  const holder: { resolve?: () => void } = {}
  const hold = new Promise<void>((r) => {
    holder.resolve = r
  })
  resetFakeWebDav({
    putBackup: async () => {
      await hold
    },
  })
  const h = makeManager()
  try {
    await h.manager.setConfig({
      enabled: true,
      endpoint: 'https://dav.example.com/dav/',
      username: 'a@b.c',
      basePath: '/sb',
      password: 'pw',
    })

    const first = h.manager.backupNow()
    // 等到 isRunning 已被置 true：稍等一个 microtask 让 try 块进入
    await new Promise<void>((r) => setTimeout(r, 10))

    let secondError: unknown = null
    try {
      await h.manager.backupNow()
    } catch (e) {
      secondError = e
    }
    assert.ok(secondError instanceof Error)
    assert.match((secondError as Error).message, /sync_already_running/)

    // 释放第一个，确保 cleanup 不卡住
    holder.resolve?.()
    await first
  } finally {
    h.cleanup()
  }
})

test('sync-manager: registerAutoInterval autoInterval=off → 不调用 scheduleCron', { skip: skipReason ?? false }, async () => {
  resetFakeWebDav()
  const h = makeManager()
  try {
    await h.manager.setConfig({
      enabled: true,
      endpoint: 'https://dav.example.com/dav/',
      username: 'a@b.c',
      basePath: '/sb',
      password: 'pw',
      autoInterval: 'off',
    })
    await h.manager.registerAutoInterval()
    assert.equal(h.cronCalls.length, 0)
    assert.ok(h.cronCancels.includes('webdav-sync'))
  } finally {
    h.cleanup()
  }
})

test('sync-manager: registerAutoInterval autoInterval=daily → cron=0 9 * * * tz=UTC', { skip: skipReason ?? false }, async () => {
  resetFakeWebDav()
  const h = makeManager()
  try {
    await h.manager.setConfig({
      enabled: true,
      endpoint: 'https://dav.example.com/dav/',
      username: 'a@b.c',
      basePath: '/sb',
      password: 'pw',
      autoInterval: 'daily',
    })
    await h.manager.registerAutoInterval()
    assert.equal(h.cronCalls.length, 1)
    assert.equal(h.cronCalls[0].taskId, 'webdav-sync')
    assert.equal(h.cronCalls[0].cronExpr, '0 9 * * *')
    assert.equal(h.cronCalls[0].timezone, 'UTC')
  } finally {
    h.cleanup()
  }
})

test('sync-manager: restoreFrom 拒绝非法 filename', { skip: skipReason ?? false }, async () => {
  resetFakeWebDav()
  const h = makeManager()
  try {
    await h.manager.setConfig({
      enabled: true,
      endpoint: 'https://dav.example.com/dav/',
      username: 'a@b.c',
      basePath: '/sb',
      password: 'pw',
    })
    // ../../etc/passwd
    await assert.rejects(
      h.manager.restoreFrom('../../etc/passwd'),
      /非法|illegal/,
    )
    // 不带 soul-backup- 前缀
    await assert.rejects(
      h.manager.restoreFrom('arbitrary.zip'),
      /非法|illegal/,
    )
    // 含路径分隔
    await assert.rejects(
      h.manager.restoreFrom('soul-backup-x/dev/null.zip'),
      /非法|illegal/,
    )
    // 没有真正调到 WebDavClient
    assert.equal(fakeWebDavCallLog.getBackup.length, 0)
  } finally {
    h.cleanup()
  }
})

test('sync-manager: applyExtractedSnapshot DB 步骤失败时不触碰本地 avatars（无半恢复）', { skip: skipReason ?? false }, async () => {
  resetFakeWebDav()
  const h = makeManager()
  try {
    // 本地 avatars 已有 a.txt（makeManager 预置）；构造一个「有 avatars 但缺 DB」的快照目录。
    // 重排后 DB 替换在最前，缺 DB 应在删除 avatars 之前抛错 → 本地 a.txt 必须原样保留。
    const extractedDir = path.join(h.workDir, 'extracted')
    const snapshotRoot = path.join(extractedDir, 'snapshot')
    fs.mkdirSync(path.join(snapshotRoot, 'avatars'), { recursive: true })
    fs.writeFileSync(path.join(snapshotRoot, 'avatars', 'remote.txt'), Buffer.from('REMOTE'))
    // 故意不写 snapshot/xiaodu-snapshot.db

    const apply = (h.manager as unknown as {
      applyExtractedSnapshot(dir: string): Promise<void>
    }).applyExtractedSnapshot.bind(h.manager)

    await assert.rejects(apply(extractedDir), /xiaodu-snapshot\.db missing/)

    // 关键断言：本地 avatars 未被替换（旧分身仍在，远端文件没进来）
    assert.ok(
      fs.existsSync(path.join(h.workDir, 'avatars', 'a.txt')),
      'DB 步骤失败时本地 avatars/a.txt 必须保留',
    )
    assert.ok(
      !fs.existsSync(path.join(h.workDir, 'avatars', 'remote.txt')),
      '失败时远端 avatars 不应被应用',
    )
  } finally {
    h.cleanup()
  }
})

test('sync-manager: applyExtractedSnapshot DB 替换后某步失败 → DB 回滚到恢复前', { skip: skipReason ?? false }, async () => {
  resetFakeWebDav()
  const h = makeManager()
  try {
    // 预置一个旧的本地 xiaodu.db（内容 OLDDB）
    const targetDb = path.join(h.workDir, 'xiaodu.db')
    fs.writeFileSync(targetDb, Buffer.from('OLDDB'))
    // 让 conversations 步骤必然失败：把 conversationsRoot 预先写成「文件」，
    // 后续 mkdir(conversationsRoot, {recursive}) 会抛错 → 触发 DB 回滚
    fs.writeFileSync(path.join(h.workDir, 'conversations'), Buffer.from('blocker'))

    const extractedDir = path.join(h.workDir, 'extracted')
    const snapshotRoot = path.join(extractedDir, 'snapshot')
    fs.mkdirSync(snapshotRoot, { recursive: true })
    fs.writeFileSync(path.join(snapshotRoot, 'xiaodu-snapshot.db'), Buffer.from('NEWDB'))
    // 仅放 conversations（让步骤 2/3 跳过，步骤 4 触发失败）
    fs.mkdirSync(path.join(snapshotRoot, 'conversations'), { recursive: true })
    fs.writeFileSync(path.join(snapshotRoot, 'conversations', 'c.jsonl'), Buffer.from('{}'))

    const apply = (h.manager as unknown as {
      applyExtractedSnapshot(dir: string): Promise<void>
    }).applyExtractedSnapshot.bind(h.manager)

    await assert.rejects(apply(extractedDir))

    // 关键断言：DB 已回滚到 OLDDB，而不是停留在远端 NEWDB
    assert.equal(
      fs.readFileSync(targetDb, 'utf-8'),
      'OLDDB',
      '后续步骤失败时 xiaodu.db 必须回滚到恢复前内容',
    )
  } finally {
    h.cleanup()
  }
})

test('sync-manager: applyExtractedSnapshot avatars 已替换后 conversations 失败 → avatars + DB 一并回滚', { skip: skipReason ?? false }, async () => {
  resetFakeWebDav()
  const h = makeManager()
  try {
    // 预置旧 DB（OLDDB）。本地 avatars/a.txt 由 makeManager 预置。
    const targetDb = path.join(h.workDir, 'xiaodu.db')
    fs.writeFileSync(targetDb, Buffer.from('OLDDB'))
    // 让 conversations（最后一步）必然失败：把 conversationsRoot 预先写成「文件」，
    // 其 mkdir(recursive) 会抛错 —— 此时 avatars 已被替换成远端内容。
    fs.writeFileSync(path.join(h.workDir, 'conversations'), Buffer.from('blocker'))

    const extractedDir = path.join(h.workDir, 'extracted')
    const snapshotRoot = path.join(extractedDir, 'snapshot')
    fs.mkdirSync(snapshotRoot, { recursive: true })
    fs.writeFileSync(path.join(snapshotRoot, 'xiaodu-snapshot.db'), Buffer.from('NEWDB'))
    // 快照含 avatars（触发替换）与 conversations（触发失败）
    fs.mkdirSync(path.join(snapshotRoot, 'avatars'), { recursive: true })
    fs.writeFileSync(path.join(snapshotRoot, 'avatars', 'remote.txt'), Buffer.from('REMOTE'))
    fs.mkdirSync(path.join(snapshotRoot, 'conversations'), { recursive: true })
    fs.writeFileSync(path.join(snapshotRoot, 'conversations', 'c.jsonl'), Buffer.from('{}'))

    const apply = (h.manager as unknown as {
      applyExtractedSnapshot(dir: string): Promise<void>
    }).applyExtractedSnapshot.bind(h.manager)

    await assert.rejects(apply(extractedDir))

    // 关键断言 1：avatars 回滚到恢复前（本地 a.txt 仍在，远端 remote.txt 不应残留）
    assert.ok(
      fs.existsSync(path.join(h.workDir, 'avatars', 'a.txt')),
      '后续步骤失败时本地 avatars/a.txt 必须随回滚保留',
    )
    assert.ok(
      !fs.existsSync(path.join(h.workDir, 'avatars', 'remote.txt')),
      '失败回滚后远端 avatars 内容不应残留（半恢复）',
    )
    // 关键断言 2：DB 回滚到 OLDDB
    assert.equal(
      fs.readFileSync(targetDb, 'utf-8'),
      'OLDDB',
      '后续步骤失败时 xiaodu.db 必须回滚到恢复前内容',
    )
    // 关键断言 3：不遗留 .restore-bak 暂存目录
    const leftovers = fs
      .readdirSync(h.workDir)
      .filter((n) => n.includes('.restore-bak.'))
    assert.deepEqual(leftovers, [], `回滚后不应遗留暂存目录：${leftovers.join(', ')}`)
  } finally {
    h.cleanup()
  }
})

test('sync-manager: applyExtractedSnapshot 恢复前无本地目录时失败 → 回滚到「目录不存在」原状（不报错）', { skip: skipReason ?? false }, async () => {
  resetFakeWebDav()
  const h = makeManager()
  try {
    // 删掉 makeManager 预置的本地 avatars，模拟「首次 restore、本地从未有过 avatars」
    fs.rmSync(path.join(h.workDir, 'avatars'), { recursive: true, force: true })
    const targetDb = path.join(h.workDir, 'xiaodu.db')
    fs.writeFileSync(targetDb, Buffer.from('OLDDB'))
    // conversations 作为文件 → 最后一步 mkdir 失败，此时 avatars 已被新建并写入快照
    fs.writeFileSync(path.join(h.workDir, 'conversations'), Buffer.from('blocker'))

    const extractedDir = path.join(h.workDir, 'extracted')
    const snapshotRoot = path.join(extractedDir, 'snapshot')
    fs.mkdirSync(snapshotRoot, { recursive: true })
    fs.writeFileSync(path.join(snapshotRoot, 'xiaodu-snapshot.db'), Buffer.from('NEWDB'))
    fs.mkdirSync(path.join(snapshotRoot, 'avatars'), { recursive: true })
    fs.writeFileSync(path.join(snapshotRoot, 'avatars', 'remote.txt'), Buffer.from('REMOTE'))
    fs.mkdirSync(path.join(snapshotRoot, 'conversations'), { recursive: true })
    fs.writeFileSync(path.join(snapshotRoot, 'conversations', 'c.jsonl'), Buffer.from('{}'))

    const apply = (h.manager as unknown as {
      applyExtractedSnapshot(dir: string): Promise<void>
    }).applyExtractedSnapshot.bind(h.manager)

    // 关键：回滚过程本身不得抛错（hadLocal=false 分支只删不还原）
    await assert.rejects(apply(extractedDir))

    // 回滚到原状：恢复前 avatars 不存在 → 回滚后也应不存在（而非残留远端内容或半目录）
    assert.ok(
      !fs.existsSync(path.join(h.workDir, 'avatars')),
      '恢复前无 avatars 时，失败回滚后该目录应保持不存在',
    )
    assert.equal(fs.readFileSync(targetDb, 'utf-8'), 'OLDDB', 'DB 必须回滚到 OLDDB')
  } finally {
    h.cleanup()
  }
})

test('sync-manager: deviceId 持久化（多次 getStatus 返回同一 deviceId）', { skip: skipReason ?? false }, async () => {
  resetFakeWebDav()
  const h = makeManager()
  try {
    const s1 = await h.manager.getStatus()
    const s2 = await h.manager.getStatus()
    assert.equal(typeof s1.deviceId, 'string')
    assert.ok(s1.deviceId.length > 0)
    assert.equal(s2.deviceId, s1.deviceId, 'deviceId 应在 settings 中持久化')

    // 直接读 settings 表确认 device_id 存在
    const row = h.db.prepare('SELECT value FROM settings WHERE key = ?').get('device_id') as
      | { value: string }
      | undefined
    assert.ok(row !== undefined && row.value === s1.deviceId)
  } finally {
    h.cleanup()
  }
})
