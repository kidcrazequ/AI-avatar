/**
 * Palace 职业工作区读写。
 */

import fs from 'fs'
import path from 'path'

import {
  getPalaceCommitmentsMarkdownPath,
  getPalaceCommitmentsPath,
  getPalaceCompanyPath,
  getPalaceDir,
  getPalaceDirectoryPath,
  getPalaceIndexPath,
  getPalaceInboxMarkdownPath,
  getPalaceInboxPath,
  getPalaceManifestPath,
  getPalaceProfilePath,
  getPalaceRoomPath,
  getPalaceRoomsDir,
} from './paths'
import {
  PALACE_DIRECTORIES,
  PALACE_PROTOCOL_VERSION,
  PALACE_SCHEMA_VERSION,
  type PalaceCommitmentDocument,
  type PalaceDirectory,
  type PalaceInboxDocument,
  type PalaceManifest,
  type PalaceRoom,
} from './types'
import {
  makeDefaultPalaceRoom,
  mergePalaceRoom,
  parsePalaceRoomMarkdown,
  serializePalaceRoom,
  type PalaceRoomInput,
} from './room'
import {
  renderPalaceCommitmentsMarkdown,
  renderPalaceInboxMarkdown,
} from './markdown-mirror'
import { buildPalaceIndexMarkdown } from './index-builder'
import { buildExamplePalaceRooms } from './seed-rooms'
import {
  addPalaceCommitmentToDocument,
  filterPalaceCommitments,
  normalizePalaceCommitmentDocument,
  updatePalaceCommitmentInDocument,
  type PalaceCommitmentCreateInput,
  type PalaceCommitmentFilter,
  type PalaceCommitmentUpdatePatch,
  type PalaceCommitmentView,
} from './commitments'
import {
  addPalaceInboxItemToDocument,
  filterPalaceInboxItems,
  normalizePalaceInboxDocument,
  updatePalaceInboxItemInDocument,
  type PalaceInboxCreateInput,
  type PalaceInboxFilter,
  type PalaceInboxItemView,
  type PalaceInboxUpdatePatch,
} from './inbox'

const JSON_INDENT = 2

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
    try { await fs.promises.unlink(tmpPath) } catch { /* ignore cleanup failure */ }
    throw err
  }
}

async function readTextSafe(filePath: string): Promise<string | null> {
  try {
    return await fs.promises.readFile(filePath, 'utf-8')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return null
    throw err
  }
}

