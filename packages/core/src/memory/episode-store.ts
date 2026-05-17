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
