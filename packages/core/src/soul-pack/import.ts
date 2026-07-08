/**
 * soul-pack import：把 SoulPack 写到 avatars/<target-id>/。
 *
 * 安全设计：
 *   - **默认不覆盖**已存在 avatar；replace 模式 force=true 整目录重置，
 *     update 模式覆盖更新（保留 memory/、life/、avatar.config.json、_index/_raw 与本地新增文件）
 *   - 目标 avatar id 走 assertSafeSegment 校验，防路径穿越
 *   - 每个 file 的 path 也走相对路径校验（不能含 `..` / 绝对路径）
 *   - binary_refs 不能恢复（无内容），报告给用户手动补
 *   - external_skills 不自动安装，提示用户跑 soul-sync.sh
 *
 * 不接管 memory：仅写到 memory/，由 SoulLoader 下次启动自然加载。
 *
 * @author zhi.qu
 * @date 2026-05-19
 */

import fs from 'fs'
import path from 'path'
import { assertSafeSegment } from '../utils/path-security'
import { sha256Hex } from './manifest'
import type { SoulPack, SoulPackBinaryRef, SoulPackSkillsRef } from './manifest'

export interface ImportSoulPackOptions {
  /** 目标 avatar id；默认用 pack.name */
  targetAvatarId?: string
  /** replace 模式下已存在时是否覆盖；默认 false */
  force?: boolean
  /**
   * 是否还原 memory（从 pack.memory 写到 memory/）。
   * replace 模式默认 true（如果 pack 包含）；update 模式默认 false（保留本机记忆，显式 true 才覆盖）。
   */
  restoreMemory?: boolean
  /**
   * 导入模式：
   *   - replace（默认）：目标已存在时需 force=true，先清空整个目录再写——重置为包快照
   *   - update：覆盖更新。不删目录，写入包内文件并按上次导入的包清单清理「新版包已移除」
   *     的旧包文件；保留本机运行期数据（memory/、life/、avatar.config.json、_index/_raw、
   *     用户本地新增的文件）
   */
  mode?: 'replace' | 'update'
  /**
   * 可选：二进制 blob 字节读取器。自包含 zip 分身包（.soulpack.zip）导入时，由 electron
   * 从解压目录 `blobs/<relPath>` 注入。传入时 importSoulPack 会**逐个校验 binary_ref 的
   * sha256 并写盘**，实现无损还原（Excel/PDF/图片/扫描件）；不传时维持原行为
   * （binary_refs 仅在 result.binaryRefsMissing 报告，需手动补齐）。
   * 返回 null 表示该 blob 不在包内（视为缺失，计入 binaryRefsMissing 并 warn，不抛错）。
   */
  readBlob?: (relPath: string) => Buffer | null
}

export interface ImportSoulPackResult {
  /** 目标 avatar id（resolveTargetId 后） */
  avatarId: string
  /** 实际执行的导入模式 */
  mode: 'replace' | 'update'
  /** 写入的文件路径列表（相对 avatar 根，POSIX 风格） */
  filesWritten: string[]
  /** update 模式：按上次包清单清理掉的文件（新版包已不包含） */
  filesRemoved: string[]
  /** update 模式：受保护跳过、未从包写入的路径 */
  filesSkipped: string[]
  /** 从包内 blobs 校验（sha256）通过并写盘的二进制文件（仅 readBlob 提供时可能非空） */
  binaryRefsWritten: SoulPackBinaryRef[]
  /** 二进制 ref：包内无字节（未提供 readBlob，或该 blob 缺失），导入端需手动补 */
  binaryRefsMissing: SoulPackBinaryRef[]
  /** 需要 import 端环境提供的外部 skills */
  externalSkillsRequired: SoulPackSkillsRef
  /** memory 是否被恢复 */
  memoryRestored: boolean
  /** 警告 / 提示 */
  warnings: string[]
}

/**
 * 把 pack 写到 avatars/<targetId>/。
 *
 * 错误：
 *   - target id 已存在且 force=false → throw
 *   - file path 含 `..` 或绝对路径 → throw（防穿越）
 *   - IO 失败 → throw
 */
