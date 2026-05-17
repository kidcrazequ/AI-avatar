/**
 * 对话消息 JSONL 双写器
 *
 * 作为 SQLite 主存储的冗余备份，将每条消息追加写入
 * <userData>/conversations/<conversationId>.jsonl
 *
 * 设计原则：
 * - 异步追加，不阻塞 SQLite 主存储
 * - 写入失败仅 warn，绝不抛（避免冗余备份反过来影响主链路）
 * - 路径段校验防止目录穿越（assertSafeSegment 失败例外抛出）
 *
 * 注意：本类不直接复用 ./logger.ts 的 Logger 类型。
 * 真实 Logger 的 warn 语义由 logEvent('warn', ...) 间接承担，
 * 这里只声明一个最小的结构化接口 JsonlAppenderLogger，
 * 调用方（database.ts 等）可在注入时自行适配，方便单测注入 fake。
 *
 * @author zhi.qu
 * @date 2026-05-09
 */

import fs from 'node:fs'
import path from 'node:path'
import { assertSafeSegment } from '@soul/core'

/**
 * 最小化的结构化 warn 日志接口。
 *
 * 仅要求实现 warn(msg, err?)。真实 Logger 实例可通过简单适配器满足，
 * 单测可直接 implements 这个接口的 FakeLogger。
 */
export interface JsonlAppenderLogger {
  warn(msg: string, err?: unknown): void
}

/**
 * 对话消息单行 JSONL 结构。
 *
 * 字段与 SQLite messages 表对齐，便于离线脚本按行解析重建对话历史；
 * conversationId 冗余写入，使脚本不必依赖文件名也能定位归属。
 */
export interface ConversationJsonlRecord {
  /** 消息 id（与 SQLite 主存储一致，用作幂等键） */
  id: string
  /** 冗余写入会话 ID，便于离线解析时不依赖文件名 */
  conversationId: string
  /** 消息角色 */
  role: 'user' | 'assistant' | 'tool'
  /** 消息文本内容（已渲染） */
  content: string
  /** tool 角色对应的调用 id，user/assistant 通常为 null */
  toolCallId?: string | null
  /** 消息附带的图片 URL 列表（可能为空） */
  imageUrls?: string[] | null
  /** thinking 模型 reasoning_content（仅 assistant；NULL 表示该消息无思考过程） */
  reasoningContent?: string | null
  /** 写入时间戳（毫秒） */
  ts: number
}

/**
 * 子分身派发事件 JSONL 结构（v15 引入，Managed-Agents 借鉴第 1 步；v16 拓展 typed 字段）。
 *
 * 与 ConversationJsonlRecord 写到同一个会话文件，靠 `type: 'sub_agent_task'` 区分；
 * 离线解析时按 type 分流即可。事件粒度 = SubAgent[Typed]Manager 状态变更。
 *
 * 不存 result 全文（避免单行过大），完整 result 留在 sqlite。JSONL 只做事件流审计。
 */
export interface SubAgentJsonlEvent {
  /** 固定 'sub_agent_task'，离线解析按此 dispatcher 分流 */
  type: 'sub_agent_task'
  /** 派发任务 id（与 sqlite sub_agent_tasks.id 一致） */
  taskId: string
  /** 冗余写入会话 ID */
  conversationId: string
  /**
   * 当前事件对应的状态：
   *   - running/done/error 由两类 manager 都会产生
   *   - lost 由 markOrphanRunningAsLost 写入（应用重启时孤儿恢复，不走 JSONL，仅留作类型完整）
   *   - denied 由 TypedSubAgentManager 写入（SpawnGuard/Hook 拒绝）
   */
  status: 'running' | 'done' | 'error' | 'lost' | 'denied'
  /** 派发方分身 ID */
  parentAvatarId: string
  /** 跨分身派发的目标；同分身派发为 null */
  targetAvatar?: string | null
  /** 任务描述（截断到 ~500 字符防止单行过大） */
  taskPreview: string
  /** error/lost 状态的错误描述 */
  error?: string | null
  /**
   * 子代理类型（v16 引入）：'explore' | 'plan' | 'worker'。
   * 旧 SubAgentManager 派发为 undefined；TypedSubAgentManager 一定有。
   */
  agentType?: string | null
  /** denied 状态时的拒绝原因（SpawnGuard.reason 或 hook.deny.reason） */
  denyReason?: string | null
  /** 事件时间戳（毫秒） */
  ts: number
}

/**
 * 记忆更新事件（v17 引入，2026-05-17：JSONL 升 event 日志方案 B）。
 *
 * [MEMORY_UPDATE]...[/MEMORY_UPDATE] 标签触发的 MEMORY.md 改写当前完全不可溯源——
 * 调试 memory 行为只能 git diff。本事件捕获每次 chat-driven 写入的元信息（不含正文，
 * 避免单行过大；正文本身在 MEMORY.md 里）。
 *
 * 注意：用户在 MemoryPanel 手动编辑 MEMORY.md 不会产生此事件——只有 chatStore 派生写入会。
 */
