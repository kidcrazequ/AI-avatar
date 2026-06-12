/**
 * 解析知识库 .md 顶部的 YAML frontmatter（与 KnowledgeViewer 一致：key: value + 简单数组）。
 */
export function parseFrontmatter(src: string): { meta: Record<string, unknown>; body: string } {
  if (!src.startsWith('---\n') && !src.startsWith('---\r\n')) {
    return { meta: {}, body: src }
  }
  const endMatch = src.match(/\n---\r?\n/)
  if (!endMatch || endMatch.index === undefined) {
    return { meta: {}, body: src }
  }
  const fmText = src.slice(4, endMatch.index)
  const body = src.slice(endMatch.index + endMatch[0].length)
  const meta: Record<string, unknown> = {}
  for (const line of fmText.split(/\r?\n/)) {
    const m = line.match(/^([a-zA-Z_][\w-]*)\s*:\s*(.*)$/)
    if (!m) continue
    const key = m[1]
    const raw = m[2].trim()
    if (raw === 'true') meta[key] = true
    else if (raw === 'false') meta[key] = false
    else if (raw.startsWith('[') && raw.endsWith(']')) {
      meta[key] = raw.slice(1, -1).split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean)
    } else {
      meta[key] = raw.replace(/^["']|["']$/g, '')
    }
  }
  return { meta, body }
}

const NO_FORMAT_RAW_EXTS = new Set([
  'xlsx', 'xls', 'csv', 'pptx', 'ppt', 'jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp',
])

/**
 * 是否隐藏知识库 FORMAT 按钮。
 * Excel/PPTX 快速路径只写 `source:` / `excel_json:`，不写 `raw_file:`，需单独识别（见 CHANGELOG FORMAT 智能显隐）。
 */
export function shouldHideKnowledgeFormatButton(meta: Record<string, unknown>): boolean {
  const source = typeof meta.source === 'string' ? meta.source.toLowerCase() : ''
  // 已 LLM 格式化（FORMAT 成功后标 source: enhanced）→ 再 FORMAT 冗余，隐藏。
  if (source === 'enhanced') return true
  // 精读产物是蒸馏笔记：FORMAT 会从 _raw/ 整本原书重新排版并覆盖笔记，必须隐藏。
  if (meta.source_type === 'deep-read') return true
  if (source === 'excel' || source === 'pptx') return true
  if (typeof meta.excel_json === 'string') return true

  const rawPath = typeof meta.raw_file === 'string' ? meta.raw_file : ''
  const base = rawPath.split(/[/\\]/).pop() ?? ''
  const extMatch = base.match(/\.([a-z0-9]+)$/i)
  const ext = extMatch ? extMatch[1].toLowerCase() : ''
  return NO_FORMAT_RAW_EXTS.has(ext)
}
