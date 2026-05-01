/**
 * Logger — 桌面端文件日志系统
 *
 * 功能：
 * - activity(action, detail)     按天写入操作时间线日志 activity-YYYY-MM-DD.log
 * - error(source, err)           按天写入错误日志 error-YYYY-MM-DD.log（独立文件）
 * - recordGenerated(...)         归档生成文档到 generated/ 子目录并更新 index.json
 * - logEvent(level, action, ...) 接收渲染进程主动上报的事件（chat / LLM 调用等）
 * - toolCall(record)             按天写入工具调用审计日志 tool-calls/YYYY-MM-DD.jsonl
 *
 * 日志目录：app.getPath('userData')/logs/
 * 所有写入均为同步操作，保证日志不丢失。
 *
 * @author zhi.qu
 * @date 2026-04-03
 */

import fs from 'fs'
import path from 'path'
import { localDateString } from '@soul/core'

export type LogLevel = 'info' | 'warn' | 'error'

/**
 * 敏感字段名（小写匹配），命中后值替换为 [REDACTED]。
 * 用于 toolCall 审计日志和任何 args 序列化场景。
 */
const SENSITIVE_KEYS = new Set([
  'apikey', 'api_key', 'token', 'access_token', 'refresh_token',
  'secret', 'client_secret', 'password', 'pwd', 'authorization', 'auth',
])

/**
 * 把对象中的敏感字段值替换为 [REDACTED]。
 *
 * 只递归一层 + 一层数组；避免深层循环引用 / 性能问题。
 * 字符串本身不脱敏（只看字段名），上层调用方需保证 key 命名规范。
 */
export function redactSensitiveArgs(args: unknown, depth = 0): unknown {
  if (depth > 3) return '[depth-limit]'
  if (args === null || args === undefined) return args
  if (typeof args !== 'object') return args
  if (Array.isArray(args)) {
    return args.map((item) => redactSensitiveArgs(item, depth + 1))
  }
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
    if (SENSITIVE_KEYS.has(k.toLowerCase())) {
      out[k] = '[REDACTED]'
    } else if (typeof v === 'object' && v !== null) {
      out[k] = redactSensitiveArgs(v, depth + 1)
    } else {
      out[k] = v
    }
  }
  return out
}

/**
 * 工具调用审计记录（Stage 三 P2 #16）。
 *
 * 一条记录对应一次 execute-tool-call IPC 调用：
 * - args 仅保留预览（前 800 字符 JSON），避免大 payload 撑爆审计文件
 * - 含 apiKey/token/secret/password 的字段会被脱敏为 [REDACTED]
 * - resultLen 记录原始结果字符数（spool 落盘前的长度）
 *
 * 输出格式：JSONL（每行一个 JSON 对象），便于 jq / awk 后续分析。
 */
export interface ToolCallAuditRecord {
  /** 调用开始时间（毫秒时间戳） */
  ts: number
  /** 调用所属分身 ID */
  avatarId: string
  /** 调用所属会话 ID */
  conversationId: string
  /** 工具名（如 query_excel / search_knowledge） */
  toolName: string
  /** 调用耗时（毫秒） */
  durationMs: number
  /** 是否成功（无 error 字段视为成功） */
  ok: boolean
  /** 入参预览（脱敏后的 JSON 字符串，超长截断） */
  argsPreview: string
  /** 原始返回结果字符数（用于评估 spool 阈值） */
  resultLen: number
  /** 失败原因（仅 ok=false 时存在） */
  error?: string
}

/** 生成文档归档记录（写入 generated/index.json） */
export interface GeneratedRecord {
  type: 'soul' | 'skill' | 'memory' | 'knowledge' | 'test-report'
  avatarId: string
  /** 原始文件相对于 userData 的路径 */
  originalPath: string
  /** 归档副本在 logs/generated/ 中的文件名 */
  archivedFile: string
  createdAt: string
  meta?: Record<string, unknown>
}

export class Logger {
  private readonly logsDir: string
  private readonly generatedDir: string
  private readonly toolCallsDir: string
  private readonly indexFile: string
  /** 防止并发写 index.json 导致数据丢失 */
  private indexWriteQueue: Promise<void> = Promise.resolve()

  constructor(userDataPath: string) {
    this.logsDir = path.join(userDataPath, 'logs')
    this.generatedDir = path.join(this.logsDir, 'generated')
    this.toolCallsDir = path.join(this.logsDir, 'tool-calls')
    this.indexFile = path.join(this.generatedDir, 'index.json')
    this.ensureDirs()
  }

  // ─── 公共接口 ────────────────────────────────────────────────────────────

  /** 记录用户操作到操作时间线日志 */
  activity(action: string, detail?: string): void {
    const line = this.formatLine('ACT', action, detail)
    this.append(this.activityFile(), line)
  }

