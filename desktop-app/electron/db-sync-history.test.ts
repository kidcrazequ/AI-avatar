/**
 * db-sync-history.ts DAO 单测（#16 WebDAV cross-device sync · 子任务 3）。
 *
 * 验证点（最少 8 条）：
 *   1. record + get：字段往返一致
 *   2. update：in_progress → success 的状态机切换 + 字段刷新
 *   3. list 默认 created_at DESC：3 条数据按时间逆序
 *   4. list filter direction：仅返回指定方向
 *   5. list filter status：仅返回指定状态
 *   6. count + getLatestSuccessful：mix 数据下计数与最近成功取值正确
 *   7. retention 自动淘汰：插 35 条后 count===30，最旧 5 条被删
 *   8. truncateErrorMessage：5000 字符的 error_message 被截断到 4000
 *   9. clear：返回删除条数 + count===0
 *  10. clamp 工具函数：边界值（负值 / Infinity / 24h 上限）
 *
 * 设计：不走 DatabaseManager，直接用 better-sqlite3 in-memory db + 手动 exec 表结构。
 * ABI 不兼容时优雅 skip（与 db-embeds.test.ts / db-schedules.test.ts 同款）。
 *
 * @author zhi.qu
 * @date 2026-05-09
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

// 与 db-embeds.test.ts 同样的 ABI 探测：better-sqlite3 是原生模块，按 Electron ABI 编译，
// 系统 Node 直跑会抛 ERR_DLOPEN_FAILED，此时优雅跳过整个 suite。
type DatabaseModule = typeof import('better-sqlite3')
type DatabaseInstance = ReturnType<DatabaseModule>
let DatabaseCtor: DatabaseModule | null = null
let SyncHistoryStoreCtor: typeof import('./db-sync-history').SyncHistoryStore | null = null
let clampDurationFn: typeof import('./db-sync-history').clampDuration | null = null
let clampFileCountFn: typeof import('./db-sync-history').clampFileCount | null = null
let clampTotalBytesFn: typeof import('./db-sync-history').clampTotalBytes | null = null
let truncateErrorMessageFn: typeof import('./db-sync-history').truncateErrorMessage | null = null
let DEFAULT_RETENTION_LIMIT_VAL = 30
let loadError: string | null = null
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  DatabaseCtor = require('better-sqlite3') as DatabaseModule
  // 触发 ABI 校验：实例化一次再关
  const probe = new DatabaseCtor(':memory:')
  probe.close()
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require('./db-sync-history') as typeof import('./db-sync-history')
  SyncHistoryStoreCtor = mod.SyncHistoryStore
  clampDurationFn = mod.clampDuration
  clampFileCountFn = mod.clampFileCount
  clampTotalBytesFn = mod.clampTotalBytes
  truncateErrorMessageFn = mod.truncateErrorMessage
  DEFAULT_RETENTION_LIMIT_VAL = mod.DEFAULT_RETENTION_LIMIT
} catch (err) {
  loadError = err instanceof Error ? err.message : String(err)
  DatabaseCtor = null
}
const skipReason = loadError
  ? `跳过：本测试需要 better-sqlite3 原生绑定与当前 Node ABI 匹配（${loadError.split('\n')[0]}）`
  : null

/**
 * 在 in-memory db 上手动建出 sync_history 表 + 索引（与 database.ts createBaseSchema 同步）。
 * 这里复制 SQL 而非反向调用 DatabaseManager，是为了让本测试不依赖 electron stub 与文件系统。
 */
function setupSchema(db: DatabaseInstance): void {
  db.pragma('foreign_keys = ON')
  db.exec(`
    CREATE TABLE IF NOT EXISTS sync_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      direction TEXT NOT NULL,
      status TEXT NOT NULL,
      file_count INTEGER NOT NULL DEFAULT 0,
      total_bytes INTEGER NOT NULL DEFAULT 0,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      remote_filename TEXT,
      error_message TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sync_history_created_at ON sync_history(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_sync_history_direction_status ON sync_history(direction, status);
  `)
}

