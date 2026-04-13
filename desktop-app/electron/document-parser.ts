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
  fileType: 'pdf' | 'word' | 'image' | 'text' | 'excel'
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

/** 图表页截图数量上限，防止大 PDF 全量渲染耗尽内存 */
const MAX_SCREENSHOT_PAGES = 20

/** 单次导入文件大小上限（约 80MB），防止超大文件拖垮主进程内存 */
export const MAX_PARSE_FILE_BYTES = 80 * 1024 * 1024

/** Excel sheet 单表最大行数（防止失控 markdown 输出） */
const EXCEL_MAX_ROWS_PER_SHEET = 5000

/**
 * 本解析器当前支持的文件扩展名（含 . 前缀，小写）。
 * folder-importer 据此过滤要导入的文件。
 */
export const SUPPORTED_PARSE_EXTENSIONS: readonly string[] = [
  '.pdf',
  '.docx',
  '.xlsx',
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
  /** 解析文件，返回文本内容和图片列表 */
  async parseFile(filePath: string): Promise<ParsedDocument> {
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
        throw new Error('不支持旧版 .doc 格式，请使用 Word 将文件另存为 .docx 后重试')
      case '.xlsx':
      case '.csv':
        // .csv 走 xlsx 路径，获得 sheet-like 表格识别
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
      console.warn(`[DocumentParser] 图表页 ${imageDensePages.length} 页超过上限 ${MAX_SCREENSHOT_PAGES}，截取前 ${MAX_SCREENSHOT_PAGES} 页`)
      imageDensePages.length = MAX_SCREENSHOT_PAGES
    }
    if (imageDensePages.length > 0) {
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
   * 表头检测与 rowsToMarkdownTable 一致：首行全字符串 → header；否则合成 col1..N。
   */
  private buildSheetData(name: string, rows: unknown[][]): ExcelSheetData {
    if (rows.length === 0) {
      return { name, rowCount: 0, columns: [], rows: [] }
    }
    const maxCols = rows.reduce((acc, row) => Math.max(acc, row.length), 0)
    if (maxCols === 0) {
      return { name, rowCount: 0, columns: [], rows: [] }
    }

    const firstRow = rows[0]
    const firstRowIsHeader =
      firstRow.length === maxCols &&
      firstRow.every(cell => typeof cell === 'string' && cell.toString().trim().length > 0)

    let headers: string[]
    let bodyRows: unknown[][]
    if (firstRowIsHeader) {
      headers = firstRow.map(c => String(c).trim())
      bodyRows = rows.slice(1)
    } else {
      headers = Array.from({ length: maxCols }, (_, i) => `col${i + 1}`)
      bodyRows = rows
    }
    while (headers.length < maxCols) headers.push(`col${headers.length + 1}`)

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
