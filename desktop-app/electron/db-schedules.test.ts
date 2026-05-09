/**
 * db-schedules.ts DAO 单测（#11 Scheduled Tasks · 子任务 1）。
 *
 * 验证点：
 *   1. ScheduleStore.create 写入并回读字段一致
 *   2. update 部分字段（保留未传字段）
 *   3. delete 触发 FOREIGN KEY ON DELETE CASCADE，schedule_runs 同步清理
 *   4. list 按创建时间倒序、avatar/enabled 过滤
 *   5. recordRunStart 幂等：同一 (schedule_id, fired_at_utc) 第二次写入返回 conflict
 *   6. recordRunFinish 状态机更新
 *   7. recordMissed UNIQUE 冲突静默返回 false
 *   8. listRuns 按 fired_at_utc 倒序
 *
 * 设计：不走 DatabaseManager，直接用 better-sqlite3 in-memory db + 手动 exec 表结构。
 * 这样测试聚焦在 DAO 行为，不依赖 electron 运行时与 schema 迁移路径
 * （迁移由独立的 database-schedules-migration.test.ts 验证）。
 *
 * @author zhi.qu
 * @date 2026-05-09
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

// 与 database-attachments.test.ts 同样的 ABI 探测：better-sqlite3 是原生模块，按 Electron ABI 编译，
// 系统 Node 直跑会抛 ERR_DLOPEN_FAILED，此时优雅跳过整个 suite。
type DatabaseModule = typeof import('better-sqlite3')
type DatabaseInstance = ReturnType<DatabaseModule>
let DatabaseCtor: DatabaseModule | null = null
let ScheduleStoreCtor: typeof import('./db-schedules').ScheduleStore | null = null
let loadError: string | null = null
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  DatabaseCtor = require('better-sqlite3') as DatabaseModule
  // 触发 ABI 校验：实例化一次再关
  const probe = new DatabaseCtor(':memory:')
  probe.close()
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require('./db-schedules') as typeof import('./db-schedules')
  ScheduleStoreCtor = mod.ScheduleStore
} catch (err) {
  loadError = err instanceof Error ? err.message : String(err)
  DatabaseCtor = null
}
const skipReason = loadError
  ? `跳过：本测试需要 better-sqlite3 原生绑定与当前 Node ABI 匹配（${loadError.split('\n')[0]}）`
  : null

/**
 * 在 in-memory db 上手动建出 schedules + schedule_runs 表（与 database.ts createBaseSchema 同步）。
 * 这里复制 SQL 而非反向调用 DatabaseManager，是为了让本测试不依赖 electron stub 与文件系统。
 */
function setupSchema(db: DatabaseInstance): void {
  db.pragma('foreign_keys = ON')
  db.exec(`
    CREATE TABLE IF NOT EXISTS schedules (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      avatar_id TEXT NOT NULL,
      project_id TEXT NOT NULL DEFAULT 'default',
      conversation_id TEXT,
      cron_expr TEXT NOT NULL,
      timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
      prompt_text TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      next_run_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS schedule_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      schedule_id TEXT NOT NULL,
      fired_at_utc INTEGER NOT NULL,
      status TEXT NOT NULL,
      conversation_id TEXT,
      duration_ms INTEGER,
      error_message TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (schedule_id) REFERENCES schedules(id) ON DELETE CASCADE,
      UNIQUE(schedule_id, fired_at_utc)
    );
  `)
}

function makeStore(): { db: DatabaseInstance; store: import('./db-schedules').ScheduleStore } {
  if (!DatabaseCtor || !ScheduleStoreCtor) {
    throw new Error('Database/Store 未加载（应已 skip）')
  }
  const db = new DatabaseCtor(':memory:')
  setupSchema(db)
  return { db, store: new ScheduleStoreCtor(db) }
}

test('db-schedules: create + get 字段往返一致', { skip: skipReason ?? false }, () => {
  const { db, store } = makeStore()
  try {
    const row = store.create({
      name: '每日早安',
      avatarId: 'xiaodu',
      cronExpr: '0 9 * * *',
      promptText: '今天写一句早安',
    })
    assert.match(row.id, /^sched_/)
    assert.equal(row.enabled, 1)
    assert.equal(row.project_id, 'default')
    assert.equal(row.timezone, 'Asia/Shanghai')
    assert.equal(row.conversation_id, null)
    assert.equal(row.next_run_at, null)
    assert.ok(row.created_at > 0)
    assert.equal(row.updated_at, row.created_at)

    const got = store.get(row.id)
    assert.deepEqual(got, row)
  } finally {
    db.close()
  }
})

