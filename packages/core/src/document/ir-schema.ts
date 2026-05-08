/**
 * 文档生成中间表示（IR）类型定义与校验
 *
 * 设计动机：让 LLM 一次输出统一格式（Markdown + frontmatter + 自定义扩展），
 * 由本模块解析为结构化 IR，再分发到 Markdown / PDF / DOCX 三个渲染器，
 * 避免"切换格式重新调 LLM"或"为每种格式各写一套生成逻辑"。
 *
 * 与 export_excel 工具的对应关系：
 *   - export_excel 处理结构化数据（rows × columns）
 *   - generate_document 处理半结构化文档（块序列）
 * 两者并列，互为补充。
 *
 * @author zhi.qu
 * @date 2026-05-08
 */

// ─── 块类型 ────────────────────────────────────────────────────────────────────

export type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6

export type CalloutLevel = 'info' | 'warning' | 'success' | 'danger'

export const CALLOUT_LEVELS: readonly CalloutLevel[] = ['info', 'warning', 'success', 'danger']

/** 表格单元值：仅允许字符串/数字/null（避免 LLM 塞嵌套对象导致渲染失败） */
export type TableCellValue = string | number | null

export type DocumentBlock =
  | { type: 'heading'; level: HeadingLevel; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'list'; ordered: boolean; items: string[] }
  | { type: 'table'; headers: string[]; rows: TableCellValue[][] }
  | { type: 'code'; language?: string; code: string }
  | { type: 'callout'; level: CalloutLevel; text: string }
  | { type: 'cite'; source: string; page?: number; text: string }
  | { type: 'image'; src: string; caption?: string; alt?: string }
  | { type: 'divider' }

export type DocumentBlockType = DocumentBlock['type']

// ─── 元数据与文档 ──────────────────────────────────────────────────────────────

export interface DocumentMetadata {
  /** 必填：文档主标题，用作 PDF/DOCX 的 title 与 HTML <title> */
  title: string
  /** 可选：作者名，缺失时由分身名称兜底 */
  author?: string
  /** 可选：YYYY-MM-DD，缺失时由 localDateString() 兜底 */
  date?: string
  /** 可选：CSS 模板名（不含 .css 后缀），缺失时使用 'default' */
  template?: string
  /** 允许扩展字段，但渲染器只识别上述四个 */
  [key: string]: unknown
}

export interface DocumentIR {
  metadata: DocumentMetadata
  blocks: DocumentBlock[]
}

// ─── 校验结果 ──────────────────────────────────────────────────────────────────

export interface IRValidationError {
  /** 块在 blocks 数组中的索引；-1 表示元数据级错误 */
  blockIndex: number
  message: string
}

export interface IRValidationResult {
  valid: boolean
  ir?: DocumentIR
  errors: IRValidationError[]
}

// ─── 校验器 ────────────────────────────────────────────────────────────────────

/**
 * 严格校验 IR 结构，返回所有错误而非短路抛错。
 *
 * 设计取舍：宽进严出 —— 解析器允许"尽可能多解析"，校验器统一把关。
 * 这样 LLM 输出有 1-2 个块格式错误时，能保留其他正确块，并把错误信息
 * 反馈给 LLM 让它修正（而非整篇拒绝）。
 */
export function validateIR(input: unknown): IRValidationResult {
  const errors: IRValidationError[] = []

  if (!isPlainObject(input)) {
    return { valid: false, errors: [{ blockIndex: -1, message: '输入不是对象' }] }
  }

  const metadata = (input as { metadata?: unknown }).metadata
  if (!isPlainObject(metadata)) {
    errors.push({ blockIndex: -1, message: 'metadata 字段缺失或不是对象' })
  } else {
    const title = (metadata as { title?: unknown }).title
    if (typeof title !== 'string' || title.trim().length === 0) {
      errors.push({ blockIndex: -1, message: 'metadata.title 必须为非空字符串' })
    }
  }

  const blocks = (input as { blocks?: unknown }).blocks
  if (!Array.isArray(blocks)) {
    errors.push({ blockIndex: -1, message: 'blocks 字段缺失或不是数组' })
    return { valid: false, errors }
  }

  for (let i = 0; i < blocks.length; i++) {
    const blockErrors = validateBlock(blocks[i], i)
    errors.push(...blockErrors)
  }

  if (errors.length > 0) {
    return { valid: false, errors }
  }
  return { valid: true, ir: input as unknown as DocumentIR, errors: [] }
}

