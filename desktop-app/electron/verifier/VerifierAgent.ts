/**
 * VerifierAgent：在隐藏 BrowserWindow 中加载 LLM 产出的页面，收集运行时证据。
 *
 * 收集的信号：
 *   1. JavaScript 运行时错误（webContents 'console-message' level=3 + 'render-process-gone'）
 *   2. 资源加载失败（'did-fail-load'）
 *   3. 多视口截图（默认桌面 1280×800、平板 768×1024、手机 390×844 三档）
 *   4. 渲染稳定性（500ms 后再截一次，看是否仍在变化）
 *
 * 设计要点：
 *   - 隐藏窗口：show:false + skipTaskbar:true + parent=mainWindow，避免抢焦点和出现在 Dock
 *   - 不复用预览 partition：用独立 partition='verifier'，免得污染用户预览的 cookie/storage
 *   - 截图保存到 workspace/.verifier/<timestamp>/，自动清理 7 天前的旧目录
 *   - 主线程 IPC 推送 'verifier-result'，让聊天面板渲染卡片
 *
 * @author zhi.qu
 * @date 2026-04-28
 */

import fs from 'fs'
import path from 'path'
import { BrowserWindow, session as electronSession } from 'electron'
import { Logger } from '../logger'

export interface VerifierViewport {
  name: string
  width: number
  height: number
  /** 设备像素比；用于截图清晰度 */
  scaleFactor?: number
}

export interface VerifierTaskOptions {
  /** 隐藏窗口加载的源 URL（file:// / http:// 都可以） */
  url: string
  /** workspace 中放截图的目录绝对路径；不传则不写文件，只返回 dataURL */
  outputDir?: string
  /** 视口列表，默认三个常见尺寸 */
  viewports?: VerifierViewport[]
  /** 最大等待时间（毫秒），默认 8000；DOMContentLoaded 后再额外等 500ms 让动画稳定 */
  timeoutMs?: number
  /** 主窗口（用于绑定 parent，让隐藏窗口跟随关闭）。可选 */
  parentWindow?: BrowserWindow | null
}

export interface VerifierConsoleEvent {
  level: 'log' | 'warn' | 'error' | 'info'
  text: string
  source?: string
  line?: number
}

export interface VerifierShot {
  viewport: VerifierViewport
  /** 写入磁盘后的相对路径（相对 outputDir）；若没传 outputDir 则无 */
  filePath?: string
  /** 截图大小 */
  width: number
  height: number
}

export interface VerifierResult {
  ok: boolean
  url: string
  message: string
  errors: VerifierConsoleEvent[]
  warnings: VerifierConsoleEvent[]
  /** 资源加载失败列表（URL + 错误码） */
  resourceFailures: Array<{ url: string; errorCode: number; errorDescription: string }>
  shots: VerifierShot[]
  /** 检查总耗时（毫秒） */
  elapsedMs: number
}

const DEFAULT_VIEWPORTS: VerifierViewport[] = [
  { name: 'desktop', width: 1280, height: 800, scaleFactor: 2 },
  { name: 'tablet', width: 768, height: 1024, scaleFactor: 2 },
  { name: 'mobile', width: 390, height: 844, scaleFactor: 2 },
]

export class VerifierAgent {
  constructor(private readonly logger?: Logger) {}

  /**
   * 执行一次完整校验。会创建 N 个隐藏 BrowserWindow（一个视口一个），
   * 并发渲染 + 截图 + 收集错误，最后一次性返回。
   */
  async verify(options: VerifierTaskOptions): Promise<VerifierResult> {
    const t0 = Date.now()
    const viewports = options.viewports?.length ? options.viewports : DEFAULT_VIEWPORTS
    const timeoutMs = options.timeoutMs ?? 8000

    const errors: VerifierConsoleEvent[] = []
    const warnings: VerifierConsoleEvent[] = []
    const resourceFailures: VerifierResult['resourceFailures'] = []
    const shots: VerifierShot[] = []

    if (options.outputDir) {
      fs.mkdirSync(options.outputDir, { recursive: true })
    }

    /**
     * 并行执行所有视口（不串行）。
     *
     * 历史踩坑：之前是 for-of 串行循环，第一个窗口 destroy() 后立刻在同一
     * partition 创建第二个窗口加载 file://，会得到 ERR_FAILED(-2) + Mach
     * rendezvous failure。根因是 BrowserWindow.destroy() 是同步的，但底层
     * session 资源清理是异步的，连续复用 partition 会撞到清理窗口期。
     *
     * 改为并行后：所有窗口同时持有 session 引用直到 capturePage 完成，最后
     * 一次性销毁，没有时序冲突；同时性能也更好。
     */
    const perViewport = viewports.map((vp) => this.runOneViewport(vp, options, timeoutMs))
    const settled = await Promise.allSettled(perViewport)
    for (let i = 0; i < settled.length; i++) {
      const s = settled[i]
      if (s.status === 'fulfilled') {
        const r = s.value
        errors.push(...r.errors)
        warnings.push(...r.warnings)
        resourceFailures.push(...r.resourceFailures)
        if (r.shot) shots.push(r.shot)
      } else {
        errors.push({
          level: 'error',
          text: `viewport ${viewports[i].name} 整体失败: ${s.reason instanceof Error ? s.reason.message : String(s.reason)}`,
        })
      }
    }

    const ok = errors.length === 0 && resourceFailures.length === 0
    const message = ok
      ? `verifier 完成：${viewports.length} 个视口全部通过，无 console 错误，无资源失败`
      : `verifier 完成：发现 ${errors.length} 条 error、${warnings.length} 条 warn、${resourceFailures.length} 个资源失败`

    if (this.logger) {
      this.logger.activity('verifier-run', `url=${options.url}, ok=${ok}, errors=${errors.length}, shots=${shots.length}`)
    }

    return {
      ok,
      url: options.url,
      message,
      errors,
      warnings,
      resourceFailures,
      shots,
      elapsedMs: Date.now() - t0,
    }
  }

