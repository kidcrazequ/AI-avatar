/**
 * Markdown 解析工具库
 * 提供通用的 Markdown 文件解析功能
 */

/**
 * 提取 Markdown 文件的标题（第一个 # 标题）
 */
export function extractTitle(content: string): string {
  const match = content.match(/^#\s+(.+)$/m)
  return match ? match[1].trim() : ''
}

/**
 * 提取 Markdown 元数据（> **键**：值 格式）
 */
export function extractMetadata(content: string, key: string): string {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(`>\\s*\\*\\*${escaped}\\*\\*[：:]\\s*(.+)$`, 'm')
  const match = content.match(pattern)
  return match ? match[1].trim() : ''
}

/**
 * 提取 Markdown 章节内容
 */
export function extractSection(content: string, sectionName: string): string {
  const escaped = sectionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(`##\\s+${escaped}\\s+([\\s\\S]*?)(?=\\n##|$)`, 'm')
  const match = content.match(pattern)
  return match ? match[1].trim() : ''
}

/**
 * 提取 YAML frontmatter
 */
export function extractFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\n([\s\S]*?)\n---/)
  if (!match) return {}

  const frontmatter = match[1]
  const result: Record<string, string> = {}

  const lines = frontmatter.split('\n')
  for (const line of lines) {
    const colonIndex = line.indexOf(':')
    if (colonIndex > 0) {
      const key = line.slice(0, colonIndex).trim()
      let value = line.slice(colonIndex + 1).trim()
      // 去除 YAML 引号包裹
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1)
      }
      result[key] = value
    }
  }

  return result
}

/**
 * 提取 frontmatter 中的单个字段
 */
export function extractFrontmatterField(content: string, field: string): string {
  const frontmatter = extractFrontmatter(content)
  return frontmatter[field] || ''
}

/**
 * 提取 Markdown 列表项（- 开头的行）
 */
export function extractListItems(content: string): string[] {
  return content
    .split('\n')
    .filter(line => line.trim().startsWith('- '))
    .map(line => line.trim().slice(2).trim())
}

/** 转义正则特殊字符 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 提取指定分隔符之间的内容
 */
export function extractBetweenDelimiters(
  content: string,
  startDelimiter: string,
  endDelimiter: string
): string {
  const escapedStart = escapeRegex(startDelimiter)
  const escapedEnd = endDelimiter ? escapeRegex(endDelimiter) : ''
  const pattern = new RegExp(`${escapedStart}\\s*([\\s\\S]*?)(?=${escapedEnd || '$'})`, 'm')
  const match = content.match(pattern)
  return match ? match[1].trim() : ''
}
