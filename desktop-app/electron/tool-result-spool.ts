/**
 * ToolResultSpool — 大工具返回值落盘器（Stage 三 P2 #15）。
 *
 * 问题：query_excel / search_knowledge 等工具偶尔返回数万字符 JSON，
 *      持续累积到 LLM context 会撑爆 prefill 预算（DeepSeek 64K 上限）。
 *
 * 方案：超过 SPOOL_THRESHOLD 的结果自动落盘到
 *      <userDataDir>/tool-results/<conversationId>/<toolName>-<ts>.txt，
 *      返回给 LLM 的 content 改为「头部摘要 + 尾部摘要 + 完整路径提示」，
 *      LLM 后续可用 read_file 拉取全文（按需取片段）。
 *
 * 设计要点：
 *   - 阈值默认 12000 字符，可通过构造参数覆盖（测试用）
 *   - 落盘路径含 conversationId 子目录，便于按对话清理
 *   - 启动时清理 7 天前的目录，防止磁盘膨胀
 *   - assertSafeSegment 防路径穿越（来自渲染进程的 conversationId / toolName）
 *   - 同步写入 + 同步 mkdir，符合 Electron 主进程惯例（不阻塞渲染）
 *
 * @author zhi.qu
 * @date 2026-04-29
 */

import fs from 'fs'
import path from 'path'
import { assertSafeSegment } from '@soul/core'

/** 默认阈值：超过此长度才落盘（字符数） */
const DEFAULT_SPOOL_THRESHOLD = 12_000
/** 头部保留字符数（让 LLM 看到结构开头） */
const DEFAULT_HEAD_CHARS = 3000
/** 尾部保留字符数（让 LLM 看到 totals/汇总行） */
const DEFAULT_TAIL_CHARS = 1000
/** 清理多少天前的 spool 文件 */
const DEFAULT_RETENTION_DAYS = 7

export interface SpoolOptions {
  /** 落盘阈值（字符）。<=0 表示禁用 spool。默认 12000 */
  threshold?: number
  /** 头部保留字符数 */
  headChars?: number
  /** 尾部保留字符数 */
  tailChars?: number
}

export interface SpoolResult {
  /** 是否触发落盘 */
  spilled: boolean
  /** 实际给 LLM 的 content（小结果原样、大结果为头尾摘要 + 路径提示） */
  content: string
  /** 落盘后的绝对路径（spilled=false 时为 undefined） */
  path?: string
  /** 原始内容字符数（便于审计） */
  originalLength: number
}

export class ToolResultSpool {
  private readonly rootDir: string
  private readonly threshold: number
  private readonly headChars: number
  private readonly tailChars: number

  constructor(userDataDir: string, opts: SpoolOptions = {}) {
    this.rootDir = path.join(userDataDir, 'tool-results')
    this.threshold = opts.threshold ?? DEFAULT_SPOOL_THRESHOLD
    this.headChars = opts.headChars ?? DEFAULT_HEAD_CHARS
    this.tailChars = opts.tailChars ?? DEFAULT_TAIL_CHARS
    this.ensureRoot()
  }

  /** 落盘根目录（供查看 / 测试断言用） */
  getRootDir(): string {
    return this.rootDir
  }

  /**
   * 处理一次工具返回：
   *   - 长度 ≤ threshold → 原样返回，不落盘
   *   - 长度 > threshold → 写文件 + content 改为「头 + [...spilled...] + 尾 + 路径提示」
   *
   * 失败兜底：写文件异常时退回到原内容截断（不阻断主链路）。
   */
  spool(conversationId: string, toolName: string, content: string): SpoolResult {
    const originalLength = content.length
    if (this.threshold <= 0 || originalLength <= this.threshold) {
      return { spilled: false, content, originalLength }
    }
    try {
      assertSafeSegment(conversationId, '会话ID')
      const safeName = this.sanitizeToolName(toolName)
      const dir = path.join(this.rootDir, conversationId)
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      const file = path.join(dir, `${safeName}-${Date.now()}.txt`)
      fs.writeFileSync(file, content, 'utf-8')

      const head = content.slice(0, this.headChars)
      const tail = content.slice(-this.tailChars)
      const summary = [
        head,
        '',
        `[... 中段已省略，原始内容 ${originalLength} 字符 ...]`,
        '',
        tail,
        '',
        `[系统提示] 工具 ${toolName} 返回过长，完整内容已落盘到：`,
        `  ${file}`,
        ``,
        `如需查看中段或完整结构，调用 \`read_tool_result\` 工具：`,
        `  read_tool_result(path="${file}")`,
        ``,
        `⚠️ **工具名警示**：`,
        `- 正确：\`read_tool_result\`（**result**，读 spool 文件）`,
        `- 错误：\`read_tool_ref\`（**ref**，只用于 web_fetch lazy_ref，本场景无效）`,
        `- 错误：\`read_lines\` / \`read_file\`（路径不在工作区，会被路径穿越守卫拒绝）`,
        `两个工具名几乎一样但功能完全不同，注意尾部是 result 不是 ref。`,
        ``,
        `否则请基于以上头/尾摘要直接收敛回答，不要调任何工具读这个 spool 文件——头/尾摘要 + reasoning 通常已经够答题。`,
      ].join('\n')

      return { spilled: true, content: summary, path: file, originalLength }
    } catch (err) {
      // 落盘失败的兜底：返回头部截断 + 错误提示，绝不抛主链路
      const fallback = content.slice(0, this.headChars + this.tailChars)
      const note = `\n\n[系统提示] 工具结果过长（${originalLength} 字符）但落盘失败：${err instanceof Error ? err.message : String(err)}。已截断为头部 ${fallback.length} 字符。`
      return { spilled: false, content: fallback + note, originalLength }
    }
  }

