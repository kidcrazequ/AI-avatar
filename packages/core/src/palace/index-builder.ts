/**
 * Palace 轻量自动索引器。
 *
 * 把 palace/ 各子目录的文件、承诺、路线卡按「人物 / 项目 / 时间」聚合成一张
 * 可读的导航索引 index.md。纯按文件名和结构化字段聚合，不解析正文，因此便宜、确定。
 */

import { isOpenPalaceCommitmentStatus } from './commitments'
import type {
  PalaceCommitment,
  PalaceRoom,
} from './types'

export interface PalaceIndexInput {
  now?: Date
  rooms: PalaceRoom[]
  commitments: PalaceCommitment[]
  /** palace/<dir>/ 下的文件名列表（仅文件名，不含路径）。 */
  dirs: Partial<Record<
    'people' | 'projects' | 'meetings' | 'reports' | 'decisions' | 'achievements' | 'wiki',
    string[]
  >>
}

export function buildPalaceIndexMarkdown(input: PalaceIndexInput): string {
  const now = input.now ?? new Date()
  const dirs = input.dirs ?? {}
  const lines: string[] = [
    '# 记忆宫殿索引',
    '',
    '> ⚠️ 本文件由 Palace 自动生成，请勿手改。它按人物 / 项目 / 时间聚合各目录内容，方便快速导航。',
    '',
    `生成于 ${now.toISOString()}`,
    '',
  ]

  appendPeople(lines, dirs.people ?? [], input.commitments)
  appendProjects(lines, dirs.projects ?? [])
  appendTimeline(lines, dirs)
  appendRooms(lines, input.rooms)

  return `${lines.join('\n').trimEnd()}\n`
}

function appendPeople(lines: string[], peopleFiles: string[], commitments: PalaceCommitment[]): void {
  lines.push('## 按人物', '')
  const people = new Map<string, { file?: string; openCount: number }>()
  for (const file of peopleFiles) {
    const name = baseName(file)
    if (!name) continue
    people.set(name, { file, openCount: 0 })
  }
  for (const c of commitments) {
    const name = c.counterparty?.trim()
    if (!name || name === '未指定') continue
    const entry = people.get(name) ?? { openCount: 0 }
    if (isOpenPalaceCommitmentStatus(c.status)) entry.openCount += 1
    people.set(name, entry)
  }
  if (people.size === 0) {
    lines.push('（暂无人物档案或承诺对象）', '')
    return
  }
  for (const name of [...people.keys()].sort((a, b) => a.localeCompare(b))) {
    const entry = people.get(name)!
    const parts: string[] = []
    if (entry.file) parts.push(`people/${entry.file}`)
    else parts.push('无人物档案，建议建 people/' + name + '.md')
    if (entry.openCount > 0) parts.push(`${entry.openCount} 条未关闭承诺`)
    lines.push(`- **${name}** — ${parts.join(' · ')}`)
  }
  lines.push('')
}

function appendProjects(lines: string[], projectFiles: string[]): void {
  lines.push('## 按项目', '')
  const names = projectFiles.map(baseName).filter(Boolean).sort((a, b) => a.localeCompare(b))
  if (names.length === 0) {
    lines.push('（暂无项目档案，建议在 projects/ 下按项目建档）', '')
    return
  }
  for (let i = 0; i < names.length; i++) {
    lines.push(`- **${names[i]}** — projects/${projectFiles.find(f => baseName(f) === names[i])}`)
  }
  lines.push('')
}

function appendTimeline(lines: string[], dirs: PalaceIndexInput['dirs']): void {
  lines.push('## 按时间', '')
  const byMonth = new Map<string, string[]>()
  const timeDirs: Array<keyof NonNullable<PalaceIndexInput['dirs']>> = [
    'meetings', 'reports', 'decisions', 'achievements',
  ]
  for (const dir of timeDirs) {
    for (const file of dirs[dir] ?? []) {
      const month = extractMonth(file)
      if (!month) continue
      const bucket = byMonth.get(month) ?? []
      bucket.push(`${dir}/${file}`)
      byMonth.set(month, bucket)
    }
  }
  if (byMonth.size === 0) {
    lines.push('（暂无按日期命名的会议 / 周报 / 决策 / 成果文件）', '')
    return
  }
  for (const month of [...byMonth.keys()].sort((a, b) => b.localeCompare(a))) {
    lines.push(`### ${month}`)
    for (const path of byMonth.get(month)!.sort()) lines.push(`- ${path}`)
    lines.push('')
  }
}

function appendRooms(lines: string[], rooms: PalaceRoom[]): void {
  lines.push('## 路线卡（路由索引）', '')
  if (rooms.length === 0) {
    lines.push('（暂无路线卡。可在桌面端「宫殿」面板新建房间，或手写 palace/rooms/<id>.md）', '')
    return
  }
  for (const room of rooms) {
    const triggers = room.triggers.length > 0 ? ` — 触发: ${room.triggers.join(', ')}` : ''
    const off = room.enabled ? '' : '（已停用）'
    lines.push(`- **${room.name}** \`${room.id}\`${off}${triggers}`)
  }
  lines.push('')
}

function baseName(file: string): string {
  return file.replace(/\.md$/i, '').trim()
}

/** 从文件名提取 YYYY-MM；支持 2026-06-17、2026_06、20260617 等常见前缀。 */
function extractMonth(name: string): string | null {
  const dashed = /(\d{4})[-_/.](\d{2})/.exec(name)
  if (dashed && isValidYearMonth(dashed[1]!, dashed[2]!)) return `${dashed[1]}-${dashed[2]}`
  const compact = /(\d{4})(\d{2})\d{2}/.exec(name)
  if (compact && isValidYearMonth(compact[1]!, compact[2]!)) return `${compact[1]}-${compact[2]}`
  return null
}

/** 校验年份在合理区间、月份 01-12，避免 config-1234-99 这类误归月。 */
function isValidYearMonth(year: string, month: string): boolean {
  const y = Number(year)
  const m = Number(month)
  return y >= 2000 && y <= 2100 && m >= 1 && m <= 12
}
