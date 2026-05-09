/**
 * `life/` 目录读写纯函数。
 *
 * 职责：把对 `avatars/<id>/life/` 目录的所有文件 IO 封装为类型安全的纯函数，
 * 由 Electron 主进程的 IPC handler 直接调用（参考 main.ts:1297 read-memory 模式）。
 *
 * 路径安全：所有公开函数都通过 `assertSafeSegment` + `resolveUnderRoot` 防御
 * 用户输入的 avatarId / episodeId 路径穿越攻击。
 *
 * 原子写：内置 file-local `atomicWrite` helper（与 main.ts:564 atomicWriteFile
 * 同模式）。Phase 1/2 出现第二处使用时再抽到 utils/。
 *
 * @author zhi.qu
 * @date 2026-05-09
 */

import fs from 'fs'
import path from 'path'

import { assertSafeSegment, resolveUnderRoot } from '../utils/path-security'
import type {
  LifeEpisode,
  LifeManifest,
  LifeProgress,
  LifeTimelineEntry,
} from './types'

// ─── 私有 helper ──────────────────────────────────────────────────────────────

/**
 * 原子写文件：先写临时文件再 rename，避免进程崩溃导致目标文件损坏。
 * 与 desktop-app/electron/main.ts:564 atomicWriteFile 同模式，
 * TODO(phase-2): 出现第三处使用时抽到 packages/core/src/utils/atomic-write.ts。
 */
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
    // 清理临时文件，吞掉清理失败的二级错误（关注主错误）
    try {
      await fs.promises.unlink(tmpPath)
    } catch (cleanupErr) {
      const code = (cleanupErr as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') {
        // 清理失败但不影响主错误传播；记录到 stderr 仅供排障
        // eslint-disable-next-line no-console -- core 模块无 logger，依赖调用方主进程 logger
        console.warn(
          `[life-store] 临时文件清理失败 ${tmpPath}: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`,
        )
      }
    }
    throw err
  }
}

/**
 * 安全读取文本文件。文件不存在返回 null，其他 IO 异常向上抛。
 */
async function readTextSafe(filePath: string): Promise<string | null> {
  try {
    return await fs.promises.readFile(filePath, 'utf-8')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      return null
    }
    throw err
  }
}

/**
 * 安全读取 JSON 文件并按泛型返回。
 * 文件不存在返回 null；解析失败抛出明确错误（避免静默吞错导致数据丢失）。
 */
