import Database from 'better-sqlite3'
import path from 'path'
import { app } from 'electron'

/** 当前数据库 schema 版本，每次有结构变更时递增 */
const CURRENT_SCHEMA_VERSION = 4

/** 提示词模板 */
export interface PromptTemplate {
  id: string
  avatar_id: string
  title: string
  content: string
  created_at: number
}

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

/** 全文搜索结果 */
export interface MessageSearchResult {
  conversationId: string
  conversationTitle: string
  messageId: string
  snippet: string
  role: string
  createdAt: number
}

export class DatabaseManager {
  private db: Database.Database
  private closed = false

  /** 高频查询的预编译 Statement 缓存，避免每次调用都重新编译 SQL */
  private stmts!: {
    getConversationsByAvatar: Database.Statement
    getConversationsAll: Database.Statement
    getConversation: Database.Statement
    getMessages: Database.Statement
    insertMessage: Database.Statement
    updateConversationTime: Database.Statement
    getSetting: Database.Statement
    setSetting: Database.Statement
    searchWithAvatar: Database.Statement
    searchAll: Database.Statement
  }

  constructor(dbPath?: string) {
    const defaultPath = path.join(app.getPath('userData'), 'xiaodu.db')
    this.db = new Database(dbPath || defaultPath)
    this.db.pragma('foreign_keys = ON')
    this.db.pragma('journal_mode = WAL')
    this.initialize()
    this.prepareStatements()
  }

