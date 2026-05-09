/**
 * knowledge-inspect.ts — 知识库 chunk 检查 CLI（只读）
 *
 * 0.5 天的轻量诊断工具：消费 KnowledgeRetriever 的公开 API，列出某个分身知识库
 * 经 buildChunks 切分后的所有 chunk（file / heading / 字符数 / 预览），并汇总
 * 二次切分 / 超长 chunk / _index 元数据齐备情况，帮助排查检索召回质量问题。
 *
 * 设计边界（绝对不跨）：
 *   - 只读：不修改任何 .md / _index/* / chunking 主逻辑
 *   - 零依赖：仅用 Node.js 内建 + 项目已有 @soul/core，不引入彩色输出/参数解析库
 *   - 同步路径：用 getFullChunks（同步 buildChunks），不用 warmUpAsync（异步路径行为不同）
 *   - 不绕 MIN_CHUNK_LENGTH=80：故意走 getFullChunks 而非 searchChunks，
 *     保证看到 KnowledgeRetriever 真实切出的所有 chunk（含会被 BM25 过滤的短 chunk）
 *
 * 用法：
 *   cd desktop-app
 *   npm run knowledge:inspect <avatar-id>                 默认：汇总 + 80 字预览
 *   npm run knowledge:inspect <avatar-id> <filter>        过滤路径含 <filter> 的文件
 *   npm run knowledge:inspect <avatar-id> -- --full       逐 chunk 完整内容
 *   npm run knowledge:inspect <avatar-id> -- --metadata   仅看 _index/*.json 齐备情况
 *
 * 退出码：
 *   0 = 成功
 *   1 = 用法错误（avatarId 缺失 / 未知 flag）
 *   2 = 路径不存在（avatars/<id>/knowledge 不存在）
 *   3 = 运行时异常（构造 retriever / 读 _index 抛错）
 *
 * @author zhi.qu
 * @date 2026-05-09
 */

import path from 'path'
import fs from 'fs'
import { KnowledgeRetriever, assertSafeSegment } from '@soul/core'

/**
 * 二次切分阈值 — 与 packages/core/src/knowledge-retriever.ts:25-27
 * 的 CHUNK_SPLIT_THRESHOLD 保持同步。如 core 改了请同步本常量与 README。
 */
const CHUNK_SPLIT_THRESHOLD = 4000

/** 默认模式预览字符数上限 */
const PREVIEW_MAX_CHARS = 80

/** heading 列在默认模式下的目标显示宽度（超出截断） */
const HEADING_DISPLAY_WIDTH = 50

/** _index/ 下需要检查的 4 个 json 文件（顺序固定，便于对照阅读） */
const INDEX_FILES = ['contexts.json', 'embeddings.json', 'hashes.json', 'tokens.json'] as const

/** 解析后的命令行参数 */
interface ParsedArgs {
  avatarId: string
  filter: string | null
  full: boolean
  metadataOnly: boolean
}

/** 用法帮助文本（avatarId 缺失或显式 --help 时打印） */
function printUsage(): void {
  console.error('用法:')
  console.error('  npm run knowledge:inspect <avatar-id>                 默认：汇总 + 80 字预览')
  console.error('  npm run knowledge:inspect <avatar-id> <filter>        只看路径含 <filter> 的文件')
  console.error('  npm run knowledge:inspect <avatar-id> -- --full       逐 chunk 完整内容')
  console.error('  npm run knowledge:inspect <avatar-id> -- --metadata   仅看 _index/*.json 齐备情况')
  console.error('')
  console.error('例:')
  console.error('  npm run knowledge:inspect 小堵-工商储专家')
  console.error('  npm run knowledge:inspect 小堵-工商储专家 cbsa')
  console.error('  npm run knowledge:inspect 小堵-工商储专家 -- --full')
  console.error('  npm run knowledge:inspect 小堵-工商储专家 -- --metadata')
}

/**
 * 手写 argv 解析：避免引入 commander / yargs 等依赖。
 * 规则：
 *   - 第一个非 -- 开头的位置参数 = avatarId
 *   - 第二个非 -- 开头的位置参数 = filter
 *   - --full / --metadata 为 boolean flag
 *   - --help / -h 显示用法（视为用法错误退出 1，便于脚本检测）
 *   - 其它未知 flag 报错退出 1
 */
function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = []
  let full = false
  let metadataOnly = false

  for (const arg of argv) {
    if (arg === '--full') {
      full = true
    } else if (arg === '--metadata') {
      metadataOnly = true
    } else if (arg === '--help' || arg === '-h') {
      printUsage()
      process.exit(1)
    } else if (arg.startsWith('--')) {
      console.error(`[knowledge-inspect] 未知参数: ${arg}`)
      printUsage()
      process.exit(1)
    } else {
      positional.push(arg)
    }
  }

  const avatarId = positional[0]
  const filter = positional[1] ?? null

  if (!avatarId) {
    console.error('[knowledge-inspect] 缺少 avatar-id')
    printUsage()
    process.exit(1)
  }

  return { avatarId, filter, full, metadataOnly }
}

