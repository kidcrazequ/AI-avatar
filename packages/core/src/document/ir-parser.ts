/**
 * 文档生成 IR 解析器
 *
 * 把 LLM 输出的 Markdown 字符串（带 frontmatter + 自定义扩展语法）
 * 解析为统一的 DocumentIR 中间表示。
 *
 * 解析策略：
 *   - 行驱动状态机，宽进严出
 *   - 不引入 marked / unified / remark 等重型依赖
 *   - 解析过程中遇到不识别的内容回退为 paragraph，不抛错
 *   - 真正的格式问题由 validateIR() 统一把关
 *
 * 支持的语法：
 *   1. YAML frontmatter（复用 parseFrontmatterCore）
 *   2. ATX 标题：# / ## / ### / #### / ##### / ######
 *   3. 段落（空行分隔）
 *   4. 无序列表：- / * / +
 *   5. 有序列表：1. 2. 3.
 *   6. GFM 表格：| 表头 | 表头 |\n|---|---|\n| 单元 | 单元 |
 *   7. 围栏代码块：```语言\n...\n```
 *   8. 水平分割线：---
 *   9. 图片：![alt](src "caption")
 *   10. 自定义容器：
 *      :::callout warning
 *      文本内容（可多行）
 *      :::
 *      :::cite source="knowledge/xxx.md" page=12
 *      引文文本
 *      :::
 *
 * @author zhi.qu
 * @date 2026-05-08
 */

import { parseFrontmatterCore } from '../utils/knowledge-frontmatter'
import {
  CALLOUT_LEVELS,
  type CalloutLevel,
  type DocumentBlock,
  type DocumentIR,
  type DocumentMetadata,
  type HeadingLevel,
  type IRValidationError,
  type TableCellValue,
} from './ir-schema'

export interface IRParseResult {
  ir: DocumentIR
  warnings: IRValidationError[]
}

/**
 * 解析 LLM 输出的 markdown 字符串为 DocumentIR。
 *
 * 设计取舍：永不抛错。无法识别的内容回退为 paragraph，
 * 让调用方拿到尽可能完整的 IR 后再用 validateIR() 决定接受/拒绝。
 */
export function parseIR(input: string): IRParseResult {
  const warnings: IRValidationError[] = []
  const { meta, body } = parseFrontmatterCore(input)
  const metadata = normalizeMetadata(meta, warnings)
  const blocks = parseBlocks(body, warnings)
  return { ir: { metadata, blocks }, warnings }
}

// ─── frontmatter 归一化 ────────────────────────────────────────────────────────

function normalizeMetadata(meta: Record<string, unknown>, warnings: IRValidationError[]): DocumentMetadata {
  const result: DocumentMetadata = { title: '' }
  const title = meta.title
  if (typeof title === 'string' && title.trim().length > 0) {
    result.title = title.trim()
  } else {
    warnings.push({ blockIndex: -1, message: 'frontmatter.title 缺失或为空（必填）' })
  }
  for (const [key, value] of Object.entries(meta)) {
    if (key === 'title') continue
    if (value === undefined || value === null) continue
    result[key] = value
  }
  return result
}

// ─── 块级状态机 ────────────────────────────────────────────────────────────────

interface ParseContext {
  lines: string[]
  cursor: number
  warnings: IRValidationError[]
}

function parseBlocks(body: string, warnings: IRValidationError[]): DocumentBlock[] {
  const blocks: DocumentBlock[] = []
  const ctx: ParseContext = {
    lines: body.split(/\r?\n/),
    cursor: 0,
    warnings,
  }
  while (ctx.cursor < ctx.lines.length) {
    const block = parseNextBlock(ctx)
    if (block) blocks.push(block)
  }
  return blocks
}

function parseNextBlock(ctx: ParseContext): DocumentBlock | null {
  const line = ctx.lines[ctx.cursor]

  if (line === undefined || line.trim() === '') {
    ctx.cursor++
    return null
  }

  if (RE_FENCE.test(line)) return parseFencedCode(ctx)
  if (RE_DIVIDER.test(line)) {
    ctx.cursor++
    return { type: 'divider' }
  }
  if (RE_DIRECTIVE_OPEN.test(line)) return parseDirective(ctx)
  if (RE_HEADING.test(line)) return parseHeading(ctx)
  if (isTableHeader(ctx)) return parseTable(ctx)
  if (RE_UL_ITEM.test(line)) return parseList(ctx, false)
  if (RE_OL_ITEM.test(line)) return parseList(ctx, true)
  if (RE_IMAGE_ONLY.test(line.trim())) return parseStandaloneImage(ctx)
  return parseParagraph(ctx)
}

