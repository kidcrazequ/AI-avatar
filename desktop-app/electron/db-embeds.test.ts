/**
 * db-embeds.ts DAO 单测（#15 Web Embed widget · 子任务 1）。
 *
 * 验证点：
 *   1. EmbedStore.create + get 字段往返一致（含 origin JSON 序列化、greeting truncate）
 *   2. create 时 rateLimitPerMin 越界 clamp（1→5、999→300、50→50）
 *   3. create 时 greeting > 500 字符截断为 500 + '…'
 *   4. create 时 origin 含 `*` 抛 Error（DAO 硬阻断）
 *   5. update 部分字段（保留未传字段，刷新 updated_at）
 *   6. delete 真删除 vs 不存在 id
 *   7. list 多条数据按 created_at DESC，支持 avatarId / enabled 过滤
 *   8. setEnabled 切换启停 + 刷新 updated_at
 *
 * 设计：不走 DatabaseManager，直接用 better-sqlite3 in-memory db + 手动 exec 表结构。
 * 这样测试聚焦在 DAO 行为，不依赖 electron 运行时与 schema 迁移路径
 * （迁移由独立的 database-embeds-migration.test.ts 验证）。
 *
 * @author zhi.qu
 * @date 2026-05-09
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

// 与 db-schedules.test.ts 同样的 ABI 探测：better-sqlite3 是原生模块，按 Electron ABI 编译，
// 系统 Node 直跑会抛 ERR_DLOPEN_FAILED，此时优雅跳过整个 suite。
type DatabaseModule = typeof import('better-sqlite3')
type DatabaseInstance = ReturnType<DatabaseModule>
let DatabaseCtor: DatabaseModule | null = null
let EmbedStoreCtor: typeof import('./db-embeds').EmbedStore | null = null
let loadError: string | null = null
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  DatabaseCtor = require('better-sqlite3') as DatabaseModule
  // 触发 ABI 校验：实例化一次再关
  const probe = new DatabaseCtor(':memory:')
  probe.close()
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require('./db-embeds') as typeof import('./db-embeds')
  EmbedStoreCtor = mod.EmbedStore
} catch (err) {
  loadError = err instanceof Error ? err.message : String(err)
  DatabaseCtor = null
}
const skipReason = loadError
  ? `跳过：本测试需要 better-sqlite3 原生绑定与当前 Node ABI 匹配（${loadError.split('\n')[0]}）`
  : null

/**
 * 在 in-memory db 上手动建出 embeds 表 + 索引（与 database.ts createBaseSchema 同步）。
 * 这里复制 SQL 而非反向调用 DatabaseManager，是为了让本测试不依赖 electron stub 与文件系统。
 */
function setupSchema(db: DatabaseInstance): void {
  db.pragma('foreign_keys = ON')
  db.exec(`
    CREATE TABLE IF NOT EXISTS embeds (
      id TEXT PRIMARY KEY,
      avatar_id TEXT NOT NULL,
      name TEXT NOT NULL,
      origin_whitelist TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      rate_limit_per_min INTEGER NOT NULL DEFAULT 30,
      greeting TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_embeds_avatar_id ON embeds(avatar_id);
    CREATE INDEX IF NOT EXISTS idx_embeds_enabled ON embeds(enabled);
  `)
}

function makeStore(): { db: DatabaseInstance; store: import('./db-embeds').EmbedStore } {
  if (!DatabaseCtor || !EmbedStoreCtor) {
    throw new Error('Database/Store 未加载（应已 skip）')
  }
  const db = new DatabaseCtor(':memory:')
  setupSchema(db)
  return { db, store: new EmbedStoreCtor(db) }
}

test('db-embeds: create + get 字段往返一致（origin JSON、默认值）', { skip: skipReason ?? false }, () => {
  const { db, store } = makeStore()
  try {
    const row = store.create({
      avatarId: 'xiaodu',
      name: '我的博客',
      originWhitelist: ['http://localhost:3000', 'https://blog.example.com'],
      greeting: '你好，我是小堵',
    })
    assert.match(row.id, /^emb_/)
    assert.equal(row.avatar_id, 'xiaodu')
    assert.equal(row.name, '我的博客')
    assert.equal(row.enabled, 1)
    assert.equal(row.rate_limit_per_min, 30) // 默认值
    assert.equal(row.greeting, '你好，我是小堵')
    assert.ok(row.created_at > 0)
    assert.equal(row.updated_at, row.created_at)

    // origin_whitelist 是 JSON 字符串
    const parsed = JSON.parse(row.origin_whitelist) as string[]
    assert.deepEqual(parsed, ['http://localhost:3000', 'https://blog.example.com'])

    const got = store.get(row.id)
    assert.deepEqual(got, row)
  } finally {
    db.close()
  }
})

test('db-embeds: create rateLimitPerMin clamp 到 [5, 300]', { skip: skipReason ?? false }, () => {
  const { db, store } = makeStore()
  try {
    const low = store.create({
      avatarId: 'a',
      name: 'low',
      originWhitelist: ['https://a.com'],
      rateLimitPerMin: 1,
    })
    assert.equal(low.rate_limit_per_min, 5)

    const high = store.create({
      avatarId: 'a',
      name: 'high',
      originWhitelist: ['https://a.com'],
      rateLimitPerMin: 999,
    })
    assert.equal(high.rate_limit_per_min, 300)

    const mid = store.create({
      avatarId: 'a',
      name: 'mid',
      originWhitelist: ['https://a.com'],
      rateLimitPerMin: 50,
    })
    assert.equal(mid.rate_limit_per_min, 50)
  } finally {
    db.close()
  }
})

