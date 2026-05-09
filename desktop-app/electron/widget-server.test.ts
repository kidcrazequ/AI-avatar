/**
 * widget-server.ts 单测（#15 Web Embed widget · 子任务 2）。
 *
 * 验证点（共 8 个用例，与主 prompt 对齐）：
 *   1. health check   GET /healthz → 200 + {ok:true,version:1}
 *   2. OPTIONS preflight：白名单命中 → 204 + Allow-Origin 回写；不命中 → 403
 *   3. /embed/:id/config enabled + 命中白名单 → 200 + 公开配置（不含 origin_whitelist）
 *   4. /embed/:id/config enabled=0 → 403
 *   5. /embed/:id/config 不存在 id → 403
 *   6. /api/embed/:id/messages proxy_api_token 未配置 → 503 proxy_token_missing
 *   7. /api/embed/:id/messages 限流：连续发 N+1 次 → 最后一次 429 + Retry-After
 *   8. /embed.js 文件不存在 → 503 widget_bundle_missing
 *
 * 设计：
 *   - 不依赖 electron 运行时（widget-server.ts 内部对 electron 全部 type-only import）
 *   - 不依赖 DatabaseManager 真实实现：用 FakeDb 提供 getSetting/setSetting/getConversation/createConversation
 *   - 用 better-sqlite3 in-memory db 跑 EmbedStore（与 db-embeds.test.ts 同款 ABI 探测）
 *   - server 绑 0.0.0.0:0（随机端口），测试客户端通过 127.0.0.1 连接
 *
 * 不测试的范围（避免 over-test，主任务边界外的留给 e2e）：
 *   - 真 SSE 上游透传（启动两个 server 复杂化；只测 client 收到的响应头与初始字节）
 *   - widget bundle 真实静态托管（子任务 3 的产物，本任务只验缺失分支）
 *
 * @author zhi.qu
 * @date 2026-05-09
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as http from 'http'

// ─── better-sqlite3 ABI 探测（与 db-embeds.test.ts 同款） ──────────────────────
type DatabaseModule = typeof import('better-sqlite3')
type DatabaseInstance = ReturnType<DatabaseModule>
let DatabaseCtor: DatabaseModule | null = null
let EmbedStoreCtor: typeof import('./db-embeds').EmbedStore | null = null
let WidgetServerCtor: typeof import('./widget-server').WidgetServer | null = null
let loadError: string | null = null
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  DatabaseCtor = require('better-sqlite3') as DatabaseModule
  // 触发 ABI 校验：实例化一次再关
  const probe = new DatabaseCtor(':memory:')
  probe.close()
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const embedsMod = require('./db-embeds') as typeof import('./db-embeds')
  EmbedStoreCtor = embedsMod.EmbedStore
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const wsMod = require('./widget-server') as typeof import('./widget-server')
  WidgetServerCtor = wsMod.WidgetServer
} catch (err) {
  loadError = err instanceof Error ? err.message : String(err)
  DatabaseCtor = null
}
const skipReason = loadError
  ? `跳过：本测试需要 better-sqlite3 原生绑定与当前 Node ABI 匹配（${loadError.split('\n')[0]}）`
  : null

// ─── 测试夹具 ────────────────────────────────────────────────────────────────

/**
 * 在 in-memory db 上手动建出 embeds 表 + 索引（与 database.ts createBaseSchema 同步）。
 * 与 db-embeds.test.ts 复制同份 SQL，避免 widget-server 测试依赖 schema 迁移。
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

/**
 * 极简 DatabaseManager 替身：仅暴露 widget-server 用到的 4 个方法。
 *
 * 用 unknown cast 满足 TS 类型，运行时只要鸭子方法在即可。
 */
