/**
 * WebDAV client for Soul cross-device sync (#16).
 *
 * Wraps perry-mitchell `webdav@^5.10.0` with:
 *  - Bearer / Basic auth (passed in via WebDavCredentials)
 *  - Self-signed cert tolerance (opt-in via ignoreTlsErrors)
 *  - Exponential backoff retry on 429 / 5xx (1s → 2s → 4s, max 3 attempts)
 *  - Strict Depth: 1 PROPFIND (Jianguoyun compat)
 *  - 500MB single-file upper bound (Jianguoyun limit)
 *
 * 不引入 @soul/core，保持本模块自包含；纯函数留给子任务 2 抽取。
 *
 * @author zhi.qu
 * @date 2026-05-09
 */

import { Agent as HttpsAgent } from 'node:https'
import {
  AuthType,
  createClient,
  type WebDAVClient,
  type WebDAVClientOptions,
  type FileStat,
} from 'webdav'

/** WebDAV 单文件上限，对齐坚果云的 500MB 硬限。 */
export const MAX_BACKUP_BYTES = 500 * 1024 * 1024

/** 备份文件名匹配前缀（仅根目录、根级文件） */
const BACKUP_FILE_PATTERN = /^soul-backup-.*\.zip$/

/** 退避序列（毫秒）：1s → 2s → 4s。最多 3 次尝试。 */
const RETRY_DELAYS_MS = [1_000, 2_000, 4_000]

/** 凭据描述（密码已在 credential-store 解密为明文，仅在内存里短暂使用）。 */
export interface WebDavCredentials {
  /** 完整 endpoint，例如 https://dav.jianguoyun.com/dav/ */
  endpoint: string
  /** 用户名（坚果云为邮箱） */
  username: string
  /** 应用专用密码 / Bearer token；空串表示匿名 */
  password: string
  /** 备份目录在 endpoint 下的相对路径，例如 /soul-backup */
  basePath: string
  /** 是否容忍自签证书（仅企业内网建议打开） */
  ignoreTlsErrors?: boolean
}

/** 远端备份条目（暴露给上层 manifest 计算用） */
export interface BackupListItem {
  filename: string
  size: number
  /** ISO 字符串；webdav 5.x 的 lastmod 通常是 RFC1123，统一原样返回，由上层解析 */
  lastModified: string
  etag?: string
}

/** 注入式 logger，避免本模块直接依赖单例 Logger，便于子任务 6 单测替身。 */
export interface WebDavLogger {
  warn(msg: string, err?: Error): void
  info(msg: string): void
}

/**
 * webdav 5.x 把所有协议错误统一抛成 WebDAVClientError，含 status / response。
 * 这里做一个轻量的类型守卫，避免在重试逻辑里散落 `any`。
 */
interface WebDavLikeError extends Error {
  status?: number
  code?: string
}

function isWebDavLikeError(err: unknown): err is WebDavLikeError {
  return err instanceof Error
}

/**
 * 判定一个错误是否值得重试（429 / 5xx / 典型瞬态网络错误）。
 *
 * 4xx 中除 429 外（例如 401 / 403 / 404 / 412）应立即抛错由上层提示用户，
 * 不浪费 4 秒退避。
 */
function isRetryable(err: unknown): boolean {
  if (!isWebDavLikeError(err)) return false

  if (typeof err.status === 'number') {
    if (err.status === 429) return true
    if (err.status >= 500 && err.status < 600) return true
    return false
  }

  // node fetch / undici 抛出的常见瞬态错误码
  const code = err.code ?? ''
  if (
    code === 'ECONNREFUSED' ||
    code === 'ECONNRESET' ||
    code === 'ETIMEDOUT' ||
    code === 'EAI_AGAIN' ||
    code === 'UND_ERR_SOCKET' ||
    code === 'UND_ERR_CONNECT_TIMEOUT'
  ) {
    return true
  }

  // 没有 status 也没有典型 code 时，保守不重试，避免无限放大业务错误
  return false
}

/** 从未知错误中提取「人类可读」的原因，避免在多处散落同样的拼接逻辑。 */
function describeError(err: unknown): string {
  if (err instanceof Error) {
    const status = isWebDavLikeError(err) && typeof err.status === 'number' ? `[${err.status}] ` : ''
    return `${status}${err.message}`
  }
  return String(err)
}

/** 拼接 basePath + filename，规避双斜杠 / 缺斜杠两种边界。 */
function joinPath(basePath: string, filename: string): string {
  const left = basePath.endsWith('/') ? basePath.slice(0, -1) : basePath
  const right = filename.startsWith('/') ? filename.slice(1) : filename
  if (!left) return `/${right}`
  return `${left}/${right}`
}

