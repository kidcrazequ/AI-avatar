/**
 * v22 migration（A4 记忆系统改造）回归测试。
 *
 * 测试意图（Rule 9：编码 WHY）：
 *   ① v21 → v22 迁移后 memory_review_state 表存在且可用——后台复盘的
 *      "N 轮触发"游标全靠它，缺表会让复盘链路在首次 IPC 就抛错
 *   ② 迁移是纯新增：既有 conversations / messages 数据零变化
 *      （A4 红线：不回溯改写任何既有数据）
 *   ③ fresh install（createBaseSchema）同样含该表——增量路径和全新安装
 *      两条路都必须收敛到同一 schema
 *   ④ MemoryReviewStore 游标语义：user 轮计数只数游标之后的 user 消息，
 *      advanceCursor 后计数归零——这是"每 N 用户轮复盘一次"的判定根基
 *   ⑤ SessionSearchStore 三模式在真实 FTS5 上工作：search 命中 + 会话去重 +
 *      定时任务降权不排除、view 翻页、browse 列表——session_search 是
 *      "过程性内容不进记忆"的前提，坏了复盘负面清单就站不住
 *   ⑥ 迁移幂等：二次打开不抛错、游标数据不丢（仓库迁移测试既有惯例）
 *   ⑦ 会话删除时游标级联清理——answer_cache 曾因缺清理产生孤儿行残留，
 *      memory_review_state 用 FK ON DELETE CASCADE 从 schema 层杜绝同类问题
 *
 * 实现方式（与 database-v20-migration.test.ts 同款套路）：
 *   1. DatabaseManager 建全 schema → 降 schema_version 到 21 + DROP 新表
 *   2. 再 new DatabaseManager 触发 v22 migration
 *   3. 用 raw sqlite + 各 Store 校验
 *
 * @author zhi.qu
 * @date 2026-07-05
 */

import fs from 'fs'
import os from 'os'
import path from 'path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

// ─── electron stub（与 database-fresh-install.test.ts 同款套路） ────────────
const TMP_USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-db-v22-userdata-'))
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
let MemoryReviewStoreCtor: typeof import('./db-memory-review').MemoryReviewStore | null = null
let SessionSearchStoreCtor: typeof import('./db-session-search').SessionSearchStore | null = null
let runMemoryReviewOnceFn: typeof import('./memory-review').runMemoryReviewOnce | null = null
let loadError: string | null = null
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require('./database') as typeof import('./database')
  DatabaseManagerCtor = mod.DatabaseManager
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  BetterSqliteCtor = require('better-sqlite3') as typeof import('better-sqlite3')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  MemoryReviewStoreCtor = (require('./db-memory-review') as typeof import('./db-memory-review')).MemoryReviewStore
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  SessionSearchStoreCtor = (require('./db-session-search') as typeof import('./db-session-search')).SessionSearchStore
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  runMemoryReviewOnceFn = (require('./memory-review') as typeof import('./memory-review')).runMemoryReviewOnce
  const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-db-v22-probe-'))
  const probe = new DatabaseManagerCtor(path.join(probeDir, 'probe.db'))
  probe.close()
} catch (err) {
  loadError = err instanceof Error ? err.message : String(err)
  DatabaseManagerCtor = null
}
const skipReason = loadError
  ? `跳过：本测试需要 better-sqlite3 原生绑定与当前 Node ABI 匹配（${loadError.split('\n')[0]}）`
  : null

/** 造一个 v21 状态的 DB 文件（无 memory_review_state 表），含既有会话/消息数据 */
function makeV21Db(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-db-v22-test-'))
  const dbFile = path.join(dir, 'v21.db')

  const init = new DatabaseManagerCtor!(dbFile)
  init.close()

  const raw = new BetterSqliteCtor!(dbFile)
  raw.prepare('UPDATE schema_version SET version = 21').run()
  raw.exec('DROP TABLE IF EXISTS memory_review_state')
  // 既有数据：一个会话 + 三条消息（迁移必须零触碰）
  raw.prepare(`
    INSERT INTO conversations (id, title, avatar_id, project_id, workspace_initialized, created_at, updated_at)
    VALUES ('c-1', '老会话', 'avatar-x', 'default', 0, 1000, 2000)
  `).run()
  const insertMsg = raw.prepare(`
    INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)
  `)
  insertMsg.run('m-1', 'c-1', 'user', '上海的分时电价怎么算', 1100)
  insertMsg.run('m-2', 'c-1', 'assistant', '按峰谷平三段计算……', 1200)
  insertMsg.run('m-3', 'c-1', 'user', '再帮我算下 IRR', 1300)
  raw.close()

  return dbFile
}

