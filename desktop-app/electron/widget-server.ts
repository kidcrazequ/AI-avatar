/**
 * Soul Web Embed widget HTTP 服务器（#15 Web Embed widget · 子任务 2）。
 *
 * 与 proxy-server.ts 是「双进程双端点」架构（详见 §4.13 主计划）：
 *   - proxy-server : 127.0.0.1:18888，仅本机回环；面向 Claude Code / Codex 等命令行客户端，
 *                    必须带 `Authorization: Bearer <proxy_api_token>`，渲染进程方案 A 完成 LLM 业务。
 *   - widget-server: 0.0.0.0:3211，面向浏览器嵌入；**不暴露任何 token**，
 *                    信任来自「严格 Origin 白名单 + DB enabled=1」，自身持 token 透传到 proxy-server。
 *
 * 安全核心：
 *   1. Origin 严格相等比对（不做 wildcard / 子串匹配 / 反射），白名单存于 embeds.origin_whitelist
 *   2. embed_id 必须在 DB 中存在且 enabled=1，否则一律 403
 *   3. 内存级 LRU 滑动窗口限流（key=embedId:Origin，60s 窗口，上限读自 embeds.rate_limit_per_min）
 *   4. SSE 透传：透传响应字节流到 widget client，不解析重组（避免协议偏离 proxy-server 契约）
 *
 * 与 proxy-server.ts 的契约对齐：
 *   - 透传到 `http://127.0.0.1:<proxy_port>/v1/messages`，注入 `Authorization: Bearer <token>` +
 *     `X-Soul-Conversation-Id: <conv_id>` 后让方案 A 链路完成业务
 *   - 任意一端禁用（proxy_server_enabled !== 'true' 或 token 缺失）→ 503 提示用户先开 proxy-server
 *
 * @author zhi.qu
 * @date 2026-05-09
 */

import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'http'
import * as fs from 'fs'
import * as path from 'path'
import type { DatabaseManager } from './database'
import type { EmbedRow, EmbedStore } from './db-embeds'
import type { Logger } from './logger'

/** 默认 widget-server 监听端口（与 proxy-server 默认 18888 区分） */
const DEFAULT_WIDGET_PORT = 3211
/** widget-server 必须显式 0.0.0.0 才能让 LAN / 隧道访问；与 proxy-server 严格隔离 */
const WIDGET_HOST = '0.0.0.0'
/** SSE 透传时拒绝默认主机：proxy-server 永远绑回环 */
const PROXY_HOST = '127.0.0.1'
/** 滑动窗口长度（ms），与 rate_limit_per_min 配合使用 */
const RATE_LIMIT_WINDOW_MS = 60_000
/** widget bundle 静态资源的同目录子目录名 */
const WIDGET_STATIC_DIR = 'widget-static'
/** widget bundle 文件名 */
const WIDGET_BUNDLE_FILE = 'soul-embed.js'
/** widget bundle 内存缓存有效期（避免每次请求都磁盘 IO） */
const WIDGET_BUNDLE_CACHE_TTL_MS = 30_000

/**
 * widget-server 依赖注入（与 proxy-server.ts 的 SoulProxyServerDeps 同款风格）。
 *
 * 注入而非全局 import 是为了：
 *   1. 让单测可以接 in-memory db / mock store
 *   2. 让主进程关停顺序可控（先 stop server 再 close db）
 */
export interface WidgetServerDeps {
  /** 主进程的 DatabaseManager；用于读 settings + 新建 conversation */
  getDb: () => DatabaseManager
  /** 主进程的 EmbedStore lazy 单例工厂 */
  getEmbedStore: () => EmbedStore
  /** 主进程 Logger（不允许内部 console.error） */
  logger: Logger
}

interface ParsedEmbedConfig {
  embedId: string
  avatarId: string
  name: string
  greeting: string | null
  rateLimitPerMin: number
  /** 解析后的 origin 列表（DB 里是 JSON 字符串） */
  originWhitelist: string[]
  enabled: boolean
}

