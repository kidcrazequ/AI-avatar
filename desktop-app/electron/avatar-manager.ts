import fs from 'fs'
import path from 'path'

export interface Avatar {
  id: string
  name: string
  description: string
  createdAt: number
}

export class AvatarManager {
  private avatarsPath: string

  constructor(avatarsPath: string) {
    this.avatarsPath = avatarsPath
  }

  // 列出所有分身
  listAvatars(): Avatar[] {
    const avatars: Avatar[] = []

    try {
      const entries = fs.readdirSync(this.avatarsPath, { withFileTypes: true })

      for (const entry of entries) {
        if (!entry.isDirectory()) continue

        const avatarPath = path.join(this.avatarsPath, entry.name)
        const claudeMdPath = path.join(avatarPath, 'CLAUDE.md')

        if (!fs.existsSync(claudeMdPath)) continue

        const claudeMd = fs.readFileSync(claudeMdPath, 'utf-8')
        const name = this.extractName(claudeMd)
        const description = this.extractDescription(claudeMd)
        const stat = fs.statSync(avatarPath)

        avatars.push({
          id: entry.name,
          name,
          description,
          createdAt: stat.birthtimeMs,
        })
      }
    } catch (error) {
      console.error('列出分身失败:', error)
    }

    return avatars.sort((a, b) => b.createdAt - a.createdAt)
  }

  // 创建新分身
  createAvatar(id: string, soulContent: string, skills: string[], knowledgeFiles: Array<{ name: string; content: string }>): void {
    const avatarPath = path.join(this.avatarsPath, id)

    // 创建目录结构
    fs.mkdirSync(path.join(avatarPath, 'knowledge'), { recursive: true })
    fs.mkdirSync(path.join(avatarPath, 'skills'), { recursive: true })
    fs.mkdirSync(path.join(avatarPath, 'memory'), { recursive: true })
    fs.mkdirSync(path.join(avatarPath, 'tests', 'cases'), { recursive: true })
    fs.mkdirSync(path.join(avatarPath, 'tests', 'reports'), { recursive: true })

    // 写入 soul.md
    fs.writeFileSync(path.join(avatarPath, 'soul.md'), soulContent, 'utf-8')

    // 写入知识文件
    for (const file of knowledgeFiles) {
      const filePath = path.join(avatarPath, 'knowledge', file.name)
      const dir = path.dirname(filePath)
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
      }
      fs.writeFileSync(filePath, file.content, 'utf-8')
    }

    // 复制技能模板
  for (const skillName of skills) {
      // 从已有分身复制技能模板
      const existingSkillPath = path.join(this.avatarsPath, 'ci-storage-expert', 'skills', `${skillName}.md`)
      const targetPath = path.join(avatarPath, 'skills', `${skillName}.md`)

      if (fs.existsSync(existingSkillPath)) {
        fs.copyFileSync(existingSkillPath, targetPath)
      }
    }

    // 写入自定义技能
    // (由前端传入的自定义技能内容会在 knowledgeFiles 之后单独处理)

    // 写入 MEMORY.md
    const memoryContent = `# Memory Index

本文件用于记录长期记忆。

## 偏好记录

## 纠偏记录

## 项目记录

## 决策记录
`
    fs.writeFileSync(path.join(avatarPath, 'memory', 'MEMORY.md'), memoryContent, 'utf-8')

    // 生成 CLAUDE.md
    const claudeMd = this.generateClaudeMd(id, soulContent, knowledgeFiles)
    fs.writeFileSync(path.join(avatarPath, 'CLAUDE.md'), claudeMd, 'utf-8')
  }

  // 写入自定义技能文件
  writeSkillFile(avatarId: string, fileName: string, content: string): void {
    const filePath = path.join(this.avatarsPath, avatarId, 'skills', fileName)
    fs.writeFileSync(filePath, content, 'utf-8')
  }

  // 删除分身
  deleteAvatar(id: string): void {
    const avatarPath = path.join(this.avatarsPath, id)
    if (fs.existsSync(avatarPath)) {
      fs.rmSync(avatarPath, { recursive: true, force: true })
    }
  }

  // 生成 CLAUDE.md
  private generateClaudeMd(id: string, soulContent: string, knowledgeFiles: Array<{ name: string; content: string }>): string {
    const name = this.extractNameFromSoul(soulContent)

    // 列出知识文件
    const knowledgeList = knowledgeFiles
      .map(f => `- \`${f.name}\``)
      .join('\n')

    // 列出技能文件
    const avatarPath = path.join(this.avatarsPath, id)
    const skillsPath = path.join(avatarPath, 'skills')
    let skillsList = ''
    if (fs.existsSync(skillsPath)) {
      const skillFiles = fs.readdirSync(skillsPath).filter(f => f.endsWith('.md'))
      skillsList = skillFiles.map(f => `- \`${f}\``).join('\n')
    }

    return `# ${name}

> 启动前请完整阅读本文件，这是你的身份和行为准则。

## 人格

请先阅读 \`soul.md\`，严格按照其中定义的人格、原则和说话方式与我交互。

## 知识

你的专业知识在 \`knowledge/\` 目录下。回答问题时遵循以下规则：

- **优先引用** knowledge/ 中的数据和案例，而非依赖通用知识
- **数据分级使用**：
  - **有 knowledge/ 数据** → 直接引用并标注来源
  - **无 knowledge/ 数据** → 诚实说明，提供框架和方法

知识文件：
${knowledgeList || '（暂无知识文件）'}

## 记忆

你的长期记忆在 \`memory/MEMORY.md\`。

**读取记忆的时机**：每次回答前先读取记忆，确保不重复犯错

**写入记忆的时机**：
- 用户纠正你的数据或判断 → 立即记录
- 用户表达了偏好 → 记录偏好
- 讨论达成了结论 → 记录结论

## 技能

你的技能在 \`skills/\` 目录下。

可用技能：
${skillsList || '（暂无技能）'}
`
  }

  private extractName(claudeMd: string): string {
    const match = claudeMd.match(/^#\s+(.+)$/m)
    return match ? match[1] : '未命名分身'
  }

  private extractDescription(claudeMd: string): string {
    const lines = claudeMd.split('\n').filter(l => l.trim())
    // 取第一个非标题、非空行作为描述
    for (const line of lines) {
      if (!line.startsWith('#') && !line.startsWith('>') && line.trim().length > 5) {
        return line.trim().substring(0, 100)
      }
    }
    return ''
  }

  private extractNameFromSoul(soulContent: string): string {
    const match = soulContent.match(/^#\s+(.+)$/m)
    return match ? match[1] : '未命名分身'
  }
}
