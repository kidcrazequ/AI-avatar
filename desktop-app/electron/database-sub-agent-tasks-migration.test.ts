/**
 * 验证 sub_agent_tasks 表两条建表路径 + 三个 DAO 方法 + 孤儿清理（v15，2026-05-17）。
 *
 *   ① 全新安装：createBaseSchema 直接建表（schema_version=15）
 *   ② 老用户升级：v14→v15 migration 建表（schema_version 由 14 升到 15）
 *   ③ 二次构造 DatabaseManager 不抛错（迁移幂等）
 *   ④ upsertSubAgentTask：插入 + 同 id 覆盖
 *   ⑤ listSubAgentTasksByConversation：按 started_at 升序
 *   ⑥ markOrphanRunningAsLost：只动 running 行，done/error 行不变
 *
 * 与其他 migration 测试同样需要 electron stub + better-sqlite3 ABI 探测。
 *
 * @author zhi.qu
 * @date 2026-05-17
 */

import fs from 'fs'
import os from 'os'
import path from 'path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const TMP_USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-sat-mig-userdata-'))
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
  const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-sat-mig-probe-'))
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-sat-mig-test-'))
  return path.join(dir, 'test.db')
}

interface SqliteRow { name: string }

function listTables(dbPath: string): string[] {
  if (!DatabaseCtor) throw new Error('Database 未加载')
  const raw = new DatabaseCtor(dbPath, { readonly: true })
  const rows = raw.prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).all() as SqliteRow[]
  raw.close()
  return rows.map((r) => r.name)
}

