import Database from 'better-sqlite3'
import path from 'path'
import { app } from 'electron'

/** 当前数据库 schema 版本，每次有结构变更时递增 */
const CURRENT_SCHEMA_VERSION = 8

/** 提示词模板 */
export interface PromptTemplate {
  id: string
  avatar_id: string
  title: string
  content: string
  created_at: number
}

/**
 * Agent 任务持久化记录（Stage 三 P2 范围外 1）。
 *
 * 一行 = 一个会话的任务列表快照（整体 JSON 序列化存储），
 * 而非按 task 一行；这样：
 *   - 写入是单行 UPSERT，无需事务管理多条记录的同步
 *   - 读取一次拿到所有任务，UI 重启后立即恢复
 *   - tasks 字段是 JSON 字符串，结构演化不需要 schema 迁移
 */
export interface AgentTaskRow {
  /** 会话 ID（PK） */
  conversation_id: string
  /** 任务列表 JSON（AgentTask[] 序列化），含 toolCalls 关联记录 */
  tasks: string
  /** 最后更新时间（毫秒） */
  updated_at: number
}

/**
 * MCP server 配置（持久化形态，对应 mcp_servers 表的一行）。
 *
 * args / env 在 SQLite 中存为 JSON 字符串，对外暴露时已 parse 成对象 / 数组。
 * 业务层（main.ts）拿到 row 后再喂给 McpClientManager.addServer。
 *
 * @author zhi.qu
 * @date 2026-04-29
 */
export interface McpServerRow {
  name: string
  enabled: boolean
  transport: 'stdio' | 'http' | 'sse'
  command?: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  url?: string
  timeout_ms?: number
  description?: string
  created_at: number
  updated_at: number
}

export interface Conversation {
  id: string
  title: string
  avatar_id: string
  workspace_initialized?: number
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

/**
 * 对话附件元信息（持久化形态，对应 attachments 表的一行）。
 *
 * 文件本体不存这里，由 AttachmentStore 落到 userData/attachments/<convId>/<hash>.<ext>。
 * 本表只存索引/元信息，便于按会话列举、按消息关联、按 ID 查找。
 *
 * @author zhi.qu
 * @date 2026-05-01
 */
export interface AttachmentRow {
  id: string
  conversation_id: string
  /** 关联的消息 ID（先上传后发消息时为 null，发送后用 linkAttachmentToMessage 回填） */
  message_id: string | null
  /** 用户上传时的原始文件名 */
  name: string
  mime: string
  size: number
  /** sha256 hex（小写，64 字符） */
  hash: string
  /** 后缀名（含点，小写；无后缀时为空字符串） */
  ext: string
  /** 上传后由解析器抽取的摘要（前 N 字 / 总结），可能为 null */
  summary: string | null
  /** 上传后由解析器抽取的文档大纲（多行 markdown 标题），可能为 null */
  outline: string | null
  /** 解析器附加的 JSON 元数据（页数、sheet 名等），存储为 JSON 字符串 */
  parsed_meta: string | null
  created_at: number
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
        workspace_initialized INTEGER NOT NULL DEFAULT 0,
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

