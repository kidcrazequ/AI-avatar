/**
 * Scheduled Tasks 持久层 DAO（独立模块）。
 *
 * 与 DatabaseManager 解耦：构造接 better-sqlite3 实例，方便单测注入 in-memory db。
 * 表 schema 见 database.ts 的 createBaseSchema / migrateV9ToV10：
 *   - schedules：用户定义的定时任务
 *   - schedule_runs：触发历史，UNIQUE(schedule_id, fired_at_utc) 提供幂等约束
 *
 * 命名约定：
 *   - id 用 `sched_` / `run_` 前缀 + 时间戳 + 随机串，与 createConversation 风格一致
 *   - 时间字段一律 Unix 毫秒（INTEGER），与现有 conversations / messages 一致
 *   - cron 表达式不在本模块校验（由 main 进程的 CronScheduler.scheduleCron 用 croner 解析时报错）
 *
 * @author zhi.qu
 * @date 2026-05-09
 */

import type Database from 'better-sqlite3'

/** 持久化的 schedule 行（与 DB schema 一一对应） */
export interface ScheduleRow {
  /** 唯一 ID，前缀 `sched_` */
  id: string
  /** 用户给的名称，如「每日小红书摘要」 */
  name: string
  /** 关联的分身 ID（必填） */
  avatar_id: string
  /** 二级项目 ID（与 #4 Avatar/Project 联动），默认 'default' */
  project_id: string
  /**
   * 写入对话的 conversation_id；null 表示每次触发时新建对话（推荐默认）。
   * 非 null 时调用方应校验该会话仍存在，否则当作无效降级为新建。
   */
  conversation_id: string | null
  /** 标准 5 字段 cron 表达式，由 croner 解析（精度到分钟） */
  cron_expr: string
  /** IANA timezone（默认 'Asia/Shanghai'），由 croner 处理 UTC 转换 */
  timezone: string
  /** 触发时发送的用户消息 */
  prompt_text: string
  /** 0/1：是否启用调度 */
  enabled: 0 | 1
  /**
   * 下次预计触发的 Unix ms（创建/更新时由 cron-scheduler 调用 setNextRunAt 写入）。
   * 仅作 UI 展示与冷启动 missed 推断用，运行时仍以 croner 实时计算为准。
   */
  next_run_at: number | null
  created_at: number
  updated_at: number
}

/** 触发状态机：running → success/failed；单独路径：missed（错过未补跑） */
export type RunStatus = 'running' | 'success' | 'failed' | 'missed'

/** 触发历史行 */
export interface ScheduleRunRow {
  id: number
  schedule_id: string
  /** 触发时刻 Unix ms（幂等键的一半） */
  fired_at_utc: number
  status: RunStatus
  /** 实际写入/新建的对话 ID（成功且新建时填，失败可空） */
  conversation_id: string | null
  /** 端到端耗时 ms（从 trigger-now 到 sendMessage 完成） */
  duration_ms: number | null
  /** 失败时记录错误消息，前 500 字截断 */
  error_message: string | null
  created_at: number
}

/** 创建 schedule 的入参（id / 时间戳由 store 自动生成） */
export interface NewScheduleInput {
  name: string
  avatarId: string
  projectId?: string
  conversationId?: string | null
  cronExpr: string
  timezone?: string
  promptText: string
  enabled?: boolean
}

/** 更新 schedule 的可选字段（不传则不动） */
export interface UpdateScheduleInput {
  name?: string
  avatarId?: string
  projectId?: string
  conversationId?: string | null
  cronExpr?: string
  timezone?: string
  promptText?: string
  enabled?: boolean
}

/** ID 前缀（与 createConversation 同风格） */
function newScheduleId(): string {
  return `sched_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`
}

/** 错误消息截断，避免单行 JSON 失控 */
function truncateError(msg: string | undefined, max = 500): string | null {
  if (!msg) return null
  return msg.length > max ? msg.slice(0, max) + '…' : msg
}

/**
 * Scheduled Tasks DAO。
 *
 * 单实例由 main.ts 在 DatabaseManager 初始化后构造（见 #11 §4.10 子任务 3）。
 * 所有方法都是同步（better-sqlite3 风格）；调用方负责异步包装。
 */