// ─── 各类块的解析 ──────────────────────────────────────────────────────────────

const RE_HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/
const RE_DIVIDER = /^\s{0,3}([-*_])\s*\1\s*\1[\s\S]*$/
const RE_FENCE = /^\s{0,3}```([^\s`]*)\s*$/
const RE_UL_ITEM = /^(\s*)[-*+]\s+(.+)$/
const RE_OL_ITEM = /^(\s*)\d+\.\s+(.+)$/
const RE_IMAGE_ONLY = /^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)$/
const RE_DIRECTIVE_OPEN = /^\s{0,3}(?:>\s*)?:::([a-zA-Z][a-zA-Z0-9_-]*)\s*(.*)$/
const RE_DIRECTIVE_CLOSE = /^\s{0,3}(?:>\s*)?:::\s*$/

function parseHeading(ctx: ParseContext): DocumentBlock {
  const line = ctx.lines[ctx.cursor]
  const match = line.match(RE_HEADING)
  ctx.cursor++
  if (!match) {
    return { type: 'paragraph', text: line.trim() }
  }
  const level = match[1].length as HeadingLevel
  const text = match[2].trim()
  return { type: 'heading', level, text }
}

function parseFencedCode(ctx: ParseContext): DocumentBlock {
  const openLine = ctx.lines[ctx.cursor]
  const openMatch = openLine.match(RE_FENCE)
  ctx.cursor++
  const language = openMatch && openMatch[1] ? openMatch[1] : undefined
  const codeLines: string[] = []
  while (ctx.cursor < ctx.lines.length) {
    const cur = ctx.lines[ctx.cursor]
    if (RE_FENCE.test(cur)) {
      ctx.cursor++
      break
    }
    codeLines.push(cur)
    ctx.cursor++
  }
  const block: DocumentBlock = language
    ? { type: 'code', language, code: codeLines.join('\n') }
    : { type: 'code', code: codeLines.join('\n') }
  return block
}

function parseList(ctx: ParseContext, ordered: boolean): DocumentBlock {
  const items: string[] = []
  const itemRegex = ordered ? RE_OL_ITEM : RE_UL_ITEM
  while (ctx.cursor < ctx.lines.length) {
    const cur = ctx.lines[ctx.cursor]
    const m = cur.match(itemRegex)
    if (!m) break
    items.push(m[2].trim())
    ctx.cursor++
  }
  return { type: 'list', ordered, items }
}

function isTableHeader(ctx: ParseContext): boolean {
  const headerLine = ctx.lines[ctx.cursor]
  if (!headerLine || !headerLine.includes('|')) return false
  const sepLine = ctx.lines[ctx.cursor + 1]
  if (!sepLine) return false
  return /^\s*\|?\s*[:\-\s|]+\|?\s*$/.test(sepLine) && sepLine.includes('-')
}

function parseTable(ctx: ParseContext): DocumentBlock {
  const headers = splitTableRow(ctx.lines[ctx.cursor])
  ctx.cursor += 2
  const rows: TableCellValue[][] = []
  while (ctx.cursor < ctx.lines.length) {
    const cur = ctx.lines[ctx.cursor]
    if (!cur || !cur.includes('|')) break
    const cells = splitTableRow(cur).map(coerceCell)
    rows.push(cells)
    ctx.cursor++
  }
  return { type: 'table', headers, rows }
}

function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\||\|$/g, '')
  return trimmed.split('|').map(s => s.trim())
}

function coerceCell(cell: string): TableCellValue {
  if (cell === '') return ''
  if (/^-?\d+(\.\d+)?$/.test(cell)) {
    const n = Number(cell)
    return Number.isFinite(n) ? n : cell
  }
  return cell
}

function parseStandaloneImage(ctx: ParseContext): DocumentBlock {
  const line = ctx.lines[ctx.cursor].trim()
  ctx.cursor++
  const m = line.match(RE_IMAGE_ONLY)
  if (!m) return { type: 'paragraph', text: line }
  const block: DocumentBlock = { type: 'image', src: m[2] }
  if (m[1]) block.alt = m[1]
  if (m[3]) block.caption = m[3]
  return block
}

