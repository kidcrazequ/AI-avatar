/**
 * soul-pack export：把分身打包成 SoulPack 对象。
 *
 * 设计原则：
 *   - 默认**不**打包 memory / life（含隐私对话）；显式 opt-in
 *   - 默认**不**打包 wiki/concepts（属于 derived，import 后可重建）
 *   - 跳过 _index/ 目录（搜索索引，import 端自动重建）
 *   - 跳过 workspaces/（临时对话工作区）
 *   - 文本文件 inline，超 INLINE_MAX_BYTES 转 binary ref
 *
 * 不直接写文件——返回 SoulPack 对象，caller 决定怎么 serialize / 落盘。
 *
 * @author zhi.qu
 * @date 2026-05-19
 */

import fs from 'fs'
import path from 'path'
import { assertSafeSegment } from '../utils/path-security'
import { parse as parseYaml } from 'yaml'
import {
  SOUL_PACK_SCHEMA_VERSION,
  INLINE_MAX_BYTES,
  INLINE_EXTENSIONS,
  sha256Hex,
  guessMimeByExtension,
  toPosixPath,
  type SoulPack,
  type SoulPackFile,
  type SoulPackBinaryRef,
  type SoulPackSkillsRef,
  type SoulPackMemory,
} from './manifest'

/** 当前 soul-pack 工具版本（与 schema_version 解耦：工具迭代时升） */
const PACK_TOOL_VERSION = '1.0.0'

/** 不打包的顶层目录（相对 avatar 根） */
const SKIP_TOP_DIRS: ReadonlySet<string> = new Set([
  '_index',       // 搜索索引，import 后重建
  'workspaces',   // 临时对话工作区
])

export interface ExportSoulPackOptions {
  /** 默认 false：打包用户记忆（MEMORY.md / USER.md / standing-orders.md / episodes / daily-summaries） */
  includeMemory?: boolean
  /** 默认 false：打包想象人生（life/） */
  includeLife?: boolean
  /** 默认 false：打包 wiki/concepts（derived 数据，import 后可重建） */
  includeWiki?: boolean
  /** Pack 工具版本覆盖（一般用默认） */
  packVersion?: string
  /** display_name 覆盖；默认从 avatar.config.json / soul.md 提取 */
  displayName?: string
  /** description 覆盖 */
  description?: string
  /** domain 标签 */
  domain?: string
  /** 导出者标识 */
  createdBy?: string
}

/**
 * 导出 avatar 为 SoulPack 对象（不含 manifest_sha256；caller 调 serializeSoulPack 写出）。
 *
 * 失败抛 Error：avatar 不存在 / 必备文件缺失 / IO 错误。
 */
export function exportSoulPack(
  avatarsPath: string,
  avatarId: string,
  options: ExportSoulPackOptions = {},
): Omit<SoulPack, 'manifest_sha256'> {
  assertSafeSegment(avatarId, '分身ID')
  const avatarRoot = path.join(avatarsPath, avatarId)
  if (!fs.existsSync(avatarRoot) || !fs.statSync(avatarRoot).isDirectory()) {
    throw new Error(`分身不存在: ${avatarId}`)
  }

  // 读 avatar.config.json 提取元数据
  const config = readAvatarConfigSafe(avatarRoot)
  const display_name = options.displayName ?? config.displayName ?? avatarId
  const description = options.description ?? config.description ?? ''
  const domain = options.domain ?? config.domain

  // 扫文件
  const { files, binary_refs } = collectFiles(avatarRoot, options)

  // 外部技能引用（shared / community）
  const external_skills = readExternalSkillsRefs(avatarRoot)

  // 记忆（可选）
  const memory_included = !!options.includeMemory
  const memory = memory_included ? readMemorySnapshot(avatarRoot) : undefined

  const pack: Omit<SoulPack, 'manifest_sha256'> = {
    schema_version: SOUL_PACK_SCHEMA_VERSION,
    name: avatarId,
    display_name,
    description,
    domain,
    created_at: new Date().toISOString(),
    created_by: options.createdBy,
    pack_version: options.packVersion ?? PACK_TOOL_VERSION,
    default_llm: config.defaultLlm,
    files,
    binary_refs,
    external_skills,
    memory_included,
    memory,
  }
  return pack
}

interface AvatarConfigExtract {
  displayName?: string
  description?: string
  domain?: string
  defaultLlm?: { provider?: string; model?: string; temperature?: number }
}

function readAvatarConfigSafe(avatarRoot: string): AvatarConfigExtract {
  const configPath = path.join(avatarRoot, 'avatar.config.json')
  if (!fs.existsSync(configPath)) return {}
  try {
    const raw = fs.readFileSync(configPath, 'utf-8')
    const json = JSON.parse(raw) as Record<string, unknown>
    const extract: AvatarConfigExtract = {}
    if (typeof json.displayName === 'string') extract.displayName = json.displayName
    if (typeof json.description === 'string') extract.description = json.description
    if (typeof json.domain === 'string') extract.domain = json.domain
    if (typeof json.defaultModel === 'object' && json.defaultModel !== null) {
      const dm = json.defaultModel as Record<string, unknown>
      extract.defaultLlm = {
        provider: typeof dm.provider === 'string' ? dm.provider : undefined,
        model: typeof dm.model === 'string' ? dm.model : undefined,
        temperature: typeof dm.temperature === 'number' ? dm.temperature : undefined,
      }
    }
    return extract
  } catch (err) {
    console.warn(`[soul-pack] 读 avatar.config.json 失败: ${err instanceof Error ? err.message : String(err)}`)
    return {}
  }
}