    // Agent 任务持久化表（v7 引入；2026-05-01 对话框附件扩展时补齐：
    // 之前 createBaseSchema 漏建该表，全新安装会在 deleteConversation 时报 "no such table"，
    // 老用户因走过 v6→v7 迁移而未暴露。这里补回，让全新安装的用户也得到完整 schema）
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_tasks (
        conversation_id TEXT PRIMARY KEY,
        tasks TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `)

    // 附件表（v8 引入，2026-05-01 对话框附件扩展）
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS attachments (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        message_id TEXT,
        name TEXT NOT NULL,
        mime TEXT NOT NULL,
        size INTEGER NOT NULL,
        hash TEXT NOT NULL,
        ext TEXT NOT NULL,
        summary TEXT,
        outline TEXT,
        parsed_meta TEXT,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
      )
    `)
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_attachments_conv
      ON attachments(conversation_id, created_at)
    `)
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_attachments_msg
      ON attachments(message_id)
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

    if (version < 5) {
      // v4 → v5：conversations 增加 workspace_initialized
      this.db.transaction(() => {
        this.safeAddColumn('conversations', 'workspace_initialized', 'INTEGER NOT NULL DEFAULT 0')
        version = 5
      })()
    }

    if (version < 6) {
      // v5 → v6：新增 mcp_servers 表（MCP 客户端 server 持久化配置）
      this.db.transaction(() => {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS mcp_servers (
            name TEXT PRIMARY KEY,
            enabled INTEGER NOT NULL DEFAULT 1,
            transport TEXT NOT NULL,
            command TEXT,
            args TEXT,
            env TEXT,
            cwd TEXT,
            url TEXT,
            timeout_ms INTEGER,
            description TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
          )
        `)
        version = 6
      })()
    }

    if (version < 7) {
      // v6 → v7：新增 agent_tasks 表（Stage 三 P2 范围外 1：会话级任务列表持久化）
      this.db.transaction(() => {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS agent_tasks (
            conversation_id TEXT PRIMARY KEY,
            tasks TEXT NOT NULL,
            updated_at INTEGER NOT NULL
          )
        `)
        version = 7
      })()
    }

    if (version < 8) {
      // v7 → v8：新增 attachments 表（对话框附件扩展，2026-05-01）
      // 文件本体落 userData/attachments/<convId>/<hash>.<ext>，本表只存元信息
      this.db.transaction(() => {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS attachments (
            id TEXT PRIMARY KEY,
            conversation_id TEXT NOT NULL,
            message_id TEXT,
            name TEXT NOT NULL,
            mime TEXT NOT NULL,
            size INTEGER NOT NULL,
            hash TEXT NOT NULL,
            ext TEXT NOT NULL,
            summary TEXT,
            outline TEXT,
            parsed_meta TEXT,
            created_at INTEGER NOT NULL,
            FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
          )
        `)
        this.db.exec(`
          CREATE INDEX IF NOT EXISTS idx_attachments_conv
          ON attachments(conversation_id, created_at)
        `)
        this.db.exec(`
          CREATE INDEX IF NOT EXISTS idx_attachments_msg
          ON attachments(message_id)
        `)
        version = 8
      })()
    }

    if (version !== fromVersion) {
      this.db.prepare('UPDATE schema_version SET version = ?').run(version)
    }
  }

  // ─── Agent 任务列表持久化（Stage 三 P2 范围外 1）─────────────────────────

  /**
   * 保存某会话的任务列表（整体覆盖式 UPSERT）。
   *
   * tasks 已由调用方 JSON.stringify；这里不做 schema 校验，由渲染进程的
   * setTasks/mergeTasks 保证字段合法性。
   */
  saveAgentTasks(conversationId: string, tasksJson: string): void {
    this.db.prepare(`
      INSERT INTO agent_tasks (conversation_id, tasks, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(conversation_id) DO UPDATE SET
        tasks = excluded.tasks,
        updated_at = excluded.updated_at
    `).run(conversationId, tasksJson, Date.now())
  }

  /**
   * 读取某会话的任务列表 JSON 字符串；不存在返回 null。
   * 调用方负责 JSON.parse 并按 AgentTask[] 校验。
   */
  getAgentTasks(conversationId: string): string | null {
    const row = this.db.prepare(`
      SELECT tasks FROM agent_tasks WHERE conversation_id = ?
    `).get(conversationId) as { tasks: string } | undefined
    return row ? row.tasks : null
  }

  /** 清空某会话的任务列表（删除整行） */
  clearAgentTasks(conversationId: string): void {
    this.db.prepare(`DELETE FROM agent_tasks WHERE conversation_id = ?`).run(conversationId)
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

  /**
   * 确保指定 ID 的 conversation 存在（已存在则不动）。
   * 用于批量回归：调用方需要用稳定的 conversationId（如 `regression-{runId}-{idx}`）
   * 才能精确过滤遥测事件，普通 createConversation 会重新生成 ID 不满足要求。
   */
  ensureConversation(id: string, title: string, avatarId: string): void {
    const now = Date.now()
    this.db.prepare(`
      INSERT OR IGNORE INTO conversations (id, title, avatar_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, title, avatarId, now, now)
  }

  /**
   * 按前缀批量删除 conversation（连同消息、agent_tasks 一并 CASCADE 删除）。
   * 用于批量回归运行结束后清理所有 `regression-{runId}-*` 会话，避免污染历史。
   * 返回删除的会话数。
   */
  deleteConversationsByPrefix(prefix: string): number {
    let deleted = 0
    this.db.transaction(() => {
      const ids = this.db.prepare(
        `SELECT id FROM conversations WHERE id LIKE ?`,
      ).all(`${prefix}%`) as Array<{ id: string }>
      for (const row of ids) {
        this.db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(row.id)
        this.db.prepare('DELETE FROM agent_tasks WHERE conversation_id = ?').run(row.id)
        this.db.prepare('DELETE FROM conversations WHERE id = ?').run(row.id)
        deleted++
      }
    })()
    return deleted
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

  markWorkspaceInitialized(conversationId: string): void {
    this.db.prepare(`
      UPDATE conversations
      SET workspace_initialized = 1, updated_at = ?
      WHERE id = ?
    `).run(Date.now(), conversationId)
  }

  updateConversationTitle(id: string, title: string) {
    this.db.prepare(`
      UPDATE conversations
      SET title = ?, updated_at = ?
      WHERE id = ?
    `).run(title, Date.now(), id)
  }

  /** 先显式删除消息（触发 FTS 同步触发器），再删除会话；同时清空 agent_tasks 与附件元信息 */
  deleteConversation(id: string) {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(id)
      this.db.prepare('DELETE FROM agent_tasks WHERE conversation_id = ?').run(id)
      this.db.prepare('DELETE FROM attachments WHERE conversation_id = ?').run(id)
      this.db.prepare('DELETE FROM conversations WHERE id = ?').run(id)
    })()
  }

  /** 先显式删除所有关联消息（触发 FTS 同步触发器），再删除会话；同时清空 agent_tasks 与附件元信息 */
  deleteConversationsByAvatar(avatarId: string) {
    this.db.transaction(() => {
      this.db.prepare(`
        DELETE FROM messages WHERE conversation_id IN (
          SELECT id FROM conversations WHERE avatar_id = ?
        )
      `).run(avatarId)
      this.db.prepare(`
        DELETE FROM agent_tasks WHERE conversation_id IN (
          SELECT id FROM conversations WHERE avatar_id = ?
        )
      `).run(avatarId)
      this.db.prepare(`
        DELETE FROM attachments WHERE conversation_id IN (
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

  // ─── MCP servers CRUD ──────────────────────────────────────────────────────
  // 设计：args / env 在 SQLite 里存为 JSON 字符串，这一层负责 stringify / parse，
  // 让上层（main.ts、ToolRouter）只感知干净的 McpServerRow 对象。

  /** 列出所有 MCP server 配置（按 created_at 倒序） */
  listMcpServers(): McpServerRow[] {
    const rows = this.db.prepare(
      `SELECT name, enabled, transport, command, args, env, cwd, url, timeout_ms, description, created_at, updated_at
       FROM mcp_servers ORDER BY created_at DESC`,
    ).all() as Array<Record<string, unknown>>
    return rows.map(this.deserializeMcpServerRow)
  }

  /** 按 name 取单条 */
  getMcpServer(name: string): McpServerRow | undefined {
    const row = this.db.prepare(
      `SELECT name, enabled, transport, command, args, env, cwd, url, timeout_ms, description, created_at, updated_at
       FROM mcp_servers WHERE name = ?`,
    ).get(name) as Record<string, unknown> | undefined
    return row ? this.deserializeMcpServerRow(row) : undefined
  }

  /** 插入或更新 MCP server（按 name 主键 upsert） */
  upsertMcpServer(row: Omit<McpServerRow, 'created_at' | 'updated_at'>): void {
    const now = Date.now()
    const existing = this.getMcpServer(row.name)
    const created_at = existing?.created_at ?? now
    this.db.prepare(`
      INSERT INTO mcp_servers (name, enabled, transport, command, args, env, cwd, url, timeout_ms, description, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET
        enabled = excluded.enabled,
        transport = excluded.transport,
        command = excluded.command,
        args = excluded.args,
        env = excluded.env,
        cwd = excluded.cwd,
        url = excluded.url,
        timeout_ms = excluded.timeout_ms,
        description = excluded.description,
        updated_at = excluded.updated_at
    `).run(
      row.name,
      row.enabled ? 1 : 0,
      row.transport,
      row.command ?? null,
      row.args && row.args.length > 0 ? JSON.stringify(row.args) : null,
      row.env && Object.keys(row.env).length > 0 ? JSON.stringify(row.env) : null,
      row.cwd ?? null,
      row.url ?? null,
      row.timeout_ms ?? null,
      row.description ?? null,
      created_at,
      now,
    )
  }

  /** 删除 MCP server 配置 */
  deleteMcpServer(name: string): void {
    this.db.prepare('DELETE FROM mcp_servers WHERE name = ?').run(name)
  }

  /**
   * 把 SQLite 原始行（JSON 字符串字段）反序列化成 McpServerRow。
   * args / env 损坏时静默回退（不抛错，避免单条坏数据卡住列表）。
   */
  private deserializeMcpServerRow = (row: Record<string, unknown>): McpServerRow => {
    const safeParseJson = <T,>(s: unknown): T | undefined => {
      if (typeof s !== 'string' || !s) return undefined
      try { return JSON.parse(s) as T } catch { return undefined }
    }
    return {
      name: String(row.name),
      enabled: row.enabled === 1 || row.enabled === true,
      transport: row.transport as McpServerRow['transport'],
      command: row.command ? String(row.command) : undefined,
      args: safeParseJson<string[]>(row.args),
      env: safeParseJson<Record<string, string>>(row.env),
      cwd: row.cwd ? String(row.cwd) : undefined,
      url: row.url ? String(row.url) : undefined,
      timeout_ms: typeof row.timeout_ms === 'number' ? row.timeout_ms : undefined,
      description: row.description ? String(row.description) : undefined,
      created_at: Number(row.created_at) || 0,
      updated_at: Number(row.updated_at) || 0,
    }
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

  // ─── 附件元信息 CRUD（v8 引入，对话框附件扩展）─────────────────────────────
  // 文件本体由 AttachmentStore 落到 userData/attachments/<convId>/<hash>.<ext>，
  // 本表只存索引/元信息（id / name / mime / hash / ext / summary / outline）。

  /**
   * 写入一条附件元信息。
   * id 由调用方提供（一般来自 AttachmentStore.saveAttachment 的返回值）。
   *
   * @author zhi.qu
   * @date 2026-05-01
   */
  insertAttachment(row: Omit<AttachmentRow, 'message_id' | 'summary' | 'outline' | 'parsed_meta'> & {
    message_id?: string | null
    summary?: string | null
    outline?: string | null
    parsed_meta?: string | null
  }): void {
    this.db.prepare(`
      INSERT INTO attachments (id, conversation_id, message_id, name, mime, size, hash, ext, summary, outline, parsed_meta, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.id,
      row.conversation_id,
      row.message_id ?? null,
      row.name,
      row.mime,
      row.size,
      row.hash,
      row.ext,
      row.summary ?? null,
      row.outline ?? null,
      row.parsed_meta ?? null,
      row.created_at,
    )
  }

  /** 按 ID 取单条附件，不存在返回 undefined */
  getAttachmentById(id: string): AttachmentRow | undefined {
    return this.db.prepare(
      `SELECT id, conversation_id, message_id, name, mime, size, hash, ext, summary, outline, parsed_meta, created_at
       FROM attachments WHERE id = ?`,
    ).get(id) as AttachmentRow | undefined
  }

  /** 列出某会话的所有附件（按 created_at 升序） */
  listAttachmentsByConversation(conversationId: string): AttachmentRow[] {
    return this.db.prepare(
      `SELECT id, conversation_id, message_id, name, mime, size, hash, ext, summary, outline, parsed_meta, created_at
       FROM attachments WHERE conversation_id = ? ORDER BY created_at ASC`,
    ).all(conversationId) as AttachmentRow[]
  }

  /**
   * 把一组附件回填关联到某条消息上（user 消息保存后调用）。
   * 仅更新 message_id 仍为 null 且属于同一会话的附件，避免误改其他消息的附件。
   *
   * @returns 实际更新的行数
   */
  linkAttachmentToMessage(messageId: string, attachmentIds: string[], conversationId: string): number {
    if (attachmentIds.length === 0) return 0
    let updated = 0
    const stmt = this.db.prepare(`
      UPDATE attachments
      SET message_id = ?
      WHERE id = ? AND conversation_id = ? AND (message_id IS NULL OR message_id = '')
    `)
    this.db.transaction(() => {
      for (const attId of attachmentIds) {
        const result = stmt.run(messageId, attId, conversationId)
        updated += result.changes
      }
    })()
    return updated
  }

  /**
   * 异步抽取摘要 / 大纲完成后，回填附件行的解析结果。
   * 仅当目标行存在时更新，避免被并发删除后又复活脏数据。
   *
   * @author zhi.qu
   * @date 2026-05-05
   */
  updateAttachmentParseResult(
    id: string,
    fields: { summary?: string | null; outline?: string | null; parsed_meta?: string | null },
  ): number {
    const result = this.db.prepare(`
      UPDATE attachments
      SET summary = ?, outline = ?, parsed_meta = ?
      WHERE id = ?
    `).run(
      fields.summary ?? null,
      fields.outline ?? null,
      fields.parsed_meta ?? null,
      id,
    )
    return result.changes
  }

  /** 按会话 ID 删除所有附件元信息（文件本体清理由调用方走 AttachmentStore） */
  deleteAttachmentsByConversation(conversationId: string): number {
    const result = this.db.prepare(
      'DELETE FROM attachments WHERE conversation_id = ?',
    ).run(conversationId)
    return result.changes
  }
}
