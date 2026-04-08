import fs from 'fs'
import path from 'path'

/**
 * TemplateLoader: 从 templates/ 目录读取模板文件。
 * 与运行环境无关——调用方负责传入正确的 templatesPath（消除 Electron 耦合）。
 *
 * @author zhi.qu
 * @date 2026-04-02
 */
export class TemplateLoader {
  private templatesPath: string

  /**
   * @param templatesPath 模板目录的绝对路径
   *   - 开发环境（Electron）：path.join(__dirname, '../../templates')
   *   - 生产环境（Electron）：path.join(process.resourcesPath, 'templates')
   *   - 单元测试：path.join(__dirname, '../../../templates')
   */
  constructor(templatesPath: string) {
    this.templatesPath = templatesPath
  }

  /**
   * 读取指定模板文件的完整内容。
   * @param templateName 模板文件名（含 .md 后缀），如 'soul-template.md'
   * @returns 模板文件内容；文件不存在时返回空字符串
   */
  getTemplate(templateName: string): string {
    const filePath = path.join(this.templatesPath, templateName)
    try {
      return fs.readFileSync(filePath, 'utf-8')
    } catch {
      console.error(`[TemplateLoader] 模板文件不存在: ${filePath}`)
      return ''
    }
  }

  /** 列出 templates/ 目录下所有 .md 文件名 */
  listTemplates(): string[] {
    try {
      return fs.readdirSync(this.templatesPath)
        .filter(f => f.endsWith('.md'))
        .sort()
    } catch {
      console.error(`[TemplateLoader] 无法读取模板目录: ${this.templatesPath}`)
      return []
    }
  }

