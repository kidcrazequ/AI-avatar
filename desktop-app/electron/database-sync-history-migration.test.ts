/**
 * 验证 sync_history 表两条建表路径都生效（#16 WebDAV cross-device sync · 子任务 6）。
 *
 *   ① 全新安装：createBaseSchema 直接建表（schema_version=12）
 *   ② 老用户升级：v11→v12 migration 建表（schema_version 由 11 升到 12）
 *   ③ 二次构造 DatabaseManager 不抛错（迁移幂等）
 *
 * 实现注意：与 database-embeds-migration.test.ts 同款，需要 electron stub + better-sqlite3 ABI 探测，
 * 否则系统 Node 直跑会因为 `import { app } from 'electron'` 或 NODE_MODULE_VERSION 失败。
 *
 * @author zhi.qu
 * @date 2026-05-09
 */

import fs from 'fs'
import os from 'os'
import path from 'path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

// ─── electron stub 注入（必须在 require('./database') 之前） ───────────────
const TMP_USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-syncmig-userdata-'))
const electronStubExports = {
  app: { getPath: (_key: string) => TMP_USER_DATA },
  shell: {},
  ipcMain: { handle: () => undefined, on: () => undefined },
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

let DatabaseManagerCtor: typeof import('./database').DatabaseManager | null = null
let DatabaseCtor: typeof import('better-sqlite3') | null = null
let loadError: string | null = null
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  DatabaseCtor = require('better-sqlite3') as typeof import('better-sqlite3')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require('./database') as typeof import('./database')
  DatabaseManagerCtor = mod.DatabaseManager
  // 触发 ABI 校验
  const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-syncmig-probe-'))
  const probe = new DatabaseManagerCtor(path.join(probeDir, 'probe.db'))
  probe.close()
} catch (err) {
  loadError = err instanceof Error ? err.message : String(err)
  DatabaseManagerCtor = null
}
const skipReason = loadError
  ? `跳过：本测试需要 better-sqlite3 原生绑定与当前 Node ABI 匹配（${loadError.split('\n')[0]}）`
  : null

function makeTempDbFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-syncmig-test-'))
  return path.join(dir, 'test.db')
}

interface SqliteRow {
  name: string
}
interface ColumnRow {
  cid: number
  name: string
  type: string
  notnull: number
  dflt_value: string | null
  pk: number
}

