/**
 * community-skill-manager.ts — 社区技能管理器
 *
 * 职责：
 * 1. 读写 shared/skills/sources.yaml
 * 2. Git clone / checkout 社区技能仓库
 * 3. 解析 skill-manifest.yaml
 * 4. 校验技能文件 frontmatter
 * 5. 管理 sources.lock
 * 6. 更新分身 skill-index.yaml（添加/移除 community 技能引用）
 *
 * @author zhi.qu
 * @date 2026-05-08
 */

import path from 'path'
import fs from 'fs'
import { spawn } from 'child_process'
import { assertSafeSegment, localDateString } from '@soul/core'
import type { CommunitySkillSource, InstalledCommunityPack, CommunitySkillInfo, CommunitySkillSyncProgress } from '@soul/core'
import { Logger } from './logger'

// ─── Types ──────────────────────────────────────────────────────

interface LockEntry {
  name: string
  repo: string
  ref: string
  commit: string
  syncedAt: string
  skillCount: number
  skills: CommunitySkillInfo[]
}

type ProgressCallback = (progress: CommunitySkillSyncProgress) => void

// ─── CommunitySkillManager ──────────────────────────────────────

export class CommunitySkillManager {
  private soulRoot: string
  private logger: Logger

  constructor(avatarsPath: string, logger: Logger) {
    this.soulRoot = path.resolve(avatarsPath, '..')
    this.logger = logger
  }

  private get sourcesYamlPath(): string {
    return path.join(this.soulRoot, 'shared', 'skills', 'sources.yaml')
  }

  private get communityDir(): string {
    return path.join(this.soulRoot, 'shared', 'skills', 'community')
  }

  private get lockFilePath(): string {
    return path.join(this.soulRoot, 'shared', 'skills', 'sources.lock')
  }

  // ─── 源管理 ────────────────────────────────────────────────────

  /** 读取 sources.yaml 中所有技能源 */
  listSources(): CommunitySkillSource[] {
    if (!fs.existsSync(this.sourcesYamlPath)) return []
    const raw = fs.readFileSync(this.sourcesYamlPath, 'utf-8')
    return this.parseSourcesYaml(raw)
  }

  /** 添加新技能源到 sources.yaml */
  addSource(source: CommunitySkillSource): void {
    assertSafeSegment(source.name)
    const sources = this.listSources()
    if (sources.some(s => s.name === source.name)) {
      throw new Error(`技能源 "${source.name}" 已存在`)
    }
    sources.push(source)
    this.writeSourcesYaml(sources)
    this.logger.activity('community:add-source', `name=${source.name} repo=${source.repo} ref=${source.ref}`)
  }

  /** 从 sources.yaml 移除技能源 */
  removeSource(name: string): void {
    assertSafeSegment(name)
    const sources = this.listSources()
    const filtered = sources.filter(s => s.name !== name)
    if (filtered.length === sources.length) {
      throw new Error(`技能源 "${name}" 不存在`)
    }
    this.writeSourcesYaml(filtered)

    // 同时删除本地安装目录
    const installDir = path.join(this.communityDir, name)
    if (fs.existsSync(installDir)) {
      fs.rmSync(installDir, { recursive: true, force: true })
    }

    // 从 lock 文件中移除
    this.removeLockEntry(name)
    this.logger.activity('community:remove-source', `name=${name}`)
  }

  // ─── 同步 ──────────────────────────────────────────────────────

  /** 执行全量同步，类似 soul-sync.sh */
  async sync(onProgress?: ProgressCallback): Promise<InstalledCommunityPack[]> {
    const sources = this.listSources()
    if (sources.length === 0) return []

    await this.ensureGitAvailable()

    if (!fs.existsSync(this.communityDir)) {
      fs.mkdirSync(this.communityDir, { recursive: true })
    }

    const results: InstalledCommunityPack[] = []

    for (let i = 0; i < sources.length; i++) {
      const source = sources[i]
      try {
        onProgress?.({
          sourceName: source.name,
          phase: 'cloning',
          total: sources.length,
          current: i + 1,
        })

        const pack = await this.syncSingleSource(source, onProgress, i, sources.length)
        results.push(pack)

        onProgress?.({
          sourceName: source.name,
          phase: 'done',
          total: sources.length,
          current: i + 1,
        })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        this.logger.error('community:sync', new Error(`同步 ${source.name} 失败: ${msg}`))
        onProgress?.({
          sourceName: source.name,
          phase: 'error',
          detail: msg,
          total: sources.length,
          current: i + 1,
        })
      }
    }

    return results
  }

