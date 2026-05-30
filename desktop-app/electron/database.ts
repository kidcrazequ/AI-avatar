import Database from 'better-sqlite3'
import path from 'path'
import { app } from 'electron'
import { ConversationJsonlAppender } from './conversation-jsonl-appender'

/** 当前数据库 schema 版本，每次有结构变更时递增 */
const CURRENT_SCHEMA_VERSION = 20

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
 * 子分身派发任务记录（v15 引入，2026-05-17）。
 *
 * 一行 = SubAgentManager 派发的一次子任务全生命周期。
 * 与 AgentTaskRow（JSON blob）不同，本表 row-per-task：
 *   - 派发方（调枢等）能枚举"今天派出去了什么"
 *   - 状态机（running → done/error/lost）按行查询有意义
 *   - 应用崩溃后 running 行被 markOrphanRunningAsLost 改为 lost
 *
 * 不持久化 LLM 调用本身（不可恢复执行），仅持久化派发记录用于审计 + UI 展示。
 */
export interface SubAgentTaskRow {
  /** SubAgentManager 生成的 sub-* id（PK） */
  id: string
  /** 派发发生的会话 ID */
  conversation_id: string
  /** 派发方分身 ID（通常是 orchestrator/调枢） */
  parent_avatar_id: string
  /** 跨分身派发的目标分身 ID；同分身派发为 NULL */
  target_avatar: string | null
  /** 任务描述（task() 工具调用时的 task 参数） */
  task: string
  /**
   * 状态机：
   *   - running / done / error 由 SubAgentManager + TypedSubAgentManager 写入
   *   - lost 由 markOrphanRunningAsLost 写入（应用重启时孤儿恢复）
   *   - denied 由 TypedSubAgentManager 写入（SpawnGuard 或 Hook 拒绝 spawn）
   */
  status: 'running' | 'done' | 'error' | 'lost' | 'denied'
  /** done 状态的 LLM 输出；其他状态为 NULL */
  result: string | null
  /** error/lost/denied 状态的描述（denied 时存 denyReason）；其他状态为 NULL */
  error: string | null
  /** 派发开始时间（毫秒） */
  started_at: number
  /** 终态时间（毫秒）；running 状态为 NULL */
  finished_at: number | null
  /**
   * 子代理类型（v16 引入，2026-05-17）。
   *
   * 仅 TypedSubAgentManager 写入：'explore' | 'plan' | 'worker'。
   * 旧 SubAgentManager 派发为 NULL（向后兼容）。未来如果有更多类型，
   * 在 SubAgentType 联合类型上加，sqlite 列本身无 CHECK 约束。
   */
  agent_type: string | null
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
  /** Avatar 内项目分区，`default` 为历史兼容默认值 */
  project_id: string
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
  /** thinking 模型输出的 reasoning_content（仅 assistant 流式产物会带；NULL 表示该消息无思考过程） */
  reasoning_content?: string | null
  /**
   * Deliberation 表达（v17 引入，2026-05-17）。
   *
   * 仅 assistant 角色可能携带——分身在不确信时用 [UNCERTAIN]...[/UNCERTAIN] 标记。
   * sqlite 存 JSON 数组字符串（如 `["这条数据来源不明", "我不太肯定 X"]`）；NULL 等价空。
   * 渲染侧把这些 marker 拆成 chip 显示在消息泡下方，体现"像人一样有犹豫"。
   */
  uncertain_markers?: string | null
  /**
   * Deliberation 表达（v17 引入）：改主意 / 重新考虑。
   *
   * 同上，[RECONSIDER]...[/RECONSIDER] 标记内容；JSON 数组字符串。
   * 与 uncertain 分开存便于按类型过滤；语义不同：uncertain=认知不确定，reconsider=立场更新。
   */
  reconsider_markers?: string | null
  /**
   * 工具调用时间线（v19 引入，2026-05-21）。
   *
   * 仅 assistant 角色会带：sqlite 存 ToolCallTimelineEntry[] 的 JSON 字符串。
   * NULL 等价空数组（多数 assistant 不调工具时无需写入）。
   * 用途：切换会话/重启后渲染每条 assistant 当时的工具调用过程，
   * 而不是全局 transient 状态被清空后丢失。
   */
  tool_call_timeline_json?: string | null
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
  /**
   * 可选的 JSONL 双写器。
   *
   * 注入后 saveMessage 会在 SQLite 事务提交成功后 fire-and-forget 追加一条 JSONL 备份。
   * 不注入（构造时省略参数）则保持纯 SQLite 单写行为，便于单测与向后兼容。
   *
   * 见 .cursor/plans/对手对比融合执行计划_2026-05.plan.md §4.2
   */
  private readonly jsonlAppender?: ConversationJsonlAppender

  /** 高频查询的预编译 Statement 缓存，避免每次调用都重新编译 SQL */
  private stmts!: {
    getConversationsByAvatar: Database.Statement
    getConversationsAll: Database.Statement
    getConversation: Database.Statement
    getMessages: Database.Statement
    getRecentMessages: Database.Statement
    insertMessage: Database.Statement
    updateConversationTime: Database.Statement
    getSetting: Database.Statement
    setSetting: Database.Statement
    searchWithAvatar: Database.Statement
    searchAll: Database.Statement
  }

  constructor(dbPath?: string, jsonlAppender?: ConversationJsonlAppender) {
    const defaultPath = path.join(app.getPath('userData'), 'xiaodu.db')
    this.db = new Database(dbPath || defaultPath)
    this.db.pragma('foreign_keys = ON')
    this.db.pragma('journal_mode = WAL')
    this.initialize()
    this.prepareStatements()
    this.jsonlAppender = jsonlAppender
  }

