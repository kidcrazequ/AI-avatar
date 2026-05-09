/**
 * database.ts mcp_servers 表的全新安装与升级路径单测（#5.5 修复回归保护）。
 *
 * 背景：v6 引入 `mcp_servers` 表时只在 v5→v6 migration 中 CREATE，没有同步加进
 *      `createBaseSchema()`。结果全新安装走「无 conversations 表 → createBaseSchema +
 *      直接写入 schema_version=CURRENT」的分支，跳过所有 migration，导致 mcp_servers
 *      表缺失，main.ts 在启动后调用 `listMcpServers()` 时抛 "no such table: mcp_servers"。
 *      老用户因为已经走过 v5→v6 migration 不会暴露。
 *
 * 验证点：
 *   1. 全新安装：createBaseSchema 必须建出 mcp_servers，schema_version=CURRENT_SCHEMA_VERSION，
 *      且能正常 upsert / 取回数据。
 *   2. v5 老库升级：手动构造 v5 状态（schema_version=5 + 已有 conversations 表），
 *      让 initialize 走 `runMigrations(5)` 分支，验证升级后 mcp_servers 可用且
 *      schema_version 推进到 CURRENT_SCHEMA_VERSION。
 *   3. 重复初始化幂等：同一 db 文件多次开关，mcp_servers 表保持单实例、不重复迁移、不丢数据。
 *
 * 实现注意：
 *   - 与 database-attachments.test.ts 相同：`database.ts` 顶部 `import { app } from 'electron'`，
 *     tsx 直接跑会因为 electron 仅在 Electron 运行时存在而失败；这里在 require('./database')
 *     之前用 require.cache 注入一个最小 stub。
 *   - better-sqlite3 是原生模块，按 Electron ABI 编译时与系统 Node 的 ABI 不兼容；探测失败
 *     时整个 suite 优雅 skip（与 database-attachments.test.ts 一致）。
 *
 * @author zhi.qu
 * @date 2026-05-09
 */

import fs from 'fs'
import os from 'os'
import path from 'path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'

// ─── 注入 electron stub（必须在 require('./database') 之前）─────────────
const TMP_USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-db-mcp-test-userdata-'))
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

// ─── stub 完成后再加载真实模块 ──────────────────────────────────────────
let DatabaseManagerCtor: typeof import('./database').DatabaseManager | null = null
let loadError: string | null = null
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require('./database') as typeof import('./database')
  DatabaseManagerCtor = mod.DatabaseManager
  // 触发 better-sqlite3 ABI 校验（lazy 加载需要实际 new 才会绑定）
  const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-db-mcp-test-probe-'))
  const probe = new DatabaseManagerCtor(path.join(probeDir, 'probe.db'))
  probe.close()
} catch (err) {
  loadError = err instanceof Error ? err.message : String(err)
  DatabaseManagerCtor = null
}
const skipReason = loadError
  ? `跳过：本测试需要 better-sqlite3 原生绑定与当前 Node ABI 匹配（${loadError.split('\n')[0]}）`
  : null

/** 当前期望的最低 schema 版本：与 database.ts 中 CURRENT_SCHEMA_VERSION 同步维护 */
const EXPECTED_MIN_SCHEMA_VERSION = 8

function makeTempDbFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-db-mcp-test-'))
  return path.join(dir, 'test.db')
}

/**
 * 直接读 sqlite_master 检查表是否存在（绕开任何缓存语句）。
 */
function tableExists(dbPath: string, tableName: string): boolean {
  const raw = new Database(dbPath, { readonly: true })
  try {
    const row = raw
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
      .get(tableName) as { name?: string } | undefined
    return !!row?.name
  } finally {
    raw.close()
  }
}

/**
 * 读 schema_version.version；不存在则返回 undefined。
 */
function readSchemaVersion(dbPath: string): number | undefined {
  const raw = new Database(dbPath, { readonly: true })
  try {
    const row = raw
      .prepare('SELECT version FROM schema_version')
      .get() as { version?: number } | undefined
    return row?.version
  } finally {
    raw.close()
  }
}

