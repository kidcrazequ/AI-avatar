/**
 * 对话情景记忆（Conversation Episode）类型（v17，Phase 2a of human-cognition extension）。
 *
 * 与 Life Experience 的"想象人生事件"对偶——本文件描述的是"和用户的真实对话浓缩"，
 * 让分身在被问"上次我们聊过 X"时能"翻"出过去的会话。
 *
 * 落盘形态：`avatars/<avatarId>/memory/episodes/<conversationId>.json`，
 * 一会话一文件，包含一个 ConversationEpisode 实例。
 *
 * 复用 LifeEmotionType / LifeConsolidationStatus 是有意为之——
 * Phase 2c 的 salience 评分引擎要让 life events 和 conversation episodes 走同一套
 * 排序公式，类型对齐能直接套同函数，避免双轨。
 *
 * @author zhi.qu
 * @date 2026-05-17
 */

import type { LifeEmotionType, LifeConsolidationStatus } from '../life/types'

/** schema 版本——破坏性升级时递增，store 解析时按版本走兼容路径 */
export const CONVERSATION_EPISODE_SCHEMA_VERSION = 1

/**
 * 单条对话情景记忆。
 *
 * 字段排序按"识别 → 内容 → 评分 → 状态 → 时间元数据"，便于人工 diff。
 */
export interface ConversationEpisode {
  schemaVersion: number

  // ─── 识别 ───
  /** 对应的会话 ID（PK：一会话一 episode） */
  conversationId: string
  /** 分身 ID（冗余字段，便于离线脚本不必查 conversations 表） */
  avatarId: string

  // ─── 内容（LLM 抽出，不可机器编辑） ───
  /** 一句话概括（≤80 字） */
  title: string
  /** 1-2 句主题描述（≤300 字） */
  theme: string
  /** 200-500 字第一人称小结："我和用户聊了..."（角色由分身担任） */
  summary: string
  /** 3-5 条关键引用片段（用户或助手原话；用于 recall 命中精度） */
  keyQuotes: string[]
  /** 标签数组，便于跨 episode 关联（最多 6 个） */
  themes: string[]

  // ─── 评分（Phase 2c salience 输入） ───
  /** 情感倾向：-10 (强负) ~ 0 (中性) ~ +10 (强正) */
  valence: number
  /** 情感主色调（复用 LifeEmotionType 联合） */
  emotionType: LifeEmotionType
  /** 重要性 0-10：用户是否会想再翻 */
  importance: number

  // ─── 状态（Phase 2c forgetter 落点） ───
  /** 复用 life 的三态：remembered / blurred / forgotten */
  consolidationStatus: LifeConsolidationStatus
  /** 复盘理由（可选；AI 整理时填） */
  consolidationNote: string

  // ─── 时间元数据 ───
  /** 会话起始时间戳（毫秒） */
  conversationStartedAt: number
  /** 会话最近一条消息时间戳——用于判断 episode 是否过期（staleness） */
  conversationLastMessageAt: number
  /** 本 episode 上次抽取/整理时间 */
  extractedAt: number
  /** 抽取时该会话的消息条数——下次若 > 此值才需要重抽 */
  messageCount: number
}

/**
 * 抽取请求参数（外部传给 extractor）。
 * 把消息列表 + 元数据打包，避免 extractor 依赖具体 DB 类型。
 */
export interface ExtractEpisodeInput {
  conversationId: string
  avatarId: string
  /** 会话标题（来自 conversations.title，作为 LLM 抽取的语境提示） */
  conversationTitle: string
  /** 已按时间正序的消息（仅 user/assistant，不含 tool） */
  transcript: Array<{
    role: 'user' | 'assistant'
    content: string
    /** 这条消息的时间戳（毫秒） */
    ts: number
  }>
}

/**
 * 抽取结果（成功 / 失败的判别式联合）。
 * 失败时 errorReason 用于 IPC 上报给渲染层；成功时直接拿 episode。
 */
export type ExtractEpisodeResult =
  | { ok: true; episode: ConversationEpisode }
  | { ok: false; errorReason: string }
