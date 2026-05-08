/**
 * 文档生成：HTML → PDF 渲染器（Electron 主进程）
 *
 * 工作原理：
 *   1. 起一个隐藏的 BrowserWindow（offscreen 风格，partition 与正常窗口隔离）
 *   2. 用 data URL 加载完整 HTML（避免临时文件读写）
 *   3. 等 did-finish-load 后（再延时 200ms 让字体/分页渲染稳定），调 webContents.printToPDF
 *   4. 输出文件并 stat 取大小，最终关闭窗口
 *
 * 错误与超时：
 *   - try/finally 保证 BrowserWindow 一定被销毁
 *   - 30s 超时通过 Promise.race 触发，超时同样会回滚已写入的半成品
 *   - 写盘失败时主动 unlink 半成品（避免留下损坏文件）
 *
 * 与 save_as_pdf 的区别：
 *   - save_as_pdf 的输入是磁盘 HTML 文件路径
 *   - 本函数直接吃 HTML 字符串（避免 generateDocument 写中间文件）
 *
 * @author zhi.qu
 * @date 2026-05-08
 */

import fs from 'fs'
import path from 'path'
import { BrowserWindow } from 'electron'
import type { Logger } from '../logger'

/** PDF 渲染默认超时（毫秒） */
const RENDER_TIMEOUT_MS = 30_000
/** loadURL 后等待字体/排版稳定的额外延时（毫秒） */
const POST_LOAD_SETTLE_MS = 200
/** data URL 大小上限（避免极端 IR 撑爆 loadURL） */
const MAX_DATA_URL_BYTES = 8 * 1024 * 1024

export interface RenderDocumentPdfOptions {
  /** 自定义超时（毫秒），默认 30000 */
  timeoutMs?: number
  /** 注入用的 logger，缺失时使用 console（仅供调用方简化测试） */
  logger?: Pick<Logger, 'activity' | 'error'>
}

export interface RenderDocumentPdfResult {
  /** 输出文件大小（字节） */
  size: number
}

/**
 * 把 HTML 字符串渲染为 PDF 文件。
 *
 * @param html       完整 HTML 文档字符串（含 DOCTYPE）
 * @param outputPath PDF 输出绝对路径
 * @returns          { size } 实际写入文件大小
 * @throws Error     渲染 / 写盘失败 / 超时
 */
export async function renderDocumentPdf(
  html: string,
  outputPath: string,
  options: RenderDocumentPdfOptions = {},
): Promise<RenderDocumentPdfResult> {
  const timeoutMs = options.timeoutMs ?? RENDER_TIMEOUT_MS
  const logger = options.logger
  const startedAt = Date.now()
  logger?.activity('document-pdf-render-start', `out=${outputPath} bytes=${html.length}`)

  if (!html || html.length === 0) {
    throw new Error('document-pdf 渲染失败：HTML 为空')
  }

  const dataUrl = 'data:text/html;charset=utf-8,' + encodeURIComponent(html)
  if (Buffer.byteLength(dataUrl, 'utf8') > MAX_DATA_URL_BYTES) {
    throw new Error(`document-pdf 渲染失败：HTML 过大（编码后 > ${MAX_DATA_URL_BYTES} 字节）`)
  }

  let win: BrowserWindow | null = null
  let writtenPartial = false
  try {
    win = new BrowserWindow({
      show: false,
      webPreferences: {
        partition: 'persist:soul-document-pdf',
        offscreen: false,
        sandbox: true,
        contextIsolation: true,
      },
    })

    const loadPromise = (async () => {
      await win!.loadURL(dataUrl)
      await delay(POST_LOAD_SETTLE_MS)
      const pdfBuffer = await win!.webContents.printToPDF({
        pageSize: 'A4',
        printBackground: true,
        displayHeaderFooter: true,
        margins: { top: 0.5, bottom: 0.5, left: 0.5, right: 0.5 },
        preferCSSPageSize: true,
      })

      fs.mkdirSync(path.dirname(outputPath), { recursive: true })
      fs.writeFileSync(outputPath, pdfBuffer)
      writtenPartial = true
      const stat = fs.statSync(outputPath)
      writtenPartial = false
      return { size: stat.size }
    })()

    const result = await Promise.race([
      loadPromise,
      timeoutPromise<RenderDocumentPdfResult>(timeoutMs),
    ])

    logger?.activity('document-pdf-render-done', `out=${outputPath} size=${result.size} elapsed=${Date.now() - startedAt}ms`)
    return result
  } catch (err) {
    if (writtenPartial) safeUnlink(outputPath)
    const e = err instanceof Error ? err : new Error(String(err))
    logger?.error('document-pdf-render', e)
    throw e
  } finally {
    if (win && !win.isDestroyed()) {
      try { win.destroy() } catch { /* ignore */ }
    }
  }
}

// ─── 内部工具 ──────────────────────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function timeoutPromise<T>(ms: number): Promise<T> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`document-pdf 渲染超时（${ms}ms）`)), ms)
  })
}

function safeUnlink(p: string): void {
  try {
    if (fs.existsSync(p)) fs.unlinkSync(p)
  } catch {
    /* ignore */
  }
}