/**
 * 生成 chunk 内容的紧凑预览：去换行、压空白、截断到 PREVIEW_MAX_CHARS。
 */
function makePreview(content: string): string {
  const flat = content.replace(/\s+/g, ' ').trim()
  if (flat.length <= PREVIEW_MAX_CHARS) return flat
  return flat.slice(0, PREVIEW_MAX_CHARS) + '…'
}

/**
 * 处理 CJK 全宽字符的字符串截断 / padEnd 是按 code point 数对齐，
 * 视觉上仍可能错位，本工具仅追求"字段间至少 2 空格、肉眼能扫"。
 */
function padDisplay(s: string, width: number): string {
  if (s.length >= width) return s
  return s + ' '.repeat(width - s.length)
}

/** 千分位逗号分隔的数字字符串 */
function formatNumber(n: number): string {
  return n.toLocaleString('en-US')
}

/** 截断 heading 到固定宽度（超出加 …） */
function truncateHeading(heading: string, width: number): string {
  if (heading.length <= width) return heading
  return heading.slice(0, width - 1) + '…'
}

/** 二次切分检测：pushChunks 给二次切分追加全角「（n）」尾巴 */
const SPLIT_SUFFIX_RE = /（\d+）$/

/** 单个 chunk 的展示数据（默认模式） */
interface ChunkRow {
  file: string
  heading: string
  length: number
  preview: string
  isSplit: boolean
}

/**
 * 检查 _index/ 下 4 个 JSON 文件的存在性与可解析性。
 * 失败不抛异常；按文件返回状态行供打印。
 */