  /**
   * 预编译高频 SQL 语句，避免每次调用 prepare() 重新解析。
   *
   * @author zhi.qu
   * @date 2026-04-10
   */
  private prepareStatements(): void {
    this.stmts = {
      getConversationsByAvatar: this.db.prepare(
        `SELECT * FROM conversations WHERE avatar_id = ? ORDER BY updated_at DESC`
      ),
      getConversationsAll: this.db.prepare(
        `SELECT * FROM conversations ORDER BY updated_at DESC`
      ),
      getConversation: this.db.prepare(
        `SELECT * FROM conversations WHERE id = ?`
      ),
      getMessages: this.db.prepare(
        `SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC`
      ),
      insertMessage: this.db.prepare(
        `INSERT INTO messages (id, conversation_id, role, content, tool_call_id, image_urls, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
      ),
      updateConversationTime: this.db.prepare(
        `UPDATE conversations SET updated_at = ? WHERE id = ?`
      ),
      getSetting: this.db.prepare(
        `SELECT value FROM settings WHERE key = ?`
      ),
      setSetting: this.db.prepare(
        `INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`
      ),
      searchWithAvatar: this.db.prepare(`
        SELECT m.id AS messageId,
               m.conversation_id AS conversationId,
               c.title AS conversationTitle,
               snippet(messages_fts, 0, '[', ']', '...', 20) AS snippet,
               m.role,
               m.created_at AS createdAt
        FROM messages_fts
        JOIN messages m ON m.rowid = messages_fts.rowid
        JOIN conversations c ON c.id = m.conversation_id
        WHERE messages_fts MATCH ?
          AND c.avatar_id = ?
          AND m.role IN ('user', 'assistant')
        ORDER BY rank
        LIMIT ?
      `),
      searchAll: this.db.prepare(`
        SELECT m.id AS messageId,
               m.conversation_id AS conversationId,
               c.title AS conversationTitle,
               snippet(messages_fts, 0, '[', ']', '...', 20) AS snippet,
               m.role,
               m.created_at AS createdAt
        FROM messages_fts
        JOIN messages m ON m.rowid = messages_fts.rowid
        JOIN conversations c ON c.id = m.conversation_id
        WHERE messages_fts MATCH ?
          AND m.role IN ('user', 'assistant')
        ORDER BY rank
        LIMIT ?
      `),
    }
  }

  private initialize() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_version (
        id INTEGER PRIMARY KEY CHECK (id = 1),
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

  /** 从零创建完整 schema（首次安装），包含所有表、索引、FTS 和触发器 */
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

    // FTS5 全文搜索表和同步触发器（v3 引入）
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        content,
        content='messages',
        content_rowid='rowid'
      )
    `)
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
      END
    `)
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.rowid, old.content);
      END
    `)
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.rowid, old.content);
        INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
      END
    `)

    // 提示词模板表（v4 引入）
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS prompt_templates (
        id TEXT PRIMARY KEY,
        avatar_id TEXT NOT NULL DEFAULT '',
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `)
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_prompt_templates_avatar
      ON prompt_templates(avatar_id, created_at)
    `)
  }

  /** 增量迁移：从 fromVersion 迁移到 CURRENT_SCHEMA_VERSION */
  private runMigrations(fromVersion: number) {
    let version = fromVersion

    if (version < 1) {
      // v0 → v1：创建基础 schema（事务包裹保证原子性）
      this.db.transaction(() => {
        this.createBaseSchema()
        version = 1
      })()
    }

    if (version < 2) {
      // v1 → v2：conversations 增加 avatar_id，messages 增加 tool_call_id 和 image_urls
      this.db.transaction(() => {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
          )
        `)
        this.safeAddColumn('conversations', 'avatar_id', `TEXT NOT NULL DEFAULT ''`)
        this.safeAddColumn('messages', 'tool_call_id', 'TEXT')
        this.safeAddColumn('messages', 'image_urls', 'TEXT')
        version = 2
      })()
    }

    if (version < 3) {
      // v2 → v3：添加 FTS5 虚拟表和触发器，支持消息全文搜索
      this.db.transaction(() => {
        this.db.exec(`
          CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
            content,
            content='messages',
            content_rowid='rowid'
          )
        `)
        this.db.exec(`
          CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
            INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
          END
        `)
        this.db.exec(`
          CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
            INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.rowid, old.content);
          END
        `)
        this.db.exec(`
          CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
            INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.rowid, old.content);
            INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
          END
        `)
        // 首次迁移时全量 rebuild 已有消息
        this.rebuildFts()
        version = 3
      })()
    }

    if (version < 4) {
      // v3 → v4：新增提示词模板表
      this.db.transaction(() => {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS prompt_templates (
            id TEXT PRIMARY KEY,
            avatar_id TEXT NOT NULL DEFAULT '',
            title TEXT NOT NULL,
            content TEXT NOT NULL,
            created_at INTEGER NOT NULL
          )
        `)
        this.db.exec(`
          CREATE INDEX IF NOT EXISTS idx_prompt_templates_avatar
          ON prompt_templates(avatar_id, created_at)
        `)
        version = 4
      })()
    }

    if (version !== fromVersion) {
      this.db.prepare('UPDATE schema_version SET version = ?').run(version)
    }
  }

  createConversation(title: string, avatarId: string): string {
    const id = `conv_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`
    const now = Date.now()

    this.db.prepare(`
      INSERT INTO conversations (id, title, avatar_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, title, avatarId, now, now)

    return id
  }

  getConversations(avatarId?: string): Conversation[] {
    if (avatarId) {
      return this.stmts.getConversationsByAvatar.all(avatarId) as Conversation[]
    }
    return this.stmts.getConversationsAll.all() as Conversation[]
  }

  getConversation(id: string): Conversation | undefined {
    return this.stmts.getConversation.get(id) as Conversation | undefined
  }

  updateConversationTitle(id: string, title: string) {
    this.db.prepare(`
      UPDATE conversations
      SET title = ?, updated_at = ?
      WHERE id = ?
    `).run(title, Date.now(), id)
  }

  /** 先显式删除消息（触发 FTS 同步触发器），再删除会话 */
  deleteConversation(id: string) {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(id)
      this.db.prepare('DELETE FROM conversations WHERE id = ?').run(id)
    })()
  }

  /** 先显式删除所有关联消息（触发 FTS 同步触发器），再删除会话 */
  deleteConversationsByAvatar(avatarId: string) {
    this.db.transaction(() => {
      this.db.prepare(`
        DELETE FROM messages WHERE conversation_id IN (
          SELECT id FROM conversations WHERE avatar_id = ?
        )
      `).run(avatarId)
      this.db.prepare('DELETE FROM conversations WHERE avatar_id = ?').run(avatarId)
    })()
  }

  // 消息操作
  saveMessage(conversationId: string, role: 'user' | 'assistant' | 'tool', content: string, toolCallId?: string, imageUrls?: string[]): string {
    const id = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`
    const now = Date.now()

    // 使用事务保证消息写入和会话更新时间原子一致，避免部分成功导致数据不一致。
    const saveTx = this.db.transaction(() => {
      this.stmts.insertMessage.run(id, conversationId, role, content, toolCallId ?? null, imageUrls ? JSON.stringify(imageUrls) : null, now)
      this.stmts.updateConversationTime.run(now, conversationId)
    })
    saveTx()

    return id
  }

  getMessages(conversationId: string): Message[] {
    return this.stmts.getMessages.all(conversationId) as Message[]
  }

  // 设置操作
  getSetting(key: string): string | undefined {
    const result = this.stmts.getSetting.get(key) as { value: string } | undefined
    return result?.value
  }

  setSetting(key: string, value: string) {
    this.stmts.setSetting.run(key, value)
  }

  close() {
    if (this.closed) return
    this.closed = true
    this.db.close()
  }

  /**
   * 安全添加列：先检查列是否存在，不存在时才执行 ALTER TABLE。
   * 避免空 catch 吞掉非「列已存在」的错误（如磁盘损坏）。
   *
   * @author zhi.qu
   * @date 2026-04-09
   */
  private safeAddColumn(table: string, column: string, definition: string): void {
    const idRe = /^[a-zA-Z_]\w*$/
    if (!idRe.test(table) || !idRe.test(column)) {
      throw new Error(`非法 SQL 标识符: table=${table}, column=${column}`)
    }
    const columns = this.db.pragma(`table_info(${table})`) as Array<{ name: string }>
    const exists = columns.some(c => c.name === column)
    if (!exists) {
      this.db.exec(`ALTER TABLE "${table}" ADD COLUMN "${column}" ${definition}`)
    }
  }

  /**
   * 全量重建 FTS5 索引。
   * 在迁移事务内调用时不捕获错误，让事务回滚以保证一致性。
   */
  private rebuildFts() {
    this.db.exec(`INSERT INTO messages_fts(messages_fts) VALUES('rebuild')`)
  }

  /**
   * 将当前数据库备份到指定路径（异步，不阻塞主线程）。
   * 使用 better-sqlite3 原生 backup API，保证备份一致性。
   *
   * @param destPath 备份文件的完整路径
   */
  async backup(destPath: string): Promise<void> {
    if (this.closed) throw new Error('数据库已关闭，无法执行备份')
    await this.db.backup(destPath)
  }

  /**
   * 全文搜索消息，返回匹配片段和所属会话信息。
   *
   * @param query - 搜索关键词
   * @param avatarId - 可选，限定分身范围
   * @param limit - 最大结果数（默认 20）
   */
  searchMessages(query: string, avatarId?: string, limit = 20): MessageSearchResult[] {
    if (!query.trim()) return []
    // FTS5 特殊字符转义：双引号包裹用户输入，内部双引号转义为两个双引号
    const safeQuery = '"' + query.replace(/"/g, '""') + '"'
    try {
      return avatarId
        ? this.stmts.searchWithAvatar.all(safeQuery, avatarId, limit) as MessageSearchResult[]
        : this.stmts.searchAll.all(safeQuery, limit) as MessageSearchResult[]
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      console.error('[Database] searchMessages failed:', msg)
      if (msg.includes('fts5') || msg.includes('MATCH') || msg.includes('syntax')) {
        return []
      }
      throw new Error(`消息搜索失败: ${msg}`)
    }
  }

  // ─── 提示词模板 ──────────────────────────────────────────────────────────────

  /**
   * 创建提示词模板。
   *
   * @author zhi.qu
   * @date 2026-04-10
   */
  createPromptTemplate(avatarId: string, title: string, content: string): string {
    const id = `tpl_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
    this.db.prepare(`
      INSERT INTO prompt_templates (id, avatar_id, title, content, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, avatarId, title, content, Date.now())
    return id
  }

  /** 获取指定分身的所有提示词模板（按创建时间倒序） */
  getPromptTemplates(avatarId: string): PromptTemplate[] {
    return this.db.prepare(`
      SELECT * FROM prompt_templates WHERE avatar_id = ? ORDER BY created_at DESC
    `).all(avatarId) as PromptTemplate[]
  }

  /** 更新提示词模板内容（仅允许更新属于指定分身的模板） */
  updatePromptTemplate(id: string, avatarId: string, title: string, content: string): void {
    const result = this.db.prepare(`
      UPDATE prompt_templates SET title = ?, content = ? WHERE id = ? AND avatar_id = ?
    `).run(title, content, id, avatarId)
    if (result.changes === 0) {
      throw new Error(`模板不存在或无权限修改: ${id}`)
    }
  }

  /** 删除提示词模板（仅允许删除属于指定分身的模板） */
  deletePromptTemplate(id: string, avatarId: string): void {
    const result = this.db.prepare('DELETE FROM prompt_templates WHERE id = ? AND avatar_id = ?').run(id, avatarId)
    if (result.changes === 0) {
      throw new Error(`模板不存在或无权限删除: ${id}`)
    }
  }
}
