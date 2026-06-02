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
 * 实现已抽到 utils/local-date.ts，本处仅做 re-export 以保持向后兼容
 * （浏览器子入口直接从 utils/local-date 导入，避免连带加载 fs/path）。
 */
export { localDateString } from './local-date'

// ─── 文件系统工具 ─────────────────────────────────────────────────────────────

/**
 * 递归遍历目录的默认最大深度，防止符号链接环路导致栈溢出。
 * 设为 16：真实知识库（如招投标技术响应资料）嵌套可达 10+ 层，
 * 早期 8 会静默丢掉深层文件，连 search_knowledge 也够不到（同用此常量）。
 */
export const DEFAULT_MAX_DIR_DEPTH = 16

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
