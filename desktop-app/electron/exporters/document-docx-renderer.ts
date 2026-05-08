/**
 * 文档生成：DocumentIR → DOCX 渲染器（Electron 主进程）
 *
 * 工作原理：
 *   1. 用 docx@9.x 的 Document/Paragraph/TextRun/Table API 把 IR 块映射为 OOXML 元素
 *   2. metadata 写入 coreProperties（title/creator/description/lastModifiedBy）
 *   3. Packer.toBuffer 一次性生成 .docx 二进制
 *   4. fs.writeFileSync 写盘并返回大小
 *
 * 字体策略：
 *   - 中文优先按平台选择：Windows=Microsoft YaHei，macOS=PingFang SC，Linux=Noto Sans CJK SC
 *   - 代码块统一使用等宽字体（Consolas/SF Mono fallback）
 *   - 不嵌入字体文件，依赖系统字体（避免文件膨胀 + 版权问题）
 *
 * 图片嵌入（v1 增强）：
 *   - 通过 options.imageRoot 解析 IR 中的相对图片路径
 *   - 仅支持 png/jpg/jpeg/gif/bmp（webp/svg 暂不支持）
 *   - 拒绝远程 URL（http/https）与绝对路径，禁路径穿越
 *   - 读取尺寸用 image-size@1.x，A4 - 边距 ≈ 600 px 宽度上限，等比缩放
 *   - 任一前置条件失败：降级为 `[图片占位]` 文本段，不打断渲染
 *
 * 注意：
 *   - 长表格不分页：docx 自身会按打印机能力自动分页，无需手动处理
 *
 * @author zhi.qu
 * @date 2026-05-08
 */

