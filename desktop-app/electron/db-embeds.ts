/**
 * Web Embed widget 持久层 DAO（独立模块，#15 Web Embed widget）。
 *
 * 与 DatabaseManager 解耦：构造接 better-sqlite3 实例，方便单测注入 in-memory db。
 * 表 schema 见 database.ts 的 createBaseSchema / migrateV10ToV11：
 *   - embeds：站点嵌入配置，每行 = 一个站点接入凭证
 *
 * 命名约定：
 *   - id 用 `emb_` 前缀 + 时间戳 + 随机串，与 `sched_` 风格一致
 *   - 时间字段一律 Unix 毫秒（INTEGER），与现有 conversations / schedules 一致
 *   - origin_whitelist 在 DB 内是 JSON 数组字符串；DAO 层提供 string[] ↔ string 转换
 *
 * 安全约束（DAO 层硬阻断）：
 *   - origin 白名单**禁止**包含 wildcard `*`：避免设置面板误存导致接入面无限制
 *   - 实际的 Origin 严格匹配由 widget-server 在握手时再做（DAO 不解析白名单内容）
 *   - greeting 超过 500 字符自动 truncate（避免单行 JSON 失控）
 *   - rate_limit_per_min 范围 [5, 300]，超出 clamp 到边界
 *
 * @author zhi.qu
 * @date 2026-05-09
 */

import type Database from 'better-sqlite3'

/** 持久化的 embed 行（与 DB schema 一一对应；origin_whitelist 仍是 JSON 字符串，由调用方 parse） */
export interface EmbedRow {
  /** 唯一 ID，前缀 `emb_` */
  id: string
  /** 绑定的分身 ID（必填） */
  avatar_id: string
  /** 用户给的别名，如「我的博客」 */
  name: string
  /**
   * Origin 白名单的 JSON 数组字符串，例如 `'["http://localhost:3000","https://blog.example.com"]'`。
   *
   * - 空数组 `'[]'` 表示**无任何 origin 通过**（拒绝所有），不是「允许全部」
   * - **禁止**包含 wildcard `*`（DAO 层在写入时硬阻断）
   * - DAO 不校验内容格式（让 widget-server 严格匹配时再做）
   */
  origin_whitelist: string
  /** 0/1：是否启用此嵌入 */
  enabled: 0 | 1
  /** 每分钟最多请求数，clamp 到 [5, 300] */
  rate_limit_per_min: number
  /** 可选首条欢迎语；超 500 字符会被截断；空字符串保存为 null */
  greeting: string | null
  created_at: number
  updated_at: number
}

/** 创建 embed 的入参（id / 时间戳由 store 自动生成） */
export interface NewEmbedInput {
  avatarId: string
  name: string
  /** Origin 列表（不允许包含 `*`，DAO 层会抛 Error） */
  originWhitelist: string[]
  /** 默认 30，clamp 到 [5, 300] */
  rateLimitPerMin?: number
  /** 默认空（→ null），超 500 字符截断 */
  greeting?: string
  /** 默认 true */
  enabled?: boolean
}

/** 更新 embed 的可选字段（不传则不动） */
export interface UpdateEmbedInput {
  avatarId?: string
  name?: string
  originWhitelist?: string[]
  rateLimitPerMin?: number
  greeting?: string
  enabled?: boolean
}

/** 列表过滤条件 */
export interface ListEmbedsFilter {
  avatarId?: string
  enabled?: boolean
}

/** ID 前缀（与 createConversation / newScheduleId 同风格） */
function newEmbedId(): string {
  return `emb_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`
}

/** 默认 30，clamp 到 [5, 300]；undefined 时回落默认值 */
function clampRateLimit(n: number | undefined): number {
  if (n === undefined || !Number.isFinite(n)) return 30
  const v = Math.floor(n)
  if (v < 5) return 5
  if (v > 300) return 300
  return v
}

/**
 * 欢迎语规整：
 *   - undefined / 空字符串 → null（不存空字符串）
 *   - 超 500 字符 → 截断 + '…'
 */
function truncateGreeting(s: string | undefined): string | null {
  if (s === undefined) return null
  const trimmed = s
  if (trimmed.length === 0) return null
  return trimmed.length > 500 ? trimmed.slice(0, 500) + '…' : trimmed
}

/**
 * 把 origin 数组序列化为 DB 存储的 JSON 字符串。
 *
 * **硬阻断**：若任意一项等于 `*` 或包含 `*`，立即抛 Error，
 * 让设置面板/调用方提前感知，避免误存「全部放行」的危险白名单。
 *
 * undefined / 空数组 → `'[]'`（语义：无任何 origin 通过）
 */
function serializeOrigins(origins: string[] | undefined): string {
  if (!origins || origins.length === 0) return '[]'
  for (const o of origins) {
    if (typeof o !== 'string') {
      throw new Error('origin 列表只接受字符串元素')
    }
    if (o.includes('*')) {
      throw new Error(`origin 白名单禁止包含 wildcard "*"，收到：${o}`)
    }
  }
  return JSON.stringify(origins)
}