export function importSoulPack(
  avatarsPath: string,
  pack: SoulPack,
  options: ImportSoulPackOptions = {},
): ImportSoulPackResult {
  const targetId = options.targetAvatarId ?? pack.name
  assertSafeSegment(targetId, 'targetAvatarId')

  // 完整 preflight：在任何破坏性操作之前把所有「可静态校验」的非法输入全部拦掉。
  // 否则 force=true 覆盖模式下，一个 manifest/hash 合法但含 ../ 路径的包会先 rmSync 删掉
  // 原分身、再在写入循环报错 → 原分身数据丢失。必须先校验、再删除、再写入。
  // readBlob 提供时，preflight 一并把「已存在的 blob」sha256 验完，杜绝篡改/损坏的 blob
  // 在 rmSync 之后才被发现。
  preflightImport(pack, options.readBlob)

  const mode = options.mode ?? 'replace'
  const targetRoot = path.join(avatarsPath, targetId)
  const exists = fs.existsSync(targetRoot)
  if (mode === 'replace') {
    if (exists && !options.force) {
      throw new Error(
        `目标分身已存在: ${targetId}。传 force=true 覆盖（会清空原目录后再写），` +
        `或用 mode='update' 覆盖更新（保留记忆与本地数据）。`,
      )
    }
    if (exists && options.force) {
      // 覆盖前清理（递归删除）。这是破坏性操作；调用方应已确认 force，且 preflight 已通过。
      fs.rmSync(targetRoot, { recursive: true, force: true })
    }
  }
  fs.mkdirSync(targetRoot, { recursive: true })

  const warnings: string[] = []
  const filesWritten: string[] = []
  const filesSkipped: string[] = []

  // update 模式：写入前先读上次导入的包清单，用于稍后清理新版包已移除的旧包文件
  const previousState = mode === 'update' ? readPackState(targetRoot) : null
  if (mode === 'update' && exists && !previousState) {
    warnings.push(
      '未找到上次导入的包清单（.soul-pack-state.json），无法识别旧版包文件，' +
      '新版包已移除的文件可能残留。',
    )
  }

  // 写 inline 文本文件
  for (const f of pack.files) {
    if (!isSafeRelativePath(f.path)) {
      throw new Error(`非法 file path（可能路径穿越）: ${f.path}`)
    }
    if (mode === 'update' && isProtectedOnUpdate(f.path, targetRoot)) {
      filesSkipped.push(f.path)
      continue
    }
    const fullPath = path.join(targetRoot, f.path)
    fs.mkdirSync(path.dirname(fullPath), { recursive: true })
    fs.writeFileSync(fullPath, f.content, 'utf-8')
    filesWritten.push(f.path)
  }

  // 二进制 blob 写盘：仅当调用方注入 readBlob（自包含 zip 分身包）。逐个校验 sha256 后落盘，
  // 实现无损还原；readBlob 缺 blob（返回 null）则计入 binaryRefsMissing，不抛错。
  const binaryRefsWritten: SoulPackBinaryRef[] = []
  const binaryRefsMissing: SoulPackBinaryRef[] = []
  for (const ref of pack.binary_refs) {
    if (!isSafeRelativePath(ref.path)) {
      throw new Error(`非法 binary ref path（可能路径穿越）: ${ref.path}`)
    }
    if (mode === 'update' && isProtectedOnUpdate(ref.path, targetRoot)) {
      filesSkipped.push(ref.path)
      continue
    }
    const buf = options.readBlob ? options.readBlob(ref.path) : null
    if (buf === null) {
      binaryRefsMissing.push(ref)
      continue
    }
    // 二次防御（preflight 已验）：解压目录可能在 preflight 与写入之间被并发改写（TOCTOU）
    if (sha256Hex(buf) !== ref.sha256) {
      throw new Error(`soul-pack blob sha256 校验失败（可能被篡改或损坏）: ${ref.path}`)
    }
    const fullPath = path.join(targetRoot, ref.path)
    fs.mkdirSync(path.dirname(fullPath), { recursive: true })
    fs.writeFileSync(fullPath, buf)
    filesWritten.push(ref.path)
    binaryRefsWritten.push(ref)
  }

  if (filesSkipped.length > 0) {
    warnings.push(
      `update 模式跳过 ${filesSkipped.length} 个受保护路径（memory/、life/、avatar.config.json、_index、_raw），本机数据保持不变。`,
    )
  }

  // update 模式：按上次包清单清理「新版包已不包含」的旧包文件。
  // 只删上次确认由包写入的路径——用户本地新增的文件不在清单里，永远不会被碰。
  const filesRemoved: string[] = []
  if (mode === 'update' && previousState) {
    const newPaths = new Set([
      ...pack.files.map((f) => f.path),
      ...pack.binary_refs.map((r) => r.path),
    ])
    for (const oldPath of previousState.files) {
      if (newPaths.has(oldPath)) continue
      // 清单可能被手工篡改：删除前重新做路径校验 + 保护路径校验
      if (!isSafeRelativePath(oldPath)) continue
      if (isProtectedOnUpdate(oldPath, targetRoot)) continue
      const full = path.join(targetRoot, oldPath)
      try {
        if (fs.existsSync(full) && fs.statSync(full).isFile()) {
          fs.rmSync(full)
          filesRemoved.push(oldPath)
        }
      } catch {
        warnings.push(`清理旧包文件失败: ${oldPath}`)
      }
    }
    if (filesRemoved.length > 0) {
      warnings.push(`已清理 ${filesRemoved.length} 个新版包中不再包含的旧包文件。`)
    }
  }

  // memory 还原：update 模式默认保留本机记忆（显式 restoreMemory=true 才用包内快照覆盖）；
  // replace 模式维持原行为（pack 包含时默认恢复）
  let memoryRestored = false
  const wantRestoreMemory =
    mode === 'update' ? options.restoreMemory === true : options.restoreMemory !== false
  if (pack.memory_included && pack.memory && wantRestoreMemory) {
    memoryRestored = restoreMemory(targetRoot, pack.memory, filesWritten, warnings)
  } else if (pack.memory_included && !wantRestoreMemory) {
    warnings.push(
      mode === 'update'
        ? 'pack 包含 memory，update 模式默认保留本机记忆，未恢复包内记忆'
        : 'pack 包含 memory 但 restoreMemory=false，已跳过',
    )
  }

  // 二进制文件提示：区分「已随包无损还原」与「仍缺字节需手动补齐」
  if (binaryRefsWritten.length > 0) {
    warnings.push(`已从包内 blobs 校验并无损还原 ${binaryRefsWritten.length} 个二进制文件。`)
  }
  if (binaryRefsMissing.length > 0) {
    warnings.push(
      `pack 含 ${binaryRefsMissing.length} 个二进制文件缺少字节` +
      `（.soulpack.json 不内联二进制；改用 .soulpack.zip 可无损携带）` +
      `；导入端需手动把同 sha256 的文件放到对应路径才能完整工作。详见 binaryRefsMissing。`,
    )
  }

  // external_skills 提示
  const sharedCount = pack.external_skills.shared.length
  const commCount = pack.external_skills.community.length
  if (sharedCount > 0 || commCount > 0) {
    const parts: string[] = []
    if (sharedCount > 0) parts.push(`${sharedCount} 个 shared skill`)
    if (commCount > 0) parts.push(`${commCount} 个 community skill 包`)
    warnings.push(
      `pack 引用了外部技能（${parts.join(' + ')}），import 端 shared/skills/ 若没装会按 skill-index.yaml 自动 fallback；community 需跑 scripts/soul-sync.sh 拉取。`,
    )
  }

  // 记录本次包清单（两种模式都写），供下次 update 识别包文件 / 比较版本
  writePackState(targetRoot, pack)

  return {
    avatarId: targetId,
    mode,
    filesWritten,
    filesRemoved,
    filesSkipped,
    binaryRefsWritten,
    binaryRefsMissing,
    externalSkillsRequired: pack.external_skills,
    memoryRestored,
    warnings,
  }
}