export class WebDavClient {
  private readonly client: WebDAVClient
  private readonly basePath: string
  private readonly logger: WebDavLogger

  constructor(creds: WebDavCredentials, logger: WebDavLogger) {
    if (!creds.endpoint) {
      throw new Error('WebDAV endpoint 不能为空')
    }
    if (!creds.basePath) {
      throw new Error('WebDAV basePath 不能为空（建议 /soul-backup）')
    }
    this.logger = logger
    // 统一规整 basePath：保证以 / 开头、不以 / 结尾
    this.basePath = creds.basePath.startsWith('/')
      ? creds.basePath.replace(/\/+$/, '')
      : `/${creds.basePath.replace(/\/+$/, '')}`

    const options: WebDAVClientOptions = {
      authType: AuthType.Password,
      username: creds.username,
      password: creds.password,
    }

    // webdav 5.x 没有专门的 ignoreTlsErrors 选项；要绕过自签证书必须挂自定义 httpsAgent。
    // 仅当用户显式开启时才生效，避免默认放宽 TLS 严格性。
    if (creds.ignoreTlsErrors === true && creds.endpoint.startsWith('https://')) {
      options.httpsAgent = new HttpsAgent({ rejectUnauthorized: false })
      this.logger.warn(
        'WebDAV 客户端启用了 ignoreTlsErrors=true，仅适合企业内网自签证书；公网请关闭。',
      )
    }

    this.client = createClient(creds.endpoint, options)
  }

  /**
   * 用一次轻量 PROPFIND 校验连接是否可用。
   *
   * 不抛错；以 { ok: false, reason } 形式返回，方便设置面板直接展示。
   */
  async testConnection(): Promise<{ ok: true } | { ok: false; reason: string }> {
    try {
      // 选 basePath 上一级（即 endpoint 根）做最小 PROPFIND，避免 basePath 还未创建导致误判
      await this.runWithRetry(
        'testConnection',
        async () => {
          await this.client.getDirectoryContents('/', { deep: false })
        },
      )
      return { ok: true }
    } catch (err) {
      this.logger.warn('WebDAV testConnection 失败', err instanceof Error ? err : undefined)
      return { ok: false, reason: describeError(err) }
    }
  }

  /**
   * 确保 basePath 目录存在。
   *
   * 若目录已存在（部分服务返回 405 Method Not Allowed / 409 Conflict），按成功处理。
   */
  async ensureBasePath(): Promise<void> {
    await this.runWithRetry('ensureBasePath', async () => {
      try {
        await this.client.createDirectory(this.basePath, { recursive: true })
      } catch (err) {
        // 已存在的目录通常返回 405 / 409，不视为失败
        if (isWebDavLikeError(err) && (err.status === 405 || err.status === 409)) {
          this.logger.info(`WebDAV basePath 已存在：${this.basePath}（${err.status}）`)
          return
        }
        throw err
      }
    })
  }

  /**
   * 上传备份文件。
   *
   * @param filename     文件名（不含目录），如 soul-backup-20260509-235500.zip
   * @param data         Buffer 或 Node 可读流
   * @param totalBytes   总字节数；用于 500MB 校验和 Content-Length 提示
   */
  async putBackup(
    filename: string,
    data: Buffer | NodeJS.ReadableStream,
    totalBytes: number,
  ): Promise<void> {
    if (!filename || filename.includes('/') || filename.includes('\\')) {
      throw new Error(`非法备份文件名：${filename}（不允许包含路径分隔符）`)
    }
    if (!Number.isFinite(totalBytes) || totalBytes <= 0) {
      throw new Error(`非法 totalBytes：${totalBytes}`)
    }
    if (totalBytes > MAX_BACKUP_BYTES) {
      throw new Error(
        `备份大小 ${totalBytes} 字节超过 WebDAV 单文件上限 ${MAX_BACKUP_BYTES} 字节（500MB），请分卷或裁剪`,
      )
    }

    const remotePath = joinPath(this.basePath, filename)
    await this.runWithRetry(`putBackup ${filename}`, async () => {
      const ok = await this.client.putFileContents(remotePath, data, {
        overwrite: true,
        contentLength: totalBytes,
      })
      if (!ok) {
        throw new Error(`putFileContents 返回 false，远端写入失败：${remotePath}`)
      }
    })
    this.logger.info(`WebDAV 备份上传完成：${remotePath} (${totalBytes} bytes)`)
  }