interface FakeConversation {
  id: string
  title: string
  avatar_id: string
  project_id: string
}
class FakeDb {
  private readonly settings = new Map<string, string>()
  private readonly conversations = new Map<string, FakeConversation>()
  private convCounter = 0
  getSetting(key: string): string | undefined {
    return this.settings.get(key)
  }
  setSetting(key: string, value: string): void {
    this.settings.set(key, value)
  }
  getConversation(id: string): FakeConversation | undefined {
    return this.conversations.get(id)
  }
  createConversation(title: string, avatarId: string, projectId = 'default'): string {
    this.convCounter++
    const id = `conv_test_${this.convCounter}_${Math.random().toString(36).slice(2, 8)}`
    this.conversations.set(id, { id, title, avatar_id: avatarId, project_id: projectId })
    return id
  }
  /** 测试辅助：手动注入 conversation 用于 X-Soul-Conversation-Id 校验路径 */
  injectConversation(c: FakeConversation): void {
    this.conversations.set(c.id, c)
  }
}

/**
 * Logger 替身：silent，但满足 activity / error / channel / logEvent 4 个方法签名。
 */
function makeFakeLogger(): import('./logger').Logger {
  const noop = (): void => undefined
  const stub = {
    activity: noop,
    error: noop,
    channel: noop,
    logEvent: noop,
  }
  return stub as unknown as import('./logger').Logger
}

/** 一站式测试上下文：db + store + server */
interface TestCtx {
  db: DatabaseInstance
  fakeDb: FakeDb
  store: import('./db-embeds').EmbedStore
  server: import('./widget-server').WidgetServer
  port: number
}

async function makeCtx(opts?: { widgetPort?: '0' | string }): Promise<TestCtx> {
  if (!DatabaseCtor || !EmbedStoreCtor || !WidgetServerCtor) {
    throw new Error('Database/Store/Server 未加载（应已 skip）')
  }
  const db = new DatabaseCtor(':memory:')
  setupSchema(db)
  const store = new EmbedStoreCtor(db)
  const fakeDb = new FakeDb()
  // 默认让 widget-server 走随机端口（避免端口冲突）
  fakeDb.setSetting('widget_server_port', opts?.widgetPort ?? '0')
  const server = new WidgetServerCtor({
    // 用 unknown cast：FakeDb 与 DatabaseManager 共用 4 个鸭子方法
    getDb: () => fakeDb as unknown as import('./database').DatabaseManager,
    getEmbedStore: () => store,
    logger: makeFakeLogger(),
  })
  const { port } = await server.start()
  return { db, fakeDb, store, server, port }
}

async function teardown(ctx: TestCtx): Promise<void> {
  await ctx.server.stop()
  ctx.db.close()
}

/** 简易 HTTP 客户端（promise 包装 + 防止挂死的 30s 超时） */
function makeRequest(opts: {
  port: number
  path: string
  method?: string
  headers?: Record<string, string>
  body?: string
}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: opts.port,
      path: opts.path,
      method: opts.method ?? 'GET',
      headers: opts.headers,
      timeout: 30_000,
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => {
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        })
      })
      res.on('error', reject)
    })
    req.on('timeout', () => {
      req.destroy(new Error('client timeout'))
    })
    req.on('error', reject)
    if (opts.body !== undefined) req.write(opts.body)
    req.end()
  })
}

// ─── 用例 1：健康检查 ────────────────────────────────────────────────────────

test('widget-server: GET /healthz → 200 + {ok:true,version:1}', { skip: skipReason ?? false }, async () => {
  const ctx = await makeCtx()
  try {
    const resp = await makeRequest({ port: ctx.port, path: '/healthz' })
    assert.equal(resp.status, 200)
    const body = JSON.parse(resp.body) as { ok: boolean; version: number }
    assert.equal(body.ok, true)
    assert.equal(body.version, 1)
  } finally {
    await teardown(ctx)
  }
})

// ─── 用例 2：OPTIONS preflight 白名单 ─────────────────────────────────────────