async function readJsonSafe<T>(filePath: string): Promise<T | null> {
  const text = await readTextSafe(filePath)
  if (text === null) return null
  try {
    return JSON.parse(text) as T
  } catch (err) {
    throw new Error(
      `life-store: 解析 JSON 失败 ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

/** JSON 序列化的统一缩进格式（2 空格，便于人工 diff） */
const JSON_INDENT = 2

/**
 * 校验 episodeId 是否为合法格式：
 *   - 经过 assertSafeSegment（无路径分隔符 / .. / 空字符）
 *   - 不以 `.` 开头（避免与 `.tmp_xxx` 冲突）
 *   - 不含扩展名（episode 落盘自动加 .md）
 */
function assertSafeEpisodeId(episodeId: string): void {
  assertSafeSegment(episodeId, '事件ID')
  if (episodeId.startsWith('.')) {
    throw new Error(`非法事件ID，不能以 . 开头: ${episodeId}`)
  }
  if (episodeId.endsWith('.md') || episodeId.includes('.')) {
    throw new Error(`非法事件ID，不能包含扩展名或点号: ${episodeId}`)
  }
}

// ─── 路径解析（公开） ─────────────────────────────────────────────────────────

/**
 * 返回 `avatars/<id>/life/` 的绝对路径。
 * @throws 当 avatarId 不安全时
 */
export function getLifeDir(avatarsRoot: string, avatarId: string): string {
  assertSafeSegment(avatarId, '分身ID')
  return resolveUnderRoot(avatarsRoot, path.join(avatarId, 'life'))
}

/** `life/manifest.json` 的绝对路径 */
export function getLifeManifestPath(avatarsRoot: string, avatarId: string): string {
  return path.join(getLifeDir(avatarsRoot, avatarId), 'manifest.json')
}

/** `life/timeline.json` 的绝对路径 */
export function getLifeTimelinePath(avatarsRoot: string, avatarId: string): string {
  return path.join(getLifeDir(avatarsRoot, avatarId), 'timeline.json')
}

/** `life/consolidated.md` 的绝对路径 */
export function getLifeConsolidatedPath(avatarsRoot: string, avatarId: string): string {
  return path.join(getLifeDir(avatarsRoot, avatarId), 'consolidated.md')
}

/** `life/progress.json` 的绝对路径 */
export function getLifeProgressPath(avatarsRoot: string, avatarId: string): string {
  return path.join(getLifeDir(avatarsRoot, avatarId), 'progress.json')
}

/** `life/episodes/` 目录的绝对路径 */
export function getLifeEpisodesDir(avatarsRoot: string, avatarId: string): string {
  return path.join(getLifeDir(avatarsRoot, avatarId), 'episodes')
}

/**
 * `life/episodes/<id>.md` 的绝对路径。
 * episodeId 经 `assertSafeEpisodeId` 校验，防止穿越。
 */
export function getLifeEpisodePath(
  avatarsRoot: string,
  avatarId: string,
  episodeId: string,
): string {
  assertSafeEpisodeId(episodeId)
  return path.join(getLifeEpisodesDir(avatarsRoot, avatarId), `${episodeId}.md`)
}

/**
 * 确保 `life/` 及其 `episodes/` 子目录存在（递归创建）。
 * 用于写文件前的兜底，幂等。
 */
export async function ensureLifeDir(
  avatarsRoot: string,
  avatarId: string,
): Promise<void> {
  const episodesDir = getLifeEpisodesDir(avatarsRoot, avatarId)
  await fs.promises.mkdir(episodesDir, { recursive: true })
}

// ─── 读 ───────────────────────────────────────────────────────────────────────

/**
 * 读取 manifest.json。文件不存在返回 null（视为分身尚未做过人生设计）。
 */
export async function readLifeManifest(
  avatarsRoot: string,
  avatarId: string,
): Promise<LifeManifest | null> {
  const filePath = getLifeManifestPath(avatarsRoot, avatarId)
  return readJsonSafe<LifeManifest>(filePath)
}

/**
 * 读取 timeline.json，文件不存在或为空数组都返回 `[]`，便于上游遍历。
 */
export async function readLifeTimeline(
  avatarsRoot: string,
  avatarId: string,
): Promise<LifeTimelineEntry[]> {
  const filePath = getLifeTimelinePath(avatarsRoot, avatarId)
  const data = await readJsonSafe<LifeTimelineEntry[]>(filePath)
  return data ?? []
}

/**
 * 读取单个 episode 正文。
 * @returns 文件不存在返回 null，存在返回完整 Markdown 文本
 */
export async function readLifeEpisode(
  avatarsRoot: string,
  avatarId: string,
  episodeId: string,
): Promise<string | null> {
  const filePath = getLifeEpisodePath(avatarsRoot, avatarId, episodeId)
  return readTextSafe(filePath)
}

/**
 * 读取 consolidated.md（注入 system prompt 的「我记得的人生」）。
 * 文件不存在返回空字符串，方便 soul-loader 拼装时直接判空跳过。
 */
export async function readLifeConsolidated(
  avatarsRoot: string,
  avatarId: string,
): Promise<string> {
  const filePath = getLifeConsolidatedPath(avatarsRoot, avatarId)
  const text = await readTextSafe(filePath)
  return text ?? ''
}

/**
 * 读取 progress.json。文件不存在返回 null（表示尚未启动过生成）。
 */
export async function readLifeProgress(
  avatarsRoot: string,
  avatarId: string,
): Promise<LifeProgress | null> {
  const filePath = getLifeProgressPath(avatarsRoot, avatarId)
  return readJsonSafe<LifeProgress>(filePath)
}

/**
 * 列出 `life/episodes/` 下所有 episode id（不含 .md 后缀）。
 * 目录不存在返回 `[]`。结果按文件名升序排序，便于断点续传时按序处理。
 */
export async function listLifeEpisodeIds(
  avatarsRoot: string,
  avatarId: string,
): Promise<string[]> {
  const episodesDir = getLifeEpisodesDir(avatarsRoot, avatarId)
  let entries: fs.Dirent[]
  try {
    entries = await fs.promises.readdir(episodesDir, { withFileTypes: true })
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return []
    throw err
  }
  const ids: string[] = []
  for (const entry of entries) {
    if (!entry.isFile()) continue
    if (!entry.name.endsWith('.md')) continue
    if (entry.name.startsWith('.')) continue
    ids.push(entry.name.slice(0, -3))
  }
  ids.sort()
  return ids
}

// ─── 写 ───────────────────────────────────────────────────────────────────────

/**
 * 写入 manifest.json（原子写，自动 mkdir）。
 */
export async function writeLifeManifest(
  avatarsRoot: string,
  avatarId: string,
  manifest: LifeManifest,
): Promise<void> {
  await ensureLifeDir(avatarsRoot, avatarId)
  const filePath = getLifeManifestPath(avatarsRoot, avatarId)
  await atomicWrite(filePath, JSON.stringify(manifest, null, JSON_INDENT))
}

/**
 * 写入 timeline.json（覆盖式，原子写）。
 */
export async function writeLifeTimeline(
  avatarsRoot: string,
  avatarId: string,
  timeline: LifeTimelineEntry[],
): Promise<void> {
  await ensureLifeDir(avatarsRoot, avatarId)
  const filePath = getLifeTimelinePath(avatarsRoot, avatarId)
  await atomicWrite(filePath, JSON.stringify(timeline, null, JSON_INDENT))
}

/**
 * 向 timeline.json 末尾追加一条事件（读 → push → 原子写）。
 *
 * 用于 grower 推进时的增量写入，避免 generator 与 grower 互相覆盖丢条目。
 *
 * @throws 当 entry.id 与既有条目重复时（避免 timeline 里出现两条同 id）
 */
export async function appendLifeTimelineEntry(
  avatarsRoot: string,
  avatarId: string,
  entry: LifeTimelineEntry,
): Promise<void> {
  assertSafeEpisodeId(entry.id)
  const timeline = await readLifeTimeline(avatarsRoot, avatarId)
  const exists = timeline.some((item) => item.id === entry.id)
  if (exists) {
    throw new Error(`life-store: timeline 已存在事件 ${entry.id}，禁止重复追加`)
  }
  timeline.push(entry)
  await writeLifeTimeline(avatarsRoot, avatarId, timeline)
}

/**
 * 写入单个 episode 的 Markdown 正文（原子写）。
 *
 * 注意：本函数仅写正文，不更新 timeline.json。调用方负责保证两边一致
 * （generator 通常会先 writeLifeEpisode 再 appendLifeTimelineEntry）。
 */
export async function writeLifeEpisode(
  avatarsRoot: string,
  avatarId: string,
  episode: LifeEpisode,
): Promise<void> {
  assertSafeEpisodeId(episode.id)
  await ensureLifeDir(avatarsRoot, avatarId)
  const filePath = getLifeEpisodePath(avatarsRoot, avatarId, episode.id)
  await atomicWrite(filePath, episode.content)
}

/**
 * 删除单个 episode 的 .md 文件，并从 timeline.json 中移除对应条目。
 *
 * 幂等：episode 文件不存在不报错（视作已删除），但 timeline 中找不到对应
 * id 时不抛错，仅返回 false 表示无 timeline 变动。
 *
 * @returns 是否实际删除了 timeline 中的条目
 */
export async function deleteLifeEpisode(
  avatarsRoot: string,
  avatarId: string,
  episodeId: string,
): Promise<boolean> {
  assertSafeEpisodeId(episodeId)
  const filePath = getLifeEpisodePath(avatarsRoot, avatarId, episodeId)
  try {
    await fs.promises.unlink(filePath)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') throw err
  }
  const timeline = await readLifeTimeline(avatarsRoot, avatarId)
  const filtered = timeline.filter((entry) => entry.id !== episodeId)
  if (filtered.length === timeline.length) {
    return false
  }
  await writeLifeTimeline(avatarsRoot, avatarId, filtered)
  return true
}

/**
 * 写入 consolidated.md（注入 system prompt 的「我记得的人生」）。
 */
export async function writeLifeConsolidated(
  avatarsRoot: string,
  avatarId: string,
  content: string,
): Promise<void> {
  await ensureLifeDir(avatarsRoot, avatarId)
  const filePath = getLifeConsolidatedPath(avatarsRoot, avatarId)
  await atomicWrite(filePath, content)
}

/**
 * 写入 progress.json（原子写）。
 */
export async function writeLifeProgress(
  avatarsRoot: string,
  avatarId: string,
  progress: LifeProgress,
): Promise<void> {
  await ensureLifeDir(avatarsRoot, avatarId)
  const filePath = getLifeProgressPath(avatarsRoot, avatarId)
  await atomicWrite(filePath, JSON.stringify(progress, null, JSON_INDENT))
}
