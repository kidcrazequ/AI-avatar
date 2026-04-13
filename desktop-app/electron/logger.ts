/**
 * Logger — 桌面端文件日志系统
 *
 * 功能：
 * - activity(action, detail)     按天写入操作时间线日志 activity-YYYY-MM-DD.log
 * - error(source, err)           按天写入错误日志 error-YYYY-MM-DD.log（独立文件）
 * - recordGenerated(...)         归档生成文档到 generated/ 子目录并更新 index.json
 * - logEvent(level, action, ...) 接收渲染进程主动上报的事件（chat / LLM 调用等）
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
  private readonly indexFile: string
  /** 防止并发写 index.json 导致数据丢失 */
  private indexWriteQueue: Promise<void> = Promise.resolve()

  constructor(userDataPath: string) {
    this.logsDir = path.join(userDataPath, 'logs')
    this.generatedDir = path.join(this.logsDir, 'generated')
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