interface RateLimiterEntry {
  /** 命中时间戳列表（ms），新的在末尾，旧的在头部 */
  timestamps: number[]
}

/**
 * SOC：限流器单独抽出来便于单测覆盖。
 *
 * 不引入新依赖（Soul 项目硬约束）；用 Map<key, number[]> 实现简单的滑动窗口：
 *   - 每次请求 push 当前时间戳
 *   - 触发判定时先清理 < (now - window) 的过期戳
 *   - 长度 > 上限 → 拒绝，并算出剩余等待秒数
 */
class SlidingWindowRateLimiter {
  private readonly buckets = new Map<string, RateLimiterEntry>()
  /** 写入计数，每 100 次触发一次 LRU 兜底清理（防止僵尸 key 内存增长） */
  private writeCount = 0

  constructor(private readonly windowMs: number = RATE_LIMIT_WINDOW_MS) {}

  /**
   * 询问是否允许放行；同时把当前时间戳计入 bucket。
   *
   * @returns ok=true 时 retryAfterSec 不必关心；ok=false 时返回客户端应等待的秒数（向上取整，最少 1）
   */
  consume(key: string, limit: number, now: number): { ok: boolean; retryAfterSec: number } {
    const entry = this.buckets.get(key) ?? { timestamps: [] }
    const cutoff = now - this.windowMs
    // 清理过期戳：从头部连续删（时间戳本来就单调）
    while (entry.timestamps.length > 0 && entry.timestamps[0] < cutoff) {
      entry.timestamps.shift()
    }
    if (entry.timestamps.length >= limit) {
      // 等待最早的戳过期就能再次放行
      const earliest = entry.timestamps[0]
      const retryAfterMs = this.windowMs - (now - earliest)
      const retryAfterSec = Math.max(1, Math.ceil(retryAfterMs / 1000))
      // 不计入本次（拒绝时不污染窗口）
      this.buckets.set(key, entry)
      return { ok: false, retryAfterSec }
    }
    entry.timestamps.push(now)
    this.buckets.set(key, entry)
    this.writeCount++
    if (this.writeCount % 100 === 0) {
      this.gc(now)
    }
    return { ok: true, retryAfterSec: 0 }
  }

  /** 删除完全为空的 bucket（避免僵尸 key） */
  private gc(now: number): void {
    const cutoff = now - this.windowMs
    for (const [k, v] of this.buckets) {
      while (v.timestamps.length > 0 && v.timestamps[0] < cutoff) {
        v.timestamps.shift()
      }
      if (v.timestamps.length === 0) {
        this.buckets.delete(k)
      }
    }
  }

  /** 测试 / 关停时清空 */
  reset(): void {
    this.buckets.clear()
    this.writeCount = 0
  }
}

/**
 * 把 EmbedRow（DB 行）解析为 widget-server 内部使用的结构（origin_whitelist 已 JSON.parse）。
 * 解析失败按 enabled=false 处理（防御性，避免脏数据导致 server 崩溃）。
 */
function parseEmbedRow(row: EmbedRow): ParsedEmbedConfig {
  let originWhitelist: string[] = []
  try {
    const parsed = JSON.parse(row.origin_whitelist) as unknown
    if (Array.isArray(parsed) && parsed.every((s) => typeof s === 'string')) {
      originWhitelist = parsed
    }
  } catch {
    // 损坏的白名单 → 退化为空数组（拒绝所有）
    originWhitelist = []
  }
  return {
    embedId: row.id,
    avatarId: row.avatar_id,
    name: row.name,
    greeting: row.greeting,
    rateLimitPerMin: row.rate_limit_per_min,
    originWhitelist,
    enabled: row.enabled === 1,
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders?: Record<string, string>): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload, 'utf8'),
    ...extraHeaders,
  })
  res.end(payload)
}