test('db-schedules: update 仅修改传入字段，updated_at 刷新', { skip: skipReason ?? false }, async () => {
  const { db, store } = makeStore()
  try {
    const row = store.create({
      name: 'A',
      avatarId: 'av1',
      cronExpr: '* * * * *',
      promptText: 'p1',
    })
    // 等 2ms 让 updated_at 可观察变化
    await new Promise((r) => setTimeout(r, 2))
    const ok = store.update(row.id, { name: 'B', enabled: false })
    assert.equal(ok, true)
    const got = store.get(row.id)!
    assert.equal(got.name, 'B')
    assert.equal(got.enabled, 0)
    assert.equal(got.cron_expr, '* * * * *') // 未传，保留
    assert.equal(got.prompt_text, 'p1')      // 未传，保留
    assert.ok(got.updated_at > row.updated_at)
  } finally {
    db.close()
  }
})

test('db-schedules: update 不存在的 id 返回 false', { skip: skipReason ?? false }, () => {
  const { db, store } = makeStore()
  try {
    assert.equal(store.update('sched_not_exist', { name: 'X' }), false)
  } finally {
    db.close()
  }
})

test('db-schedules: delete 联动 CASCADE 清理 runs', { skip: skipReason ?? false }, () => {
  const { db, store } = makeStore()
  try {
    const row = store.create({ name: 'A', avatarId: 'a', cronExpr: '* * * * *', promptText: 'p' })
    const r = store.recordRunStart(row.id, 1700000000000)
    assert.equal(r.conflict, false)
    assert.notEqual(r.runId, null)
    store.recordRunFinish(r.runId!, 'success')
    assert.equal(store.listRuns(row.id).length, 1)

    const deleted = store.delete(row.id)
    assert.equal(deleted, true)
    assert.equal(store.get(row.id), undefined)
    // 触发 CASCADE：runs 应已清空
    const remaining = db.prepare('SELECT COUNT(*) AS n FROM schedule_runs WHERE schedule_id = ?').get(row.id) as { n: number }
    assert.equal(remaining.n, 0)
  } finally {
    db.close()
  }
})

test('db-schedules: delete 不存在的 id 返回 false', { skip: skipReason ?? false }, () => {
  const { db, store } = makeStore()
  try {
    assert.equal(store.delete('sched_nope'), false)
  } finally {
    db.close()
  }
})

test('db-schedules: list 按 created_at DESC，支持 avatarId / enabledOnly 过滤', { skip: skipReason ?? false }, async () => {
  const { db, store } = makeStore()
  try {
    const a = store.create({ name: 'a', avatarId: 'av1', cronExpr: '* * * * *', promptText: 'x' })
    await new Promise((r) => setTimeout(r, 2))
    const b = store.create({ name: 'b', avatarId: 'av2', cronExpr: '* * * * *', promptText: 'x' })
    await new Promise((r) => setTimeout(r, 2))
    const c = store.create({ name: 'c', avatarId: 'av1', cronExpr: '* * * * *', promptText: 'x', enabled: false })

    const all = store.list()
    assert.deepEqual(
      all.map((r) => r.id),
      [c.id, b.id, a.id], // 倒序
    )

    const onlyAv1 = store.list({ avatarId: 'av1' })
    assert.deepEqual(onlyAv1.map((r) => r.id).sort(), [a.id, c.id].sort())

    const enabled = store.listEnabled()
    assert.deepEqual(enabled.map((r) => r.id).sort(), [a.id, b.id].sort())
  } finally {
    db.close()
  }
})

test('db-schedules: setNextRunAt 写回成功', { skip: skipReason ?? false }, () => {
  const { db, store } = makeStore()
  try {
    const row = store.create({ name: 'a', avatarId: 'a', cronExpr: '* * * * *', promptText: 'x' })
    store.setNextRunAt(row.id, 9999)
    assert.equal(store.get(row.id)!.next_run_at, 9999)
    store.setNextRunAt(row.id, null)
    assert.equal(store.get(row.id)!.next_run_at, null)
  } finally {
    db.close()
  }
})

