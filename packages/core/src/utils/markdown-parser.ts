/**
 * Markdown 解析工具库
 * 提供通用的 Markdown 文件解析功能
 */

import { parse as parseYaml } from 'yaml'

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
 * 提取 YAML frontmatter。
 *
 * 全字段以**字符串形式**返回，便于上层直接渲染。规则：
 *   - 字符串 / 数字 / 布尔 / null → toString（null/undefined → ''）
 *   - 数组 / 对象 → JSON.stringify（保留信息，避免上层崩）
 *   - 顶层非对象（如纯字符串 YAML）→ 返回空对象
 *
 * 支持完整 YAML（含 >- / |- 等折叠标量、引号、数组）；解析失败时回退到旧的
 * 行式 split（保留对损坏 frontmatter 的兜底行为，避免单个坏文件压垮全局扫描）。
 */
export function extractFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\n([\s\S]*?)\n---/)
  if (!match) return {}

  const frontmatter = match[1]

  try {
    const parsed = parseYaml(frontmatter) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const result: Record<string, string> = {}
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (value === null || value === undefined) result[key] = ''
      else if (typeof value === 'string') result[key] = value
      else if (typeof value === 'number' || typeof value === 'boolean') result[key] = String(value)
      else result[key] = JSON.stringify(value)
    }
    return result
  } catch {
    // 兜底：YAML 解析失败时退回行式 split（与旧实现一致，保留单行解析能力）
    const result: Record<string, string> = {}
    for (const line of frontmatter.split('\n')) {
      const colonIndex = line.indexOf(':')
      if (colonIndex > 0) {
        const key = line.slice(0, colonIndex).trim()
        let value = line.slice(colonIndex + 1).trim()
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1)
        }
        result[key] = value
      }
    }
    return result
  }
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
