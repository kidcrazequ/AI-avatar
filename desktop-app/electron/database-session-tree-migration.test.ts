/**
 * v21 会话树底座 migration 回归测试（借鉴 Pi 树状会话）。
 *
 * 覆盖：
 *   ① 全新安装：messages.parent_id / conversations.leaf_message_id 列存在，schema_version=21
 *   ② v20→v21 升级：历史扁平消息被回填成线性父链，leaf 指向最后一条
 *   ③ saveMessage 持续维护：每存一条 parent_id 指向上一条、leaf 推进到本条
 *   ④ 迁移幂等：二次构造不抛错、不破坏已回填数据
 *
 * 实现：DatabaseManager 建全 schema（v21）→ 用 better-sqlite3 把 schema_version 降回 20
 * 且把 parent_id/leaf 置 NULL（模拟"无树链的旧数据"）→ 再构造触发 v21 back-fill。
 * （不依赖 ALTER TABLE DROP COLUMN：safeAddColumn 的"加列"已被 fresh-install + 其它迁移覆盖，
 * 这里专测新增的 back-fill 逻辑。）
 *
 * @author zhi.qu
 * @date 2026-06-02
 */

import fs from 'fs'
import os from 'os'
import path from 'path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

// ─── electron stub（与 database-v20-migration.test.ts 同款套路） ───────────────
const TMP_USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-db-tree-userdata-'))
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
  const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-db-tree-probe-'))
  const probe = new DatabaseManagerCtor(path.join(probeDir, 'probe.db'))
  probe.close()
} catch (err) {
  loadError = err instanceof Error ? err.message : String(err)
  DatabaseManagerCtor = null
}
const skipReason = loadError
  ? `跳过：本测试需要 better-sqlite3 原生绑定与当前 Node ABI 匹配（${loadError.split('\n')[0]}）`
  : null

/** 造一个"v20 + 无树链"的 DB：建全 schema → 降版本到 20 + 置空 parent_id/leaf + 插扁平消息。 */
function makeV20FlatDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-db-tree-test-'))
  const dbFile = path.join(dir, 'v20-flat.db')
  const init = new DatabaseManagerCtor!(dbFile)
  init.close()

  const raw = new BetterSqliteCtor!(dbFile)
  raw.prepare('UPDATE schema_version SET version = 20').run()
  raw.prepare(`INSERT INTO conversations (id, title, avatar_id, project_id, workspace_initialized, created_at, updated_at, leaf_message_id)
               VALUES ('c1', 't', 'avatar-x', 'default', 0, 0, 0, NULL)`).run()
  const insMsg = raw.prepare(`INSERT INTO messages (id, conversation_id, role, content, created_at, parent_id)
                              VALUES (?, 'c1', ?, ?, ?, NULL)`)
  insMsg.run('m1', 'user', '问题一', 100)
  insMsg.run('m2', 'assistant', '回答一', 200)
  insMsg.run('m3', 'user', '问题二', 300)
  raw.close()
  return dbFile
}

test('① 全新安装：parent_id/leaf_message_id 列存在，schema_version=21', { skip: skipReason ?? undefined }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-db-tree-fresh-'))
  const dbFile = path.join(dir, 'fresh.db')
  const db = new DatabaseManagerCtor!(dbFile)
  const convId = db.createConversation('新会话', 'avatar-x')
  db.saveMessage(convId, 'user', 'hi')
  const msgs = db.getMessages(convId)
  db.close()

  assert.ok('parent_id' in msgs[0], 'messages 应有 parent_id 列')
  const raw = new BetterSqliteCtor!(dbFile)
  const ver = (raw.prepare('SELECT version FROM schema_version').get() as { version: number }).version
  const convCols = (raw.prepare(`PRAGMA table_info(conversations)`).all() as Array<{ name: string }>).map(c => c.name)
  raw.close()
  assert.equal(ver, 21)
  assert.ok(convCols.includes('leaf_message_id'), 'conversations 应有 leaf_message_id 列')
})

test('② v20→v21 升级：扁平消息回填成线性父链，leaf=最后一条', { skip: skipReason ?? undefined }, () => {
  const dbFile = makeV20FlatDb()
  const db = new DatabaseManagerCtor!(dbFile) // 构造即触发 v21 back-fill
  const msgs = db.getMessages('c1')
  const conv = db.getConversation('c1')
  db.close()

  const byId = new Map(msgs.map(m => [m.id, m]))
  assert.equal(byId.get('m1')!.parent_id ?? null, null, 'm1 是根，parent_id 应为 null')
  assert.equal(byId.get('m2')!.parent_id, 'm1', 'm2 应指向 m1')
  assert.equal(byId.get('m3')!.parent_id, 'm2', 'm3 应指向 m2')
  assert.equal(conv!.leaf_message_id, 'm3', 'leaf 应指向最后一条 m3')
})