test('widget-server: OPTIONS preflight 白名单命中→204 / 不命中→403', { skip: skipReason ?? false }, async () => {
  const ctx = await makeCtx()
  try {
    const embed = ctx.store.create({
      avatarId: 'test-avatar',
      name: 'test-embed',
      originWhitelist: ['https://example.com', 'http://localhost:3000'],
    })
    // 命中白名单
    const okResp = await makeRequest({
      port: ctx.port,
      path: `/api/embed/${embed.id}/messages`,
      method: 'OPTIONS',
      headers: {
        Origin: 'https://example.com',
        'Access-Control-Request-Method': 'POST',
      },
    })
    assert.equal(okResp.status, 204)
    assert.equal(okResp.headers['access-control-allow-origin'], 'https://example.com')
    // 不命中白名单
    const denyResp = await makeRequest({
      port: ctx.port,
      path: `/api/embed/${embed.id}/messages`,
      method: 'OPTIONS',
      headers: {
        Origin: 'https://evil.example',
        'Access-Control-Request-Method': 'POST',
      },
    })
    assert.equal(denyResp.status, 403)
    // 不命中时不应回写 Allow-Origin（让浏览器自然拒绝）
    assert.equal(denyResp.headers['access-control-allow-origin'], undefined)
    const denyBody = JSON.parse(denyResp.body) as { error: string }
    assert.equal(denyBody.error, 'origin_not_allowed')
  } finally {
    await teardown(ctx)
  }
})

// ─── 用例 3：GET /embed/:id/config 命中白名单 → 200 + 公开配置 ────────────────

test('widget-server: GET /embed/:id/config 命中白名单 → 200 + 公开字段（不含 origin_whitelist）', { skip: skipReason ?? false }, async () => {
  const ctx = await makeCtx()
  try {
    const embed = ctx.store.create({
      avatarId: 'avatar-x',
      name: 'My Blog Widget',
      originWhitelist: ['https://blog.example.com'],
      greeting: '你好',
      rateLimitPerMin: 30,
    })
    const resp = await makeRequest({
      port: ctx.port,
      path: `/embed/${embed.id}/config`,
      headers: { Origin: 'https://blog.example.com' },
    })
    assert.equal(resp.status, 200)
    assert.equal(resp.headers['access-control-allow-origin'], 'https://blog.example.com')
    const body = JSON.parse(resp.body) as Record<string, unknown>
    assert.equal(body.embedId, embed.id)
    assert.equal(body.avatarId, 'avatar-x')
    assert.equal(body.name, 'My Blog Widget')
    assert.equal(body.greeting, '你好')
    assert.equal(body.rateLimitPerMin, 30)
    // 关键：不能泄漏 origin_whitelist
    assert.equal(body.origin_whitelist, undefined)
    assert.equal(body.originWhitelist, undefined)
    // 也不应泄漏 enabled 字段（公开 API 已经隐含 enabled 才会返回）
    assert.equal(body.enabled, undefined)
  } finally {
    await teardown(ctx)
  }
})

// ─── 用例 4：GET /embed/:id/config disabled embed → 403 ──────────────────────

test('widget-server: GET /embed/:id/config disabled embed → 403', { skip: skipReason ?? false }, async () => {
  const ctx = await makeCtx()
  try {
    const embed = ctx.store.create({
      avatarId: 'a1',
      name: 'disabled-embed',
      originWhitelist: ['https://x.example'],
      enabled: false,
    })
    const resp = await makeRequest({
      port: ctx.port,
      path: `/embed/${embed.id}/config`,
      headers: { Origin: 'https://x.example' },
    })
    assert.equal(resp.status, 403)
    const body = JSON.parse(resp.body) as { error: string }
    assert.equal(body.error, 'embed_disabled_or_not_found')
  } finally {
    await teardown(ctx)
  }
})

// ─── 用例 5：GET /embed/:id/config 不存在 id → 403 ───────────────────────────

test('widget-server: GET /embed/:id/config 不存在 id → 403', { skip: skipReason ?? false }, async () => {
  const ctx = await makeCtx()
  try {
    const resp = await makeRequest({
      port: ctx.port,
      path: '/embed/emb_nonexistent_xyz/config',
      headers: { Origin: 'https://x.example' },
    })
    assert.equal(resp.status, 403)
    const body = JSON.parse(resp.body) as { error: string }
    assert.equal(body.error, 'embed_disabled_or_not_found')
  } finally {
    await teardown(ctx)
  }
})

// ─── 用例 6：POST /api/embed/:id/messages proxy_token 未配置 → 503 ───────────