test('v22 migration: memory_review_state 表被创建且 schema_version 推进', { skip: skipReason ?? undefined }, () => {
  const dbFile = makeV21Db()
  const db = new DatabaseManagerCtor!(dbFile)
  db.close()
  const raw = new BetterSqliteCtor!(dbFile)
  const table = raw.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='memory_review_state'",
  ).get()
  const ver = raw.prepare('SELECT version FROM schema_version').get() as { version: number } | undefined
  raw.close()
  assert.ok(table, 'v22 migration 后 memory_review_state 表应存在')
  assert.ok(ver && ver.version >= 22, `schema_version 应 >= 22，实际 ${ver?.version}`)
})

test('v22 migration: 纯新增，既有会话/消息数据零变化', { skip: skipReason ?? undefined }, () => {
  const dbFile = makeV21Db()
  const db = new DatabaseManagerCtor!(dbFile)
  const msgs = db.getMessages('c-1')
  db.close()
  assert.equal(msgs.length, 3, '既有消息应原样保留')
  assert.equal(msgs[0].content, '上海的分时电价怎么算')
})

test('v22 fresh install: createBaseSchema 也含 memory_review_state（双路收敛）', { skip: skipReason ?? undefined }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-db-v22-fresh-'))
  const dbFile = path.join(dir, 'fresh.db')
  const db = new DatabaseManagerCtor!(dbFile)
  db.close()
  const raw = new BetterSqliteCtor!(dbFile)
  const table = raw.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='memory_review_state'",
  ).get()
  raw.close()
  assert.ok(table, 'fresh install 应直接建出 memory_review_state')
})

test('MemoryReviewStore: 游标之后才计 user 轮，advanceCursor 后归零', { skip: skipReason ?? undefined }, () => {
  const dbFile = makeV21Db()
  const db = new DatabaseManagerCtor!(dbFile)
  const store = new MemoryReviewStoreCtor!(db.getRawDb())

  // 游标 0：两条 user 消息都算
  assert.equal(store.countUserMessagesSince('c-1', 0), 2)
  const transcript = store.getTranscriptSince('c-1', 0)
  assert.equal(transcript.length, 3, 'user/assistant 都进转写（tool 消息不存在于本用例）')
  assert.equal(transcript[0].content, '上海的分时电价怎么算', '转写按时间升序')

  // 复盘完成推进游标 → 计数归零（"每 N 轮一次"的判定根基）
  store.advanceCursor('c-1', 'avatar-x', 1300)
  assert.equal(store.countUserMessagesSince('c-1', store.get('c-1')!.last_reviewed_message_created_at), 0)
  assert.equal(store.get('c-1')!.review_count, 1)

  // 再来一轮新消息 → 只数新的
  db.getRawDb().prepare(`
    INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES ('m-4', 'c-1', 'user', '新问题', 1400)
  `).run()
  assert.equal(store.countUserMessagesSince('c-1', 1300), 1)
  db.close()
})

test('v22 migration: 二次打开幂等，游标数据不丢', { skip: skipReason ?? undefined }, () => {
  const dbFile = makeV21Db()
  const db1 = new DatabaseManagerCtor!(dbFile)
  const store1 = new MemoryReviewStoreCtor!(db1.getRawDb())
  store1.advanceCursor('c-1', 'avatar-x', 1300)
  db1.close()
  // 第二次打开（模拟正常重启）：不抛错、已有游标行原样保留
  const db2 = new DatabaseManagerCtor!(dbFile)
  const store2 = new MemoryReviewStoreCtor!(db2.getRawDb())
  const row = store2.get('c-1')
  db2.close()
  assert.ok(row, '重启后游标行应保留')
  assert.equal(row!.last_reviewed_message_created_at, 1300)
  assert.equal(row!.review_count, 1)
})

test('runMemoryReviewOnce: 会话不属于该分身时拒绝（跨分身 IDOR 防护）', { skip: skipReason ?? undefined }, async () => {
  // WHY：不校验归属时，(avatarId, conversationId) 错配的一次调用就能把
  // 分身 B 的私密会话内容摘要写进分身 A 的持久记忆，且下个 session 静默生效
  const dbFile = makeV21Db()
  const db = new DatabaseManagerCtor!(dbFile)
  const store = new MemoryReviewStoreCtor!(db.getRawDb())
  const res = await runMemoryReviewOnceFn!({
    avatarsPath: fs.mkdtempSync(path.join(os.tmpdir(), 'soul-mem-idor-')),
    avatarId: 'avatar-other',   // c-1 实际属于 avatar-x
    conversationId: 'c-1',
    reviewTurns: 1,
    store,
    callLLM: async () => { throw new Error('归属校验失败前不应触发 LLM 调用') },
  })
  db.close()
  assert.equal(res.ok, false)
  assert.match(res.reason ?? '', /不属于该分身/)
})

