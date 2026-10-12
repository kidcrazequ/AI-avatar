/**
 * Tool Result Compressor — TokenJuice 启发的工具返回值后处理层
 *
 * 设计原则（红线，禁止违反）：
 *   1. 只做"无损 + 可还原"操作；绝不调 LLM 二次总结
 *   2. `query_excel` / `read_knowledge_file` / `read_attachment` / `eval_js` /
 *      `exec_shell` / `exec_code` 等事实根基类工具走 passthrough 白名单
 *   3. env `SOUL_TOOL_COMPRESSION=off` 一键回退为 identity 函数
 *
 * v1 范围（本期）：
 *   - Strip ANSI 转义
 *   - Trim 每行尾部空白
 *   - 折叠 ≥3 个连续空行 → 2 个
 *   - 章节去重：仅对包含 `\n\n---\n\n` 分隔的输出（search_knowledge 格式）做完全相同章节去重
 *
 * v2 backlog（不在本期）：
 *   - 跨工具调用去重（需要 per-conversation 状态 + TTL 淘汰）
 *   - URL 截短显示态（需要与新「联网引用铁律」prompt 仔细对齐）
 *   - 段落级去重（v1 章节级太保守时可放开）
 *
 * @author zhi.qu
 * @date 2026-05-18
 */

import crypto from 'crypto'

/** 压缩配置，由 ToolRouter 在构造时根据 env 决定 */
export interface CompressConfig {
  enabled: boolean
  stripAnsi: boolean
  collapseWhitespace: boolean
  dedupeSections: boolean
  /** 这些工具的 content 原样透传（红线：事实根基不动） */
  passthrough: ReadonlySet<string>
}

/** 默认透传白名单。事实根基类工具的输出必须 byte-for-byte 保留。 */
export const DEFAULT_COMPRESSION_PASSTHROUGH: ReadonlySet<string> = new Set([
  'query_excel',
  'read_knowledge_file',
  'read_attachment',
  'search_attachment',
  'read_file',
  'read_lines',
  'eval_js',
  'eval_js_user_view',
  'exec_shell',
  'exec_code',
  'await_shell',
  // 调试/状态查询类，原文短且精确
  'git_status',
  'git_diff',
])

/** 从 env 构建默认配置（在 ToolRouter 构造时调用一次） */
export function buildDefaultCompressConfig(envValue?: string): CompressConfig {
  const enabled = (envValue ?? 'on').toLowerCase() !== 'off'
  return {
    enabled,
    stripAnsi: true,
    collapseWhitespace: true,
    dedupeSections: true,
    passthrough: DEFAULT_COMPRESSION_PASSTHROUGH,
  }
}

/**
 * 压缩工具返回的 content 字符串。失败时降级为原文（永远不抛）。
 *
 * @param toolName 工具名（用于查透传白名单）
 * @param content 原始 content
 * @param config 压缩配置
 * @returns { content, originalChars, finalChars, droppedSections }
 */
export function compressToolResult(
  toolName: string,
  content: string,
  config: CompressConfig,
): { content: string; originalChars: number; finalChars: number; droppedSections: number } {
  const originalChars = content.length

  // 短路 1：env 关 → identity
  if (!config.enabled) {
    return { content, originalChars, finalChars: originalChars, droppedSections: 0 }
  }
  // 短路 2：透传白名单
  if (config.passthrough.has(toolName)) {
    return { content, originalChars, finalChars: originalChars, droppedSections: 0 }
  }
  // 短路 3：空 / 极短内容
  if (content.length < 64) {
    return { content, originalChars, finalChars: originalChars, droppedSections: 0 }
  }

  let working = content
  let droppedSections = 0

  try {
    // 1. Strip ANSI 转义（终端颜色码）
    if (config.stripAnsi) {
      // eslint-disable-next-line no-control-regex
      working = working.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
    }

    // 2. Trim 每行尾部空白 + 折叠空行
    if (config.collapseWhitespace) {
      working = working
        .split('\n')
        .map(line => line.replace(/[ \t]+$/, ''))
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
    }

    // 3. 章节去重：仅当内容含 search_knowledge 风格的 `---` 分隔符
    //    完全相同的章节（header + source_anchor + body）只保留首次
    if (config.dedupeSections && working.includes('\n---\n')) {
      const sections = working.split(/\n\n---\n\n/)
      if (sections.length >= 2) {
        const seen = new Set<string>()
        const out: string[] = []
        for (const sec of sections) {
          const normalized = sec.trim()
          // 太短的章节不去重（避免 header-only / 错误信息被误吃）
          if (normalized.length < 100) {
            out.push(sec)
            continue
          }
          const hash = crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 16)
          if (seen.has(hash)) {
            droppedSections++
            continue
          }
          seen.add(hash)
          out.push(sec)
        }
        working = out.join('\n\n---\n\n')
      }
    }
  } catch (err) {
    // 红线：任何异常都降级为原文（绝不让压缩器破坏工具输出）
    console.warn('[tool-result-compressor] 压缩失败，降级为原文:', err instanceof Error ? err.message : String(err))
    return { content, originalChars, finalChars: originalChars, droppedSections: 0 }
  }

  return {
    content: working,
    originalChars,
    finalChars: working.length,
    droppedSections,
  }
}
