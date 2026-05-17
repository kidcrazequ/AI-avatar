/**
 * 对话情景记忆抽取器（v17，Phase 2a）。
 *
 * 流程：
 *   1. 调 LLM（注入 callLLM），输出严格 JSON
 *   2. 容忍 LLM 偶尔加 markdown 代码块包装——剥掉再 parse
 *   3. 校验必填字段类型 + clamp 数值字段到合法区间
 *   4. 填充时间元数据（extractedAt / messageCount / conversationLastMessageAt）
 *
 * 失败处理：返回 { ok: false, errorReason }，调用方决定是否重试/记 telemetry。
 * 不修改文件——只产生 ConversationEpisode 实例，由调用方决定写盘时机。
 *
 * @author zhi.qu
 * @date 2026-05-17
 */

import type { LLMCallFn } from '../document-formatter'
import type { LifeEmotionType, LifeConsolidationStatus } from '../life/types'
import {
  EPISODE_EXTRACTOR_SYSTEM_PROMPT,
  buildEpisodeExtractionPrompt,
} from './episode-prompts'
import {
  CONVERSATION_EPISODE_SCHEMA_VERSION,
  type ConversationEpisode,
  type ExtractEpisodeInput,
  type ExtractEpisodeResult,
} from './episode-types'

const VALID_EMOTION_TYPES: ReadonlySet<LifeEmotionType> = new Set([
  'joy', 'sorrow', 'anger', 'fear', 'wonder', 'shame', 'love',
])

/** clamp 数值到闭区间 */
function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : fallback
  return Math.max(min, Math.min(max, n))
}

/** 把不可信对象 trim 后转成数组化的合法字符串数组，按 maxLen 截断 */
function normalizeStringArray(value: unknown, maxItems: number, maxItemLen: number): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((x): x is string => typeof x === 'string')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .slice(0, maxItems)
    .map((s) => (s.length > maxItemLen ? s.slice(0, maxItemLen) + '…' : s))
}

/** 剥掉 LLM 偶尔加的 markdown 代码块包装 */
function stripCodeFence(text: string): string {
  const trimmed = text.trim()
  const fence = /^```[a-zA-Z]*\n([\s\S]*?)\n```$/m
  const m = trimmed.match(fence)
  return m ? m[1] : trimmed
}

/**
 * 主入口：调 LLM 抽取一条 episode。
 *
 * @param input 抽取请求（会话 metadata + transcript）
 * @param callLLM 注入的 LLM 调用函数
 * @param maxTokens LLM 输出 token 上限（默认 2000，抽取 episode 不需要太长）
 */
export async function extractConversationEpisode(
  input: ExtractEpisodeInput,
  callLLM: LLMCallFn,
  maxTokens = 2000,
): Promise<ExtractEpisodeResult> {
  if (input.transcript.length === 0) {
    return { ok: false, errorReason: 'transcript 为空，无法抽取' }
  }

  const userPrompt = buildEpisodeExtractionPrompt(input)
  let raw: string
  try {
    raw = await callLLM(EPISODE_EXTRACTOR_SYSTEM_PROMPT, userPrompt, maxTokens)
  } catch (err) {
    return { ok: false, errorReason: `LLM 调用失败: ${err instanceof Error ? err.message : String(err)}` }
  }

  const cleaned = stripCodeFence(raw)
  let parsed: unknown
  try {
    parsed = JSON.parse(cleaned)
  } catch (err) {
    return {
      ok: false,
      errorReason: `JSON 解析失败: ${err instanceof Error ? err.message : String(err)}; 原文前 200 字：${cleaned.slice(0, 200)}`,
    }
  }

  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, errorReason: 'LLM 输出不是对象' }
  }
  const obj = parsed as Record<string, unknown>

  // 必填字段校验
  const title = typeof obj.title === 'string' ? obj.title.trim() : ''
  const summary = typeof obj.summary === 'string' ? obj.summary.trim() : ''
  if (!title || !summary) {
    return { ok: false, errorReason: 'title 或 summary 缺失/非字符串' }
  }

  // emotionType 必须在白名单内，否则回退到中性的 wonder
  const rawEmotion = typeof obj.emotionType === 'string' ? obj.emotionType.trim() : ''
  const emotionType: LifeEmotionType = VALID_EMOTION_TYPES.has(rawEmotion as LifeEmotionType)
    ? (rawEmotion as LifeEmotionType)
    : 'wonder'

  const theme = typeof obj.theme === 'string' ? obj.theme.trim().slice(0, 300) : ''
  const keyQuotes = normalizeStringArray(obj.keyQuotes, 5, 120)
  const themes = normalizeStringArray(obj.themes, 6, 40)

  // 数值字段 clamp 到合法区间，越界时按中性兜底
  const valence = clamp(obj.valence, -10, 10, 0)
  const importance = clamp(obj.importance, 0, 10, 3)

  const now = Date.now()
  const conversationStartedAt = input.transcript[0]?.ts ?? now
  const conversationLastMessageAt = input.transcript[input.transcript.length - 1]?.ts ?? now

  // consolidationStatus 初始值：刚抽出来肯定是 remembered；Phase 2c forgetter 跑过后才衰减
  const consolidationStatus: LifeConsolidationStatus = 'remembered'

  const episode: ConversationEpisode = {
    schemaVersion: CONVERSATION_EPISODE_SCHEMA_VERSION,
    conversationId: input.conversationId,
    avatarId: input.avatarId,
    title: title.slice(0, 80),
    theme,
    summary: summary.slice(0, 2000), // LLM 偶尔超长，截到一个明显上限
    keyQuotes,
    themes,
    valence,
    emotionType,
    importance,
    consolidationStatus,
    consolidationNote: '',
    conversationStartedAt,
    conversationLastMessageAt,
    extractedAt: now,
    messageCount: input.transcript.length,
  }

  return { ok: true, episode }
}