test('③ saveMessage 持续维护父链 + 推进 leaf', { skip: skipReason ?? undefined }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-db-tree-save-'))
  const db = new DatabaseManagerCtor!(path.join(dir, 'save.db'))
  const convId = db.createConversation('会话', 'avatar-x')
  const id1 = db.saveMessage(convId, 'user', '一')
  const id2 = db.saveMessage(convId, 'assistant', '二')
  const msgs = db.getMessages(convId)
  const conv = db.getConversation(convId)
  db.close()

  const m1 = msgs.find(m => m.id === id1)!
  const m2 = msgs.find(m => m.id === id2)!
  assert.equal(m1.parent_id ?? null, null, '首条根消息 parent_id 为 null')
  assert.equal(m2.parent_id, id1, '第二条 parent_id 指向第一条')
  assert.equal(conv!.leaf_message_id, id2, 'leaf 推进到最新一条')
})

test('④ 迁移幂等：二次构造不抛错、回填数据不被破坏', { skip: skipReason ?? undefined }, () => {
  const dbFile = makeV20FlatDb()
  const first = new DatabaseManagerCtor!(dbFile)
  first.close()
  const second = new DatabaseManagerCtor!(dbFile) // 已是 v21，再开应无副作用
  const conv = second.getConversation('c1')
  const m3 = second.getMessages('c1').find(m => m.id === 'm3')!
  second.close()
  assert.equal(conv!.leaf_message_id, 'm3')
  assert.equal(m3.parent_id, 'm2')
})

test('⑤ getActivePathMessages 线性会话 == getMessages（零行为变化）', { skip: skipReason ?? undefined }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-db-tree-active-'))
  const db = new DatabaseManagerCtor!(path.join(dir, 'a.db'))
  const conv = db.createConversation('会话', 'avatar-x')
  db.saveMessage(conv, 'user', '一')
  db.saveMessage(conv, 'assistant', '二')
  db.saveMessage(conv, 'user', '三')
  const all = db.getMessages(conv).map((m) => m.id)
  const active = db.getActivePathMessages(conv).map((m) => m.id)
  db.close()
  assert.deepEqual(active, all, '无分叉时活动路径必须等于全量线性顺序')
})

test('⑥ fork：换个思路重答另起分支，活动路径排除旧分支、全量仍含', { skip: skipReason ?? undefined }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-db-tree-fork-'))
  const db = new DatabaseManagerCtor!(path.join(dir, 'f.db'))
  const conv = db.createConversation('会话', 'avatar-x')
  const a = db.saveMessage(conv, 'user', '问题')
  const b = db.saveMessage(conv, 'assistant', '旧回答')
  // 从 user 消息 a 分叉（leaf 指回 a），再存新回答 c → c 以 a 为父，b 落到旁支
  assert.equal(db.forkConversationFromMessage(conv, a), true)
  const c = db.saveMessage(conv, 'assistant', '新回答')
  const active = db.getActivePathMessages(conv).map((m) => m.id)
  const all = db.getMessages(conv).map((m) => m.id)
  db.close()
  assert.deepEqual(active, [a, c], '活动路径应为 [问题, 新回答]，不含旧回答 b')
  assert.ok(all.includes(b), '旧回答仍在库里（全量含，可供切回）')
  assert.equal(all.length, 3)
})

test('⑦ forkConversationFromMessage 非本会话消息 → false', { skip: skipReason ?? undefined }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-db-tree-fork2-'))
  const db = new DatabaseManagerCtor!(path.join(dir, 'f2.db'))
  const conv = db.createConversation('会话', 'avatar-x')
  db.saveMessage(conv, 'user', 'x')
  const ok = db.forkConversationFromMessage(conv, 'nonexistent-id')
  db.close()
  assert.equal(ok, false)
})

test('⑧ 删除 leaf 消息（重新生成场景）：leaf 修复到父，活动路径不断裂', { skip: skipReason ?? undefined }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-db-tree-del-'))
  const db = new DatabaseManagerCtor!(path.join(dir, 'd.db'))
  const conv = db.createConversation('会话', 'avatar-x')
  const a = db.saveMessage(conv, 'user', '问题')
  const b = db.saveMessage(conv, 'assistant', '回答') // leaf=b
  db.deleteMessage(b) // 重新生成：删掉末条 assistant
  const conv2 = db.getConversation(conv)
  const active = db.getActivePathMessages(conv).map((m) => m.id)
  db.close()
  assert.equal(conv2!.leaf_message_id, a, 'leaf 应从被删的 b 修复到其父 a')
  assert.deepEqual(active, [a], '活动路径不悬空、不退回错乱')
})
