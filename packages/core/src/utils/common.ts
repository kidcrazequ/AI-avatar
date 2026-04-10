/**
 * 项目级通用工具函数
 *
 * 统一处理日期格式化、文件系统递归遍历等横切关注点，
 * 防止各模块各自实现导致行为不一致（如 UTC vs 本地时区）。
 *
 * @author zhi.qu
 * @date 2026-04-10
 */

import fs from 'fs'
import path from 'path'

// ─── 日期工具 ────────────────────────────────────────────────────────────────

/**
 * 返回本地时区的 YYYY-MM-DD 格式日期字符串。
 *
 * 全项目统一使用此函数生成日期字符串，禁止直接调用
 * `toISOString().slice(0, 10)`（返回 UTC 日期，在 UTC+8 晚间与本地日期差一天）。
 *
 * @param date 可选，默认为当前时间
 * @returns 格式为 "YYYY-MM-DD" 的本地日期字符串
 */
export function localDateString(date = new Date()): string {
  return date.toLocaleDateString('sv-SE')
}

// ─── 文件系统工具 ─────────────────────────────────────────────────────────────

/** 递归遍历目录的默认最大深度，防止符号链接环路导致栈溢出 */
export const DEFAULT_MAX_DIR_DEPTH = 8

/**
 * 递归收集指定扩展名的文件路径。
 *
 * 全项目统一使用此函数进行递归目录扫描，禁止各模块自行实现递归遍历
 * （原因：各处自实现时容易忘记添加深度限制，导致符号链接环路栈溢出风险）。
 *
 * @param dirPath   起始目录的绝对路径
 * @param ext       目标扩展名（含点号，如 '.md'）
 * @param maxDepth  最大递归深度，默认 8
 * @param depth     当前递归深度（内部使用，外部调用无需传入）
 * @returns         匹配的文件绝对路径列表
 */
export function collectFilesRecursive(
  dirPath: string,
  ext: string,
  maxDepth = DEFAULT_MAX_DIR_DEPTH,
  depth = 0,
): string[] {
  if (depth > maxDepth) {
    console.warn(`[collectFilesRecursive] 目录递归深度超过 ${maxDepth}，跳过: ${dirPath}`)
    return []
  }
  const results: string[] = []
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name)
      if (entry.isDirectory()) {
        results.push(...collectFilesRecursive(fullPath, ext, maxDepth, depth + 1))
      } else if (entry.isFile() && entry.name.endsWith(ext)) {
        results.push(fullPath)
      }
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') {
      console.warn(`[collectFilesRecursive] 无法读取目录 ${dirPath}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return results
}
