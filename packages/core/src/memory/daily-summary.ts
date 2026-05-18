/**
 * Memory Tree — daily summary（v18 OpenHuman 借鉴）
 *
 * 痛点：Soul 的对话情景记忆是**实体维度**（per-conversation episode + WikiCompiler
 * per-entity 聚合页），缺**时间维度聚合**。问"今天聊了什么 / 上周聊过 X" 时只能
 * BM25 检索 episodes，时间锚定不直接。
 *
 * 解法：每日 cron 把当天所有 episodes 合并成一份 daily-<YYYY-MM-DD>.md 落盘。
 * v1 用机械合并（拼 title + theme + summary 截断），零 LLM 成本；
 * v2 可选 LLM 二次摘要（feature flag 控制）。
 *
 * 落盘：`avatars/<id>/memory/daily-summaries/<YYYY-MM-DD>.md`
 *
 * 不接管现有 episode 系统：episodes/*.json 仍是 SoT，daily summary 是只读派生。
 *
 * @author zhi.qu
 * @date 2026-05-18
 */

import fs from 'fs'
import path from 'path'
import type { ConversationEpisode } from './episode-types'

const DAILY_SUMMARY_DIR = 'daily-summaries'
const SUMMARY_CLIP_CHARS = 240

function getDailySummaryDir(avatarsPath: string, avatarId: string): string {
  return path.join(avatarsPath, avatarId, 'memory', DAILY_SUMMARY_DIR)
}

function getDailySummaryFilePath(avatarsPath: string, avatarId: string, date: string): string {
  return path.join(getDailySummaryDir(avatarsPath, avatarId), `${date}.md`)
}

/** YYYY-MM-DD 字符串校验 + 防穿越（不允许 . / 等） */
function isValidDateString(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s)
}

/** ISO 本地日期 YYYY-MM-DD（避免 UTC 时区偏移；用调用方注入的时间） */
export function localDateStringFromMs(ms: number): string {
  const d = new Date(ms)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/**
 * 按 conversationStartedAt 把 episodes 按本地日期分组。
 * 跳过 forgotten 状态（已被遗忘的不该再进 daily summary）。
 */
export function groupEpisodesByDate(episodes: ConversationEpisode[]): Map<string, ConversationEpisode[]> {
  const groups = new Map<string, ConversationEpisode[]>()
  for (const ep of episodes) {
    if (ep.consolidationStatus === 'forgotten') continue
    if (!Number.isFinite(ep.conversationStartedAt) || ep.conversationStartedAt <= 0) continue
    const date = localDateStringFromMs(ep.conversationStartedAt)
    const arr = groups.get(date) ?? []
    arr.push(ep)
    groups.set(date, arr)
  }
  // 同一天内按 conversationStartedAt 正序排列
  for (const arr of groups.values()) {
    arr.sort((a, b) => a.conversationStartedAt - b.conversationStartedAt)
  }
  return groups
}

/**
 * v1 机械合并：从一组 episode 生成 daily summary markdown（零 LLM 成本）。
 * 包含：标题 / 总览（对话数 + 主题列表）/ 每条对话的 title + theme + clipped summary。
 */
export function compileDailySummary(date: string, episodes: ConversationEpisode[]): string {
  if (!isValidDateString(date)) {
    throw new Error(`非法日期格式: ${date}（期望 YYYY-MM-DD）`)
  }
  const lines: string[] = []
  lines.push(`# ${date} 的对话回顾`)
  lines.push('')

  if (episodes.length === 0) {
    lines.push('> 当天没有显著的对话记忆。')
    return lines.join('\n')
  }

  // 总览
  const allThemes = new Set<string>()
  for (const ep of episodes) {
    for (const t of ep.themes ?? []) allThemes.add(t)
  }
  const themesPreview = Array.from(allThemes).slice(0, 12).join(' / ') || '（无标签）'
  lines.push(`> 共 ${episodes.length} 次对话，主题：${themesPreview}`)
  lines.push('')

  // 每条对话
  for (let i = 0; i < episodes.length; i++) {
    const ep = episodes[i]
    lines.push(`## 对话 ${i + 1}：${ep.title}`)
    if (ep.theme?.trim()) lines.push(`> ${ep.theme.trim()}`)
    lines.push('')
    lines.push(`- importance: **${ep.importance}** · valence: ${ep.valence} · status: ${ep.consolidationStatus}${ep.pinned ? ' · 📌 pinned' : ''}`)
    const summary = (ep.summary ?? '').trim()
    if (summary) {
      const clipped = summary.length > SUMMARY_CLIP_CHARS
        ? summary.slice(0, SUMMARY_CLIP_CHARS) + '…'
        : summary
      lines.push('')
      lines.push(clipped)
    }
    lines.push('')
  }

  return lines.join('\n')
}

/**
 * 落盘 daily summary。路径已自动 mkdir。
 */
export function writeDailySummary(
  avatarsPath: string,
  avatarId: string,
  date: string,
  content: string,
): void {
  if (!isValidDateString(date)) throw new Error(`非法日期格式: ${date}`)
  const filePath = getDailySummaryFilePath(avatarsPath, avatarId, date)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, content, 'utf-8')
}