test('db-schedules: recordRunStart 幂等 - 第二次同一时刻冲突', { skip: skipReason ?? false }, () => {
  const { db, store } = makeStore()
  try {
    const row = store.create({ name: 'a', avatarId: 'a', cronExpr: '* * * * *', promptText: 'x' })
    const r1 = store.recordRunStart(row.id, 1700000000000)
    assert.equal(r1.conflict, false)
    assert.notEqual(r1.runId, null)
    const r2 = store.recordRunStart(row.id, 1700000000000)
    assert.equal(r2.conflict, true)
    assert.equal(r2.runId, null)
    // 不同时刻不冲突
    const r3 = store.recordRunStart(row.id, 1700000060000)
    assert.equal(r3.conflict, false)
  } finally {
    db.close()
  }
})

test('db-schedules: recordRunFinish 字段写入正确，并截断超长错误', { skip: skipReason ?? false }, () => {
  const { db, store } = makeStore()
  try {
    const row = store.create({ name: 'a', avatarId: 'a', cronExpr: '* * * * *', promptText: 'x' })
    const r = store.recordRunStart(row.id, 1700000000000)
    assert.notEqual(r.runId, null)
    const longErr = 'E'.repeat(800)
    const ok = store.recordRunFinish(r.runId!, 'failed', {
      conversationId: 'conv_x',
      durationMs: 1234,
      errorMessage: longErr,
    })
    assert.equal(ok, true)
    const runs = store.listRuns(row.id)
    assert.equal(runs.length, 1)
    assert.equal(runs[0].status, 'failed')
    assert.equal(runs[0].conversation_id, 'conv_x')
    assert.equal(runs[0].duration_ms, 1234)
    assert.ok(runs[0].error_message!.length <= 501) // 500 + '…'
    assert.ok(runs[0].error_message!.endsWith('…'))
  } finally {
    db.close()
  }
})

test('db-schedules: recordMissed UNIQUE 冲突静默返回 false', { skip: skipReason ?? false }, () => {
  const { db, store } = makeStore()
  try {
    const row = store.create({ name: 'a', avatarId: 'a', cronExpr: '* * * * *', promptText: 'x' })
    assert.equal(store.recordMissed(row.id, 1700000000000), true)
    // 同一时刻已经记 missed，再调返回 false 不抛
    assert.equal(store.recordMissed(row.id, 1700000000000), false)
    // 已存在 running 行的时刻，不再写 missed
    store.recordRunStart(row.id, 1700000060000)
    assert.equal(store.recordMissed(row.id, 1700000060000), false)
  } finally {
    db.close()
  }
})

test('db-schedules: listRuns 倒序 + 限额', { skip: skipReason ?? false }, () => {
  const { db, store } = makeStore()
  try {
    const row = store.create({ name: 'a', avatarId: 'a', cronExpr: '* * * * *', promptText: 'x' })
    for (let i = 0; i < 5; i++) {
      store.recordRunStart(row.id, 1700000000000 + i * 60000)
    }
    const runs = store.listRuns(row.id, 3)
    assert.equal(runs.length, 3)
    assert.equal(runs[0].fired_at_utc, 1700000000000 + 4 * 60000)
    assert.equal(runs[2].fired_at_utc, 1700000000000 + 2 * 60000)
  } finally {
    db.close()
  }
})

test('db-schedules: countRunsByStatus', { skip: skipReason ?? false }, () => {
  const { db, store } = makeStore()
  try {
    const row = store.create({ name: 'a', avatarId: 'a', cronExpr: '* * * * *', promptText: 'x' })
    const r1 = store.recordRunStart(row.id, 1)
    store.recordRunFinish(r1.runId!, 'success')
    const r2 = store.recordRunStart(row.id, 2)
    store.recordRunFinish(r2.runId!, 'failed', { errorMessage: 'e' })
    store.recordRunStart(row.id, 3) // 保持 running
    store.recordMissed(row.id, 4)

    const counts = store.countRunsByStatus(row.id)
    assert.equal(counts.success, 1)
    assert.equal(counts.failed, 1)
    assert.equal(counts.running, 1)
    assert.equal(counts.missed, 1)
  } finally {
    db.close()
  }
})
