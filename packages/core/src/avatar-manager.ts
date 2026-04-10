import fs from 'fs'
import path from 'path'
import { TemplateLoader } from './template-loader'
import { assertSafeSegment, resolveUnderRoot } from './utils/path-security'

export interface Avatar {
  id: string
  name: string
  description: string
  createdAt: number
  /** 头像图片：data URL（自定义上传）或 "default:<key>"（预置头像） */
  avatarImage?: string
}

/**
 * AvatarManager: 管理分身的创建、删除和文件操作。
 * 创建分身时自动读取 templates/ 目录下的模板，确保生成的文件符合项目规范。
 *
 * @author zhi.qu
 * @date 2026-04-02
 */
export class AvatarManager {
  private avatarsPath: string
  private templateLoader: TemplateLoader

  /** 自定义头像文件与读回时的体积上限（与 readAvatarImageSafe 一致） */
  private static readonly AVATAR_IMAGE_MAX_BYTES = 512 * 1024

  /**
   * 从 data URL 中解析 base64 载荷（支持 image/png、image/jpeg、image/webp 及含 + 的子类型）。
   *
   * @throws Error 格式非法时
   */
  static parseImageDataUrlBase64(dataUrl: string): string {
    const trimmed = dataUrl.trim()
    const prefix = 'data:image/'
    const marker = ';base64,'
    if (!trimmed.startsWith(prefix) || !trimmed.includes(marker)) {
      throw new Error('无效的头像 data URL 格式')
    }
    const afterPrefix = trimmed.slice(prefix.length)
    const idx = afterPrefix.indexOf(marker)
    if (idx <= 0) throw new Error('无效的头像 data URL 格式')
    const subtype = afterPrefix.slice(0, idx).trim()
    if (!subtype) throw new Error('无效的头像 data URL 格式')
    const rawB64 = afterPrefix.slice(idx + marker.length).replace(/\s/g, '')
    if (!rawB64) throw new Error('无效的头像 data URL 格式')
    return rawB64
  }

  /**
   * @param avatarsPath 分身根目录绝对路径
   * @param templatesPath 模板目录绝对路径（由调用方传入，消除 Electron 耦合）
   */
  constructor(avatarsPath: string, templatesPath: string) {
    this.avatarsPath = avatarsPath
    this.templateLoader = new TemplateLoader(templatesPath)
  }


  /** 列出所有分身 */
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
        const avatarImage = this.readAvatarImageSafe(avatarPath)