export class ScheduleStore {
  constructor(private readonly db: Database.Database) {}

  /**
   * 创建一条 schedule。
   *
   * cron_expr 不在此处校验（保持 DAO 纯净），调用方应已通过 croner 解析过。
   *
   * @returns 创建后的完整行（含 id 与时间戳）
   */
  create(input: NewScheduleInput): ScheduleRow {
    const id = newScheduleId()
    const now = Date.now()
    const row: ScheduleRow = {
      id,
      name: input.name,
      avatar_id: input.avatarId,
      project_id: input.projectId ?? 'default',
      conversation_id: input.conversationId ?? null,
      cron_expr: input.cronExpr,
      timezone: input.timezone ?? 'Asia/Shanghai',
      prompt_text: input.promptText,
      enabled: input.enabled === false ? 0 : 1,
      next_run_at: null,
      created_at: now,
      updated_at: now,
    }
    this.db.prepare(`
      INSERT INTO schedules (
        id, name, avatar_id, project_id, conversation_id,
        cron_expr, timezone, prompt_text, enabled, next_run_at,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.id,
      row.name,
      row.avatar_id,
      row.project_id,
      row.conversation_id,
      row.cron_expr,
      row.timezone,
      row.prompt_text,
      row.enabled,
      row.next_run_at,
      row.created_at,
      row.updated_at,
    )
    return row
  }

  /**
   * 部分更新 schedule。
   * 只更新 patch 中实际提供的字段；updated_at 总是刷新。
   * 不存在的 id 静默忽略（返回 false）。
   */
  update(id: string, patch: UpdateScheduleInput): boolean {
    const existing = this.get(id)
    if (!existing) return false

    const sets: string[] = []
    const values: Array<string | number | null> = []

    if (patch.name !== undefined) {
      sets.push('name = ?')
      values.push(patch.name)
    }
    if (patch.avatarId !== undefined) {
      sets.push('avatar_id = ?')
      values.push(patch.avatarId)
    }
    if (patch.projectId !== undefined) {
      sets.push('project_id = ?')
      values.push(patch.projectId)
    }
    if (patch.conversationId !== undefined) {
      sets.push('conversation_id = ?')
      values.push(patch.conversationId)
    }
    if (patch.cronExpr !== undefined) {
      sets.push('cron_expr = ?')
      values.push(patch.cronExpr)
    }
    if (patch.timezone !== undefined) {
      sets.push('timezone = ?')
      values.push(patch.timezone)
    }
    if (patch.promptText !== undefined) {
      sets.push('prompt_text = ?')
      values.push(patch.promptText)
    }
    if (patch.enabled !== undefined) {
      sets.push('enabled = ?')
      values.push(patch.enabled ? 1 : 0)
    }
    sets.push('updated_at = ?')
    values.push(Date.now())
    values.push(id)

    this.db.prepare(`
      UPDATE schedules SET ${sets.join(', ')} WHERE id = ?
    `).run(...values)
    return true
  }

  /**
   * 删除 schedule。FOREIGN KEY ON DELETE CASCADE 会自动清理 schedule_runs。
   * 返回删除是否真的发生（ID 不存在返回 false）。
   */
  delete(id: string): boolean {
    const result = this.db.prepare(`DELETE FROM schedules WHERE id = ?`).run(id)
    return result.changes > 0
  }

  /** 按 ID 查 schedule，不存在返回 undefined */
  get(id: string): ScheduleRow | undefined {
    return this.db.prepare(`
      SELECT * FROM schedules WHERE id = ?
    `).get(id) as ScheduleRow | undefined
  }

  /** 列出所有 schedules，按创建时间倒序 */
  list(filter?: { avatarId?: string; enabledOnly?: boolean }): ScheduleRow[] {
    const where: string[] = []
    const params: Array<string | number> = []
    if (filter?.avatarId) {
      where.push('avatar_id = ?')
      params.push(filter.avatarId)
    }
    if (filter?.enabledOnly) {
      where.push('enabled = 1')
    }
    const sql = `
      SELECT * FROM schedules
      ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY created_at DESC
    `
    return this.db.prepare(sql).all(...params) as ScheduleRow[]
  }

  /** 冷启动恢复用：列出所有 enabled 的 schedules */
  listEnabled(): ScheduleRow[] {
    return this.list({ enabledOnly: true })
  }

  /** 由 cron-scheduler 在每次重新计算下次触发时间后写回 */
  setNextRunAt(id: string, ts: number | null): void {
    this.db.prepare(`
      UPDATE schedules SET next_run_at = ?, updated_at = ? WHERE id = ?
    `).run(ts, Date.now(), id)
  }

  /**
   * 触发开始时调用，先尝试写入一条 status='running' 的 run 记录。
   *
   * 利用 UNIQUE(schedule_id, fired_at_utc) 实现幂等：
   *   - 首次触发：插入成功，返回 { runId, conflict: false }
   *   - 同一时刻被重复触发（如 trigger-now 与 cron 撞车）：唯一索引冲突，
   *     返回 { runId: null, conflict: true }，调用方应跳过实际 sendMessage
   *
   * 不抛异常（除非 DB 自身 IO 错），便于调用方写直白代码。
   */
  recordRunStart(scheduleId: string, firedAtUtc: number): { runId: number | null; conflict: boolean } {
    try {
      const result = this.db.prepare(`
        INSERT INTO schedule_runs (
          schedule_id, fired_at_utc, status, created_at
        ) VALUES (?, ?, 'running', ?)
      `).run(scheduleId, firedAtUtc, Date.now())
      return { runId: Number(result.lastInsertRowid), conflict: false }
    } catch (err) {
      // SQLITE_CONSTRAINT_UNIQUE：同一 (schedule_id, fired_at_utc) 已存在
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('UNIQUE') || msg.includes('constraint')) {
        return { runId: null, conflict: true }
      }
      throw err
    }
  }

  /**
   * 触发结束时调用，更新已有 run 行的 status / conversation_id / duration_ms / error_message。
   * runId 不存在时静默忽略（返回 false）。
   */
  recordRunFinish(
    runId: number,
    status: Exclude<RunStatus, 'running'>,
    opts?: { conversationId?: string | null; durationMs?: number; errorMessage?: string },
  ): boolean {
    const result = this.db.prepare(`
      UPDATE schedule_runs
         SET status = ?,
             conversation_id = ?,
             duration_ms = ?,
             error_message = ?
       WHERE id = ?
    `).run(
      status,
      opts?.conversationId ?? null,
      opts?.durationMs ?? null,
      truncateError(opts?.errorMessage),
      runId,
    )
    return result.changes > 0
  }

  /**
   * 直接记录一条 missed run（用于冷启动恢复时发现 next_run_at 已过期的旧任务）。
   * 仍受 UNIQUE 约束保护：若已有相同 (scheduleId, firedAtUtc) 行则不重复写。
   */
  recordMissed(scheduleId: string, firedAtUtc: number): boolean {
    try {
      this.db.prepare(`
        INSERT INTO schedule_runs (
          schedule_id, fired_at_utc, status, created_at
        ) VALUES (?, ?, 'missed', ?)
      `).run(scheduleId, firedAtUtc, Date.now())
      return true
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('UNIQUE') || msg.includes('constraint')) {
        return false
      }
      throw err
    }
  }

  /** 列出某 schedule 的触发历史，按时间倒序，最多 limit 条 */
  listRuns(scheduleId: string, limit = 100): ScheduleRunRow[] {
    return this.db.prepare(`
      SELECT * FROM schedule_runs
       WHERE schedule_id = ?
       ORDER BY fired_at_utc DESC
       LIMIT ?
    `).all(scheduleId, limit) as ScheduleRunRow[]
  }

  /** 调试 / 测试用：统计某 schedule 各状态 run 数量 */
  countRunsByStatus(scheduleId: string): Record<RunStatus, number> {
    const rows = this.db.prepare(`
      SELECT status, COUNT(*) AS n
        FROM schedule_runs
       WHERE schedule_id = ?
       GROUP BY status
    `).all(scheduleId) as Array<{ status: RunStatus; n: number }>
    const result: Record<RunStatus, number> = { running: 0, success: 0, failed: 0, missed: 0 }
    for (const r of rows) result[r.status] = r.n
    return result
  }
}