/** 上次导入的包清单文件（点前缀：export 扫描跳过隐藏文件，不会回流进新包） */
const PACK_STATE_FILE = '.soul-pack-state.json'

/** 已安装分身的包清单（每次 import 成功后写入 avatar 根目录） */
export interface SoulPackInstallState {
  pack_name: string
  pack_version: string
  manifest_sha256?: string
  /** 上次导入时包内文件的相对路径列表（inline 文本 + 二进制 ref），供 update 识别旧包文件 */
  files: string[]
}

/** 读取已安装分身的包清单；不存在 / 损坏返回 null。 */
export function readInstalledPackState(avatarsPath: string, avatarId: string): SoulPackInstallState | null {
  assertSafeSegment(avatarId, 'avatarId')
  return readPackState(path.join(avatarsPath, avatarId))
}

function readPackState(targetRoot: string): SoulPackInstallState | null {
  const p = path.join(targetRoot, PACK_STATE_FILE)
  if (!fs.existsSync(p)) return null
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf-8')) as Partial<SoulPackInstallState>
    if (!Array.isArray(raw.files)) return null
    return {
      pack_name: typeof raw.pack_name === 'string' ? raw.pack_name : '',
      pack_version: typeof raw.pack_version === 'string' ? raw.pack_version : '',
      manifest_sha256: typeof raw.manifest_sha256 === 'string' ? raw.manifest_sha256 : undefined,
      files: raw.files.filter((x): x is string => typeof x === 'string'),
    }
  } catch {
    return null
  }
}