  /**
   * 构建生成 soul.md 时的 system prompt。
   * 将 soul-template.md 的结构约束和 soul-guide.md 的核心原则注入，
   * 确保 DeepSeek 等弱模型也能按模板生成。
   */
  buildSoulCreationPrompt(avatarName: string): string {
    const soulTemplate = this.getTemplate('soul-template.md')
    const soulGuide = this.getTemplate('soul-guide.md')

    // 从 soul-guide.md 中提取撰写原则部分
    let writingPrinciples = ''
    if (soulGuide) {
      const principlesMatch = soulGuide.match(/## 撰写原则\n([\s\S]*?)(?=\n## 逐章撰写指南)/)
      if (principlesMatch) {
        writingPrinciples = principlesMatch[1].trim()
      }
    }

    return `你是 AI 分身创建助手。你的任务是根据用户的描述，生成一份高质量的分身灵魂文档（soul.md）。

## 强制约束（不可违反）

1. **严格遵循下方模板结构**，包含全部 8 个章节，不可增删章节
2. **好的回答示例必须至少 3 组**，分别覆盖：
   - 场景 1：知识库有数据时的正常回答（展示核心风格）
   - 场景 2：知识库没数据时的诚实应答（诚实说没有，给框架，引导补充）
   - 场景 3：不靠谱需求时的反驳（用数据和逻辑反驳）
3. **坏的回答示例必须至少 2 组**，分别展示：
   - 反面教材 1：通用 AI 风格（车轱辘话、多维度分析但无结论）
   - 反面教材 2：编造数据或模糊应答
4. **必须包含"数据溯源红线"**（数据必须可追溯的表格）
5. **口头禅必须具体真实**，不能是"注重质量"之类的空话
6. **承诺第 1 条必须是"数据可溯源"**
7. **用第一人称写**，有温度、有个性，不要像说明文档
8. **直接输出 Markdown 正文**，不要加代码块标记

${writingPrinciples ? `## 撰写原则（来自 soul-guide.md，必须遵循）\n\n${writingPrinciples}\n\n` : ''}## 分身名称

${avatarName}

## 模板结构（必须严格遵循）

${soulTemplate}
`
  }

  /**
   * 构建生成技能文件时的 system prompt。
   * 将 skill-template.md 的结构约束注入。
   */
  buildSkillCreationPrompt(): string {
    const skillTemplate = this.getTemplate('skill-template.md')

    return `你是 AI 分身技能创建助手。你的任务是根据用户的描述，生成一份标准的技能定义文件。

## 强制约束（不可违反）

1. **严格遵循下方模板的可复制区结构**
2. **必须包含 YAML frontmatter**（name 和 description 字段）
3. **description 用第三人称**，同时写清 WHAT（做什么）和 WHEN（何时用）
4. **必须包含输入参数表**（必须和可选参数）
5. **必须包含触发条件和触发关键词**
6. **必须包含至少一个用户输入/分身输出示例**
7. **执行流程要具体可操作**，不要写"根据情况灵活处理"之类的空话
8. **直接输出 Markdown 正文**，不要加代码块标记

## 模板结构（必须严格遵循可复制区的格式）

${skillTemplate}
`
  }

  /**
   * 构建生成测试用例时的 system prompt。
   * 将 test-case-template.md 的标准格式、6 类测试类别和评分规范注入。
   */
  buildTestCaseCreationPrompt(): string {
    const testTemplate = this.getTemplate('test-case-template.md')

    return `你是 AI 分身质量测试专家。你的任务是根据知识文件内容，生成覆盖多个维度的测试用例。

## 强制约束（不可违反）

1. **必须覆盖以下 6 个测试类别**（每类至少 1 个用例）：
   - 人格一致性：测试分身是否按 soul.md 定义的风格回答
   - 知识准确性：测试分身对知识库内容的掌握
   - 知识库约束：测试分身在知识库没有数据时是否诚实拒绝
   - 数据溯源：测试分身是否标注数据来源
   - 第一性原理：测试分身是否追问本质、拆解假设
   - 边界处理：测试分身面对模糊/超范围问题时的处理

2. **每个测试用例必须包含**：
   - 名称（简短描述）
   - 类别（上述 6 类之一）
   - 用户问题（PROMPT）：真实自然的用户提问
   - 期望包含（MUST_CONTAIN）：回答中必须出现的关键事实或关键词
   - 不应包含（MUST_NOT_CONTAIN）：回答中不应出现的内容（如编造数据、模糊表述）
   - 评分标准（RUBRICS）：可量化的评估条件

3. **输出格式**（严格遵守，每个用例一段）：

===TEST_CASE===
名称: [简短名称]
类别: [6 类之一]
用户问题: [用户会问的具体问题]
期望包含: [关键词，每行一个]
不应包含: [不应出现的内容，每行一个]
评分标准: [评估标准，每行一个]
===END===

## 模板参考（用于理解测试用例的标准格式和示例）

${testTemplate}
`
  }

  /**
   * 从 agent-template.md 中提取核心约束部分（知识库约束 + 第一性原理），
   * 用于增强 AvatarManager.generateClaudeMd() 的输出质量。
   */
  getAgentCoreConstraints(): string {
    const agentTemplate = this.getTemplate('agent-template.md')
    if (!agentTemplate) return ''

    const sections: string[] = []

    // 提取"最高准则"整个区块（从"## 最高准则"到下一个"## "）
    const coreMatch = agentTemplate.match(
      /## 最高准则[：:].+?\n([\s\S]*?)(?=\n## [^#])/
    )
    if (coreMatch) {
      sections.push('## 最高准则：基于知识库回答，坚持第一性原理\n\n' + coreMatch[1].trim())
    }

    // 提取"回答示范"区块
    const exampleMatch = agentTemplate.match(
      /## 回答示范\n([\s\S]*?)(?=\n## [^#]|$)/
    )
    if (exampleMatch) {
      sections.push('## 回答示范\n' + exampleMatch[1].trim())
    }

    return sections.join('\n\n')
  }

  /**
   * 获取 knowledge README 模板内容。
   */
  getKnowledgeReadmeTemplate(): string {
    return this.getTemplate('knowledge-readme-template.md')
  }
}
