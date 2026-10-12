/**
 * Palace 任务后沉淀 inbox 纯函数。
 */

import {
  PALACE_SCHEMA_VERSION,
  type PalaceInboxDocument,
  type PalaceInboxItem,
  type PalaceInboxKind,
  type PalaceInboxStatus,
  type PalaceSedimentTarget,
} from './types'
import { localDateString } from '../utils/common'

export const PALACE_INBOX_KINDS: readonly PalaceInboxKind[] = [
  'fact',
  'person',
  'project',
  'commitment',
  'writing',
  'route',
  'other',
]

export const PALACE_INBOX_STATUSES: readonly PalaceInboxStatus[] = [
  'pending',
  'accepted',
  'rejected',
]

export const PALACE_SEDIMENT_TARGETS: readonly PalaceSedimentTarget[] = [
  'profile',
  'company',
  'people',
  'projects',
  'meetings',
  'reports',
  'decisions',
  'achievements',
  'wiki',
  'commitments',
  'rooms',
  'inbox',
]

export interface PalaceInboxCreateInput {
  id?: string
  kind?: PalaceInboxKind
  title: string
  content: string
  status?: PalaceInboxStatus
  target?: PalaceSedimentTarget
  source?: string
  confidence?: number
  tags?: string[]
}

export interface PalaceInboxUpdatePatch {
  kind?: PalaceInboxKind
  title?: string
  content?: string
  status?: PalaceInboxStatus
  target?: PalaceSedimentTarget | null
  source?: string | null
  confidence?: number | null
  tags?: string[]
}

export interface PalaceInboxFilter {
  status?: PalaceInboxStatus
  kind?: PalaceInboxKind
  target?: PalaceSedimentTarget
  query?: string
  includeResolved?: boolean
  limit?: number
}

export type PalaceInboxItemView = PalaceInboxItem

const RESOLVED_STATUSES = new Set<PalaceInboxStatus>(['accepted', 'rejected'])

export function normalizePalaceInboxDocument(
  doc: PalaceInboxDocument | null | undefined,
): PalaceInboxDocument {
  return {
    schemaVersion: PALACE_SCHEMA_VERSION,
    items: Array.isArray(doc?.items) ? doc.items : [],
  }
}

export function createPalaceInboxItem(
  input: PalaceInboxCreateInput,
  existing: readonly PalaceInboxItem[] = [],
  now: Date = new Date(),
): PalaceInboxItem {
  const title = requireText(input.title, 'title')
  const content = requireText(input.content, 'content')
  const kind = normalizeInboxKind(input.kind)
  const status = normalizeInboxStatus(input.status ?? 'pending')
  const id = cleanText(input.id) || generatePalaceInboxItemId(existing, now)
  assertSafeInboxItemId(id)
  const iso = now.toISOString()
  const target = normalizeOptionalTarget(input.target)
  const source = cleanText(input.source)
  const confidence = normalizeOptionalConfidence(input.confidence)
  const tags = normalizeStringArray(input.tags)

  return {
    id,
    kind,
    title,
    content,
    status,
    createdAt: iso,
    updatedAt: iso,
    ...(target ? { target } : {}),
    ...(source ? { source } : {}),
    ...(confidence !== null ? { confidence } : {}),
    ...(tags.length > 0 ? { tags } : {}),
  }
}

export function addPalaceInboxItemToDocument(
  doc: PalaceInboxDocument,
  input: PalaceInboxCreateInput,
  now: Date = new Date(),
): { document: PalaceInboxDocument; item: PalaceInboxItem } {
  const normalized = normalizePalaceInboxDocument(doc)
  const item = createPalaceInboxItem(input, normalized.items, now)
  if (normalized.items.some(existing => existing.id === item.id)) {
    throw new Error(`Palace inbox item 已存在: ${item.id}`)
  }
  return {
    item,
    document: {
      schemaVersion: PALACE_SCHEMA_VERSION,
      items: [...normalized.items, item],
    },
  }
}