function writePackState(targetRoot: string, pack: SoulPack): void {
  const state: SoulPackInstallState = {
    pack_name: pack.name,
    pack_version: pack.pack_version,
    manifest_sha256: pack.manifest_sha256,
    files: [...pack.files.map((f) => f.path), ...pack.binary_refs.map((r) => r.path)],
  }
  fs.writeFileSync(path.join(targetRoot, PACK_STATE_FILE), JSON.stringify(state, null, 2), 'utf-8')
}

/**
 * update 模式下不被包覆盖、也不参与旧文件清理的路径：
 *   - memory/、life/：本机运行期数据（记忆、想象人生），包内容不得静默覆盖
 *   - avatar.config.json：本机 LLM 配置 / 显示名（仅本机已存在时保护，否则照常写入）
 *   - 任意层级 _index：派生搜索索引，由本机按 hashes 增量重建
 *   - 任意层级 _raw：原始资料正本（二进制不入包，包内偶发的 _raw 文本也不得覆盖本机正本）
 */
function isProtectedOnUpdate(relPosix: string, targetRoot: string): boolean {
  const segs = relPosix.split('/')
  if (segs[0] === 'memory' || segs[0] === 'life') return true
  if (segs.includes('_index') || segs.includes('_raw')) return true
  if (relPosix === 'avatar.config.json') {
    return fs.existsSync(path.join(targetRoot, 'avatar.config.json'))
  }
  return false
}

/** import 上限：防资源炸弹（force 删除前就拦下，不污染原分身）。 */
const MAX_PACK_FILES = 10_000
const MAX_PACK_INLINE_BYTES = 500 * 1024 * 1024 // 500MB inline 文本总量

/**
 * 纯校验，不触碰文件系统：在 rmSync / 写入之前发现任何「会导致写入阶段 throw」的非法输入即抛，
 * 保证破坏性操作前已通过全部静态校验。
 * 只覆盖 throw 类问题（file path 穿越、数量/大小上限）；memory 里非法的 episode/daily 条目
 * 由 restoreMemory 跳过+warn（不 throw），不会造成"删除后失败"，故不在此拦截。
 */