  /**
   * 清理 olderThanDays 天前的 spool 文件 / 子目录。
   *
   * 在 Electron app.whenReady() 启动时调一次即可：
   *   const spool = new ToolResultSpool(app.getPath('userData'))
   *   spool.cleanup()
   *
   * 失败仅 console.warn（清理失败不影响业务）。
   */
  cleanup(olderThanDays = DEFAULT_RETENTION_DAYS): { removedFiles: number; removedDirs: number } {
    let removedFiles = 0
    let removedDirs = 0
    try {
      if (!fs.existsSync(this.rootDir)) return { removedFiles, removedDirs }
      const cutoff = Date.now() - olderThanDays * 24 * 60 * 60 * 1000
      const convDirs = fs.readdirSync(this.rootDir, { withFileTypes: true })
      for (const cd of convDirs) {
        if (!cd.isDirectory()) continue
        const dirPath = path.join(this.rootDir, cd.name)
        const files = fs.readdirSync(dirPath)
        for (const f of files) {
          const fp = path.join(dirPath, f)
          try {
            const stat = fs.statSync(fp)
            if (stat.mtimeMs < cutoff) {
              fs.unlinkSync(fp)
              removedFiles++
            }
          } catch (e) {
            void e
          }
        }
        // 空目录直接删
        try {
          if (fs.readdirSync(dirPath).length === 0) {
            fs.rmdirSync(dirPath)
            removedDirs++
          }
        } catch (e) {
          void e
        }
      }
    } catch (err) {
      console.warn('[ToolResultSpool] cleanup 失败:', err instanceof Error ? err.message : String(err))
    }
    return { removedFiles, removedDirs }
  }

  /**
   * 列出某会话所有 spool 文件（按 mtime 倒序），供 UI 查看入口使用。
   */
  listForConversation(conversationId: string): Array<{ file: string; size: number; mtime: number }> {
    try {
      assertSafeSegment(conversationId, '会话ID')
      const dir = path.join(this.rootDir, conversationId)
      if (!fs.existsSync(dir)) return []
      return fs.readdirSync(dir)
        .map((f) => {
          const fp = path.join(dir, f)
          const stat = fs.statSync(fp)
          return { file: fp, size: stat.size, mtime: stat.mtimeMs }
        })
        .sort((a, b) => b.mtime - a.mtime)
    } catch {
      return []
    }
  }

  // ─── 内部工具 ────────────────────────────────────────────────────────────

  private ensureRoot(): void {
    if (!fs.existsSync(this.rootDir)) fs.mkdirSync(this.rootDir, { recursive: true })
  }

  /**
   * 工具名清洗：仅保留 [a-zA-Z0-9_-]，其他字符替换为 _，长度截断 64。
   *
   * tool name 由 LLM 生成，理论上只允许 snake_case；但为了防御 prompt-injection，
   * 仍按白名单过滤一次再用作文件名。
   */
  private sanitizeToolName(toolName: string): string {
    const cleaned = toolName.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64)
    return cleaned || 'unknown_tool'
  }
}

/** read_tool_result 单次返回体字节硬上限（含超长单行防护） */
export const DEFAULT_SPOOL_MAX_BODY_BYTES = 1_000_000
/** read_tool_result 单次最多返回行数减一（4000 行上限，含起始行） */
export const DEFAULT_SPOOL_HARD_LINE_CAP = 3999

export interface SpoolLineRangeOptions {
  /** 返回体字节硬上限，默认 1MB */
  maxBodyBytes?: number
  /** 起始行之后最多再返回多少行（4000 行上限），默认 3999 */
  hardLineCap?: number
}

export interface SpoolLineRangeResult {
  /** 渲染后的 "lineNo|content" 行，已 join('\n') */
  body: string
  /** 自然 EOF 时为真实总行数；提前停止时为已返回到的行号（>= startLine） */
  lastLine: number
  /** 实际返回到的行号 */
  cappedEnd: number
  /** 区间之后仍有内容 / 因行数或字节上限被截断 */
  truncated: boolean
  /** 因字节上限截断（含单行超长截断） */
  byteCapped: boolean
}

