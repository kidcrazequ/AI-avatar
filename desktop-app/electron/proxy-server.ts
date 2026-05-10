/**
 * Soul Anthropic 兼容 Proxy（P0+ · 方案 A）
 * 主进程 HTTP 仅做鉴权与协议；业务对话由渲染进程 `sendMessage` 同源链路执行。
 *
 * @author zhi.qu
 * @date 2026-05-09
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'http'
import type { BrowserWindow, IpcMain } from 'electron'
import * as crypto from 'crypto'
import type { Logger } from './logger'

const DEFAULT_PORT = 18888
const HOST = '127.0.0.1'

export interface SoulProxyServerDeps {
  getDb: () => { getSetting: (key: string) => string | undefined }
  getMainWindow: () => BrowserWindow | null
  logger?: Logger | null
}

type PendingJob =
  | { mode: 'sse'; res: ServerResponse }
  | { mode: 'json'; res: ServerResponse }

const pendingJobs = new Map<string, PendingJob>()

let httpServer: ReturnType<typeof createServer> | null = null

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload, 'utf8'),
  })
  res.end(payload)
}

function sendText(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' })
  res.end(text)
}

function readRequestBody(req: IncomingMessage, maxBytes = 8 * 1024 * 1024): Promise<string> {
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

function parseAuthBearer(req: IncomingMessage): string | null {
  const raw = req.headers.authorization
  if (!raw || typeof raw !== 'string') return null
  const m = /^Bearer\s+(.+)$/i.exec(raw.trim())
  return m ? m[1].trim() : null
}

export interface SoulProxyRunPayload {
  jobId: string
  stream: boolean
  conversationId: string
  /** Anthropic Messages API 请求 JSON */
  body: Record<string, unknown>
}

let proxyIpcRegistered = false

/**
 * 注册 IPC：渲染进程写 SSE / JSON 响应结束。
 */
export function registerSoulProxyIpcHandlers(ipcMain: IpcMain): void {
  if (proxyIpcRegistered) return
  proxyIpcRegistered = true

  ipcMain.handle('soul-proxy-api:sse-write', (_event, jobId: string, rawChunk: string) => {
    const job = pendingJobs.get(jobId)
    if (!job || job.mode !== 'sse') return { ok: false }
    try {
      job.res.write(rawChunk, 'utf8')
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle(
    'soul-proxy-api:finish',
    (_event, jobId: string, payload: { error?: string; json?: unknown }) => {
      const job = pendingJobs.get(jobId)
      if (!job) return { ok: false }
      pendingJobs.delete(jobId)
      try {
        if (payload.error) {
          if (job.mode === 'sse') {
            const errLine = `event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'api_error', message: payload.error } })}\n\n`
            job.res.write(errLine, 'utf8')
            job.res.end()
          } else {
            sendJson(job.res as ServerResponse, 500, { error: payload.error })
          }
          return { ok: true }
        }
        if (job.mode === 'json' && payload.json !== undefined) {
          const body = JSON.stringify(payload.json)
          job.res.writeHead(200, {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body, 'utf8'),
          })
          job.res.end(body)
          return { ok: true }
        }
        if (job.mode === 'sse') {
          job.res.end()
        }
        return { ok: true }
      } catch (e) {
        try {
          job.res.end()
        } catch {
          void 0 // 忽略重复 end / 已关闭的 socket
        }
        return { ok: false, error: e instanceof Error ? e.message : String(e) }
      }
    },
  )
}

export function startSoulProxyServer(deps: SoulProxyServerDeps): void {
  if (httpServer) return

  const enabled = deps.getDb().getSetting('proxy_server_enabled') === 'true'
  if (!enabled) {
    deps.logger?.activity('soul-proxy', 'skipped (proxy_server_enabled !== true)')
    return
  }

  const portRaw = deps.getDb().getSetting('proxy_server_port')
  const port = Math.floor(Number(portRaw)) > 0 && Math.floor(Number(portRaw)) < 65536
    ? Math.floor(Number(portRaw))
    : DEFAULT_PORT

  httpServer = createServer(async (req, res) => {
    const log = deps.logger
    const url = req.url ?? '/'
    const method = req.method ?? 'GET'

    if (method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, anthropic-version, x-soul-conversation-id',
        'Access-Control-Max-Age': '86400',
      })
      res.end()
      return
    }

    if (method === 'GET' && (url === '/v1/health' || url === '/health')) {
      sendJson(res, 200, { ok: true, service: 'soul-proxy', bind: HOST })
      return
    }

    if (method !== 'POST' || url !== '/v1/messages') {
      sendText(res, 404, 'Not Found')
      return
    }

    const token = deps.getDb().getSetting('proxy_api_token') ?? ''
    if (!token) {
      sendJson(res, 503, { error: 'proxy_api_token 未配置' })
      return
    }

    const bearer = parseAuthBearer(req)
    if (!bearer || bearer !== token) {
      sendJson(res, 401, { error: 'invalid_token', message: 'Authorization: Bearer 与设置中的 Proxy Token 不一致' })
      log?.channel('soul-proxy', 'auth-fail', 'Bearer mismatch or missing')
      return
    }

    const conversationId = req.headers['x-soul-conversation-id']
    if (typeof conversationId !== 'string' || conversationId.trim().length === 0) {
      sendJson(res, 400, {
        error: 'missing_header',
        message: '必须提供请求头 x-soul-conversation-id（Soul 会话 ID，与侧边栏会话一致）',
      })
      return
    }

    let rawBody: string
    try {
      rawBody = await readRequestBody(req)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      sendJson(res, 400, { error: 'bad_body', message: msg })
      return
    }

    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(rawBody) as Record<string, unknown>
    } catch {
      sendJson(res, 400, { error: 'invalid_json' })
      return
    }

    const stream = parsed.stream === true
    const win = deps.getMainWindow()
    if (!win || win.isDestroyed()) {
      sendJson(res, 503, { error: 'renderer_unavailable' })
      return
    }

    const jobId = crypto.randomUUID()
    if (stream) {
      pendingJobs.set(jobId, { mode: 'sse', res })
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      })
    } else {
      pendingJobs.set(jobId, { mode: 'json', res })
    }

    const payload: SoulProxyRunPayload = {
      jobId,
      stream,
      conversationId: conversationId.trim(),
      body: parsed,
    }

    try {
      win.webContents.send('soul-proxy-api:run-request', payload)
      log?.channel('soul-proxy', 'dispatched', `job=${jobId} stream=${stream} conv=${conversationId.trim()}`)
    } catch (e) {
      pendingJobs.delete(jobId)
      const msg = e instanceof Error ? e.message : String(e)
      sendJson(res, 500, { error: 'dispatch_failed', message: msg })
    }
  })

  httpServer.on('error', (err: NodeJS.ErrnoException) => {
    deps.logger?.error('soul-proxy-server', err)
  })

  httpServer.listen(port, HOST, () => {
    deps.logger?.activity('soul-proxy', `listening http://${HOST}:${port}/v1/messages (方案 A → renderer sendMessage)`)
  })
}

export function stopSoulProxyServer(logger?: Logger | null): void {
  if (!httpServer) return
  try {
    httpServer.close(() => {
      logger?.activity('soul-proxy', 'stopped')
    })
  } catch (e) {
    logger?.error('soul-proxy-stop', e instanceof Error ? e : new Error(String(e)))
  }
  httpServer = null
}