export function updatePalaceInboxItemInDocument(
  doc: PalaceInboxDocument,
  id: string,
  patch: PalaceInboxUpdatePatch,
  now: Date = new Date(),
): { document: PalaceInboxDocument; item: PalaceInboxItem } {
  assertSafeInboxItemId(id)
  const normalized = normalizePalaceInboxDocument(doc)
  const idx = normalized.items.findIndex(item => item.id === id)
  if (idx < 0) throw new Error(`Palace inbox item 不存在: ${id}`)
  const current = normalized.items[idx]!
  const updated: PalaceInboxItem = {
    ...current,
    ...(patch.kind !== undefined ? { kind: normalizeInboxKind(patch.kind) } : {}),
    ...(patch.title !== undefined ? { title: requireText(patch.title, 'title') } : {}),
    ...(patch.content !== undefined ? { content: requireText(patch.content, 'content') } : {}),
    ...(patch.status !== undefined ? { status: normalizeInboxStatus(patch.status) } : {}),
    updatedAt: now.toISOString(),
  }

  assignOptional(updated, 'target', patch.target, normalizeOptionalTarget)
  assignOptional(updated, 'source', patch.source, cleanText)
  const confidence = normalizeOptionalConfidence(patch.confidence)
  if (patch.confidence !== undefined) {
    if (confidence === null) delete updated.confidence
    else updated.confidence = confidence
  }
  if (patch.tags !== undefined) updated.tags = normalizeStringArray(patch.tags)

  const items = [...normalized.items]
  items[idx] = updated
  return {
    item: updated,
    document: { schemaVersion: PALACE_SCHEMA_VERSION, items },
  }
}

export function filterPalaceInboxItems(
  doc: PalaceInboxDocument,
  filter: PalaceInboxFilter = {},
): PalaceInboxItemView[] {
  const query = cleanText(filter.query).toLowerCase()
  let out = normalizePalaceInboxDocument(doc).items
    .filter(item => filter.includeResolved || !RESOLVED_STATUSES.has(item.status))
    .filter(item => !filter.status || item.status === filter.status)
    .filter(item => !filter.kind || item.kind === filter.kind)
    .filter(item => !filter.target || item.target === filter.target)
    .filter(item => {
      if (!query) return true
      const haystack = [
        item.id,
        item.kind,
        item.title,
        item.content,
        item.target ?? '',
        item.source ?? '',
        ...(item.tags ?? []),
      ].join(' ').toLowerCase()
      return haystack.includes(query)
    })

  out = sortPalaceInboxItems(out)
  if (filter.limit && filter.limit > 0) out = out.slice(0, Math.min(100, Math.floor(filter.limit)))
  return out
}

export function sortPalaceInboxItems(items: PalaceInboxItemView[]): PalaceInboxItemView[] {
  const statusRank: Record<PalaceInboxStatus, number> = {
    pending: 0,
    accepted: 1,
    rejected: 2,
  }
  return [...items].sort((a, b) => {
    const sr = statusRank[a.status] - statusRank[b.status]
    if (sr !== 0) return sr
    return b.updatedAt.localeCompare(a.updatedAt)
  })
}

export function generatePalaceInboxItemId(
  existing: readonly PalaceInboxItem[] = [],
  now: Date = new Date(),
): string {
  const date = localDateString(now).replace(/-/g, '')
  const prefix = `inbox-${date}-`
  const max = existing
    .map(item => item.id)
    .filter(id => id.startsWith(prefix))
    .map(id => Number(id.slice(prefix.length)))
    .filter(Number.isFinite)
    .reduce((a, b) => Math.max(a, b), 0)
  return `${prefix}${String(max + 1).padStart(3, '0')}`
}

function normalizeInboxKind(value: PalaceInboxKind | undefined): PalaceInboxKind {
  if (value && PALACE_INBOX_KINDS.includes(value)) return value
  return 'other'
}

function normalizeInboxStatus(value: PalaceInboxStatus): PalaceInboxStatus {
  if (PALACE_INBOX_STATUSES.includes(value)) return value
  return 'pending'
}

function normalizeOptionalTarget(value: unknown): PalaceSedimentTarget | '' {
  const text = cleanText(value)
  if (!text) return ''
  if (PALACE_SEDIMENT_TARGETS.includes(text as PalaceSedimentTarget)) {
    return text as PalaceSedimentTarget
  }
  throw new Error(`非法 Palace sediment target: ${text}`)
}

function normalizeOptionalConfidence(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error('Palace inbox confidence 必须是 0 到 1 之间的数字')
  }
  if (value < 0 || value > 1) {
    throw new Error('Palace inbox confidence 必须是 0 到 1 之间的数字')
  }
  return Number(value.toFixed(4))
}

function requireText(value: unknown, label: string): string {
  const text = cleanText(value)
  if (!text) throw new Error(`Palace inbox ${label} 不能为空`)
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

function assignOptional<T extends 'target' | 'source'>(
  target: PalaceInboxItem,
  key: T,
  value: PalaceInboxItem[T] | null | undefined,
  normalize: (x: unknown) => PalaceInboxItem[T] | '',
): void {
  if (value === undefined) return
  const normalized = normalize(value)
  if (normalized) target[key] = normalized
  else delete target[key]
}

function assertSafeInboxItemId(value: string): void {
  if (!value || !value.trim()) throw new Error('Palace inbox item id 不能为空')
  if (/[/\\]|\.\.|\0/.test(value)) {
    throw new Error(`非法 Palace inbox item id: ${value}`)
  }
}