function listIndexes(dbPath: string): string[] {
  if (!DatabaseCtor) throw new Error('Database 未加载')
  const raw = new DatabaseCtor(dbPath, { readonly: true })
  const rows = raw.prepare(`SELECT name FROM sqlite_master WHERE type='index' ORDER BY name`).all() as SqliteRow[]
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

test('sub_agent_tasks: 全新安装 createBaseSchema 包含表 + 索引 + agent_type 列，schema_version=16', { skip: skipReason ?? false }, () => {
  if (!DatabaseManagerCtor || !DatabaseCtor) return
  const dbPath = makeTempDbFile()
  const dm = new DatabaseManagerCtor(dbPath)
  dm.close()

  const tables = listTables(dbPath)
  assert.ok(tables.includes('sub_agent_tasks'), `sub_agent_tasks 表缺失，实际：${tables.join(',')}`)

  const indexes = listIndexes(dbPath)
  assert.ok(indexes.includes('idx_sub_agent_tasks_conv'), `idx_sub_agent_tasks_conv 缺失：${indexes.join(',')}`)
  assert.ok(indexes.includes('idx_sub_agent_tasks_running'), `idx_sub_agent_tasks_running 缺失：${indexes.join(',')}`)

  // v16：agent_type 列必须存在（TypedSubAgentManager 写入位）
  const raw = new DatabaseCtor(dbPath, { readonly: true })
  const cols = raw.prepare(`PRAGMA table_info(sub_agent_tasks)`).all() as Array<{ name: string }>
  raw.close()
  assert.ok(cols.some((c) => c.name === 'agent_type'), `agent_type 列缺失，实际列：${cols.map((c) => c.name).join(',')}`)

  assert.ok(readSchemaVersion(dbPath) >= 16, `schema_version 应 >=16，实际 ${readSchemaVersion(dbPath)}`)
})

test('sub_agent_tasks: v14 老库一路升到 v16，sub_agent_tasks 表 + agent_type 列齐备', { skip: skipReason ?? false }, () => {
  if (!DatabaseManagerCtor || !DatabaseCtor) return
  const dbPath = makeTempDbFile()
  // 构造 v14 最小库：包含 prepareStatements 涉及的表 + v14 之前各版本的表
  // （否则 stmts 预编译期会报 "no such table"）。
  const raw = new DatabaseCtor(dbPath)
  raw.exec(`
    CREATE TABLE schema_version (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL DEFAULT 1);
    INSERT INTO schema_version (version) VALUES (14);
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, avatar_id TEXT NOT NULL DEFAULT '',
      project_id TEXT NOT NULL DEFAULT 'default', workspace_initialized INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, role TEXT NOT NULL,
      content TEXT NOT NULL, tool_call_id TEXT, image_urls TEXT,
      reasoning_content TEXT, created_at INTEGER NOT NULL
    );
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE VIRTUAL TABLE messages_fts USING fts5(content, content='messages', content_rowid='rowid');
  `)
  raw.close()

  const dm = new DatabaseManagerCtor(dbPath)
  dm.close()

  assert.ok(readSchemaVersion(dbPath) >= 16, `schema_version 应 >=16，实际 ${readSchemaVersion(dbPath)}`)
  const tables = listTables(dbPath)
  assert.ok(tables.includes('sub_agent_tasks'), '迁移后应包含 sub_agent_tasks 表')

  // agent_type 列在 v16 补齐
  // 上面已有同名 raw（造种子库时声明），ESM/tsx 在同一函数 scope 重复 const 会编译失败；
  // 改名 rawRO 区分（这次是只读探查）
  const rawRO = new DatabaseCtor(dbPath, { readonly: true })
  const cols = rawRO.prepare(`PRAGMA table_info(sub_agent_tasks)`).all() as Array<{ name: string }>
  rawRO.close()
  assert.ok(cols.some((c) => c.name === 'agent_type'), 'v16 迁移后应有 agent_type 列')

  // 再开一次：迁移应幂等，不抛
  const dm2 = new DatabaseManagerCtor(dbPath)
  dm2.close()
  assert.ok(readSchemaVersion(dbPath) >= 16, `schema_version 应 >=16，实际 ${readSchemaVersion(dbPath)}`)
})

test('upsertSubAgentTask + listSubAgentTasksByConversation：插入、覆盖、排序', { skip: skipReason ?? false }, () => {
  if (!DatabaseManagerCtor) return
  const dbPath = makeTempDbFile()
  const dm = new DatabaseManagerCtor(dbPath)
  try {
    // 先建一个会话（FK 约束需要）
    const convId = dm.createConversation('t', 'avatar-x')

    dm.upsertSubAgentTask({
      id: 'sub-001', conversation_id: convId, parent_avatar_id: 'avatar-x',
      target_avatar: null, task: '任务 A', status: 'running',
      result: null, error: null, started_at: 1000, finished_at: null, agent_type: null,
    })
    dm.upsertSubAgentTask({
      id: 'sub-002', conversation_id: convId, parent_avatar_id: 'avatar-x',
      target_avatar: 'design-master', task: '任务 B', status: 'running',
      result: null, error: null, started_at: 2000, finished_at: null, agent_type: null,
    })

    let rows = dm.listSubAgentTasksByConversation(convId)
    assert.equal(rows.length, 2)
    assert.equal(rows[0].id, 'sub-001', '应按 started_at 升序')
    assert.equal(rows[1].target_avatar, 'design-master')

    // 同 id 覆盖：sub-001 从 running → done
    dm.upsertSubAgentTask({
      id: 'sub-001', conversation_id: convId, parent_avatar_id: 'avatar-x',
      target_avatar: null, task: '任务 A', status: 'done',
      result: '结果文本', error: null, started_at: 1000, finished_at: 1500, agent_type: null,
    })

    rows = dm.listSubAgentTasksByConversation(convId)
    assert.equal(rows.length, 2, 'UPSERT 不应增加行数')
    const a = rows.find((r) => r.id === 'sub-001')!
    assert.equal(a.status, 'done')
    assert.equal(a.result, '结果文本')
    assert.equal(a.finished_at, 1500)
  } finally {
    dm.close()
  }
})

test('upsertSubAgentTask：agent_type 与 denied 状态可正确写入读出', { skip: skipReason ?? false }, () => {
  if (!DatabaseManagerCtor) return
  const dbPath = makeTempDbFile()
  const dm = new DatabaseManagerCtor(dbPath)
  try {
    const convId = dm.createConversation('t', 'avatar-x')

    // 模拟 TypedSubAgentManager 写一行 explore + running
    dm.upsertSubAgentTask({
      id: 'sub-explore-001', conversation_id: convId, parent_avatar_id: 'avatar-x',
      target_avatar: null, task: '探索任务', status: 'running',
      result: null, error: null, started_at: 1, finished_at: null,
      agent_type: 'explore',
    })

    // 再写一行被 SpawnGuard 拒绝的 denied
    dm.upsertSubAgentTask({
      id: 'sub-denied-001', conversation_id: convId, parent_avatar_id: 'avatar-x',
      target_avatar: null, task: '被拒任务', status: 'denied',
      result: null, error: '预算超限', started_at: 2, finished_at: 2,
      agent_type: 'worker',
    })

    const rows = dm.listSubAgentTasksByConversation(convId)
    const explore = rows.find((r) => r.id === 'sub-explore-001')!
    const denied = rows.find((r) => r.id === 'sub-denied-001')!
    assert.equal(explore.agent_type, 'explore')
    assert.equal(explore.status, 'running')
    assert.equal(denied.agent_type, 'worker')
    assert.equal(denied.status, 'denied')
    assert.equal(denied.error, '预算超限')
  } finally {
    dm.close()
  }
})

test('markOrphanRunningAsLost：只动 running 行，done/error 行不变', { skip: skipReason ?? false }, () => {
  if (!DatabaseManagerCtor) return
  const dbPath = makeTempDbFile()
  const dm = new DatabaseManagerCtor(dbPath)
  try {
    const convId = dm.createConversation('t', 'avatar-x')

    dm.upsertSubAgentTask({
      id: 'r-1', conversation_id: convId, parent_avatar_id: 'avatar-x',
      target_avatar: null, task: 'r', status: 'running',
      result: null, error: null, started_at: 1, finished_at: null, agent_type: null,
    })
    dm.upsertSubAgentTask({
      id: 'd-1', conversation_id: convId, parent_avatar_id: 'avatar-x',
      target_avatar: null, task: 'd', status: 'done',
      result: 'ok', error: null, started_at: 2, finished_at: 3, agent_type: null,
    })
    dm.upsertSubAgentTask({
      id: 'e-1', conversation_id: convId, parent_avatar_id: 'avatar-x',
      target_avatar: null, task: 'e', status: 'error',
      result: null, error: 'boom', started_at: 4, finished_at: 5, agent_type: null,
    })

    const changed = dm.markOrphanRunningAsLost()
    assert.equal(changed, 1, '只应改 1 行')

    const rows = dm.listSubAgentTasksByConversation(convId)
    const r = rows.find((x) => x.id === 'r-1')!
    const d = rows.find((x) => x.id === 'd-1')!
    const e = rows.find((x) => x.id === 'e-1')!
    assert.equal(r.status, 'lost')
    assert.match(r.error ?? '', /重启时任务丢失/)
    assert.ok(typeof r.finished_at === 'number', 'lost 行应填 finished_at')
    assert.equal(d.status, 'done', 'done 行不应被动')
    assert.equal(e.status, 'error', 'error 行不应被动')
  } finally {
    dm.close()
  }
})