test('widget-server: POST /api/embed/:id/messages proxy_token 未配置 → 503 proxy_token_missing', { skip: skipReason ?? false }, async () => {
  const ctx = await makeCtx()
  try {
    const embed = ctx.store.create({
      avatarId: 'avatar-y',
      name: 'embed-with-proxy-test',
      originWhitelist: ['https://allowed.example'],
    })
    // 关键设置：proxy_server_enabled=true 但不设 proxy_api_token
    ctx.fakeDb.setSetting('proxy_server_enabled', 'true')
    // proxy_api_token 缺失 → 应返回 503 proxy_token_missing

    const resp = await makeRequest({
      port: ctx.port,
      path: `/api/embed/${embed.id}/messages`,
      method: 'POST',
      headers: {
        Origin: 'https://allowed.example',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'hello widget' }],
        stream: true,
      }),
    })
    assert.equal(resp.status, 503)
    const body = JSON.parse(resp.body) as { error: string }
    assert.equal(body.error, 'proxy_token_missing')
    // X-Soul-Conversation-Id 应在响应头里回写（即使 503，也已分配 conv_id）
    assert.ok(typeof resp.headers['x-soul-conversation-id'] === 'string')
  } finally {
    await teardown(ctx)
  }
})

// ─── 用例 7：限流 N+1 → 429 + Retry-After ────────────────────────────────────

test('widget-server: POST /api/embed/:id/messages 限流第 N+1 次 → 429 + Retry-After', { skip: skipReason ?? false }, async () => {
  const ctx = await makeCtx()
  try {
    const limit = 5
    const embed = ctx.store.create({
      avatarId: 'avatar-z',
      name: 'rate-limit-test',
      originWhitelist: ['https://rl.example'],
      rateLimitPerMin: limit,
    })
    // proxy_server_enabled=false → 业务侧返回 503，但限流器在 503 之前就已 consume，
    // 所以第 N+1 次仍会被限流器拒绝。
    ctx.fakeDb.setSetting('proxy_server_enabled', 'false')

    const requestOnce = (): Promise<number> => makeRequest({
      port: ctx.port,
      path: `/api/embed/${embed.id}/messages`,
      method: 'POST',
      headers: {
        Origin: 'https://rl.example',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'ping' }] }),
    }).then(r => r.status)

    // 串行发 N 次（避免并行带来时序歧义）
    const statuses: number[] = []
    for (let i = 0; i < limit; i++) {
      statuses.push(await requestOnce())
    }
    // 前 N 次都不应该是 429（应该是 503 proxy_disabled 或类似）
    for (const s of statuses) {
      assert.notEqual(s, 429, `第一批次响应不应触发限流，得到 ${s}`)
    }

    // 第 N+1 次应该被限流
    const limited = await makeRequest({
      port: ctx.port,
      path: `/api/embed/${embed.id}/messages`,
      method: 'POST',
      headers: {
        Origin: 'https://rl.example',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'ping' }] }),
    })
    assert.equal(limited.status, 429)
    const body = JSON.parse(limited.body) as { error: string }
    assert.equal(body.error, 'rate_limited')
    // Retry-After 必须是正整数秒数
    const retryAfter = limited.headers['retry-after']
    assert.ok(typeof retryAfter === 'string', 'Retry-After 头缺失')
    const seconds = Number(retryAfter)
    assert.ok(Number.isInteger(seconds) && seconds >= 1 && seconds <= 60, `Retry-After 不在 [1,60] 内：${retryAfter}`)
  } finally {
    await teardown(ctx)
  }
})

// ─── 用例 8：GET /embed.js 文件不存在 → 503 widget_bundle_missing ────────────

test('widget-server: GET /embed.js 文件不存在 → 503 widget_bundle_missing', { skip: skipReason ?? false }, async () => {
  const ctx = await makeCtx()
  try {
    // 当前测试环境下 desktop-app/electron/widget-static/soul-embed.js 不存在 → 应返回 503
    const resp = await makeRequest({ port: ctx.port, path: '/embed.js' })
    assert.equal(resp.status, 503)
    const body = JSON.parse(resp.body) as { error: string; message: string }
    assert.equal(body.error, 'widget_bundle_missing')
    assert.match(body.message, /build:widget/)
  } finally {
    await teardown(ctx)
  }
})
