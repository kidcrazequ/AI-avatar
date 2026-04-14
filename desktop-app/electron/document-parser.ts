import fs from 'fs'
import path from 'path'

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

/** Excel sheet 结构 */
export interface ExcelSheetData {
  name: string
  rowCount: number
  columns: ExcelColumnSchema[]
  /** 全量行（对象数组，key = 列名） */
  rows: Array<Record<string, string | number | null>>
}

/** Excel 导入后产出的结构化数据（写入 knowledge/_excel/<basename>.json） */
export interface ExcelStructuredData {
  fileName: string
  /** 导入时间戳 ISO8601 */
  importedAt: string
  sheets: ExcelSheetData[]
}

/**
 * 图表页文字阈值：一页文字（去空白后）少于此字符数，认为该页以图表为主，需要 OCR。
 * 300 字符是经验值：PDF 每页约有 60 字页眉，300 以下的页基本是图表/图纸页。
 */
const IMAGE_PAGE_TEXT_THRESHOLD = 300

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
    return Promise.race([
      this._parseFileImpl(filePath),
      new Promise<never>((_, reject) =>
        setTimeout(() => {
          this._aborted = true
          reject(new Error(`解析超时（>${PARSE_TIMEOUT_MS / 1000}秒），文件可能过大: ${path.basename(filePath)}`))
        }, PARSE_TIMEOUT_MS)
      ),
    ])
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
    if (Array.isArray(textResult.pages)) {
      textResult.pages.forEach((page: { num: number; text: string }) => {
        const chars = (page.text || '').replace(/\s+/g, '').length
        perPageChars.push({ num: page.num, chars })
        if (chars < IMAGE_PAGE_TEXT_THRESHOLD) {
          imageDensePages.push(page.num)
        }
      })
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
    if (imageDensePages.length > 0 && !this._aborted) {
      try {
        const imageDenseSet = new Set(imageDensePages)
        const screenshotResult = await parser.getScreenshot({ scale: 2 })
        for (const screenshot of screenshotResult.pages) {
          if (imageDenseSet.has(screenshot.pageNumber) && screenshot.dataUrl) {
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
  }

  private async parseWord(filePath: string, fileName: string): Promise<ParsedDocument> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mammoth = require('mammoth')
    const result = await mammoth.extractRawText({ path: filePath })
    return {
      text: result.value || '',
      images: [],
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
   * 把 sheet 的二维数组行转成 ExcelSheetData（对象数组 + 列 schema）。
   *
   * 智能表头检测（处理 Excel 合并单元格 / 多行表头）：
   *   1. 扫描前 5 行，对每一行打分：非空字符串单元格越多分越高，纯数字/None 行扣分
   *   2. 选最高分的行作为表头；若并列，取靠上的
   *   3. 表头行之前的所有行都跳过（合并标题、空行等）
   *   4. 单元格中的 \n（多行 merged 表头）替换为空格
   *   5. 完全没有合适行就 fallback 到 col1..colN
   */
  private buildSheetData(name: string, rows: unknown[][]): ExcelSheetData {
    if (rows.length === 0) {
      return { name, rowCount: 0, columns: [], rows: [] }
    }
    const maxCols = rows.reduce((acc, row) => Math.max(acc, row.length), 0)
    if (maxCols === 0) {
      return { name, rowCount: 0, columns: [], rows: [] }
    }

    // 扫前 5 行找最适合作为表头的行
    const SCAN_DEPTH = Math.min(5, rows.length)
    let bestHeaderIdx = -1
    let bestScore = -1
    for (let i = 0; i < SCAN_DEPTH; i++) {
      const row = rows[i]
      let stringCells = 0
      let numericCells = 0
      let emptyCells = 0
      for (let j = 0; j < maxCols; j++) {
        const cell = row[j]
        if (cell === null || cell === undefined || (typeof cell === 'string' && cell.trim() === '')) {
          emptyCells++
        } else if (typeof cell === 'number') {
          numericCells++
        } else if (typeof cell === 'string') {
          stringCells++
        }
      }
      // 评分：字符串单元格 +2，数字 -1，空格 -0.3
      // 表头要求至少 50% 的列非空且大部分是字符串
      const score = stringCells * 2 - numericCells - emptyCells * 0.3
      const fillRate = (stringCells + numericCells) / maxCols
      if (fillRate >= 0.5 && stringCells > numericCells && score > bestScore) {
        bestScore = score
        bestHeaderIdx = i
      }
    }

    let headers: string[]
    let bodyRows: unknown[][]
    if (bestHeaderIdx >= 0) {
      const headerRow = rows[bestHeaderIdx]
      headers = Array.from({ length: maxCols }, (_, j) => {
        const cell = headerRow[j]
        if (cell === null || cell === undefined) return `col${j + 1}`
        const s = String(cell).trim().replace(/\r?\n/g, ' ').replace(/\s+/g, ' ')
        return s || `col${j + 1}`
      })
      // 跳过表头行及之前的所有行（合并标题等）
      bodyRows = rows.slice(bestHeaderIdx + 1)
    } else {
      // 完全没找到合适的表头行 → fallback
      headers = Array.from({ length: maxCols }, (_, i) => `col${i + 1}`)
      bodyRows = rows
    }
    while (headers.length < maxCols) headers.push(`col${headers.length + 1}`)
    // 去重：同名列加 _2, _3 后缀
    const seen = new Map<string, number>()
    headers = headers.map(h => {
      const count = seen.get(h) || 0
      seen.set(h, count + 1)
      return count === 0 ? h : `${h}_${count + 1}`
    })

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

    return {
      name,
      rowCount: objRows.length,
      columns,
      rows: objRows,
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
   * 将二维数组转为 GFM markdown 表格。第一行若全为字符串则视为表头，
   * 否则合成 col1..colN 表头。单元格中的 `|`、换行符需转义。
   */
  private rowsToMarkdownTable(rows: unknown[][]): string {
    if (rows.length === 0) return '_（空）_'

    const escapeCell = (v: unknown): string => {
      if (v === null || v === undefined) return ''
      const s = String(v)
      return s
        .replace(/\\/g, '\\\\')
        .replace(/\|/g, '\\|')
        .replace(/\r?\n/g, '<br>')
        .trim()
    }

    // 确定列数：取所有行中最大的列数
    const maxCols = rows.reduce((acc, row) => Math.max(acc, row.length), 0)
    if (maxCols === 0) return '_（无列）_'

    // 判断首行是否为表头（所有单元格都是非空字符串）
    const firstRow = rows[0]
    const firstRowIsHeader =
      firstRow.length === maxCols &&
      firstRow.every(cell => typeof cell === 'string' && cell.toString().trim().length > 0)

    let header: string[]
    let bodyRows: unknown[][]
    if (firstRowIsHeader) {
      header = firstRow.map(c => escapeCell(c))
      bodyRows = rows.slice(1)
    } else {
      header = Array.from({ length: maxCols }, (_, i) => `col${i + 1}`)
      bodyRows = rows
    }

    // 补齐 header 到 maxCols
    while (header.length < maxCols) header.push(`col${header.length + 1}`)

    const headerLine = '| ' + header.join(' | ') + ' |'
    const separatorLine = '| ' + header.map(() => '---').join(' | ') + ' |'
    const bodyLines = bodyRows.map(row => {
      const padded = [...row]
      while (padded.length < maxCols) padded.push('')
      return '| ' + padded.map(c => escapeCell(c)).join(' | ') + ' |'
    })

    return [headerLine, separatorLine, ...bodyLines].join('\n')
  }
}
