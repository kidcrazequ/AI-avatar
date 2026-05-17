/**
 * 会话 JSONL 事件读取器（v17 引入，2026-05-17：event viewer 主进程支撑）。
 *
 * 读 <userData>/conversations/<conversationId>.jsonl，按行 JSON.parse，
 * 用 type 字段归一化为 ConversationJsonlAnyEvent 联合：
 *   - 缺 type 但带 role 的旧消息行 → 补 type='message'
 *   - 已带 type 的新事件行 → 原样保留
 *   - 解析失败的行 → 跳过 + parseErrors 计数，不抛
 *   - 文件不存在 → 返回空数组（events=[], parseErrors=0）
 *
 * 设计要点：
 *   - 整文件 readFile 而不是流式：会话 JSONL 单文件预期 <几 MB，整读简单且足够
 *   - 容错：单行损坏不污染整次读取——chat 流程中任何单事件失败仅 warn，主链不挂
 *   - 不做任何写入：纯 read，配合 ConversationJsonlAppender 双侧
 *
 * @author zhi.qu
 * @date 2026-05-17
 */

import fs from 'node:fs'
import path from 'node:path'
import { assertSafeSegment } from '@soul/core'
import type {
  ConversationJsonlAnyEvent,
  ConversationJsonlRecord,
} from './conversation-jsonl-appender'

/** reader 返回结构：事件列表 + 解析失败计数（不影响成功事件） */
export interface ReadEventsResult {
  events: ConversationJsonlAnyEvent[]
  /** 损坏/无法解析的行数 */
  parseErrors: number
}

/**
 * 最小化的 warn 日志接口——与 ConversationJsonlAppender 同型，
 * 让单测可注入 fake、生产侧由 main.ts 适配真 Logger。
 */
export interface EventReaderLogger {
  warn(msg: string, err?: unknown): void
}

/**
 * 已知的 typed event 类型集合，用于判别 type 字段是否合法——
 * 不在集合内的字符串视为未知 type，按 message 兜底解析失败。
 *
 * 与 ConversationJsonlAnyEvent 的 type 字段保持一致。
 */
const KNOWN_TYPED_EVENTS = new Set([
  'message',
  'conversation_started',
  'memory_update',
  'model_switch',
  'mode_switch',
  'sub_agent_task',
])

/**
 * 读取一个会话的所有事件。
 *
 * @param userDataDir 应用 userData 根目录（绝对路径）
 * @param conversationId 会话 ID（assertSafeSegment 拦截路径穿越）
 * @param logger 可选 warn 日志接口；单行解析失败仅在此 warn，不抛
 */
export async function readConversationEvents(
  userDataDir: string,
  conversationId: string,
  logger?: EventReaderLogger,
): Promise<ReadEventsResult> {
  assertSafeSegment(conversationId, 'conversationId')

  const file = path.join(userDataDir, 'conversations', `${conversationId}.jsonl`)

  let raw: string
  try {
    raw = await fs.promises.readFile(file, 'utf-8')
  } catch (err) {
    // 文件不存在是常见情况（v17 前的旧会话 / 从未写入过的新会话）——静默返回空，
    // 仅在非 ENOENT 时 warn（权限错误等真实异常）
    const code = (err as NodeJS.ErrnoException)?.code
    if (code !== 'ENOENT' && logger) {
      logger.warn('[ConversationEventReader] readFile 失败', err)
    }
    return { events: [], parseErrors: 0 }
  }

  const events: ConversationJsonlAnyEvent[] = []
  let parseErrors = 0

  for (const line of raw.split('\n')) {
    if (line.length === 0) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      parseErrors++
      // 单行损坏只 warn 一次；多行损坏 caller 通过 parseErrors 看总数
      continue
    }
    const norm = normalizeEvent(parsed)
    if (!norm) {
      parseErrors++
      continue
    }
    events.push(norm)
  }

  if (parseErrors > 0 && logger) {
    logger.warn(`[ConversationEventReader] ${conversationId} 有 ${parseErrors} 行解析失败已跳过`)
  }

  return { events, parseErrors }
}

/**
 * 把单行 parsed JSON 归一化为 ConversationJsonlAnyEvent。
 * 不合法返回 null（外层计入 parseErrors）。
 *
 * 关键路径：
 *   - 已有合法 type 字段 → 直接 cast
 *   - 没有 type 但有 role 字段 → 旧 ConversationJsonlRecord，补 type='message'
 *   - 否则 → null（垃圾行 / 未知 schema）
 */
function normalizeEvent(parsed: unknown): ConversationJsonlAnyEvent | null {
  if (!parsed || typeof parsed !== 'object') return null
  const obj = parsed as Record<string, unknown>

  if (typeof obj.type === 'string') {
    if (!KNOWN_TYPED_EVENTS.has(obj.type)) return null
    // 类型签名校验由调用方在使用时做窄化；这里假定上游 writer 写入字段完整
    return obj as unknown as ConversationJsonlAnyEvent
  }

  // 旧消息行：无 type 但有 role
  if (typeof obj.role === 'string' && typeof obj.id === 'string' && typeof obj.content === 'string') {
    const msg: ConversationJsonlRecord & { type: 'message' } = {
      ...(obj as unknown as ConversationJsonlRecord),
      type: 'message',
    }
    return msg
  }

  return null
}
