/**
 * 本地时区日期格式化工具。
 *
 * 从 utils/common.ts 抽出，独立成文件以便浏览器端导入：
 *   common.ts 内部 import 了 fs / path（供 collectFilesRecursive 使用），
 *   渲染进程通过 @soul/core/browser 仅需要 localDateString，
 *   独立文件可避免顶层 import fs/path 在浏览器侧加载失败。
 *
 * 全项目统一使用 localDateString 生成 YYYY-MM-DD 字符串，
 * 禁止 toISOString().slice(0, 10)（UTC 偏移会导致日期差一天）。
 *
 * @author zhi.qu
 * @date 2026-04-30
 */

/**
 * 返回本地时区的 YYYY-MM-DD 格式日期字符串。
 *
 * 实现：使用 Intl 提供的 'sv-SE'（瑞典）locale，
 *      其官方日期格式即 ISO-8601 形式的 YYYY-MM-DD，且按本地时区计算。
 *
 * @param date 可选，默认为当前时间
 * @returns 格式为 "YYYY-MM-DD" 的本地日期字符串
 */
export function localDateString(date = new Date()): string {
  return date.toLocaleDateString('sv-SE')
}
