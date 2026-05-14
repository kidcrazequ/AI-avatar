/**
 * AuditTrail：把 Hook 触发、LLM 调用、工具调用串成结构化 JSONL，落盘到
 * <auditDir>/<YYYY-MM-DD>.jsonl。写入异步、非阻塞；轮转按日切片。
 *
 * 借鉴 PAP `pap/governance/audit_trail.py`。
 */

import fs from 'fs'
import path from 'path'
import { HookPoint } from './hooks/points'

export interface AuditEvent {
  ts: string
  point: HookPoint | 'llm_call' | 'tool_call' | 'decision'
  agentId?: string
  sessionId?: string
  payload: Record<string, unknown>
}

export interface AuditTrailOptions {
  /** 目录绝对路径；不存在时自动创建 */
  auditDir: string
  /** 失败回调；用于上层报警，默认 console.error */
  onWriteError?: (err: unknown) => void
}

export class AuditTrail {
  private dir: string
  private onWriteError: (err: unknown) => void
  /** 简单 fire-and-forget 队列（不做 backpressure，桌面端单进程足够） */
  private queue: Promise<void> = Promise.resolve()

  constructor(opts: AuditTrailOptions) {
    this.dir = opts.auditDir
    this.onWriteError = opts.onWriteError ?? ((err) => console.error('[audit] write failed:', err))
    try {
      if (!fs.existsSync(this.dir)) fs.mkdirSync(this.dir, { recursive: true })
    } catch (err) {
      this.onWriteError(err)
    }
  }

  /** 记录一个事件；不抛异常，错误走 onWriteError */
  record(event: Omit<AuditEvent, 'ts'> & { ts?: string }): void {
    const ts = event.ts ?? new Date().toISOString()
    const filename = `${ts.slice(0, 10)}.jsonl`
    const filepath = path.join(this.dir, filename)
    const line = JSON.stringify({ ...event, ts }) + '\n'
    this.queue = this.queue.then(
      () =>
        new Promise<void>((resolve) => {
          fs.appendFile(filepath, line, (err) => {
            if (err) this.onWriteError(err)
            resolve()
          })
        })
    )
  }

  /** 等待队列排空（用于测试 / 进程退出前 flush） */
  async flush(): Promise<void> {
    await this.queue
  }
}
