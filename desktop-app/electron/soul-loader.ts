import fs from 'fs'
import path from 'path'
import { SkillManager } from './skill-manager'

export interface AvatarConfig {
  id: string
  name: string
  systemPrompt: string
}

/**
 * SoulLoader: 负责将分身的各类配置文件组装为完整的 system prompt。
 * GAP2: 加载 memory/MEMORY.md 并注入 prompt
 * GAP3: 通过 SkillManager 只注入已启用的技能
 * GAP10: 加载 shared/knowledge/ 目录的共享知识
 */
export class SoulLoader {
  private avatarsPath: string
  private sharedPath: string
  private skillManager: SkillManager

  constructor(avatarsPath: string) {
    this.avatarsPath = avatarsPath
    this.sharedPath = path.join(avatarsPath, '..', 'shared')
    this.skillManager = new SkillManager(avatarsPath)
  }

  loadAvatar(avatarId: string): AvatarConfig {
    const avatarPath = path.join(this.avatarsPath, avatarId)

    // 读取 CLAUDE.md（入口文件）
    const claudeMd = this.readFileSafe(path.join(avatarPath, 'CLAUDE.md'))

    // 读取 soul.md（人格定义）
    const soulMd = this.readFileSafe(path.join(avatarPath, 'soul.md'))

    // GAP2: 读取 memory/MEMORY.md（长期记忆）
    const memoryContent = this.readFileSafe(path.join(avatarPath, 'memory', 'MEMORY.md'))

    // GAP10: 读取 shared/knowledge/ 目录（共享知识库）
    const sharedKnowledgeFiles = this.readDirectory(path.join(this.sharedPath, 'knowledge'))

    // GAP1（部分）: 只读取 knowledge/ 根目录文件作为索引级常驻知识
    // 子目录文件（如 products/、policies/）作为按需检索知识（由工具调用访问）
    const knowledgeRootFiles = this.readRootFilesOnly(path.join(avatarPath, 'knowledge'))

    // GAP3: 通过 SkillManager 获取已启用技能内容（而非读取全部 skills/ 文件）
    const skillsContent = this.skillManager.getEnabledSkillsContent(avatarId)

    // GAP11: 工具调用能力说明（帮助 DeepSeek 等模型更好地使用 function calling）
    const toolsNote = [
      '## 可用工具',
      '',
      '你可以调用以下工具来辅助回答，请在需要查询具体数据时主动调用：',
      '',
      '- **search_knowledge(query)**: 在知识库中检索相关内容片段，用于查找产品参数、政策文件、项目案例等',
      '- **read_knowledge_file(file_path)**: 读取知识库指定文件的完整内容',
      '- **list_knowledge_files()**: 列出知识库中所有可用文件',
      '- **calculate_roi(...)**: 计算储能项目的峰谷套利收益、IRR 和回收期',
      '- **lookup_policy(province, policy_type)**: 查询省份电价政策或补贴信息',
      '- **compare_products(products)**: 对比多款产品的技术参数',
      '',
      '**调用原则**：当用户询问具体项目数据、特定省份政策、产品规格对比、收益计算时，应主动调用工具获取准确信息，不要凭记忆回答。',
    ].join('\n')

    // 构建 system prompt
    const parts: string[] = [claudeMd, '\n\n---\n\n', soulMd]

    // 共享知识（所有分身通用）
    if (sharedKnowledgeFiles.length > 0) {
      parts.push('\n\n---\n\n# 共享知识库\n\n')
      sharedKnowledgeFiles.forEach(f => parts.push(f.content + '\n\n'))
    }

    // 索引级知识（knowledge/ 根目录文件，始终注入）
    if (knowledgeRootFiles.length > 0) {
      parts.push('\n\n---\n\n# 知识库\n\n')
      knowledgeRootFiles.forEach(f => parts.push(f.content + '\n\n'))
    }

    // GAP2: 长期记忆（始终注入，用于对话一致性）
    if (memoryContent.trim()) {
      parts.push('\n\n---\n\n# 长期记忆\n\n')
      parts.push(memoryContent)
    }

    // GAP11: 工具调用说明（始终注入，告知 LLM 其工具能力）
    parts.push('\n\n---\n\n')
    parts.push(toolsNote)

    // GAP3: 已启用的技能（通过 SkillManager 过滤）
    if (skillsContent) {
      parts.push('\n\n---\n\n')
      parts.push(skillsContent)
    }

    const systemPrompt = parts.join('')

    return {
      id: avatarId,
      name: this.extractAvatarName(claudeMd),
      systemPrompt,
    }
  }

  /** 安全读取文件，文件不存在时返回空字符串 */
  private readFileSafe(filePath: string): string {
    try {
      return fs.readFileSync(filePath, 'utf-8')
    } catch {
      return ''
    }
  }

  /** 只读取目录根层级的 .md 文件，不递归子目录 */
  private readRootFilesOnly(dirPath: string): Array<{ path: string; content: string }> {
    const files: Array<{ path: string; content: string }> = []
    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith('.md')) {
          const fullPath = path.join(dirPath, entry.name)
          files.push({ path: fullPath, content: this.readFileSafe(fullPath) })
        }
      }
    } catch {
      // 目录不存在则跳过
    }
    return files
  }

  /** 递归读取目录下所有 .md 文件 */
  private readDirectory(dirPath: string): Array<{ path: string; content: string }> {
    const files: Array<{ path: string; content: string }> = []
    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true })
      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name)
        if (entry.isDirectory()) {
          files.push(...this.readDirectory(fullPath))
        } else if (entry.isFile() && entry.name.endsWith('.md')) {
          files.push({ path: fullPath, content: this.readFileSafe(fullPath) })
        }
      }
    } catch {
      // 目录不存在则跳过
    }
    return files
  }

  private extractAvatarName(claudeMd: string): string {
    const match = claudeMd.match(/^#\s+(.+)$/m)
    return match ? match[1] : '未命名分身'
  }
}
