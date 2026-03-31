import fs from 'fs'
import path from 'path'
import { extractTitle, extractMetadata } from './utils/markdown-parser'

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
    const skill = this.getSkill(avatarId, skillId)
    if (!skill) {
      throw new Error(`技能不存在: ${skillId}`)
    }

    fs.writeFileSync(skill.filePath, content, 'utf-8')
  }

  toggleSkill(avatarId: string, skillId: string, enabled: boolean): void {
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

  // 获取技能配置
  private getSkillConfig(avatarId: string): SkillConfig {
    const configPath = path.join(this.avatarsPath, avatarId, 'skills', '.config.json')

    if (!fs.existsSync(configPath)) {
      return { disabledSkills: [] }
    }

    try {
      const content = fs.readFileSync(configPath, 'utf-8')
      return JSON.parse(content) as SkillConfig
    } catch (error) {
      console.error('读取技能配置失败:', error)
      return { disabledSkills: [] }
    }
  }

  // 保存技能配置
  private saveSkillConfig(avatarId: string, config: SkillConfig): void {
    const configPath = path.join(this.avatarsPath, avatarId, 'skills', '.config.json')
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8')
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
    const skills = this.getSkills(avatarId).filter(s => s.enabled)

    if (skills.length === 0) {
      return ''
    }

    const skillsContent = skills.map(s => s.content).join('\n\n---\n\n')
    return `\n\n# 技能定义\n\n${skillsContent}`
  }
}
