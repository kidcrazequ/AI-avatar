/**
 * skill-generator-prompt.ts — 用于"AI 自然语言生成技能草稿"的 meta-prompt 构造。
 *
 * 流程：
 *   1. 读 templates/skill-template.md（格式规范）
 *   2. 读 templates/skills/*.md（few-shot 示例）
 *   3. 拼成 system + user prompt 给 LLM
 *   4. LLM 返回完整的 skill markdown 草稿
 *
 * 关键设计：
 *   - 不强制让 LLM 按照单个具体 example 复刻，而是让它**理解模式**
 *   - 输出 frontmatter 里的 `name` 字段会成为 skill ID，由前端做最终校验
 *   - LLM 输出失败时调用方负责降级（前端会展示原始返回让用户手动修）
 */
import fs from 'fs'
import path from 'path'

export const SKILL_GEN_SYSTEM_PROMPT = `你是一个 soul 项目的「技能编辑助手」，专门帮用户从自然语言描述生成结构化的 skill markdown 文件。

## 你的任务

用户会用一句话或几句话描述他想要的技能。你需要输出**一份完整可用的 skill markdown 文件**。
输出必须严格符合下面的"模板规范"和"已有技能示例"展示的格式与风格。

## 输出要求

1. **只输出 markdown 文件本身**（含 \`---\` frontmatter + 正文），不要任何额外解释、不要包装在代码块里
2. **frontmatter 必须包含**：
   - \`name\`：skill 的 ID，**只能用小写英文字母 / 数字 / 连字符**，不超过 40 字符，必须能反映技能用途（例如 \`filter-open-tasks\`、\`export-pptx\`、\`summarize-meeting\`）
   - \`description\`：第三人称描述这个技能 WHAT + WHEN，含触发关键词，1-2 句话，不超过 300 字
3. **正文必须包含的章节**：
   - \`# 标题\`（中文人类可读名）
   - \`> **级别**：[■] 基础 / [■■] 进阶 / [■■■] 专家\`（自行判断）
   - \`> **版本**：v1.0\`
   - \`## 技能说明\`（一句话）
   - \`## 触发条件\`（用户在什么场景下用）
   - \`## 输入\`（如果需要参数）
   - \`## 执行流程\`（核心：分步骤说明 LLM 应该做什么）
   - \`## 输出格式\`（如果有）
   - \`## 示例\`（至少一个用户输入 → 输出示例）
4. **风格**：像 draw-chart / draw-mermaid 那样精炼、用 markdown 表格组织参数、有清晰的"自检清单"
5. **数据来源约束**：如果技能涉及"基于知识库"的查询，必须明确写"必须来源于 knowledge/ 或用户消息，禁止编造"

## 禁止事项

- 不要在最后写"以上是生成的技能"之类的总结
- 不要用代码块包裹整个输出
- 不要省略 frontmatter
- 不要输出无关的对话内容
`

/**
 * 构造 user prompt：包含技能模板规范 + 已有技能 few-shot 示例 + 用户的自然语言描述。
 *
 * @param templatesPath soul 仓库的 templates/ 目录绝对路径
 * @param userDescription 用户用自然语言描述他想要的技能
 */
export function buildSkillGenUserPrompt(templatesPath: string, userDescription: string): string {
  const parts: string[] = []

  // 1. 模板规范
  const templateFile = path.join(templatesPath, 'skill-template.md')
  if (fs.existsSync(templateFile)) {
    const tpl = fs.readFileSync(templateFile, 'utf-8')
    parts.push('## 模板规范\n\n以下是 skill markdown 的标准模板（占位符用 `{{...}}` 表示，输出时请替换为真实内容）：\n\n')
    parts.push(tpl)
    parts.push('\n\n---\n\n')
  }

  // 2. Few-shot 示例：读 templates/skills/*.md 作为参考
  const skillsDir = path.join(templatesPath, 'skills')
  if (fs.existsSync(skillsDir) && fs.statSync(skillsDir).isDirectory()) {
    const skillFiles = fs.readdirSync(skillsDir, { withFileTypes: true })
      .filter(e => e.isFile() && e.name.endsWith('.md'))
      .map(e => e.name)
      .sort()
    if (skillFiles.length > 0) {
      parts.push('## 已有技能示例\n\n以下是项目里现有的几个技能，作为风格和结构的参考：\n\n')
      for (const fileName of skillFiles) {
        const content = fs.readFileSync(path.join(skillsDir, fileName), 'utf-8')
        // 截断过长的示例避免吃掉太多 token，只给前 2000 字
        const truncated = content.length > 2000 ? content.slice(0, 2000) + '\n\n... (内容省略)' : content
        parts.push(`### 示例：${fileName}\n\n\`\`\`markdown\n${truncated}\n\`\`\`\n\n`)
      }
      parts.push('---\n\n')
    }
  }

  // 3. 用户的需求
  parts.push('## 用户的需求\n\n')
  parts.push(userDescription.trim())
  parts.push('\n\n---\n\n')
  parts.push('请基于上面的模板规范和已有技能示例，为用户生成一份**完整的 skill markdown 文件**。直接输出 markdown 内容（含 frontmatter），不要任何额外说明。')

  return parts.join('')
}
