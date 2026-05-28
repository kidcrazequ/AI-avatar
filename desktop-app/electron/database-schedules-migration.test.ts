/**
 * 验证 schedules / schedule_runs 两条建表路径都生效（#11 Scheduled Tasks · 子任务 1）。
 *
 *   ① 全新安装：createBaseSchema 直接建表
 *   ② 老用户升级：v9→v10 migration 建表
 *
 * 实现注意：与 database-attachments.test.ts 同样需要 electron stub + better-sqlite3 ABI 探测，
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

const TMP_USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-sched-mig-userdata-'))
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
  const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-sched-mig-probe-'))
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-sched-mig-test-'))
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

test('schedules migration: 全新安装 createBaseSchema 包含 schedules + schedule_runs', { skip: skipReason ?? false }, () => {
  if (!DatabaseManagerCtor) return
  const dbPath = makeTempDbFile()
  const dm = new DatabaseManagerCtor(dbPath)
  dm.close()
  const tables = listTables(dbPath)
  assert.ok(tables.includes('schedules'), `schedules 表缺失，实际表：${tables.join(',')}`)
  assert.ok(tables.includes('schedule_runs'), `schedule_runs 表缺失，实际表：${tables.join(',')}`)
})

test('schedules migration: v9 老库升级到 v10 后建出 schedules + schedule_runs', { skip: skipReason ?? false }, () => {
  if (!DatabaseManagerCtor || !DatabaseCtor) return
  const dbPath = makeTempDbFile()
  // 手动构造一个 v9 的最小库：要包含 DatabaseManager.prepareStatements 涉及的所有表
  // （conversations / messages / settings / messages_fts），否则 stmts 预编译时报 "no such table"。
  // 不需要全量 schema —— 只要预编译能通过，就足以验证 v9→v10 迁移路径。
  const raw = new DatabaseCtor(dbPath)
  raw.exec(`
    CREATE TABLE schema_version (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL DEFAULT 1);
    INSERT INTO schema_version (version) VALUES (9);
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
  `)
  raw.close()

  // 以 DatabaseManager 打开，触发 v9→v10 迁移
  const dm = new DatabaseManagerCtor(dbPath)
  dm.close()

  const tables = listTables(dbPath)
  assert.ok(tables.includes('schedules'), `升级后 schedules 表缺失：${tables.join(',')}`)
  assert.ok(tables.includes('schedule_runs'), `升级后 schedule_runs 表缺失：${tables.join(',')}`)

  // 校验 schema_version 至少升到 10（DatabaseManager 会推到 CURRENT_SCHEMA_VERSION）
  const verDb = new DatabaseCtor(dbPath, { readonly: true })
  const ver = verDb.prepare('SELECT version FROM schema_version').get() as { version: number }
  verDb.close()
  assert.ok(ver.version >= 10, `schema_version 应 >=10，实际 ${ver.version}`)
})

test('schedules migration: 二次构造 DatabaseManager 不抛错（迁移幂等）', { skip: skipReason ?? false }, () => {
  if (!DatabaseManagerCtor) return
  const dbPath = makeTempDbFile()
  const dm1 = new DatabaseManagerCtor(dbPath)
  dm1.close()
  // 再开一次：如果迁移逻辑非幂等会抛 "table schedules already exists"
  const dm2 = new DatabaseManagerCtor(dbPath)
  dm2.close()
})
