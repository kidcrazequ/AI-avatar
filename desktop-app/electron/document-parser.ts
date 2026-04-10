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
  fileType: 'pdf' | 'word' | 'image' | 'text'
  /** 每页的字符数，用于定位 Vision 数据在原文中的位置（PDF 专属） */
  perPageChars?: Array<{ num: number; chars: number }>
  /** 图表页截图对应的页码列表（与 images 数组一一对应） */
  imagePageNumbers?: number[]
}

/**
 * 图表页文字阈值：一页文字（去空白后）少于此字符数，认为该页以图表为主，需要 OCR。
 * 300 字符是经验值：PDF 每页约有 60 字页眉，300 以下的页基本是图表/图纸页。
 */
const IMAGE_PAGE_TEXT_THRESHOLD = 300

/** 图表页截图数量上限，防止大 PDF 全量渲染耗尽内存 */
const MAX_SCREENSHOT_PAGES = 20

/** 单次导入文件大小上限（约 80MB），防止超大文件拖垮主进程内存 */
const MAX_PARSE_FILE_BYTES = 80 * 1024 * 1024

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
      case '.jpg':
      case '.jpeg':
      case '.png':
      case '.gif':
      case '.webp':
      case '.bmp':
        return this.parseImage(filePath, fileName)
      case '.txt':
      case '.md':
      case '.csv':
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
}
