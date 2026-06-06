import fs from 'fs'
import path from 'path'
import { Worker } from 'node:worker_threads'
import { JSDOM } from 'jsdom'

import { parseExcelCore } from './excel/excel-parse-core'
import type { ExcelColumnSchema, ExcelRowMetaRole, ExcelSheetData, ExcelStructuredData } from './excel/excel-types'

// Excel 类型/函数原定义在本文件，现抽到 ./excel/* 供主线程与 worker 共用；
// 此处 re-export 保持对外 API 不变（外部仍可从 document-parser import 这些符号）。
export { inferRowMetaRole } from './excel/excel-parse-core'
export type { ExcelColumnSchema, ExcelRowMetaRole, ExcelSheetData, ExcelStructuredData }

export interface ParsedDocument {
  /** 提取的纯文本内容 */
  text: string
  /** 提取到的图片，格式为 base64 data URL (data:image/png;base64,...) */
  images: string[]
  /** 原始文件名 */
  fileName: string
  /** 文件类型 */
  fileType: 'pdf' | 'word' | 'pptx' | 'image' | 'text' | 'excel'
  /** Excel sheet 名称列表（Excel 专属，用于 UI 展示） */
  sheetNames?: string[]
  /** 每页的字符数，用于定位 Vision 数据在原文中的位置（PDF 专属） */
  perPageChars?: Array<{ num: number; chars: number }>
  /** 图表页截图对应的页码列表（与 images 数组一一对应） */
  imagePageNumbers?: number[]
  /**
   * Excel 专属：结构化数据（含 schema + 原始行）。
   * 用于 query_excel 工具精确过滤，避免把整个表塞进 system prompt。
   */
  structuredData?: ExcelStructuredData
}

/**
 * 检测文本是否为乱码（PDF CID 字体编码错误导致的 Unicode 乱码）。
 * 原理：正常中文/英文文档中，常见字符（CJK 基本区 + ASCII 字母数字 + 常见标点）占比应 > 50%。
 * CID 字体乱码会产出大量稀有 Unicode 字符（Sinhala / Gujarati / Tibetan / Canadian Syllabics 等），
 * 导致常见字符占比骤降。
 */