  /**
   * 列出 basePath 下符合 soul-backup-*.zip 命名的备份。
   *
   * 强制 deep=false 对应 PROPFIND Depth: 1，兼容坚果云只允许深度 1 的限制。
   * 不返回子目录、不递归。
   */
  async listBackups(): Promise<BackupListItem[]> {
    const items = await this.runWithRetry('listBackups', async () => {
      return this.client.getDirectoryContents(this.basePath, { deep: false })
    })

    // webdav 5.x 在不带 details 的重载下直接返回 FileStat[]
    const list = items as FileStat[]
    const filtered: BackupListItem[] = []
    for (const it of list) {
      if (it.type !== 'file') continue
      if (!BACKUP_FILE_PATTERN.test(it.basename)) continue
      filtered.push({
        filename: it.basename,
        size: it.size,
        lastModified: it.lastmod,
        etag: it.etag ?? undefined,
      })
    }
    return filtered
  }

  /**
   * 下载远端备份到内存 Buffer。
   *
   * 子任务 1 暂只暴露内存版本；后续如需流式恢复，再加 createReadStream 包装。
   * 下载前后都会做 500MB 校验，避免对端返回异常长度撑爆主进程。
   */
  async getBackup(filename: string): Promise<Buffer> {
    if (!filename || filename.includes('/') || filename.includes('\\')) {
      throw new Error(`非法备份文件名：${filename}`)
    }
    const remotePath = joinPath(this.basePath, filename)

    // 先 stat 确认大小，避免超过上限的文件被全量拉到内存
    const statResult = await this.runWithRetry(`stat ${filename}`, async () => {
      return this.client.stat(remotePath)
    })
    const stat = statResult as FileStat
    if (stat.type !== 'file') {
      throw new Error(`远端 ${remotePath} 不是文件（type=${stat.type}）`)
    }
    if (stat.size > MAX_BACKUP_BYTES) {
      throw new Error(
        `远端文件 ${remotePath} 大小 ${stat.size} 字节超过 ${MAX_BACKUP_BYTES} 字节，拒绝下载`,
      )
    }

    const raw = await this.runWithRetry(`getBackup ${filename}`, async () => {
      return this.client.getFileContents(remotePath, { format: 'binary' })
    })

    // getFileContents 在 binary + 不带 details 时返回 BufferLike（Buffer | ArrayBuffer）
    let buf: Buffer
    if (Buffer.isBuffer(raw)) {
      buf = raw
    } else if (raw instanceof ArrayBuffer) {
      buf = Buffer.from(raw)
    } else {
      throw new Error(`getBackup 收到非二进制响应：${typeof raw}`)
    }

    if (buf.byteLength > MAX_BACKUP_BYTES) {
      throw new Error(
        `下载内容 ${buf.byteLength} 字节超过 ${MAX_BACKUP_BYTES} 字节上限`,
      )
    }
    return buf
  }

  /**
   * 删除远端备份文件。
   *
   * 文件不存在时抛 404，由调用方决定是否吞掉（保留观察空间）。
   */
  async deleteBackup(filename: string): Promise<void> {
    if (!filename || filename.includes('/') || filename.includes('\\')) {
      throw new Error(`非法备份文件名：${filename}`)
    }
    const remotePath = joinPath(this.basePath, filename)
    await this.runWithRetry(`deleteBackup ${filename}`, async () => {
      await this.client.deleteFile(remotePath)
    })
    this.logger.info(`WebDAV 备份删除完成：${remotePath}`)
  }

  /**
   * 通用重试外壳：最多 3 次，遇到 429 / 5xx / 瞬态网络错误时按 1s → 2s → 4s 退避。
   *
   * 不抽到 @soul/core，保持本模块自包含；待子任务 2 出现第二个使用方再升级。
   */
  private async runWithRetry<T>(label: string, action: () => Promise<T>): Promise<T> {
    let lastErr: unknown
    for (let attempt = 0; attempt < RETRY_DELAYS_MS.length; attempt++) {
      try {
        return await action()
      } catch (err) {
        lastErr = err
        if (!isRetryable(err) || attempt === RETRY_DELAYS_MS.length - 1) {
          throw err
        }
        const wait = RETRY_DELAYS_MS[attempt]
        this.logger.warn(
          `WebDAV ${label} 失败，第 ${attempt + 1}/${RETRY_DELAYS_MS.length} 次，${wait}ms 后重试：${describeError(err)}`,
          err instanceof Error ? err : undefined,
        )
        await delay(wait)
      }
    }
    // 理论上不会走到这里：循环最后一次失败已经 throw
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
  }
}

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })
}