test('memory_review_state: 会话删除时游标级联清理（防孤儿行）', { skip: skipReason ?? undefined }, () => {
  const dbFile = makeV21Db()
  const db = new DatabaseManagerCtor!(dbFile)
  const store = new MemoryReviewStoreCtor!(db.getRawDb())
  store.advanceCursor('c-1', 'avatar-x', 1300)
  db.deleteConversation('c-1')
  const row = db.getRawDb()
    .prepare('SELECT * FROM memory_review_state WHERE conversation_id = ?')
    .get('c-1')
  db.close()
  assert.equal(row, undefined, '删除会话后游标行不应残留（FK ON DELETE CASCADE）')
})

test('SessionSearchStore: search 命中 + 会话去重 + 定时任务降权不排除；view/browse 可用', { skip: skipReason ?? undefined }, () => {
  const dbFile = makeV21Db()
  const db = new DatabaseManagerCtor!(dbFile)
  const raw = db.getRawDb()
  // 第二个会话（普通）+ 第三个会话（定时任务产物），都含关键词"电价"
  raw.prepare(`
    INSERT INTO conversations (id, title, avatar_id, project_id, workspace_initialized, created_at, updated_at)
    VALUES ('c-2', '普通会话', 'avatar-x', 'default', 0, 3000, 4000)
  `).run()
  raw.prepare(`
    INSERT INTO conversations (id, title, avatar_id, project_id, workspace_initialized, created_at, updated_at)
    VALUES ('c-cron', '定时报告', 'avatar-x', 'default', 0, 5000, 6000)
  `).run()
  const insertMsg = raw.prepare(`
    INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)
  `)
  insertMsg.run('m-c2-1', 'c-2', 'user', '江苏的电价政策有更新吗', 3100)
  insertMsg.run('m-c2-2', 'c-2', 'assistant', '有，江苏 2026 电价新政……', 3200)
  insertMsg.run('m-cron-1', 'c-cron', 'assistant', '每日电价播报：今日峰谷价差……', 5100)
  // 把 c-cron 标记为定时任务会话（schedules.conversation_id 路径）
  raw.prepare(`
    INSERT INTO schedules (id, name, avatar_id, project_id, conversation_id, cron_expr, timezone, prompt_text, enabled, next_run_at, created_at, updated_at)
    VALUES ('sched-1', '日报', 'avatar-x', 'default', 'c-cron', '0 9 * * *', 'Asia/Shanghai', '播报电价', 1, NULL, 0, 0)
  `).run()

  const store = new SessionSearchStoreCtor!(raw)

  // search：三个会话都含"电价"；当前会话 c-1 被排除；剩下 c-2 与 c-cron
  const out = store.search({ avatarId: 'avatar-x', query: '电价', excludeConversationId: 'c-1' })
  assert.ok(out.includes('c-2'), 'search 应命中普通会话 c-2')
  assert.ok(out.includes('c-cron'), '定时任务会话应降权但不排除（仍出现在结果里）')
  assert.ok(out.includes('定时任务会话'), '定时任务会话应带标记')
  assert.ok(!out.includes('会话 c-1「'), '当前会话应从 search 结果排除')
  // 会话去重：c-2 有两条命中消息，但只出现一个会话块
  assert.equal(out.split('── 会话 c-2').length - 1, 1, '同会话多命中应去重为一个块')

  // view：按 conversation_id 翻页；不属于该分身的会话拒绝
  const view = store.view({ avatarId: 'avatar-x', conversationId: 'c-2', offset: 0, limit: 1 })
  assert.ok(view.includes('1-1 / 共 2 条'), 'view 应分页并给出总数')
  assert.ok(view.includes('offset=1'), 'view 未读完时应提示翻页 offset')
  const viewDenied = store.view({ avatarId: 'other-avatar', conversationId: 'c-2' })
  assert.ok(viewDenied.includes('不存在或不属于'), '跨分身 view 应拒绝')

  // browse：列表含消息数与定时任务标记
  const browse = store.browse({ avatarId: 'avatar-x' })
  assert.ok(browse.includes('c-cron') && browse.includes('[定时任务]'), 'browse 应标记定时任务会话')
  assert.ok(browse.includes('c-2'), 'browse 应列出普通会话')

  db.close()
})
