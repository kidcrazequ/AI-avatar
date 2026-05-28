import fs from 'fs'
import path from 'path'
import { extractTitle, extractMetadata, extractFrontmatter } from './utils/markdown-parser'
import { assertSafeSegment } from './utils/path-security'

export interface Skill {
  id: string
  name: string
  level: string
  version: string
  description: string
  enabled: boolean
  filePath: string
  content: string
  /** 系统自带技能（来自 templates/skills/），不允许通过 UI 删除 */
  isBuiltin: boolean
  /** 技能来源：local=分身本地物理文件，shared=shared/skills/，community=shared/skills/community/<pack>/ */
  source?: 'local' | 'shared' | 'community'
}

/**
 * 公共技能可用条目（用于 SkillsPanel「公共技能」tab）。
 * 与本地 Skill 不同：这是 `shared/skills/<name>.md` 的物理文件 + 分身 `skill-index.yaml`
 * 引用状态的合并视图——分身未引用时 enabled=false，UI 上提供一键启用。
 */
export interface AvailableSharedSkill {
  /** 技能 name（== 文件名去 .md，frontmatter 的 name 字段优先） */
  name: string
  /** 文件名（含扩展名），便于 UI 路径展示 */
  filename: string
  /** frontmatter description（截断渲染） */
  description: string
  /** frontmatter domain（可选） */
  domain: string
  /** 当前分身的 skill-index.yaml 是否已引用此技能 */
  enabled: boolean
}

export interface SkillConfig {
  disabledSkills: string[]
}

export class SkillManager {
  private avatarsPath: string
  /** templates 目录的绝对路径（用于判定内置技能） */
  private templatesPath: string
  /** 内置技能 ID 集合的缓存（首次读取时初始化，避免每个 skill 都去 stat） */
  private builtinSkillIdsCache: Set<string> | null = null

  constructor(avatarsPath: string) {
    this.avatarsPath = avatarsPath
    // soul 仓库根 = avatarsPath 的父目录，templates/ 在根下
    this.templatesPath = path.join(avatarsPath, '..', 'templates')
  }

  /**
   * 获取内置技能 ID 集合（首次调用时扫描 `templates/skills/*.md`，结果缓存）。
   * 用于 isBuiltin 判定 + deleteSkill 拦截。
   */
  private getBuiltinSkillIds(): Set<string> {
    if (this.builtinSkillIdsCache) return this.builtinSkillIdsCache
    const skillsTemplateDir = path.join(this.templatesPath, 'skills')
    const set = new Set<string>()
    if (fs.existsSync(skillsTemplateDir) && fs.statSync(skillsTemplateDir).isDirectory()) {
      for (const entry of fs.readdirSync(skillsTemplateDir, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith('.md')) {
          set.add(entry.name.replace(/\.md$/, ''))
        }
      }
    }
    this.builtinSkillIdsCache = set
    return set
  }

  /** 判定某个 skillId 是否为系统内置（来自 templates/skills/） */
  isBuiltinSkill(skillId: string): boolean {
    return this.getBuiltinSkillIds().has(skillId)
  }

  getSkills(avatarId: string): Skill[] {
    assertSafeSegment(avatarId, '分身ID')
    const skillsPath = path.join(this.avatarsPath, avatarId, 'skills')

    if (!fs.existsSync(skillsPath)) {
      return []
    }

    const skills: Skill[] = []
    const config = this.getSkillConfig(avatarId)

    // 两种格式并存（v18 起兼容 anthropics/skills SKILL.md 标准）：
    //   1) 单文件 <skill-id>.md（Soul 原生格式，frontmatter 极简：name + description）
    //   2) 目录形式 <skill-id>/SKILL.md（anthropic spec）
    //      允许同时含 scripts/ / references/ / assets/ 子目录（不进 prompt，按需让 LLM 读）
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(skillsPath, { withFileTypes: true })
    } catch {
      return []
    }