function inspectIndexDir(knowledgePath: string): string[] {
  const indexDir = path.join(knowledgePath, '_index')
  const lines: string[] = []
  lines.push('== 索引元数据（_index/）==')
  lines.push('')

  if (!fs.existsSync(indexDir)) {
    lines.push(`  _index/ 目录不存在: ${indexDir}`)
    return lines
  }

  for (const fname of INDEX_FILES) {
    const fpath = path.join(indexDir, fname)
    const label = padDisplay(`${fname}:`, 18)
    if (!fs.existsSync(fpath)) {
      lines.push(`  ${label} ✗ (missing)`)
      continue
    }
    let raw: string
    try {
      raw = fs.readFileSync(fpath, 'utf-8')
    } catch (err) {
      console.error(`[knowledge-inspect] 读取 ${fname} 失败: ${err instanceof Error ? err.message : String(err)}`)
      lines.push(`  ${label} ✗ [unreadable]`)
      continue
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (err) {
      console.error(`[knowledge-inspect] 解析 ${fname} 失败: ${err instanceof Error ? err.message : String(err)}`)
      lines.push(`  ${label} ✗ [damaged]`)
      continue
    }
    const entries = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? Object.keys(parsed as Record<string, unknown>).length
      : -1
    if (entries < 0) {
      lines.push(`  ${label} ✗ [unexpected shape]`)
    } else {
      lines.push(`  ${label} ✓  ${formatNumber(entries)} entries`)
    }
  }

  return lines
}

/**
 * 默认模式输出：按 file 分组列出 chunks + 汇总。
 */
function printDefault(
  rows: ChunkRow[],
  filter: string | null,
  knowledgePath: string,
): void {
  console.log('== 文件 → chunks ==')
  console.log('')

  if (rows.length === 0) {
    console.log(filter
      ? `(无 chunk 命中 filter="${filter}")`
      : '(知识库为空 / 没有 .md 文件)'
    )
    console.log('')
  } else {
    let lastFile: string | null = null
    for (const r of rows) {
      if (r.file !== lastFile) {
        console.log(r.file)
        lastFile = r.file
      }
      const headingCol = padDisplay(truncateHeading(r.heading, HEADING_DISPLAY_WIDTH), HEADING_DISPLAY_WIDTH)
      const lenCol = padDisplay(`${r.length} 字`, 10)
      const splitMark = r.isSplit ? ' [二次切分]' : ''
      console.log(`  ${headingCol}  ${lenCol}  ${r.preview}${splitMark}`)
    }
    console.log('')
  }

  // 汇总
  const fileSet = new Set<string>()
  let totalChars = 0
  let longestLen = 0
  let longestFile = ''
  let longestHeading = ''
  let splitCount = 0
  let oversizeCount = 0
  for (const r of rows) {
    fileSet.add(r.file)
    totalChars += r.length
    if (r.length > longestLen) {
      longestLen = r.length
      longestFile = r.file
      longestHeading = r.heading
    }
    if (r.isSplit) splitCount++
    if (r.length > CHUNK_SPLIT_THRESHOLD) oversizeCount++
  }
  const avgChars = rows.length === 0 ? 0 : Math.round(totalChars / rows.length)

  console.log('== 汇总 ==')
  console.log('')
  console.log(`文件数:           ${formatNumber(fileSet.size)}`)
  console.log(`chunks:           ${formatNumber(rows.length)}`)
  console.log(`字符总数:         ${formatNumber(totalChars)}`)
  console.log(`平均字符:         ${formatNumber(avgChars)}`)
  if (rows.length > 0) {
    const warn = longestLen > CHUNK_SPLIT_THRESHOLD
      ? `  [⚠️ 超过 CHUNK_SPLIT_THRESHOLD(${CHUNK_SPLIT_THRESHOLD})]`
      : ''
    console.log(`最长 chunk:       ${formatNumber(longestLen)} 字 @ ${longestFile} ${longestHeading}${warn}`)
  }
  console.log(`二次切分:         ${formatNumber(splitCount)} 个（heading 末尾含「（n）」）`)
  console.log(`超长（>${CHUNK_SPLIT_THRESHOLD}）:    ${formatNumber(oversizeCount)} 个`)
  console.log('')

  for (const line of inspectIndexDir(knowledgePath)) {
    console.log(line)
  }
}

/**
 * --full 模式输出：跳过汇总，逐 chunk 打印完整内容 + 分隔线。
 */
function printFull(rows: ChunkRow[], allChunks: Array<{ file: string; heading: string; content: string }>): void {
  if (rows.length === 0) {
    console.log('(无 chunk 命中)')
    return
  }
  // rows 与 allChunks 经同样过滤后 1:1 对应（见 main 中过滤逻辑）
  const sep = '─'.repeat(60)
  for (let i = 0; i < rows.length; i++) {
    const chunk = allChunks[i]
    console.log(sep)
    console.log(`file:    ${chunk.file}`)
    console.log(`heading: ${chunk.heading}`)
    console.log(`length:  ${chunk.content.length}`)
    console.log(sep)
    console.log(chunk.content)
    console.log('')
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))

  // 路径段安全校验：阻止 ../ / 绝对路径段等通过 avatar-id 注入
  try {
    assertSafeSegment(args.avatarId, 'avatar-id')
  } catch (err) {
    console.error(`[knowledge-inspect] 非法 avatar-id: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }

  const repoRoot = path.resolve(__dirname, '..', '..')
  const knowledgePath = path.join(repoRoot, 'avatars', args.avatarId, 'knowledge')

  console.log(`[knowledge-inspect] avatar:        ${args.avatarId}`)
  console.log(`[knowledge-inspect] knowledgePath: ${knowledgePath}`)
  console.log(`[knowledge-inspect] filter:        ${args.filter ?? '(none)'}`)

  if (!fs.existsSync(knowledgePath)) {
    console.error(`[knowledge-inspect] 知识库路径不存在: ${knowledgePath}`)
    console.error('[knowledge-inspect] 请确认 avatar-id 拼写正确，且 avatars/<id>/knowledge 目录已创建')
    process.exit(2)
  }

  // --metadata 模式：跳过 chunk 加载，只看 _index/ 状态
  if (args.metadataOnly) {
    console.log('')
    for (const line of inspectIndexDir(knowledgePath)) {
      console.log(line)
    }
    return
  }

  console.log('[knowledge-inspect] building chunks...')
  console.log('')

  const retriever = new KnowledgeRetriever(knowledgePath)
  // 故意用 getFullChunks 而非 searchChunks：避免 MIN_CHUNK_LENGTH=80 / metadata 过滤，
  // 让本工具看到 buildChunks 真实切出的全集（诊断用途，不是检索用途）
  const allChunks = retriever.getFullChunks()

  // filter：按 file 路径子串大小写不敏感匹配
  const filtered = args.filter
    ? allChunks.filter(c => c.file.toLowerCase().includes(args.filter!.toLowerCase()))
    : allChunks

  const rows: ChunkRow[] = filtered.map(c => ({
    file: c.file,
    heading: c.heading,
    length: c.content.length,
    preview: makePreview(c.content),
    isSplit: SPLIT_SUFFIX_RE.test(c.heading),
  }))

  if (args.full) {
    printFull(rows, filtered)
  } else {
    printDefault(rows, args.filter, knowledgePath)
  }
}

void main().catch((err) => {
  console.error('[knowledge-inspect] FAIL')
  console.error(err instanceof Error ? err.stack ?? err.message : String(err))
  process.exit(3)
})
