/**
 * soul-pack import：把 SoulPack 写到 avatars/<target-id>/。
 *
 * 安全设计：
 *   - **默认不覆盖**已存在 avatar；force=true 才覆盖
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
import type { SoulPack, SoulPackBinaryRef, SoulPackSkillsRef } from './manifest'

export interface ImportSoulPackOptions {
  /** 目标 avatar id；默认用 pack.name */
  targetAvatarId?: string
  /** 已存在时是否覆盖；默认 false */
  force?: boolean
  /** 是否还原 memory（从 pack.memory 写到 memory/）；默认 true（如果 pack 包含） */
  restoreMemory?: boolean
}

export interface ImportSoulPackResult {
  /** 目标 avatar id（resolveTargetId 后） */
  avatarId: string
  /** 写入的文件路径列表（相对 avatar 根，POSIX 风格） */
  filesWritten: string[]
  /** 二进制 ref：pack 里没有内容，导入端需手动补 */
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

  const targetRoot = path.join(avatarsPath, targetId)
  const exists = fs.existsSync(targetRoot)
  if (exists && !options.force) {
    throw new Error(`目标分身已存在: ${targetId}。传 force=true 覆盖（会清空原目录后再写）。`)
  }
  if (exists && options.force) {
    // 覆盖前清理（递归删除）。这是破坏性操作；调用方应已确认 force。
    fs.rmSync(targetRoot, { recursive: true, force: true })
  }
  fs.mkdirSync(targetRoot, { recursive: true })

  const warnings: string[] = []
  const filesWritten: string[] = []

  // 写 inline 文本文件
  for (const f of pack.files) {
    if (!isSafeRelativePath(f.path)) {
      throw new Error(`非法 file path（可能路径穿越）: ${f.path}`)
    }
    const fullPath = path.join(targetRoot, f.path)
    fs.mkdirSync(path.dirname(fullPath), { recursive: true })
    fs.writeFileSync(fullPath, f.content, 'utf-8')
    filesWritten.push(f.path)
  }

  // memory 还原（如果 pack 包含 + 选项允许）
  let memoryRestored = false
  if (pack.memory_included && pack.memory && options.restoreMemory !== false) {
    memoryRestored = restoreMemory(targetRoot, pack.memory, filesWritten, warnings)
  } else if (pack.memory_included && options.restoreMemory === false) {
    warnings.push('pack 包含 memory 但 restoreMemory=false，已跳过')
  }

  // 二进制 ref 提示
  if (pack.binary_refs.length > 0) {
    warnings.push(
      `pack 含 ${pack.binary_refs.length} 个二进制文件 ref（pack 不内联二进制内容）` +
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

  return {
    avatarId: targetId,
    filesWritten,
    binaryRefsMissing: pack.binary_refs,
    externalSkillsRequired: pack.external_skills,
    memoryRestored,
    warnings,
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
