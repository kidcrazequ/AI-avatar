/**
 * Palace 承诺闭环账本纯函数。
 */

import {
  PALACE_SCHEMA_VERSION,
  type PalaceCommitment,
  type PalaceCommitmentDirection,
  type PalaceCommitmentDocument,
  type PalaceCommitmentStatus,
} from './types'
import { localDateString } from '../utils/common'

export const PALACE_COMMITMENT_DIRECTIONS: readonly PalaceCommitmentDirection[] = [
  'i_owe_them',
  'they_owe_me',
  'mutual',
  'watch',
]

export const PALACE_COMMITMENT_STATUSES: readonly PalaceCommitmentStatus[] = [
  'proposed',
  'open',
  'done',
  'blocked',
  'dropped',
]

const OPEN_STATUSES = new Set<PalaceCommitmentStatus>(['proposed', 'open', 'blocked'])
const CLOSED_STATUSES = new Set<PalaceCommitmentStatus>(['done', 'dropped'])

export type PalaceCommitmentUrgency =
  | 'overdue'
  | 'due_today'
  | 'due_soon'
  | 'scheduled'
  | 'no_due'
  | 'closed'

export interface PalaceCommitmentCreateInput {
  id?: string
  direction?: PalaceCommitmentDirection
  title: string
  counterparty?: string
  promise: string
  status?: PalaceCommitmentStatus
  dueAt?: string
  owner?: string
  source?: string
  tags?: string[]
  notes?: string[]
}

export interface PalaceCommitmentUpdatePatch {
  direction?: PalaceCommitmentDirection
  title?: string
  counterparty?: string
  promise?: string
  status?: PalaceCommitmentStatus
  dueAt?: string | null
  owner?: string | null
  source?: string | null
  tags?: string[]
  appendNote?: string
}

export interface PalaceCommitmentFilter {
  status?: PalaceCommitmentStatus
  direction?: PalaceCommitmentDirection
  query?: string
  includeClosed?: boolean
  dueBefore?: string
  limit?: number
  now?: Date
}

export interface PalaceCommitmentView extends PalaceCommitment {
  urgency: PalaceCommitmentUrgency
  daysUntilDue: number | null
}

export function normalizePalaceCommitmentDocument(
  doc: PalaceCommitmentDocument | null | undefined,
): PalaceCommitmentDocument {
  return {
    schemaVersion: PALACE_SCHEMA_VERSION,
    commitments: Array.isArray(doc?.commitments) ? doc.commitments : [],
  }
}

export function createPalaceCommitment(
  input: PalaceCommitmentCreateInput,
  existing: readonly PalaceCommitment[] = [],
  now: Date = new Date(),
): PalaceCommitment {
  const title = requireText(input.title, 'title')
  const promise = requireText(input.promise, 'promise')
  const counterparty = cleanText(input.counterparty) || '未指定'
  const direction = normalizeDirection(input.direction)
  const status = normalizeStatus(input.status ?? 'open')
  const id = cleanText(input.id) || generatePalaceCommitmentId(existing, now)
  assertSafeCommitmentId(id)
  const iso = now.toISOString()
  const dueAt = normalizeOptionalDate(input.dueAt)
  return {
    id,
    direction,
    title,
    counterparty,
    promise,
    status,
    createdAt: iso,
    updatedAt: iso,
    ...(dueAt ? { dueAt } : {}),
    ...(cleanText(input.owner) ? { owner: cleanText(input.owner) } : {}),
    ...(cleanText(input.source) ? { source: cleanText(input.source) } : {}),
    ...(normalizeStringArray(input.tags).length > 0 ? { tags: normalizeStringArray(input.tags) } : {}),
    ...(normalizeStringArray(input.notes).length > 0 ? { notes: normalizeStringArray(input.notes) } : {}),
  }
}

