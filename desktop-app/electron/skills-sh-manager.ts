/**
 * skills-sh-manager.ts — skills.sh 技能市场管理器
 *
 * 职责：
 * 1. 搜索：调 skills.sh 免密公开端点 `GET /api/search` 检索开源技能
 * 2. 安装：git clone 来源仓库 → 按 frontmatter name 定位目标技能目录 →
 *    把整个技能目录复制到 `avatars/<id>/skills/<skillId>/`（source: local，分身专属）
 *
 * 设计取舍：
 * - 搜索走免密 `/api/search`；带鉴权的 `/api/v1` 需向 Vercel 申请 sk_live_ key，本期不用。
 * - 安装走 git clone（与 CommunitySkillManager 同路数），而非 HTTP 拉单个 SKILL.md：
 *   skills.sh 技能常为多文件（SKILL.md + rules/ + metadata.json 等），且 search 返回的
 *   skillId 带前缀（如 vercel-react-best-practices）≠ 仓库目录名（react-best-practices），
 *   只有 SKILL.md 的 frontmatter `name` 才能稳定定位。整目录复制最稳，也保住附带文件。
 * - 目标目录名 == skillId == 目标 SKILL.md 的 frontmatter `name`，符合 anthropics/skills
 *   「目录名 == frontmatter name」约定，避免 SkillManager.loadSkillFromDir 的不匹配告警。
 *
 * 安全边界（IPC 不可信输入）：source / skillId 会进 git clone URL 与磁盘路径，
 * 必须先过 parseSource（owner/repo 严格白名单 + 挡 `-` 选项注入 / `..` 穿越）与
 * sanitizeSkillId（收敛到 [A-Za-z0-9_-] + assertSafeSegment），再 resolveUnderRoot 兜底。
 */

import path from 'path'
import fs from 'fs'
import os from 'os'
import { spawn } from 'child_process'
import {
  assertSafeSegment,
  resolveUnderRoot,
  extractFrontmatter,
  fetchWithTimeout,
  type SkillsShSearchResult,
} from '@soul/core'
import { Logger } from './logger'

/**
 * skills.sh 搜索 API base。允许用 env 覆盖（内网代理/测试，与官方 CLI 的 SEARCH_API_BASE 对齐），
 * 但**仅接受 https://**——否则忽略覆盖、回落默认，避免被改成 http://内网地址 做 SSRF。
 */
