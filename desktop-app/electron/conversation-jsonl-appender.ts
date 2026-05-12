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
}