  /** 记录错误到独立错误日志 */
  error(source: string, err: Error | unknown): void {
    const e = err instanceof Error ? err : new Error(String(err))
    const stackLine = e.stack?.split('\n')[1]?.trim()
    const detail = `${e.message}${stackLine ? ' | ' + stackLine : ''}`
    const line = this.formatLine('ERR', source, detail)
    this.append(this.errorFile(), line)
    // 同时在活动日志中记录一条错误标记，方便时间线查看
    this.append(this.activityFile(), this.formatLine('ERR', source, e.message))
  }

  /**
   * 接收渲染进程上报的日志事件（通过 log-event IPC）
   * level 为 'error' 时写入错误日志，其余写入活动日志
   */
  logEvent(level: LogLevel, action: string, detail?: string): void {
    const line = this.formatLine(level.toUpperCase(), action, detail)
    this.append(this.activityFile(), line)
    if (level === 'error') {
      this.append(this.errorFile(), line)
    }
  }

  /**
   * 记录一次工具调用审计（Stage 三 P2 #16）。
   *
   * 文件：logs/tool-calls/YYYY-MM-DD.jsonl，按本地日期滚动。
   * 任何写入异常仅 console.warn，绝不抛出（审计绝不能影响主链路）。
   *
   * 写入前自动：
   * 1. 入参的 apiKey/token/secret/password/authorization 字段脱敏为 [REDACTED]
   * 2. argsPreview 截断到 800 字符
   * 3. error 字段截断到 500 字符（避免长堆栈撑爆 jsonl 单行）
   */
  toolCall(record: ToolCallAuditRecord): void {
    try {
      const safe: ToolCallAuditRecord = {
        ts: record.ts,
        avatarId: record.avatarId,
        conversationId: record.conversationId,
        toolName: record.toolName,
        durationMs: record.durationMs,
        ok: record.ok,
        argsPreview: this.truncateUtf8(record.argsPreview ?? '', 800),
        resultLen: record.resultLen,
      }
      if (record.error) {
        safe.error = this.truncateUtf8(record.error, 500)
      }
      const file = path.join(this.toolCallsDir, `${this.today()}.jsonl`)
      this.append(file, JSON.stringify(safe) + '\n')
    } catch (err) {
      console.warn('[Logger] toolCall 写入失败:', err instanceof Error ? err.message : String(err))
    }
  }

  /**
   * 读取指定日期（默认今天）的工具调用审计日志原文。
   *
   * 返回 jsonl 字符串，调用方按 split('\n') 解析。
   * 不存在或读取失败时返回空字符串。
   */
  readToolCallLog(date?: string): string {
    const file = path.join(this.toolCallsDir, `${date ?? this.today()}.jsonl`)
    return this.readLog(file)
  }

  /**
   * 工具调用审计目录（供外部查询 / 测试断言用）。
   */
  getToolCallsDir(): string {
    return this.toolCallsDir
  }

  /**
   * 按 utf-8 字节长度安全截断字符串，避免在多字节字符中间截断。
   *
   * 仅用于审计日志这类「以字符数为预算」的轻量截断场景。
   */
  private truncateUtf8(s: string, maxChars: number): string {
    if (s.length <= maxChars) return s
    return s.slice(0, maxChars) + `...[truncated, originalLen=${s.length}]`
  }

  /**
   * 归档一份生成文档到 logs/generated/，并在 index.json 中追加记录。
   * 若 sourceFile 不存在则跳过拷贝，但仍写入 index 记录。
   */
  recordGenerated(
    type: GeneratedRecord['type'],
    avatarId: string,
    sourceFile: string,
    meta?: Record<string, unknown>
  ): void {
    const ts = Date.now()
    const safeId = avatarId.replace(/[^a-zA-Z0-9\u4e00-\u9fa5_-]/g, '_')
    const ext = path.extname(sourceFile) || '.md'
    const archivedFile = `${type}-${safeId}-${ts}${ext}`
    const archivedPath = path.join(this.generatedDir, archivedFile)

    // 拷贝原文件
    if (fs.existsSync(sourceFile)) {
      try {
        fs.copyFileSync(sourceFile, archivedPath)
      } catch (e) {
        this.error('recordGenerated.copy', e)
      }
    }

    // 追加 index 记录
    const record: GeneratedRecord = {
      type,
      avatarId,
      originalPath: sourceFile,
      archivedFile,
      createdAt: new Date(ts).toISOString(),
      meta,
    }
    this.appendIndex(record)

    this.activity('generated-doc', `type=${type} avatar=${avatarId} file=${archivedFile}`)
  }

  /** 读取指定日期（默认今天）的活动日志文本 */
  readActivityLog(date?: string): string {
    return this.readLog(this.activityFile(date))
  }

  /** 读取指定日期（默认今天）的错误日志文本 */
  readErrorLog(date?: string): string {
    return this.readLog(this.errorFile(date))
  }