/**
 * 数 mcp_servers 表行数；表不存在时抛错（让用例层显式捕获）。
 */
function countMcpServers(dbPath: string): number {
  const raw = new Database(dbPath, { readonly: true })
  try {
    const row = raw.prepare('SELECT COUNT(*) AS c FROM mcp_servers').get() as { c: number }
    return row.c
  } finally {
    raw.close()
  }
}

/**
 * 在 dbPath 处构造一个「v5 状态」的旧库：
 *   - schema_version = 5
 *   - conversations / messages / settings / messages_fts / prompt_templates 等
 *     v5 之前 migration 已建出的表都在
 *   - 但 mcp_servers / agent_tasks / attachments 都不存在
 *
 * 这样后续 DatabaseManager 打开同一文件时，会走 `runMigrations(5)` 分支，
 * 触发 v5→v6（mcp_servers）/v6→v7（agent_tasks）/v7→v8（attachments）连续升级。
 */
function seedV5Database(dbPath: string): void {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  const raw = new Database(dbPath)
  raw.pragma('foreign_keys = ON')
  raw.pragma('journal_mode = WAL')
  raw.exec(`
    CREATE TABLE schema_version (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      version INTEGER NOT NULL DEFAULT 1
    );
    INSERT INTO schema_version (id, version) VALUES (1, 5);

    CREATE TABLE conversations (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      avatar_id TEXT NOT NULL DEFAULT '',
      workspace_initialized INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      tool_call_id TEXT,
      image_urls TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    );

    CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE INDEX idx_messages_conversation
      ON messages(conversation_id, created_at);

    CREATE VIRTUAL TABLE messages_fts USING fts5(
      content,
      content='messages',
      content_rowid='rowid'
    );

    CREATE TABLE prompt_templates (
      id TEXT PRIMARY KEY,
      avatar_id TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX idx_prompt_templates_avatar
      ON prompt_templates(avatar_id, created_at);
  `)
  raw.close()
}

// ────────────────────────────── 测试用例 ──────────────────────────────

test('mcp_servers: 全新安装 createBaseSchema 必须建出该表', { skip: skipReason ?? undefined }, () => {
  const dbPath = makeTempDbFile()
  // 全新初始化：走「无 conversations 表 → createBaseSchema + 直接写 schema_version=CURRENT」分支
  const db = new DatabaseManagerCtor!(dbPath)

  try {
    // 1) 表必须存在 —— 这是 #5.5 的核心修复点
    assert.ok(tableExists(dbPath, 'mcp_servers'), '全新安装后 mcp_servers 表必须存在')

    // 2) schema_version 必须 ≥ EXPECTED_MIN_SCHEMA_VERSION（CURRENT_SCHEMA_VERSION）
    const version = readSchemaVersion(dbPath)
    assert.ok(typeof version === 'number', 'schema_version 必须可读')
    assert.ok(
      version! >= EXPECTED_MIN_SCHEMA_VERSION,
      `schema_version 应 ≥ ${EXPECTED_MIN_SCHEMA_VERSION}，实际为 ${version}`,
    )

    // 3) 写入 / 读回链路通畅，证明表结构与 database.ts 中的 upsert/list SQL 完全匹配
    db.upsertMcpServer({
      name: 'echo-stdio',
      enabled: true,
      transport: 'stdio',
      command: 'node',
      args: ['echo.js'],
      env: { FOO: 'bar' },
      description: '测试用 echo server',
    })
    const list = db.listMcpServers()
    assert.equal(list.length, 1, '应能列出刚刚 upsert 的 1 条记录')
    assert.equal(list[0].name, 'echo-stdio')
    assert.equal(list[0].enabled, true)
    assert.equal(list[0].transport, 'stdio')
    assert.deepEqual(list[0].args, ['echo.js'])
    assert.deepEqual(list[0].env, { FOO: 'bar' })

    const single = db.getMcpServer('echo-stdio')
    assert.ok(single, '按 name 取单条应能命中')
    assert.equal(single!.command, 'node')
  } finally {
    db.close()
  }
})