function parseParagraph(ctx: ParseContext): DocumentBlock {
  const buf: string[] = []
  while (ctx.cursor < ctx.lines.length) {
    const cur = ctx.lines[ctx.cursor]
    if (cur === undefined || cur.trim() === '') break
    if (
      RE_HEADING.test(cur) ||
      RE_FENCE.test(cur) ||
      RE_DIVIDER.test(cur) ||
      RE_UL_ITEM.test(cur) ||
      RE_OL_ITEM.test(cur) ||
      RE_DIRECTIVE_OPEN.test(cur)
    ) break
    buf.push(cur)
    ctx.cursor++
  }
  return { type: 'paragraph', text: buf.join('\n').trim() }
}

// ─── 自定义容器（callout / cite） ─────────────────────────────────────────────

function parseDirective(ctx: ParseContext): DocumentBlock | null {
  const openLine = ctx.lines[ctx.cursor]
  const openMatch = openLine.match(RE_DIRECTIVE_OPEN)
  if (!openMatch) {
    ctx.cursor++
    return { type: 'paragraph', text: openLine.trim() }
  }
  const directive = openMatch[1].toLowerCase()
  const argsRaw = openMatch[2].trim()
  ctx.cursor++

  const contentLines: string[] = []
  let closed = false
  while (ctx.cursor < ctx.lines.length) {
    const cur = ctx.lines[ctx.cursor]
    if (RE_DIRECTIVE_CLOSE.test(cur)) {
      ctx.cursor++
      closed = true
      break
    }
    contentLines.push(stripDirectiveQuoteMarker(cur))
    ctx.cursor++
  }
  const text = contentLines.join('\n').trim()

  if (!closed) {
    ctx.warnings.push({
      blockIndex: -1,
      message: `:::${directive} 容器未闭合（缺少 ::: 行），按 paragraph 兜底`,
    })
    return text ? { type: 'paragraph', text } : null
  }

  if (directive === 'callout') {
    const level = parseCalloutLevel(argsRaw)
    if (!level) {
      ctx.warnings.push({
        blockIndex: -1,
        message: `:::callout 的 level "${argsRaw}" 非法（应为 ${CALLOUT_LEVELS.join('|')}），降级为 info`,
      })
    }
    return { type: 'callout', level: level ?? 'info', text }
  }

  if (directive === 'cite') {
    const attrs = parseDirectiveAttrs(argsRaw)
    const source = typeof attrs.source === 'string' ? attrs.source : ''
    if (!source) {
      ctx.warnings.push({ blockIndex: -1, message: ':::cite 缺少 source 属性' })
      return { type: 'paragraph', text }
    }
    const block: DocumentBlock = { type: 'cite', source, text }
    if (typeof attrs.page === 'number') {
      block.page = attrs.page
    }
    return block
  }

  ctx.warnings.push({ blockIndex: -1, message: `未知容器指令 ":::${directive}"，回退为 paragraph` })
  return text ? { type: 'paragraph', text } : null
}

function stripDirectiveQuoteMarker(line: string): string {
  return line.replace(/^\s{0,3}>\s?/, '')
}

function parseCalloutLevel(input: string): CalloutLevel | null {
  const lower = input.toLowerCase().trim()
  return CALLOUT_LEVELS.includes(lower as CalloutLevel) ? (lower as CalloutLevel) : null
}

/**
 * 解析容器属性串，如 `source="knowledge/foo.md" page=12`
 * 仅支持 key=value（带或不带双引号）。
 */
function parseDirectiveAttrs(raw: string): Record<string, string | number> {
  const out: Record<string, string | number> = {}
  const re = /(\w+)\s*=\s*("([^"]*)"|(\S+))/g
  let m: RegExpExecArray | null
  while ((m = re.exec(raw)) !== null) {
    const key = m[1]
    const value = m[3] !== undefined ? m[3] : m[4]
    if (/^-?\d+$/.test(value)) {
      const n = parseInt(value, 10)
      if (Number.isInteger(n)) {
        out[key] = n
        continue
      }
    }
    out[key] = value
  }
  return out
}
