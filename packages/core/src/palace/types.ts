/**
 * Palace — 职业处境记忆宫殿的数据协议。
 *
 * Palace 与 knowledge / skills / memory 并列：knowledge 存事实，skills 存做法，
 * memory 存长期偏好，Palace 存“某类任务开始前该想起什么”。
 */

export const PALACE_SCHEMA_VERSION = 1 as const
export const PALACE_PROTOCOL_VERSION = '2026-06-p0' as const

export const PALACE_ROOT_DIR = 'palace' as const
export const PALACE_MANIFEST_FILE = 'manifest.json' as const
export const PALACE_PROFILE_FILE = 'profile.md' as const
export const PALACE_COMPANY_FILE = 'company.md' as const
export const PALACE_COMMITMENTS_FILE = 'commitments.json' as const
export const PALACE_INBOX_FILE = 'items.json' as const

/**
 * 可读 Markdown 镜像与索引。JSON 仍是承诺/inbox 的唯一正本，这些 .md 在每次写入后
 * 自动重新生成，纯为“任何编辑器都能打开看”服务，手改不会回写。
 */
export const PALACE_COMMITMENTS_MD_FILE = 'commitments.md' as const
export const PALACE_INBOX_MD_FILE = 'inbox.md' as const
export const PALACE_INDEX_FILE = 'index.md' as const

export const PALACE_DIRECTORIES = [
  'people',
  'projects',
  'meetings',
  'reports',
  'decisions',
  'achievements',
  'wiki',
  'rooms',
  'inbox',
] as const

export type PalaceDirectory = typeof PALACE_DIRECTORIES[number]

export type PalaceSedimentTarget =
  | 'profile'
  | 'company'
  | 'people'
  | 'projects'
  | 'meetings'
  | 'reports'
  | 'decisions'
  | 'achievements'
  | 'wiki'
  | 'commitments'
  | 'rooms'
  | 'inbox'

export interface PalaceManifest {
  schemaVersion: typeof PALACE_SCHEMA_VERSION
  protocolVersion: typeof PALACE_PROTOCOL_VERSION
  avatarId: string
  createdAt: string
  updatedAt: string
  description: string
  directories: Record<PalaceDirectory, string>
  files: {
    profile: string
    company: string
    commitments: string
    inbox: string
    commitmentsMarkdown: string
    inboxMarkdown: string
    index: string
  }
}

/**
 * 任务路线卡。落盘为 `palace/rooms/<id>.md`，frontmatter 存结构化字段，
 * body 存人类可读的路线说明。
 */
export interface PalaceRoom {
  schemaVersion: typeof PALACE_SCHEMA_VERSION
  id: string
  name: string
  description: string
  triggers: string[]
  priority: number
  enabled: boolean
  requiresContextCard: boolean
  requiredFiles: string[]
  readOrder: string[]
  /** 条件读：每条形如「涉及 X → 重点看 Y」，按命中场景追加阅读，不是固定必读。 */
  conditionalReads: string[]
  pitfalls: string[]
  outputLocation: string
  /** 建议口径：任务前上下文包里给出的对外措辞/语气基调。 */
  toneGuidance: string
  sedimentTargets: PalaceSedimentTarget[]
  createdAt: string
  updatedAt: string
  body: string
}

export type PalaceCommitmentDirection =
  | 'i_owe_them'
  | 'they_owe_me'
  | 'mutual'
  | 'watch'

export type PalaceCommitmentStatus =
  | 'proposed'
  | 'open'
  | 'done'
  | 'blocked'
  | 'dropped'

export interface PalaceCommitment {
  id: string
  direction: PalaceCommitmentDirection
  title: string
  counterparty: string
  promise: string
  status: PalaceCommitmentStatus
  createdAt: string
  updatedAt: string
  dueAt?: string
  owner?: string
  source?: string
  tags?: string[]
  notes?: string[]
}

export interface PalaceCommitmentDocument {
  schemaVersion: typeof PALACE_SCHEMA_VERSION
  commitments: PalaceCommitment[]
}

export type PalaceInboxKind =
  | 'fact'
  | 'person'
  | 'project'
  | 'commitment'
  | 'writing'
  | 'route'
  | 'other'

export type PalaceInboxStatus = 'pending' | 'accepted' | 'rejected'

export interface PalaceInboxItem {
  id: string
  kind: PalaceInboxKind
  title: string
  content: string
  status: PalaceInboxStatus
  createdAt: string
  updatedAt: string
  target?: PalaceSedimentTarget
  source?: string
  confidence?: number
  tags?: string[]
}

export interface PalaceInboxDocument {
  schemaVersion: typeof PALACE_SCHEMA_VERSION
  items: PalaceInboxItem[]
}
