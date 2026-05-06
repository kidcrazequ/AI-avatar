import fs from 'fs'
import path from 'path'
import { JSDOM } from 'jsdom'

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

/** Excel 列 schema */
export interface ExcelColumnSchema {
  name: string
  /** 列的数据类型：纯数字 / 日期样 / 其他（字符串） */
  dtype: 'number' | 'date-like' | 'string'
  /** 该列唯一值数量 */
  uniqueCount: number
  /** 首 N 个唯一样本值（供 LLM 理解列含义） */
  samples: Array<string | number>
  /** 数值/日期列的最小值（字符串以便 JSON 序列化日期） */
  min?: string | number
  /** 数值/日期列的最大值 */
  max?: string | number
}

/**
 * 行元数据角色（与业务无关的纯数据角色识别）：
 *   - 'data'     : 真实数据行（默认）
 *   - 'subtitle' : 子表/小节标题行（col1 有值但同行其他列大多为 null，典型为合并单元格小标题）
 *   - 'subtotal' : 小计行（label 含"小计/Subtotal"）
 *   - 'total'    : 总计行（label 含"总计/合计/总和/Total"）
 *
 * 用途：query_excel 类工具/出题器可借此区分"可被精确按行 filter 的数据行"与"表格元数据行"。
 * 不会序列化到 row 对象内（避免污染 LLM 看到的 cell 数据），而是与 rows 一一对应放在并行数组里。
 */
export type ExcelRowMetaRole = 'data' | 'subtitle' | 'subtotal' | 'total'

/** Excel sheet 结构 */
export interface ExcelSheetData {
  name: string
  rowCount: number
  columns: ExcelColumnSchema[]
  /** 全量行（对象数组，key = 列名） */
  rows: Array<Record<string, string | number | null>>
  /**
   * 与 rows 一一对应的行角色数组（i 位置对应 rows[i] 的角色）。
   * 旧版本 _excel JSON 可能缺失此字段，使用方应做好 optional 处理。
   */
  rowMetaRoles?: ExcelRowMetaRole[]
}

/**
 * 推断单行的元数据角色（不依赖业务字典，只看数据形状）。
 * 输入要求：row 是已经过 buildSheetData 转好的对象行；columns 是该 sheet 的 schema。
 * 注意：此函数对单行独立判定，不做"汇总值=明细行加和"这类需要全表上下文的高阶判定。
 */
export function inferRowMetaRole(
  row: Record<string, string | number | null>,
  columns: ExcelColumnSchema[],
): ExcelRowMetaRole {
  if (columns.length === 0) return 'data'
  const labelColName = columns[0].name
  const labelRaw = row[labelColName]
  const labelStr = labelRaw === null || labelRaw === undefined ? '' : String(labelRaw).trim()

  // 注意：中文字符不构成 \b 词边界，必须分中/英文两套正则
  if (/^(总计|合计|总和|累计)/.test(labelStr)) return 'total'
  if (/^(Total|Grand[\s-]?Total)$/i.test(labelStr)) return 'total'
  if (/^小计/.test(labelStr)) return 'subtotal'
  if (/^Sub[\s-]?total$/i.test(labelStr)) return 'subtotal'

  // subtitle 启发：col1 有值，但其他列绝大多数（≥80%）为 null
  // 典型场景：Excel 合并单元格 / 多张子表合并到一个 sheet 时的小节标题行
  const otherCols = columns.slice(1)
  if (labelStr !== '' && otherCols.length > 0) {
    let nullCount = 0
    for (const c of otherCols) {
      const v = row[c.name]
      if (v === null || v === undefined || v === '') nullCount++
    }
    if (nullCount / otherCols.length >= 0.8) return 'subtitle'
  }

  return 'data'
}