function makeStore(): { db: DatabaseInstance; store: import('./db-sync-history').SyncHistoryStore } {
  if (!DatabaseCtor || !SyncHistoryStoreCtor) {
    throw new Error('Database/Store 未加载（应已 skip）')
  }
  const db = new DatabaseCtor(':memory:')
  setupSchema(db)
  return { db, store: new SyncHistoryStoreCtor(db) }
}

test('db-sync-history: record + get 字段往返一致', { skip: skipReason ?? false }, () => {
  const { db, store } = makeStore()
  try {
    const before = Date.now()
    const row = store.record({
      direction: 'backup',
      status: 'success',
      file_count: 12,
      total_bytes: 8 * 1024 * 1024,
      duration_ms: 1500,
      remote_filename: 'backup-20260509.zip',
    })
    assert.ok(row.id > 0)
    assert.equal(row.direction, 'backup')
    assert.equal(row.status, 'success')
    assert.equal(row.file_count, 12)
    assert.equal(row.total_bytes, 8 * 1024 * 1024)
    assert.equal(row.duration_ms, 1500)
    assert.equal(row.remote_filename, 'backup-20260509.zip')
    assert.equal(row.error_message, null)
    assert.ok(row.created_at >= before)

    const got = store.get(row.id)
    assert.deepEqual(got, row)

    // 不存在 id 返回 null
    assert.equal(store.get(999_999), null)
  } finally {
    db.close()
  }
})

test('db-sync-history: update 状态机 + 字段刷新', { skip: skipReason ?? false }, () => {
  const { db, store } = makeStore()
  try {
    const initial = store.record({
      direction: 'backup',
      status: 'in_progress',
    })
    assert.equal(initial.status, 'in_progress')
    assert.equal(initial.file_count, 0)
    assert.equal(initial.duration_ms, 0)

    const updated = store.update(initial.id, {
      status: 'success',
      file_count: 20,
      duration_ms: 3500,
      total_bytes: 10_000,
      remote_filename: 'backup-late.zip',
    })
    assert.ok(updated !== null)
    assert.equal(updated!.id, initial.id)
    assert.equal(updated!.status, 'success')
    assert.equal(updated!.file_count, 20)
    assert.equal(updated!.duration_ms, 3500)
    assert.equal(updated!.total_bytes, 10_000)
    assert.equal(updated!.remote_filename, 'backup-late.zip')
    // created_at 不应被修改
    assert.equal(updated!.created_at, initial.created_at)

    // 不存在 id
    assert.equal(store.update(999_999, { status: 'success' }), null)

    // 空 patch 返回原行
    const noop = store.update(initial.id, {})
    assert.deepEqual(noop, updated)
  } finally {
    db.close()
  }
})

test('db-sync-history: list 默认按 created_at DESC', { skip: skipReason ?? false }, () => {
  const { db, store } = makeStore()
  try {
    const a = store.record({ direction: 'backup', status: 'success', created_at: 1000 })
    const b = store.record({ direction: 'backup', status: 'success', created_at: 2000 })
    const c = store.record({ direction: 'backup', status: 'success', created_at: 3000 })

    const list = store.list()
    assert.deepEqual(
      list.map((r) => r.id),
      [c.id, b.id, a.id],
    )
  } finally {
    db.close()
  }
})

test('db-sync-history: list filter direction 仅返回指定方向', { skip: skipReason ?? false }, () => {
  const { db, store } = makeStore()
  try {
    store.record({ direction: 'backup', status: 'success' })
    store.record({ direction: 'backup', status: 'success' })
    store.record({ direction: 'backup', status: 'success' })
    const r1 = store.record({ direction: 'restore', status: 'success' })
    const r2 = store.record({ direction: 'restore', status: 'failed' })

    const onlyRestore = store.list({ direction: 'restore' })
    assert.equal(onlyRestore.length, 2)
    assert.ok(onlyRestore.every((r) => r.direction === 'restore'))
    const restoreIds = onlyRestore.map((r) => r.id).sort((x, y) => x - y)
    assert.deepEqual(restoreIds, [r1.id, r2.id].sort((x, y) => x - y))
  } finally {
    db.close()
  }
})