export interface MemoryUpdateJsonlEvent {
  type: 'memory_update'
  conversationId: string
  avatarId: string
  /** 本次合入的条目数（memUpdates.length） */
  updateCount: number
  /** 本次合入内容的截断预览（最多 500 字符，便于离线查看不必读 MEMORY.md） */
  summaryPreview: string
  /** 写入后 MEMORY.md 的总字节数（粗略容量审计） */
  totalByteSize: number
  /** 是否触发了 consolidate（容量超限时 LLM 整理） */
  consolidated: boolean
  ts: number
}

/**
 * 会话模型切换事件（v17 引入）。
 *
 * 用户在 ChatWindow 顶栏循环切换 conversationModelOverride 时产生。
 * 让"这一轮回答用的哪个模型"事后可查——尤其是排查"为什么这个会话回答风格突然变了"。
 */
export interface ModelSwitchJsonlEvent {
  type: 'model_switch'
  conversationId: string
  /** 切换前的 override（null 表示用分身 default 或 chat slot） */
  fromModel: string | null
  /** 切换后的 override（null 表示重置为 default） */
  toModel: string | null
  ts: number
}

/**
 * 会话工具模式切换事件（v17 后续补，2026-05-17）。
 *
 * Ask / Plan / Agent 三档影响工具放行策略（灰名单 / 写操作准入）。
 * 排查"为什么这一轮明明用了写工具却没生效"的时候，需要看当时模式是不是 Ask。
 * chatStore.setMode 已有"同档不刷新"短路，所以本事件只在真实切换时落盘。
 */
export interface ModeSwitchJsonlEvent {
  type: 'mode_switch'
  conversationId: string
  fromMode: 'agent' | 'plan' | 'ask'
  toMode: 'agent' | 'plan' | 'ask'
  ts: number
}

/**
 * 会话创建事件（v17 后续补）。
 *
 * 由 create-conversation IPC 处理器在 db.createConversation 成功后写入。
 * 让 JSONL 自身能定位"这个文件对应的会话最初什么时候创建的、谁创建的"——
 * 不依赖 sqlite 也能从 JSONL 重建基础元信息，是单文件可读性的基石。
 *
 * 注意：regression-ensure-conversation 等测试脚手架路径不产生此事件。
 */
export interface ConversationStartedJsonlEvent {
  type: 'conversation_started'
  conversationId: string
  avatarId: string
  /** Avatar 内项目分区（default 为默认值） */
  projectId: string
  /** 创建时的会话标题 */
  title: string
  ts: number
}

/**
 * 离线/读路径专用：消息事件的"已归一化"形态——
 * 旧版 ConversationJsonlRecord 没有 type 字段，reader 解析时统一补上 `type: 'message'`，
 * 方便下游用 switch(event.type) 走判别式联合。
 */
export interface ConversationJsonlMessageEvent extends ConversationJsonlRecord {
  type: 'message'
}

/**
 * 会话 JSONL 离散事件的判别式联合（v17，2026-05-17：event viewer）。
 *
 * 用 type 字段判别：
 *   - 'message'              — 历史/新消息（旧文件 type 缺失，由 reader 归一化补齐）
 *   - 'conversation_started' — 创建会话
 *   - 'memory_update'        — chat-driven 记忆改写
 *   - 'model_switch'         — 模型 override 切换
 *   - 'mode_switch'          — 工具模式切换
 *   - 'sub_agent_task'       — 子分身派发各状态
 */
export type ConversationJsonlAnyEvent =
  | ConversationJsonlMessageEvent
  | ConversationStartedJsonlEvent
  | MemoryUpdateJsonlEvent
  | ModelSwitchJsonlEvent
  | ModeSwitchJsonlEvent
  | SubAgentJsonlEvent

/**
 * 单例 JSONL 双写器。
 *
 * 首次 getInstance 决定 userDataDir / logger，后续调用复用同一实例；
 * 单测场景需要切换不同 userDataDir / logger 时，配合 __resetForTesting 使用。
 */
export class ConversationJsonlAppender {
  private static instance: ConversationJsonlAppender | null = null

  private constructor(
    private readonly userDataDir: string,
    private readonly logger: JsonlAppenderLogger,
  ) {}

  /**
   * 获取（或首次创建）单例实例。
   *
   * @param userDataDir 应用 userData 根目录（绝对路径）
   * @param logger      结构化 warn 日志接口实现（用于写失败时上报）
   */
  static getInstance(userDataDir: string, logger: JsonlAppenderLogger): ConversationJsonlAppender {
    if (!ConversationJsonlAppender.instance) {
      ConversationJsonlAppender.instance = new ConversationJsonlAppender(userDataDir, logger)
    }
    return ConversationJsonlAppender.instance
  }