export function isGarbledText(text: string): boolean {
  const stripped = text.replace(/\s+/g, '')
  if (stripped.length < 20) return false
  // 常见字符：CJK 基本区 + ASCII 字母数字 + 中英文标点
  const commonChars = stripped.replace(/[A-Za-z0-9\u4E00-\u9FFF\u3000-\u303F\uFF00-\uFFEF.,;:!?'"()[\]{}<>@#$%^&*+=\-_/\\|~`，。；：！？、""''（）【】《》—…·\u00A0\u2000-\u206F]/g, '')
  const ratio = 1 - commonChars.length / stripped.length
  return ratio < 0.4
}

/**
 * 判断 PDF 某页是否需要 OCR（图纸/图表/扫描件/乱码页）。
 * 智能策略：
 *   - 乱码页 → 一定 OCR（CID 字体编码错误，文字提取为乱码）
 *   - < 300 chars → 一定 OCR（扫描件 / 纯图片页）
 *   - 300-1000 chars + 噪音比 > 25% → OCR（工程图纸：大量单字符行 A B C 1 2 3）
 *   - 其他 → 正常文字页，不 OCR
 *
 * 经模拟测试验证：工程图纸 PDF 16/16 页全覆盖，文字文档（规格书/证书）不误触。
 */
function shouldOcrPage(pageText: string): boolean {
  const stripped = pageText.replace(/\s+/g, '')
  const chars = stripped.length
  if (chars < 300) return true
  // 乱码检测：CID 字体编码错误导致的 Unicode 乱码，必须走 OCR
  if (isGarbledText(pageText)) return true
  if (chars >= 1000) return false
  // 300-1000 区间：检查噪音比（单字符行占比 > 25% = 工程图纸图框坐标噪音）
  const lines = pageText.split(/\n/).filter(l => l.trim())
  if (lines.length === 0) return true
  const singleCharLines = lines.filter(l => l.trim().length <= 2).length
  return singleCharLines / lines.length > 0.25
}

/**
 * 图表页截图数量上限。200 页 ≈ 200-600MB 内存，覆盖绝大多数场景。
 * 超过时均匀采样，确保首/中/尾都覆盖。
 */
const MAX_SCREENSHOT_PAGES = 200

/** 单次导入文件大小上限（200MB） */
export const MAX_PARSE_FILE_BYTES = 200 * 1024 * 1024

/** 单文件解析超时（5 分钟），防止大文件卡死主进程 */
const PARSE_TIMEOUT_MS = 5 * 60 * 1000

/**
 * 本解析器当前支持的文件扩展名（含 . 前缀，小写）。
 * folder-importer 据此过滤要导入的文件。
 */
export const SUPPORTED_PARSE_EXTENSIONS: readonly string[] = [
  '.pdf',
  '.doc',
  '.docx',
  '.pptx',
  '.xlsx',
  '.xls',
  '.csv',
  '.txt',
  '.md',
  '.html',
  '.htm',
  '.jpg',
  '.jpeg',
  '.png',
  '.gif',
  '.webp',
  '.bmp',
] as const

/** 单次 parseFile 调用专属的中止令牌（超时后置 aborted=true，避免并发调用互相污染） */
interface AbortToken {
  aborted: boolean
}

let excelWorkerWarned = false

/**
 * 解析 excel-parse-worker.cjs 的物理路径。
 *
 * 兼容三种运行态：
 *   - 打包后：与 main 同在 dist-electron（__dirname）。若 asarUnpack 生效，物理文件在
 *     app.asar.unpacked，显式重定向兜底（worker 加载 asar 虚拟路径在部分场景会失败）。
 *   - 本地 build 后跑源码 / 单测：electron/ → ../dist-electron。
 *   - 都没有（dev 未 build）：返回 null，由调用方退回主线程同步解析。
 */
function resolveExcelWorkerPath(): string | null {
  const candidates = [
    path.join(__dirname, 'excel-parse-worker.cjs'),
    path.join(__dirname, '..', 'dist-electron', 'excel-parse-worker.cjs'),
  ]
  for (const c of candidates) {
    if (c.includes(`app.asar${path.sep}`) && !c.includes('app.asar.unpacked')) {
      const unpacked = c.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`)
      if (fs.existsSync(unpacked)) return unpacked
    }
    if (fs.existsSync(c)) return c
  }
  return null
}

/**
 * DocumentParser: 负责解析 PDF / Word / 图片 / 文本文件，提取文字和图片。
 * - PDF → pdf-parse v2 提取文字；文字少的页面同时渲染为截图供 OCR 识别图表内容
 * - Word (.docx) → mammoth 提取文本
 * - 图片 → 编码为 base64 data URL，交由渲染进程调用 Qwen VL OCR
 * - 纯文本 → 直接读取
 */
export class DocumentParser {
  /** 解析文件，返回文本内容和图片列表。带超时保护。 */
  async parseFile(filePath: string): Promise<ParsedDocument> {
    // 超时标志：本次调用专属，避免共享单例的并发 parseFile 互相污染中止状态。
    // parseFile 超时后置 aborted=true，parsePdf 中的耗时操作检查此 token 提前退出。
    const token: AbortToken = { aborted: false }
    let timer: NodeJS.Timeout | null = null
    try {
      return await Promise.race([
        this._parseFileImpl(filePath, token),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            token.aborted = true
            reject(new Error(`解析超时（>${PARSE_TIMEOUT_MS / 1000}秒），文件可能过大: ${path.basename(filePath)}`))
          }, PARSE_TIMEOUT_MS)
        }),
      ])
    } finally {
      // 关键：成功路径必须 clearTimeout，否则 timer 挂到 event loop 上
      // 导致批量处理 300 文件后 CLI 进程迟迟不退出（生产 Electron 长驻进程不受影响）
      if (timer) clearTimeout(timer)
    }
  }

  private async _parseFileImpl(filePath: string, token: AbortToken): Promise<ParsedDocument> {
    const stat = await fs.promises.stat(filePath)
    if (!stat.isFile()) {
      throw new Error(`路径不是普通文件: ${filePath}`)
    }
    if (stat.size > MAX_PARSE_FILE_BYTES) {
      throw new Error(`文件过大（>${Math.floor(MAX_PARSE_FILE_BYTES / (1024 * 1024))}MB），请拆分后导入: ${path.basename(filePath)}`)
    }
    const ext = path.extname(filePath).toLowerCase()
    const fileName = path.basename(filePath)

    switch (ext) {
      case '.pdf':
        return this.parsePdf(filePath, fileName, token)
      case '.docx':
        return this.parseWord(filePath, fileName)
      case '.doc':
        return this.parseDocLegacy(filePath, fileName)
      case '.pptx':
        return this.parsePptx(filePath, fileName)
      case '.xlsx':
      case '.xls':
      case '.csv':
        // .csv / .xls 走 xlsx 路径，SheetJS 支持所有 Excel 格式
        return this.parseExcel(filePath, fileName)
      case '.jpg':
      case '.jpeg':
      case '.png':
      case '.gif':
      case '.webp':
      case '.bmp':
        return this.parseImage(filePath, fileName)
      case '.txt':
      case '.md':
        return this.parseText(filePath, fileName)
      case '.html':
      case '.htm':
        return this.parseHtml(filePath, fileName)
      default:
        throw new Error(`不支持的文件类型: ${ext}`)
    }
  }

  /**
   * 解析 PDF 文件：提取每页文字、统计字符数、按文字密度筛选需要 Vision OCR 的图表页。
   *
   * Template-based chunking（#14 子任务 1）：
   *   多页 PDF（pages.length >= 2）会在每页内容前注入 `### 第 N 页` 三级标题，
   *   返回的 text 形如：
   *     ### 第 1 页
   *
   *     <page 1 文字>
   *
   *     ### 第 2 页
   *
   *     <page 2 文字>
   *   这样 packages/core/src/knowledge-retriever.ts 的 buildChunks 会按 heading
   *   切 chunk，让"PDF 第 N 页"自然成为最小检索单元。本方法只负责注入侧，
   *   不依赖也不修改 knowledge-retriever。
   *   单页 PDF 不注入，保持现有行为不变。
   */
  private async parsePdf(filePath: string, fileName: string, token: AbortToken): Promise<ParsedDocument> {
    // pdfjs-dist 的 fake worker 模式通过 import("./pdf.worker.mjs") 加载 worker。
    // 在 Windows 打包后 asar 内 import() 加载 .mjs 有兼容性问题。
    // 预加载 CJS 版本的 worker 并挂到 globalThis，pdfjs-dist 检测到后直接使用。
    if (!(globalThis as Record<string, unknown>).pdfjsWorker) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports -- pdf-worker.cjs 是运行时动态产物路径，ESM import 不支持
        ;(globalThis as Record<string, unknown>).pdfjsWorker = require(
          path.join(__dirname, 'pdf-worker.cjs')
        )
      } catch (e) {
        console.warn('[DocumentParser] 预加载 pdf worker 失败（将回退到动态 import）:', e)
      }
    }
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { PDFParse } = require('pdf-parse')
    const buffer = await fs.promises.readFile(filePath)
    const data = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
    const parser = new PDFParse({ data })

    try {
    // 1. 提取全文
    const textResult = await parser.getText({ parsePageInfo: true })
    const rawFullText: string = textResult.text || ''

    // 2. 统计每页字符数（用于 Vision 数据定位），并找出图表页
    const perPageChars: Array<{ num: number; chars: number }> = []
    const imageDensePages: number[] = []
    const hasPageInfo = Array.isArray(textResult.pages) && textResult.pages.length > 0
    if (hasPageInfo) {
      textResult.pages.forEach((page: { num: number; text: string }) => {
        const chars = (page.text || '').replace(/\s+/g, '').length
        perPageChars.push({ num: page.num, chars })
        if (shouldOcrPage(page.text || '')) {
          imageDensePages.push(page.num)
        }
      })
    }

    // 2.5 多页 PDF 注入 `### 第 N 页` 三级标题，让下游 knowledge-retriever.buildChunks
    //     按页自然切分 chunk（# / ## / ### 都是 buildChunks 识别的 section 边界）。
    //     - 用 ###（三级）而非 ##（二级），避开 PPTX 的 `## 第 N 页` 命名空间，
    //       两类文档同时出现时不会互相吞并 chunk。
    //     - 单页 PDF（pages.length < 2）不注入，保持现有行为；过短文档加 heading
    //       反而会被 chunker 当成独立 section 误切。
    //     - 空页（page.text 空白或仅空白）跳过，不产生空 heading。
    //     - pages 数组缺失（pdfjs 异常）时回退到 textResult.text。
    //     注：本逻辑仅修改返回的 text 字段，不触碰 packages/core/src/knowledge-retriever.ts
    //     —— heading 注入侧 + chunker 识别侧解耦，互不感知具体规则。
    let fullText: string = rawFullText
    if (hasPageInfo && textResult.pages.length >= 2) {
      const sections: string[] = []
      for (const page of textResult.pages as Array<{ num: number; text: string }>) {
        const pageText = page.text || ''
        if (pageText.trim() === '') continue
        sections.push(`### 第 ${page.num} 页\n\n${pageText}`)
      }
      if (sections.length > 0) {
        fullText = sections.join('\n\n')
      }
    }

    // 分页信息缺失的 fallback：若全文本身稀疏/乱码，就把所有页当图表页走 OCR，
    // 避免 pdfjs 拿不到 perPage 时整份文档零截图（曾出现于某些 CNAS 测试报告）。
    // 页号列表从 getScreenshot 拿，这样即使分页 API 失败也能兜底。
    // 注意：这里判定原文质量必须用 rawFullText（pdfjs 提取的原始文字），
    //      不能用注入了 `### 第 N 页` 的 fullText —— 注入的标题字符不属于 PDF 原文。
    let needsFullDocFallback = false
    if (imageDensePages.length === 0 && shouldOcrPage(rawFullText)) {
      needsFullDocFallback = true
    }

    // 3. 渲染截图并按文字密度筛选（getScreenshot 的 pages 参数在 v2 中无效），限制最大页数
    const images: string[] = []
    const imagePageNumbers: number[] = []
    if (imageDensePages.length > MAX_SCREENSHOT_PAGES) {
      // 均匀采样而非只取前 N 页，确保 PDF 首/中/尾的图表页都被覆盖
      const step = imageDensePages.length / MAX_SCREENSHOT_PAGES
      const sampled: number[] = []
      for (let i = 0; i < MAX_SCREENSHOT_PAGES; i++) {
        sampled.push(imageDensePages[Math.floor(i * step)])
      }
      console.warn(`[DocumentParser] 图表页 ${imageDensePages.length} 页超过上限 ${MAX_SCREENSHOT_PAGES}，均匀采样 ${sampled.length} 页`)
      imageDensePages.length = 0
      imageDensePages.push(...sampled)
    }
    if ((imageDensePages.length > 0 || needsFullDocFallback) && !token.aborted) {
      try {
        const imageDenseSet = new Set(imageDensePages)
        const screenshotResult = await parser.getScreenshot({ scale: 2 })
        const allPages = screenshotResult.pages as Array<{ pageNumber: number; dataUrl?: string }>
        // fallback 模式：前 MAX_SCREENSHOT_PAGES 页全截图
        const pagesToShot = needsFullDocFallback
          ? allPages.slice(0, MAX_SCREENSHOT_PAGES)
          : allPages.filter(p => imageDenseSet.has(p.pageNumber))
        if (needsFullDocFallback) {
          console.warn(`[DocumentParser] 分页信息缺失且全文稀疏/乱码，fallback 截图 ${pagesToShot.length}/${allPages.length} 页`)
        }
        for (const screenshot of pagesToShot) {
          if (screenshot.dataUrl) {
            images.push(screenshot.dataUrl)
            imagePageNumbers.push(screenshot.pageNumber)
          }
        }
      } catch (err) {
        console.error('[DocumentParser] PDF 截图失败:', err)
      }
    }

    return {
      text: fullText,
      images,
      fileName,
      fileType: 'pdf',
      perPageChars,
      imagePageNumbers,
    }
    } finally {
      // 释放 pdfjs 底层 document，避免批量导入 300+ 文件时 worker 累积状态导致
      // 后续文件随机出现"0 截图"的 flake。单文件场景 destroy 无副作用。
      // 用 finally 确保任意提前 return / throw（含超时后 race 失败、getText 抛错、
      // 截图 catch）路径都会释放 parser，不再泄漏 pdfjs document + worker。
      try { await parser.destroy() } catch { /* ignore */ }
    }
  }

  /**
   * 解析 Word .docx 文件：优先用 mammoth.convertToHtml + Turndown 拿带标题层级的 markdown，
   * 让 packages/core/src/knowledge-retriever.ts 的 buildChunks 按 # / ## / ### 切 chunk。
   *
   * 三级兜底链：
   *   1. mammoth.convertToHtml(styleMap) → HTML → Turndown → Markdown（主路径）
   *   2. mammoth.extractRawText（一级回退：丢失标题层级，但纯文本可用）
   *   3. adm-zip 解 word/document.xml 直抽 <w:t>（二级回退：覆盖表格/文本框/SDT 控件）
   *
   * styleMap 同时声明中英文标题样式，因为 Office 中文版创建的文档 style-name 是 `标题 1/2/...`，
   * 而英文 Office 创建的是 `Heading 1/2/...`，mammoth 默认 styleMap 只覆盖英文映射。
   */
  private async parseWord(filePath: string, fileName: string): Promise<ParsedDocument> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mammoth = require('mammoth')

    // 中英文 Word 标题样式 → HTML h1-h6 的显式映射。`:fresh` 修饰确保每个标题
    // 独占段落，不会和前后内容合并到同一行。
    const styleMap = [
      "p[style-name='标题 1'] => h1:fresh",
      "p[style-name='标题 2'] => h2:fresh",
      "p[style-name='标题 3'] => h3:fresh",
      "p[style-name='标题 4'] => h4:fresh",
      "p[style-name='标题 5'] => h5:fresh",
      "p[style-name='标题 6'] => h6:fresh",
      "p[style-name='Heading 1'] => h1:fresh",
      "p[style-name='Heading 2'] => h2:fresh",
      "p[style-name='Heading 3'] => h3:fresh",
      "p[style-name='Heading 4'] => h4:fresh",
      "p[style-name='Heading 5'] => h5:fresh",
      "p[style-name='Heading 6'] => h6:fresh",
    ]

    let text = ''

    // 主路径：convertToHtml → Turndown 转 markdown，保留标题层级与列表/表格
    try {
      const htmlResult = await mammoth.convertToHtml({ path: filePath, styleMap })
      const html: string = htmlResult?.value || ''
      if (html.trim() !== '') {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const TurndownService = require('turndown')
        const turndown = new TurndownService({
          headingStyle: 'atx',
          bulletListMarker: '-',
          codeBlockStyle: 'fenced',
        })
        text = turndown.turndown(html)
      }
    } catch (err) {
      console.warn(
        `[DocumentParser] docx convertToHtml/Turndown 失败（${fileName}），回退到 extractRawText:`,
        err,
      )
    }

    // 一级回退：extractRawText（主路径无输出 / 抛错时使用）
    if (text.trim() === '') {
      try {
        const result = await mammoth.extractRawText({ path: filePath })
        text = result?.value || ''
      } catch (err) {
        console.warn(
          `[DocumentParser] docx extractRawText 也失败（${fileName}）:`,
          err,
        )
      }
    }

    // docx 是 zip 包。同一次打开拿两样东西：① word/media/* 图片（兜底 Vision OCR）
    // ② 如果 mammoth 输出过短，从 word/document.xml 直抽 <w:t> 节点 fallback
    //   —— 覆盖 mammoth.extractRawText 遗漏的表格单元格、文本框、SDT 内容控件等
    const images: string[] = []
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const AdmZip = require('adm-zip')
      const zip = new AdmZip(filePath)
      const entries = zip.getEntries() as Array<{ entryName: string; getData: () => Buffer }>
      for (const e of entries) {
        const m = e.entryName.match(/^word\/media\/.+\.(png|jpe?g|gif|bmp|webp)$/i)
        if (!m) continue
        const ext = m[1].toLowerCase()
        const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : `image/${ext}`
        images.push(`data:${mime};base64,${e.getData().toString('base64')}`)
        if (images.length >= MAX_SCREENSHOT_PAGES) break
      }

      // 表格型 docx fallback：mammoth 提取字符过少且文件 > 20KB → 直抽 <w:t>
      const stat = await fs.promises.stat(filePath)
      if (text.replace(/\s+/g, '').length < 500 && stat.size > 20 * 1024) {
        const docEntry = entries.find(e => e.entryName === 'word/document.xml')
        if (docEntry) {
          const xml = docEntry.getData().toString('utf-8')
          // 按 </w:p>、</w:tr>、<w:br/> 作为块分隔符，在 <w:t> 节点间插换行，
          // 保留段落/表格行的视觉结构（而不是扁平拼接）。
          const segments: string[] = []
          const segRegex = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<\/w:p>|<\/w:tr>|<w:br\/>/g
          let m2: RegExpExecArray | null
          let buf = ''
          while ((m2 = segRegex.exec(xml)) !== null) {
            if (m2[1] !== undefined) {
              buf += m2[1]
                .replace(/&amp;/g, '&')
                .replace(/&lt;/g, '<')
                .replace(/&gt;/g, '>')
                .replace(/&quot;/g, '"')
                .replace(/&apos;/g, "'")
            } else {
              if (buf.trim()) segments.push(buf.trim())
              buf = ''
            }
          }
          if (buf.trim()) segments.push(buf.trim())
          const xmlText = segments.join('\n')
          if (xmlText.length > text.length) {
            console.warn(`[DocumentParser] docx mammoth 提取过短（${text.length} 字），使用 XML fallback（${xmlText.length} 字）`)
            text = xmlText
          }
        }
      }
    } catch (err) {
      console.warn('[DocumentParser] docx 图片/XML fallback 失败:', err)
    }

    return {
      text,
      images,
      fileName,
      fileType: 'word',
    }
  }

  /** 解析旧版 .doc（OLE2 二进制格式），使用 word-extractor 纯 JS 库 */
  private async parseDocLegacy(filePath: string, fileName: string): Promise<ParsedDocument> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const WordExtractor = require('word-extractor')
    const extractor = new WordExtractor()
    const doc = await extractor.extract(filePath)
    const body = doc.getBody() || ''
    const footnotes = doc.getFootnotes() || ''
    const endnotes = doc.getEndnotes() || ''
    const parts = [body, footnotes, endnotes].filter(Boolean)
    return {
      text: parts.join('\n\n'),
      images: [],
      fileName,
      fileType: 'word',
    }
  }

  /**
   * 解析 PowerPoint (.pptx) 文件。pptx 本质是 zip 包，内含 ppt/slides/slide*.xml。
   * 提取每张幻灯片的文本内容，按幻灯片编号组织。
   * 使用已有依赖 adm-zip（批量导入已引入）。
   */
  private async parsePptx(filePath: string, fileName: string): Promise<ParsedDocument> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const AdmZip = require('adm-zip')
    const zip = new AdmZip(filePath)
    const entries = zip.getEntries() as Array<{ entryName: string; getData: () => Buffer }>

    // 收集所有 slide XML 文件并按编号排序
    const slideEntries = entries
      .filter((e: { entryName: string }) => /^ppt\/slides\/slide\d+\.xml$/.test(e.entryName))
      .sort((a: { entryName: string }, b: { entryName: string }) => {
        const numA = parseInt(a.entryName.match(/slide(\d+)/)?.[1] || '0', 10)
        const numB = parseInt(b.entryName.match(/slide(\d+)/)?.[1] || '0', 10)
        return numA - numB
      })

    if (slideEntries.length === 0) {
      return { text: '_（pptx 中未找到幻灯片）_', images: [], fileName, fileType: 'text' }
    }

    const sections: string[] = []
    for (let i = 0; i < slideEntries.length; i++) {
      const xml = slideEntries[i].getData().toString('utf-8')
      // 提取所有 <a:t> 文本节点（PowerPoint XML 中文本存储在 <a:t> 标签内）。
      //
      // ⚠️ 正则必须区分 <a:t> 与 <a:tblPr>/<a:tbl>/<a:tc>/<a:tr>/<a:txBody> 等。
      // 原实现 /<a:t[^>]*>/ 会让 [^>]* 吃掉 "blPr" 等字符，错误地匹配到 <a:tblPr>
      // 等标签，把整段嵌套 XML 当作文本拉出来。
      //
      // 正确写法：<a:t 后面要么直接是 >（无属性），要么是空白 + 属性。用
      // (?:\s[^>]*)? 保证后续字符要么不存在，要么以空白开头。这样 <a:tblPr>
      // 在 "blPr" 处失败（b 不是空白也不是 >），不会误匹配。
      const texts: string[] = []
      const regex = /<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g
      let match: RegExpExecArray | null
      while ((match = regex.exec(xml)) !== null) {
        // XML 实体反转义（&amp; &lt; &gt; &quot; &apos;）
        const t = match[1]
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/&apos;/g, "'")
          .trim()
        if (t) texts.push(t)
      }
      if (texts.length > 0) {
        sections.push(`## 第 ${i + 1} 页\n\n${texts.join('\n')}`)
      }
    }

    const header = `> 导入自 PowerPoint: ${fileName} | ${slideEntries.length} 张幻灯片\n\n---\n`
    return {
      text: header + '\n' + (sections.length > 0 ? sections.join('\n\n---\n\n') : '_（幻灯片中无文本内容）_'),
      images: [],
      fileName,
      fileType: 'pptx',
    }
  }

  private async parseImage(filePath: string, fileName: string): Promise<ParsedDocument> {
    const ext = path.extname(filePath).toLowerCase().slice(1)
    const mimeType = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
      : ext === 'png' ? 'image/png'
      : ext === 'gif' ? 'image/gif'
      : ext === 'webp' ? 'image/webp'
      : ext === 'bmp' ? 'image/bmp'
      : 'application/octet-stream'
    const buffer = await fs.promises.readFile(filePath)
    const base64 = buffer.toString('base64')
    const dataUrl = `data:${mimeType};base64,${base64}`
    return {
      text: '',
      images: [dataUrl],
      fileName,
      fileType: 'image',
    }
  }

  private async parseText(filePath: string, fileName: string): Promise<ParsedDocument> {
    const text = await fs.promises.readFile(filePath, 'utf-8')
    return {
      text,
      images: [],
      fileName,
      fileType: 'text',
    }
  }

  private async parseHtml(filePath: string, fileName: string): Promise<ParsedDocument> {
    const html = await fs.promises.readFile(filePath, 'utf-8')
    const dom = new JSDOM(html)
    const { document } = dom.window

    document.querySelectorAll('script, style, noscript, template').forEach(el => el.remove())
    document.querySelectorAll('br').forEach(el => el.replaceWith(document.createTextNode('\n')))
    document
      .querySelectorAll('p, div, section, article, header, footer, main, aside, nav, li, tr, h1, h2, h3, h4, h5, h6')
      .forEach(el => el.appendChild(document.createTextNode('\n')))

    const title = document.title.trim()
    const bodyText = (document.body?.textContent ?? document.documentElement.textContent ?? '')
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n[ \t]+/g, '\n')
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
    const text = title && !bodyText.includes(title) ? `${title}\n\n${bodyText}` : bodyText

    return {
      text,
      images: [],
      fileName,
      fileType: 'text',
    }
  }

  /**
   * 解析 Excel/CSV → Markdown + 结构化数据。
   *
   * 同步重活（XLSX.readFile + sheet_to_json）跑在 worker_threads 里（excel-parse-worker.cjs），
   * 避免大 xlsx 冻结主进程事件循环；超时用 worker.terminate() 强杀卡死的同步解析——这是
   * 主进程内联跑做不到的（被锁死的事件循环里 Promise.race 超时回调永远排不上）。
   * 若 worker 产物缺失（dev 未 build / 单测源码态）则退回主线程同步解析，保证功能不缺失。
   */
  private parseExcel(filePath: string, fileName: string): Promise<ParsedDocument> {
    const workerPath = resolveExcelWorkerPath()
    if (!workerPath) {
      if (!excelWorkerWarned) {
        excelWorkerWarned = true
        console.warn('[DocumentParser] excel-parse-worker.cjs 未找到，Excel 解析退回主线程同步执行（仅 dev/test 预期）')
      }
      return Promise.resolve(parseExcelCore(filePath, fileName))
    }
    return new Promise<ParsedDocument>((resolve, reject) => {
      const worker = new Worker(workerPath, { workerData: { filePath, fileName } })
      let settled = false
      // 超时：worker.terminate() 强杀卡死的同步解析（主进程内联做不到）。回调内联以避免前向引用。
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        void worker.terminate()
        reject(new Error(`解析超时（>${PARSE_TIMEOUT_MS / 1000}秒），文件可能过大: ${fileName}`))
      }, PARSE_TIMEOUT_MS)
      const finish = (action: () => void): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        void worker.terminate()
        action()
      }
      worker.once('message', (msg: { ok: boolean; result?: ParsedDocument; error?: string }) => {
        finish(() => {
          if (msg && msg.ok && msg.result) resolve(msg.result)
          else reject(new Error((msg && msg.error) || 'excel worker 返回无效结果'))
        })
      })
      worker.once('error', (err) => {
        finish(() => reject(err instanceof Error ? err : new Error(String(err))))
      })
      worker.once('exit', (code) => {
        if (code !== 0) finish(() => reject(new Error(`excel worker 异常退出（code ${code}）`)))
      })
    })
  }

}