function preflightImport(pack: SoulPack, readBlob?: (relPath: string) => Buffer | null): void {
  if (!Array.isArray(pack.files)) {
    throw new Error('soul-pack 非法：files 不是数组')
  }
  if (!Array.isArray(pack.binary_refs)) {
    throw new Error('soul-pack 非法：binary_refs 不是数组')
  }
  if (pack.files.length + pack.binary_refs.length > MAX_PACK_FILES) {
    throw new Error(`soul-pack 文件数（inline + binary）超过上限 ${MAX_PACK_FILES}`)
  }
  let totalBytes = 0
  for (const f of pack.files) {
    if (!isSafeRelativePath(f.path)) {
      throw new Error(`非法 file path（可能路径穿越）: ${f.path}`)
    }
    totalBytes += Buffer.byteLength(typeof f.content === 'string' ? f.content : '', 'utf-8')
    if (totalBytes > MAX_PACK_INLINE_BYTES) {
      throw new Error(`soul-pack inline 内容总大小超过上限 ${MAX_PACK_INLINE_BYTES} 字节`)
    }
  }
  for (const ref of pack.binary_refs) {
    // 防 zip-slip：binary_ref.path 也可能含 ../ / 绝对路径，必须在破坏性操作前拦下
    if (!isSafeRelativePath(ref.path)) {
      throw new Error(`非法 binary ref path（可能路径穿越）: ${ref.path}`)
    }
    // 提供 blob 读取器时，在 rmSync 之前把「已存在的 blob」sha256 验完——
    // 一旦某个 blob 与 manifest 声明的 sha256 不符（篡改/损坏），立刻抛，绝不先删原分身。
    if (readBlob) {
      const buf = readBlob(ref.path)
      if (buf !== null && sha256Hex(buf) !== ref.sha256) {
        throw new Error(`soul-pack blob sha256 校验失败（可能被篡改或损坏）: ${ref.path}`)
      }
    }
  }
}

/** 校验 path 安全：不能绝对路径 / 不能含 `..` 段 / 不能空 */
function isSafeRelativePath(p: string): boolean {
  if (!p || typeof p !== 'string') return false
  // 不能绝对路径
  if (path.isAbsolute(p)) return false
  if (/^[a-zA-Z]:[/\\]/.test(p)) return false // Windows drive letter
  // 不能含 .. 段（任一段）
  const parts = p.split(/[/\\]/)
  for (const seg of parts) {
    if (seg === '..' || seg === '') return false
  }
  return true
}

function restoreMemory(
  targetRoot: string,
  memory: NonNullable<SoulPack['memory']>,
  filesWritten: string[],
  warnings: string[],
): boolean {
  const memDir = path.join(targetRoot, 'memory')
  fs.mkdirSync(memDir, { recursive: true })
  let touched = false

  const writeText = (rel: string, content: string | undefined) => {
    if (typeof content !== 'string') return
    const p = path.join(memDir, rel)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, content, 'utf-8')
    filesWritten.push(`memory/${rel}`)
    touched = true
  }
  writeText('MEMORY.md', memory.structuredMemoryMd)
  writeText('USER.md', memory.userMd)
  writeText('standing-orders.md', memory.standingOrdersMd)

  if (memory.episodes && memory.episodes.length > 0) {
    const epDir = path.join(memDir, 'episodes')
    fs.mkdirSync(epDir, { recursive: true })
    for (const ep of memory.episodes) {
      if (typeof ep !== 'object' || ep === null) {
        warnings.push('episode entry 非对象，已跳过')
        continue
      }
      const cid = (ep as { conversationId?: unknown }).conversationId
      if (typeof cid !== 'string' || !/^[A-Za-z0-9._-]+$/.test(cid)) {
        warnings.push(`episode conversationId 非法或缺失，已跳过: ${String(cid)}`)
        continue
      }
      fs.writeFileSync(path.join(epDir, `${cid}.json`), JSON.stringify(ep, null, 2), 'utf-8')
      filesWritten.push(`memory/episodes/${cid}.json`)
      touched = true
    }
  }

  if (memory.dailySummaries && memory.dailySummaries.length > 0) {
    const dsDir = path.join(memDir, 'daily-summaries')
    fs.mkdirSync(dsDir, { recursive: true })
    for (const ds of memory.dailySummaries) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(ds.date)) {
        warnings.push(`daily summary date 非法格式，已跳过: ${ds.date}`)
        continue
      }
      fs.writeFileSync(path.join(dsDir, `${ds.date}.md`), ds.content, 'utf-8')
      filesWritten.push(`memory/daily-summaries/${ds.date}.md`)
      touched = true
    }
  }

  return touched
}
