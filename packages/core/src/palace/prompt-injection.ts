/**
 * Palace 确定性 system prompt 注入。
 *
 * 正向链路从「模型可能调工具」变「必然生效」：对启用 Palace 的分身，把
 * 职业画像摘要 + 逾期/今日到期承诺确定性注入 system prompt。
 *
 * prompt cache 铁律：本模块只在 session 装配 soul 内容时被调用一次（与
 * 冻结快照同语义），产出在会话内不变；palace 目录不存在或两段都空时返回
 * 空串——一个字符都不注入，不占 token。
 */

import fs from 'fs'

import { localDateString } from '../utils/common'
import { getPalaceCommitmentsPath, getPalaceProfilePath } from './paths'
import { buildDefaultPalaceProfile } from './store'
import { normalizePalaceCommitmentDocument } from './commitments'
import type { PalaceCommitment, PalaceCommitmentDocument } from './types'

/** 画像摘要注入的最大字符数（超出截断并标注）。 */
export const PALACE_PROFILE_SUMMARY_MAX_CHARS = 600

/** 今日承诺提醒最多注入条数（超出以一行溢出提示收口）。 */
export const PALACE_DUE_REMINDER_MAX_ITEMS = 3

/** 空模板骨架行集合（标题 + 引导语），判定「实质内容」时剔除。 */
const PROFILE_SKELETON_LINES = new Set(
  buildDefaultPalaceProfile()
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0),
)

/**
 * profile.md 是否有实质内容：去掉空模板骨架行和空行后仍有文字。
 * 纯骨架（用户从未填写）不算，避免把空模板标题注入 prompt。
 */
export function hasSubstantivePalaceProfile(profile: string): boolean {
  return profile
    .split('\n')
    .map(line => line.trim())
    .some(line => line.length > 0 && !PROFILE_SKELETON_LINES.has(line))
}

export interface PalacePromptInjectionInput {
  /** profile.md 原文（可为空串）。 */
  profile: string
  /** 承诺账本条目（原始条目即可，无需 view）。 */
  commitments: readonly PalaceCommitment[]
  /** 本地今天（YYYY-MM-DD，来自 localDateString，避免 UTC 漂移）。 */
  today: string
}

/**
 * 纯函数：由 profile 原文 + 承诺列表构建注入文本。
 * 两段都不满足注入条件时返回空串（严格零注入）。
 */
export function buildPalacePromptInjection(input: PalacePromptInjectionInput): string {
  const sections: string[] = []

  if (hasSubstantivePalaceProfile(input.profile)) {
    const full = input.profile.trim()
    const truncated = full.length > PALACE_PROFILE_SUMMARY_MAX_CHARS
    const summary = truncated
      ? `${full.slice(0, PALACE_PROFILE_SUMMARY_MAX_CHARS)}\n\n（画像已截断，完整内容见「职场」面板档案页）`
      : full
    sections.push(`## 职场画像（摘要）\n\n${summary}`)
  }

  // 「open 且逾期或今天到期」：status 严格取 open（proposed 未确认、blocked 已
  // 知悉阻塞，都不进每日提醒）；dueAt 为 YYYY-MM-DD，本地日期字符串直接比较。
  const due = input.commitments
    .filter(c => c.status === 'open')
    .filter(c => typeof c.dueAt === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(c.dueAt) && c.dueAt <= input.today)
    .sort((a, b) => (a.dueAt as string).localeCompare(b.dueAt as string))
  if (due.length > 0) {
    const shown = due.slice(0, PALACE_DUE_REMINDER_MAX_ITEMS)
    const lines = shown.map(c => {
      const label = c.dueAt === input.today ? '今日到期' : `已逾期（原到期 ${c.dueAt}）`
      return `- 【${label}】${c.title}（对 ${c.counterparty}）：${c.promise}`
    })
    if (due.length > shown.length) {
      lines.push(`- 另有 ${due.length - shown.length} 条逾期/今日到期承诺，见「职场」面板`)
    }
    sections.push(`## 今日承诺提醒\n\n${lines.join('\n')}`)
  }

  return sections.join('\n\n')
}

/** 同步安全读文本：任何读失败（不存在/权限/目录占位）都按缺失处理。 */
function readTextSyncSafe(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf-8')
  } catch {
    return null
  }
}

/**
 * 同步装载 Palace 注入文本，给 soul-loader 的同步拼装链路用。
 * palace 不存在、内容为空、承诺账本损坏时按零注入降级，绝不阻断 soul 装配。
 */
export function loadPalacePromptInjection(
  avatarsRoot: string,
  avatarId: string,
  now: Date = new Date(),
): string {
  const profile = readTextSyncSafe(getPalaceProfilePath(avatarsRoot, avatarId)) ?? ''
  let commitments: PalaceCommitment[] = []
  const rawCommitments = readTextSyncSafe(getPalaceCommitmentsPath(avatarsRoot, avatarId))
  if (rawCommitments !== null) {
    try {
      commitments = normalizePalaceCommitmentDocument(
        JSON.parse(rawCommitments) as PalaceCommitmentDocument,
      ).commitments
    } catch {
      // 账本损坏不值得让整个 system prompt 装配失败；该段降级为零注入，
      // 损坏本身会在打开「职场」面板（get-overview 严格解析）时暴露。
      commitments = []
    }
  }
  return buildPalacePromptInjection({ profile, commitments, today: localDateString(now) })
}