import fs from 'fs'
import path from 'path'
import sizeOf from 'image-size'
import {
  AlignmentType,
  BorderStyle,
  Document,
  HeadingLevel,
  ImageRun,
  ITableCellOptions,
  ITableRowOptions,
  LevelFormat,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx'
import type {
  CalloutLevel,
  DocumentBlock,
  DocumentIR,
  DocumentHeadingLevel,
  TableCellValue,
} from '@soul/core'
import { resolveUnderRoot } from '@soul/core'
import type { Logger } from '../logger'

/** docx ImageRun 支持的 type 字段（与 IImageOptions 严格对齐） */
type DocxImageType = 'png' | 'jpg' | 'gif' | 'bmp'

/** 图片块渲染上下文（cjk 字体 + imageRoot + logger 集中传递） */
interface ImageRenderCtx {
  cjkFont: string
  imageRoot?: string
  logger?: Pick<Logger, 'activity' | 'error'>
}

/**
 * 图片格式白名单：扩展名 → docx ImageRun 的 type 字段。
 *
 * docx@9.x 的 RegularImageOptions.type 仅接受 'jpg' / 'png' / 'gif' / 'bmp'，
 * 故 .jpeg 扩展名映射到 docx 的 'jpg'（同一种 JPEG 格式两种叫法）。
 */
const IMAGE_EXT_TO_DOCX_TYPE: Record<string, DocxImageType> = {
  '.png': 'png',
  '.jpg': 'jpg',
  '.jpeg': 'jpg',
  '.gif': 'gif',
  '.bmp': 'bmp',
}

/** A4 (210 mm) - 左右边距 ≈ 600 px@96dpi；docx ImageRun 用 px 作为变换单位 */
const IMAGE_MAX_WIDTH_PX = 600

export interface RenderDocumentDocxOptions {
  logger?: Pick<Logger, 'activity' | 'error'>
  /**
   * 图片相对路径解析根（通常为分身根目录）。
   *
   * IR 中 image.src 为相对路径时，将以此根做 resolveUnderRoot 安全解析。
   * 未配置或解析失败 / 文件不存在时降级为 `[图片占位]` 文本段。
   *
   * 安全策略：
   *   - 绝对路径：拒绝（避免泄漏宿主任意路径）
   *   - 远程 URL（http/https）：拒绝（v1 不下载远程图）
   *   - 路径穿越（..）：被 resolveUnderRoot 拦截
   */
  imageRoot?: string
}

export interface RenderDocumentDocxResult {
  size: number
}

/**
 * 把 DocumentIR 渲染为 .docx 文件。
 *
 * @param ir         统一中间表示
 * @param outputPath 输出 .docx 绝对路径
 * @param options    可选：logger / imageRoot（图片相对路径解析根）
 */
export async function renderDocumentDocx(
  ir: DocumentIR,
  outputPath: string,
  options: RenderDocumentDocxOptions = {},
): Promise<RenderDocumentDocxResult> {
  const logger = options.logger
  const startedAt = Date.now()
  logger?.activity(
    'document-docx-render-start',
    `out=${outputPath} blocks=${ir.blocks.length} imageRoot=${options.imageRoot ?? '<none>'}`,
  )

  const cjkFont = pickCjkFont()
  const monoFont = pickMonoFont()
  const imageCtx: ImageRenderCtx = {
    cjkFont,
    imageRoot: options.imageRoot,
    logger,
  }

  const children: (Paragraph | Table)[] = []
  // 文档头部：标题 + 元数据
  children.push(buildTitleParagraph(ir.metadata.title || '未命名文档', cjkFont))
  const metaLine = buildMetaLine(ir.metadata)
  if (metaLine) children.push(metaLine)
  if (ir.blocks.length > 0) children.push(emptyParagraph())

  for (const block of ir.blocks) {
    children.push(...renderBlockToDocx(block, cjkFont, monoFont, imageCtx))
  }

  const doc = new Document({
    creator: typeof ir.metadata.author === 'string' ? ir.metadata.author : 'Soul AI 分身',
    title: ir.metadata.title,
    description: typeof ir.metadata.description === 'string' ? ir.metadata.description : undefined,
    styles: {
      default: {
        document: {
          run: { font: cjkFont, size: 24 },
        },
      },
    },
    numbering: {
      config: [{
        reference: 'soul-ordered',
        levels: [{
          level: 0,
          format: LevelFormat.DECIMAL,
          text: '%1.',
          alignment: AlignmentType.START,
          style: { paragraph: { indent: { left: 720, hanging: 360 } } },
        }],
      }],
    },
    sections: [
      {
        properties: {
          page: {
            margin: { top: 1080, right: 1080, bottom: 1080, left: 1080 },
          },
        },
        children,
      },
    ],
  })

  try {
    const buffer = await Packer.toBuffer(doc)
    fs.mkdirSync(path.dirname(outputPath), { recursive: true })
    fs.writeFileSync(outputPath, buffer)
    const size = fs.statSync(outputPath).size
    logger?.activity('document-docx-render-done', `out=${outputPath} size=${size} elapsed=${Date.now() - startedAt}ms`)
    return { size }
  } catch (err) {
    safeUnlink(outputPath)
    const e = err instanceof Error ? err : new Error(String(err))
    logger?.error('document-docx-render', e)
    throw e
  }
}

// ─── 块映射 ───────────────────────────────────────────────────────────────────

function renderBlockToDocx(
  block: DocumentBlock,
  cjkFont: string,
  monoFont: string,
  imageCtx: ImageRenderCtx,
): (Paragraph | Table)[] {
  switch (block.type) {
    case 'heading':
      return [new Paragraph({
        heading: mapHeadingLevel(block.level),
        children: [new TextRun({ text: block.text, font: cjkFont })],
      })]
    case 'paragraph': {
      const lines = block.text.split(/\n/)
      const runs: TextRun[] = []
      lines.forEach((line, i) => {
        runs.push(new TextRun({ text: line, font: cjkFont }))
        if (i < lines.length - 1) runs.push(new TextRun({ break: 1 }))
      })
      return [new Paragraph({ children: runs })]
    }
    case 'list':
      return block.items.map(item => buildListParagraph(item, block.ordered, cjkFont))
    case 'table':
      return [buildTable(block.headers, block.rows, cjkFont)]
    case 'code':
      return buildCodeBlock(block.code, monoFont)
    case 'callout':
      return [buildCalloutParagraph(block.level, block.text, cjkFont)]
    case 'cite':
      return [buildCiteParagraph(block.source, block.page, block.text, cjkFont)]
    case 'image':
      return renderImageBlock(block, imageCtx)
    case 'divider':
      return [new Paragraph({
        border: {
          bottom: { style: BorderStyle.SINGLE, size: 6, color: 'D0D7DE' },
        },
      })]
  }
}

// ─── 图片块渲染 ────────────────────────────────────────────────────────────────

/**
 * 渲染图片块为 docx Paragraph 序列。
 *
 * 路径安全降级策略（按优先级，命中任一即降级为占位段并 logger.activity 记录原因）：
 *   1. 远程 URL（http:// / https://）—— v1 不下载远程图
 *   2. 绝对路径 —— 拒绝（避免泄漏宿主任意路径）
 *   3. imageRoot 未配置 —— 无法解析相对路径
 *   4. resolveUnderRoot 抛错（含 ..）—— 路径穿越拦截
 *   5. 文件不存在 / 不是普通文件
 *   6. 扩展名不在白名单（仅 png/jpg/jpeg/gif/bmp）
 *   7. fs.readFile / image-size / ImageRun 任一抛错
 *
 * 嵌入成功后追加一个 caption 段落（居中、灰色 9pt），与 HTML 的 figcaption 对齐。
 */
function renderImageBlock(
  block: Extract<DocumentBlock, { type: 'image' }>,
  ctx: ImageRenderCtx,
): Paragraph[] {
  const src = block.src.trim()
  const fallback = (reason: string): Paragraph[] => {
    ctx.logger?.activity(
      'document-docx-image-fallback',
      `reason=${reason} src=${src} alt=${block.alt ?? ''}`,
    )
    return [buildImagePlaceholder(block, ctx.cjkFont)]
  }

  if (!src) return fallback('empty-src')
  if (/^https?:\/\//i.test(src)) return fallback('remote-url')
  if (path.isAbsolute(src)) return fallback('absolute-path')
  if (!ctx.imageRoot) return fallback('no-image-root')

  let absPath: string
  try {
    absPath = resolveUnderRoot(ctx.imageRoot, src)
  } catch {
    return fallback('path-traversal')
  }

  let stat: fs.Stats
  try {
    stat = fs.statSync(absPath)
  } catch {
    return fallback('not-found')
  }
  if (!stat.isFile()) return fallback('not-a-file')

  const ext = path.extname(absPath).toLowerCase()
  const docxType = IMAGE_EXT_TO_DOCX_TYPE[ext]
  if (!docxType) return fallback(`unsupported-ext:${ext || '<none>'}`)

  let buffer: Buffer
  try {
    buffer = fs.readFileSync(absPath)
  } catch {
    return fallback('read-failed')
  }

  let intrinsicWidth: number | undefined
  let intrinsicHeight: number | undefined
  try {
    const dim = sizeOf(buffer)
    intrinsicWidth = dim.width
    intrinsicHeight = dim.height
  } catch {
    return fallback('image-size-failed')
  }
  if (!intrinsicWidth || !intrinsicHeight || intrinsicWidth <= 0 || intrinsicHeight <= 0) {
    return fallback('invalid-dimensions')
  }

  const { width: targetWidth, height: targetHeight } = fitImageDimensions(
    intrinsicWidth,
    intrinsicHeight,
    IMAGE_MAX_WIDTH_PX,
  )

  let imageRun: ImageRun
  try {
    imageRun = new ImageRun({
      type: docxType,
      data: buffer,
      transformation: { width: targetWidth, height: targetHeight },
      altText: block.alt
        ? { title: block.alt, description: block.alt, name: block.alt }
        : undefined,
    })
  } catch (err) {
    ctx.logger?.error?.(
      'document-docx-image-run',
      err instanceof Error ? err : new Error(String(err)),
    )
    return fallback('image-run-failed')
  }

  ctx.logger?.activity(
    'document-docx-image-embed',
    `src=${src} type=${docxType} intrinsic=${intrinsicWidth}x${intrinsicHeight} target=${targetWidth}x${targetHeight}`,
  )

  const paragraphs: Paragraph[] = [new Paragraph({
    alignment: AlignmentType.CENTER,
    children: [imageRun],
  })]

  if (block.caption) {
    paragraphs.push(new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new TextRun({
        text: block.caption,
        font: ctx.cjkFont,
        color: '57606A',
        size: 18,
      })],
    }))
  }

  return paragraphs
}

