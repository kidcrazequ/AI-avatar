/**
 * SyncHistoryStore DAO for Soul WebDAV sync (#16 WebDAV cross-device sync).
 *
 * 持久化每一次 WebDAV 备份/恢复的执行结果。
 * 设计要点：
 *   - 与 DatabaseManager 解耦：构造接 better-sqlite3 实例，方便单测注入 in-memory db
 *   - 容量自动控制：record 时按 DEFAULT_RETENTION_LIMIT 自动淘汰最旧记录（默认保留最近 30 条）
 *   - 输入清洗：clamp duration / file_count / total_bytes，error_message 截断到 4000 字符
 *   - 构造期检测 sync_history 表是否存在；不存在则抛错（避免迁移未跑时调用 DAO）
 *
 * 与表结构对应见 database.ts 的 createBaseSchema / migrateV11ToV12。
 *
 * @author zhi.qu
 * @date 2026-05-09
 */

import type Database from 'better-sqlite3'

/** 同步方向：备份本地数据到 WebDAV / 从 WebDAV 恢复到本地 */
export type SyncDirection = 'backup' | 'restore'

/** 同步运行状态：进行中 / 成功 / 失败 */
export type SyncStatus = 'success' | 'failed' | 'in_progress'

/** 持久化的 sync_history 行（与 DB schema 一一对应） */
export interface SyncHistoryRow {
  /** 自增主键 */
  id: number
  direction: SyncDirection
  status: SyncStatus
  /** 本次同步涉及的文件数 */
  file_count: number
  /** 本次同步累计字节数 */
  total_bytes: number
  /** 端到端耗时（毫秒） */
  duration_ms: number
  /** 远端文件名（如 backup-20260509.zip）；不适用时为 null */
  remote_filename: string | null
  /** 失败错误信息（已截断到 4000 字符）；成功时为 null */
  error_message: string | null
  /** Unix ms */
  created_at: number
}

/** record 入参：direction / status 必填，其他字段缺省按 0 / null 处理 */
export interface NewSyncHistoryInput {
  direction: SyncDirection
  status: SyncStatus
  file_count?: number
  total_bytes?: number
  duration_ms?: number
  remote_filename?: string | null
  error_message?: string | null
  /** 自定义写入时间（测试用），缺省 Date.now() */
  created_at?: number
}

/** update 入参：仅传入字段会被更新 */
export interface UpdateSyncHistoryInput {
  status?: SyncStatus
  file_count?: number
  total_bytes?: number
  duration_ms?: number
  remote_filename?: string | null
  error_message?: string | null
}

/** 默认保留最近 30 条同步历史（约 1 个月日常使用量），超出自动淘汰 */
export const DEFAULT_RETENTION_LIMIT = 30

/** duration_ms clamp：min 0 / max 24 小时（避免错误时间戳计算导致的脏数据） */
export function clampDuration(ms: number): number {
  if (!Number.isFinite(ms)) return 0
  const v = Math.floor(ms)
  if (v < 0) return 0
  const max = 24 * 3600 * 1000
  if (v > max) return max
  return v
}

/** file_count clamp：min 0 / max 1_000_000（防御性上限，超过即视为脏数据） */
export function clampFileCount(n: number): number {
  if (!Number.isFinite(n)) return 0
  const v = Math.floor(n)
  if (v < 0) return 0
  const max = 1_000_000
  if (v > max) return max
  return v
}

/** total_bytes clamp：min 0 / max 100 GB（防 INTEGER 溢出与异常累加） */
export function clampTotalBytes(n: number): number {
  if (!Number.isFinite(n)) return 0
  const v = Math.floor(n)
  if (v < 0) return 0
  const max = 100 * 1024 * 1024 * 1024
  if (v > max) return max
  return v
}

/**
 * 截断 error_message 到最多 4000 字符，避免单行错误堆栈撑爆 SQLite 行。
 * undefined / null / 空字符串 → null（不存空字符串，便于 IS NULL 查询）。
 */
export function truncateErrorMessage(s: string | null | undefined): string | null {
  if (s === null || s === undefined) return null
  if (s.length === 0) return null
  const max = 4000
  return s.length > max ? s.slice(0, max) : s
}

/** 列表 / 计数过滤条件 */
export interface ListSyncHistoryOptions {
  /** 默认 100 */
  limit?: number
  direction?: SyncDirection
  status?: SyncStatus
}

/** count 过滤条件（不含 limit） */
export interface CountSyncHistoryOptions {
  direction?: SyncDirection
  status?: SyncStatus
}

/**
 * SyncHistoryStore DAO。
 *
 * 单实例由 main.ts 在 DatabaseManager 初始化后构造（见 #16 §4.14 子任务 5）。
 * 所有方法都是同步（better-sqlite3 风格）；调用方负责异步包装。
 */