  /**
   * 暴露原生 better-sqlite3 实例给独立 DAO 模块（如 ScheduleStore）。
   *
   * 设计取舍：DatabaseManager 已逼近 1000 行，不再继续往里塞新表的 CRUD。
   * 独立 DAO 的好处：① 单测可注入 in-memory db；② 模块边界与功能边界对齐。
   * 调用方仅限本仓库 desktop-app/electron/* 下的 DAO 模块，外部不应直接拿到。
   */
  getRawDb(): Database.Database {
    return this.db
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
        // 二级排序用 rowid：saveMessage 用 Date.now() 毫秒时间戳，tool 和 assistant
        // 连续落库（同一 sendMessage 流式回合内）经常同毫秒。仅按 created_at 排序
        // 时同毫秒行的相对顺序由 SQLite 内部实现决定（不稳定），
        // collectDocumentAttachmentsByAssistantId 依赖 tool 出现在 assistant 之前
        // 才能挂到正确的回答上，必须 rowid 兜底单调递增的插入顺序。
        `SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC, rowid ASC`
      ),
      // 只取最近 N 条：idx_messages_conversation 定位会话行，DESC + LIMIT 把跨 IPC 传输的
      // 行数封顶为 N，避免长会话把整段历史读进渲染进程再 slice（见 context-resolver @会话引用）。
      getRecentMessages: this.db.prepare(
        `SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`
      ),
      insertMessage: this.db.prepare(
        `INSERT INTO messages (id, conversation_id, role, content, tool_call_id, image_urls, reasoning_content, uncertain_markers, reconsider_markers, tool_call_timeline_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
               c.avatar_id AS avatarId,
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
               c.avatar_id AS avatarId,
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
        project_id TEXT NOT NULL DEFAULT 'default',
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
        reasoning_content TEXT,
        uncertain_markers TEXT,
        reconsider_markers TEXT,
        tool_call_timeline_json TEXT,
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

    // MCP server 配置表（v6 引入；2026-05-09 #5.5 修复：之前 createBaseSchema 漏建该表，
    // 全新安装会跳过 v5→v6 migration 导致 mcp_servers 缺失，下次列表查询时报 "no such table"。
    // 老用户因走过 v5→v6 migration 而未暴露。这里补回，让全新安装的用户也得到完整 schema）
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

    // 用户自定义定时任务表（v10 引入，2026-05-09 #11 Scheduled Tasks）
    // 与现有 CronScheduler（cron-scheduler.ts）配合：主进程用 croner 解析 cron_expr 调度，
    // 触发时通过 webContents.send('schedule:trigger', ...) 让渲染端调 sendMessage。
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schedules (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        avatar_id TEXT NOT NULL,
        project_id TEXT NOT NULL DEFAULT 'default',
        conversation_id TEXT,
        cron_expr TEXT NOT NULL,
        timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
        prompt_text TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        next_run_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `)
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_schedules_avatar_id
      ON schedules(avatar_id)
    `)
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_schedules_enabled
      ON schedules(enabled)
    `)

    // 调度触发历史表（v10 引入）。
    // 幂等键：UNIQUE(schedule_id, fired_at_utc)，防止同一时刻双触发。
    // 状态语义：running（已开始未完成）/ success / failed / missed（错过未补跑）。
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schedule_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        schedule_id TEXT NOT NULL,
        fired_at_utc INTEGER NOT NULL,
        status TEXT NOT NULL,
        conversation_id TEXT,
        duration_ms INTEGER,
        error_message TEXT,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (schedule_id) REFERENCES schedules(id) ON DELETE CASCADE,
        UNIQUE(schedule_id, fired_at_utc)
      )
    `)
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_schedule_runs_schedule_id
      ON schedule_runs(schedule_id, fired_at_utc DESC)
    `)
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_schedule_runs_status
      ON schedule_runs(status)
    `)

    // Web Embed widget 嵌入配置表（v11 引入，2026-05-09 #15 Web Embed widget）
    // 每条记录代表一个站点嵌入配置：绑定哪个分身、允许哪些 origin、限流阈值等。
    // origin_whitelist 存 JSON 数组字符串；DAO 层硬阻断 wildcard `*`，避免设置面板误存。
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS embeds (
        id TEXT PRIMARY KEY,
        avatar_id TEXT NOT NULL,
        name TEXT NOT NULL,
        origin_whitelist TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        rate_limit_per_min INTEGER NOT NULL DEFAULT 30,
        greeting TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `)
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_embeds_avatar_id
      ON embeds(avatar_id)
    `)
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_embeds_enabled
      ON embeds(enabled)
    `)

    // WebDAV 同步历史表（v12 引入，2026-05-09 #16 WebDAV cross-device sync）。
    // 每行 = 一次同步运行（备份或恢复），用于设置面板展示最近运行情况、
    // 失败诊断与下次增量参考。容量受 SyncHistoryStore.pruneToLimit 控制（默认 30 条）。
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sync_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        direction TEXT NOT NULL,
        status TEXT NOT NULL,
        file_count INTEGER NOT NULL DEFAULT 0,
        total_bytes INTEGER NOT NULL DEFAULT 0,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        remote_filename TEXT,
        error_message TEXT,
        created_at INTEGER NOT NULL
      )
    `)
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_sync_history_created_at
      ON sync_history(created_at DESC)
    `)
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_sync_history_direction_status
      ON sync_history(direction, status)
    `)

    // 答案缓存表（v14 引入，2026-05-13 同问不同答修复）。
    // 同 user content + 同 conversation 上下文哈希 → 复用上次答案，绕过 LLM 调用。
    // 用户可通过"重新生成"按钮 bypass cache 重跑一次。
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS answer_cache (
        cache_key TEXT PRIMARY KEY,
        avatar_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        user_content TEXT NOT NULL,
        assistant_content TEXT NOT NULL,
        reasoning_content TEXT,
        model TEXT,
        created_at INTEGER NOT NULL,
        hit_count INTEGER NOT NULL DEFAULT 0
      )
    `)
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_answer_cache_avatar_conv
      ON answer_cache(avatar_id, conversation_id, created_at DESC)
    `)

    // 子分身派发任务表（v15 引入，2026-05-17：Managed-Agents 借鉴第 1 步——
    // 把 SubAgentManager 内存任务表镜像到 sqlite，使应用重启后能看到派发过的任务及结果）。
    // v16（2026-05-17）：补 agent_type 列，承载 TypedSubAgentManager 的 explore/plan/worker。
    // 不可在崩溃后 resume LLM 调用，仅做审计 + UI 展示。
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sub_agent_tasks (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        parent_avatar_id TEXT NOT NULL,
        target_avatar TEXT,
        task TEXT NOT NULL,
        status TEXT NOT NULL,
        result TEXT,
        error TEXT,
        started_at INTEGER NOT NULL,
        finished_at INTEGER,
        agent_type TEXT,
        FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
      )
    `)
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_sub_agent_tasks_conv
      ON sub_agent_tasks(conversation_id, started_at)
    `)
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_sub_agent_tasks_running
      ON sub_agent_tasks(status) WHERE status = 'running'
    `)

    // v18 projects 表（与 conversations.project_id 字符串保持兼容；projects.name 等于该字符串）。
    // fresh install 必须含此表——否则 list-project-ids / projects:create 等 IPC 报
    // "no such table: projects"，新用户首次打开应用即崩。
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        avatar_id TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        archived INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(avatar_id, name)
      )
    `)
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_projects_avatar ON projects(avatar_id)`)
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

    if (version < 9) {
      // v8 → v9：conversations.project_id（Avatar 内二级项目分区）
      this.db.transaction(() => {
        this.safeAddColumn('conversations', 'project_id', `TEXT NOT NULL DEFAULT 'default'`)
        version = 9
      })()
    }

    if (version < 10) {
      // v9 → v10：新增 schedules + schedule_runs 表（用户自定义定时任务，#11 Scheduled Tasks）
      // FOREIGN KEY ON DELETE CASCADE 在 schedules 删除时自动清理 schedule_runs。
      this.db.transaction(() => {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS schedules (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            avatar_id TEXT NOT NULL,
            project_id TEXT NOT NULL DEFAULT 'default',
            conversation_id TEXT,
            cron_expr TEXT NOT NULL,
            timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
            prompt_text TEXT NOT NULL,
            enabled INTEGER NOT NULL DEFAULT 1,
            next_run_at INTEGER,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
          )
        `)
        this.db.exec(`
          CREATE INDEX IF NOT EXISTS idx_schedules_avatar_id
          ON schedules(avatar_id)
        `)
        this.db.exec(`
          CREATE INDEX IF NOT EXISTS idx_schedules_enabled
          ON schedules(enabled)
        `)
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS schedule_runs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            schedule_id TEXT NOT NULL,
            fired_at_utc INTEGER NOT NULL,
            status TEXT NOT NULL,
            conversation_id TEXT,
            duration_ms INTEGER,
            error_message TEXT,
            created_at INTEGER NOT NULL,
            FOREIGN KEY (schedule_id) REFERENCES schedules(id) ON DELETE CASCADE,
            UNIQUE(schedule_id, fired_at_utc)
          )
        `)
        this.db.exec(`
          CREATE INDEX IF NOT EXISTS idx_schedule_runs_schedule_id
          ON schedule_runs(schedule_id, fired_at_utc DESC)
        `)
        this.db.exec(`
          CREATE INDEX IF NOT EXISTS idx_schedule_runs_status
          ON schedule_runs(status)
        `)
        version = 10
      })()
    }

    if (version < 11) {
      // v10 → v11：新增 embeds 表（Web Embed widget 站点嵌入配置，#15 Web Embed widget）
      // 每行 = 一个站点嵌入：绑定分身、origin 白名单、限流、欢迎语等。
      // 详见主计划 §4.13。
      this.db.transaction(() => {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS embeds (
            id TEXT PRIMARY KEY,
            avatar_id TEXT NOT NULL,
            name TEXT NOT NULL,
            origin_whitelist TEXT NOT NULL,
            enabled INTEGER NOT NULL DEFAULT 1,
            rate_limit_per_min INTEGER NOT NULL DEFAULT 30,
            greeting TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
          )
        `)
        this.db.exec(`
          CREATE INDEX IF NOT EXISTS idx_embeds_avatar_id
          ON embeds(avatar_id)
        `)
        this.db.exec(`
          CREATE INDEX IF NOT EXISTS idx_embeds_enabled
          ON embeds(enabled)
        `)
        version = 11
      })()
    }

    if (version < 12) {
      // v11 → v12：新增 sync_history 表（WebDAV 跨设备同步历史，#16 WebDAV cross-device sync）
      // 每行 = 一次备份/恢复运行的执行结果记录，由 SyncHistoryStore DAO 写入。
      // 表结构与 createBaseSchema 同步，详见 db-sync-history.ts 与主计划 §4.14。
      this.db.transaction(() => {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS sync_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            direction TEXT NOT NULL,
            status TEXT NOT NULL,
            file_count INTEGER NOT NULL DEFAULT 0,
            total_bytes INTEGER NOT NULL DEFAULT 0,
            duration_ms INTEGER NOT NULL DEFAULT 0,
            remote_filename TEXT,
            error_message TEXT,
            created_at INTEGER NOT NULL
          )
        `)
        this.db.exec(`
          CREATE INDEX IF NOT EXISTS idx_sync_history_created_at
          ON sync_history(created_at DESC)
        `)
        this.db.exec(`
          CREATE INDEX IF NOT EXISTS idx_sync_history_direction_status
          ON sync_history(direction, status)
        `)
        version = 12
      })()
    }

    if (version < 13) {
      // v12 → v13：messages 增加 reasoning_content 列（持久化 thinking 模型的思考过程，
      // 让"切换会话回来"也能恢复 reasoning 折叠区，避免内存里 reasoningText 丢失）。
      this.db.transaction(() => {
        this.safeAddColumn('messages', 'reasoning_content', 'TEXT')
        version = 13
      })()
    }

    if (version < 14) {
      // v13 → v14：答案缓存表（同问不同答修复）。
      // 同 user content + 同 conversation 上下文哈希 → 复用上次答案，绕过 LLM 调用。
      // 用户可通过"重新生成"按钮 bypass cache 重跑一次。
      this.db.transaction(() => {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS answer_cache (
            cache_key TEXT PRIMARY KEY,
            avatar_id TEXT NOT NULL,
            conversation_id TEXT NOT NULL,
            user_content TEXT NOT NULL,
            assistant_content TEXT NOT NULL,
            reasoning_content TEXT,
            model TEXT,
            created_at INTEGER NOT NULL,
            hit_count INTEGER NOT NULL DEFAULT 0
          )
        `)
        this.db.exec(`
          CREATE INDEX IF NOT EXISTS idx_answer_cache_avatar_conv
          ON answer_cache(avatar_id, conversation_id, created_at DESC)
        `)
        version = 14
      })()
    }

    if (version < 15) {
      // v14 → v15：子分身派发任务持久化（Managed-Agents 借鉴第 1 步）。
      // SubAgentManager 内存任务表镜像到 sqlite，应用重启后可枚举/展示历史派发。
      this.db.transaction(() => {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS sub_agent_tasks (
            id TEXT PRIMARY KEY,
            conversation_id TEXT NOT NULL,
            parent_avatar_id TEXT NOT NULL,
            target_avatar TEXT,
            task TEXT NOT NULL,
            status TEXT NOT NULL,
            result TEXT,
            error TEXT,
            started_at INTEGER NOT NULL,
            finished_at INTEGER,
            FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
          )
        `)
        this.db.exec(`
          CREATE INDEX IF NOT EXISTS idx_sub_agent_tasks_conv
          ON sub_agent_tasks(conversation_id, started_at)
        `)
        this.db.exec(`
          CREATE INDEX IF NOT EXISTS idx_sub_agent_tasks_running
          ON sub_agent_tasks(status) WHERE status = 'running'
        `)
        version = 15
      })()
    }

    if (version < 16) {
      // v15 → v16：sub_agent_tasks 增加 agent_type 列，承载 TypedSubAgentManager
      // 的 explore/plan/worker。旧 SubAgentManager 派发行 NULL 即可，无需回填。
      this.db.transaction(() => {
        this.safeAddColumn('sub_agent_tasks', 'agent_type', 'TEXT')
        version = 16
      })()
    }

    if (version < 17) {
      // v16 → v17：messages 增加 uncertain_markers + reconsider_markers 列，
      // 承载分身 [UNCERTAIN]/[RECONSIDER] 标记（"像人一样表达犹豫"，Phase 1 of
      // human-cognition extension）。两列存 JSON 数组字符串，NULL 等价空。
      this.db.transaction(() => {
        this.safeAddColumn('messages', 'uncertain_markers', 'TEXT')
        this.safeAddColumn('messages', 'reconsider_markers', 'TEXT')
        version = 17
      })()
    }

    if (version < 18) {
      // v17 → v18：新增 projects 表（分身下的"任务包"实体）。
      // 与 conversations.project_id 字符串保持兼容：projects.name 等于该字符串。
      // 数据迁移：从现有 DISTINCT (avatar_id, project_id) 反推已有 project。
      this.db.transaction(() => {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS projects (
            id TEXT PRIMARY KEY,
            avatar_id TEXT NOT NULL,
            name TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            archived INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            UNIQUE(avatar_id, name)
          )
        `)
        this.db.exec(`CREATE INDEX IF NOT EXISTS idx_projects_avatar ON projects(avatar_id)`)
        const now = Date.now()
        // 反推已有 project：从 conversations 表的 DISTINCT (avatar_id, project_id) 取
        const rows = this.db.prepare(`
          SELECT DISTINCT avatar_id, project_id FROM conversations
          WHERE avatar_id != '' AND project_id != ''
        `).all() as Array<{ avatar_id: string; project_id: string }>
        const insertStmt = this.db.prepare(`
          INSERT OR IGNORE INTO projects (id, avatar_id, name, description, archived, created_at, updated_at)
          VALUES (?, ?, ?, '', 0, ?, ?)
        `)
        // 老 conversations.project_id 可能含 createProject 之外通道写入的脏数据（path
        // 分隔符、..、null byte 等）；原样灌进 projects.name 后被磁盘路径拼接会路径
        // 穿越。校验同 createProject 的正则；非法的把该 (avatar, project_id) 下所有
        // 会话迁到 default 桶，避免会话挂在无法访问的 project name 上。
        const sanitizeConvStmt = this.db.prepare(`
          UPDATE conversations SET project_id = 'default', updated_at = ?
          WHERE avatar_id = ? AND project_id = ?
        `)
        for (const r of rows) {
          // 'default' 是虚拟桶（list-project-ids 固定保留），不作为实体 project 行存在。
          // 与 createProject 拒绝 default 保持一致，避免 ProjectManagerPanel 把它算进
          // 活跃数。conversations.project_id='default' 数据继续留着，不需要迁。
          if (r.project_id === 'default') continue
          if (!/^[\w-]+$/.test(r.project_id)) {
            console.warn(`[v18 migration] 非法 project_id ${JSON.stringify(r.project_id)} (avatar=${r.avatar_id})：会话已迁到 default 桶`)
            sanitizeConvStmt.run(now, r.avatar_id, r.project_id)
            continue
          }
          const id = `proj_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`
          insertStmt.run(id, r.avatar_id, r.project_id, now, now)
        }
        version = 18
      })()
    }

    if (version < 19) {
      // v18 → v19：messages 增加 tool_call_timeline_json 列，承载本条 assistant 消息
      // 关联的工具调用时间线（ToolCallTimelineEntry[] 的 JSON 字符串），让用户切换/重启
      // 后仍能看到每条 assistant 消息当时的工具调用过程。NULL 等价空数组，旧数据兼容。
      // 2026-05-21 用户反馈：切对话后工具调用步骤丢失。
      this.db.transaction(() => {
        this.safeAddColumn('messages', 'tool_call_timeline_json', 'TEXT')
        version = 19
      })()
    }

    if (version < 20) {
      // v19 → v20: 修复已升过 v18 的库里残留的脏 project 数据。
      // v18 早期版本没做正则校验也没跳过 default，留下四类问题：
      //   ① 'default' 被插成实体 project 行（与虚拟桶语义冲突，ProjectManagerPanel 会
      //      把它算进活跃数 + 渲染"保留"占位）
      //   ② 含 ../ / 路径分隔符 / null byte 的 name 行（projects:delete 等会拼到
      //      path.join，路径穿越）
      //   ③ conversations.project_id 有非法值且 projects 表没有对应行（孤儿非法）
      //   ④ conversations.project_id 是合法字符串但 projects 表没行（孤儿合法）——
      //      list-project-ids 只读 projects 表，这种会话在侧栏看不到入口
      // 一次性扫描：①② 清掉脏行 + 会话迁 default；③ 同 ②；④ 补回 projects 行
      // 保留用户分组（workspaces/<name>/ 路径不变，无需迁移）
      this.db.transaction(() => {
        const now = Date.now()
        // ①：删除 default 项目行（不影响 conversations.project_id='default' 数据）
        this.db.prepare(`DELETE FROM projects WHERE name = 'default'`).run()
        // ②：扫描非法 name 行
        const projRows = this.db.prepare(`SELECT id, avatar_id, name FROM projects`).all() as Array<{ id: string; avatar_id: string; name: string }>
        const updateConvStmt = this.db.prepare(`
          UPDATE conversations SET project_id = 'default', updated_at = ?
          WHERE avatar_id = ? AND project_id = ?
        `)
        const deleteProjStmt = this.db.prepare(`DELETE FROM projects WHERE id = ?`)
        for (const r of projRows) {
          if (!/^[\w-]+$/.test(r.name)) {
            updateConvStmt.run(now, r.avatar_id, r.name)
            deleteProjStmt.run(r.id)
            console.warn(`[v20 migration] 清扫非法 project name ${JSON.stringify(r.name)} (avatar=${r.avatar_id})；会话已迁到 default`)
          }
        }
        // ③：扫描非法 project_id 的孤儿会话
        const convRows = this.db.prepare(`
          SELECT DISTINCT avatar_id, project_id FROM conversations
          WHERE project_id != '' AND project_id != 'default'
        `).all() as Array<{ avatar_id: string; project_id: string }>
        for (const r of convRows) {
          if (!/^[\w-]+$/.test(r.project_id)) {
            updateConvStmt.run(now, r.avatar_id, r.project_id)
            console.warn(`[v20 migration] 清扫非法 conversation project_id ${JSON.stringify(r.project_id)} (avatar=${r.avatar_id})；已迁到 default`)
          }
        }
        // ④：合法但 projects 表无对应行的孤儿 project_id → 补 projects 行
        // LEFT JOIN 在 ②③ 清理之后跑，保证只剩合法但缺行的真孤儿
        const orphanLegalRows = this.db.prepare(`
          SELECT DISTINCT c.avatar_id, c.project_id
          FROM conversations c
          LEFT JOIN projects p ON p.avatar_id = c.avatar_id AND p.name = c.project_id
          WHERE c.project_id != '' AND c.project_id != 'default' AND p.id IS NULL
        `).all() as Array<{ avatar_id: string; project_id: string }>
        const insertProjStmt = this.db.prepare(`
          INSERT OR IGNORE INTO projects (id, avatar_id, name, description, archived, created_at, updated_at)
          VALUES (?, ?, ?, '', 0, ?, ?)
        `)
        for (const r of orphanLegalRows) {
          // avatar_id 也走 createProject 同款正则——历史脏数据可能含 ../，
          // 一旦写进 projects 行，后续 rename/delete 用 existing.avatar_id 拼
          // path.join(avatarsPath, existing.avatar_id) 就会路径穿越
          if (/^[\w-]+$/.test(r.project_id) && /^[\w-]+$/.test(r.avatar_id)) {
            const id = `proj_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`
            insertProjStmt.run(id, r.avatar_id, r.project_id, now, now)
            console.warn(`[v20 migration] 补回孤儿 project ${JSON.stringify(r.project_id)} (avatar=${r.avatar_id})；保留用户分组`)
          } else {
            console.warn(`[v20 migration] 跳过孤儿 project ${JSON.stringify(r.project_id)} (avatar=${JSON.stringify(r.avatar_id)})：含非法字符，未补回 projects 行`)
          }
        }
        version = 20
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

  // ─── 子分身派发任务持久化（v15 引入，Managed-Agents 借鉴第 1 步）───────────

  /**
   * UPSERT 一条派发记录。
   *
   * SubAgentManager.onChange 在 running/done/error 三个时刻各调一次：
   *   - 首次调用（running）插入新行
   *   - 后续调用（done/error）按主键覆盖
   * 任何失败都不应阻塞 LLM 主链（调用方负责 try/catch）。
   */
  upsertSubAgentTask(row: SubAgentTaskRow): void {
    this.db.prepare(`
      INSERT INTO sub_agent_tasks (
        id, conversation_id, parent_avatar_id, target_avatar, task,
        status, result, error, started_at, finished_at, agent_type
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        result = excluded.result,
        error = excluded.error,
        finished_at = excluded.finished_at,
        agent_type = excluded.agent_type
    `).run(
      row.id,
      row.conversation_id,
      row.parent_avatar_id,
      row.target_avatar,
      row.task,
      row.status,
      row.result,
      row.error,
      row.started_at,
      row.finished_at,
      row.agent_type,
    )
  }

  /** 列出某会话内的所有派发任务（按发起时间升序）。 */
  listSubAgentTasksByConversation(conversationId: string): SubAgentTaskRow[] {
    return this.db.prepare(`
      SELECT id, conversation_id, parent_avatar_id, target_avatar, task,
             status, result, error, started_at, finished_at, agent_type
      FROM sub_agent_tasks
      WHERE conversation_id = ?
      ORDER BY started_at ASC
    `).all(conversationId) as SubAgentTaskRow[]
  }

  /**
   * 把上次运行残留的 running 行全部置为 lost。
   *
   * 调用时机：Database 构造完成后立刻调一次（main.ts 装配点）。
   * 语义：应用崩溃时正在跑的 LLM 调用无法恢复——我们不再 resume，只把状态改为 lost
   * 让 UI 能展示"曾经派出去但下落不明"。
   *
   * @returns 被标记的行数
   */
  markOrphanRunningAsLost(): number {
    const r = this.db.prepare(`
      UPDATE sub_agent_tasks
      SET status = 'lost',
          error = '应用重启时任务丢失',
          finished_at = ?
      WHERE status = 'running'
    `).run(Date.now())
    return r.changes
  }

  createConversation(title: string, avatarId: string, projectId = 'default'): string {
    const id = `conv_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`
    const now = Date.now()

    this.db.prepare(`
      INSERT INTO conversations (id, title, avatar_id, project_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, title, avatarId, projectId, now, now)

    return id
  }

  /**
   * 列出某分身下侧边栏要展示的项目名（active only），用于侧边栏分组。
   *
   * 之前实现从 conversations 表去重 project_id：
   *   - 新建但还没有会话的 project 不显示
   *   - 归档状态完全不被考虑
   * 修复后改读 projects 表 active rows，与 ProjectManagerPanel 数据源对齐。
   * 历史 default / 旧 project_id 已在 v18 migration 反推插入 projects 表，
   * 因此切换实现无遗漏；新装用户 projects 表为空时由调用方兜底 ['default']。
   */
  listProjectIdsForAvatar(avatarId: string): string[] {
    const rows = this.db.prepare(`
      SELECT name FROM projects
      WHERE avatar_id = ? AND archived = 0
      ORDER BY name
    `).all(avatarId) as Array<{ name: string }>
    return rows.map((r) => r.name)
  }

  /**
   * 原地更新单条消息的 content（仅用于 infographic hiddenRepair 闭环：修正版
   * 渲染结果回写已存的 assistant 消息）。不改 role / created_at / images 等，
   * 也不滚动 conversations.updated_at —— 这是隐藏修正不应该影响"最近活动时间"。
   *
   * 返回受影响行数（0 = messageId 不存在）。
   */
  updateMessageContent(messageId: string, content: string): number {
    const r = this.db.prepare(`UPDATE messages SET content = ? WHERE id = ?`).run(content, messageId)
    return r.changes
  }

  /**
   * 确保指定 ID 的 conversation 存在（已存在则不动）。
   * 用于批量回归：调用方需要用稳定的 conversationId（如 `regression-{runId}-{idx}`）
   * 才能精确过滤遥测事件，普通 createConversation 会重新生成 ID 不满足要求。
   */
  ensureConversation(id: string, title: string, avatarId: string, projectId = 'default'): void {
    const now = Date.now()
    this.db.prepare(`
      INSERT OR IGNORE INTO conversations (id, title, avatar_id, project_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, title, avatarId, projectId, now, now)
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
        this.db.prepare('DELETE FROM sub_agent_tasks WHERE conversation_id = ?').run(row.id)
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

  /** 先显式删除消息（触发 FTS 同步触发器），再删除会话；同时清空 agent_tasks/sub_agent_tasks 与附件元信息 */
  deleteConversation(id: string) {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(id)
      this.db.prepare('DELETE FROM agent_tasks WHERE conversation_id = ?').run(id)
      this.db.prepare('DELETE FROM sub_agent_tasks WHERE conversation_id = ?').run(id)
      this.db.prepare('DELETE FROM attachments WHERE conversation_id = ?').run(id)
      this.db.prepare('DELETE FROM conversations WHERE id = ?').run(id)
    })()
  }

  /** 先显式删除所有关联消息（触发 FTS 同步触发器），再删除会话；同时清空 agent_tasks/sub_agent_tasks 与附件元信息 */
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
        DELETE FROM sub_agent_tasks WHERE conversation_id IN (
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
  saveMessage(
    conversationId: string,
    role: 'user' | 'assistant' | 'tool',
    content: string,
    toolCallId?: string,
    imageUrls?: string[],
    /** thinking 模型流式产物。仅 assistant 角色会传；空串/undefined 统一存 NULL，避免空字段干扰检索。 */
    reasoning?: string,
    /** v17：assistant 的 [UNCERTAIN] 标记内容数组（已去重 + 截断由 chatStore 负责）；空数组等价 NULL */
    uncertainMarkers?: string[],
    /** v17：assistant 的 [RECONSIDER] 标记内容数组；空数组等价 NULL */
    reconsiderMarkers?: string[],
    /**
     * v19：assistant 关联的工具调用时间线 JSON 字符串。
     * 由 chatStore 在落盘前 JSON.stringify(ToolCallTimelineEntry[]) 得到。
     * 空数组（"[]"）等价 NULL，不写入；保持 DB 行干净，节省存储。
     */
    toolCallTimelineJson?: string,
    /**
     * 可选外部 ID：chatStore 在 sendMessage 入口 nextMessageId() 时已生成一个
     * assistantMsgId，并塞进 state.messages 占位气泡。如果不传 externalId 这里
     * 重新生成，前后端 ID 就分叉（state=msg-xxx, DB=msg_xxx）—— hidden repair
     * 的 updateMessageContent(assistantMsgId, ...) 永远更新 0 行。传 externalId
     * 让 DB 复用同一 ID，保证前后端可互相寻址。
     */
    externalId?: string,
  ): string {
    const id = externalId && externalId.length > 0
      ? externalId
      : `msg_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`
    const now = Date.now()
    const reasoningValue = reasoning && reasoning.trim().length > 0 ? reasoning : null
    const uncertainValue = uncertainMarkers && uncertainMarkers.length > 0 ? JSON.stringify(uncertainMarkers) : null
    const reconsiderValue = reconsiderMarkers && reconsiderMarkers.length > 0 ? JSON.stringify(reconsiderMarkers) : null
    const timelineValue = toolCallTimelineJson && toolCallTimelineJson !== '[]' && toolCallTimelineJson.length > 0 ? toolCallTimelineJson : null
    // JSONL 双写沿用解码形态：把工具时间线 JSON 解析回数组（同 uncertainMarkers），
    // 让离线恢复 / 事件重建能直接读到 assistant 的工具调用过程。timelineValue 源自
    // chatStore 的 JSON.stringify，正常可解析；异常仅降级为 null，绝不影响 SQLite 主存储。
    let timelineDecoded: unknown[] | null = null
    if (timelineValue) {
      try {
        const parsed = JSON.parse(timelineValue)
        if (Array.isArray(parsed)) timelineDecoded = parsed
      } catch { timelineDecoded = null }
    }

    // 使用事务保证消息写入和会话更新时间原子一致，避免部分成功导致数据不一致。
    const saveTx = this.db.transaction(() => {
      this.stmts.insertMessage.run(
        id, conversationId, role, content,
        toolCallId ?? null,
        imageUrls ? JSON.stringify(imageUrls) : null,
        reasoningValue,
        uncertainValue,
        reconsiderValue,
        timelineValue,
        now,
      )
      this.stmts.updateConversationTime.run(now, conversationId)
    })
    saveTx()

    // SQLite 主存储已成功提交后，再把同一条消息异步追加到 JSONL 双写文件。
    // 必须放在事务外：appender 走 fs.promises 异步 IO，不能阻塞 SQLite 事务也不能让其失败回滚。
    // 不 await：appender.append 内部已 try/catch + logger.warn 兜底（Promise 永不 reject），
    // 直接 fire-and-forget 即可保持 saveMessage 同步签名与 IPC 响应延迟。
    void this.jsonlAppender?.append(conversationId, {
      id,
      conversationId,
      role,
      content,
      toolCallId: toolCallId ?? null,
      imageUrls: imageUrls ?? null,
      reasoningContent: reasoningValue,
      uncertainMarkers: uncertainMarkers && uncertainMarkers.length > 0 ? uncertainMarkers : null,
      reconsiderMarkers: reconsiderMarkers && reconsiderMarkers.length > 0 ? reconsiderMarkers : null,
      toolCallTimeline: timelineDecoded,
      ts: now,
    })

    return id
  }

  getMessages(conversationId: string): Message[] {
    return this.stmts.getMessages.all(conversationId) as Message[]
  }

  /**
   * 只取会话最近 limit 条消息，按时间升序返回（与 getMessages 顺序一致）。
   * SQL 用 DESC + LIMIT 取最新的，再在内存里反转回 ASC，避免长会话全量读取。
   */
  getRecentMessages(conversationId: string, limit: number): Message[] {
    const safeLimit = Math.max(1, Math.min(500, Math.floor(limit) || 1))
    const rows = this.stmts.getRecentMessages.all(conversationId, safeLimit) as Message[]
    return rows.reverse()
  }

  /**
   * 删除单条消息（v14，「重新生成」按钮专用）。
   * 返回删除条数；不存在时返回 0，调用方据此判断是否需要刷新 UI。
   */
  deleteMessage(messageId: string): number {
    const result = this.db.prepare('DELETE FROM messages WHERE id = ?').run(messageId)
    return result.changes
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

  // ─── Projects（任务包，v18）──────────────────────────────────────────────

  /** 列出某分身下的所有 project（archived 排在后）；不传 avatarId 返回全部 */
  listProjects(avatarId?: string): Array<{
    id: string
    avatar_id: string
    name: string
    description: string
    archived: 0 | 1
    created_at: number
    updated_at: number
    conversation_count: number
  }> {
    const where = avatarId ? 'WHERE p.avatar_id = ?' : ''
    const args = avatarId ? [avatarId] : []
    return this.db.prepare(`
      SELECT p.*,
        (SELECT COUNT(*) FROM conversations c WHERE c.avatar_id = p.avatar_id AND c.project_id = p.name) AS conversation_count
      FROM projects p
      ${where}
      ORDER BY p.archived ASC, p.updated_at DESC
    `).all(...args) as Array<{
      id: string; avatar_id: string; name: string; description: string;
      archived: 0 | 1; created_at: number; updated_at: number; conversation_count: number
    }>
  }

  /** 按 id 取单个 project */
  getProject(id: string): { id: string; avatar_id: string; name: string; description: string; archived: 0 | 1; created_at: number; updated_at: number } | undefined {
    const row = this.db.prepare(`SELECT * FROM projects WHERE id = ?`).get(id) as
      | { id: string; avatar_id: string; name: string; description: string; archived: 0 | 1; created_at: number; updated_at: number }
      | undefined
    return row
  }

  /** 创建 project；name 必须在 avatar 内唯一 */
  createProject(avatarId: string, name: string, description = ''): string {
    if (!avatarId) throw new Error('avatarId 必填')
    if (!/^[\w-]+$/.test(name)) throw new Error('project name 仅允许字母数字下划线连字符')
    // 'default' 是"未归属任何任务包"的虚拟桶（参见 list-project-ids 兜底逻辑），
    // 不允许作为真实 project 行存在，否则 UI/DB 语义会冲突
    if (name === 'default') throw new Error('"default" 是保留名，不能作为项目名创建')
    const id = `proj_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`
    const now = Date.now()
    try {
      this.db.prepare(`
        INSERT INTO projects (id, avatar_id, name, description, archived, created_at, updated_at)
        VALUES (?, ?, ?, ?, 0, ?, ?)
      `).run(id, avatarId, name, description, now, now)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('UNIQUE')) throw new Error(`project "${name}" 已存在`)
      throw err
    }
    return id
  }

  /** 更新 project（rename 时同步迁移 conversations.project_id） */
  updateProject(id: string, patch: { name?: string; description?: string }): void {
    const existing = this.getProject(id)
    if (!existing) throw new Error(`project 不存在: ${id}`)
    // 'default' 是保留名，既不能改它的 name/description，也不能 rename 任何项目到 default
    if (existing.name === 'default') throw new Error('"default" 是保留项目桶，不能编辑')
    const sets: string[] = []
    const args: unknown[] = []
    let newName = existing.name
    if (patch.name !== undefined && patch.name !== existing.name) {
      if (!/^[\w-]+$/.test(patch.name)) throw new Error('project name 仅允许字母数字下划线连字符')
      if (patch.name === 'default') throw new Error('"default" 是保留名，不能 rename 到 default')
      sets.push('name = ?')
      args.push(patch.name)
      newName = patch.name
    }
    if (patch.description !== undefined) {
      sets.push('description = ?')
      args.push(patch.description)
    }
    if (sets.length === 0) return
    sets.push('updated_at = ?')
    args.push(Date.now())
    args.push(id)
    this.db.transaction(() => {
      this.db.prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`).run(...args)
      if (newName !== existing.name) {
        // 同步迁移 conversations.project_id（rename 不破坏既有归属）
        this.db.prepare(`
          UPDATE conversations SET project_id = ?, updated_at = ?
          WHERE avatar_id = ? AND project_id = ?
        `).run(newName, Date.now(), existing.avatar_id, existing.name)
      }
    })()
  }

  /** 归档 / 取消归档 project（不删除数据） */
  archiveProject(id: string, archived: boolean): void {
    const existing = this.getProject(id)
    if (existing?.name === 'default') throw new Error('"default" 是保留项目桶，不能归档')
    this.db.prepare(`UPDATE projects SET archived = ?, updated_at = ? WHERE id = ?`)
      .run(archived ? 1 : 0, Date.now(), id)
  }

  /**
   * 删除 project。
   * options.migrateConversationsTo: 把该 project 下会话迁到目标 project name（默认 'default'）。
   * 不传则迁到 'default'，不允许硬删会话。
   */
  deleteProject(id: string, options: { migrateConversationsTo?: string } = {}): void {
    const existing = this.getProject(id)
    if (!existing) return
    if (existing.name === 'default') throw new Error('"default" 是保留项目桶，不能删除')
    const target = options.migrateConversationsTo ?? 'default'
    // target 不能指向正在被删的项目自身：否则下面 UPDATE 把会话 project_id 改成
    // existing.name（其实没改），紧接 DELETE projects WHERE id 把这个 project 行
    // 删了，会话就挂在一个不存在的 project name 上。UI 已过滤 self，但 IPC/未来
    // 代码传错值会触发。
    if (target === existing.name) {
      throw new Error(`migrateConversationsTo 不能指向正在删除的项目自身：${target}`)
    }
    // 校验 target：必须是 'default' 或同 avatar 下未归档 project；UI 已限制，
    // 但 IPC/未来代码传错值会把会话迁到不存在的 project，sidebar 看不到 = 相当于丢失。
    if (target !== 'default') {
      const valid = this.db.prepare(`
        SELECT 1 FROM projects WHERE avatar_id = ? AND name = ? AND archived = 0
      `).get(existing.avatar_id, target)
      if (!valid) {
        throw new Error(`migrateConversationsTo 目标不存在或已归档：${target}（必须是 default 或同 avatar 下未归档项目）`)
      }
    }
    this.db.transaction(() => {
      this.db.prepare(`
        UPDATE conversations SET project_id = ?, updated_at = ?
        WHERE avatar_id = ? AND project_id = ?
      `).run(target, Date.now(), existing.avatar_id, existing.name)
      this.db.prepare(`DELETE FROM projects WHERE id = ?`).run(id)
    })()
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
   * 解除某条消息上所有附件的关联（message_id 置空），供「重新生成」删除原 user 消息前调用。
   * attachments 表对 message_id 无外键（只有 conversation_id CASCADE），删消息不清 message_id；
   * 不先解绑的话重发时 linkAttachmentToMessage（只认 message_id IS NULL 的行）无法把附件迁到
   * 新 user 消息，刷新后会丢 chip。附件行本身保留（文件仍在盘上），等重发重新关联。
   *
   * @returns 实际更新的行数
   */
  unlinkAttachmentsFromMessage(messageId: string, conversationId: string): number {
    const result = this.db
      .prepare('UPDATE attachments SET message_id = NULL WHERE message_id = ? AND conversation_id = ?')
      .run(messageId, conversationId)
    return result.changes
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

  // ─── 答案缓存（v14 引入，同问不同答修复）────────────────────────────────
  // 命中 cache → 跳过 LLM 调用直接返回上次答案，解决 DeepSeek temperature=0 + seed
  // 仍非严格 deterministic 的问题。重新生成按钮可 bypass cache 重跑。

  getCachedAnswer(cacheKey: string): {
    assistantContent: string
    reasoningContent: string | null
    model: string | null
  } | null {
    const row = this.db
      .prepare(
        'SELECT assistant_content, reasoning_content, model FROM answer_cache WHERE cache_key = ?',
      )
      .get(cacheKey) as
      | { assistant_content: string; reasoning_content: string | null; model: string | null }
      | undefined
    if (!row) return null
    // 命中计数 + 1，方便后续诊断/UI 展示
    this.db
      .prepare('UPDATE answer_cache SET hit_count = hit_count + 1 WHERE cache_key = ?')
      .run(cacheKey)
    return {
      assistantContent: row.assistant_content,
      reasoningContent: row.reasoning_content,
      model: row.model,
    }
  }

  saveCachedAnswer(params: {
    cacheKey: string
    avatarId: string
    conversationId: string
    userContent: string
    assistantContent: string
    reasoningContent?: string | null
    model?: string | null
  }): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO answer_cache
          (cache_key, avatar_id, conversation_id, user_content, assistant_content,
           reasoning_content, model, created_at, hit_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      )
      .run(
        params.cacheKey,
        params.avatarId,
        params.conversationId,
        params.userContent,
        params.assistantContent,
        params.reasoningContent ?? null,
        params.model ?? null,
        Date.now(),
      )
  }

  /** 删除单个 cache（用户「重新生成」时清掉对应条目，下次写新答案） */
  deleteCachedAnswer(cacheKey: string): number {
    const result = this.db
      .prepare('DELETE FROM answer_cache WHERE cache_key = ?')
      .run(cacheKey)
    return result.changes
  }

  /** 删除该会话所有 cache（会话清空 / 删除时调用） */
  deleteCachedAnswersByConversation(conversationId: string): number {
    const result = this.db
      .prepare('DELETE FROM answer_cache WHERE conversation_id = ?')
      .run(conversationId)
    return result.changes
  }
}