/** 等比缩放：若 intrinsicWidth 已 ≤ maxWidthPx，原尺寸返回。 */
function fitImageDimensions(
  intrinsicWidth: number,
  intrinsicHeight: number,
  maxWidthPx: number,
): { width: number; height: number } {
  if (intrinsicWidth <= maxWidthPx) {
    return { width: intrinsicWidth, height: intrinsicHeight }
  }
  const ratio = maxWidthPx / intrinsicWidth
  return {
    width: maxWidthPx,
    height: Math.max(1, Math.round(intrinsicHeight * ratio)),
  }
}

/** 与 v1 占位文本格式对齐（保持兼容，让降级路径与图片缺失场景视觉一致）。 */
function buildImagePlaceholder(
  block: Extract<DocumentBlock, { type: 'image' }>,
  cjkFont: string,
): Paragraph {
  return new Paragraph({
    children: [new TextRun({
      text: `[图片占位] ${block.alt || block.caption || block.src}`,
      italics: true,
      color: '888888',
      font: cjkFont,
    })],
  })
}

function mapHeadingLevel(level: DocumentHeadingLevel): (typeof HeadingLevel)[keyof typeof HeadingLevel] {
  switch (level) {
    case 1: return HeadingLevel.HEADING_1
    case 2: return HeadingLevel.HEADING_2
    case 3: return HeadingLevel.HEADING_3
    case 4: return HeadingLevel.HEADING_4
    case 5: return HeadingLevel.HEADING_5
    case 6: return HeadingLevel.HEADING_6
  }
}