test('db-embeds: create greeting > 500 字符截断为 500 + …', { skip: skipReason ?? false }, () => {
  const { db, store } = makeStore()
  try {
    const longGreeting = 'G'.repeat(800)
    const row = store.create({
      avatarId: 'a',
      name: 'long',
      originWhitelist: ['https://a.com'],
      greeting: longGreeting,
    })
    assert.ok(row.greeting !== null)
    // 500 个 G + '…'，共 501 个字符
    assert.equal(row.greeting!.length, 501)
    assert.ok(row.greeting!.endsWith('…'))
    assert.equal(row.greeting!.slice(0, 500), 'G'.repeat(500))

    // 空字符串 → null（不存空字符串）
    const empty = store.create({
      avatarId: 'a',
      name: 'empty',
      originWhitelist: ['https://a.com'],
      greeting: '',
    })
    assert.equal(empty.greeting, null)
  } finally {
    db.close()
  }
})

test('db-embeds: create origin 含 * 抛 Error（DAO 硬阻断）', { skip: skipReason ?? false }, () => {
  const { db, store } = makeStore()
  try {
    assert.throws(
      () => {
        store.create({
          avatarId: 'a',
          name: 'star',
          originWhitelist: ['*'],
        })
      },
      /wildcard/i,
    )
    assert.throws(
      () => {
        store.create({
          avatarId: 'a',
          name: 'star2',
          originWhitelist: ['https://*.example.com'],
        })
      },
      /wildcard/i,
    )
    // 正常 origin 不应抛
    assert.doesNotThrow(() => {
      store.create({
        avatarId: 'a',
        name: 'ok',
        originWhitelist: ['https://example.com'],
      })
    })
  } finally {
    db.close()
  }
})

test('db-embeds: update 仅修改传入字段，updated_at 刷新', { skip: skipReason ?? false }, async () => {
  const { db, store } = makeStore()
  try {
    const row = store.create({
      avatarId: 'a',
      name: 'A',
      originWhitelist: ['https://a.com'],
      greeting: 'hi',
    })
    // 等 2ms 让 updated_at 可观察变化
    await new Promise((r) => setTimeout(r, 2))
    const updated = store.update(row.id, { name: 'B', enabled: false })
    assert.ok(updated !== null)
    assert.equal(updated!.name, 'B')
    assert.equal(updated!.enabled, 0)
    assert.equal(updated!.greeting, 'hi') // 未传，保留
    assert.equal(updated!.origin_whitelist, row.origin_whitelist) // 未传，保留
    assert.equal(updated!.rate_limit_per_min, row.rate_limit_per_min)
    assert.ok(updated!.updated_at > row.updated_at)

    // 不存在 id 返回 null
    assert.equal(store.update('emb_not_exist', { name: 'X' }), null)
  } finally {
    db.close()
  }
})

test('db-embeds: delete 返回 true / false', { skip: skipReason ?? false }, () => {
  const { db, store } = makeStore()
  try {
    const row = store.create({
      avatarId: 'a',
      name: 'd',
      originWhitelist: ['https://a.com'],
    })
    assert.equal(store.delete(row.id), true)
    assert.equal(store.get(row.id), null)
    // 不存在的 id
    assert.equal(store.delete('emb_nope'), false)
    // 已删除的 id 再删
    assert.equal(store.delete(row.id), false)
  } finally {
    db.close()
  }
})

test('db-embeds: list 按 created_at DESC，支持 avatarId / enabled 过滤', { skip: skipReason ?? false }, async () => {
  const { db, store } = makeStore()
  try {
    const a = store.create({ avatarId: 'av1', name: 'a', originWhitelist: ['https://a.com'] })
    await new Promise((r) => setTimeout(r, 2))
    const b = store.create({ avatarId: 'av2', name: 'b', originWhitelist: ['https://b.com'] })
    await new Promise((r) => setTimeout(r, 2))
    const c = store.create({
      avatarId: 'av1',
      name: 'c',
      originWhitelist: ['https://c.com'],
      enabled: false,
    })

    // 全量倒序
    const all = store.list()
    assert.deepEqual(
      all.map((r) => r.id),
      [c.id, b.id, a.id],
    )

    // avatarId 过滤
    const onlyAv1 = store.list({ avatarId: 'av1' })
    assert.deepEqual(onlyAv1.map((r) => r.id).sort(), [a.id, c.id].sort())

    // enabled=true 过滤
    const enabled = store.list({ enabled: true })
    assert.deepEqual(enabled.map((r) => r.id).sort(), [a.id, b.id].sort())

    // enabled=false 过滤
    const disabled = store.list({ enabled: false })
    assert.deepEqual(disabled.map((r) => r.id), [c.id])

    // 联合过滤
    const av1Enabled = store.list({ avatarId: 'av1', enabled: true })
    assert.deepEqual(av1Enabled.map((r) => r.id), [a.id])
  } finally {
    db.close()
  }
})

test('db-embeds: setEnabled 切换启停 + 刷新 updated_at', { skip: skipReason ?? false }, async () => {
  const { db, store } = makeStore()
  try {
    const row = store.create({
      avatarId: 'a',
      name: 'toggle',
      originWhitelist: ['https://a.com'],
    })
    assert.equal(row.enabled, 1)
    await new Promise((r) => setTimeout(r, 2))

    const off = store.setEnabled(row.id, false)
    assert.ok(off !== null)
    assert.equal(off!.enabled, 0)
    assert.ok(off!.updated_at > row.updated_at)

    const on = store.setEnabled(row.id, true)
    assert.ok(on !== null)
    assert.equal(on!.enabled, 1)
    assert.ok(on!.updated_at >= off!.updated_at)

    // 不存在 id 返回 null
    assert.equal(store.setEnabled('emb_nope', true), null)
  } finally {
    db.close()
  }
})
