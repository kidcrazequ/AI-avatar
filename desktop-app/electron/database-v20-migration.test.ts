/**
 * v20 migration 回归测试。
 *
 * 覆盖四个场景：
 *   ① 'default' 实体 project 行被删除（v18 早期版本把 default 当真实项目插了）
 *   ② 含 ../ 等非法 name 的 project 行删除 + 受影响会话迁到 default
 *   ③ conversations.project_id 含非法字符且无对应 project 行 → 迁到 default
 *   ④ 合法但 projects 表无对应行的孤儿会话 → 补回 projects 行（保留用户分组）
 *
 * 实现方式：
 *   1. 用 DatabaseManager 一次性建库到 v20（createBaseSchema 完整建表）
 *   2. 用 better-sqlite3 直接 UPDATE schema_version 回 19 + 插脏数据
 *   3. 再 new DatabaseManager 触发 v20 migration
 *   4. 用 listProjects / getConversations 校验
 *
 * @author zhi.qu
 * @date 2026-05-28
 */

import fs from 'fs'
import os from 'os'
import path from 'path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

// ─── electron stub（与 database-fresh-install.test.ts 同款套路） ────────────
const TMP_USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-db-v20-userdata-'))
const electronStubExports = {
  app: { getPath: (_key: string) => TMP_USER_DATA },
  shell: {},
  ipcMain: { handle: () => undefined, on: () => undefined },
}
const electronResolvedId = (() => {
  try { return require.resolve('electron') } catch { return 'electron' }
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
let BetterSqliteCtor: typeof import('better-sqlite3') | null = null
let loadError: string | null = null
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require('./database') as typeof import('./database')
  DatabaseManagerCtor = mod.DatabaseManager
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  BetterSqliteCtor = require('better-sqlite3') as typeof import('better-sqlite3')
  const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-db-v20-probe-'))
  const probe = new DatabaseManagerCtor(path.join(probeDir, 'probe.db'))
  probe.close()
} catch (err) {
  loadError = err instanceof Error ? err.message : String(err)
  DatabaseManagerCtor = null
}
const skipReason = loadError
  ? `跳过：本测试需要 better-sqlite3 原生绑定与当前 Node ABI 匹配（${loadError.split('\n')[0]}）`
  : null

/**
 * 造一个 v19 状态的 DB 文件，含四个场景的脏数据。
 * 先用 DatabaseManager 建全 schema → 降级 schema_version 到 19 → 插脏数据。
 */
function makeV19DirtyDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-db-v20-test-'))
  const dbFile = path.join(dir, 'v19-dirty.db')

  // 一次性建出完整 schema（DatabaseManager 会自动把 schema_version 设到 20）
  const init = new DatabaseManagerCtor!(dbFile)
  init.close()

  // 降级到 v19 + 插脏数据
  const raw = new BetterSqliteCtor!(dbFile)
  raw.prepare('UPDATE schema_version SET version = 19').run()
  const insertProj = raw.prepare(`
    INSERT INTO projects (id, avatar_id, name, description, archived, created_at, updated_at)
    VALUES (?, ?, ?, ?, 0, 0, 0)
  `)
  const insertConv = raw.prepare(`
    INSERT INTO conversations (id, title, avatar_id, project_id, workspace_initialized, created_at, updated_at)
    VALUES (?, ?, ?, ?, 0, 0, 0)
  `)
  // ① 'default' 项目行
  insertProj.run('p-def', 'avatar-x', 'default', '')
  // ② 非法 name + 该项目下的会话
  insertProj.run('p-bad', 'avatar-x', '../etc', '')
  insertConv.run('c-bad', 't', 'avatar-x', '../etc')
  // ③ 非法 conversation project_id（无对应 project 行）
  insertConv.run('c-orphan-bad', 't', 'avatar-x', 'has/slash')
  // ④ 合法但孤儿的 conversation project_id（projects 表没行）
  insertConv.run('c-orphan-legal', 't', 'avatar-x', 'client-a')
  // 对照：正常 project + 普通会话
  insertProj.run('p-ok', 'avatar-x', 'proj-ok', '')
  insertConv.run('c-ok', 't', 'avatar-x', 'proj-ok')
  raw.close()

  return dbFile
}

test('v20 migration: ① default 实体 project 行被删除', { skip: skipReason ?? undefined }, () => {
  const dbFile = makeV19DirtyDb()
  const db = new DatabaseManagerCtor!(dbFile)
  const projects = db.listProjects('avatar-x')
  db.close()
  assert.equal(
    projects.find(p => p.name === 'default'),
    undefined,
    'default 实体 project 行应被删除（保留虚拟桶语义）',
  )
  // 对照：合法项目应保留
  assert.ok(projects.find(p => p.name === 'proj-ok'), '合法 project 应保留')
})

test('v20 migration: ② 非法 name project 删除 + 会话迁 default', { skip: skipReason ?? undefined }, () => {
  const dbFile = makeV19DirtyDb()
  const db = new DatabaseManagerCtor!(dbFile)
  const projects = db.listProjects('avatar-x')
  const convBad = db.getConversation('c-bad')
  db.close()
  assert.equal(
    projects.find(p => p.name === '../etc'),
    undefined,
    '非法 name project 行应被删除',
  )
  assert.ok(convBad, 'c-bad 会话应仍存在')
  assert.equal(convBad!.project_id, 'default', '受影响会话应迁到 default 桶')
})

test('v20 migration: ③ 非法 conv project_id 迁 default', { skip: skipReason ?? undefined }, () => {
  const dbFile = makeV19DirtyDb()
  const db = new DatabaseManagerCtor!(dbFile)
  const conv = db.getConversation('c-orphan-bad')
  db.close()
  assert.ok(conv, 'c-orphan-bad 会话应仍存在')
  assert.equal(conv!.project_id, 'default', '非法 project_id 应迁到 default')
})

test('v20 migration: ④ 合法孤儿 project_id 补回 projects 行', { skip: skipReason ?? undefined }, () => {
  const dbFile = makeV19DirtyDb()
  const db = new DatabaseManagerCtor!(dbFile)
  const projects = db.listProjects('avatar-x')
  const conv = db.getConversation('c-orphan-legal')
  db.close()
  const backfilled = projects.find(p => p.name === 'client-a')
  assert.ok(backfilled, '合法孤儿 project 应被补回 projects 行（保留用户分组）')
  assert.equal(backfilled!.avatar_id, 'avatar-x')
  assert.ok(conv, 'c-orphan-legal 会话应仍存在')
  assert.equal(conv!.project_id, 'client-a', '合法孤儿会话 project_id 保留不变（workspace 路径不变）')
})

test('v20 migration: schema_version 推进到 20', { skip: skipReason ?? undefined }, () => {
  const dbFile = makeV19DirtyDb()
  const db = new DatabaseManagerCtor!(dbFile)
  db.close()
  const raw = new BetterSqliteCtor!(dbFile)
  const row = raw.prepare('SELECT version FROM schema_version').get() as { version: number } | undefined
  raw.close()
  assert.ok(row && row.version === 20, `v20 migration 后 schema_version 应 === 20，实际 ${row?.version}`)
})