export function addPalaceCommitmentToDocument(
  doc: PalaceCommitmentDocument,
  input: PalaceCommitmentCreateInput,
  now: Date = new Date(),
): { document: PalaceCommitmentDocument; commitment: PalaceCommitment } {
  const normalized = normalizePalaceCommitmentDocument(doc)
  const commitment = createPalaceCommitment(input, normalized.commitments, now)
  if (normalized.commitments.some(c => c.id === commitment.id)) {
    throw new Error(`Palace commitment 已存在: ${commitment.id}`)
  }
  return {
    commitment,
    document: {
      schemaVersion: PALACE_SCHEMA_VERSION,
      commitments: [...normalized.commitments, commitment],
    },
  }
}

export function updatePalaceCommitmentInDocument(
  doc: PalaceCommitmentDocument,
  id: string,
  patch: PalaceCommitmentUpdatePatch,
  now: Date = new Date(),
): { document: PalaceCommitmentDocument; commitment: PalaceCommitment } {
  assertSafeCommitmentId(id)
  const normalized = normalizePalaceCommitmentDocument(doc)
  const idx = normalized.commitments.findIndex(c => c.id === id)
  if (idx < 0) throw new Error(`Palace commitment 不存在: ${id}`)
  const current = normalized.commitments[idx]!
  const updated: PalaceCommitment = {
    ...current,
    ...(patch.direction !== undefined ? { direction: normalizeDirection(patch.direction) } : {}),
    ...(patch.title !== undefined ? { title: requireText(patch.title, 'title') } : {}),
    ...(patch.counterparty !== undefined ? { counterparty: cleanText(patch.counterparty) || '未指定' } : {}),
    ...(patch.promise !== undefined ? { promise: requireText(patch.promise, 'promise') } : {}),
    ...(patch.status !== undefined ? { status: normalizeStatus(patch.status) } : {}),
    updatedAt: now.toISOString(),
  }

  assignOptional(updated, 'dueAt', patch.dueAt, normalizeOptionalDate)
  assignOptional(updated, 'owner', patch.owner, cleanText)
  assignOptional(updated, 'source', patch.source, cleanText)
  if (patch.tags !== undefined) updated.tags = normalizeStringArray(patch.tags)
  const note = cleanText(patch.appendNote)
  if (note) updated.notes = [...(updated.notes ?? []), note]

  const commitments = [...normalized.commitments]
  commitments[idx] = updated
  return {
    commitment: updated,
    document: { schemaVersion: PALACE_SCHEMA_VERSION, commitments },
  }
}

export function filterPalaceCommitments(
  doc: PalaceCommitmentDocument,
  filter: PalaceCommitmentFilter = {},
): PalaceCommitmentView[] {
  const now = filter.now ?? new Date()
  const query = cleanText(filter.query).toLowerCase()
  const dueBefore = normalizeOptionalDate(filter.dueBefore)
  let out = normalizePalaceCommitmentDocument(doc).commitments
    .filter(c => filter.includeClosed || !CLOSED_STATUSES.has(c.status))
    .filter(c => !filter.status || c.status === filter.status)
    .filter(c => !filter.direction || c.direction === filter.direction)
    .filter(c => !dueBefore || (c.dueAt !== undefined && c.dueAt <= dueBefore))
    .filter(c => {
      if (!query) return true
      const haystack = [
        c.id,
        c.title,
        c.counterparty,
        c.promise,
        c.owner ?? '',
        c.source ?? '',
        ...(c.tags ?? []),
        ...(c.notes ?? []),
      ].join(' ').toLowerCase()
      return haystack.includes(query)
    })
    .map(c => ({
      ...c,
      urgency: getPalaceCommitmentUrgency(c, now),
      daysUntilDue: daysUntilDue(c, now),
    }))

  out = sortPalaceCommitmentViews(out)
  if (filter.limit && filter.limit > 0) out = out.slice(0, Math.min(100, Math.floor(filter.limit)))
  return out
}