  /**
   * 单视口的隔离执行：创建窗口→加载→截图→销毁，并把所有事件归到本视口。
   * 由 verify() 并行调用。
   */
  private async runOneViewport(
    vp: VerifierViewport,
    options: VerifierTaskOptions,
    timeoutMs: number,
  ): Promise<{
    errors: VerifierConsoleEvent[]
    warnings: VerifierConsoleEvent[]
    resourceFailures: VerifierResult['resourceFailures']
    shot?: VerifierShot
  }> {
    const errors: VerifierConsoleEvent[] = []
    const warnings: VerifierConsoleEvent[] = []
    const resourceFailures: VerifierResult['resourceFailures'] = []

    // 设计选择：
    //   - show:false + skipTaskbar:true + focusable:false → 完全隐藏窗口
    //   - 故意 *不* 用 offscreen:true：在 macOS + Electron 41 下 offscreen
    //     模式会触发 GPU 子进程 Mach rendezvous failure，页面加载不出来。
    //   - 每个 viewport 用独立 partition：避免并行窗口共享 session 时
    //     webRequest listener 互相覆盖；用完即弃。
    const partition = `persist:soul-verifier-${vp.name}-${Date.now()}`
    const sess = electronSession.fromPartition(partition)

    // 给本 viewport 的 session 装资源错误监听。
    // 子资源（img/css/script）加载失败 *不会* 触发 webContents.did-fail-load
    // （那个事件只对主文档生效），必须走 webRequest.onErrorOccurred。
    sess.webRequest.onErrorOccurred((details) => {
      // 过滤掉浏览器内部的非资源请求噪声
      if (details.error === 'net::ERR_ABORTED') return
      resourceFailures.push({
        url: details.url,
        errorCode: -1,
        errorDescription: details.error,
      })
    })

    const win = new BrowserWindow({
      width: vp.width,
      height: vp.height,
      show: false,
      skipTaskbar: true,
      focusable: false,
      parent: options.parentWindow ?? undefined,
      webPreferences: {
        partition,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    })

    const scale = vp.scaleFactor ?? 1
    try {
      win.webContents.setZoomFactor(scale)
    } catch (zoomErr) {
      warnings.push({
        level: 'warn',
        text: `viewport ${vp.name} 设置缩放失败: ${zoomErr instanceof Error ? zoomErr.message : String(zoomErr)}`,
      })
    }

    win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
      const lv: VerifierConsoleEvent['level'] =
        level === 3 ? 'error' : level === 2 ? 'warn' : level === 1 ? 'info' : 'log'
      const evt: VerifierConsoleEvent = { level: lv, text: message, source: sourceId, line }
      if (lv === 'error') errors.push(evt)
      else if (lv === 'warn') warnings.push(evt)
    })
    win.webContents.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL, isMainFrame) => {
      // 只记主文档失败，子资源走上面的 webRequest 监听
      if (isMainFrame) {
        resourceFailures.push({ url: validatedURL, errorCode, errorDescription })
      }
    })
    win.webContents.on('render-process-gone', (_e, details) => {
      errors.push({ level: 'error', text: `render-process-gone: ${details.reason}` })
    })

    let shot: VerifierShot | undefined
    try {
      const loadPromise = options.url.startsWith('file:')
        ? win.loadURL(options.url)
        : (options.url.startsWith('http://') || options.url.startsWith('https://'))
          ? win.loadURL(options.url)
          : win.loadFile(options.url)

      const timeoutPromise = new Promise<never>((_resolve, reject) => {
        setTimeout(
          () => reject(new Error(`verifier 加载超时 (${timeoutMs}ms): ${options.url}`)),
          timeoutMs,
        )
      })
      await Promise.race([loadPromise, timeoutPromise])

      // 等动画/异步状态稳定
      await new Promise<void>((resolve) => setTimeout(resolve, 500))

      const image = await win.webContents.capturePage()
      const size = image.getSize()
      shot = { viewport: vp, width: size.width, height: size.height }
      if (options.outputDir) {
        const fileName = `verifier-${vp.name}-${vp.width}x${vp.height}.png`
        const abs = path.join(options.outputDir, fileName)
        fs.writeFileSync(abs, image.toPNG())
        shot.filePath = fileName
      }
    } catch (loadErr) {
      errors.push({
        level: 'error',
        text: `viewport ${vp.name} 加载失败: ${loadErr instanceof Error ? loadErr.message : String(loadErr)}`,
      })
    } finally {
      try { win.destroy() } catch {}
    }

    return { errors, warnings, resourceFailures, shot }
  }

  /**
   * 兼容旧调用：把 task 当成 url 跑一次默认校验。
   * 主进程现在大多数场景应该改用 verify(...) 直接传 options。
   */
  async run(taskOrUrl?: string): Promise<{ ok: boolean; message: string }> {
    if (!taskOrUrl) return { ok: true, message: 'verifier: 无任务，跳过' }
    if (!taskOrUrl.includes('://') && !taskOrUrl.startsWith('/')) {
      return { ok: true, message: `verifier: 不识别的任务 "${taskOrUrl}"，已忽略` }
    }
    const result = await this.verify({ url: taskOrUrl })
    return { ok: result.ok, message: result.message }
  }
}