export class SyncHistoryStore {
  constructor(private readonly db: Database.Database) {
    // 防御：迁移未跑时调用 DAO 会得到很难定位的 "no such table"。
    // 这里在构造期一次性检测，提前以清晰错误中断。
    const tableInfo = this.db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='sync_history'",
    ).get() as { name?: string } | undefined
    if (!tableInfo || tableInfo.name !== 'sync_history') {
      throw new Error('sync_history 表不存在；请确认 schema 已迁移到 v12 之后再构造 SyncHistoryStore')
    }
  }

  /**
   * 写入一条同步历史。
   *
   * - 自动 clamp duration_ms / file_count / total_bytes
   * - 自动 truncate error_message 到 4000 字符
   * - 写入后自动按 DEFAULT_RETENTION_LIMIT 淘汰最旧记录
   *
   * @returns 写入后的完整行（含自增 id）
   */
  record(input: NewSyncHistoryInput): SyncHistoryRow {
    const created_at = input.created_at ?? Date.now()
    const fileCount = clampFileCount(input.file_count ?? 0)
    const totalBytes = clampTotalBytes(input.total_bytes ?? 0)
    const durationMs = clampDuration(input.duration_ms ?? 0)
    const remoteFilename = input.remote_filename ?? null
    const errorMessage = truncateErrorMessage(input.error_message)

    const result = this.db.prepare(`
      INSERT INTO sync_history (
        direction, status, file_count, total_bytes, duration_ms,
        remote_filename, error_message, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.direction,
      input.status,
      fileCount,
      totalBytes,
      durationMs,
      remoteFilename,
      errorMessage,
      created_at,
    )

    const id = Number(result.lastInsertRowid)
    // 容量自动收敛：插入后立即按默认 limit 淘汰超额行。
    this.pruneToLimit(DEFAULT_RETENTION_LIMIT)

    const row = this.get(id)
    if (!row) {
      // 极端：刚插入的行被并发删除（或 prune 误伤），抛错以暴露问题
      throw new Error(`刚写入的 sync_history 行 ${id} 立即查询不到，可能存在并发问题`)
    }
    return row
  }

  /**
   * 部分更新一条同步历史（典型场景：先写 in_progress，运行结束后改 success/failed）。
   *
   * 仅 patch 中实际提供的字段会被写入；输入会做 clamp / truncate。
   * 不存在的 id 返回 null。
   */
  update(id: number, patch: UpdateSyncHistoryInput): SyncHistoryRow | null {
    const existing = this.get(id)
    if (!existing) return null

    const sets: string[] = []
    const values: Array<string | number | null> = []

    if (patch.status !== undefined) {
      sets.push('status = ?')
      values.push(patch.status)
    }
    if (patch.file_count !== undefined) {
      sets.push('file_count = ?')
      values.push(clampFileCount(patch.file_count))
    }
    if (patch.total_bytes !== undefined) {
      sets.push('total_bytes = ?')
      values.push(clampTotalBytes(patch.total_bytes))
    }
    if (patch.duration_ms !== undefined) {
      sets.push('duration_ms = ?')
      values.push(clampDuration(patch.duration_ms))
    }
    if (patch.remote_filename !== undefined) {
      sets.push('remote_filename = ?')
      values.push(patch.remote_filename)
    }
    if (patch.error_message !== undefined) {
      sets.push('error_message = ?')
      values.push(truncateErrorMessage(patch.error_message))
    }

    if (sets.length === 0) {
      return existing
    }
    values.push(id)
    this.db.prepare(`
      UPDATE sync_history SET ${sets.join(', ')} WHERE id = ?
    `).run(...values)
    return this.get(id)
  }

  /** 按 ID 取单条；不存在返回 null */
  get(id: number): SyncHistoryRow | null {
    const row = this.db.prepare(`
      SELECT * FROM sync_history WHERE id = ?
    `).get(id) as SyncHistoryRow | undefined
    return row ?? null
  }

  /**
   * 列出同步历史，按 created_at DESC（最新在前），可按 direction / status 过滤。
   * limit 默认 100；调用方应控制上限避免一次拉太多。
   */
  list(opts?: ListSyncHistoryOptions): SyncHistoryRow[] {
    const limit = opts?.limit ?? 100
    const where: string[] = []
    const params: Array<string | number> = []
    if (opts?.direction !== undefined) {
      where.push('direction = ?')
      params.push(opts.direction)
    }
    if (opts?.status !== undefined) {
      where.push('status = ?')
      params.push(opts.status)
    }
    const sql = `
      SELECT * FROM sync_history
      ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `
    params.push(limit)
    return this.db.prepare(sql).all(...params) as SyncHistoryRow[]
  }

  /** 计数，可按 direction / status 过滤 */
  count(opts?: CountSyncHistoryOptions): number {
    const where: string[] = []
    const params: Array<string> = []
    if (opts?.direction !== undefined) {
      where.push('direction = ?')
      params.push(opts.direction)
    }
    if (opts?.status !== undefined) {
      where.push('status = ?')
      params.push(opts.status)
    }
    const sql = `
      SELECT COUNT(*) AS n FROM sync_history
      ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
    `
    const row = this.db.prepare(sql).get(...params) as { n: number }
    return row.n
  }

  /** 取指定方向最近一次成功的同步记录（设置面板"上次成功同步时间"用） */
  getLatestSuccessful(direction: SyncDirection): SyncHistoryRow | null {
    const row = this.db.prepare(`
      SELECT * FROM sync_history
      WHERE direction = ? AND status = 'success'
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `).get(direction) as SyncHistoryRow | undefined
    return row ?? null
  }

  /** 清空所有历史，返回删除条数 */
  clear(): number {
    const result = this.db.prepare(`DELETE FROM sync_history`).run()
    return result.changes
  }

  /**
   * 仅保留最近 limit 条（按 created_at DESC + id DESC），删除其余。
   *
   * 用于 record 后的容量收敛与运维手动清理。
   * limit 缺省走 DEFAULT_RETENTION_LIMIT；非法值（< 0）静默回落到默认值。
   *
   * @returns 删除的条数
   */
  pruneToLimit(limit?: number): number {
    const effective = (limit !== undefined && Number.isFinite(limit) && limit >= 0)
      ? Math.floor(limit)
      : DEFAULT_RETENTION_LIMIT
    const result = this.db.prepare(`
      DELETE FROM sync_history
      WHERE id NOT IN (
        SELECT id FROM sync_history
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      )
    `).run(effective)
    return result.changes
  }
}