/** Excel 导入后产出的结构化数据（写入 knowledge/_excel/<basename>.json） */
export interface ExcelStructuredData {
  fileName: string
  /** 导入时间戳 ISO8601 */
  importedAt: string
  sheets: ExcelSheetData[]
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
  const commonChars = stripped.replace(/[A-Za-z0-9\u4E00-\u9FFF\u3000-\u303F\uFF00-\uFFEF.,;:!?'"()\[\]{}<>@#$%^&*+=\-_/\\|~`，。；：！？、""''（）【】《》—…·\u00A0\u2000-\u206F]/g, '')
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

/** Excel sheet 单表最大行数（防止失控 markdown 输出） */
const EXCEL_MAX_ROWS_PER_SHEET = 5000

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

/**
 * DocumentParser: 负责解析 PDF / Word / 图片 / 文本文件，提取文字和图片。
 * - PDF → pdf-parse v2 提取文字；文字少的页面同时渲染为截图供 OCR 识别图表内容
 * - Word (.docx) → mammoth 提取文本
 * - 图片 → 编码为 base64 data URL，交由渲染进程调用 Qwen VL OCR
 * - 纯文本 → 直接读取
 */
export class DocumentParser {
  /** 超时标志：parseFile 超时后置 true，_parseFileImpl 中的耗时操作检查此标志提前退出 */
  private _aborted = false

  /** 解析文件，返回文本内容和图片列表。带超时保护。 */
  async parseFile(filePath: string): Promise<ParsedDocument> {
    this._aborted = false
    let timer: NodeJS.Timeout | null = null
    try {
      return await Promise.race([
        this._parseFileImpl(filePath),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            this._aborted = true
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

  private async _parseFileImpl(filePath: string): Promise<ParsedDocument> {
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
        return this.parsePdf(filePath, fileName)
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

  private async parsePdf(filePath: string, fileName: string): Promise<ParsedDocument> {
    // pdfjs-dist 的 fake worker 模式通过 import("./pdf.worker.mjs") 加载 worker。
    // 在 Windows 打包后 asar 内 import() 加载 .mjs 有兼容性问题。
    // 预加载 CJS 版本的 worker 并挂到 globalThis，pdfjs-dist 检测到后直接使用。
    if (!(globalThis as Record<string, unknown>).pdfjsWorker) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        ;(globalThis as Record<string, unknown>).pdfjsWorker = require(
          require('path').join(__dirname, 'pdf-worker.cjs')
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

    // 1. 提取全文
    const textResult = await parser.getText({ parsePageInfo: true })
    const fullText: string = textResult.text || ''

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

    // 分页信息缺失的 fallback：若全文本身稀疏/乱码，就把所有页当图表页走 OCR，
    // 避免 pdfjs 拿不到 perPage 时整份文档零截图（曾出现于某些 CNAS 测试报告）。
    // 页号列表从 getScreenshot 拿，这样即使分页 API 失败也能兜底。
    let needsFullDocFallback = false
    if (imageDensePages.length === 0 && shouldOcrPage(fullText)) {
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
    if ((imageDensePages.length > 0 || needsFullDocFallback) && !this._aborted) {
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

    // 释放 pdfjs 底层 document，避免批量导入 300+ 文件时 worker 累积状态导致
    // 后续文件随机出现"0 截图"的 flake。单文件场景 destroy 无副作用。
    try { await parser.destroy() } catch { /* ignore */ }

    return {
      text: fullText,
      images,
      fileName,
      fileType: 'pdf',
      perPageChars,
      imagePageNumbers,
    }
  }

  private async parseWord(filePath: string, fileName: string): Promise<ParsedDocument> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mammoth = require('mammoth')
    const result = await mammoth.extractRawText({ path: filePath })
    let text: string = result.value || ''

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
   * 解析 Excel/CSV 文件为 Markdown + 结构化数据。每个 sheet 变成一个
   * `## {sheetName}` section，下面跟一个 GFM 表格；同时提取列 schema
   * 和全量行对象数组，写入 structuredData 字段供 query_excel 工具使用。
   *
   * 无需额外依赖：xlsx（SheetJS 社区版）为纯 JS，同时支持 .xlsx 和 .csv。
   */
  private async parseExcel(filePath: string, fileName: string): Promise<ParsedDocument> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const XLSX = require('xlsx')
    const workbook = XLSX.readFile(filePath, { cellDates: true, cellNF: false })
    const sheetNames: string[] = workbook.SheetNames || []
    if (sheetNames.length === 0) {
      throw new Error(`Excel/CSV 文件不含任何 sheet: ${fileName}`)
    }

    const sections: string[] = []
    const sheetDataList: ExcelSheetData[] = []
    let totalRows = 0
    let truncated = false

    for (const name of sheetNames) {
      const sheet = workbook.Sheets[name]
      if (!sheet) continue
      const rows: unknown[][] = XLSX.utils.sheet_to_json(sheet, {
        header: 1,
        defval: '',
        blankrows: false,
        raw: false,
      })
      if (rows.length === 0) {
        sections.push(`## ${name}\n\n_（空 sheet）_\n`)
        sheetDataList.push({ name, rowCount: 0, columns: [], rows: [] })
        continue
      }

      const originalRowCount = rows.length
      let workingRows = rows
      if (rows.length > EXCEL_MAX_ROWS_PER_SHEET) {
        workingRows = rows.slice(0, EXCEL_MAX_ROWS_PER_SHEET)
        truncated = true
      }
      totalRows += workingRows.length

      // Markdown 表格（可视化用）
      const markdownTable = this.rowsToMarkdownTable(workingRows)
      const suffix = originalRowCount > workingRows.length
        ? `\n\n> ⚠️ 已截断至 ${workingRows.length} 行（原 ${originalRowCount} 行）\n`
        : ''
      sections.push(`## ${name}\n\n${markdownTable}${suffix}`)

      // 结构化数据（query_excel 工具用）
      sheetDataList.push(this.buildSheetData(name, workingRows))
    }

    const header =
      `> 导入自 Excel: ${fileName} | ${sheetNames.length} sheet${sheetNames.length > 1 ? 's' : ''} | ${totalRows} row${totalRows !== 1 ? 's' : ''}` +
      (truncated ? ' | 部分 sheet 已截断' : '') +
      '\n\n---\n'

    return {
      text: header + '\n' + sections.join('\n\n'),
      images: [],
      fileName,
      fileType: 'excel',
      sheetNames,
      structuredData: {
        fileName,
        importedAt: new Date().toISOString(),
        sheets: sheetDataList,
      },
    }
  }

  /**
   * 智能表头检测 + 列名去重，返回统一的中间结构供 buildSheetData 和 rowsToMarkdownTable 共用。
   *
   * 算法：
   *   1. 扫描前 10 行，对每一行打分：非空字符串单元格越多分越高，纯数字/None 行扣分
   *   2. "封面行跳过"启发式：前 3 行内若首 cell 有值但其余 ≥80% 为空 → 视为封面/标题行，不参与打分
   *   3. 选最高分的行作为表头；若并列，取靠上的
   *   4. "两行表头合并"：若最佳行仍有 ≥30% 空 cell，检查其下一行能否补全 → 合并两行
   *   5. 表头行之前的所有行都跳过（合并标题、空行等）
   *   6. 单元格中的 \n（多行 merged 表头）替换为空格
   *   7. 完全没有合适行就 fallback 到 col1..colN（表单型 Excel）
   *   8. 同名列自动加 _2, _3 后缀避免 key 冲突
   */
  private prepareTable(rows: unknown[][]): {
    headers: string[]
    headerRowIndex: number
    bodyRows: unknown[][]
    maxCols: number
  } {
    const maxCols = rows.reduce((acc, row) => Math.max(acc, row.length), 0)
    if (maxCols === 0) {
      return { headers: [], headerRowIndex: -1, bodyRows: rows, maxCols: 0 }
    }

    // 扫描深度从 5 → 10，覆盖封面行在前几行的 Excel 文件
    const SCAN_DEPTH = Math.min(10, rows.length)

    // 标记封面/标题行：前 3 行内，首 cell 有值但其余 ≥80% 为空
    const coverRowSet = new Set<number>()
    const COVER_CHECK_DEPTH = Math.min(3, rows.length)
    for (let i = 0; i < COVER_CHECK_DEPTH; i++) {
      const row = rows[i]
      if (maxCols <= 1) break
      const first = row[0]
      const hasFirst = first !== null && first !== undefined
        && !(typeof first === 'string' && first.trim() === '')
      if (!hasFirst) continue
      let emptyRest = 0
      for (let j = 1; j < maxCols; j++) {
        const cell = j < row.length ? row[j] : undefined
        if (cell === null || cell === undefined || (typeof cell === 'string' && cell.trim() === '')) {
          emptyRest++
        }
      }
      if (emptyRest / (maxCols - 1) >= 0.8) {
        coverRowSet.add(i)
      }
    }

    let bestHeaderIdx = -1
    let bestScore = -1
    for (let i = 0; i < SCAN_DEPTH; i++) {
      // 跳过封面/标题行
      if (coverRowSet.has(i)) continue

      const row = rows[i]
      let stringCells = 0
      let numericCells = 0
      let emptyCells = 0
      for (let j = 0; j < maxCols; j++) {
        const cell = j < row.length ? row[j] : undefined
        if (cell === null || cell === undefined || (typeof cell === 'string' && cell.trim() === '')) {
          emptyCells++
        } else if (typeof cell === 'number') {
          numericCells++
        } else if (typeof cell === 'string') {
          stringCells++
        }
      }
      const score = stringCells * 2 - numericCells - emptyCells * 0.3
      const fillRate = (stringCells + numericCells) / maxCols
      if (fillRate >= 0.5 && stringCells > numericCells && score > bestScore) {
        bestScore = score
        bestHeaderIdx = i
      }
    }

    let headers: string[]
    let bodyRows: unknown[][]
    /** 两行表头合并时，body 从合并的下一行开始 */
    let mergedSecondRow = false
    if (bestHeaderIdx >= 0) {
      const headerRow = rows[bestHeaderIdx]
      headers = Array.from({ length: maxCols }, (_, j) => {
        const cell = j < headerRow.length ? headerRow[j] : undefined
        if (cell === null || cell === undefined) return ''
        const s = String(cell).trim().replace(/\r?\n/g, ' ').replace(/\s+/g, ' ')
        return s
      })

      // 两行表头合并：若最佳行仍有 ≥30% 空 cell，检查下一行能否补全
      const emptyCellCount = headers.filter(h => h === '').length
      const nextIdx = bestHeaderIdx + 1
      if (emptyCellCount / maxCols >= 0.3 && nextIdx < rows.length) {
        const nextRow = rows[nextIdx]
        let canMerge = false
        let fillCount = 0
        for (let j = 0; j < maxCols; j++) {
          if (headers[j] !== '') continue
          const nextCell = j < nextRow.length ? nextRow[j] : undefined
          if (nextCell !== null && nextCell !== undefined
            && typeof nextCell === 'string' && nextCell.trim() !== '') {
            fillCount++
          }
        }
        // 下一行至少能补全一半的空 cell 才合并
        if (emptyCellCount > 0 && fillCount >= emptyCellCount * 0.5) {
          canMerge = true
        }
        if (canMerge) {
          for (let j = 0; j < maxCols; j++) {
            if (headers[j] !== '') continue
            const nextCell = j < nextRow.length ? nextRow[j] : undefined
            if (nextCell !== null && nextCell !== undefined) {
              const s = String(nextCell).trim().replace(/\r?\n/g, ' ').replace(/\s+/g, ' ')
              if (s) headers[j] = s
            }
          }
          mergedSecondRow = true
        }
      }

      // 仍为空的列位 fallback 到 colN
      headers = headers.map((h, j) => h || `col${j + 1}`)
      bodyRows = rows.slice(mergedSecondRow ? bestHeaderIdx + 2 : bestHeaderIdx + 1)
    } else {
      // 表单型 Excel（类型 B）：无合适表头行，fallback 到 col1..colN
      headers = Array.from({ length: maxCols }, (_, i) => `col${i + 1}`)
      bodyRows = rows
    }
    while (headers.length < maxCols) headers.push(`col${headers.length + 1}`)

    const seen = new Map<string, number>()
    headers = headers.map(h => {
      const count = seen.get(h) || 0
      seen.set(h, count + 1)
      return count === 0 ? h : `${h}_${count + 1}`
    })

    return { headers, headerRowIndex: bestHeaderIdx, bodyRows, maxCols }
  }

  /**
   * 把 sheet 的二维数组行转成 ExcelSheetData（对象数组 + 列 schema）。
   * 表头检测委托给 prepareTable()，保证与 markdown 输出用同一套逻辑。
   */
  private buildSheetData(name: string, rows: unknown[][]): ExcelSheetData {
    if (rows.length === 0) {
      return { name, rowCount: 0, columns: [], rows: [] }
    }
    const { headers, bodyRows, maxCols } = this.prepareTable(rows)
    if (maxCols === 0) {
      return { name, rowCount: 0, columns: [], rows: [] }
    }

    // 转对象数组
    const objRows: Array<Record<string, string | number | null>> = bodyRows.map(row => {
      const obj: Record<string, string | number | null> = {}
      for (let i = 0; i < maxCols; i++) {
        const raw = row[i]
        obj[headers[i]] = this.normalizeCell(raw)
      }
      return obj
    })

    // 推断列 schema
    const columns: ExcelColumnSchema[] = headers.map(h => this.inferColumnSchema(h, objRows))

    // ★ 推断每行的元数据角色（data / subtitle / subtotal / total）
    // 用于 generator / query_excel 等工具区分"可精确 filter 的数据行"与"表格元数据行"。
    const rowMetaRoles: ExcelRowMetaRole[] = objRows.map(r => inferRowMetaRole(r, columns))

    return {
      name,
      rowCount: objRows.length,
      columns,
      rows: objRows,
      rowMetaRoles,
    }
  }

  /** 规范化单元格值：null/undefined → null；Date → ISO；尝试 parseFloat */
  private normalizeCell(v: unknown): string | number | null {
    if (v === null || v === undefined) return null
    if (v instanceof Date) {
      // YYYY-MM-DD（日期型列更便于范围比较）
      const y = v.getFullYear()
      const m = String(v.getMonth() + 1).padStart(2, '0')
      const d = String(v.getDate()).padStart(2, '0')
      return `${y}-${m}-${d}`
    }
    if (typeof v === 'number') return Number.isFinite(v) ? v : null
    if (typeof v === 'boolean') return v ? 1 : 0
    const s = String(v).trim()
    if (s === '') return null
    // 尝试解析数字（保留整数/小数）
    if (/^-?\d+(\.\d+)?$/.test(s)) {
      const n = parseFloat(s)
      if (Number.isFinite(n)) return n
    }
    return s
  }

  /** 推断单列的 schema：dtype、唯一值、samples、min/max */
  private inferColumnSchema(
    name: string,
    rows: Array<Record<string, string | number | null>>,
  ): ExcelColumnSchema {
    const values: Array<string | number> = []
    const seen = new Set<string>()
    for (const row of rows) {
      const v = row[name]
      if (v === null || v === undefined) continue
      values.push(v)
      seen.add(String(v))
    }

    // 判断 dtype
    let numericCount = 0
    let dateLikeCount = 0
    for (const v of values) {
      if (typeof v === 'number') numericCount++
      else if (typeof v === 'string' && /^\d{4}[-/]\d{1,2}([-/]\d{1,2})?$/.test(v)) dateLikeCount++
    }
    const total = values.length || 1
    let dtype: ExcelColumnSchema['dtype'] = 'string'
    if (numericCount / total >= 0.9) dtype = 'number'
    else if (dateLikeCount / total >= 0.9) dtype = 'date-like'

    // samples：最多 8 个唯一值
    const samples = Array.from(seen).slice(0, 8).map(s => {
      if (dtype === 'number') {
        const n = parseFloat(s)
        return Number.isFinite(n) ? n : s
      }
      return s
    })

    // min/max（仅对 number / date-like）
    let min: string | number | undefined
    let max: string | number | undefined
    if (dtype === 'number') {
      const nums = values.filter((v): v is number => typeof v === 'number')
      if (nums.length > 0) {
        min = Math.min(...nums)
        max = Math.max(...nums)
      }
    } else if (dtype === 'date-like') {
      const strs = values.filter((v): v is string => typeof v === 'string').sort()
      if (strs.length > 0) {
        min = strs[0]
        max = strs[strs.length - 1]
      }
    }

    return {
      name,
      dtype,
      uniqueCount: seen.size,
      samples,
      ...(min !== undefined ? { min } : {}),
      ...(max !== undefined ? { max } : {}),
    }
  }

  /**
   * 检测某行是否为"分节标题 / 合计行"，用于 ffill 的重置边界。
   * 简化版 inferRowMetaRole，直接作用于原始 unknown[] 行（无需列 schema）。
   */
  private isMergeResetBoundary(row: unknown[], maxCols: number): boolean {
    if (maxCols <= 1) return false
    const first = row[0]
    if (first === null || first === undefined || (typeof first === 'string' && first.trim() === '')) {
      return false
    }
    const firstStr = String(first).trim()
    if (/^(总计|合计|总和|累计|小计)/.test(firstStr) || /^(Total|Grand[\s-]?Total|Sub[\s-]?total)$/i.test(firstStr)) {
      return true
    }
    let emptyCount = 0
    for (let j = 1; j < maxCols; j++) {
      const cell = j < row.length ? row[j] : undefined
      if (cell === null || cell === undefined || (typeof cell === 'string' && cell.trim() === '')) {
        emptyCount++
      }
    }
    return emptyCount / (maxCols - 1) >= 0.8
  }

  /**
   * 对前 N 列做前向填充（forward fill），恢复 Excel 合并单元格的语义。
   *
   * 算法：
   *   1. 扫描前 MAX_FFILL_COLS（3）列，找出"合并候选列"
   *   2. 候选判定：列的空单元格占比 ≥ 10%（说明存在合并）且至少 2 个非空值
   *   3. 遇到"全填充列"（空率 < 10%）则中断序列——该列及其后的列不再 ffill
   *   4. 逐行前向填充：空 cell 复制上方最近非空值
   *   5. 分节标题 / 合计行作为重置边界，避免跨分组填充
   *
   * 只用于 markdown 输出，不影响 _excel/*.json 结构化数据。
   */
  private ffillLeadingColumns(bodyRows: unknown[][], maxCols: number): unknown[][] {
    if (bodyRows.length <= 1 || maxCols === 0) return bodyRows

    const MAX_FFILL_COLS = Math.min(3, maxCols)
    const ffillCols: number[] = []

    for (let col = 0; col < MAX_FFILL_COLS; col++) {
      let emptyCount = 0
      let nonEmptyCount = 0
      for (const row of bodyRows) {
        const cell = col < row.length ? row[col] : undefined
        if (cell === null || cell === undefined || (typeof cell === 'string' && cell.trim() === '')) {
          emptyCount++
        } else {
          nonEmptyCount++
        }
      }
      const emptyRate = emptyCount / bodyRows.length

      if (emptyRate < 0.1) break

      if (nonEmptyCount >= 2) {
        ffillCols.push(col)
      }
    }

    if (ffillCols.length === 0) return bodyRows

    const result = bodyRows.map(row => [...row])
    const lastValues: unknown[] = new Array(ffillCols.length).fill(null)

    for (let i = 0; i < result.length; i++) {
      const row = result[i]

      if (this.isMergeResetBoundary(row, maxCols)) {
        lastValues.fill(null)
        continue
      }

      for (let ci = 0; ci < ffillCols.length; ci++) {
        const col = ffillCols[ci]
        const cell = col < row.length ? row[col] : undefined
        if (cell === null || cell === undefined || (typeof cell === 'string' && cell.trim() === '')) {
          if (lastValues[ci] !== null) {
            row[col] = lastValues[ci]
          }
        } else {
          lastValues[ci] = cell
        }
      }
    }

    return result
  }

  /**
   * 将二维数组转为 GFM markdown 表格。
   * 表头检测委托给 prepareTable()，与 buildSheetData 共用同一套智能检测算法。
   * 前向填充委托给 ffillLeadingColumns()，恢复合并单元格语义。
   */
  private rowsToMarkdownTable(rows: unknown[][]): string {
    if (rows.length === 0) return '_（空）_'

    const escapeCell = (v: unknown): string => {
      if (v === null || v === undefined) return ''
      const s = String(v)
      return s
        .replace(/\\/g, '\\\\')
        .replace(/\|/g, '\\|')
        .replace(/\r?\n/g, '；')
        .trim()
    }

    const { headers, bodyRows, maxCols } = this.prepareTable(rows)
    if (maxCols === 0) return '_（无列）_'

    const filledRows = this.ffillLeadingColumns(bodyRows, maxCols)

    const headerEscaped = headers.map(h => escapeCell(h))
    const headerLine = '| ' + headerEscaped.join(' | ') + ' |'
    const separatorLine = '| ' + headerEscaped.map(() => '---').join(' | ') + ' |'
    const bodyLines = filledRows.map(row => {
      const padded = [...row]
      while (padded.length < maxCols) padded.push('')
      return '| ' + padded.map(c => escapeCell(c)).join(' | ') + ' |'
    })

    return [headerLine, separatorLine, ...bodyLines].join('\n')
  }
}
