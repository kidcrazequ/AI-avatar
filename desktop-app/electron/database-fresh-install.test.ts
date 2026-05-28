/**
 * fresh install schema 完整性回归测试。
 *
 * 背景：createBaseSchema 之前缺 v18（projects 表）与 v19（messages.tool_call_timeline_json），
 * 全新用户首次启动后调 list-project-ids / saveMessage 立即报 "no such
 * table/column"。增量迁移路径覆盖了，但 fresh install 走的是 createBaseSchema
 * 一次性建库 + 把 schema_version 直接写到 CURRENT_SCHEMA_VERSION，跳过所有迁移。
 *
 * 本测试模拟新装：建一个空 .db 文件 → new DatabaseManager → 直接验证 v18/v19
 * 引入的表/列都能正常使用。
 *
 * @author zhi.qu
 * @date 2026-05-28
 */

import fs from 'fs'
import os from 'os'
import path from 'path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

// ─── electron stub（与 database-attachments.test.ts 同款套路） ──────────────
const TMP_USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-db-fresh-userdata-'))
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
let loadError: string | null = null
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require('./database') as typeof import('./database')
  DatabaseManagerCtor = mod.DatabaseManager
  // 探测 better-sqlite3 ABI（系统 Node 跑 tsx 时常见不匹配）
  const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-db-fresh-probe-'))
  const probe = new DatabaseManagerCtor(path.join(probeDir, 'probe.db'))
  probe.close()
} catch (err) {
  loadError = err instanceof Error ? err.message : String(err)
  DatabaseManagerCtor = null
}
const skipReason = loadError
  ? `跳过：本测试需要 better-sqlite3 原生绑定与当前 Node ABI 匹配（${loadError.split('\n')[0]}）`
  : null

function makeFreshDbFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-db-fresh-'))
  return path.join(dir, 'fresh.db')
}

test('fresh install: createBaseSchema 包含 projects 表（v18）', { skip: skipReason ?? undefined }, () => {
  const db = new DatabaseManagerCtor!(makeFreshDbFile())
  // createProject 直接打 SQL，缺表就会立刻抛 "no such table: projects"
  const projectId = db.createProject('avatar-x', 'proj-alpha', 'desc')
  assert.ok(typeof projectId === 'string' && projectId.length > 0, 'createProject 应返回非空 id')

  const projects = db.listProjects('avatar-x')
  assert.equal(projects.length, 1)
  assert.equal(projects[0].name, 'proj-alpha')
  assert.equal(projects[0].avatar_id, 'avatar-x')
  db.close()
})

test('fresh install: messages.tool_call_timeline_json 列存在（v19）', { skip: skipReason ?? undefined }, () => {
  const db = new DatabaseManagerCtor!(makeFreshDbFile())
  db.ensureConversation('conv-fresh', '测试', 'avatar-x')
  // saveMessage 带 timelineJson 走 prepareStatements 里的 insertMessage——
  // 缺列时立刻抛 "table messages has no column named tool_call_timeline_json"
  const id = db.saveMessage(
    'conv-fresh',
    'assistant',
    'hello',
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    JSON.stringify([{ id: 't1', name: 'search_knowledge' }]),
  )
  assert.ok(typeof id === 'string' && id.length > 0, 'saveMessage 应返回非空 id')

  const msgs = db.getMessages('conv-fresh')
  assert.equal(msgs.length, 1)
  assert.ok(
    typeof msgs[0].tool_call_timeline_json === 'string' && msgs[0].tool_call_timeline_json!.includes('search_knowledge'),
    'tool_call_timeline_json 应回读出工具时间线',
  )
  db.close()
})

test('fresh install: schema_version 写到 CURRENT_SCHEMA_VERSION', { skip: skipReason ?? undefined }, () => {
  const dbFile = makeFreshDbFile()
  const db = new DatabaseManagerCtor!(dbFile)
  db.close()

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require('better-sqlite3') as typeof import('better-sqlite3')
  const raw = new Database(dbFile)
  const row = raw.prepare('SELECT version FROM schema_version').get() as { version: number } | undefined
  raw.close()
  assert.ok(row && row.version >= 19, `fresh install schema_version 应 >= 19，实际 ${row?.version}`)
})
