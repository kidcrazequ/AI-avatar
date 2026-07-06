/**
 * Memory Review State DAO（A4 · Hermes 借鉴 · v22）。
 *
 * 每会话一行游标：记录"记忆复盘已消化到哪条消息"（按 created_at），
 * 供后台复盘判断"距上次复盘是否已积累 ≥ N 个用户轮"。
 *
 * 与 ScheduleStore / EmbedStore 同款模式：main.ts 在 DatabaseManager
 * 初始化后 lazy 构造，方法全同步（better-sqlite3），调用方负责异步包装。
 * 这里的查询都是单行/计数级，不会阻塞事件循环（工程铁律相关的大头
 * ——LLM 复盘调用与文件写入——在 electron/memory-review.ts 异步编排）。
 *
 * @author zhi.qu
 * @date 2026-07-05
 */

import type Database from 'better-sqlite3'

export interface MemoryReviewStateRow {
  conversation_id: string
  avatar_id: string
  last_reviewed_message_created_at: number
  reviewed_at: number
  review_count: number
}

export interface ReviewTranscriptMessage {
  role: 'user' | 'assistant'
  content: string
  created_at: number
}

export class MemoryReviewStore {
  constructor(private readonly db: Database.Database) {}

  /** 会话归属查询（跨分身防护：复盘前必须校验 conversation 确属该分身） */
  conversationAvatarId(conversationId: string): string | undefined {
    const row = this.db
      .prepare(`SELECT avatar_id FROM conversations WHERE id = ?`)
      .get(conversationId) as { avatar_id: string } | undefined
    return row?.avatar_id
  }

  get(conversationId: string): MemoryReviewStateRow | undefined {
    return this.db
      .prepare(`SELECT * FROM memory_review_state WHERE conversation_id = ?`)
      .get(conversationId) as MemoryReviewStateRow | undefined
  }

  /** 复盘完成（含 Nothing-to-save）后推进游标；review_count 自增 */
  advanceCursor(conversationId: string, avatarId: string, lastReviewedCreatedAt: number): void {
    this.db
      .prepare(`
        INSERT INTO memory_review_state (conversation_id, avatar_id, last_reviewed_message_created_at, reviewed_at, review_count)
        VALUES (?, ?, ?, ?, 1)
        ON CONFLICT(conversation_id) DO UPDATE SET
          avatar_id = excluded.avatar_id,
          last_reviewed_message_created_at = excluded.last_reviewed_message_created_at,
          reviewed_at = excluded.reviewed_at,
          review_count = memory_review_state.review_count + 1
      `)
      .run(conversationId, avatarId, lastReviewedCreatedAt, Date.now())
  }

  /** 游标之后的用户轮数（复盘触发判定） */
  countUserMessagesSince(conversationId: string, sinceCreatedAt: number): number {
    const row = this.db
      .prepare(`
        SELECT COUNT(*) AS n FROM messages
        WHERE conversation_id = ? AND role = 'user' AND created_at > ?
      `)
      .get(conversationId, sinceCreatedAt) as { n: number }
    return row.n
  }

  /**
   * 游标之后的 user/assistant 转写（升序），cap 限最大条数（取最近的 cap 条）。
   * tool 消息不进复盘 prompt——过程性内容用 session_search 找。
   */
  getTranscriptSince(conversationId: string, sinceCreatedAt: number, cap = 60): ReviewTranscriptMessage[] {
    const rows = this.db
      .prepare(`
        SELECT role, content, created_at FROM messages
        WHERE conversation_id = ? AND created_at > ? AND role IN ('user', 'assistant')
        ORDER BY created_at DESC, rowid DESC
        LIMIT ?
      `)
      .all(conversationId, sinceCreatedAt, cap) as ReviewTranscriptMessage[]
    return rows.reverse()
  }
}
