import fs from 'fs'
import path from 'path'
import { extractTitle, extractMetadata } from './utils/markdown-parser'
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
}

export interface SkillConfig {
  disabledSkills: string[]
}

export class SkillManager {
  private avatarsPath: string

  constructor(avatarsPath: string) {
    this.avatarsPath = avatarsPath
  }

  getSkills(avatarId: string): Skill[] {
    assertSafeSegment(avatarId, '分身ID')
    const skillsPath = path.join(this.avatarsPath, avatarId, 'skills')

    if (!fs.existsSync(skillsPath)) {
      return []
    }

    const files = fs.readdirSync(skillsPath).filter(f => f.endsWith('.md'))
    const skills: Skill[] = []
    const config = this.getSkillConfig(avatarId)

    for (const file of files) {
      const filePath = path.join(skillsPath, file)
      try {
        const content = fs.readFileSync(filePath, 'utf-8')
        const parsed = this.parseSkill(content, filePath, file)
        if (parsed) {
          parsed.enabled = !config.disabledSkills.includes(parsed.id)
          skills.push(parsed)
        }
      } catch (error) {
        console.error(`解析技能失败: ${filePath}`, error)
      }
    }

    return skills.sort((a, b) => a.name.localeCompare(b.name))
  }

  getSkill(avatarId: string, skillId: string): Skill | undefined {
    assertSafeSegment(avatarId, '分身ID')
    assertSafeSegment(skillId, '技能ID')
    const skillsPath = path.join(this.avatarsPath, avatarId, 'skills')
    const filePath = path.join(skillsPath, `${skillId}.md`)

    if (!fs.existsSync(filePath)) {
      return undefined
    }

    try {
      const content = fs.readFileSync(filePath, 'utf-8')
      const parsed = this.parseSkill(content, filePath, `${skillId}.md`)
      if (parsed) {
        const config = this.getSkillConfig(avatarId)
        parsed.enabled = !config.disabledSkills.includes(parsed.id)
        return parsed
      }
    } catch (error) {
      console.error(`解析技能失败: ${filePath}`, error)
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
      throw new Error(`保存技能配置失败: ${msg}`)
    }
  }

  // 解析技能文件
  private parseSkill(content: string, filePath: string, fileName: string): Skill | null {
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
    }
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
   */
  getSkillsSummary(avatarId: string): string {
    assertSafeSegment(avatarId, '分身ID')
    const skills = this.getSkills(avatarId).filter(s => s.enabled)

    if (skills.length === 0) {
      return ''
    }

    const lines = skills.map(s => `- **${s.name}** (id: \`${s.id}\`)：${s.description || '无描述'}`)
    return `\n\n# 可用技能（摘要）\n\n以下是可用的技能列表。需要使用某技能时，请调用 \`load_skill\` 工具加载完整定义。\n\n${lines.join('\n')}`
  }
}