function buildListParagraph(text: string, ordered: boolean, cjkFont: string): Paragraph {
  if (ordered) {
    return new Paragraph({
      numbering: { reference: 'soul-ordered', level: 0 },
      children: [new TextRun({ text, font: cjkFont })],
    })
  }
  return new Paragraph({
    bullet: { level: 0 },
    children: [new TextRun({ text, font: cjkFont })],
  })
}

function buildTable(headers: string[], rows: TableCellValue[][], cjkFont: string): Table {
  const headerRow: ITableRowOptions = {
    tableHeader: true,
    children: headers.map(h => buildTableCell(h, cjkFont, true)),
  }
  const bodyRows: ITableRowOptions[] = rows.map(row => ({
    children: row.map(c => buildTableCell(formatCell(c), cjkFont, false)),
  }))
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [new TableRow(headerRow), ...bodyRows.map(r => new TableRow(r))],
  })
}

function buildTableCell(text: string, cjkFont: string, isHeader: boolean): TableCell {
  const opts: ITableCellOptions = {
    children: [new Paragraph({
      children: [new TextRun({ text, font: cjkFont, bold: isHeader })],
    })],
    shading: isHeader ? { type: ShadingType.CLEAR, fill: 'F6F8FA' } : undefined,
  }
  return new TableCell(opts)
}

function buildCodeBlock(code: string, monoFont: string): Paragraph[] {
  const lines = code.split(/\n/)
  return lines.map(line => new Paragraph({
    shading: { type: ShadingType.CLEAR, fill: 'F6F8FA' },
    children: [new TextRun({ text: line || ' ', font: monoFont, size: 20 })],
  }))
}

const CALLOUT_FILL: Record<CalloutLevel, string> = {
  info: 'DDF4FF',
  warning: 'FFF8C5',
  success: 'DAFBE1',
  danger: 'FFEBE9',
}

function buildCalloutParagraph(level: CalloutLevel, text: string, cjkFont: string): Paragraph {
  return new Paragraph({
    shading: { type: ShadingType.CLEAR, fill: CALLOUT_FILL[level] },
    border: {
      left: { style: BorderStyle.SINGLE, size: 24, color: calloutBorder(level) },
    },
    children: [new TextRun({ text, font: cjkFont })],
  })
}

function calloutBorder(level: CalloutLevel): string {
  switch (level) {
    case 'info': return '0969DA'
    case 'warning': return 'BF8700'
    case 'success': return '1A7F37'
    case 'danger': return 'D1242F'
  }
}

function buildCiteParagraph(source: string, page: number | undefined, text: string, cjkFont: string): Paragraph {
  const sourceLabel = page !== undefined
    ? `（来源：${source}，第 ${page} 页）`
    : `（来源：${source}）`
  return new Paragraph({
    indent: { left: 720 },
    children: [
      new TextRun({ text, font: cjkFont, italics: true }),
      new TextRun({ text: ' ' + sourceLabel, font: cjkFont, italics: true, color: '57606A' }),
    ],
  })
}

function buildTitleParagraph(title: string, cjkFont: string): Paragraph {
  return new Paragraph({
    heading: HeadingLevel.TITLE,
    alignment: AlignmentType.CENTER,
    children: [new TextRun({ text: title, font: cjkFont, bold: true, size: 48 })],
  })
}

function buildMetaLine(metadata: DocumentIR['metadata']): Paragraph | null {
  const parts: string[] = []
  if (typeof metadata.author === 'string' && metadata.author) parts.push(metadata.author)
  if (typeof metadata.date === 'string' && metadata.date) parts.push(metadata.date)
  if (parts.length === 0) return null
  return new Paragraph({
    alignment: AlignmentType.CENTER,
    children: [new TextRun({ text: parts.join(' · '), color: '57606A', size: 20 })],
  })
}

function emptyParagraph(): Paragraph {
  return new Paragraph({ children: [] })
}

// ─── 内部工具 ──────────────────────────────────────────────────────────────────

function pickCjkFont(): string {
  switch (process.platform) {
    case 'win32': return 'Microsoft YaHei'
    case 'darwin': return 'PingFang SC'
    default: return 'Noto Sans CJK SC'
  }
}

function pickMonoFont(): string {
  switch (process.platform) {
    case 'darwin': return 'SF Mono'
    case 'win32': return 'Consolas'
    default: return 'DejaVu Sans Mono'
  }
}

function formatCell(cell: TableCellValue): string {
  if (cell === null) return ''
  if (typeof cell === 'number') return String(cell)
  return cell
}

function safeUnlink(p: string): void {
  try {
    if (fs.existsSync(p)) fs.unlinkSync(p)
  } catch {
    /* ignore */
  }
}