test('mcp_servers: v5 老库升级 runMigrations 后表存在且数据可写', { skip: skipReason ?? undefined }, () => {
  const dbPath = makeTempDbFile()

  // 1) 手动构造 v5 状态（schema_version=5 + v5 所有表，但缺 mcp_servers / agent_tasks / attachments）
  seedV5Database(dbPath)
  // 防御性断言：确认种子库确实没有 mcp_servers
  assert.ok(!tableExists(dbPath, 'mcp_servers'), '前置条件：v5 种子库不应有 mcp_servers 表')
  assert.equal(readSchemaVersion(dbPath), 5, '前置条件：v5 种子库 schema_version=5')

  // 2) 用 DatabaseManager 打开同一文件，会走 initialize 的「已有数据库 → runMigrations(5)」分支
  const db = new DatabaseManagerCtor!(dbPath)
  try {
    // 3) 升级后 mcp_servers 必须存在（v5→v6 migration 命中），且 schema_version 推进到 CURRENT
    assert.ok(tableExists(dbPath, 'mcp_servers'), 'v5 升级后 mcp_servers 表必须存在')

    const version = readSchemaVersion(dbPath)
    assert.ok(
      typeof version === 'number' && version >= EXPECTED_MIN_SCHEMA_VERSION,
      `升级后 schema_version 应推进到 ≥ ${EXPECTED_MIN_SCHEMA_VERSION}，实际为 ${version}`,
    )

    // 4) 升级路径建出的表应能正常承载业务数据
    db.upsertMcpServer({
      name: 'http-server',
      enabled: false,
      transport: 'http',
      url: 'http://127.0.0.1:8080/mcp',
      timeout_ms: 5000,
    })
    const back = db.getMcpServer('http-server')
    assert.ok(back, '升级路径建出的 mcp_servers 表应能写入并读回')
    assert.equal(back!.transport, 'http')
    assert.equal(back!.url, 'http://127.0.0.1:8080/mcp')
    assert.equal(back!.timeout_ms, 5000)
    assert.equal(back!.enabled, false)
  } finally {
    db.close()
  }
})

test('mcp_servers: 重复初始化幂等且不丢数据', { skip: skipReason ?? undefined }, () => {
  const dbPath = makeTempDbFile()

  // 1) 全新初始化并写入 1 条
  const first = new DatabaseManagerCtor!(dbPath)
  first.upsertMcpServer({
    name: 'persisted',
    enabled: true,
    transport: 'stdio',
    command: 'cat',
  })
  assert.equal(countMcpServers(dbPath), 1, '首次写入后应有 1 条')
  first.close()

  // 2) 重新打开同一文件 —— 此时 schema_version 已是 CURRENT，runMigrations 应是 no-op
  const second = new DatabaseManagerCtor!(dbPath)
  try {
    assert.ok(tableExists(dbPath, 'mcp_servers'), '二次开库 mcp_servers 表必须仍然存在')
    const list = second.listMcpServers()
    assert.equal(list.length, 1, '二次开库不应丢数据，也不应重复迁移产生新行')
    assert.equal(list[0].name, 'persisted')
    assert.equal(list[0].command, 'cat')

    // 3) 同 name upsert 不会产生新行（验证主键约束 + ON CONFLICT 路径在迁移后仍然有效）
    second.upsertMcpServer({
      name: 'persisted',
      enabled: false,
      transport: 'stdio',
      command: 'cat',
    })
    assert.equal(countMcpServers(dbPath), 1, 'upsert 同 name 不应产生新行')
    assert.equal(second.getMcpServer('persisted')!.enabled, false, 'upsert 应更新 enabled 字段')
  } finally {
    second.close()
  }
})