function validateBlock(block: unknown, index: number): IRValidationError[] {
  if (!isPlainObject(block)) {
    return [{ blockIndex: index, message: '块不是对象' }]
  }

  const type = (block as { type?: unknown }).type
  if (typeof type !== 'string') {
    return [{ blockIndex: index, message: '块缺少 type 字段' }]
  }

  switch (type) {
    case 'heading': {
      const level = (block as { level?: unknown }).level
      const text = (block as { text?: unknown }).text
      const errs: IRValidationError[] = []
      if (typeof level !== 'number' || ![1, 2, 3, 4, 5, 6].includes(level)) {
        errs.push({ blockIndex: index, message: 'heading.level 必须为 1-6 整数' })
      }
      if (typeof text !== 'string') {
        errs.push({ blockIndex: index, message: 'heading.text 必须为字符串' })
      }
      return errs
    }
    case 'paragraph': {
      const text = (block as { text?: unknown }).text
      return typeof text === 'string'
        ? []
        : [{ blockIndex: index, message: 'paragraph.text 必须为字符串' }]
    }
    case 'list': {
      const ordered = (block as { ordered?: unknown }).ordered
      const items = (block as { items?: unknown }).items
      const errs: IRValidationError[] = []
      if (typeof ordered !== 'boolean') {
        errs.push({ blockIndex: index, message: 'list.ordered 必须为布尔' })
      }
      if (!Array.isArray(items) || !items.every(s => typeof s === 'string')) {
        errs.push({ blockIndex: index, message: 'list.items 必须为字符串数组' })
      }
      return errs
    }
    case 'table': {
      const headers = (block as { headers?: unknown }).headers
      const rows = (block as { rows?: unknown }).rows
      const errs: IRValidationError[] = []
      if (!Array.isArray(headers) || !headers.every(s => typeof s === 'string')) {
        errs.push({ blockIndex: index, message: 'table.headers 必须为字符串数组' })
      }
      if (!Array.isArray(rows)) {
        errs.push({ blockIndex: index, message: 'table.rows 必须为数组' })
      } else {
        for (let r = 0; r < rows.length; r++) {
          const row = rows[r]
          if (!Array.isArray(row) || !row.every(isTableCellValue)) {
            errs.push({ blockIndex: index, message: `table.rows[${r}] 单元值仅允许 string|number|null` })
            break
          }
        }
      }
      return errs
    }
    case 'code': {
      const code = (block as { code?: unknown }).code
      const language = (block as { language?: unknown }).language
      const errs: IRValidationError[] = []
      if (typeof code !== 'string') {
        errs.push({ blockIndex: index, message: 'code.code 必须为字符串' })
      }
      if (language !== undefined && typeof language !== 'string') {
        errs.push({ blockIndex: index, message: 'code.language 必须为字符串或省略' })
      }
      return errs
    }
    case 'callout': {
      const level = (block as { level?: unknown }).level
      const text = (block as { text?: unknown }).text
      const errs: IRValidationError[] = []
      if (typeof level !== 'string' || !CALLOUT_LEVELS.includes(level as CalloutLevel)) {
        errs.push({ blockIndex: index, message: `callout.level 必须为 ${CALLOUT_LEVELS.join('|')} 之一` })
      }
      if (typeof text !== 'string') {
        errs.push({ blockIndex: index, message: 'callout.text 必须为字符串' })
      }
      return errs
    }
    case 'cite': {
      const source = (block as { source?: unknown }).source
      const text = (block as { text?: unknown }).text
      const page = (block as { page?: unknown }).page
      const errs: IRValidationError[] = []
      if (typeof source !== 'string' || source.trim().length === 0) {
        errs.push({ blockIndex: index, message: 'cite.source 必须为非空字符串' })
      }
      if (typeof text !== 'string') {
        errs.push({ blockIndex: index, message: 'cite.text 必须为字符串' })
      }
      if (page !== undefined && (typeof page !== 'number' || !Number.isInteger(page) || page < 1)) {
        errs.push({ blockIndex: index, message: 'cite.page 必须为正整数或省略' })
      }
      return errs
    }
    case 'image': {
      const src = (block as { src?: unknown }).src
      const caption = (block as { caption?: unknown }).caption
      const alt = (block as { alt?: unknown }).alt
      const errs: IRValidationError[] = []
      if (typeof src !== 'string' || src.trim().length === 0) {
        errs.push({ blockIndex: index, message: 'image.src 必须为非空字符串' })
      }
      if (caption !== undefined && typeof caption !== 'string') {
        errs.push({ blockIndex: index, message: 'image.caption 必须为字符串或省略' })
      }
      if (alt !== undefined && typeof alt !== 'string') {
        errs.push({ blockIndex: index, message: 'image.alt 必须为字符串或省略' })
      }
      return errs
    }
    case 'divider': {
      return []
    }
    default:
      return [{ blockIndex: index, message: `未知块类型: ${type}` }]
  }
}

// ─── 内部工具 ──────────────────────────────────────────────────────────────────

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isTableCellValue(v: unknown): v is TableCellValue {
  return v === null || typeof v === 'string' || typeof v === 'number'
}
