/**
 * Palace route card Markdown parser / serializer.
 */

import {
  buildFrontmatterBlock,
  parseFrontmatterCore,
} from '../utils/knowledge-frontmatter'
import {
  PALACE_SCHEMA_VERSION,
  type PalaceRoom,
  type PalaceSedimentTarget,
} from './types'

const DEFAULT_PRIORITY = 50

export function makeDefaultPalaceRoom(
  id: string,
  name: string,
  now: Date = new Date(),
): PalaceRoom {
  const iso = now.toISOString()
  return {
    schemaVersion: PALACE_SCHEMA_VERSION,
    id,
    name,
    description: '',
    triggers: [],
    priority: DEFAULT_PRIORITY,
    enabled: true,
    requiresContextCard: true,
    requiredFiles: [],
    readOrder: [],
    conditionalReads: [],
    pitfalls: [],
    outputLocation: 'inbox/',
    toneGuidance: '',
    sedimentTargets: ['inbox'],
    createdAt: iso,
    updatedAt: iso,
    body: [
      `# ${name}`,
      '',
      '## 触发场景',
      '',
      '## 必读，按顺序',
      '',
      '## 条件读',
      '',
      '## 任务前上下文包',
      '',
      '## 建议口径',
      '',
      '## 坑',
      '',
      '## 任务后沉淀',
      '',
    ].join('\n'),
  }
}

/** 创建/更新路线卡的输入。未提供的字段沿用已有值（或默认值）。 */
export interface PalaceRoomInput {
  id: string
  name: string
  description?: string
  triggers?: string[]
  requiredFiles?: string[]
  readOrder?: string[]
  conditionalReads?: string[]
  pitfalls?: string[]
  outputLocation?: string
  toneGuidance?: string
  sedimentTargets?: PalaceSedimentTarget[]
  priority?: number
  enabled?: boolean
  requiresContextCard?: boolean
  body?: string
}

/**
 * 把输入合并进基线路线卡（已有卡或默认卡）。纯函数，做字段清洗和范围约束，
 * 给 agent 工具和桌面端 IPC 共用，避免两处各写一遍合并逻辑。
 */
export function mergePalaceRoom(
  base: PalaceRoom,
  input: PalaceRoomInput,
  now: Date = new Date(),
): PalaceRoom {
  const priority = typeof input.priority === 'number' && Number.isFinite(input.priority)
    ? Math.max(0, Math.min(100, Math.floor(input.priority)))
    : base.priority
  return {
    ...base,
    id: input.id,
    name: input.name,
    description: input.description !== undefined ? input.description.trim() : base.description,
    triggers: cleanList(input.triggers) ?? base.triggers,
    priority,
    enabled: typeof input.enabled === 'boolean' ? input.enabled : base.enabled,
    requiresContextCard: typeof input.requiresContextCard === 'boolean' ? input.requiresContextCard : base.requiresContextCard,
    requiredFiles: cleanList(input.requiredFiles) ?? base.requiredFiles,
    readOrder: cleanList(input.readOrder) ?? base.readOrder,
    conditionalReads: cleanList(input.conditionalReads) ?? base.conditionalReads,
    pitfalls: cleanList(input.pitfalls) ?? base.pitfalls,
    outputLocation: (input.outputLocation && input.outputLocation.trim()) || base.outputLocation,
    toneGuidance: input.toneGuidance !== undefined ? input.toneGuidance.trim() : base.toneGuidance,
    sedimentTargets: input.sedimentTargets !== undefined
      ? input.sedimentTargets.filter(isSedimentTarget)
      : base.sedimentTargets,
    body: input.body !== undefined && input.body.trim() ? input.body : base.body,
    createdAt: base.createdAt,
    updatedAt: now.toISOString(),
  }
}

function cleanList(value: string[] | undefined): string[] | undefined {
  if (value === undefined) return undefined
  return value.map(v => String(v).trim()).filter(Boolean)
}

export function serializePalaceRoom(room: PalaceRoom): string {
  const meta: Record<string, unknown> = {
    schema_version: room.schemaVersion,
    id: room.id,
    name: room.name,
    description: room.description,
    triggers: room.triggers,
    priority: room.priority,
    enabled: room.enabled,
    requires_context_card: room.requiresContextCard,
    required_files: room.requiredFiles,
    read_order: room.readOrder,
    conditional_reads: room.conditionalReads,
    pitfalls: room.pitfalls,
    output_location: room.outputLocation,
    tone_guidance: room.toneGuidance,
    sediment_targets: room.sedimentTargets,
    created_at: room.createdAt,
    updated_at: room.updatedAt,
  }
  const body = room.body.trimStart()
  return `${buildFrontmatterBlock(meta)}\n\n${body.endsWith('\n') ? body : `${body}\n`}`
}

export function parsePalaceRoomMarkdown(markdown: string, fallbackId = ''): PalaceRoom {
  const { meta, body } = parseFrontmatterCore(markdown)
  const now = new Date(0).toISOString()
  const id = asNonEmptyString(meta.id, fallbackId)
  const name = asNonEmptyString(meta.name, id || '未命名路线卡')
  return {
    schemaVersion: PALACE_SCHEMA_VERSION,
    id,
    name,
    description: asString(meta.description),
    triggers: asStringArray(meta.triggers),
    priority: asNumber(meta.priority, DEFAULT_PRIORITY),
    enabled: asBoolean(meta.enabled, true),
    requiresContextCard: asBoolean(meta.requires_context_card, true),
    requiredFiles: asStringArray(meta.required_files),
    readOrder: asStringArray(meta.read_order),
    conditionalReads: asStringArray(meta.conditional_reads),
    pitfalls: asStringArray(meta.pitfalls),
    outputLocation: asNonEmptyString(meta.output_location, 'inbox/'),
    toneGuidance: asString(meta.tone_guidance),
    sedimentTargets: asSedimentTargets(meta.sediment_targets),
    createdAt: asNonEmptyString(meta.created_at, now),
    updatedAt: asNonEmptyString(meta.updated_at, now),
    body,
  }
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function asNonEmptyString(value: unknown, fallback: string): string {
  const s = asString(value)
  return s.length > 0 ? s : fallback
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((v): v is string => typeof v === 'string')
    .map(v => v.trim())
    .filter(Boolean)
}

function asNumber(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const n = Number(value)
    if (Number.isFinite(n)) return n
  }
  return fallback
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    if (value === 'true') return true
    if (value === 'false') return false
  }
  return fallback
}

function asSedimentTargets(value: unknown): PalaceSedimentTarget[] {
  const raw = asStringArray(value)
  return raw.filter(isSedimentTarget)
}

function isSedimentTarget(value: string): value is PalaceSedimentTarget {
  return [
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
  ].includes(value)
}