/** 递归扫 avatar 目录收集文件，按 options 过滤敏感目录 */
function collectFiles(
  avatarRoot: string,
  options: ExportSoulPackOptions,
): { files: SoulPackFile[]; binary_refs: SoulPackBinaryRef[] } {
  const files: SoulPackFile[] = []
  const binary_refs: SoulPackBinaryRef[] = []

  const shouldSkipDir = (relTop: string): boolean => {
    if (SKIP_TOP_DIRS.has(relTop)) return true
    if (relTop === 'memory' && !options.includeMemory) return true
    if (relTop === 'life' && !options.includeLife) return true
    if (relTop === 'wiki' && !options.includeWiki) return true
    return false
  }

  function walk(dir: string): void {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch (err) {
      console.warn(`[soul-pack] readdir 失败 ${dir}: ${err instanceof Error ? err.message : String(err)}`)
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      const rel = toPosixPath(path.relative(avatarRoot, full))
      const topSegment = rel.split('/')[0]
      // 隐藏文件 / 系统文件跳过
      if (entry.name.startsWith('.')) continue
      if (entry.isDirectory()) {
        if (shouldSkipDir(topSegment)) continue
        walk(full)
        continue
      }
      if (!entry.isFile()) continue
      // memory 走单独 snapshot 函数（结构化，不走文件 inline）
      if (topSegment === 'memory') continue
      const ext = path.extname(entry.name).toLowerCase()
      const stat = fs.statSync(full)
      if (INLINE_EXTENSIONS.has(ext) && stat.size <= INLINE_MAX_BYTES) {
        try {
          const content = fs.readFileSync(full, 'utf-8')
          files.push({
            path: rel,
            content,
            sha256: sha256Hex(content),
            size: stat.size,
          })
        } catch (err) {
          console.warn(`[soul-pack] 读文件失败 ${full}: ${err instanceof Error ? err.message : String(err)}`)
        }
      } else {
        // 二进制 / 超大文本：算 hash + ref，不 inline
        try {
          const buf = fs.readFileSync(full)
          binary_refs.push({
            path: rel,
            sha256: sha256Hex(buf),
            size: stat.size,
            mime: guessMimeByExtension(entry.name),
          })
        } catch (err) {
          console.warn(`[soul-pack] hash 文件失败 ${full}: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
    }
  }

  walk(avatarRoot)
  // path 升序，便于 git diff 稳定
  // 用 UTF-16 字节序排序，跟 git 默认排序一致，便于 diff 稳定
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  binary_refs.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return { files, binary_refs }
}

/** 解析 skills/skill-index.yaml 提取 shared / community 引用 */
function readExternalSkillsRefs(avatarRoot: string): SoulPackSkillsRef {
  const out: SoulPackSkillsRef = { shared: [], community: [] }
  const indexPath = path.join(avatarRoot, 'skills', 'skill-index.yaml')
  if (!fs.existsSync(indexPath)) return out
  try {
    const raw = fs.readFileSync(indexPath, 'utf-8')
    const parsed = parseYaml(raw) as Record<string, unknown> | null
    if (!parsed || typeof parsed !== 'object') return out

    const shared = parsed.shared_skills
    if (Array.isArray(shared)) {
      for (const item of shared) {
        if (typeof item === 'object' && item !== null && typeof (item as { name?: unknown }).name === 'string') {
          out.shared.push((item as { name: string }).name)
        }
      }
    }
    const community = parsed.community_skills
    if (Array.isArray(community)) {
      for (const item of community) {
        if (typeof item !== 'object' || item === null) continue
        const it = item as Record<string, unknown>
        if (typeof it.name !== 'string' || typeof it.repo !== 'string' || typeof it.ref !== 'string') continue
        const skills = Array.isArray(it.skills)
          ? it.skills.filter((s): s is string => typeof s === 'string')
          : []
        out.community.push({ name: it.name, repo: it.repo, ref: it.ref, skills })
      }
    }
  } catch (err) {
    console.warn(`[soul-pack] 解析 skill-index.yaml 失败: ${err instanceof Error ? err.message : String(err)}`)
  }
  return out
}

/** 读 memory 快照（仅 includeMemory=true 调用） */
function readMemorySnapshot(avatarRoot: string): SoulPackMemory {
  const memDir = path.join(avatarRoot, 'memory')
  const out: SoulPackMemory = {}

  const tryReadText = (rel: string): string | undefined => {
    const p = path.join(memDir, rel)
    if (!fs.existsSync(p)) return undefined
    try {
      return fs.readFileSync(p, 'utf-8')
    } catch {
      return undefined
    }
  }
  out.structuredMemoryMd = tryReadText('MEMORY.md')
  out.userMd = tryReadText('USER.md')
  out.standingOrdersMd = tryReadText('standing-orders.md')

  // episodes/*.json
  const epDir = path.join(memDir, 'episodes')
  if (fs.existsSync(epDir)) {
    const episodes: unknown[] = []
    for (const f of fs.readdirSync(epDir)) {
      if (!f.endsWith('.json')) continue
      try {
        const raw = fs.readFileSync(path.join(epDir, f), 'utf-8')
        episodes.push(JSON.parse(raw))
      } catch {
        // 损坏的 episode 跳过
      }
    }
    if (episodes.length > 0) out.episodes = episodes
  }

  // daily-summaries/*.md
  const dsDir = path.join(memDir, 'daily-summaries')
  if (fs.existsSync(dsDir)) {
    const summaries: Array<{ date: string; content: string }> = []
    for (const f of fs.readdirSync(dsDir)) {
      if (!f.endsWith('.md')) continue
      const date = f.replace(/\.md$/, '')
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue
      try {
        summaries.push({ date, content: fs.readFileSync(path.join(dsDir, f), 'utf-8') })
      } catch {
        // skip
      }
    }
    if (summaries.length > 0) out.dailySummaries = summaries
  }

  return out
}