function listTables(dbPath: string): string[] {
  if (!DatabaseCtor) throw new Error('Database 未加载')
  const raw = new DatabaseCtor(dbPath, { readonly: true })
  const rows = raw.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`,
  ).all() as SqliteRow[]
  raw.close()
  return rows.map((r) => r.name)
}

function listIndexes(dbPath: string): string[] {
  if (!DatabaseCtor) throw new Error('Database 未加载')
  const raw = new DatabaseCtor(dbPath, { readonly: true })
  const rows = raw.prepare(
    `SELECT name FROM sqlite_master WHERE type='index' ORDER BY name`,
  ).all() as SqliteRow[]
  raw.close()
  return rows.map((r) => r.name)
}

function listColumns(dbPath: string, table: string): ColumnRow[] {
  if (!DatabaseCtor) throw new Error('Database 未加载')
  const raw = new DatabaseCtor(dbPath, { readonly: true })
  const rows = raw.prepare(`PRAGMA table_info(${table})`).all() as ColumnRow[]
  raw.close()
  return rows
}

function readSchemaVersion(dbPath: string): number {
  if (!DatabaseCtor) throw new Error('Database 未加载')
  const raw = new DatabaseCtor(dbPath, { readonly: true })
  const row = raw.prepare('SELECT version FROM schema_version').get() as { version: number }
  raw.close()
  return row.version
}

test('sync_history migration: 全新安装 createBaseSchema 包含 sync_history 表 + 索引，schema_version=12', { skip: skipReason ?? false }, () => {
  if (!DatabaseManagerCtor) return
  const dbPath = makeTempDbFile()
  const dm = new DatabaseManagerCtor(dbPath)
  dm.close()

  const tables = listTables(dbPath)
  assert.ok(tables.includes('sync_history'), `sync_history 表缺失，实际表：${tables.join(',')}`)

  const indexes = listIndexes(dbPath)
  assert.ok(
    indexes.includes('idx_sync_history_created_at'),
    `idx_sync_history_created_at 缺失：${indexes.join(',')}`,
  )
  assert.ok(
    indexes.includes('idx_sync_history_direction_status'),
    `idx_sync_history_direction_status 缺失：${indexes.join(',')}`,
  )

  // 字段层面校验：name + notnull + pk + type
  const cols = listColumns(dbPath, 'sync_history')
  const byName = new Map(cols.map((c) => [c.name, c]))
  // 必备字段都在
  for (const required of [
    'id',
    'direction',
    'status',
    'file_count',
    'total_bytes',
    'duration_ms',
    'remote_filename',
    'error_message',
    'created_at',
  ]) {
    assert.ok(byName.has(required), `字段缺失：${required}（实际：${cols.map((c) => c.name).join(',')}）`)
  }
  // id 是主键
  assert.equal(byName.get('id')!.pk, 1)
  // direction / status / created_at 必须 NOT NULL
  assert.equal(byName.get('direction')!.notnull, 1)
  assert.equal(byName.get('status')!.notnull, 1)
  assert.equal(byName.get('created_at')!.notnull, 1)
  // remote_filename / error_message 允许 NULL
  assert.equal(byName.get('remote_filename')!.notnull, 0)
  assert.equal(byName.get('error_message')!.notnull, 0)

  assert.ok(readSchemaVersion(dbPath) >= 12, `schema_version 应 >=12，实际 ${readSchemaVersion(dbPath)}`)
})

test('sync_history migration: v11 老库升级到 v12 后建出 sync_history 表', { skip: skipReason ?? false }, () => {
  if (!DatabaseManagerCtor || !DatabaseCtor) return
  const dbPath = makeTempDbFile()
  // 手动构造一个 v11 的最小库：包含 DatabaseManager.prepareStatements 涉及的所有表
  // （conversations / messages / settings / messages_fts），加上 v10/v11 已有的 schedules / schedule_runs / embeds。
  // 否则 stmts 预编译时会报 "no such table"。
  const raw = new DatabaseCtor(dbPath)
  raw.exec(`
    CREATE TABLE schema_version (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL DEFAULT 1);
    INSERT INTO schema_version (version) VALUES (11);
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, avatar_id TEXT NOT NULL DEFAULT '',
      project_id TEXT NOT NULL DEFAULT 'default', workspace_initialized INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, role TEXT NOT NULL,
      content TEXT NOT NULL, tool_call_id TEXT, image_urls TEXT, created_at INTEGER NOT NULL
    );
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE VIRTUAL TABLE messages_fts USING fts5(content, content='messages', content_rowid='rowid');
    CREATE TABLE schedules (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, avatar_id TEXT NOT NULL,
      project_id TEXT NOT NULL DEFAULT 'default', conversation_id TEXT,
      cron_expr TEXT NOT NULL, timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
      prompt_text TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
      next_run_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE schedule_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      schedule_id TEXT NOT NULL, fired_at_utc INTEGER NOT NULL,
      status TEXT NOT NULL, conversation_id TEXT, duration_ms INTEGER,
      error_message TEXT, created_at INTEGER NOT NULL,
      FOREIGN KEY (schedule_id) REFERENCES schedules(id) ON DELETE CASCADE,
      UNIQUE(schedule_id, fired_at_utc)
    );
    CREATE TABLE embeds (
      id TEXT PRIMARY KEY, avatar_id TEXT NOT NULL, name TEXT NOT NULL,
      origin_whitelist TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
      rate_limit_per_min INTEGER NOT NULL DEFAULT 30, greeting TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
  `)
  raw.close()

  // 以 DatabaseManager 打开，触发 v11→v12 迁移
  const dm = new DatabaseManagerCtor(dbPath)
  dm.close()

  const tables = listTables(dbPath)
  assert.ok(tables.includes('sync_history'), `升级后 sync_history 表缺失：${tables.join(',')}`)

  const indexes = listIndexes(dbPath)
  assert.ok(
    indexes.includes('idx_sync_history_created_at'),
    `升级后 idx_sync_history_created_at 缺失：${indexes.join(',')}`,
  )
  assert.ok(
    indexes.includes('idx_sync_history_direction_status'),
    `升级后 idx_sync_history_direction_status 缺失：${indexes.join(',')}`,
  )

  assert.ok(readSchemaVersion(dbPath) >= 12, `schema_version 应 >=12，实际 ${readSchemaVersion(dbPath)}`)
})

test('sync_history migration: 二次构造 DatabaseManager 不抛错（迁移幂等）', { skip: skipReason ?? false }, () => {
  if (!DatabaseManagerCtor) return
  const dbPath = makeTempDbFile()
  const dm1 = new DatabaseManagerCtor(dbPath)
  dm1.close()
  // 再开一次：如果迁移逻辑非幂等会抛 "table sync_history already exists"
  const dm2 = new DatabaseManagerCtor(dbPath)
  dm2.close()

  // schema_version 仍是 12
  assert.ok(readSchemaVersion(dbPath) >= 12, `schema_version 应 >=12，实际 ${readSchemaVersion(dbPath)}`)

  // sync_history 表还在、且只有一份（重复创建会抛错而不是悄悄变成两份）
  const tables = listTables(dbPath)
  assert.equal(tables.filter((t) => t === 'sync_history').length, 1)
})
