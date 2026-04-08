import Database from 'better-sqlite3'
import path from 'path'
import { app } from 'electron'

/** 当前数据库 schema 版本，每次有结构变更时递增 */
const CURRENT_SCHEMA_VERSION = 2

export interface Conversation {
  id: string
  title: string
  avatar_id: string
  created_at: number
  updated_at: number
}

export interface Message {
  id: string
  conversation_id: string
  role: 'user' | 'assistant' | 'tool'
  content: string
  tool_call_id?: string
  image_urls?: string
  created_at: number
}

export class DatabaseManager {
  private db: Database.Database

  constructor(dbPath?: string) {
    const defaultPath = path.join(app.getPath('userData'), 'xiaodu.db')
    this.db = new Database(dbPath || defaultPath)
    // BUG5 修复：显式启用外键约束（SQLite 默认关闭）
    this.db.pragma('foreign_keys = ON')
    this.initialize()
  }

  private initialize() {
    // 创建 schema_version 表（BUG10 修复：DB 迁移机制）
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER NOT NULL DEFAULT 1
      )
    `)

    const versionRow = this.db.prepare('SELECT version FROM schema_version').get() as { version: number } | undefined

    if (versionRow === undefined) {
      // schema_version 表为空，判断是全新安装还是旧版本升级
      const tableExists = this.db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='conversations'"
      ).get()

      if (!tableExists) {
        // 全新安装：创建所有表并标记最新版本
        this.createBaseSchema()
        this.db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(CURRENT_SCHEMA_VERSION)
      } else {
        // 旧版本升级（conversations 已存在但无 schema_version 记录）：从 v1 开始迁移
        this.db.prepare('INSERT INTO schema_version (version) VALUES (1)').run()
        this.runMigrations(1)
      }
    } else {
      // 已有数据库，运行增量迁移
      this.runMigrations(versionRow.version)
    }
  }

  /** 从零创建完整 schema（首次安装） */
  private createBaseSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        avatar_id TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `)

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        tool_call_id TEXT,
        image_urls TEXT,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
      )
    `)

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `)

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_messages_conversation
      ON messages(conversation_id, created_at)
    `)
  }

  /** 增量迁移：从 fromVersion 迁移到 CURRENT_SCHEMA_VERSION */
  private runMigrations(fromVersion: number) {
    let version = fromVersion

    if (version < 1) {
      // v0 → v1：创建基础 schema
      this.createBaseSchema()
      version = 1
    }

    if (version < 2) {
      // v1 → v2：conversations 增加 avatar_id，messages 增加 tool_call_id 和 image_urls
      // 同时确保 settings 表存在（旧版本可能未创建）
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        )
      `)
      try {
        this.db.exec(`ALTER TABLE conversations ADD COLUMN avatar_id TEXT NOT NULL DEFAULT ''`)
      } catch (_) { /* 字段已存在则忽略 */ }
      try {
        this.db.exec(`ALTER TABLE messages ADD COLUMN tool_call_id TEXT`)
      } catch (_) { /* 字段已存在则忽略 */ }
      try {
        this.db.exec(`ALTER TABLE messages ADD COLUMN image_urls TEXT`)
      } catch (_) { /* 字段已存在则忽略 */ }
      version = 2
    }

    if (version !== fromVersion) {
      this.db.prepare('UPDATE schema_version SET version = ?').run(CURRENT_SCHEMA_VERSION)
    }
  }

  createConversation(title: string, avatarId: string): string {
    const id = `conv_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
    const now = Date.now()

    this.db.prepare(`
      INSERT INTO conversations (id, title, avatar_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, title, avatarId, now, now)

    return id
  }

  getConversations(avatarId?: string): Conversation[] {
    if (avatarId) {
      return this.db.prepare(`
        SELECT * FROM conversations
        WHERE avatar_id = ?
        ORDER BY updated_at DESC
      `).all(avatarId) as Conversation[]
    }
    return this.db.prepare(`
      SELECT * FROM conversations
      ORDER BY updated_at DESC
    `).all() as Conversation[]
  }

  getConversation(id: string): Conversation | undefined {
    return this.db.prepare(`
      SELECT * FROM conversations WHERE id = ?
    `).get(id) as Conversation | undefined
  }

  updateConversationTitle(id: string, title: string) {
    this.db.prepare(`
      UPDATE conversations
      SET title = ?, updated_at = ?
      WHERE id = ?
    `).run(title, Date.now(), id)
  }

  deleteConversation(id: string) {
    this.db.prepare('DELETE FROM conversations WHERE id = ?').run(id)
  }

  /** BUG4 修复：删除某个分身的所有会话（及其消息，通过 CASCADE） */
  deleteConversationsByAvatar(avatarId: string) {
    this.db.prepare('DELETE FROM conversations WHERE avatar_id = ?').run(avatarId)
  }

  // 消息操作
  saveMessage(conversationId: string, role: 'user' | 'assistant' | 'tool', content: string, toolCallId?: string, imageUrls?: string[]): string {
    const id = `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
    const now = Date.now()

    this.db.prepare(`
      INSERT INTO messages (id, conversation_id, role, content, tool_call_id, image_urls, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, conversationId, role, content, toolCallId ?? null, imageUrls ? JSON.stringify(imageUrls) : null, now)

    // 更新会话的 updated_at
    this.db.prepare(`
      UPDATE conversations SET updated_at = ? WHERE id = ?
    `).run(now, conversationId)

    return id
  }

  getMessages(conversationId: string): Message[] {
    return this.db.prepare(`
      SELECT * FROM messages
      WHERE conversation_id = ?
      ORDER BY created_at ASC
    `).all(conversationId) as Message[]
  }

  // 设置操作
  getSetting(key: string): string | undefined {
    const result = this.db.prepare(`
      SELECT value FROM settings WHERE key = ?
    `).get(key) as { value: string } | undefined

    return result?.value
  }

  setSetting(key: string, value: string) {
    this.db.prepare(`
      INSERT OR REPLACE INTO settings (key, value)
      VALUES (?, ?)
    `).run(key, value)
  }

  close() {
    this.db.close()
  }
}
