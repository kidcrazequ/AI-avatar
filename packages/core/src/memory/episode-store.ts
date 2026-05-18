/**
 * `avatars/<id>/memory/episodes/<conversationId>.json` 读写。
 *
 * 一会话一文件——简化并发与重复抽取的语义：upsert 整文件覆盖即可，不需要事务。
 *
 * 路径安全：所有公开函数都通过 `assertSafeSegment` + `resolveUnderRoot` 防御
 * avatarId / conversationId 路径穿越攻击。
 *
 * 原子写：临时文件 + rename，避免进程崩溃导致目标文件损坏（与 life/store.ts 同模式）。
 *
 * 解析容错：损坏文件不抛错（避免一条坏 episode 让整个分身的注入挂掉），
 * 而是返回 null 并由调用方 logger.warn——store 不持有 logger，吞错走 console.warn。
 *
 * @author zhi.qu
 * @date 2026-05-17
 */

import fs from 'fs'
import path from 'path'

import { assertSafeSegment, resolveUnderRoot } from '../utils/path-security'
import type { ConversationEpisode } from './episode-types'

// ─── 私有 helper ──────────────────────────────────────────────────────────────

/** 原子写：先写 .tmp 再 rename。与 life/store.ts:atomicWrite 同模式 */
async function atomicWrite(filePath: string, content: string): Promise<void> {
  const dir = path.dirname(filePath)
  const tmpPath = path.join(
    dir,
    `.tmp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
  )
  try {
    await fs.promises.writeFile(tmpPath, content, 'utf-8')
    await fs.promises.rename(tmpPath, filePath)
  } catch (err) {
    try { await fs.promises.unlink(tmpPath) } catch { /* 清理失败仅吞，关注主错误 */ }
    throw err
  }
}

/**
 * 解析单个 episode JSON 文件。
 * 文件不存在返回 null；解析失败也返回 null（吞错记 warn），避免一条坏文件拖垮整体读取。
 */
function parseEpisodeFile(raw: string, sourcePath: string): ConversationEpisode | null {
  try {
    const obj = JSON.parse(raw)
    if (!obj || typeof obj !== 'object') return null
    // 最小字段校验——schemaVersion 缺失或 conversationId 类型错都按损坏处理
    if (typeof obj.conversationId !== 'string' || typeof obj.avatarId !== 'string') return null
    if (typeof obj.title !== 'string' || typeof obj.summary !== 'string') return null
    return obj as ConversationEpisode
  } catch (err) {
    // eslint-disable-next-line no-console -- core 模块无 logger，依赖调用方主进程 logger
    console.warn(
      `[episode-store] 解析失败 ${sourcePath}: ${err instanceof Error ? err.message : String(err)}`,
    )
    return null
  }
}

/** 拼到分身 episodes 目录的绝对路径，做路径安全校验 */
function getEpisodesDir(avatarsPath: string, avatarId: string): string {
  assertSafeSegment(avatarId, '分身ID')
  return resolveUnderRoot(avatarsPath, path.join(avatarId, 'memory', 'episodes'))
}

/** 单个 episode 文件绝对路径 */
function getEpisodeFilePath(avatarsPath: string, avatarId: string, conversationId: string): string {
  assertSafeSegment(conversationId, 'conversationId')
  const dir = getEpisodesDir(avatarsPath, avatarId)
  return path.join(dir, `${conversationId}.json`)
}

// ─── 公开 API ─────────────────────────────────────────────────────────────────

/**
 * 写入（或覆盖）一条 episode。
 * 自动创建 episodes/ 目录；原子写防进程崩溃损坏文件。
 */
export async function writeConversationEpisode(
  avatarsPath: string,
  episode: ConversationEpisode,
): Promise<void> {
  const file = getEpisodeFilePath(avatarsPath, episode.avatarId, episode.conversationId)
  await fs.promises.mkdir(path.dirname(file), { recursive: true })
  await atomicWrite(file, JSON.stringify(episode, null, 2))
}

/**
 * 读取一条 episode。
 * 不存在 / 损坏 → null（损坏会 console.warn，便于排障）。
 */
export async function readConversationEpisode(
  avatarsPath: string,
  avatarId: string,
  conversationId: string,
): Promise<ConversationEpisode | null> {
  const file = getEpisodeFilePath(avatarsPath, avatarId, conversationId)
  try {
    const raw = await fs.promises.readFile(file, 'utf-8')
    return parseEpisodeFile(raw, file)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return null
    throw err
  }
}

/**
 * 列出分身所有 episodes（已解析）。
 * 仅过滤 .json 后缀；损坏文件被跳过（不进列表）。
 * 目录不存在返回空数组（新分身或从未抽取过场景）。
 */
export async function listConversationEpisodes(
  avatarsPath: string,
  avatarId: string,
): Promise<ConversationEpisode[]> {
  const dir = getEpisodesDir(avatarsPath, avatarId)
  let entries: string[]
  try {
    entries = await fs.promises.readdir(dir)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return []
    throw err
  }
  const episodes: ConversationEpisode[] = []
  for (const name of entries) {
    if (!name.endsWith('.json')) continue
    const file = path.join(dir, name)
    try {
      const raw = await fs.promises.readFile(file, 'utf-8')
      const parsed = parseEpisodeFile(raw, file)
      if (parsed) episodes.push(parsed)
    } catch {
      // 单个文件读失败不阻塞整体；下一轮人工排查
    }
  }
  return episodes
}

/**
 * 删除一条 episode。文件不存在视为成功（幂等）。
 */
export async function deleteConversationEpisode(
  avatarsPath: string,
  avatarId: string,
  conversationId: string,
): Promise<void> {
  const file = getEpisodeFilePath(avatarsPath, avatarId, conversationId)
  try {
    await fs.promises.unlink(file)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return
    throw err
  }
}

/**
 * 判断是否需要重新抽取——
 *   - 没有 episode → 需要
 *   - 已有但 episode.messageCount < 当前消息数 → 需要（会话又长了）
 *   - 已有且消息数没变 → 不需要
 *
 * 上层调用方在 chatStore 抽取触发逻辑里用。
 */
export function shouldExtractEpisode(
  existing: ConversationEpisode | null,
  currentMessageCount: number,
): boolean {
  if (!existing) return true
  return currentMessageCount > existing.messageCount
}

// ─── agent self-edit API（v18 Letta-style）────────────────────────────────────

/** pin 数量上限：防 LLM 把所有 episode 都 pin 爆 system prompt */
export const MAX_PINNED_EPISODES_PER_AVATAR = 20
/** 单 episode 最多笔记条数 */
export const MAX_NOTES_PER_EPISODE = 5
/** 单条笔记字符上限 */
export const MAX_NOTE_LENGTH = 500
/** pin reason 字符上限 */
export const MAX_PIN_REASON_LENGTH = 300

export type PinEpisodeResult =
  | { ok: true; alreadyPinned: boolean; totalPinned: number }
  | { ok: false; error: string }

/**
 * Pin 一条 episode。
 *
 * 语义：被 pin 的 episode 在 system prompt 注入时永远排在前面（PINNED_BONUS），
 * 且不会被 forgetter 衰减为 blurred/forgotten。
 *
 * 设计原则：
 *   - **不提供 unpin**：防止 LLM 自我审查删除负面记忆。需要清理由人工编辑 .json 文件。
 *   - **幂等**：重复 pin 返回 alreadyPinned: true，不报错也不刷新 pinnedAt。
 *   - **数量上限**：达到 MAX_PINNED_EPISODES_PER_AVATAR 后拒绝 pin，强制 LLM 取舍。
 */
export async function pinConversationEpisode(
  avatarsPath: string,
  avatarId: string,
  conversationId: string,
  reason: string,
): Promise<PinEpisodeResult> {
  const ep = await readConversationEpisode(avatarsPath, avatarId, conversationId)
  if (!ep) return { ok: false, error: `episode 不存在: ${conversationId}` }

  if (ep.pinned) {
    const all = await listConversationEpisodes(avatarsPath, avatarId)
    return { ok: true, alreadyPinned: true, totalPinned: all.filter(e => e.pinned).length }
  }

  const all = await listConversationEpisodes(avatarsPath, avatarId)
  const pinnedCount = all.filter(e => e.pinned).length
  if (pinnedCount >= MAX_PINNED_EPISODES_PER_AVATAR) {
    return {
      ok: false,
      error: `已达 pin 上限（${MAX_PINNED_EPISODES_PER_AVATAR} 条）；本框架不提供 unpin 工具，需人工编辑 episodes/*.json 解 pin 后才能 pin 新的`,
    }
  }

  const sanitizedReason = String(reason ?? '').trim().slice(0, MAX_PIN_REASON_LENGTH)
  const updated: ConversationEpisode = {
    ...ep,
    pinned: true,
    pinReason: sanitizedReason,
    pinnedAt: Date.now(),
  }
  await writeConversationEpisode(avatarsPath, updated)
  return { ok: true, alreadyPinned: false, totalPinned: pinnedCount + 1 }
}

export type AppendNoteResult =
  | { ok: true; totalNotes: number }
  | { ok: false; error: string }

/**
 * 给 episode 追加一条 agent 补充笔记。
 *
 * 设计原则：
 *   - **不覆盖** LLM 抽取的 summary / keyQuotes 等字段；只在 notes[] 后面追加
 *   - 单条笔记 MAX_NOTE_LENGTH 字符上限，整 episode 最多 MAX_NOTES_PER_EPISODE 条
 *   - 空白笔记直接拒绝
 */
export async function appendConversationEpisodeNote(
  avatarsPath: string,
  avatarId: string,
  conversationId: string,
  note: string,
): Promise<AppendNoteResult> {
  const trimmed = String(note ?? '').trim()
  if (!trimmed) return { ok: false, error: '笔记不能为空' }
  if (trimmed.length > MAX_NOTE_LENGTH) {
    return { ok: false, error: `笔记过长，上限 ${MAX_NOTE_LENGTH} 字符（当前 ${trimmed.length}）` }
  }

  const ep = await readConversationEpisode(avatarsPath, avatarId, conversationId)
  if (!ep) return { ok: false, error: `episode 不存在: ${conversationId}` }

  const existingNotes = ep.notes ?? []
  if (existingNotes.length >= MAX_NOTES_PER_EPISODE) {
    return { ok: false, error: `本 episode 笔记已达上限（${MAX_NOTES_PER_EPISODE} 条）` }
  }

  const updated: ConversationEpisode = {
    ...ep,
    notes: [...existingNotes, { text: trimmed, ts: Date.now() }],
  }
  await writeConversationEpisode(avatarsPath, updated)
  return { ok: true, totalNotes: updated.notes!.length }
}
