/**
 * WigoloSidecar：wigolo 边车进程（`wigolo serve`）的生命周期管理器。
 *
 * 背景见 docs/wigolo-cn-search-plan.md 子任务 1：wigolo 依赖原生模块
 * （better-sqlite3 / playwright），按系统 Node ABI 编译，嵌入 Electron 会碎；
 * 重内存组件隔离在边车进程，避开主进程 4GB 堆顶。本模块只管「拉起 / 复用 /
 * 探活 / 回收」，REST 调用由 tool-router 的 cn_web_search 分支负责。
 *
 * 生命周期语义：
 *   - ensureReady：幂等懒启动，绝不 throw（诚实降级，一律返回 status）。
 *     先探活端口——已有健康 daemon（用户手动跑的 `wigolo serve`）则复用；
 *     否则找二进制 spawn，轮询健康检查（GET /openapi.json）最多 20 秒。
 *   - 未安装时只给安装指引，绝不自动 npx 下载——wigolo 全量 ~1.5GB，
 *     慢网环境自动下载等于挂死（同 warmup 需挂代理手动跑）。
 *   - 并发 ensureReady 共享同一个进行中的 promise，防止双 spawn。
 *   - stop：只 SIGTERM 自己 spawn 的进程；复用的外部 daemon 不动。
 */

import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { fetchWithTimeout } from '@soul/core'

/** 默认边车端口（wigolo serve 默认监听） */
const DEFAULT_PORT = 3333
/** 单次健康检查超时 */
const HEALTH_CHECK_TIMEOUT_MS = 5_000
/** spawn 后等待就绪的总时长上限 */
const STARTUP_TIMEOUT_MS = 20_000
/** 健康检查轮询间隔 */
const POLL_INTERVAL_MS = 500
/** 失败诊断保留的 stderr 尾部长度（不无限累积内存） */
const STDERR_TAIL_CHARS = 2000

/** 未安装时的指引（绝不代替用户下载：全量 ~1.5GB） */
const INSTALL_GUIDE =
  'wigolo 未安装。请手动执行 `npx wigolo init --no-warmup`（跳过全量资源下载），' +
  '随后慢网环境挂代理执行 `wigolo warmup --all`（约 1.5GB，支持断点续传）补齐浏览器与模型。'

export interface WigoloSidecarStatus {
  state: 'ready' | 'starting' | 'not-installed' | 'failed' | 'stopped'
  baseUrl?: string   // state==='ready' 时必有，如 http://127.0.0.1:3333
  detail?: string    // 人类可读说明（失败原因 / 安装指引）
}

export interface WigoloSidecarOptions {
  port?: number                                  // 默认 3333
  logger?: (tag: string, msg: string) => void
  env?: Record<string, string>                   // 透传子进程（代理等），叠加在 process.env 之上
  spawnImpl?: typeof import('node:child_process').spawn   // 测试注入
  healthCheckImpl?: (baseUrl: string) => Promise<boolean> // 测试注入；默认 GET {baseUrl}/openapi.json 200 即健康（fetchWithTimeout，5s 超时）
  resolveBinaryImpl?: () => string | null        // 测试注入；默认在 PATH 上找 wigolo 可执行（用 child_process.execFileSync('which',['wigolo']) 包 try/catch），找不到返回 null
}

/** 默认健康检查：openapi.json 能 2xx 拿到即认为 daemon 健康 */
async function defaultHealthCheck(baseUrl: string): Promise<boolean> {
  try {
    await fetchWithTimeout(`${baseUrl}/openapi.json`, { timeoutMs: HEALTH_CHECK_TIMEOUT_MS })
    return true
  } catch {
    // 连不上 / 非 2xx / 超时统一视为不健康，由上层决定 spawn 还是降级
    return false
  }
}