        avatars.push({
          id: entry.name,
          name,
          description,
          createdAt: stat.birthtimeMs,
          avatarImage,
        })
      }
    } catch (error) {
      console.error('列出分身失败:', error)
    }

    return avatars.sort((a, b) => b.createdAt - a.createdAt)
  }

  /**
   * 保存分身头像图片。
   * dataUrl 可为 base64 data URL（自定义上传）或 "default:<key>"（预置头像）。
   * 预置头像直接写入标识文件；自定义头像解码后写入 avatar.png。
   *
   * @param avatarId 分身 ID
   * @param dataUrl  data URL 或 "default:<key>"
   */
  saveAvatarImage(avatarId: string, dataUrl: string): void {
    assertSafeSegment(avatarId, '分身 ID')
    const avatarPath = path.join(this.avatarsPath, avatarId)

    if (!fs.existsSync(avatarPath)) {
      throw new Error(`分身目录不存在，无法保存头像：${avatarId}`)
    }

    const trimmedUrl = dataUrl.trim()

    if (trimmedUrl.startsWith('default:')) {
      // 预置头像：写入标识文件
      fs.writeFileSync(path.join(avatarPath, 'avatar.txt'), trimmedUrl, 'utf-8')
      // 清除可能存在的自定义头像
      const pngPath = path.join(avatarPath, 'avatar.png')
      if (fs.existsSync(pngPath)) fs.unlinkSync(pngPath)
      return
    }

    // 自定义上传：base64 data URL → 写入 avatar.png（与 readAvatarImageSafe 一致按 PNG 提供）
    const b64Payload = AvatarManager.parseImageDataUrlBase64(trimmedUrl)
    const buffer = Buffer.from(b64Payload, 'base64')
    if (buffer.length > AvatarManager.AVATAR_IMAGE_MAX_BYTES) {
      throw new Error(`头像图片不能超过 ${Math.floor(AvatarManager.AVATAR_IMAGE_MAX_BYTES / 1024)}KB，请先压缩后再上传`)
    }

    fs.writeFileSync(path.join(avatarPath, 'avatar.png'), buffer)
    // 清除可能存在的预置标识文件
    const txtPath = path.join(avatarPath, 'avatar.txt')
    if (fs.existsSync(txtPath)) fs.unlinkSync(txtPath)
  }

  /**
   * 读取分身头像图片。
   *
   * @param avatarId 分身 ID
   * @returns data URL 或 "default:<key>"，无头像时返回 null
   */
  getAvatarImage(avatarId: string): string | null {
    assertSafeSegment(avatarId, '分身 ID')
    const avatarPath = path.join(this.avatarsPath, avatarId)
    return this.readAvatarImageSafe(avatarPath) ?? null
  }

  /**
   * 从分身目录读取头像（内部方法，不校验 avatarId）。
   * 优先读 avatar.png（自定义），其次读 avatar.txt（预置标识）。
   */
  private readAvatarImageSafe(avatarPath: string): string | undefined {
    try {
      const pngPath = path.join(avatarPath, 'avatar.png')
      if (fs.existsSync(pngPath)) {
        const stat = fs.statSync(pngPath)
        if (stat.size > AvatarManager.AVATAR_IMAGE_MAX_BYTES) return undefined // 超限跳过
        const buf = fs.readFileSync(pngPath)
        return `data:image/png;base64,${buf.toString('base64')}`
      }
      const txtPath = path.join(avatarPath, 'avatar.txt')
      if (fs.existsSync(txtPath)) {
        const content = fs.readFileSync(txtPath, 'utf-8').trim()
        if (content.startsWith('default:')) return content
      }
    } catch {
      // 读取失败静默处理，降级为无头像
    }
    return undefined
  }

  /**
   * 创建新分身。
   * skills 参数会写入 skills/ 目录下的对应 .md 文件。
   *
   * @author zhi.qu
   * @date 2026-04-09
   */
  createAvatar(id: string, soulContent: string, skills: string[], knowledgeFiles: Array<{ name: string; content: string }>): void {
    assertSafeSegment(id, '分身 ID')
    const avatarPath = path.join(this.avatarsPath, id)

    if (fs.existsSync(avatarPath)) {
      throw new Error(`分身 "${id}" 已存在，无法重复创建`)
    }

    // 创建目录结构
    fs.mkdirSync(path.join(avatarPath, 'knowledge'), { recursive: true })
    fs.mkdirSync(path.join(avatarPath, 'skills'), { recursive: true })
    fs.mkdirSync(path.join(avatarPath, 'memory'), { recursive: true })
    fs.mkdirSync(path.join(avatarPath, 'tests', 'cases'), { recursive: true })
    fs.mkdirSync(path.join(avatarPath, 'tests', 'reports'), { recursive: true })

    // 写入 soul.md
    fs.writeFileSync(path.join(avatarPath, 'soul.md'), soulContent, 'utf-8')

    // 写入技能文件
    for (const skillContent of skills) {
      const skillId = this.extractSkillId(skillContent)
      const skillPath = path.join(avatarPath, 'skills', `${skillId}.md`)
      fs.writeFileSync(skillPath, skillContent, 'utf-8')
    }

    // 写入知识文件
    for (const file of knowledgeFiles) {
      const knowledgeRoot = path.join(avatarPath, 'knowledge')
      const filePath = resolveUnderRoot(knowledgeRoot, file.name)
      const dir = path.dirname(filePath)
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
      }
      fs.writeFileSync(filePath, file.content, 'utf-8')
    }

    // 写入 knowledge/README.md（基于模板）
    const readmeTemplate = this.templateLoader.getKnowledgeReadmeTemplate()
    if (readmeTemplate) {
      const readmePath = path.join(avatarPath, 'knowledge', 'README.md')
      const readmeContent = readmeTemplate
        .replace(/\{\{AGENT_DISPLAY_NAME\}\}/g, this.extractNameFromSoul(soulContent) || id)
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/\{\{CATEGORY_\d+\}\}/g, '')
        .replace(/\{\{CATEGORY_\d+_DESC\}\}/g, '待补充')
      fs.writeFileSync(readmePath, readmeContent, 'utf-8')
    }

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

  /** 写入自定义技能文件 */
  writeSkillFile(avatarId: string, fileName: string, content: string): void {
    assertSafeSegment(avatarId, '分身 ID')
    assertSafeSegment(fileName, '技能文件名')
    const filePath = path.join(this.avatarsPath, avatarId, 'skills', fileName)
    fs.writeFileSync(filePath, content, 'utf-8')
  }

  /** 删除分身 */
  deleteAvatar(id: string): void {
    assertSafeSegment(id, '分身 ID')
    const avatarPath = path.join(this.avatarsPath, id)
    if (fs.existsSync(avatarPath)) {
      fs.rmSync(avatarPath, { recursive: true, force: true })
    }
  }

  /**
   * 生成 CLAUDE.md（分身操作规则入口文件）。
   * 基于 templates/agent-template.md 的核心约束章节生成，
   * 确保知识库约束、第一性原理、禁止推导猜测等关键规则完整保留。
   */
  private generateClaudeMd(id: string, soulContent: string, knowledgeFiles: Array<{ name: string; content: string }>): string {
    const name = this.extractNameFromSoul(soulContent)

    const knowledgeList = knowledgeFiles
      .map(f => `- \`${f.name}\``)
      .join('\n')

    const avatarPath = path.join(this.avatarsPath, id)
    const skillsPath = path.join(avatarPath, 'skills')
    let skillsList = ''
    if (fs.existsSync(skillsPath)) {
      const skillFiles = fs.readdirSync(skillsPath).filter(f => f.endsWith('.md'))
      skillsList = skillFiles.map(f => `- \`${f}\``).join('\n')
    }

    const coreConstraints = this.templateLoader.getAgentCoreConstraints()

    return `# ${name}

> 启动前请完整阅读本文件，这是你的身份和行为准则。

## 人格

请先阅读 \`soul.md\`，严格按照其中定义的人格、原则和说话方式与我交互。

你不是通用 AI 助手。你的每一次回答都应该体现 soul.md 中定义的身份和风格。

**人格执行要求**（每次回答必须检查）：
- 结论先行，不要从背景铺垫开始
- 有数据就给结论，不要只列框架
- 遇到不靠谱的需求要直接指出问题

${coreConstraints}

## 知识

你的专业知识在 \`knowledge/\` 目录下。回答问题时遵循以下规则：

- **优先引用** knowledge/ 中的数据和案例，而非依赖通用知识
- **数据分级使用**（重要！）：
  - **有 knowledge/ 数据** → 直接引用并标注来源
  - **无 knowledge/ 数据** → 诚实说"我的知识库中没有 [具体内容] 的数据"，然后提供框架和方法，让用户补充数据后再处理
  - **关键原则**：不用模型通用知识冒充专业知识。没有 knowledge/ 数据就是没有，给框架和方法比给不可追溯的数字更有价值。

知识文件：
${knowledgeList || '（暂无知识文件）'}

## 记忆

你的长期记忆在 \`memory/MEMORY.md\`。

**读取记忆的时机**（重要！）：
- **每次回答前**，先读 \`memory/MEMORY.md\` 的纠偏记录，确保不重复犯已被纠正过的错误

**写入记忆的时机**：
- 用户纠正你的数据或判断 → 立即记录正确信息
- 用户表达了偏好 → 记录偏好
- 讨论达成了结论或决策 → 记录结论
- 用户提供了新的案例或信息 → 记录并归类

**记忆格式**：按主题组织（偏好、纠偏记录、项目记录、决策记录），不按时间堆砌。

## 技能

你的技能在 \`skills/\` 目录下。当用户需要执行具体任务时：

1. 识别用户需求对应哪个技能
2. 阅读对应的技能文档
3. 按文档中的流程执行
4. 缺少必要输入时主动询问

可用技能：
${skillsList || '（暂无技能）'}
`
  }

  /** 从 markdown 内容提取第一个一级标题作为名称 */
  private extractFirstHeading(content: string, fallback: string = '未命名分身'): string {
    const match = content.match(/^#\s+(.+)$/m)
    return match ? match[1] : fallback
  }

  private extractName(claudeMd: string): string {
    return this.extractFirstHeading(claudeMd)
  }

  private extractDescription(claudeMd: string): string {
    const lines = claudeMd.split('\n').filter(l => l.trim())
    for (const line of lines) {
      if (!line.startsWith('#') && !line.startsWith('>') && line.trim().length > 5) {
        return line.trim().substring(0, 100)
      }
    }
    return ''
  }

  private extractNameFromSoul(soulContent: string): string {
    return this.extractFirstHeading(soulContent)
  }

  /** 从技能内容中提取技能 ID（基于一级标题，降级为时间戳） */
  private extractSkillId(skillContent: string): string {
    const heading = this.extractFirstHeading(skillContent, '')
    if (heading) {
      return heading.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-').replace(/^-|-$/g, '')
    }
    return `skill-${Date.now()}`
  }
}
