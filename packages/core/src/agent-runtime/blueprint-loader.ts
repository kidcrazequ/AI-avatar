/**
 * 从分身目录（avatars/<id>/ 或 expert-packs/<id>/）装配 AgentBlueprint。
 *
 * 数据源：
 *   - expert-pack.json    → id / name / description / version / author / domain / redline
 *   - soul.md             → persona（首段非引用文本）
 *   - CLAUDE.md           → ruleLayers 第一项
 *   - skills/skill-index.yaml → SkillRefs
 *   - knowledge/          → KBScope（read-only，路径相对仓库根）
 *
 * 设计原则：
 *   - 失败时 fallback 到合理默认值（部分字段缺失不应让整个 blueprint 装配失败）
 *   - 不修改文件系统，纯读
 *   - 不依赖 Electron / DOM 模块
 */

import fs from 'fs'
import path from 'path'
import { parse as parseYaml } from 'yaml'
import {
  AgentBlueprintSchema,
  type AgentBlueprint,
  type SkillRef,
} from './blueprint'

interface ExpertPackJson {
  id?: string
  name?: string
  description?: string
  domain?: string
  version?: string
  author?: string
  redline?: string
}

interface SkillIndexEntry {
  name?: string
  path?: string
  source?: 'local' | 'shared' | 'community'
  domain?: string
  keywords?: string[]
  when?: string
  priority?: number
  version?: string
}

interface SkillIndexFile {
  version?: string
  local_skills?: SkillIndexEntry[]
  shared_skills?: SkillIndexEntry[]
  community_skills?: SkillIndexEntry[]
}

export interface LoadBlueprintOptions {
  /** 分身目录绝对路径（如 .../avatars/finance-expert 或 .../expert-packs/finance-expert） */
  avatarDir: string
  /** 仓库根目录绝对路径，用于规范化 KBScope.path */
  repoRoot: string
  /** 父代理 id（Phase 3 SpawnGuard 用） */
  parentAgentId?: string
}

/**
 * 装配 Blueprint 主入口。所有 IO 错误转为 throw，schema 校验失败也会 throw。
 */
export function loadBlueprintFromAvatarDir(opts: LoadBlueprintOptions): AgentBlueprint {
  const { avatarDir, repoRoot, parentAgentId } = opts

  if (!fs.existsSync(avatarDir) || !fs.statSync(avatarDir).isDirectory()) {
    throw new Error(`分身目录不存在或不是目录：${avatarDir}`)
  }

  const expertPack = readExpertPackJson(avatarDir)
  const soulMdPath = path.join(avatarDir, 'soul.md')
  const claudeMdPath = path.join(avatarDir, 'CLAUDE.md')
  const agentsMdPath = path.join(avatarDir, 'AGENTS.md')

  const persona = readPersona(soulMdPath)
  const id = expertPack.id || path.basename(avatarDir)
  const name = expertPack.name || readFirstHeading(soulMdPath) || readFirstHeading(claudeMdPath) || id

  const ruleLayers = [claudeMdPath, soulMdPath, agentsMdPath].filter((p) => fs.existsSync(p))

  const skills = readSkillIndex(avatarDir)
  const kbScopes = readKBScopes(avatarDir, repoRoot)

  const raw = {
    identity: {
      id,
      name,
      persona,
      scope: expertPack.domain || '',
      owner: expertPack.author || '',
      version: expertPack.version || '0.1.0',
      tags: [],
      description: expertPack.description || '',
      redline: expertPack.redline || '',
    },
    ruleLayers,
    skills,
    tools: [],
    kbScopes,
    memoryPolicy: {},
    permission: {},
    budget: {},
    parentAgentId,
    metadata: {
      avatarDir,
      hasMemoryDir: fs.existsSync(path.join(avatarDir, 'memory')),
    },
  }

  return AgentBlueprintSchema.parse(raw)
}

// ── 内部辅助 ─────────────────────────────────────────────────────────────

function readExpertPackJson(avatarDir: string): ExpertPackJson {
  const p = path.join(avatarDir, 'expert-pack.json')
  if (!fs.existsSync(p)) return {}
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8')) as ExpertPackJson
  } catch {
    return {}
  }
}

function readPersona(soulMdPath: string): string {
  if (!fs.existsSync(soulMdPath)) return ''
  const content = fs.readFileSync(soulMdPath, 'utf-8')
  // 取第一段实际段落（跳过标题、引用块、空行、horizontal rule）
  const lines = content.split('\n')
  const buf: string[] = []
  let started = false
  for (const line of lines) {
    const t = line.trim()
    if (!started) {
      if (t.startsWith('#') || t.startsWith('>') || t === '' || t === '---') continue
      started = true
      buf.push(t)
      continue
    }
    if (t === '') break
    if (t.startsWith('#')) break
    buf.push(t)
  }
  const para = buf.join(' ').trim()
  // 截到 600 字防止 persona 过长撑爆 system prompt
  return para.length > 600 ? para.slice(0, 600) + '…' : para
}

function readFirstHeading(mdPath: string): string {
  if (!fs.existsSync(mdPath)) return ''
  const content = fs.readFileSync(mdPath, 'utf-8')
  const m = content.match(/^#\s+(.+)$/m)
  return m ? m[1].trim() : ''
}

function readSkillIndex(avatarDir: string): SkillRef[] {
  const indexPath = path.join(avatarDir, 'skills', 'skill-index.yaml')
  if (!fs.existsSync(indexPath)) return []
  let parsed: SkillIndexFile
  try {
    parsed = parseYaml(fs.readFileSync(indexPath, 'utf-8')) as SkillIndexFile
  } catch {
    return []
  }
  const groups: Array<[SkillIndexEntry[] | undefined, 'local' | 'shared' | 'community']> = [
    [parsed.local_skills, 'local'],
    [parsed.shared_skills, 'shared'],
    [parsed.community_skills, 'community'],
  ]
  const refs: SkillRef[] = []
  for (const [list, defaultSource] of groups) {
    if (!list) continue
    for (const entry of list) {
      if (!entry.name || !entry.path) continue
      refs.push({
        id: entry.name,
        source: entry.source || defaultSource,
        path: entry.path,
        version: entry.version,
        domain: entry.domain,
        keywords: entry.keywords || [],
        when: entry.when,
        priority: entry.priority,
      })
    }
  }
  return refs
}

function readKBScopes(avatarDir: string, repoRoot: string): Array<{ path: string; read: boolean; write: boolean }> {
  const kbDir = path.join(avatarDir, 'knowledge')
  if (!fs.existsSync(kbDir)) return []
  const rel = path.relative(repoRoot, kbDir)
  return [{ path: rel || 'knowledge', read: true, write: false }]
}
