/**
 * 路径安全工具：防止路径穿越攻击。
 *
 * 提供两层防护：
 * - assertSafeSegment：校验单个路径段（ID / 文件名）不含危险字符
 * - resolveUnderRoot：校验解析后的完整路径不会逃逸出指定根目录
 *
 * 全项目统一使用这两个函数处理路径安全，禁止各模块自行实现
 * path.resolve + startsWith 检查（容易遗漏 normalize 或前缀匹配陷阱）。
 *
 * @author zhi.qu
 * @date 2026-04-10
 */

import path from 'path'

/**
 * 断言字符串是安全的路径段（不含路径分隔符和 ..）。
 * 用于校验分身 ID、技能 ID、文件名等用户可控输入。
 *
 * @throws Error 如果包含非法字符
 */
export function assertSafeSegment(value: string, label: string): void {
  if (!value || !value.trim()) {
    throw new Error(`${label}不能为空`)
  }
  if (/[\/\\]|\.\.|\0/.test(value)) {
    throw new Error(`非法${label}，不能包含路径分隔符或 ..: ${value}`)
  }
}

/**
 * 将相对路径解析到指定根目录下，并确保结果不会逃逸出根目录。
 *
 * 替代各模块中散落的 `path.resolve(root, rel) + startsWith(root)` 模式，
 * 统一处理 normalize、尾部分隔符等边界情况。
 *
 * @param root        受信任的根目录（绝对路径）
 * @param relativePath 用户提供的相对路径
 * @returns           解析后的安全绝对路径
 * @throws Error      如果解析后的路径逃逸出根目录
 *
 * @example
 * ```ts
 * const safePath = resolveUnderRoot('/data/avatars', 'expert/soul.md')
 * // => '/data/avatars/expert/soul.md'
 *
 * resolveUnderRoot('/data/avatars', '../../etc/passwd')
 * // => throws Error: 路径穿越
 * ```
 */
export function resolveUnderRoot(root: string, relativePath: string): string {
  const normalizedRoot = path.resolve(root) + path.sep
  const resolved = path.resolve(root, relativePath)

  if (!resolved.startsWith(normalizedRoot) && resolved !== path.resolve(root)) {
    throw new Error(`路径穿越: "${relativePath}" 逃逸出根目录 "${root}"`)
  }

  return resolved
}