/**
 * Web Embed DAO。
 *
 * 单实例由 main.ts 在 DatabaseManager 初始化后构造（见 #15 §4.13 子任务 2）。
 * 所有方法都是同步（better-sqlite3 风格）；调用方负责异步包装。
 */
export class EmbedStore {
  constructor(private readonly db: Database.Database) {}

  /**
   * 创建一条 embed。
   *
   * - 自动生成 id（`emb_<ts>_<rand>`）与 created_at / updated_at
   * - origin 含 `*` 立即抛 Error（serializeOrigins 兜底）
   * - rateLimitPerMin clamp 到 [5, 300]
   * - greeting 超 500 字符截断
   *
   * @returns 创建后的完整行
   */
  create(input: NewEmbedInput): EmbedRow {
    const id = newEmbedId()
    const now = Date.now()
    const row: EmbedRow = {
      id,
      avatar_id: input.avatarId,
      name: input.name,
      origin_whitelist: serializeOrigins(input.originWhitelist),
      enabled: input.enabled === false ? 0 : 1,
      rate_limit_per_min: clampRateLimit(input.rateLimitPerMin),
      greeting: truncateGreeting(input.greeting),
      created_at: now,
      updated_at: now,
    }
    this.db.prepare(`
      INSERT INTO embeds (
        id, avatar_id, name, origin_whitelist, enabled,
        rate_limit_per_min, greeting, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.id,
      row.avatar_id,
      row.name,
      row.origin_whitelist,
      row.enabled,
      row.rate_limit_per_min,
      row.greeting,
      row.created_at,
      row.updated_at,
    )
    return row
  }

  /**
   * 部分更新 embed。
   * 只更新 patch 中实际提供的字段；updated_at 总是刷新。
   * 不存在的 id 返回 null。
   */
  update(id: string, patch: UpdateEmbedInput): EmbedRow | null {
    const existing = this.get(id)
    if (!existing) return null

    const sets: string[] = []
    const values: Array<string | number | null> = []

    if (patch.avatarId !== undefined) {
      sets.push('avatar_id = ?')
      values.push(patch.avatarId)
    }
    if (patch.name !== undefined) {
      sets.push('name = ?')
      values.push(patch.name)
    }
    if (patch.originWhitelist !== undefined) {
      sets.push('origin_whitelist = ?')
      values.push(serializeOrigins(patch.originWhitelist))
    }
    if (patch.rateLimitPerMin !== undefined) {
      sets.push('rate_limit_per_min = ?')
      values.push(clampRateLimit(patch.rateLimitPerMin))
    }
    if (patch.greeting !== undefined) {
      sets.push('greeting = ?')
      values.push(truncateGreeting(patch.greeting))
    }
    if (patch.enabled !== undefined) {
      sets.push('enabled = ?')
      values.push(patch.enabled ? 1 : 0)
    }
    sets.push('updated_at = ?')
    values.push(Date.now())
    values.push(id)

    this.db.prepare(`
      UPDATE embeds SET ${sets.join(', ')} WHERE id = ?
    `).run(...values)
    return this.get(id)
  }

  /**
   * 删除 embed。
   * 返回是否真的发生删除（id 不存在返回 false）。
   */
  delete(id: string): boolean {
    const result = this.db.prepare(`DELETE FROM embeds WHERE id = ?`).run(id)
    return result.changes > 0
  }

  /** 按 ID 查 embed，不存在返回 null */
  get(id: string): EmbedRow | null {
    const row = this.db.prepare(`
      SELECT * FROM embeds WHERE id = ?
    `).get(id) as EmbedRow | undefined
    return row ?? null
  }

  /** 列出 embeds，按 created_at DESC；可按 avatar / enabled 过滤 */
  list(opts?: ListEmbedsFilter): EmbedRow[] {
    const where: string[] = []
    const params: Array<string | number> = []
    if (opts?.avatarId !== undefined) {
      where.push('avatar_id = ?')
      params.push(opts.avatarId)
    }
    if (opts?.enabled !== undefined) {
      where.push('enabled = ?')
      params.push(opts.enabled ? 1 : 0)
    }
    const sql = `
      SELECT * FROM embeds
      ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY created_at DESC
    `
    return this.db.prepare(sql).all(...params) as EmbedRow[]
  }

  /**
   * 单独切换启停，刷新 updated_at。
   * 不存在的 id 返回 null。
   */
  setEnabled(id: string, enabled: boolean): EmbedRow | null {
    const result = this.db.prepare(`
      UPDATE embeds SET enabled = ?, updated_at = ? WHERE id = ?
    `).run(enabled ? 1 : 0, Date.now(), id)
    if (result.changes === 0) return null
    return this.get(id)
  }
}