export function sortPalaceCommitmentViews(items: PalaceCommitmentView[]): PalaceCommitmentView[] {
  const urgencyRank: Record<PalaceCommitmentUrgency, number> = {
    overdue: 0,
    due_today: 1,
    due_soon: 2,
    scheduled: 3,
    no_due: 4,
    closed: 5,
  }
  return [...items].sort((a, b) => {
    const ur = urgencyRank[a.urgency] - urgencyRank[b.urgency]
    if (ur !== 0) return ur
    const da = a.dueAt ?? '9999-12-31'
    const db = b.dueAt ?? '9999-12-31'
    if (da !== db) return da.localeCompare(db)
    return b.updatedAt.localeCompare(a.updatedAt)
  })
}

export function getPalaceCommitmentUrgency(
  commitment: PalaceCommitment,
  now: Date = new Date(),
): PalaceCommitmentUrgency {
  if (CLOSED_STATUSES.has(commitment.status)) return 'closed'
  const days = daysUntilDue(commitment, now)
  if (days === null) return 'no_due'
  if (days < 0) return 'overdue'
  if (days === 0) return 'due_today'
  if (days <= 3) return 'due_soon'
  return 'scheduled'
}

export function daysUntilDue(commitment: PalaceCommitment, now: Date = new Date()): number | null {
  if (!commitment.dueAt) return null
  const due = parseDateOnly(commitment.dueAt)
  if (!due) return null
  const today = dateOnlyUtc(now)
  return Math.round((due.getTime() - today.getTime()) / 86400000)
}

export function isOpenPalaceCommitmentStatus(status: PalaceCommitmentStatus): boolean {
  return OPEN_STATUSES.has(status)
}

export function generatePalaceCommitmentId(
  existing: readonly PalaceCommitment[] = [],
  now: Date = new Date(),
): string {
  const date = localDateString(now).replace(/-/g, '')
  const prefix = `cmt-${date}-`
  const max = existing
    .map(c => c.id)
    .filter(id => id.startsWith(prefix))
    .map(id => Number(id.slice(prefix.length)))
    .filter(Number.isFinite)
    .reduce((a, b) => Math.max(a, b), 0)
  return `${prefix}${String(max + 1).padStart(3, '0')}`
}

function normalizeDirection(value: PalaceCommitmentDirection | undefined): PalaceCommitmentDirection {
  if (value && PALACE_COMMITMENT_DIRECTIONS.includes(value)) return value
  return 'i_owe_them'
}

function normalizeStatus(value: PalaceCommitmentStatus): PalaceCommitmentStatus {
  if (PALACE_COMMITMENT_STATUSES.includes(value)) return value
  return 'open'
}

function requireText(value: unknown, label: string): string {
  const text = cleanText(value)
  if (!text) throw new Error(`Palace commitment ${label} 不能为空`)
  return text
}

function cleanText(value: unknown): string {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : ''
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of value) {
    const text = cleanText(item)
    if (!text || seen.has(text)) continue
    seen.add(text)
    out.push(text)
  }
  return out
}

function normalizeOptionalDate(value: unknown): string {
  const text = cleanText(value)
  if (!text) return ''
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(text)
  if (!m) throw new Error(`非法日期格式，期望 YYYY-MM-DD: ${text}`)
  return m[1]
}

function parseDateOnly(value: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value)
  if (!m) return null
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
}

function dateOnlyUtc(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()))
}

function assignOptional<T extends 'dueAt' | 'owner' | 'source'>(
  target: PalaceCommitment,
  key: T,
  value: string | null | undefined,
  normalize: (x: unknown) => string,
): void {
  if (value === undefined) return
  const normalized = normalize(value)
  if (normalized) target[key] = normalized
  else delete target[key]
}

function assertSafeCommitmentId(value: string): void {
  if (!value || !value.trim()) throw new Error('Palace commitment id 不能为空')
  if (/[/\\]|\.\.|\0/.test(value)) {
    throw new Error(`非法 Palace commitment id: ${value}`)
  }
}