  /** 列出已安装的社区技能包（从 lock 文件读取） */
  listInstalled(): InstalledCommunityPack[] {
    if (!fs.existsSync(this.lockFilePath)) return []
    try {
      const raw = fs.readFileSync(this.lockFilePath, 'utf-8')
      const entries: LockEntry[] = JSON.parse(raw)
      return entries.map(e => ({
        name: e.name,
        repo: e.repo,
        ref: e.ref,
        commit: e.commit,
        syncedAt: e.syncedAt,
        skillCount: e.skillCount,
        skills: e.skills,
      }))
    } catch {
      return []
    }
  }

  /** 为分身启用某个社区技能（写入 skill-index.yaml） */
  enableForAvatar(avatarId: string, skillName: string, packName: string): void {
    assertSafeSegment(avatarId)
    assertSafeSegment(skillName)
    assertSafeSegment(packName)

    const indexPath = path.join(this.soulRoot, 'avatars', avatarId, 'skills', 'skill-index.yaml')
    if (!fs.existsSync(indexPath)) {
      const dir = path.dirname(indexPath)
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(indexPath, 'version: "1.0"\nskills:\n', 'utf-8')
    }

    const raw = fs.readFileSync(indexPath, 'utf-8')
    if (raw.includes(`name: ${skillName}`)) return

    const skillFile = this.findSkillFile(packName, skillName)
    if (!skillFile) throw new Error(`社区技能 ${skillName} 在 ${packName} 中不存在`)

    const relativePath = `../../../shared/skills/community/${packName}/skills/${skillFile}`
    const entry = [
      `  - name: ${skillName}`,
      `    path: ${relativePath}`,
      `    domain: community`,
      `    keywords: [${skillName}]`,
      `    when: "社区技能 ${skillName}"`,
      `    priority: 10`,
      `    source: community`,
      `    origin: ${this.getRepoUrl(packName)}`,
    ].join('\n')

    const updated = raw.trimEnd() + '\n' + entry + '\n'
    fs.writeFileSync(indexPath, updated, 'utf-8')
    this.logger.activity('community:enable', `avatar=${avatarId} skill=${skillName} pack=${packName}`)
  }

  /** 为分身禁用某个社区技能（从 skill-index.yaml 移除） */
  disableForAvatar(avatarId: string, skillName: string): void {
    assertSafeSegment(avatarId)
    assertSafeSegment(skillName)

    const indexPath = path.join(this.soulRoot, 'avatars', avatarId, 'skills', 'skill-index.yaml')
    if (!fs.existsSync(indexPath)) return

    const raw = fs.readFileSync(indexPath, 'utf-8')
    const lines = raw.split('\n')
    const result: string[] = []
    let skipping = false

    for (const line of lines) {
      if (line.trim().startsWith('- name:') && line.includes(skillName)) {
        skipping = true
        continue
      }
      if (skipping) {
        if (line.trim().startsWith('- name:') || (line.trim() === '' && !line.startsWith(' '))) {
          skipping = false
        } else if (line.match(/^\s{4}\S/)) {
          continue
        } else {
          skipping = false
        }
      }
      if (!skipping) result.push(line)
    }

    fs.writeFileSync(indexPath, result.join('\n'), 'utf-8')
    this.logger.activity('community:disable', `avatar=${avatarId} skill=${skillName}`)
  }

  // ─── 内部方法 ──────────────────────────────────────────────────