  /**
   * 仅供单测使用：重置单例，使下一次 getInstance 重新创建实例。
   * 命名带 __ 前缀提示生产代码禁止调用。
   */
  static __resetForTesting(): void {
    ConversationJsonlAppender.instance = null
  }

  /**
   * 追加一条消息到 <userDataDir>/conversations/<conversationId>.jsonl。
   *
   * 流程：
   *   1. assertSafeSegment 校验 conversationId（路径穿越/空值必须显式抛）
   *   2. 异步 mkdir -p 保证目录存在
   *   3. 异步 appendFile 写入一行 JSON + '\n'
   *
   * 仅第 1 步会抛；2/3 步任何异常都仅 logger.warn，绝不抛——避免冗余备份反过来阻塞 SQLite 主存储。
   *
   * @param conversationId 会话 ID（必须是单一安全段，不允许包含 / \ .. 或为空）
   * @param record         待写入的消息记录
   */
  async append(conversationId: string, record: ConversationJsonlRecord): Promise<void> {
    assertSafeSegment(conversationId, 'conversationId')

    try {
      const dir = path.join(this.userDataDir, 'conversations')
      const file = path.join(dir, `${conversationId}.jsonl`)
      await fs.promises.mkdir(dir, { recursive: true })
      await fs.promises.appendFile(file, JSON.stringify(record) + '\n', 'utf-8')
    } catch (err) {
      this.logger.warn('[ConversationJsonlAppender] append 失败:', err)
    }
  }

  /**
   * 追加一条子分身派发事件到同一个会话 JSONL 文件。
   *
   * 与 append() 共用文件，靠记录的 type 字段区分；fire-and-forget，绝不抛——
   * 子分身派发链路不能因为冗余备份失败而中断。
   *
   * 调用方（database.ts / main.ts 装配点）负责构造事件，本方法仅做安全写入。
   */
  async appendSubAgentEvent(conversationId: string, event: SubAgentJsonlEvent): Promise<void> {
    await this.appendTypedEvent(conversationId, event, 'appendSubAgentEvent')
  }

  /**
   * 追加一条记忆更新事件（v17：JSONL 升 event 日志方案 B 之一）。
   *
   * 仅 chat-driven 路径（chatStore.extractMemoryUpdates → writeMemory）产生本事件，
   * 用户手动编辑 MEMORY.md 不会触发。
   */
  async appendMemoryUpdateEvent(conversationId: string, event: MemoryUpdateJsonlEvent): Promise<void> {
    await this.appendTypedEvent(conversationId, event, 'appendMemoryUpdateEvent')
  }

  /**
   * 追加一条会话模型切换事件（v17：JSONL 升 event 日志方案 B 之一）。
   *
   * 由 chatStore.setConversationModel 触发——fromModel 是切换前的 override，
   * toModel 是切换后的 override；任一为 null 表示"重置为分身 default"。
   */
  async appendModelSwitchEvent(conversationId: string, event: ModelSwitchJsonlEvent): Promise<void> {
    await this.appendTypedEvent(conversationId, event, 'appendModelSwitchEvent')
  }

  /**
   * 追加一条会话工具模式切换事件（v17 后续补）。
   *
   * 由 chatStore.setMode 触发——chatStore 已有"同档不刷新"短路，所以本方法只在
   * 真实切换时被调用。fromMode/toMode 必为合法三档之一（agent/plan/ask）。
   */
  async appendModeSwitchEvent(conversationId: string, event: ModeSwitchJsonlEvent): Promise<void> {
    await this.appendTypedEvent(conversationId, event, 'appendModeSwitchEvent')
  }

  /**
   * 追加一条会话创建事件（v17 后续补）。
   *
   * 由 create-conversation IPC 处理器在 db.createConversation 成功后写入；
   * regression-ensure-conversation 等测试脚手架路径不产生此事件。
   */
  async appendConversationStartedEvent(
    conversationId: string,
    event: ConversationStartedJsonlEvent,
  ): Promise<void> {
    await this.appendTypedEvent(conversationId, event, 'appendConversationStartedEvent')
  }

  /**
   * 通用事件追加私有实现——抽离 mkdir + appendFile 同形逻辑，消除复制粘贴。
   *
   * 所有公共 appendXxxEvent 方法都委托到这里；method 名仅用于日志可读性。
   * conversationId 走 assertSafeSegment（路径穿越必抛），其余路径错误一律 warn 不抛。
   */
  private async appendTypedEvent(
    conversationId: string,
    event: { type: string },
    method: string,
  ): Promise<void> {
    assertSafeSegment(conversationId, 'conversationId')

    try {
      const dir = path.join(this.userDataDir, 'conversations')
      const file = path.join(dir, `${conversationId}.jsonl`)
      await fs.promises.mkdir(dir, { recursive: true })
      await fs.promises.appendFile(file, JSON.stringify(event) + '\n', 'utf-8')
    } catch (err) {
      this.logger.warn(`[ConversationJsonlAppender] ${method} 失败:`, err)
    }
  }
}
