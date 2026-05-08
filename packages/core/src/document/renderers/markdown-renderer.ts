/**
 * 文档生成 IR → Markdown 字符串渲染器
 *
 * 设计目标：与 ir-parser.ts 严格对应，满足 roundtrip 一致性
 *   parseIR(renderMarkdown(ir)).ir.blocks ≡ ir.blocks
 *
 * 已知 roundtrip 损失（IR schema 层面无法表达的歧义）：
 *   1. 表格里"形如 `42` 的字符串"会被解析器强制视为数字
 *      （IR 允许 string|number|null，但 markdown 表格层面无法标注类型）
 *   2. 表格里 null 单元格会变成空字符串
 *   3. image src 含空格的极端情况会解析失败（不应出现）
 *   4. metadata 中的数字会被解析回字符串（parseFrontmatterCore 出于
 *      与知识库 frontmatter 行为兼容的原因不做数字推断）。
 *      实践影响：在 IR 里写 `revision: 3` roundtrip 后变 `'3'`；
 *      如需保持数字语义，请在调用方做显式转换或使用字符串。
 *
 * @author zhi.qu
 * @date 2026-05-08
 */

import type {
  DocumentBlock,
  DocumentIR,
  DocumentMetadata,
  TableCellValue,
} from '../ir-schema'

/**
 * 渲染 IR 为 markdown 字符串。
 * 输出始终以 frontmatter 块开头（即使只有 title），块之间以空行分隔。
 */
export function renderMarkdown(ir: DocumentIR): string {
  const parts: string[] = []
  parts.push(renderFrontmatter(ir.metadata))
  for (const block of ir.blocks) {
    parts.push(renderBlock(block))
  }
  return parts.join('\n\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n'
}

// ─── frontmatter ──────────────────────────────────────────────────────────────

function renderFrontmatter(metadata: DocumentMetadata): string {
  const lines: string[] = ['---']
  lines.push(`title: ${serializeFrontmatterValue(metadata.title)}`)
  for (const [key, value] of Object.entries(metadata)) {
    if (key === 'title') continue
    if (value === undefined || value === null) continue
    const serialized = serializeFrontmatterValue(value)
    if (serialized === null) continue
    lines.push(`${key}: ${serialized}`)
  }
  lines.push('---')
  return lines.join('\n')
}

/**
 * 把元数据值序列化为安全的 frontmatter 字面量。
 * 返回 null 表示该值类型不支持，调用方应跳过。
 */
function serializeFrontmatterValue(value: unknown): string | null {
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (Array.isArray(value)) {
    const items = value
      .filter((v): v is string | number => typeof v === 'string' || typeof v === 'number')
      .map(v => String(v))
    return `[${items.join(', ')}]`
  }
  if (typeof value === 'string') {
    if (needsQuoting(value)) return `"${value.replace(/"/g, '\\"')}"`
    return value
  }
  return null
}

/**
 * 字符串需要加双引号的情况：
 * - 空串
 * - 字面量为 "true" / "false"（否则会被 parseFrontmatterCore 解析为布尔）
 * - 以 `[` 开头（否则会被解析为数组）
 * - 含 `:` `#` `\n` 等可能破坏 frontmatter 行结构的字符
 */
function needsQuoting(s: string): boolean {
  if (s === '') return true
  if (s === 'true' || s === 'false') return true
  if (s.startsWith('[') || s.startsWith(']')) return true
  return /[:#\n\r"]/.test(s)
}

// ─── 块分发 ───────────────────────────────────────────────────────────────────

function renderBlock(block: DocumentBlock): string {
  switch (block.type) {
    case 'heading':
      return `${'#'.repeat(block.level)} ${block.text}`
    case 'paragraph':
      return block.text
    case 'list':
      return renderList(block.ordered, block.items)
    case 'table':
      return renderTable(block.headers, block.rows)
    case 'code':
      return renderCode(block.language, block.code)
    case 'callout':
      return `:::callout ${block.level}\n${block.text}\n:::`
    case 'cite':
      return renderCite(block.source, block.page, block.text)
    case 'image':
      return renderImage(block.src, block.alt, block.caption)
    case 'divider':
      return '---'
  }
}

function renderList(ordered: boolean, items: string[]): string {
  if (items.length === 0) return ''
  return items
    .map((item, i) => (ordered ? `${i + 1}. ${item}` : `- ${item}`))
    .join('\n')
}

function renderTable(headers: string[], rows: TableCellValue[][]): string {
  const headerLine = `| ${headers.join(' | ')} |`
  const sepLine = `| ${headers.map(() => '---').join(' | ')} |`
  const bodyLines = rows.map(row => `| ${row.map(serializeCell).join(' | ')} |`)
  return [headerLine, sepLine, ...bodyLines].join('\n')
}

function serializeCell(value: TableCellValue): string {
  if (value === null) return ''
  if (typeof value === 'number') return String(value)
  return value
}

function renderCode(language: string | undefined, code: string): string {
  const fenceLang = language ?? ''
  return '```' + fenceLang + '\n' + code + '\n```'
}

function renderCite(source: string, page: number | undefined, text: string): string {
  const attrs = page !== undefined
    ? `source="${source}" page=${page}`
    : `source="${source}"`
  return `:::cite ${attrs}\n${text}\n:::`
}

function renderImage(src: string, alt: string | undefined, caption: string | undefined): string {
  const altText = alt ?? ''
  if (caption !== undefined && caption !== '') {
    return `![${altText}](${src} "${caption}")`
  }
  return `![${altText}](${src})`
}