  private async syncSingleSource(
    source: CommunitySkillSource,
    onProgress: ProgressCallback | undefined,
    index: number,
    total: number,
  ): Promise<InstalledCommunityPack> {
    const tempDir = path.join(this.communityDir, `.tmp-${source.name}-${Date.now()}`)
    const destDir = path.join(this.communityDir, source.name)

    try {
      // Clone
      await this.gitClone(source.repo, source.ref, tempDir)

      onProgress?.({
        sourceName: source.name,
        phase: 'checking-out',
        total,
        current: index + 1,
      })

      // 获取 commit hash
      const commit = await this.gitRevParse(tempDir)

      onProgress?.({
        sourceName: source.name,
        phase: 'copying',
        total,
        current: index + 1,
      })

      // 复制技能文件
      const skillsSourceDir = source.file
        ? path.dirname(path.join(tempDir, source.file))
        : path.join(tempDir, source.path || 'skills')

      if (fs.existsSync(destDir)) {
        fs.rmSync(destDir, { recursive: true, force: true })
      }
      fs.mkdirSync(path.join(destDir, 'skills'), { recursive: true })

      const skills = this.copySkillFiles(skillsSourceDir, destDir, source)

      // 更新 lock
      const pack: InstalledCommunityPack = {
        name: source.name,
        repo: source.repo,
        ref: source.ref,
        commit,
        syncedAt: new Date().toISOString(),
        skillCount: skills.length,
        skills,
      }
      this.updateLockEntry(pack)

      return pack
    } finally {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true })
      }
    }
  }

  private copySkillFiles(sourceDir: string, destDir: string, source: CommunitySkillSource): CommunitySkillInfo[] {
    const skills: CommunitySkillInfo[] = []

    if (!fs.existsSync(sourceDir)) {
      this.logger.warn('community:copy', `技能目录不存在: ${sourceDir}`)
      return skills
    }

    if (source.file) {
      const fullPath = path.join(path.dirname(sourceDir), source.file)
      if (fs.existsSync(fullPath)) {
        const destFile = path.join(destDir, 'skills', path.basename(source.file))
        fs.copyFileSync(fullPath, destFile)
        skills.push(this.extractSkillInfo(destFile))
      }
      return skills
    }

    const files = fs.readdirSync(sourceDir).filter(f => f.endsWith('.md'))
    for (const file of files) {
      const skillName = file.replace(/\.md$/, '')
      if (source.skills && source.skills.length > 0 && !source.skills.includes(skillName)) {
        continue
      }
      const srcFile = path.join(sourceDir, file)
      const destFile = path.join(destDir, 'skills', file)
      fs.copyFileSync(srcFile, destFile)
      skills.push(this.extractSkillInfo(destFile))
    }

    return skills
  }

  private extractSkillInfo(filePath: string): CommunitySkillInfo {
    const content = fs.readFileSync(filePath, 'utf-8')
    const name = path.basename(filePath, '.md')
    let description = ''
    let domain = ''

    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/)
    if (frontmatterMatch) {
      const fm = frontmatterMatch[1]
      const descMatch = fm.match(/description:\s*(.+)/)
      if (descMatch) description = descMatch[1].trim()
      const domainMatch = fm.match(/domain:\s*(.+)/)
      if (domainMatch) domain = domainMatch[1].trim()
    }

    if (!description) {
      const firstLine = content.split('\n').find(l => l.trim() && !l.startsWith('#') && !l.startsWith('---'))
      description = firstLine?.trim().slice(0, 80) || name
    }

    return { name, file: path.basename(filePath), description, domain }
  }

  private findSkillFile(packName: string, skillName: string): string | null {
    const skillsDir = path.join(this.communityDir, packName, 'skills')
    if (!fs.existsSync(skillsDir)) return null
    const candidates = [`${skillName}.md`, `${skillName}/SKILL.md`]
    for (const c of candidates) {
      if (fs.existsSync(path.join(skillsDir, c))) return c
    }
    return null
  }

  private getRepoUrl(packName: string): string {
    const sources = this.listSources()
    return sources.find(s => s.name === packName)?.repo || ''
  }

  // ─── Lock 文件管理 ─────────────────────────────────────────────

  private readLock(): LockEntry[] {
    if (!fs.existsSync(this.lockFilePath)) return []
    try {
      return JSON.parse(fs.readFileSync(this.lockFilePath, 'utf-8'))
    } catch {
      return []
    }
  }

  private writeLock(entries: LockEntry[]): void {
    fs.writeFileSync(this.lockFilePath, JSON.stringify(entries, null, 2), 'utf-8')
  }

  private updateLockEntry(pack: InstalledCommunityPack): void {
    const entries = this.readLock()
    const idx = entries.findIndex(e => e.name === pack.name)
    const entry: LockEntry = {
      name: pack.name,
      repo: pack.repo,
      ref: pack.ref,
      commit: pack.commit,
      syncedAt: pack.syncedAt,
      skillCount: pack.skillCount,
      skills: pack.skills,
    }
    if (idx >= 0) entries[idx] = entry
    else entries.push(entry)
    this.writeLock(entries)
  }

  private removeLockEntry(name: string): void {
    const entries = this.readLock().filter(e => e.name !== name)
    this.writeLock(entries)
  }

  // ─── YAML 解析/序列化 ─────────────────────────────────────────

  private parseSourcesYaml(raw: string): CommunitySkillSource[] {
    const sources: CommunitySkillSource[] = []
    const lines = raw.split('\n')
    let current: Partial<CommunitySkillSource> | null = null
    let inSkills = false

    for (const line of lines) {
      const trimmed = line.replace(/#.*$/, '').trimEnd()
      if (!trimmed.trim()) continue

      if (trimmed.trim().startsWith('- name:')) {
        if (current?.name) sources.push(current as CommunitySkillSource)
        current = { name: trimmed.trim().replace('- name:', '').trim(), skills: [] }
        inSkills = false
        continue
      }

      if (!current) continue
      const kv = trimmed.trim()

      if (kv.startsWith('repo:')) { current.repo = kv.replace('repo:', '').trim(); inSkills = false }
      else if (kv.startsWith('ref:')) { current.ref = kv.replace('ref:', '').trim(); inSkills = false }
      else if (kv.startsWith('path:')) { current.path = kv.replace('path:', '').trim(); inSkills = false }
      else if (kv.startsWith('file:')) { current.file = kv.replace('file:', '').trim(); inSkills = false }
      else if (kv.startsWith('skills:')) {
        const inline = kv.replace('skills:', '').trim()
        if (inline.startsWith('[')) {
          const items = inline.replace(/\[|\]/g, '').split(',').map(s => s.trim()).filter(Boolean)
          current.skills = items
          inSkills = false
        } else {
          inSkills = true
        }
      } else if (inSkills && kv.startsWith('-')) {
        current.skills!.push(kv.replace(/^-\s*/, '').trim())
      }
    }

    if (current?.name) sources.push(current as CommunitySkillSource)
    return sources
  }

  private writeSourcesYaml(sources: CommunitySkillSource[]): void {
    const lines: string[] = [
      '# 外部技能来源清单',
      `# 更新时间：${localDateString()}`,
      '',
      'version: "1.0"',
      '',
      'sources:',
    ]

    for (const s of sources) {
      lines.push(`  - name: ${s.name}`)
      lines.push(`    repo: ${s.repo}`)
      lines.push(`    ref: ${s.ref}`)
      if (s.path) lines.push(`    path: ${s.path}`)
      if (s.file) lines.push(`    file: ${s.file}`)
      if (s.skills && s.skills.length > 0) {
        lines.push(`    skills:`)
        for (const sk of s.skills) lines.push(`      - ${sk}`)
      } else {
        lines.push(`    skills: []`)
      }
    }

    if (sources.length === 0) lines.push('  []')

    fs.writeFileSync(this.sourcesYamlPath, lines.join('\n') + '\n', 'utf-8')
  }

  // ─── Git 操作 ──────────────────────────────────────────────────

  private async ensureGitAvailable(): Promise<void> {
    try {
      await this.runCommand('git', ['--version'])
    } catch {
      throw new Error('未检测到 Git。请安装 Git 后再使用社区技能同步功能。')
    }
  }

  private async gitClone(repo: string, ref: string, destDir: string): Promise<void> {
    await this.runCommand('git', ['clone', '--depth', '1', '--branch', ref, repo, destDir])
  }

  private async gitRevParse(repoDir: string): Promise<string> {
    const output = await this.runCommand('git', ['rev-parse', 'HEAD'], repoDir)
    return output.trim()
  }

  private runCommand(cmd: string, args: string[], cwd?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = spawn(cmd, args, {
        cwd: cwd || this.soulRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 60_000,
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
