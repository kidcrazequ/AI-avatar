/**
 * 临时本地静态文件服务：把 workspace 内的某个文件以 http://127.0.0.1:<port>/<token>
 * 的形式短期暴露出来，供以下场景使用：
 *   - 让本机内的另一个工具（如本地浏览器、Office for Web 客户端）拉取
 *   - 在 PDF 打印窗口里以 http:// 引用静态资源（比 file:// 更稳）
 *   - 给 Markdown / HTML 预览注入临时图片地址
 *
 * 安全设计：
 *   - 仅监听 127.0.0.1，不对外网开放
 *   - 每次注册返回独立 token（128 bit），URL 路径形式为 /f/<token>
 *   - 默认 1 小时 TTL，过期自动失效（请求时再校验，不依赖定时器）
 *   - 关闭进程时自动注销所有 token
 *
 * 与 Canva/外部 SaaS 的关系：HTTPS 站点不能直接 fetch http://localhost
 * 资源（混合内容策略），所以 send_to_canva 走"导出 + shell.openExternal +
 * 用户拖拽上传"的方案；本服务仅服务于本机内部消费。
 *
 * @author zhi.qu
 * @date 2026-04-28
 */

import http from 'http'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { Logger } from '../logger'

interface RegisteredEntry {
  absPath: string
  expiresAt: number
  contentType: string
}

const DEFAULT_TTL_MS = 60 * 60 * 1000 // 1 小时

function guessContentType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase().replace('.', '')
  switch (ext) {
    case 'html': case 'htm': return 'text/html; charset=utf-8'
    case 'css': return 'text/css; charset=utf-8'
    case 'js': case 'mjs': return 'text/javascript; charset=utf-8'
    case 'json': return 'application/json; charset=utf-8'
    case 'pdf': return 'application/pdf'
    case 'pptx': return 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    case 'docx': return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    case 'xlsx': return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    case 'png': return 'image/png'
    case 'jpg': case 'jpeg': return 'image/jpeg'
    case 'gif': return 'image/gif'
    case 'webp': return 'image/webp'
    case 'svg': return 'image/svg+xml'
    case 'mp4': return 'video/mp4'
    case 'webm': return 'video/webm'
    case 'mp3': return 'audio/mpeg'
    case 'wav': return 'audio/wav'
    case 'txt': case 'md': return 'text/plain; charset=utf-8'
    default: return 'application/octet-stream'
  }
}

export class PublicFileServer {
  private server: http.Server | null = null
  private port = 0
  private entries = new Map<string, RegisteredEntry>()
  private starting: Promise<void> | null = null

  constructor(private readonly logger?: Logger) {}

  /** 懒启动：第一次 register 时才起 server */
  private async ensureStarted(): Promise<void> {
    if (this.server) return
    if (this.starting) return this.starting
    this.starting = new Promise<void>((resolve, reject) => {
      const server = http.createServer((req, res) => this.handle(req, res))
      server.on('error', (err) => {
        this.logger?.error('public-file-server', err instanceof Error ? err : new Error(String(err)))
        reject(err)
      })
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address()
        if (!addr || typeof addr === 'string') {
          reject(new Error('public-file-server 启动失败：无法获取端口'))
          return
        }
        this.port = addr.port
        this.server = server
        this.logger?.activity('public-file-server-start', `port=${this.port}`)
        resolve()
      })
    }).finally(() => {
      this.starting = null
    })
    return this.starting
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = req.url || ''
    const m = url.match(/^\/f\/([a-f0-9]{32,64})(?:[?#].*)?$/)
    if (!m) {
      res.statusCode = 404
      res.end('Not Found')
      return
    }
    const token = m[1]
    const entry = this.entries.get(token)
    if (!entry) {
      res.statusCode = 404
      res.end('Not Found')
      return
    }
    if (Date.now() > entry.expiresAt) {
      this.entries.delete(token)
      res.statusCode = 410
      res.end('Gone')
      return
    }
    if (!fs.existsSync(entry.absPath) || !fs.statSync(entry.absPath).isFile()) {
      res.statusCode = 404
      res.end('Not Found')
      return
    }
    res.setHeader('Content-Type', entry.contentType)
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    const stream = fs.createReadStream(entry.absPath)
    stream.on('error', (err) => {
      this.logger?.error('public-file-serve-stream', err instanceof Error ? err : new Error(String(err)))
      try { res.destroy() } catch {}
    })
    stream.pipe(res)
  }

  /**
   * 把绝对路径注册为可访问 URL，返回 http://127.0.0.1:<port>/f/<token>。
   * absPath 必须是已存在的文件，调用方负责做路径安全校验（通常用 WorkspaceManager.resolveCrossProjectPath）。
   */
  async register(absPath: string, ttlMs: number = DEFAULT_TTL_MS): Promise<string> {
    if (!path.isAbsolute(absPath)) {
      throw new Error(`public-file-server.register 需要绝对路径: ${absPath}`)
    }
    if (!fs.existsSync(absPath) || !fs.statSync(absPath).isFile()) {
      throw new Error(`public-file-server.register 文件不存在: ${absPath}`)
    }
    await this.ensureStarted()
    const token = crypto.randomBytes(20).toString('hex')
    this.entries.set(token, {
      absPath,
      expiresAt: Date.now() + ttlMs,
      contentType: guessContentType(absPath),
    })
    return `http://127.0.0.1:${this.port}/f/${token}`
  }

  /** 主动注销（极少使用，主要由 TTL 自然失效） */
  unregister(url: string): void {
    const m = url.match(/\/f\/([a-f0-9]{32,64})/)
    if (m) this.entries.delete(m[1])
  }

  /** 应用退出时调用 */
  async stop(): Promise<void> {
    if (!this.server) return
    await new Promise<void>((resolve) => {
      this.server?.close(() => resolve())
    })
    this.server = null
    this.entries.clear()
    this.logger?.activity('public-file-server-stop')
  }
}
