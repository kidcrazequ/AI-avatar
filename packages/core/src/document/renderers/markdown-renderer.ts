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
      return renderCallout(block.level, block.text)
    case 'cite':
      return renderCite(block.source, block.page, block.text)
    case 'image':
      return renderImage(block.src, block.alt, block.caption)
    case 'divider':
      return '---'
    default: {
      // TS exhaustiveness check：未来 DocumentBlock 加新 type 但忘了在此处理，编译期会报错
      const _never: never = block
      throw new Error(`未覆盖的 block.type: ${(_never as { type: string }).type}`)
    }
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

/**
 * 把 cite 块渲染成标准 GFM blockquote（每行 `> ` 前缀）。
 *
 * 旧实现用 `:::cite source="..." page=2\n...\n:::` 扩展指令，但**标准 markdown 渲染器
 * 不识别 `:::` directive**——GitHub / VS Code / 桌面端预览都把它当裸文本显示
 * （2026-05-22 用户反馈"生成的 md 文件缺少格式"）。改用 blockquote 兼容所有渲染器。
 * 来源行加粗强调，文本部分多行也加 `> ` 前缀避免被识别为引用结束。
 *
 * DOCX/PDF 不走这里（它们直接吃 IR），所以这次修改不影响那些格式的渲染。
 */
function renderCite(source: string, page: number | undefined, text: string): string {
  const sourceLine = page !== undefined
    ? `> **来源**：\`${source}\` (p.${page})`
    : `> **来源**：\`${source}\``
  const textLines = text.split('\n').map(l => `> ${l}`).join('\n')
  return `${sourceLine}\n>\n${textLines}`
}

/**
 * 把 callout 块渲染成 GFM Alert 语法（GitHub 原生支持，VS Code / 多数渲染器也兼容）。
 *
 * 旧实现 `:::callout warning\n...\n:::` 同样是 directive 扩展，标准渲染器无效。
 * GFM Alert 形如 `> [!WARNING]\n> 文本`，外观仍是 blockquote 但带语义标记。
 * 不支持 GFM Alert 的渲染器至少会回退为普通 blockquote，可读性可接受。
 */
function renderCallout(level: 'info' | 'warning' | 'success' | 'danger', text: string): string {
  const tag: Record<typeof level, string> = {
    info: 'NOTE',
    success: 'TIP',
    warning: 'WARNING',
    danger: 'CAUTION',
  }
  const textLines = text.split('\n').map(l => `> ${l}`).join('\n')
  return `> [!${tag[level]}]\n${textLines}`
}

function renderImage(src: string, alt: string | undefined, caption: string | undefined): string {
  const altText = alt ?? ''
  if (caption !== undefined && caption !== '') {
    return `![${altText}](${src} "${caption}")`
  }
  return `![${altText}](${src})`
}