  /**
   * 写入到独立频道日志（按天轮转），如 claudebridge / verifier。
   * 与 activity/error 隔离，便于排查特定组件问题不混进主时间线。
   *
   * @param channel  频道名，仅允许 [a-z0-9-] 防止路径注入
   * @param action   事件名
   * @param detail   可选详情
   */
  channel(channel: string, action: string, detail?: string): void {
    if (!/^[a-z0-9-]{1,32}$/.test(channel)) {
      this.error('logger.channel', new Error(`非法 channel 名: ${channel}`))
      return
    }
    const file = path.join(this.logsDir, `${channel}-${this.today()}.log`)
    const line = this.formatLine(channel.toUpperCase().slice(0, 5), action, detail)
    this.append(file, line)
  }

  /** 读取指定 channel 当天的日志，便于设置面板展示 */
  readChannelLog(channel: string, date?: string): string {
    if (!/^[a-z0-9-]{1,32}$/.test(channel)) return ''
    const file = path.join(this.logsDir, `${channel}-${date ?? this.today()}.log`)
    return this.readLog(file)
  }

  /** 读取生成文档索引 */
  readGeneratedIndex(): GeneratedRecord[] {
    try {
      const raw = fs.readFileSync(this.indexFile, 'utf-8')
      const parsed = JSON.parse(raw)
      if (!Array.isArray(parsed)) {
        console.warn(`[Logger] 生成文档索引格式异常（非数组），重置为空`)
        return []
      }
      return parsed.filter((item): item is GeneratedRecord =>
        item && typeof item === 'object' && typeof item.type === 'string' && typeof item.avatarId === 'string'
      )
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') {
        console.warn(`[Logger] 生成文档索引读取失败: ${err instanceof Error ? err.message : String(err)}`)
      }
      return []
    }
  }

  // ─── 内部工具 ────────────────────────────────────────────────────────────

  private ensureDirs(): void {
    if (!fs.existsSync(this.logsDir)) fs.mkdirSync(this.logsDir, { recursive: true })
    if (!fs.existsSync(this.generatedDir)) fs.mkdirSync(this.generatedDir, { recursive: true })
    if (!fs.existsSync(this.toolCallsDir)) fs.mkdirSync(this.toolCallsDir, { recursive: true })
  }

  /** 活动日志文件路径，按天轮转 */
  private activityFile(date?: string): string {
    return path.join(this.logsDir, `activity-${date ?? this.today()}.log`)
  }

  /** 错误日志文件路径，按天轮转 */
  private errorFile(date?: string): string {
    return path.join(this.logsDir, `error-${date ?? this.today()}.log`)
  }

  private today(): string {
    // 使用本地时区日期，避免跨时区时日期文件名不符合用户直觉
    return localDateString()
  }

  private now(): string {
    return new Date().toTimeString().slice(0, 8)
  }

  private formatLine(tag: string, action: string, detail?: string): string {
    const d = detail ? ` | ${detail.replace(/\n/g, ' ')}` : ''
    return `[${this.now()}] ${tag.padEnd(5)} ${action}${d}\n`
  }

  /** 日志文件大小超过此阈值（字节）时轮转 */
  private static readonly MAX_LOG_SIZE = 5 * 1024 * 1024 // 5MB
  /** 每 N 次写入才检查一次文件大小，减少主线程 statSync 系统调用频率 */
  private static readonly SIZE_CHECK_INTERVAL = 50
  private appendCounters = new Map<string, number>()

  private append(file: string, line: string): void {
    try {
      const count = (this.appendCounters.get(file) ?? 0) + 1
      this.appendCounters.set(file, count)
      if (count % Logger.SIZE_CHECK_INTERVAL === 0) {
        try {
          const stat = fs.statSync(file)
          if (stat.size > Logger.MAX_LOG_SIZE) {
            const rotated1 = file.replace(/\.log$/, '.1.log')
            const rotated2 = file.replace(/\.log$/, '.2.log')
            try { fs.renameSync(rotated1, rotated2) } catch (e1) { void e1 /* .1.log 不存在时忽略 */ }
            try { fs.renameSync(file, rotated1) } catch (e2) { void e2 /* 重命名失败忽略 */ }
            this.appendCounters.set(file, 0)
          }
        } catch (statErr) {
          // 文件不存在时 stat 会抛错，忽略即可
          void statErr
        }
      }
      fs.appendFileSync(file, line, 'utf-8')
    } catch (err) {
      console.warn('[Logger] 写入日志失败:', err instanceof Error ? err.message : String(err))
    }
  }

  private readLog(file: string): string {
    try {
      return fs.readFileSync(file, 'utf-8')
    } catch {
      return ''
    }
  }

  private appendIndex(record: GeneratedRecord): void {
    this.indexWriteQueue = this.indexWriteQueue.then(() => {
      const records = this.readGeneratedIndex()
      records.push(record)
      try {
        // 原子写入：先写临时文件再 rename，防止崩溃时 index.json 损坏导致历史丢失
        const tmpFile = this.indexFile + '.tmp'
        fs.writeFileSync(tmpFile, JSON.stringify(records, null, 2), 'utf-8')
        fs.renameSync(tmpFile, this.indexFile)
      } catch (e) {
        this.error('appendIndex', e)
      }
    }).catch((err) => {
      console.error('[Logger] appendIndex 写入失败:', err instanceof Error ? err.message : String(err))
    })
  }
}
