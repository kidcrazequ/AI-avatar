/**
 * Palace 承诺 / inbox 的只读 Markdown 镜像渲染。
 *
 * JSON 仍是唯一正本；这些 Markdown 在每次写入后由 store 自动重新生成，纯为
 * “不被锁死、任何编辑器都能打开看”服务。手改 .md 不会回写 JSON。
 */

import {
  filterPalaceCommitments,
  type PalaceCommitmentUrgency,
} from './commitments'
import type {
  PalaceCommitmentDirection,
  PalaceCommitmentDocument,
  PalaceInboxDocument,
  PalaceInboxStatus,
} from './types'

const MIRROR_NOTE =
  '> ⚠️ 本文件由 Palace 自动生成，请勿手改；编辑请用桌面端「宫殿」面板，或直接改同目录的 JSON 正本。'

const DIRECTION_LABEL: Record<PalaceCommitmentDirection, string> = {
  i_owe_them: '我答应别人的',
  they_owe_me: '别人答应我的',
  mutual: '双向约定',
  watch: '需要盯着的',
}

const URGENCY_LABEL: Record<PalaceCommitmentUrgency, string> = {
  overdue: '已逾期',
  due_today: '今天到期',
  due_soon: '近期到期',
  scheduled: '已排期',
  no_due: '无截止',
  closed: '已关闭',
}

const INBOX_STATUS_LABEL: Record<PalaceInboxStatus, string> = {
  pending: '待确认',
  accepted: '已接受',
  rejected: '已拒绝',
}

const DIRECTION_ORDER: PalaceCommitmentDirection[] = ['i_owe_them', 'they_owe_me', 'mutual', 'watch']

export function renderPalaceCommitmentsMarkdown(
  doc: PalaceCommitmentDocument,
  now: Date = new Date(),
): string {
  const all = filterPalaceCommitments(doc, { includeClosed: true, now })
  const open = all.filter(c => c.urgency !== 'closed')
  const closed = all.filter(c => c.urgency === 'closed')
  const overdue = open.filter(c => c.urgency === 'overdue').length

  const lines: string[] = [
    '# 承诺台账',
    '',
    MIRROR_NOTE,
    '',
    `共 ${all.length} 条 · 未关闭 ${open.length} 条 · 逾期 ${overdue} 条 · 生成于 ${now.toISOString()}`,
    '',
  ]

  if (open.length === 0) {
    lines.push('当前没有未关闭承诺。', '')
  }

  for (const direction of DIRECTION_ORDER) {
    const group = open.filter(c => c.direction === direction)
    if (group.length === 0) continue
    lines.push(`## ${DIRECTION_LABEL[direction]}（${direction}）`, '')
    lines.push('| 状态 | 紧急度 | 截止 | 对方 | 承诺 | id |')
    lines.push('|---|---|---|---|---|---|')
    for (const c of group) {
      lines.push(
        `| ${c.status} | ${URGENCY_LABEL[c.urgency]} | ${cell(c.dueAt ?? '—')} | ${cell(c.counterparty)} | ${cell(c.promise)} | \`${cell(c.id)}\` |`,
      )
    }
    lines.push('')
  }

  if (closed.length > 0) {
    lines.push('## 已关闭', '')
    lines.push('| 状态 | 对方 | 承诺 | id |')
    lines.push('|---|---|---|---|')
    for (const c of closed) {
      lines.push(`| ${c.status} | ${cell(c.counterparty)} | ${cell(c.promise)} | \`${cell(c.id)}\` |`)
    }
    lines.push('')
  }

  return `${lines.join('\n').trimEnd()}\n`
}

export function renderPalaceInboxMarkdown(
  doc: PalaceInboxDocument,
  now: Date = new Date(),
): string {
  const items = doc.items ?? []
  const order: PalaceInboxStatus[] = ['pending', 'accepted', 'rejected']
  const pending = items.filter(i => i.status === 'pending').length

  const lines: string[] = [
    '# 任务后沉淀收件箱',
    '',
    MIRROR_NOTE,
    '',
    `共 ${items.length} 条 · 待确认 ${pending} 条 · 生成于 ${now.toISOString()}`,
    '',
  ]

  if (items.length === 0) {
    lines.push('当前没有沉淀项。', '')
  }

  for (const status of order) {
    const group = items.filter(i => i.status === status)
    if (group.length === 0) continue
    lines.push(`## ${INBOX_STATUS_LABEL[status]}（${status}）`, '')
    for (const item of group) {
      const target = item.target ? ` → ${item.target}` : ''
      lines.push(`- **[${item.kind}${target}]** ${item.title} \`${item.id}\``)
      if (item.content) lines.push(`  - ${item.content.replace(/\n+/g, ' ')}`)
    }
    lines.push('')
  }

  return `${lines.join('\n').trimEnd()}\n`
}

/** 转义 Markdown 表格里的竖线和换行，避免破坏表格结构。 */
function cell(value: string): string {
  return String(value).replace(/\|/g, '\\|').replace(/\n+/g, ' ').trim()
}