function readRequestBody(req: IncomingMessage, maxBytes = 1 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    req.on('data', (c: Buffer) => {
      total += c.length
      if (total > maxBytes) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/**
 * 安全提取 Origin header（统一字符串、忽略多值）。
 * 不做任何 normalization（避免误判同源）；调用方需用严格相等比对。
 */
function extractOrigin(req: IncomingMessage): string | null {
  const raw = req.headers.origin
  if (Array.isArray(raw)) return raw[0] ?? null
  if (typeof raw === 'string' && raw.length > 0) return raw
  return null
}

/**
 * Widget HTTP 服务器主类。
 *
 * 启停周期由 main.ts 控制；start()/stop() 同 proxy-server 风格幂等可重入。
 *
 * 设计取舍：
 *   - 用 Node 原生 http 模块，不引入 express/koa（项目硬约束「不引新依赖」）
 *   - 路由用 if/else 分发（端点数量稀少，无需正则表，便于审阅）
 *   - SSE 透传走 http.request + pipe，不在 widget-server 端解析事件流
 */
export class WidgetServer {
  private server: Server | null = null
  private actualPort: number | null = null
  private readonly rateLimiter = new SlidingWindowRateLimiter()
  /** widget bundle 内存缓存：{ content, mtime, cachedAt } 命中时直接 res.end */
  private bundleCache: { content: Buffer; cachedAt: number } | null = null

  constructor(private readonly deps: WidgetServerDeps) {}

  isRunning(): boolean {
    return this.server !== null && this.actualPort !== null
  }

  getPort(): number | null {
    return this.actualPort
  }

  /**
   * 启动 server。
   *
   * - 如已 running 直接返回当前端口（幂等）
   * - 端口从 settings 读 widget_server_port；非法或未设置回落 DEFAULT_WIDGET_PORT；显式 0 走随机端口
   * - 监听 0.0.0.0（与 proxy-server 127.0.0.1 区分），让 LAN/反向隧道可访问
   * - 端口被占用时用 reject(err) 而非 process.exit，避免拖垮主进程
   */
  start(): Promise<{ port: number }> {
    if (this.server && this.actualPort !== null) {
      return Promise.resolve({ port: this.actualPort })
    }

    const portRaw = this.deps.getDb().getSetting('widget_server_port')
    let port: number
    if (portRaw === '0') {
      // 显式随机端口（测试场景常用）
      port = 0
    } else {
      const parsed = Math.floor(Number(portRaw))
      port = Number.isFinite(parsed) && parsed > 0 && parsed < 65536 ? parsed : DEFAULT_WIDGET_PORT
    }

    const server = createServer((req, res) => {
      // 内部 dispatch 自带 try/catch，单条请求异常不会拖垮 server
      this.handleRequest(req, res).catch((err) => {
        this.deps.logger.error('widget-server.dispatch', err instanceof Error ? err : new Error(String(err)))
        if (!res.headersSent) {
          try {
            sendJson(res, 500, { error: 'internal_error' })
          } catch {
            void 0 // socket 已断；忽略写入错误
          }
        }
      })
    })

    server.on('error', (err: NodeJS.ErrnoException) => {
      this.deps.logger.error('widget-server', err)
    })

    return new Promise((resolve, reject) => {
      const onError = (err: NodeJS.ErrnoException) => {
        server.removeListener('listening', onListening)
        reject(err)
      }
      const onListening = () => {
        server.removeListener('error', onError)
        const addr = server.address()
        const boundPort = typeof addr === 'object' && addr ? addr.port : port
        this.server = server
        this.actualPort = boundPort
        this.deps.logger.activity('widget-server', `listening http://${WIDGET_HOST}:${boundPort}`)
        resolve({ port: boundPort })
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(port, WIDGET_HOST)
    })
  }

  /**
   * 优雅关闭：停止接收新连接，清空限流器与 bundle cache。
   * 已在传输的 SSE 透传连接由 Node http 自然关闭。
   */
  stop(): Promise<void> {
    if (!this.server) return Promise.resolve()
    const server = this.server
    return new Promise((resolve) => {
      server.close(() => {
        this.deps.logger.activity('widget-server', 'stopped')
        resolve()
      })
      this.server = null
      this.actualPort = null
      this.rateLimiter.reset()
      this.bundleCache = null
    })
  }

  /**
   * 主路由分发。
   *
   * 路由表（按命中频率排序，热路径先判）：
   *   - POST /api/embed/:id/messages → SSE 透传到 proxy-server
   *   - GET  /embed/:id/config       → 返回该 embed 的公开配置
   *   - GET  /embed.js               → widget bundle 静态托管（带 30s 内存缓存）
   *   - OPTIONS *                    → CORS 预检
   *   - GET  /healthz                → 健康检查（无鉴权）
   *   - 其他                         → 404
   */
  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? 'GET'
    const url = req.url ?? '/'

    // CORS 预检：所有路径统一处理
    if (method === 'OPTIONS') {
      this.handleOptions(req, res)
      return
    }

    if (method === 'GET' && url === '/healthz') {
      sendJson(res, 200, { ok: true, version: 1 })
      return
    }

    if (method === 'GET' && url === '/embed.js') {
      this.handleEmbedJs(res)
      return
    }

    // 提取 :id 形式的 embedId（embed/:id/config 与 api/embed/:id/messages）
    const configMatch = /^\/embed\/([A-Za-z0-9_]+)\/config$/.exec(url)
    if (method === 'GET' && configMatch) {
      await this.handleEmbedConfig(req, res, configMatch[1])
      return
    }
    const messagesMatch = /^\/api\/embed\/([A-Za-z0-9_]+)\/messages$/.exec(url)
    if (method === 'POST' && messagesMatch) {
      await this.handleEmbedMessages(req, res, messagesMatch[1])
      return
    }

    sendJson(res, 404, { error: 'not_found' })
  }

  /**
   * CORS 预检处理。
   *
   * 设计要点：
   *   - 严格匹配 Origin 白名单：仅当请求路径是 /embed/:id/* 或 /api/embed/:id/* 时才查 DB
   *   - 其他路径（/embed.js / /healthz）允许任意 Origin（这两个不暴露用户数据）
   *   - 不允许 Authorization header（widget 不带 token）
   */
  private handleOptions(req: IncomingMessage, res: ServerResponse): void {
    const url = req.url ?? '/'
    const origin = extractOrigin(req)

    // 静态资源 / 健康检查：允许任意 Origin（无敏感数据），但不写 credentials
    if (url === '/embed.js' || url === '/healthz') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': origin ?? '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '86400',
      })
      res.end()
      return
    }

    // 业务路径：严格白名单
    const configMatch = /^\/embed\/([A-Za-z0-9_]+)\/config$/.exec(url)
    const messagesMatch = /^\/api\/embed\/([A-Za-z0-9_]+)\/messages$/.exec(url)
    const embedId = configMatch?.[1] ?? messagesMatch?.[1] ?? null
    if (!embedId) {
      sendJson(res, 404, { error: 'not_found' })
      return
    }
    if (!origin) {
      // 缺失 Origin：preflight 默认拒绝（避免任何 wildcard 泄漏）
      sendJson(res, 403, { error: 'origin_not_allowed' })
      return
    }
    const config = this.loadEmbedConfig(embedId)
    if (!config || !config.enabled) {
      sendJson(res, 403, { error: 'embed_disabled_or_not_found' })
      return
    }
    if (!config.originWhitelist.includes(origin)) {
      sendJson(res, 403, { error: 'origin_not_allowed' })
      return
    }
    res.writeHead(204, {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Credentials': 'false',
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Soul-Conversation-Id',
      'Access-Control-Max-Age': '86400',
    })
    res.end()
  }

  /**
   * 静态 widget bundle 托管。
   *
   * 文件路径：__dirname/widget-static/soul-embed.js（子任务 3 由 packages/widget 构建产物拷贝过来）。
   * 缺失时 503 + 明确错误码，让用户在子任务 3 完成前先做集成。
   */
  private handleEmbedJs(res: ServerResponse): void {
    const now = Date.now()
    if (this.bundleCache && now - this.bundleCache.cachedAt < WIDGET_BUNDLE_CACHE_TTL_MS) {
      this.writeBundleResponse(res, this.bundleCache.content)
      return
    }
    const bundlePath = path.join(__dirname, WIDGET_STATIC_DIR, WIDGET_BUNDLE_FILE)
    let content: Buffer
    try {
      content = fs.readFileSync(bundlePath)
    } catch {
      sendJson(res, 503, {
        error: 'widget_bundle_missing',
        message: '请先 npm run build:widget',
      })
      return
    }
    this.bundleCache = { content, cachedAt: now }
    this.writeBundleResponse(res, content)
  }

  private writeBundleResponse(res: ServerResponse, content: Buffer): void {
    res.writeHead(200, {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Content-Length': content.length,
      'Cache-Control': 'public, max-age=300',
      'Access-Control-Allow-Origin': '*',
    })
    res.end(content)
  }

  /**
   * GET /embed/:id/config —— 返回公开配置供 widget 启动时拉取。
   *
   * 限制：
   *   - 不返回 origin_whitelist（避免被拿到完整白名单）
   *   - 不返回内部时间戳
   *   - 只回 widget 渲染需要的 4 个字段
   */
  private async handleEmbedConfig(req: IncomingMessage, res: ServerResponse, embedId: string): Promise<void> {
    const origin = extractOrigin(req)
    if (!origin) {
      sendJson(res, 403, { error: 'origin_not_allowed' })
      return
    }
    const config = this.loadEmbedConfig(embedId)
    if (!config || !config.enabled) {
      sendJson(res, 403, { error: 'embed_disabled_or_not_found' })
      return
    }
    if (!config.originWhitelist.includes(origin)) {
      sendJson(res, 403, { error: 'origin_not_allowed' })
      return
    }
    sendJson(res, 200, {
      embedId: config.embedId,
      avatarId: config.avatarId,
      name: config.name,
      greeting: config.greeting,
      rateLimitPerMin: config.rateLimitPerMin,
    }, {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Credentials': 'false',
    })
  }

  /**
   * POST /api/embed/:id/messages —— 核心业务入口。
   *
   * 流水线：
   *   1. Origin + enabled 校验
   *   2. 限流（key=embedId:Origin）
   *   3. 解析请求体 + 提取最后一条 user 消息
   *   4. 复用或新建 conversation_id（带 X-Soul-Conversation-Id 时校验 avatar_id 一致）
   *   5. 透传 SSE 到 proxy-server（http.request → pipe）
   */
  private async handleEmbedMessages(req: IncomingMessage, res: ServerResponse, embedId: string): Promise<void> {
    const origin = extractOrigin(req)
    if (!origin) {
      sendJson(res, 403, { error: 'origin_not_allowed' })
      return
    }
    const config = this.loadEmbedConfig(embedId)
    if (!config || !config.enabled) {
      sendJson(res, 403, { error: 'embed_disabled_or_not_found' })
      return
    }
    if (!config.originWhitelist.includes(origin)) {
      sendJson(res, 403, { error: 'origin_not_allowed' })
      return
    }

    const limitDecision = this.rateLimiter.consume(`${embedId}:${origin}`, config.rateLimitPerMin, Date.now())
    if (!limitDecision.ok) {
      sendJson(res, 429, { error: 'rate_limited' }, {
        'Retry-After': String(limitDecision.retryAfterSec),
        'Access-Control-Allow-Origin': origin,
      })
      return
    }

    let rawBody: string
    try {
      rawBody = await readRequestBody(req)
    } catch (err) {
      sendJson(res, 400, { error: 'bad_body', message: err instanceof Error ? err.message : String(err) })
      return
    }
    let parsed: { messages?: Array<{ role?: string; content?: string }>; stream?: boolean } | null = null
    try {
      parsed = JSON.parse(rawBody) as typeof parsed
    } catch {
      sendJson(res, 400, { error: 'invalid_json' })
      return
    }

    const userContent = pickLastUserContent(parsed?.messages)
    if (!userContent) {
      sendJson(res, 400, { error: 'no_user_message' })
      return
    }

    // 校验 / 准备 conversation_id
    const incomingConvHeader = req.headers['x-soul-conversation-id']
    const incomingConv = typeof incomingConvHeader === 'string' ? incomingConvHeader.trim() : ''
    const db = this.deps.getDb()
    let conversationId: string
    if (incomingConv) {
      const existing = db.getConversation(incomingConv)
      if (!existing) {
        sendJson(res, 403, { error: 'conversation_not_found' })
        return
      }
      if (existing.avatar_id !== config.avatarId) {
        sendJson(res, 403, { error: 'conversation_avatar_mismatch' })
        return
      }
      conversationId = incomingConv
    } else {
      conversationId = db.createConversation(config.name || 'Web Embed', config.avatarId, 'default')
    }

    // 校验 proxy-server 是否就绪（仅在真要透传时检查；提前给 client 友好错误）
    const proxyEnabled = db.getSetting('proxy_server_enabled') === 'true'
    if (!proxyEnabled) {
      sendJson(res, 503, { error: 'proxy_disabled' }, {
        'Access-Control-Allow-Origin': origin,
        'X-Soul-Conversation-Id': conversationId,
      })
      return
    }
    const proxyToken = db.getSetting('proxy_api_token') ?? ''
    if (!proxyToken) {
      sendJson(res, 503, { error: 'proxy_token_missing' }, {
        'Access-Control-Allow-Origin': origin,
        'X-Soul-Conversation-Id': conversationId,
      })
      return
    }
    const proxyPortRaw = db.getSetting('proxy_server_port')
    const proxyPort = Math.floor(Number(proxyPortRaw)) > 0 && Math.floor(Number(proxyPortRaw)) < 65536
      ? Math.floor(Number(proxyPortRaw))
      : 18888

    // 重写请求体为 proxy-server 期待的 /v1/messages 形态：
    //   - stream: true（widget 始终用流式）
    //   - messages: [{ role: 'user', content: <string> }]
    //   - 其他 anthropic 字段（model / max_tokens 等）让方案 A 渲染端补齐
    const proxyBody = JSON.stringify({
      stream: true,
      messages: [{ role: 'user', content: userContent }],
    })

    await this.streamToProxy(res, {
      origin,
      conversationId,
      proxyHost: PROXY_HOST,
      proxyPort,
      proxyToken,
      bodyJson: proxyBody,
    })
  }

  /**
   * 用 Node 原生 http.request 调 proxy-server，并把响应流直接 pipe 给 widget client。
   *
   * 不解析事件流（避免协议偏离 proxy-server 契约）；
   * 仅在透传开始前 writeHead，写入 widget 期待的 SSE / CORS 头。
   */
  private streamToProxy(
    res: ServerResponse,
    args: {
      origin: string
      conversationId: string
      proxyHost: string
      proxyPort: number
      proxyToken: string
      bodyJson: string
    },
  ): Promise<void> {
    return new Promise((resolve) => {
      const upstream = httpRequest({
        host: args.proxyHost,
        port: args.proxyPort,
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(args.bodyJson, 'utf8'),
          Authorization: `Bearer ${args.proxyToken}`,
          'X-Soul-Conversation-Id': args.conversationId,
        },
      }, (upRes) => {
        // proxy-server 返回的 status 透传给 client；正常应该是 200 + text/event-stream
        const status = upRes.statusCode ?? 502
        if (status >= 400) {
          // 非 200：把上游的 JSON / 文本透传过去，但加上我们的 CORS 头让浏览器能读到错误内容
          const chunks: Buffer[] = []
          upRes.on('data', (c: Buffer) => chunks.push(c))
          upRes.on('end', () => {
            const body = Buffer.concat(chunks).toString('utf8')
            try {
              res.writeHead(status, {
                'Content-Type': upRes.headers['content-type'] ?? 'application/json; charset=utf-8',
                'Access-Control-Allow-Origin': args.origin,
                'X-Soul-Conversation-Id': args.conversationId,
              })
              res.end(body)
            } catch {
              void 0 // 客户端已断开；忽略写入错误
            }
            resolve()
          })
          upRes.on('error', () => {
            try { res.end() } catch { void 0 /* 客户端已断开 */ }
            resolve()
          })
          // widget client 中途断开：销毁上游请求与响应流，避免悬挂连接。
          res.on('close', () => {
            try { upstream.destroy() } catch { void 0 }
            try { upRes.destroy() } catch { void 0 }
            resolve()
          })
          return
        }
        // SSE 透传：写头并直接 pipe 字节流
        res.writeHead(200, {
          'Content-Type': upRes.headers['content-type'] ?? 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'Access-Control-Allow-Origin': args.origin,
          'X-Soul-Conversation-Id': args.conversationId,
        })
        upRes.pipe(res)
        upRes.on('end', () => resolve())
        upRes.on('error', (err) => {
          this.deps.logger.error('widget-server.upstream', err)
          try { res.end() } catch { void 0 /* 客户端已断开 */ }
          resolve()
        })
        // widget client 中途断开（关页签）：销毁上游请求与响应流，
        // 让 proxy-server 的 res.on('close') 触发 releaseJob，停止 renderer 继续生成 token。
        res.on('close', () => {
          try { upstream.destroy() } catch { void 0 }
          try { upRes.destroy() } catch { void 0 }
          resolve()
        })
      })
      upstream.on('error', (err: NodeJS.ErrnoException) => {
        // 连接拒绝 / 超时：返回 502
        if (!res.headersSent) {
          sendJson(res, 502, { error: 'proxy_unreachable', message: err.message }, {
            'Access-Control-Allow-Origin': args.origin,
            'X-Soul-Conversation-Id': args.conversationId,
          })
        } else {
          try { res.end() } catch { void 0 /* 客户端已断开 */ }
        }
        resolve()
      })
      upstream.write(args.bodyJson)
      upstream.end()
    })
  }

  /**
   * 从 EmbedStore 读单条 embed 配置；不存在 / 解析失败返回 null。
   * 非缓存路径：每次请求都查 DB（量级低，且 embeds 表在用户改设置后能立即生效）。
   */
  private loadEmbedConfig(embedId: string): ParsedEmbedConfig | null {
    try {
      const row = this.deps.getEmbedStore().get(embedId)
      if (!row) return null
      return parseEmbedRow(row)
    } catch (err) {
      this.deps.logger.error('widget-server.loadEmbedConfig', err instanceof Error ? err : new Error(String(err)))
      return null
    }
  }
}

/**
 * 从 messages 数组里提取最后一条 user 消息的文本内容。
 *
 * - 多消息数组取最后一条 role='user'
 * - 跳过 system / assistant / tool 等其他角色
 * - content 必须是非空字符串；否则返回 null
 */
function pickLastUserContent(messages: Array<{ role?: string; content?: string }> | undefined): string | null {
  if (!Array.isArray(messages) || messages.length === 0) return null
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m && m.role === 'user' && typeof m.content === 'string' && m.content.trim().length > 0) {
      return m.content
    }
  }
  return null
}

// 仅供测试访问限流器内部行为（编译产物中不裸暴露内部状态）
export const __testables = {
  SlidingWindowRateLimiter,
  parseEmbedRow,
  pickLastUserContent,
}
