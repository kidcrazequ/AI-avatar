/**
 * 查询文本哈希工具：FNV-1a 32bit。
 *
 * 从 utils/chart-cache.ts 抽出，独立成文件以便浏览器端导入：
 *   chart-cache.ts 内部 import 了 fs / path（持久化用），
 *   渲染进程通过 @soul/core/browser 仅需要 hashQueryContent / normalizeQueryForHash，
 *   独立文件可避免顶层 import fs/path 在浏览器侧加载失败。
 *
 * @author zhi.qu
 * @date 2026-04-30
 */

/**
 * 规范化用户问题文本用于生成 cache key。
 * 只做"等价写法归一"：压缩内部空白 + 两端 trim + ASCII 小写。
 * 不去标点、不分词 —— 避免把语义不同的问题误归为同一 key。
 *
 * @param content 原始查询文本
 * @returns 规范化后的字符串
 */
export function normalizeQueryForHash(content: string): string {
  return content
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[A-Z]/g, c => c.toLowerCase())
}

/**
 * FNV-1a 32bit hex；和 knowledge-indexer / deriveSeedFromContent 同源风格。
 *
 * @param content 任意文本
 * @returns 8 位十六进制字符串
 */
export function hashQueryContent(content: string): string {
  const s = normalizeQueryForHash(content)
  let hash = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    hash ^= s.charCodeAt(i)
    hash = (hash * 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}