async function readJsonSafe<T>(filePath: string): Promise<T | null> {
  const text = await readTextSafe(filePath)
  if (text === null) return null
  try {
    return JSON.parse(text) as T
  } catch (err) {
    throw new Error(
      `palace-store: 解析 JSON 失败 ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    )
  }
}

function serializeJson(value: unknown): string {
  return `${JSON.stringify(value, null, JSON_INDENT)}\n`
}

export function buildDefaultPalaceManifest(
  avatarId: string,
  now: Date = new Date(),
): PalaceManifest {
  const iso = now.toISOString()
  return {
    schemaVersion: PALACE_SCHEMA_VERSION,
    protocolVersion: PALACE_PROTOCOL_VERSION,
    avatarId,
    createdAt: iso,
    updatedAt: iso,
    description: '职业处境记忆宫殿：记录任务路线、人物项目上下文、承诺闭环和待确认沉淀。',
    directories: {
      people: 'people/',
      projects: 'projects/',
      meetings: 'meetings/',
      reports: 'reports/',
      decisions: 'decisions/',
      achievements: 'achievements/',
      wiki: 'wiki/',
      rooms: 'rooms/',
      inbox: 'inbox/',
    },
    files: {
      profile: 'profile.md',
      company: 'company.md',
      commitments: 'commitments.json',
      inbox: 'inbox/items.json',
      commitmentsMarkdown: 'commitments.md',
      inboxMarkdown: 'inbox/inbox.md',
      index: 'index.md',
    },
  }
}

export function emptyPalaceCommitmentDocument(): PalaceCommitmentDocument {
  return { schemaVersion: PALACE_SCHEMA_VERSION, commitments: [] }
}

export function emptyPalaceInboxDocument(): PalaceInboxDocument {
  return { schemaVersion: PALACE_SCHEMA_VERSION, items: [] }
}

export function buildDefaultPalaceProfile(): string {
  return [
    '# Profile',
    '',
    '> 记录用户当前职业画像、角色目标、沟通偏好和长期边界。',
    '',
    '## 当前角色',
    '',
    '## 风格偏好',
    '',
    '## 长期目标',
    '',
  ].join('\n')
}

export function buildDefaultPalaceCompany(): string {
  return [
    '# Company',
    '',
    '> 记录当前组织、团队结构、协作关系和敏感边界。',
    '',
    '## 组织结构',
    '',
    '## 关键关系',
    '',
    '## 敏感边界',
    '',
  ].join('\n')
}

/**
 * 初始化 Palace 文件树。幂等：已有文件不覆盖，只补缺失目录和基础文件。
 */
export async function ensurePalaceWorkspace(
  avatarsRoot: string,
  avatarId: string,
  now: Date = new Date(),
  seedExamples = false,
): Promise<PalaceManifest> {
  const palaceDir = getPalaceDir(avatarsRoot, avatarId)
  await fs.promises.mkdir(palaceDir, { recursive: true })
  for (const dir of PALACE_DIRECTORIES) {
    await fs.promises.mkdir(getPalaceDirectoryPath(avatarsRoot, avatarId, dir), { recursive: true })
  }

  let manifest = await readPalaceManifest(avatarsRoot, avatarId)
  const isNew = !manifest
  if (!manifest) {
    manifest = buildDefaultPalaceManifest(avatarId, now)
    await writePalaceManifest(avatarsRoot, avatarId, manifest)
  }
  await writeIfMissing(getPalaceProfilePath(avatarsRoot, avatarId), buildDefaultPalaceProfile())
  await writeIfMissing(getPalaceCompanyPath(avatarsRoot, avatarId), buildDefaultPalaceCompany())
  await writeIfMissing(getPalaceCommitmentsPath(avatarsRoot, avatarId), serializeJson(emptyPalaceCommitmentDocument()))
  await writeIfMissing(getPalaceInboxPath(avatarsRoot, avatarId), serializeJson(emptyPalaceInboxDocument()))
  // 仅在首次创建且调用方显式要求时种入示例路线卡，避免“宫殿空房子”；
  // 不覆盖已存在的同名卡，也不向已建好的老宫殿注入。
  if (isNew && seedExamples) await seedExamplePalaceRooms(avatarsRoot, avatarId, now)
  // 补齐可读 Markdown 镜像和索引（也覆盖老分身升级场景：已有 JSON 但还没 .md）。
  await ensurePalaceReadableArtifacts(avatarsRoot, avatarId, now)
  return manifest
}

/**
 * 种入内置示例路线卡。幂等：用 writeIfMissing，已存在的同名卡不覆盖。
 * 返回本次实际新增的卡数（用于回填脚本汇报）。不自动重建索引，调用方按需重建。
 */
export async function seedExamplePalaceRooms(
  avatarsRoot: string,
  avatarId: string,
  now: Date = new Date(),
): Promise<number> {
  let written = 0
  for (const room of buildExamplePalaceRooms(now)) {
    if (await writeIfMissing(getPalaceRoomPath(avatarsRoot, avatarId, room.id), serializePalaceRoom(room))) {
      written += 1
    }
  }
  return written
}

async function ensurePalaceReadableArtifacts(
  avatarsRoot: string,
  avatarId: string,
  now: Date,
): Promise<void> {
  const commitmentsMd = getPalaceCommitmentsMarkdownPath(avatarsRoot, avatarId)
  if (!(await fileExists(commitmentsMd))) {
    await atomicWrite(commitmentsMd, renderPalaceCommitmentsMarkdown(await readPalaceCommitments(avatarsRoot, avatarId), now))
  }
  const inboxMd = getPalaceInboxMarkdownPath(avatarsRoot, avatarId)
  if (!(await fileExists(inboxMd))) {
    await atomicWrite(inboxMd, renderPalaceInboxMarkdown(await readPalaceInbox(avatarsRoot, avatarId), now))
  }
  if (!(await fileExists(getPalaceIndexPath(avatarsRoot, avatarId)))) {
    await regeneratePalaceIndex(avatarsRoot, avatarId, now)
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.promises.access(filePath)
    return true
  } catch {
    return false
  }
}

async function listPalaceDirFiles(
  avatarsRoot: string,
  avatarId: string,
  directory: PalaceDirectory,
): Promise<string[]> {
  try {
    const entries = await fs.promises.readdir(
      getPalaceDirectoryPath(avatarsRoot, avatarId, directory),
      { withFileTypes: true },
    )
    return entries
      .filter(e => e.isFile() && !e.name.startsWith('.') && e.name.endsWith('.md'))
      .map(e => e.name)
      .sort()
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
}

export interface PalaceContextExtras {
  peopleProfiles: Array<{ name: string; content: string }>
  materials: string[]
}

/**
 * 为任务前上下文包补齐“对方画像 + 能用素材”：
 * - peopleProfiles：people/ 下名字出现在任务文本里的人物档案。
 * - materials：achievements/ 与 reports/ 里最近的若干文件路径，作为可复用素材线索。
 * 纯按文件名启发匹配，不解析正文，cap 住数量，开销有界。
 */
export async function listPalaceContextExtras(
  avatarsRoot: string,
  avatarId: string,
  task: string,
  limit = 3,
): Promise<PalaceContextExtras> {
  const cap = Math.max(1, Math.min(8, Math.floor(limit)))
  const taskLc = task.toLowerCase()
  const peopleDir = getPalaceDirectoryPath(avatarsRoot, avatarId, 'people')
  const peopleFiles = await listPalaceDirFiles(avatarsRoot, avatarId, 'people')
  const peopleProfiles: Array<{ name: string; content: string }> = []
  for (const file of peopleFiles) {
    const name = file.replace(/\.md$/i, '').trim()
    // 至少两个字符，避免 people/a.md 这种单字名子串命中几乎所有任务。
    if (name.length < 2 || !taskLc.includes(name.toLowerCase())) continue
    const content = (await readTextSafe(path.join(peopleDir, file))) ?? ''
    peopleProfiles.push({ name, content })
    if (peopleProfiles.length >= cap) break
  }

  const [achievements, reports] = await Promise.all([
    listPalaceDirFiles(avatarsRoot, avatarId, 'achievements'),
    listPalaceDirFiles(avatarsRoot, avatarId, 'reports'),
  ])
  const materials = [
    ...achievements.slice(-cap).reverse().map(f => `achievements/${f}`),
    ...reports.slice(-cap).reverse().map(f => `reports/${f}`),
  ]
  return { peopleProfiles, materials }
}

/**
 * 重新生成 palace/index.md。按人物/项目/时间聚合各目录文件 + 承诺 + 路线卡。
 * 在路线卡、承诺变更后调用；纯按文件名和结构化字段聚合，开销有界。
 */
export async function regeneratePalaceIndex(
  avatarsRoot: string,
  avatarId: string,
  now: Date = new Date(),
): Promise<void> {
  await fs.promises.mkdir(getPalaceDir(avatarsRoot, avatarId), { recursive: true })
  const [rooms, commitmentsDoc, people, projects, meetings, reports, decisions, achievements] = await Promise.all([
    listPalaceRooms(avatarsRoot, avatarId),
    readPalaceCommitments(avatarsRoot, avatarId),
    listPalaceDirFiles(avatarsRoot, avatarId, 'people'),
    listPalaceDirFiles(avatarsRoot, avatarId, 'projects'),
    listPalaceDirFiles(avatarsRoot, avatarId, 'meetings'),
    listPalaceDirFiles(avatarsRoot, avatarId, 'reports'),
    listPalaceDirFiles(avatarsRoot, avatarId, 'decisions'),
    listPalaceDirFiles(avatarsRoot, avatarId, 'achievements'),
  ])
  const markdown = buildPalaceIndexMarkdown({
    now,
    rooms,
    commitments: commitmentsDoc.commitments,
    dirs: { people, projects, meetings, reports, decisions, achievements },
  })
  await atomicWrite(getPalaceIndexPath(avatarsRoot, avatarId), markdown)
}

/** 仅当文件不存在时写入。返回 true 表示本次写了，false 表示已存在被跳过。 */
async function writeIfMissing(filePath: string, content: string): Promise<boolean> {
  try {
    await fs.promises.writeFile(filePath, content, { encoding: 'utf-8', flag: 'wx' })
    return true
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'EEXIST') throw err
    return false
  }
}

export async function readPalaceManifest(
  avatarsRoot: string,
  avatarId: string,
): Promise<PalaceManifest | null> {
  return readJsonSafe<PalaceManifest>(getPalaceManifestPath(avatarsRoot, avatarId))
}

export async function writePalaceManifest(
  avatarsRoot: string,
  avatarId: string,
  manifest: PalaceManifest,
): Promise<void> {
  await fs.promises.mkdir(getPalaceDir(avatarsRoot, avatarId), { recursive: true })
  await atomicWrite(getPalaceManifestPath(avatarsRoot, avatarId), serializeJson(manifest))
}

export async function readPalaceProfile(avatarsRoot: string, avatarId: string): Promise<string> {
  return (await readTextSafe(getPalaceProfilePath(avatarsRoot, avatarId))) ?? ''
}

export async function writePalaceProfile(
  avatarsRoot: string,
  avatarId: string,
  content: string,
): Promise<void> {
  await ensurePalaceWorkspace(avatarsRoot, avatarId)
  await atomicWrite(getPalaceProfilePath(avatarsRoot, avatarId), content)
}

export async function readPalaceCompany(avatarsRoot: string, avatarId: string): Promise<string> {
  return (await readTextSafe(getPalaceCompanyPath(avatarsRoot, avatarId))) ?? ''
}

export async function writePalaceCompany(
  avatarsRoot: string,
  avatarId: string,
  content: string,
): Promise<void> {
  await ensurePalaceWorkspace(avatarsRoot, avatarId)
  await atomicWrite(getPalaceCompanyPath(avatarsRoot, avatarId), content)
}

export async function readPalaceCommitments(
  avatarsRoot: string,
  avatarId: string,
): Promise<PalaceCommitmentDocument> {
  return normalizePalaceCommitmentDocument(
    (await readJsonSafe<PalaceCommitmentDocument>(getPalaceCommitmentsPath(avatarsRoot, avatarId)))
      ?? emptyPalaceCommitmentDocument(),
  )
}

export async function writePalaceCommitments(
  avatarsRoot: string,
  avatarId: string,
  document: PalaceCommitmentDocument,
): Promise<void> {
  await ensurePalaceWorkspace(avatarsRoot, avatarId)
  const normalized = normalizePalaceCommitmentDocument(document)
  await atomicWrite(getPalaceCommitmentsPath(avatarsRoot, avatarId), serializeJson(normalized))
  await atomicWrite(getPalaceCommitmentsMarkdownPath(avatarsRoot, avatarId), renderPalaceCommitmentsMarkdown(normalized))
  await regeneratePalaceIndex(avatarsRoot, avatarId)
}

export async function listPalaceCommitmentViews(
  avatarsRoot: string,
  avatarId: string,
  filter: PalaceCommitmentFilter = {},
): Promise<PalaceCommitmentView[]> {
  const document = await readPalaceCommitments(avatarsRoot, avatarId)
  return filterPalaceCommitments(document, filter)
}

export async function addPalaceCommitment(
  avatarsRoot: string,
  avatarId: string,
  input: PalaceCommitmentCreateInput,
  now: Date = new Date(),
): Promise<PalaceCommitmentView> {
  await ensurePalaceWorkspace(avatarsRoot, avatarId, now)
  const current = await readPalaceCommitments(avatarsRoot, avatarId)
  const { document, commitment } = addPalaceCommitmentToDocument(current, input, now)
  await writePalaceCommitments(avatarsRoot, avatarId, document)
  return filterPalaceCommitments(
    { schemaVersion: PALACE_SCHEMA_VERSION, commitments: [commitment] },
    { includeClosed: true, now },
  )[0]!
}

export async function updatePalaceCommitmentEntry(
  avatarsRoot: string,
  avatarId: string,
  id: string,
  patch: PalaceCommitmentUpdatePatch,
  now: Date = new Date(),
): Promise<PalaceCommitmentView> {
  await ensurePalaceWorkspace(avatarsRoot, avatarId, now)
  const current = await readPalaceCommitments(avatarsRoot, avatarId)
  const { document, commitment } = updatePalaceCommitmentInDocument(current, id, patch, now)
  await writePalaceCommitments(avatarsRoot, avatarId, document)
  return filterPalaceCommitments(
    { schemaVersion: PALACE_SCHEMA_VERSION, commitments: [commitment] },
    { includeClosed: true, now },
  )[0]!
}

export async function readPalaceInbox(
  avatarsRoot: string,
  avatarId: string,
): Promise<PalaceInboxDocument> {
  return normalizePalaceInboxDocument(
    (await readJsonSafe<PalaceInboxDocument>(getPalaceInboxPath(avatarsRoot, avatarId)))
      ?? emptyPalaceInboxDocument(),
  )
}

export async function writePalaceInbox(
  avatarsRoot: string,
  avatarId: string,
  document: PalaceInboxDocument,
): Promise<void> {
  await ensurePalaceWorkspace(avatarsRoot, avatarId)
  const normalized = normalizePalaceInboxDocument(document)
  await atomicWrite(getPalaceInboxPath(avatarsRoot, avatarId), serializeJson(normalized))
  await atomicWrite(getPalaceInboxMarkdownPath(avatarsRoot, avatarId), renderPalaceInboxMarkdown(normalized))
}

export async function listPalaceInboxItems(
  avatarsRoot: string,
  avatarId: string,
  filter: PalaceInboxFilter = {},
): Promise<PalaceInboxItemView[]> {
  const document = await readPalaceInbox(avatarsRoot, avatarId)
  return filterPalaceInboxItems(document, filter)
}

export async function addPalaceInboxItem(
  avatarsRoot: string,
  avatarId: string,
  input: PalaceInboxCreateInput,
  now: Date = new Date(),
): Promise<PalaceInboxItemView> {
  await ensurePalaceWorkspace(avatarsRoot, avatarId, now)
  const current = await readPalaceInbox(avatarsRoot, avatarId)
  const { document, item } = addPalaceInboxItemToDocument(current, input, now)
  await writePalaceInbox(avatarsRoot, avatarId, document)
  return item
}

export async function updatePalaceInboxItemEntry(
  avatarsRoot: string,
  avatarId: string,
  id: string,
  patch: PalaceInboxUpdatePatch,
  now: Date = new Date(),
): Promise<PalaceInboxItemView> {
  await ensurePalaceWorkspace(avatarsRoot, avatarId, now)
  const current = await readPalaceInbox(avatarsRoot, avatarId)
  const { document, item } = updatePalaceInboxItemInDocument(current, id, patch, now)
  await writePalaceInbox(avatarsRoot, avatarId, document)
  return item
}

export async function writePalaceRoom(
  avatarsRoot: string,
  avatarId: string,
  room: PalaceRoom,
): Promise<void> {
  await ensurePalaceWorkspace(avatarsRoot, avatarId)
  await atomicWrite(getPalaceRoomPath(avatarsRoot, avatarId, room.id), serializePalaceRoom(room))
  await regeneratePalaceIndex(avatarsRoot, avatarId)
}

/**
 * 创建或更新一张路线卡：读已有卡（或默认卡）→ 合并输入 → 落盘 → 重建索引。
 * 给 agent 工具和桌面端 IPC 共用。
 */
export async function upsertPalaceRoom(
  avatarsRoot: string,
  avatarId: string,
  input: PalaceRoomInput,
  now: Date = new Date(),
): Promise<{ room: PalaceRoom; created: boolean }> {
  const existing = await readPalaceRoom(avatarsRoot, avatarId, input.id)
  const base = existing ?? makeDefaultPalaceRoom(input.id, input.name, now)
  const room = mergePalaceRoom(base, input, now)
  await writePalaceRoom(avatarsRoot, avatarId, room)
  return { room, created: !existing }
}

export async function readPalaceRoom(
  avatarsRoot: string,
  avatarId: string,
  roomId: string,
): Promise<PalaceRoom | null> {
  const text = await readTextSafe(getPalaceRoomPath(avatarsRoot, avatarId, roomId))
  if (text === null) return null
  return parsePalaceRoomMarkdown(text, roomId)
}

export async function listPalaceRooms(
  avatarsRoot: string,
  avatarId: string,
): Promise<PalaceRoom[]> {
  const dir = getPalaceRoomsDir(avatarsRoot, avatarId)
  let entries: fs.Dirent[]
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true })
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return []
    throw err
  }
  const rooms: PalaceRoom[] = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md') || entry.name.startsWith('.')) continue
    const id = entry.name.slice(0, -3)
    const room = await readPalaceRoom(avatarsRoot, avatarId, id)
    if (room) rooms.push(room)
  }
  rooms.sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id))
  return rooms
}

export async function deletePalaceRoom(
  avatarsRoot: string,
  avatarId: string,
  roomId: string,
): Promise<void> {
  let removed = false
  try {
    await fs.promises.unlink(getPalaceRoomPath(avatarsRoot, avatarId, roomId))
    removed = true
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') throw err
  }
  // 只有真的删掉了卡才重建索引，避免对不存在的 id 做无谓的全目录重扫。
  if (removed) await regeneratePalaceIndex(avatarsRoot, avatarId)
}