test('db-sync-history: list filter status 仅返回指定状态', { skip: skipReason ?? false }, () => {
  const { db, store } = makeStore()
  try {
    store.record({ direction: 'backup', status: 'success' })
    store.record({ direction: 'backup', status: 'success' })
    const f1 = store.record({ direction: 'backup', status: 'failed', error_message: 'auth failed' })
    const f2 = store.record({ direction: 'restore', status: 'failed', error_message: 'timeout' })

    const failed = store.list({ status: 'failed' })
    assert.equal(failed.length, 2)
    assert.ok(failed.every((r) => r.status === 'failed'))
    const failedIds = failed.map((r) => r.id).sort((x, y) => x - y)
    assert.deepEqual(failedIds, [f1.id, f2.id].sort((x, y) => x - y))
  } finally {
    db.close()
  }
})

test('db-sync-history: count + getLatestSuccessful 准确', { skip: skipReason ?? false }, () => {
  const { db, store } = makeStore()
  try {
    store.record({ direction: 'backup', status: 'success', created_at: 1000 })
    store.record({ direction: 'backup', status: 'failed', created_at: 1500 })
    const latestBackupSuccess = store.record({
      direction: 'backup',
      status: 'success',
      created_at: 2000,
      remote_filename: 'expected-latest.zip',
    })
    store.record({ direction: 'restore', status: 'success', created_at: 1800 })

    assert.equal(store.count(), 4)
    assert.equal(store.count({ direction: 'backup' }), 3)
    assert.equal(store.count({ status: 'success' }), 3)
    assert.equal(store.count({ direction: 'backup', status: 'failed' }), 1)

    const latest = store.getLatestSuccessful('backup')
    assert.ok(latest !== null)
    assert.equal(latest!.id, latestBackupSuccess.id)
    assert.equal(latest!.remote_filename, 'expected-latest.zip')

    // restore 仅 1 条 success
    const latestRestore = store.getLatestSuccessful('restore')
    assert.ok(latestRestore !== null)
    assert.equal(latestRestore!.direction, 'restore')
    assert.equal(latestRestore!.status, 'success')
  } finally {
    db.close()
  }
})

test('db-sync-history: retention 自动淘汰最旧（35 → 30）', { skip: skipReason ?? false }, () => {
  const { db, store } = makeStore()
  try {
    const ids: number[] = []
    for (let i = 0; i < 35; i++) {
      const r = store.record({
        direction: 'backup',
        status: 'success',
        // 用单调递增的 created_at 让"最旧 5 条"可预测
        created_at: 1000 + i,
      })
      ids.push(r.id)
    }
    // 写入后 count 应被 record 触发的 prune 收敛到 DEFAULT_RETENTION_LIMIT
    assert.equal(store.count(), DEFAULT_RETENTION_LIMIT_VAL)
    assert.equal(DEFAULT_RETENTION_LIMIT_VAL, 30)

    // 最旧 5 条（前 5 个 id）应已被删除
    for (let i = 0; i < 5; i++) {
      assert.equal(store.get(ids[i]), null, `期望 id ${ids[i]}（第 ${i + 1} 条）已被淘汰`)
    }
    // 后 30 条仍然存在
    for (let i = 5; i < 35; i++) {
      assert.ok(store.get(ids[i]) !== null, `期望 id ${ids[i]}（第 ${i + 1} 条）仍保留`)
    }
  } finally {
    db.close()
  }
})

