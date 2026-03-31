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
}

/**
 * DocumentParser: 负责解析 PDF / Word / 图片 / 文本文件，提取文字和图片（GAP9a）。
 * - PDF → pdf-parse 提取文字，同时将页面图片返回给渲染进程用 OCR 处理
 * - Word (.docx) → mammoth 提取 HTML/文本
 * - 图片 → 编码为 base64 data URL，交由渲染进程调用 Qwen VL OCR
 * - 纯文本 → 直接读取
 */
export class DocumentParser {
  /** 解析文件，返回文本内容和图片列表 */
  async parseFile(filePath: string): Promise<ParsedDocument> {
    const ext = path.extname(filePath).toLowerCase()
    const fileName = path.basename(filePath)

    switch (ext) {
      case '.pdf':
        return this.parsePdf(filePath, fileName)
      case '.docx':
      case '.doc':
        return this.parseWord(filePath, fileName)
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
    const pdfParse = require('pdf-parse')
    const buffer = fs.readFileSync(filePath)
    const data = await pdfParse(buffer)
    return {
      text: data.text || '',
      images: [],  // pdf-parse 不提取图片；图片页面通过视觉模型处理
      fileName,
      fileType: 'pdf',
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

  private parseImage(filePath: string, fileName: string): ParsedDocument {
    const ext = path.extname(filePath).toLowerCase().slice(1)
    const mimeType = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
      : ext === 'png' ? 'image/png'
      : ext === 'gif' ? 'image/gif'
      : ext === 'webp' ? 'image/webp'
      : 'image/png'
    const buffer = fs.readFileSync(filePath)
    const base64 = buffer.toString('base64')
    const dataUrl = `data:${mimeType};base64,${base64}`
    return {
      text: '',
      images: [dataUrl],
      fileName,
      fileType: 'image',
    }
  }

  private parseText(filePath: string, fileName: string): ParsedDocument {
    const text = fs.readFileSync(filePath, 'utf-8')
    return {
      text,
      images: [],
      fileName,
      fileType: 'text',
    }
  }
}
