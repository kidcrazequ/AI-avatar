/**
 * Palace 任务前上下文包。
 */

import {
  PALACE_SCHEMA_VERSION,
  type PalaceCommitmentDocument,
  type PalaceInboxDocument,
  type PalaceRoom,
} from './types'
import type { PalaceRoomMatch } from './matcher'
import { filterPalaceCommitments, type PalaceCommitmentUrgency } from './commitments'

export interface PalaceContextCardInput {
  task: string
  room?: PalaceRoom
  matches?: PalaceRoomMatch[]
  profile?: string
  company?: string
  commitments?: PalaceCommitmentDocument
  inbox?: PalaceInboxDocument
  /** 对方画像：与本任务相关的 people/<人>.md 内容。 */
  peopleProfiles?: Array<{ name: string; content: string }>
  /** 能用素材：成果 / 周报等可复用素材的路径或要点。 */
  materials?: string[]
  maxItems?: number
}

export function buildPalaceContextCard(input: PalaceContextCardInput): string {
  const maxItems = Math.max(1, Math.min(10, Math.floor(input.maxItems ?? 5)))
  const lines: string[] = []
  const room = input.room

  lines.push('# Palace 任务前上下文包')
  lines.push('')
  lines.push(`- **任务**：${input.task.trim() || '（未填写）'}`)
  if (room) {
    lines.push(`- **路线卡**：${room.name}（\`${room.id}\`，priority=${room.priority}）`)
    if (room.description.trim()) lines.push(`- **路线说明**：${room.description.trim()}`)
  } else {
    lines.push('- **路线卡**：未命中')
  }

  if (input.matches && input.matches.length > 0) {
    lines.push('')
    lines.push('## 匹配依据')
    for (const match of input.matches.slice(0, maxItems)) {
      lines.push(`- ${match.room.name}（\`${match.room.id}\`，score=${match.score.toFixed(1)}）：${match.reasons.join('；') || '关键词相近'}`)
    }
  }

  if (room) {
    lines.push('')
    lines.push('## 必读，按顺序')
    appendList(lines, room.readOrder.length > 0 ? room.readOrder : room.requiredFiles, '未在路线卡里配置 read_order / required_files。')

    if (room.conditionalReads.length > 0) {
      lines.push('')
      lines.push('## 条件读')
      for (const c of room.conditionalReads) lines.push(`- ${c}`)
    }

    lines.push('')
    lines.push('## 文件入口')
    appendList(lines, room.requiredFiles, '未配置 required_files，可先看 profile.md / company.md / commitments.json。')
  }

  const peopleProfiles = input.peopleProfiles ?? []
  if (peopleProfiles.length > 0) {
    lines.push('')
    lines.push('## 对方画像')
    for (const p of peopleProfiles.slice(0, maxItems)) {
      lines.push(`- **${p.name}**：${summarize(p.content)}`)
    }
  }

  const materials = input.materials ?? []
  if (materials.length > 0) {
    lines.push('')
    lines.push('## 能用素材')
    appendList(lines, materials.slice(0, maxItems), '暂无可复用素材线索。')
  }

  if (room) {
    lines.push('')
    lines.push('## 坑，敏感点')
    appendList(lines, room.pitfalls, '未配置 pitfalls，执行前需要自行识别敏感边界。')

    if (room.toneGuidance.trim()) {
      lines.push('')
      lines.push('## 建议口径')
      lines.push(`- ${room.toneGuidance.trim()}`)
    }

    lines.push('')
    lines.push('## 输出与沉淀')
    lines.push(`- **输出位置**：${room.outputLocation || 'inbox/'}`)
    lines.push(`- **沉淀目标**：${room.sedimentTargets.length > 0 ? room.sedimentTargets.join(' / ') : 'inbox'}`)
  }

  lines.push('')
  lines.push('## 处境摘要')
  lines.push(`- **profile.md**：${summarize(input.profile)}`)
  lines.push(`- **company.md**：${summarize(input.company)}`)

  const activeCommitments = filterPalaceCommitments(input.commitments ?? { schemaVersion: PALACE_SCHEMA_VERSION, commitments: [] }, {
    limit: maxItems,
  })
  lines.push('')
  lines.push('## 承诺提示')
  if (activeCommitments.length === 0) {
    lines.push('- 当前没有 open/proposed/blocked 承诺。')
  } else {
    for (const c of activeCommitments) {
      const due = c.dueAt ? `，due=${c.dueAt}` : ''
      lines.push(`- ${formatUrgency(c.urgency, c.daysUntilDue)} ${c.title}：${c.counterparty} · ${c.status}${due} · ${c.promise}`)
    }
  }

  const pendingInbox = (input.inbox?.items ?? [])
    .filter(item => item.status === 'pending')
    .slice(0, maxItems)
  lines.push('')
  lines.push('## 待确认沉淀')
  if (pendingInbox.length === 0) {
    lines.push('- 当前没有 pending inbox 项。')
  } else {
    for (const item of pendingInbox) {
      const target = item.target ? ` → ${item.target}` : ''
      lines.push(`- ${item.kind}${target}：${item.title}`)
    }
  }

  lines.push('')
  lines.push('## 执行前确认')
  lines.push('先把这张上下文包用简短中文展示给用户，确认路线、材料和敏感点无误后，再进入正式执行。')

  return lines.join('\n')
}

function appendList(lines: string[], items: string[], empty: string): void {
  if (items.length === 0) {
    lines.push(`- ${empty}`)
    return
  }
  for (let i = 0; i < items.length; i++) {
    lines.push(`${i + 1}. ${items[i]}`)
  }
}

function summarize(text: string | undefined): string {
  const cleaned = String(text ?? '')
    .replace(/^---[\s\S]*?---\s*/m, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!cleaned) return '暂无内容。'
  return cleaned.length > 240 ? `${cleaned.slice(0, 240)}...` : cleaned
}

function formatUrgency(urgency: PalaceCommitmentUrgency, daysUntilDue: number | null): string {
  switch (urgency) {
    case 'overdue':
      return `[已逾期 ${Math.abs(daysUntilDue ?? 0)} 天]`
    case 'due_today':
      return '[今天到期]'
    case 'due_soon':
      return `[${daysUntilDue} 天内到期]`
    case 'scheduled':
      return `[${daysUntilDue} 天后到期]`
    case 'closed':
      return '[已关闭]'
    case 'no_due':
    default:
      return '[无截止日]'
  }
}