    for (const entry of entries) {
      const entryPath = path.join(skillsPath, entry.name)
      try {
        if (entry.isFile() && entry.name.endsWith('.md')) {
          const content = fs.readFileSync(entryPath, 'utf-8')
          const parsed = this.parseSkill(content, entryPath, entry.name)
          if (parsed) {
            parsed.enabled = !config.disabledSkills.includes(parsed.id)
            skills.push(parsed)
          }
        } else if (entry.isDirectory()) {
          const parsed = this.loadSkillFromDir(entryPath, entry.name)
          if (parsed) {
            parsed.enabled = !config.disabledSkills.includes(parsed.id)
            skills.push(parsed)
          }
        }
      } catch (error) {
        console.error(`解析技能失败: ${entryPath}`, error)
      }
    }

    return skills.sort((a, b) => a.name.localeCompare(b.name))
  }

  getSkill(avatarId: string, skillId: string): Skill | undefined {
    assertSafeSegment(avatarId, '分身ID')
    assertSafeSegment(skillId, '技能ID')
    const skillsPath = path.join(this.avatarsPath, avatarId, 'skills')
    const sharedRoot = path.join(this.avatarsPath, '..', 'shared', 'skills')

    // 候选路径（按 local > shared > community 顺序）：
    //   - 单文件 .md（Soul 原生格式）
    //   - 目录形式 <skillId>/SKILL.md（anthropics/skills 标准）
    type Candidate = {
      kind: 'file' | 'dir'
      path: string
      source: 'local' | 'shared' | 'community'
    }
    const candidates: Candidate[] = [
      { kind: 'file', path: path.join(skillsPath, `${skillId}.md`), source: 'local' },
      { kind: 'dir', path: path.join(skillsPath, skillId), source: 'local' },
      { kind: 'file', path: path.join(sharedRoot, `${skillId}.md`), source: 'shared' },
      { kind: 'dir', path: path.join(sharedRoot, skillId), source: 'shared' },
    ]
    // community：扫一遍 shared/skills/community/<pack>/skills/<id>.md
    try {
      const communityRoot = path.join(sharedRoot, 'community')
      if (fs.existsSync(communityRoot)) {
        for (const pack of fs.readdirSync(communityRoot, { withFileTypes: true })) {
          if (!pack.isDirectory()) continue
          candidates.push({ kind: 'file', path: path.join(communityRoot, pack.name, 'skills', `${skillId}.md`), source: 'community' })
          candidates.push({ kind: 'dir', path: path.join(communityRoot, pack.name, 'skills', skillId), source: 'community' })
        }
      }
    } catch { /* community 扫描失败不阻塞主路径 */ }

    for (const cand of candidates) {
      try {
        if (cand.kind === 'file') {
          if (!fs.existsSync(cand.path)) continue
          const content = fs.readFileSync(cand.path, 'utf-8')
          const fileName = path.basename(cand.path)
          const parsed = this.parseSkill(content, cand.path, fileName, cand.source)
          if (parsed) {
            const config = this.getSkillConfig(avatarId)
            parsed.enabled = !config.disabledSkills.includes(parsed.id)
            return parsed
          }
        } else {
          if (!fs.existsSync(cand.path) || !fs.statSync(cand.path).isDirectory()) continue
          const parsed = this.loadSkillFromDir(cand.path, skillId, cand.source)
          if (parsed) {
            const config = this.getSkillConfig(avatarId)
            parsed.enabled = !config.disabledSkills.includes(parsed.id)
            return parsed
          }
        }
      } catch (error) {
        console.error(`解析技能失败: ${cand.path}`, error)
      }
    }

    return undefined
  }

  updateSkill(avatarId: string, skillId: string, content: string): void {
    assertSafeSegment(avatarId, '分身ID')
    assertSafeSegment(skillId, '技能ID')
    const skill = this.getSkill(avatarId, skillId)
    if (!skill) {
      throw new Error(`技能不存在: ${skillId}`)
    }
    // 非 local skill 不允许从分身侧编辑（避免单分身改动影响所有分身 / 污染上游社区包）。
    // 想改 shared/community 技能：要么直接编辑 shared/skills/<id>.md，要么在分身本地创建同名覆写。
    if (skill.source && skill.source !== 'local') {
      throw new Error(`${skill.source === 'shared' ? '公共' : '社区'}技能不可从分身侧编辑：${skillId}（请创建本地覆写或直接编辑源文件）`)
    }

    fs.writeFileSync(skill.filePath, content, 'utf-8')
  }

  /**
   * 新建技能：在 `avatars/{avatarId}/skills/` 下创建 `{skillId}.md`。
   *
   * @param avatarId 分身 ID
   * @param skillId  技能 ID（== 文件名主体，必须全英文 / 数字 / 连字符，避免路径穿越和文件系统问题）
   * @param content  完整的 markdown 内容（应包含 frontmatter + 正文）
   * @returns 创建后的 Skill 对象
   * @throws 如果 skillId 非法、文件已存在、或写入失败
   */
  createSkill(avatarId: string, skillId: string, content: string): Skill {
    assertSafeSegment(avatarId, '分身ID')
    assertSafeSegment(skillId, '技能ID')
    // 额外限制 skillId 只能是英文 / 数字 / 连字符 / 下划线，避免和 path-security 重复但更严格
    if (!/^[A-Za-z0-9_-]+$/.test(skillId)) {
      throw new Error(`技能 ID 必须只包含英文字母、数字、连字符或下划线: ${skillId}`)
    }
    const skillsDir = path.join(this.avatarsPath, avatarId, 'skills')
    if (!fs.existsSync(skillsDir)) {
      fs.mkdirSync(skillsDir, { recursive: true })
    }
    const filePath = path.join(skillsDir, `${skillId}.md`)
    if (fs.existsSync(filePath)) {
      throw new Error(`技能已存在，请换一个 ID 或改用"编辑"功能: ${skillId}`)
    }

    fs.writeFileSync(filePath, content, 'utf-8')

    const created = this.getSkill(avatarId, skillId)
    if (!created) {
      // 写入后读取失败 — 极少见，但要报错
      throw new Error(`创建成功但读取失败: ${skillId}`)
    }
    return created
  }

  /**
   * 删除技能：物理删除 `{skillId}.md` 并从 `.config.json` 的 disabledSkills 列表中移除（清理）。
   *
   * @param avatarId 分身 ID
   * @param skillId  技能 ID
   * @throws 如果技能不存在或删除失败
   */
  deleteSkill(avatarId: string, skillId: string): void {
    assertSafeSegment(avatarId, '分身ID')
    assertSafeSegment(skillId, '技能ID')
    const skill = this.getSkill(avatarId, skillId)
    if (!skill) {
      throw new Error(`技能不存在: ${skillId}`)
    }
    // 非 local skill 不允许删（删了会影响其他分身 / 污染上游）。
    if (skill.source && skill.source !== 'local') {
      throw new Error(`${skill.source === 'shared' ? '公共' : '社区'}技能不可从分身侧删除：${skillId}（如需该分身停用，请在 skill-index.yaml 移除引用）`)
    }
    // 内置技能不允许删除（来自 templates/skills/，删了下次创建分身又会回来，且会破坏其它分身共享假设）
    if (this.isBuiltinSkill(skillId)) {
      throw new Error(`系统内置技能不可删除: ${skillId}（如需停用请用"禁用"开关）`)
    }

    fs.unlinkSync(skill.filePath)

    // 清理 disabledSkills 里的残留条目（不影响主流程，失败不抛）
    try {
      const config = this.getSkillConfig(avatarId)
      if (config.disabledSkills.includes(skillId)) {
        config.disabledSkills = config.disabledSkills.filter(id => id !== skillId)
        this.saveSkillConfig(avatarId, config)
      }
    } catch (err) {
      console.warn('[SkillManager] 清理 disabledSkills 失败（不影响主流程）:', err instanceof Error ? err.message : String(err))
    }
  }

  /**
   * 列出 `shared/skills/*.md` 下所有公共技能，并标注当前分身是否已在 skill-index.yaml 中引用。
   * 不下钻 community/ 子目录（社区技能走独立的 CommunitySkillTab）。
   *
   * @param avatarId 分身 ID
   * @returns 按 name 排序的列表
   */
  getAvailableSharedSkills(avatarId: string): AvailableSharedSkill[] {
    assertSafeSegment(avatarId, '分身ID')
    const sharedSkillsDir = path.join(this.avatarsPath, '..', 'shared', 'skills')
    if (!fs.existsSync(sharedSkillsDir)) return []

    const enabledNames = this.readSharedSkillNamesFromIndex(avatarId)
    const result: AvailableSharedSkill[] = []
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(sharedSkillsDir, { withFileTypes: true })
    } catch (err) {
      console.warn('[SkillManager] 读 shared/skills/ 失败:', err instanceof Error ? err.message : String(err))
      return []
    }
    for (const entry of entries) {
      const entryPath = path.join(sharedSkillsDir, entry.name)
      try {
        if (entry.isFile() && entry.name.endsWith('.md')) {
          // 单文件形式（Soul 原生）：shared/skills/<name>.md
          const content = fs.readFileSync(entryPath, 'utf-8')
          const fm = extractFrontmatter(content)
          const name = (fm.name && fm.name.trim()) || entry.name.replace(/\.md$/, '')
          result.push({
            name,
            filename: entry.name,
            description: fm.description || '',
            domain: fm.domain || '',
            enabled: enabledNames.has(name),
          })
        } else if (entry.isDirectory() && entry.name !== 'community') {
          // v18：anthropics/skills SKILL.md 标准的目录形式
          //   shared/skills/<name>/SKILL.md（+ scripts/ / references/ / assets/）
          // community/ 子目录仍保留给 soul-sync.sh 拉取的外部包（独立加载链路）
          const skillMdPath = path.join(entryPath, 'SKILL.md')
          if (!fs.existsSync(skillMdPath)) continue
          const content = fs.readFileSync(skillMdPath, 'utf-8')
          const fm = extractFrontmatter(content)
          const fmName = (fm.name && fm.name.trim()) || ''
          if (fmName && fmName !== entry.name) {
            console.warn(`[SkillManager] shared/skills/${entry.name}/SKILL.md frontmatter name="${fmName}" 不匹配目录名`)
          }
          result.push({
            name: entry.name, // SKILL.md spec：以目录名为准
            filename: `${entry.name}/SKILL.md`,
            description: fm.description || '',
            domain: fm.domain || '',
            enabled: enabledNames.has(entry.name),
          })
        }
      } catch (err) {
        console.warn(`[SkillManager] 解析 shared skill 失败 ${entry.name}:`, err instanceof Error ? err.message : String(err))
      }
    }
    return result.sort((a, b) => a.name.localeCompare(b.name))
  }

  /**
   * 在分身 skill-index.yaml 中启用 / 禁用某个公共技能。
   *
   * 启用：追加一段 entry block 到 `shared_skills:` 段下；段不存在时新建段在文件末尾。
   * 禁用：按 `name:` 匹配定位到 entry block 起点，删到下一个 entry 或下一个顶层段或文件结尾。
   *
   * 保留文件其余部分（含注释、缩进、本地技能段）。
   */
  toggleSharedSkill(avatarId: string, skillName: string, enable: boolean): void {
    assertSafeSegment(avatarId, '分身ID')
    if (!/^[A-Za-z0-9_-]+$/.test(skillName)) {
      throw new Error(`公共技能名非法（只允许英文/数字/连字符/下划线）: ${skillName}`)
    }

    const sharedSkillPath = path.join(this.avatarsPath, '..', 'shared', 'skills', `${skillName}.md`)
    if (enable && !fs.existsSync(sharedSkillPath)) {
      throw new Error(`公共技能不存在: shared/skills/${skillName}.md`)
    }

    const indexDir = path.join(this.avatarsPath, avatarId, 'skills')
    const indexPath = path.join(indexDir, 'skill-index.yaml')
    if (!fs.existsSync(indexDir)) {
      fs.mkdirSync(indexDir, { recursive: true })
    }
    let raw = fs.existsSync(indexPath)
      ? fs.readFileSync(indexPath, 'utf-8')
      : 'version: "1.0"\n'

    if (enable) {
      // 已存在 → 幂等返回（不重复追加）
      if (this.readSharedSkillNamesFromIndex(avatarId).has(skillName)) return

      // 派生 entry 元数据：domain / 简短 description 从 shared skill frontmatter 拿
      let domain = ''
      let description = ''
      try {
        const fm = extractFrontmatter(fs.readFileSync(sharedSkillPath, 'utf-8'))
        domain = (fm.domain || '').trim()
        description = (fm.description || '').trim()
      } catch {/* 文件读不到时退回默认 */}
      const domainLine = domain || description.slice(0, 30).replace(/\s+/g, ' ')

      const entryBlock = [
        `  - name: ${skillName}`,
        `    path: shared/skills/${skillName}.md`,
        `    source: shared`,
        `    domain: ${domainLine}`,
        `    keywords: []  # 自动启用，如需精确路由请手动补充关键词`,
        `    priority: 5`,
        '',
      ].join('\n')

      if (/^shared_skills:\s*$/m.test(raw)) {
        // 段已存在：在段标题行紧跟其后插入新 entry
        raw = raw.replace(/^(shared_skills:\s*\n)/m, `$1${entryBlock}`)
      } else {
        // 段不存在：在文件末尾新建一段
        if (!raw.endsWith('\n')) raw += '\n'
        raw +=
          '\n# ═══════════════════════════════════════\n' +
          '# 公共技能（来自 shared/skills/，由桌面端 SkillsPanel 维护）\n' +
          '# ═══════════════════════════════════════\n' +
          'shared_skills:\n' +
          entryBlock
      }
    } else {
      // 删除：按行扫描，匹配到 `- name: skillName` 后跳过整段
      raw = this.removeSharedSkillEntry(raw, skillName)
    }

    fs.writeFileSync(indexPath, raw, 'utf-8')
  }

  /** 从 skill-index.yaml 解析出所有 source: shared 的 entry name（仅扫文本，不依赖 yaml 库） */
  private readSharedSkillNamesFromIndex(avatarId: string): Set<string> {
    const indexPath = path.join(this.avatarsPath, avatarId, 'skills', 'skill-index.yaml')
    const names = new Set<string>()
    if (!fs.existsSync(indexPath)) return names
    let raw: string
    try {
      raw = fs.readFileSync(indexPath, 'utf-8')
    } catch {
      return names
    }
    // 按 `- name:` 行切成 block，每个 block 看是否含 source: shared
    const lines = raw.split('\n')
    let currentName: string | null = null
    let currentBlock: string[] = []
    const flush = () => {
      if (!currentName) return
      const blockText = currentBlock.join('\n')
      if (/^\s+source:\s*shared\s*$/m.test(blockText)) {
        names.add(currentName)
      }
    }
    for (const line of lines) {
      const m = line.match(/^\s*-\s*name:\s*(.+?)\s*$/)
      if (m) {
        flush()
        currentName = m[1].replace(/['"]/g, '').trim()
        currentBlock = [line]
      } else {
        currentBlock.push(line)
      }
    }
    flush()
    return names
  }

  /** 按 name 删除一段 entry block（保留前后内容 + 注释 + 段标题） */
  private removeSharedSkillEntry(raw: string, skillName: string): string {
    const lines = raw.split('\n')
    const out: string[] = []
    let skipping = false
    for (const line of lines) {
      if (skipping) {
        // 终止 skip：下一个 entry（- name:）或下一个顶层段（xxx:）或空行后跟非缩进内容
        if (/^\s*-\s*name:/.test(line) || /^[A-Za-z_]\w*:/.test(line)) {
          skipping = false
          out.push(line)
        }
        // 否则继续 skip
        continue
      }
      const m = line.match(/^\s*-\s*name:\s*(.+?)\s*$/)
      if (m && m[1].replace(/['"]/g, '').trim() === skillName) {
        skipping = true
        continue
      }
      out.push(line)
    }
    return out.join('\n')
  }

  toggleSkill(avatarId: string, skillId: string, enabled: boolean): void {
    assertSafeSegment(avatarId, '分身ID')
    assertSafeSegment(skillId, '技能ID')
    const config = this.getSkillConfig(avatarId)

    if (enabled) {
      // 启用：从禁用列表中移除
      config.disabledSkills = config.disabledSkills.filter(id => id !== skillId)
    } else {
      // 禁用：添加到禁用列表
      if (!config.disabledSkills.includes(skillId)) {
        config.disabledSkills.push(skillId)
      }
    }

    this.saveSkillConfig(avatarId, config)
  }

  private getSkillConfig(avatarId: string): SkillConfig {
    assertSafeSegment(avatarId, '分身ID')
    const configPath = path.join(this.avatarsPath, avatarId, 'skills', '.config.json')

    if (!fs.existsSync(configPath)) {
      return { disabledSkills: [] }
    }

    try {
      const content = fs.readFileSync(configPath, 'utf-8')
      const parsed = JSON.parse(content)
      if (!parsed || !Array.isArray(parsed.disabledSkills)) {
        console.warn('[SkillManager] 技能配置格式异常，使用默认配置')
        return { disabledSkills: [] }
      }
      const safeDisabled = parsed.disabledSkills.filter((id: unknown) => typeof id === 'string')
      return { disabledSkills: safeDisabled }
    } catch (error) {
      console.error('[SkillManager] 读取技能配置失败:', error)
      return { disabledSkills: [] }
    }
  }

  private saveSkillConfig(avatarId: string, config: SkillConfig): void {
    assertSafeSegment(avatarId, '分身ID')
    const configPath = path.join(this.avatarsPath, avatarId, 'skills', '.config.json')
    try {
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8')
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      console.error('[SkillManager] 保存技能配置失败:', msg)
      throw new Error(`保存技能配置失败: ${msg}`, { cause: error })
    }
  }

  // 解析技能文件
  private parseSkill(content: string, filePath: string, fileName: string, source: 'local' | 'shared' | 'community' = 'local'): Skill | null {
    const name = extractTitle(content) || fileName.replace('.md', '')
    const level = extractMetadata(content, '级别') || '未知'
    const version = extractMetadata(content, '版本') || 'v1.0'

    // 提取技能说明
    const descMatch = content.match(/##\s+技能说明\s+([\s\S]*?)(?=\n##|$)/)
    const description = descMatch ? descMatch[1].trim().substring(0, 200) : ''

    const id = fileName.replace('.md', '')

    return {
      id,
      name,
      level,
      version,
      description,
      enabled: true,
      filePath,
      content,
      isBuiltin: this.isBuiltinSkill(id),
      source,
    }
  }

  /**
   * v18：加载 anthropics/skills SKILL.md 标准格式的目录形式技能。
   *
   * 约定（来自 https://agentskills.io/specification）：
   *   <skill-id>/
   *     ├── SKILL.md          # 必需：frontmatter (name + description) + markdown body
   *     ├── scripts/          # 可选：可执行脚本
   *     ├── references/       # 可选：技术参考文档
   *     └── assets/           # 可选：模板 / 资源
   *
   * - SKILL.md frontmatter 的 `name` 字段**必须**匹配目录名（spec 强制）；
   *   不一致时记录警告但仍按目录名加载（容错）
   * - id 用目录名（dirName），保持与单文件 .md 的命名一致性
   * - scripts/ / references/ / assets/ 不进 prompt；只暴露 SKILL.md body 给 LLM
   *   后续 LLM 调用 `read_knowledge_file` / `exec_shell` 等工具可按需访问
   */
  private loadSkillFromDir(skillDir: string, dirName: string, source: 'local' | 'shared' | 'community' = 'local'): Skill | null {
    const skillMdPath = path.join(skillDir, 'SKILL.md')
    if (!fs.existsSync(skillMdPath)) return null
    let content: string
    try {
      content = fs.readFileSync(skillMdPath, 'utf-8')
    } catch (err) {
      console.error(`[SkillManager] 读 SKILL.md 失败 ${skillMdPath}:`, err instanceof Error ? err.message : String(err))
      return null
    }
    const fm = extractFrontmatter(content)
    const frontmatterName = (fm.name || '').trim()
    if (frontmatterName && frontmatterName !== dirName) {
      console.warn(
        `[SkillManager] SKILL.md frontmatter name="${frontmatterName}" 不匹配目录名 "${dirName}"，按 spec 应严格一致；仍按目录名 "${dirName}" 加载`,
      )
    }
    // 复用 parseSkill：把 dirName 当 fileName 传入，让 id = dirName
    return this.parseSkill(content, skillMdPath, `${dirName}.md`, source)
  }

  // 获取启用的技能内容（用于生成 systemPrompt）
  getEnabledSkillsContent(avatarId: string): string {
    assertSafeSegment(avatarId, '分身ID')
    const skills = this.getSkills(avatarId).filter(s => s.enabled)

    if (skills.length === 0) {
      return ''
    }

    const skillsContent = skills.map(s => s.content).join('\n\n---\n\n')
    return `\n\n# 技能定义\n\n${skillsContent}`
  }

  /**
   * 获取启用技能的摘要列表（用于渐进式披露）。
   * 只返回技能名称和说明，不包含完整实现内容，减少 token 占用。
   * AI 在需要使用某技能时，通过 load_skill 工具加载完整内容。
   *
   * 合并三个来源（同 id 时本地覆写优先）：
   *   1. avatars/<id>/skills/ 下的本地实体 .md / SKILL.md（getSkills）
   *   2. skill-index.yaml 里 source: shared 的引用
   *   3. skill-index.yaml 里 source: community 的引用
   *
   * 之前只扫 ①，导致 orchestrator 这类"只引用 shared、本地无文件"的分身
   * UI 显示已启用但 prompt 摘要里看不见，模型实际不知道这些技能 ID。
   */
  getSkillsSummary(avatarId: string): string {
    assertSafeSegment(avatarId, '分身ID')
    const byId = new Map<string, Skill>()
    for (const s of this.getSkills(avatarId).filter(s => s.enabled)) {
      byId.set(s.id, s)
    }
    for (const ref of this.readEnabledNonLocalSkillRefsFromIndex(avatarId)) {
      if (byId.has(ref)) continue // 本地覆写优先
      try {
        const resolved = this.getSkill(avatarId, ref)
        if (resolved && resolved.enabled) byId.set(ref, resolved)
      } catch { /* 单个 ref 解析失败不阻塞其它 */ }
    }
    if (byId.size === 0) return ''
    const lines = [...byId.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(s => `- **${s.name}** (id: \`${s.id}\`)：${s.description || '无描述'}`)
    return `\n\n# 可用技能（摘要）\n\n以下是可用的技能列表。需要使用某技能时，请调用 \`load_skill\` 工具加载完整定义。\n\n${lines.join('\n')}`
  }

  /**
   * 读 skill-index.yaml 里所有 source: shared / source: community 的 name 列表。
   * 与 readSharedSkillNamesFromIndex 区别：放宽到 community；getSkillsSummary 用。
   * 仍是文本扫描（不引 yaml 库）。
   */
  private readEnabledNonLocalSkillRefsFromIndex(avatarId: string): string[] {
    const indexPath = path.join(this.avatarsPath, avatarId, 'skills', 'skill-index.yaml')
    if (!fs.existsSync(indexPath)) return []
    let raw: string
    try {
      raw = fs.readFileSync(indexPath, 'utf-8')
    } catch {
      return []
    }
    const names: string[] = []
    const lines = raw.split('\n')
    let currentName: string | null = null
    let currentBlock: string[] = []
    const flush = () => {
      if (!currentName) return
      const blockText = currentBlock.join('\n')
      if (/^\s+source:\s*(shared|community)\s*$/m.test(blockText)) {
        names.push(currentName)
      }
    }
    for (const line of lines) {
      const m = line.match(/^\s*-\s*name:\s*(.+?)\s*$/)
      if (m) {
        flush()
        currentName = m[1].replace(/['"]/g, '').trim()
        currentBlock = [line]
      } else {
        currentBlock.push(line)
      }
    }
    flush()
    return names
  }
}