/**
 * 读取 daily summary。不存在返回 null。
 */
export function readDailySummary(
  avatarsPath: string,
  avatarId: string,
  date: string,
): string | null {
  if (!isValidDateString(date)) return null
  const filePath = getDailySummaryFilePath(avatarsPath, avatarId, date)
  try {
    return fs.readFileSync(filePath, 'utf-8')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return null
    console.warn(`[daily-summary] 读 ${filePath} 失败: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}

/**
 * 列出所有已生成的 daily summary 日期。可选 start/end 过滤（YYYY-MM-DD）。
 * 按日期降序（最新在前）。
 */
export function listDailySummaries(
  avatarsPath: string,
  avatarId: string,
  options?: { start?: string; end?: string; limit?: number },
): string[] {
  const dir = getDailySummaryDir(avatarsPath, avatarId)
  let entries: string[]
  try {
    entries = fs.readdirSync(dir)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return []
    throw err
  }
  const dates = entries
    .filter(f => f.endsWith('.md'))
    .map(f => f.replace(/\.md$/, ''))
    .filter(isValidDateString)
  let filtered = dates
  if (options?.start && isValidDateString(options.start)) {
    filtered = filtered.filter(d => d >= options.start!)
  }
  if (options?.end && isValidDateString(options.end)) {
    filtered = filtered.filter(d => d <= options.end!)
  }
  filtered.sort((a, b) => b.localeCompare(a)) // 降序
  if (options?.limit && options.limit > 0) {
    filtered = filtered.slice(0, options.limit)
  }
  return filtered
}

/**
 * 入口函数：扫某分身的全部 episode，按日期分组 + 合并 + 写盘。
 * 返回每个日期生成 / 跳过的状态。
 *
 * 设计：覆盖式写（重新跑会用最新 episode 集合覆盖之前的 summary）——
 * episode forgetter 改变了 status 后，daily summary 自动反映新状态。
 *
 * 调用方传入已 listed 的 episodes（避免本模块依赖 fs 读 episodes 目录）。
 */
export function applyDailySummaryAllDates(
  avatarsPath: string,
  avatarId: string,
  episodes: ConversationEpisode[],
): { written: string[]; skipped: string[] } {
  const groups = groupEpisodesByDate(episodes)
  const written: string[] = []
  const skipped: string[] = []
  for (const [date, eps] of groups) {
    try {
      const content = compileDailySummary(date, eps)
      writeDailySummary(avatarsPath, avatarId, date, content)
      written.push(date)
    } catch (err) {
      console.warn(`[daily-summary] 写 ${date} 失败: ${err instanceof Error ? err.message : String(err)}`)
      skipped.push(date)
    }
  }
  return { written, skipped }
}