test('db-sync-history: error_message 5000 字符 → 截断到 4000', { skip: skipReason ?? false }, () => {
  const { db, store } = makeStore()
  try {
    const longMsg = 'X'.repeat(5000)
    const row = store.record({
      direction: 'backup',
      status: 'failed',
      error_message: longMsg,
    })
    assert.ok(row.error_message !== null)
    assert.equal(row.error_message!.length, 4000)
    assert.equal(row.error_message, 'X'.repeat(4000))

    // 短消息保持原样
    const short = store.record({
      direction: 'backup',
      status: 'failed',
      error_message: 'auth failed',
    })
    assert.equal(short.error_message, 'auth failed')

    // 空字符串 → null
    const empty = store.record({
      direction: 'backup',
      status: 'failed',
      error_message: '',
    })
    assert.equal(empty.error_message, null)
  } finally {
    db.close()
  }
})

test('db-sync-history: clear 返回删除数量并清空', { skip: skipReason ?? false }, () => {
  const { db, store } = makeStore()
  try {
    for (let i = 0; i < 5; i++) {
      store.record({ direction: 'backup', status: 'success' })
    }
    assert.equal(store.count(), 5)
    const removed = store.clear()
    assert.equal(removed, 5)
    assert.equal(store.count(), 0)
    assert.deepEqual(store.list(), [])

    // 二次 clear 删 0 条
    assert.equal(store.clear(), 0)
  } finally {
    db.close()
  }
})

test('db-sync-history: clamp 工具函数边界值', { skip: skipReason ?? false }, () => {
  if (!clampDurationFn || !clampFileCountFn || !clampTotalBytesFn || !truncateErrorMessageFn) {
    assert.fail('clamp 函数未加载（应已 skip）')
    return
  }
  // clampDuration
  assert.equal(clampDurationFn(-1), 0)
  assert.equal(clampDurationFn(0), 0)
  assert.equal(clampDurationFn(1500), 1500)
  assert.equal(clampDurationFn(Infinity), 0) // 非有限数 → 0
  assert.equal(clampDurationFn(NaN), 0)
  const dayMs = 24 * 3600 * 1000
  assert.equal(clampDurationFn(dayMs), dayMs)
  assert.equal(clampDurationFn(dayMs + 1), dayMs) // 上限封顶

  // clampFileCount
  assert.equal(clampFileCountFn(-5), 0)
  assert.equal(clampFileCountFn(0), 0)
  assert.equal(clampFileCountFn(123), 123)
  assert.equal(clampFileCountFn(2_000_000), 1_000_000)
  assert.equal(clampFileCountFn(Infinity), 0)

  // clampTotalBytes
  assert.equal(clampTotalBytesFn(-100), 0)
  assert.equal(clampTotalBytesFn(0), 0)
  const tenMb = 10 * 1024 * 1024
  assert.equal(clampTotalBytesFn(tenMb), tenMb)
  const hundredGb = 100 * 1024 * 1024 * 1024
  assert.equal(clampTotalBytesFn(hundredGb), hundredGb)
  assert.equal(clampTotalBytesFn(hundredGb + 1), hundredGb)

  // truncateErrorMessage
  assert.equal(truncateErrorMessageFn(null), null)
  assert.equal(truncateErrorMessageFn(undefined), null)
  assert.equal(truncateErrorMessageFn(''), null)
  assert.equal(truncateErrorMessageFn('hi'), 'hi')
  const exact4000 = 'A'.repeat(4000)
  assert.equal(truncateErrorMessageFn(exact4000), exact4000)
  const over = 'B'.repeat(4001)
  const truncated = truncateErrorMessageFn(over)
  assert.ok(truncated !== null)
  assert.equal(truncated!.length, 4000)
})

test('db-sync-history: 构造器在 sync_history 表缺失时抛错', { skip: skipReason ?? false }, () => {
  if (!DatabaseCtor || !SyncHistoryStoreCtor) {
    assert.fail('Database/Store 未加载（应已 skip）')
    return
  }
  const db = new DatabaseCtor(':memory:')
  try {
    // 不调用 setupSchema 故意制造缺表场景
    assert.throws(
      () => {
        new SyncHistoryStoreCtor!(db)
      },
      /sync_history 表不存在/,
    )
  } finally {
    db.close()
  }
})