/** 默认二进制定位：PATH 上找 wigolo，找不到返回 null（不 throw） */
function defaultResolveBinary(): string | null {
  try {
    const found = execFileSync('which', ['wigolo'], { encoding: 'utf-8' }).trim()
    return found || null
  } catch {
    // which 非零退出（未命中）或不可用，视为未安装
    return null
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export class WigoloSidecar {
  private readonly port: number
  private readonly loggerImpl?: (tag: string, msg: string) => void
  private readonly extraEnv: Record<string, string>
  private readonly spawnImpl: typeof spawn
  private readonly healthCheckImpl: (baseUrl: string) => Promise<boolean>
  private readonly resolveBinaryImpl: () => string | null

  private status: WigoloSidecarStatus = { state: 'stopped', detail: '尚未启动' }
  /** 自己 spawn 的子进程（复用外部 daemon 时为 null） */
  private child: ChildProcess | null = null
  /** true = 进程归本模块管（stop 时回收）；false = 复用外部 daemon（stop 不动） */
  private ownedProcess = false
  /** 进行中的 ensureReady，并发调用共享，防双 spawn */
  private inflight: Promise<WigoloSidecarStatus> | null = null
  /** stop() 递增；启动流程持旧值时不得再覆盖状态（防止 stop 后被迟到的 failed 覆盖） */
  private epoch = 0

  constructor(opts: WigoloSidecarOptions = {}) {
    this.port = opts.port ?? DEFAULT_PORT
    this.loggerImpl = opts.logger
    this.extraEnv = opts.env ?? {}
    this.spawnImpl = opts.spawnImpl ?? spawn
    this.healthCheckImpl = opts.healthCheckImpl ?? defaultHealthCheck
    this.resolveBinaryImpl = opts.resolveBinaryImpl ?? defaultResolveBinary
  }

  /** 幂等懒启动。绝不 throw：任何失败都收敛为 status（诚实降级） */
  async ensureReady(): Promise<WigoloSidecarStatus> {
    // 已就绪且（复用外部 daemon，或自有进程仍存活）→ 直接复用
    if (this.status.state === 'ready' && (!this.ownedProcess || this.isChildAlive())) {
      return this.getStatus()
    }
    if (this.inflight) return this.inflight

    const myEpoch = this.epoch
    this.inflight = this.doEnsureReady(myEpoch)
      .catch((err) =>
        // 纵深防御：doEnsureReady 自身不应 throw，这里兜底保证「绝不 throw」契约
        this.commit(myEpoch, {
          state: 'failed',
          detail: `边车启动异常: ${err instanceof Error ? err.message : String(err)}`,
        }),
      )
      .finally(() => {
        this.inflight = null
      })
    return this.inflight
  }

  getStatus(): WigoloSidecarStatus {
    return { ...this.status }
  }

  /** 只回收自己 spawn 的进程；复用的外部 daemon 不动。stop 后可再次 ensureReady 重启 */
  async stop(): Promise<void> {
    this.epoch++
    this.inflight = null
    if (this.ownedProcess && this.child && this.isChildAlive()) {
      try {
        this.child.kill('SIGTERM')
      } catch {
        // 进程可能恰好已退出，忽略
      }
    }
    this.child = null
    this.ownedProcess = false
    this.status = { state: 'stopped', detail: '已停止' }
  }

  // ─── 内部实现 ───

  private isChildAlive(): boolean {
    return this.child !== null && this.child.exitCode === null && this.child.signalCode === null
  }

  private log(tag: string, msg: string): void {
    if (this.loggerImpl) this.loggerImpl(tag, msg)
  }

  /** 状态提交守门：epoch 变过（期间 stop 过）则不覆盖，返回当前状态 */
  private commit(myEpoch: number, next: WigoloSidecarStatus): WigoloSidecarStatus {
    if (myEpoch !== this.epoch) return this.getStatus()
    this.status = next
    return { ...next }
  }

  private async doEnsureReady(myEpoch: number): Promise<WigoloSidecarStatus> {
    const baseUrl = `http://127.0.0.1:${this.port}`
    this.commit(myEpoch, { state: 'starting', detail: '正在探测 / 启动 wigolo 边车' })

    // 1. 端口上已有健康 daemon（用户手动 `wigolo serve` 常驻）→ 复用，不 spawn
    if (await this.healthCheckImpl(baseUrl)) {
      this.child = null
      this.ownedProcess = false
      return this.commit(myEpoch, { state: 'ready', baseUrl, detail: '复用已在运行的 wigolo daemon' })
    }

    // 2. 定位二进制；找不到 → not-installed + 安装指引（绝不自动下载）
    const binary = this.resolveBinaryImpl()
    if (!binary) {
      return this.commit(myEpoch, { state: 'not-installed', detail: INSTALL_GUIDE })
    }

    // 3. spawn `wigolo serve` 并轮询健康检查直到就绪 / 失败 / 超时
    return this.spawnAndWait(myEpoch, binary, baseUrl)
  }

  private async spawnAndWait(
    myEpoch: number,
    binary: string,
    baseUrl: string,
  ): Promise<WigoloSidecarStatus> {
    let stderrTail = ''
    // 用对象属性而非局部 let：闭包内赋值 + 外层轮询读取，规避 TS 窄化失真
    const exit: { reason: string | null } = { reason: null }

    const child = this.spawnImpl(binary, ['serve', '--port', String(this.port)], {
      env: { ...process.env, ...this.extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    this.child = child
    this.ownedProcess = true

    child.stdout?.on('data', (chunk: Buffer | string) => {
      this.log('wigolo:stdout', String(chunk).trimEnd())
    })
    child.stderr?.on('data', (chunk: Buffer | string) => {
      const text = String(chunk)
      // 只留尾部 2000 字符供失败诊断
      stderrTail = (stderrTail + text).slice(-STDERR_TAIL_CHARS)
      this.log('wigolo:stderr', text.trimEnd())
    })
    child.on('error', (err) => {
      // spawn 本身失败（如 EACCES）；ENOENT 已被 resolveBinary 挡在前面
      exit.reason = `spawn 失败: ${err.message}`
    })
    child.on('exit', (code, signal) => {
      exit.reason = exit.reason ?? `进程提前退出（code=${code} signal=${signal}）`
    })

    const deadline = Date.now() + STARTUP_TIMEOUT_MS
    while (Date.now() < deadline && exit.reason === null && myEpoch === this.epoch) {
      if (await this.healthCheckImpl(baseUrl)) {
        return this.commit(myEpoch, { state: 'ready', baseUrl, detail: '边车已由本进程拉起' })
      }
      if (exit.reason !== null) break
      await delay(POLL_INTERVAL_MS)
    }

    // 失败路径（进程退出 / 20s 超时 / 期间被 stop）：回收自己拉起的进程
    if (exit.reason === null) {
      try {
        child.kill('SIGTERM')
      } catch {
        // 进程可能恰好已退出，忽略
      }
    }
    if (this.child === child) {
      this.child = null
      this.ownedProcess = false
    }
    const reason = exit.reason ?? `健康检查超时（${STARTUP_TIMEOUT_MS / 1000}s 内未就绪）`
    const detail = stderrTail ? `${reason}；stderr 尾部：${stderrTail}` : reason
    return this.commit(myEpoch, { state: 'failed', detail })
  }
}