function resolveSearchApiBase(): string {
  const override = process.env.SKILLS_SH_BASE
  if (override && /^https:\/\//.test(override)) return override.replace(/\/+$/, '')
  return 'https://skills.sh'
}
const SEARCH_API_BASE = resolveSearchApiBase()
const SEARCH_TIMEOUT_MS = 15_000
const CLONE_TIMEOUT_MS = 60_000
/** 单技能目录文件数上限——超过视为误命中仓库根（monorepo），拒绝复制以防把整库拖进分身 */
const MAX_SKILL_FILES = 300
/** SKILL.md 递归搜索的最大深度与命中上限（防御异常巨仓） */
const WALK_MAX_DEPTH = 6
const WALK_MAX_HITS = 2000

/** 安装结果（返回给渲染端做提示 + 触发本地技能列表刷新） */
export interface SkillsShInstallResult {
  /** 安装后的本地技能 id（== 目录名 == frontmatter name） */
  skillId: string
  /** 展示名 */
  name: string
  /** 复制进来的文件数 */
  fileCount: number
}

export class SkillsShManager {
  private avatarsPath: string
  private logger: Logger

  constructor(avatarsPath: string, logger: Logger) {
    this.avatarsPath = avatarsPath
    this.logger = logger
  }

  // ─── 搜索 ──────────────────────────────────────────────────────

  /** 调 skills.sh 公开搜索端点，返回结构化结果（防御性解析，字段缺失即跳过该项） */
  async search(query: string, limit = 20): Promise<SkillsShSearchResult[]> {
    const q = (query || '').trim()
    if (!q) return []
    const n = Math.max(1, Math.min(50, Math.floor(limit) || 20))
    const url = `${SEARCH_API_BASE}/api/search?q=${encodeURIComponent(q)}&limit=${n}`

    const res = await fetchWithTimeout(url, {
      timeoutMs: SEARCH_TIMEOUT_MS,
      headers: { accept: 'application/json' },
    })
    const data = (await res.json()) as { skills?: unknown }
    const raw = Array.isArray(data?.skills) ? data.skills : []

    const out: SkillsShSearchResult[] = []
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue
      const o = item as Record<string, unknown>
      const skillId = typeof o.skillId === 'string' ? o.skillId : ''
      const source = typeof o.source === 'string' ? o.source : ''
      if (!skillId || !source) continue
      out.push({
        id: typeof o.id === 'string' ? o.id : `${source}/${skillId}`,
        skillId,
        name: typeof o.name === 'string' ? o.name : skillId,
        source,
        installs: typeof o.installs === 'number' ? o.installs : 0,
        description: typeof o.description === 'string' ? o.description : undefined,
      })
    }
    this.logger.activity('skills-sh:search', `q="${q}" results=${out.length}`)
    return out
  }

  // ─── 安装 ──────────────────────────────────────────────────────

  /**
   * 安装一个 skills.sh 技能到当前分身：克隆来源仓库 → 定位技能目录 → 整目录复制到
   * `avatars/<avatarId>/skills/<skillId>/`。已存在则拒绝（提示删除后重装）。
   */
  async install(
    avatarId: string,
    result: { source: string; skillId: string },
  ): Promise<SkillsShInstallResult> {
    assertSafeSegment(avatarId, '分身ID')
    const { owner, repo } = this.parseSource(result.source)
    const skillId = this.sanitizeSkillId(result.skillId)

    await this.ensureGitAvailable()

    const skillsDir = path.join(this.avatarsPath, avatarId, 'skills')
    // resolveUnderRoot 兜底：即便 sanitize 失效也挡住越界
    const destDir = resolveUnderRoot(skillsDir, skillId)
    if (fs.existsSync(destDir)) {
      throw new Error(`技能 "${skillId}" 已安装在该分身；如需更新请先在「本地技能」删除后重装`)
    }

    const repoUrl = `https://github.com/${owner}/${repo}.git`
    // clone 到系统临时目录（不落在 skillsDir 内，避免 getSkills 扫到半成品）
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-skillssh-'))
    const cloneDir = path.join(tmpRoot, 'repo')
    try {
      await this.gitClone(repoUrl, cloneDir)

      const found = this.locateSkillDir(cloneDir, result.skillId)
      if (!found) {
        throw new Error(`未能在仓库 ${result.source} 中定位技能 "${result.skillId}"（未找到匹配的 SKILL.md）`)
      }

      const fileCount = this.countFiles(found.dir)
      if (fileCount > MAX_SKILL_FILES) {
        throw new Error(`技能目录文件数 ${fileCount} 超过上限 ${MAX_SKILL_FILES}（疑似命中仓库根/monorepo），已中止安装`)
      }

      if (!fs.existsSync(skillsDir)) fs.mkdirSync(skillsDir, { recursive: true })
      this.copyDir(found.dir, destDir)

      this.logger.activity(
        'skills-sh:install',
        `avatar=${avatarId} skill=${skillId} source=${result.source} files=${fileCount}`,
      )
      return { skillId, name: found.name || skillId, fileCount }
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true })
    }
  }

  // ─── 安装内部方法 ──────────────────────────────────────────────

  /**
   * 在克隆出的仓库里定位目标技能所在目录：
   *   1) frontmatter `name` 精确等于 skillId（最可靠——search 的 skillId 即 frontmatter name）
   *   2) 仓库仅有一个 SKILL.md → 直接用它（单技能仓库兜底）
   *   3) 目录名匹配（skillId 去掉前缀段后 == 目录名，处理 `vercel-` 这类命名空间前缀）
   */
  private locateSkillDir(repoRoot: string, skillId: string): { dir: string; name: string } | null {
    const files = this.findSkillMdFiles(repoRoot)
    if (files.length === 0) return null

    let single: { dir: string; name: string } | null = null
    for (const f of files) {
      const name = this.readFrontmatterName(f)
      const dir = path.dirname(f)
      if (name === skillId) return { dir, name }
      if (files.length === 1) single = { dir, name: name || skillId }
    }
    if (single) return single

    for (const f of files) {
      const base = path.basename(path.dirname(f))
      if (base === skillId || skillId.endsWith(`-${base}`)) {
        return { dir: path.dirname(f), name: this.readFrontmatterName(f) || skillId }
      }
    }
    return null
  }

  private readFrontmatterName(skillMdPath: string): string {
    try {
      return (extractFrontmatter(fs.readFileSync(skillMdPath, 'utf-8')).name || '').trim()
    } catch {
      return ''
    }
  }

  /** 递归找所有 SKILL.md（跳过 .git / node_modules，限深度与命中数） */
  private findSkillMdFiles(root: string): string[] {
    const out: string[] = []
    const SKIP = new Set(['.git', 'node_modules', '.github'])
    const walk = (dir: string, depth: number): void => {
      if (depth > WALK_MAX_DEPTH || out.length >= WALK_MAX_HITS) return
      let entries: fs.Dirent[]
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        if (e.isDirectory()) {
          if (SKIP.has(e.name)) continue
          walk(path.join(dir, e.name), depth + 1)
        } else if (e.isFile() && e.name === 'SKILL.md') {
          out.push(path.join(dir, e.name))
        }
      }
    }
    walk(root, 0)
    return out
  }

  /**
   * 递归复制技能目录到分身。手写递归而非 fs.cpSync：
   * - 跳过 .git / node_modules（无关内容）。
   * - **跳过 symlink**——fs.cpSync 默认 dereference=false 会把 symlink 原样装入分身目录，
   *   恶意技能仓库可借 `evil -> /etc/passwd` 让渲染端顺着读宿主任意文件。这里用 Dirent
   *   直接判断并整体跳过 symlink，绝不复制/解引用。其它特殊类型（FIFO/socket 等）一并忽略。
   */
  private copyDir(src: string, dest: string): void {
    fs.mkdirSync(dest, { recursive: true })
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue
      const s = path.join(src, entry.name)
      const d = path.join(dest, entry.name)
      if (entry.isSymbolicLink()) {
        this.logger.warn('skills-sh:install', `跳过不安全的 symlink: ${s}`)
        continue
      }
      if (entry.isDirectory()) this.copyDir(s, d)
      else if (entry.isFile()) fs.copyFileSync(s, d)
    }
  }

  private countFiles(dir: string): number {
    let n = 0
    const walk = (d: string): void => {
      let entries: fs.Dirent[]
      try {
        entries = fs.readdirSync(d, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        if (e.name === '.git' || e.name === 'node_modules') continue
        if (e.isDirectory()) walk(path.join(d, e.name))
        else n++
      }
    }
    walk(dir)
    return n
  }

  /** 解析并校验 owner/repo（白名单字符 + 挡 `-` 开头的选项注入与 `..` 穿越） */
  private parseSource(source: string): { owner: string; repo: string } {
    if (typeof source !== 'string' || !source.trim()) {
      throw new Error('技能来源 source 不能为空')
    }
    const m = source.trim().match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/)
    if (!m) {
      throw new Error(`非法的技能来源（应为 owner/repo）: ${source}`)
    }
    const owner = m[1]
    const repo = m[2]
    // 锚定白名单正则已排除控制字符；这里再挡 `-` 开头（git 选项注入）与 `.` 开头（`.`/`..`/`.hidden`）
    for (const seg of [owner, repo]) {
      if (seg.startsWith('-') || seg.startsWith('.') || seg.includes('..')) {
        throw new Error(`非法的来源片段: ${seg}`)
      }
    }
    return { owner, repo }
  }

  /** 收敛 skillId 为安全的文件系统片段（[A-Za-z0-9_-]），再过 assertSafeSegment 兜底 */
  private sanitizeSkillId(raw: string): string {
    if (typeof raw !== 'string' || !raw.trim()) {
      throw new Error('skillId 不能为空')
    }
    const id = raw
      .trim()
      .replace(/[^A-Za-z0-9_-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
    if (!id) {
      throw new Error(`无法从 "${raw}" 生成合法的技能 ID`)
    }
    assertSafeSegment(id, '技能ID')
    return id
  }

  // ─── Git 操作 ──────────────────────────────────────────────────

  private async ensureGitAvailable(): Promise<void> {
    try {
      await this.runCommand('git', ['--version'])
    } catch {
      throw new Error('未检测到 Git。安装 skills.sh 技能需要 Git，请安装后重试。')
    }
  }

  /** 浅克隆默认分支（不带 --branch，避免再校验 ref） */
  private async gitClone(repoUrl: string, destDir: string): Promise<void> {
    await this.runCommand('git', ['clone', '--depth', '1', repoUrl, destDir])
  }

  private runCommand(cmd: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = spawn(cmd, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: CLONE_TIMEOUT_MS,
      })
      let stdout = ''
      let stderr = ''
      proc.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
      proc.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
      proc.on('close', (code) => {
        if (code === 0) resolve(stdout)
        else reject(new Error(`${cmd} ${args.join(' ')} 退出码 ${code}: ${stderr.slice(0, 500)}`))
      })
      proc.on('error', (err) => reject(err))
    })
  }
}