/**
 * 流式按行读取 spool 文件 [startLine, requestedEnd] 区间，O(1) 内存。
 *
 * - 逐 chunk 扫描换行字节：区间外的行只数行号、不缓存内容；
 * - 区间内的行收集内容，但「已提交字节 + 当前行字节」一旦触及 maxBodyBytes 立即在行中截断并停止，
 *   因此即便整个文件是一行超大 minified JSON，也只会把前 ~1MB 读进内存，不会整体加载；
 * - 行号超过 startLine + hardLineCap 时停止（4000 行硬上限）。
 *
 * 为什么不用 readline：readline 以「整行」为最小单位触发 line 事件，单行超大时会先把整行
 * 缓存进内存，字节上限来不及保护——正是本函数要解决的 OOM 场景。
 */
export async function readSpoolLineRange(
  filePath: string,
  startLine: number,
  requestedEnd: number,
  opts: SpoolLineRangeOptions = {},
): Promise<SpoolLineRangeResult> {
  const maxBodyBytes = opts.maxBodyBytes ?? DEFAULT_SPOOL_MAX_BODY_BYTES
  const hardLineCap = opts.hardLineCap ?? DEFAULT_SPOOL_HARD_LINE_CAP
  const collectEnd = Math.min(requestedEnd, startLine + hardLineCap)
  const NL = 0x0a // '\n'

  return await new Promise<SpoolLineRangeResult>((resolve, reject) => {
    const stream = fs.createReadStream(filePath)
    const parts: string[] = []
    let lineNo = 1 // 正在构建的行号
    let lineStarted = false // 当前（未被换行终结的）行是否已消费过字节
    let bodyBytes = 0 // 已提交行的字节合计（含行号前缀与换行符）
    let byteCapped = false
    let finished = false
    let settled = false

    let curChunks: Buffer[] = []
    let curLen = 0
    let curDropped = false // 当前行因预算耗尽丢弃了尾部

    const inRange = (no: number): boolean => no >= startLine && no <= collectEnd

    const commitLine = (): void => {
      if (inRange(lineNo)) {
        const content = Buffer.concat(curChunks, curLen).toString('utf-8')
        const rendered = `${lineNo}|${content}`
        parts.push(rendered)
        bodyBytes += Buffer.byteLength(rendered) + 1
        if (curDropped) byteCapped = true
      }
      curChunks = []
      curLen = 0
      curDropped = false
    }

    const settle = (lastLine: number): void => {
      if (settled) return
      settled = true
      const cappedEnd = Math.min(collectEnd, lastLine)
      resolve({
        body: parts.join('\n'),
        lastLine,
        cappedEnd,
        // 仅当内容被字节上限截断、或实际返回行号没到达请求的 requestedEnd（4000 行硬上限 / EOF）
        // 才算 truncated；拿到完整请求区间即使文件后面还有行也不算截断（与旧行为一致）。
        truncated: byteCapped || cappedEnd < requestedEnd,
        byteCapped,
      })
    }

    const stop = (lastLine: number): void => {
      finished = true
      stream.destroy()
      settle(lastLine)
    }

    stream.on('data', (chunk: Buffer) => {
      if (finished) return
      let i = 0
      while (i < chunk.length) {
        const nl = chunk.indexOf(NL, i)
        const segEnd = nl === -1 ? chunk.length : nl
        const segLen = segEnd - i
        if (segLen > 0) lineStarted = true
        if (inRange(lineNo) && !curDropped && segLen > 0) {
          const remaining = maxBodyBytes - (bodyBytes + curLen)
          const take = Math.max(0, Math.min(segLen, remaining))
          if (take > 0) {
            curChunks.push(Buffer.from(chunk.subarray(i, i + take)))
            curLen += take
          }
          if (take < segLen) {
            // 预算耗尽于行中：提交已收集的部分并立即停止，避免继续把超大行剩余字节读进来
            curDropped = true
            commitLine()
            stop(lineNo)
            return
          }
        }
        if (nl === -1) break // 本 chunk 用尽、行未结束 → 等下个 chunk
        commitLine()
        lineNo++
        lineStarted = false
        i = nl + 1
        if (lineNo > collectEnd) {
          // 越过请求区间末尾即停（不算截断；是否截断由 cappedEnd<requestedEnd 在 settle 判断）
          stop(lineNo - 1)
          return
        }
        if (bodyBytes >= maxBodyBytes) {
          byteCapped = true
          stop(lineNo - 1)
          return
        }
      }
    })

    stream.on('end', () => {
      if (finished) return
      // 自然 EOF：补提交最后一行（无尾随换行的内容）；文件以 \n 结尾时 lineStarted=false，不多算一行
      if (lineStarted) {
        commitLine()
        settle(lineNo)
      } else {
        settle(lineNo - 1)
      }
    })
    stream.on('error', (err) => {
      if (settled) return
      settled = true
      reject(err)
    })
  })
}
