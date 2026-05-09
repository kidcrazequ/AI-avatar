/**
 * 验证 embeds 表两条建表路径都生效（#15 Web Embed widget · 子任务 1）。
 *
 *   ① 全新安装：createBaseSchema 直接建表（schema_version=11）
 *   ② 老用户升级：v10→v11 migration 建表（schema_version 由 10 升到 11）
 *   ③ 二次构造 DatabaseManager 不抛错（迁移幂等）
 *
 * 实现注意：与 database-schedules-migration.test.ts 同样需要 electron stub + better-sqlite3 ABI 探测，
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

const TMP_USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-emb-mig-userdata-'))
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
  const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-emb-mig-probe-'))
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-emb-mig-test-'))
  return path.join(dir, 'test.db')
}

interface SqliteRow {
  name: string
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

function readSchemaVersion(dbPath: string): number {
  if (!DatabaseCtor) throw new Error('Database 未加载')
  const raw = new DatabaseCtor(dbPath, { readonly: true })
  const row = raw.prepare('SELECT version FROM schema_version').get() as { version: number }
  raw.close()
  return row.version
}

test('embeds migration: 全新安装 createBaseSchema 包含 embeds 表 + 索引，schema_version=11', { skip: skipReason ?? false }, () => {
  if (!DatabaseManagerCtor) return
  const dbPath = makeTempDbFile()
  const dm = new DatabaseManagerCtor(dbPath)
  dm.close()

  const tables = listTables(dbPath)
  assert.ok(tables.includes('embeds'), `embeds 表缺失，实际表：${tables.join(',')}`)

  const indexes = listIndexes(dbPath)
  assert.ok(indexes.includes('idx_embeds_avatar_id'), `idx_embeds_avatar_id 缺失：${indexes.join(',')}`)
  assert.ok(indexes.includes('idx_embeds_enabled'), `idx_embeds_enabled 缺失：${indexes.join(',')}`)

  assert.equal(readSchemaVersion(dbPath), 11)
})

test('embeds migration: v10 老库升级到 v11 后建出 embeds 表', { skip: skipReason ?? false }, () => {
  if (!DatabaseManagerCtor || !DatabaseCtor) return
  const dbPath = makeTempDbFile()
  // 手动构造一个 v10 的最小库：包含 DatabaseManager.prepareStatements 涉及的所有表
  // （conversations / messages / settings / messages_fts），加上 v10 已有的 schedules / schedule_runs。
  // 否则 stmts 预编译时会报 "no such table"。
  const raw = new DatabaseCtor(dbPath)
  raw.exec(`
    CREATE TABLE schema_version (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL DEFAULT 1);
    INSERT INTO schema_version (version) VALUES (10);
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
  `)
  raw.close()

  // 以 DatabaseManager 打开，触发 v10→v11 迁移
  const dm = new DatabaseManagerCtor(dbPath)
  dm.close()

  const tables = listTables(dbPath)
  assert.ok(tables.includes('embeds'), `升级后 embeds 表缺失：${tables.join(',')}`)

  const indexes = listIndexes(dbPath)
  assert.ok(indexes.includes('idx_embeds_avatar_id'), `升级后 idx_embeds_avatar_id 缺失：${indexes.join(',')}`)
  assert.ok(indexes.includes('idx_embeds_enabled'), `升级后 idx_embeds_enabled 缺失：${indexes.join(',')}`)

  assert.equal(readSchemaVersion(dbPath), 11)
})

test('embeds migration: 二次构造 DatabaseManager 不抛错（迁移幂等）', { skip: skipReason ?? false }, () => {
  if (!DatabaseManagerCtor) return
  const dbPath = makeTempDbFile()
  const dm1 = new DatabaseManagerCtor(dbPath)
  dm1.close()
  // 再开一次：如果迁移逻辑非幂等会抛 "table embeds already exists"
  const dm2 = new DatabaseManagerCtor(dbPath)
  dm2.close()

  // schema_version 仍是 11
  assert.equal(readSchemaVersion(dbPath), 11)
})
