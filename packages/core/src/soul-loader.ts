import fs from 'fs'
import path from 'path'
import { SkillManager } from './skill-manager'
import { assertSafeSegment } from './utils/path-security'
import { DEFAULT_MAX_DIR_DEPTH } from './utils/common'

export interface AvatarConfig {
  id: string
  name: string
  systemPrompt: string
}

/** Excel 列 schema（与 document-parser.ts 的 ExcelColumnSchema 对应） */
interface ExcelColumnSchema {
  name: string
  dtype: 'number' | 'date-like' | 'string'
  uniqueCount: number
  samples: Array<string | number>
  min?: string | number
  max?: string | number
}

/** Excel sheet（rows 在 SoulLoader 中不加载，仅读 schema） */
interface ExcelSheetSchema {
  name: string
  rowCount: number
  columns: ExcelColumnSchema[]
}

/** knowledge/_excel/*.json 的顶层结构（仅 schema 部分） */
interface ExcelFileSchema {
  fileName: string
  basename: string
  sheets: ExcelSheetSchema[]
}

/**
 * 解析简单 YAML frontmatter。只支持 `key: value` 和 `rag_only: true|false` 等基础
 * 场景，不引入 yaml 依赖。如果 .md 文件第一行不是 `---` 则返回空对象。
 */
function parseFrontmatter(content: string): { data: Record<string, unknown>; body: string } {
  if (!content.startsWith('---\n') && !content.startsWith('---\r\n')) {
    return { data: {}, body: content }
  }
  const endMatch = content.match(/\n---\r?\n/)
  if (!endMatch || endMatch.index === undefined) {
    return { data: {}, body: content }
  }
  const fmText = content.slice(4, endMatch.index)
  const body = content.slice(endMatch.index + endMatch[0].length)
  const data: Record<string, unknown> = {}
  for (const line of fmText.split(/\r?\n/)) {
    const m = line.match(/^([a-zA-Z_][\w-]*)\s*:\s*(.*)$/)
    if (!m) continue
    const key = m[1]
    const raw = m[2].trim()
    if (raw === 'true') data[key] = true
    else if (raw === 'false') data[key] = false
    else if (/^-?\d+$/.test(raw)) data[key] = parseInt(raw, 10)
    else if (/^-?\d+\.\d+$/.test(raw)) data[key] = parseFloat(raw)
    else if (raw.startsWith('[') && raw.endsWith(']')) {
      // 简单数组：[a, b, "c"]，按逗号切，去掉引号
      data[key] = raw.slice(1, -1).split(',')
        .map(s => s.trim().replace(/^["']|["']$/g, ''))
        .filter(s => s.length > 0)
    } else {
      data[key] = raw.replace(/^["']|["']$/g, '')
    }
  }
  return { data, body }
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
    assertSafeSegment(avatarId, '分身ID')
    const avatarPath = path.join(this.avatarsPath, avatarId)

    // 读取 CLAUDE.md（入口文件）
    const claudeMd = this.readFileSafe(path.join(avatarPath, 'CLAUDE.md'))

    // 读取 soul.md（人格定义）
    const soulMd = this.readFileSafe(path.join(avatarPath, 'soul.md'))

    // GAP2: 读取 memory/MEMORY.md（长期记忆）
    const memoryContent = this.readFileSafe(path.join(avatarPath, 'memory', 'MEMORY.md'))

    // Feature 3: 读取 memory/USER.md（用户画像）
    const userProfileContent = this.readFileSafe(path.join(avatarPath, 'memory', 'USER.md'))

    // GAP10: 读取 shared/knowledge/ 目录（共享知识库）
    const sharedKnowledgeFiles = this.readDirectory(path.join(this.sharedPath, 'knowledge'))

    // 递归读取 knowledge/ 目录下所有知识文件（含子目录如 imports/）注入 system prompt
    const knowledgeRootFiles = this.readDirectory(path.join(avatarPath, 'knowledge'))

    // GAP3: 通过 SkillManager 获取已启用技能内容（而非读取全部 skills/ 文件）
    // Feature 5: 渐进式披露——默认只注入摘要，AI 通过 load_skill 工具按需加载完整内容
    const skillsContent = this.skillManager.getSkillsSummary(avatarId)

    // GAP11: 工具调用能力说明（帮助 DeepSeek 等模型更好地使用 function calling）
    const toolsNote = [
      '## 可用工具',
      '',
      '你可以调用以下工具来辅助回答，请在需要查询具体数据时主动调用：',
      '',
      '- **search_knowledge(query)**: 在知识库中检索相关内容片段，用于查找产品参数、政策文件、项目案例等',
      '- **read_knowledge_file(file_path)**: 读取知识库指定文件的完整内容',
      '- **list_knowledge_files()**: 列出知识库中所有可用文件',
      '- **query_excel(file, sheet, filter, columns, limit)**: **精确**查询已导入的 Excel / CSV 数据。当用户问涉及表格数据、要按条件筛选行、生成图表时，必须用此工具（不要用 search_knowledge 查 Excel）。filter 支持 MongoDB 风格（$eq/$ne/$gt/$gte/$lt/$lte/$in）。系统 prompt 顶部的"可查询 Excel 数据源"列出所有可用 file 和 sheet',
      '- **calculate_roi(...)**: 计算储能项目的峰谷套利收益、IRR 和回收期',
      '- **lookup_policy(province, policy_type)**: 查询省份电价政策或补贴信息',
      '- **compare_products(products)**: 对比多款产品的技术参数',
      '- **load_skill(skill_id)**: 按需加载指定技能的完整执行步骤（system prompt 中只含摘要，执行前必须先调用此工具获取完整流程）',
      '- **delegate_task(task)**: 将独立子任务委派给子代理并行执行，子代理使用相同的知识库但独立对话上下文',
      '',
      '**调用原则**：当用户询问具体项目数据、特定省份政策、产品规格对比、收益计算时，应主动调用工具获取准确信息，不要凭记忆回答。**涉及 Excel 表格数据必须用 query_excel**，不要用 search_knowledge 模糊匹配表格。需要执行某项技能时，必须先调用 load_skill 获取完整定义。',
    ].join('\n')

    // 构建 system prompt
    const parts: string[] = [claudeMd, '\n\n---\n\n', soulMd]

    // 共享知识（所有分身通用）
    if (sharedKnowledgeFiles.length > 0) {
      parts.push('\n\n---\n\n# 共享知识库\n\n')
      sharedKnowledgeFiles.forEach(f => parts.push(f.content + '\n\n'))
    }

    // 知识库文件（递归读取所有 knowledge/ 子目录文件）
    // rag_only 标记的文件（Excel 导入、超大文档等）不拼入 system prompt，
    // 只通过 search_knowledge / query_excel 等工具按需检索。
    if (knowledgeRootFiles.length > 0) {
      const knowledgeBase = path.join(avatarPath, 'knowledge')
      const stuffEntries: Array<{ relPath: string; body: string }> = []
      const ragOnlyEntries: Array<{ relPath: string; meta: Record<string, unknown> }> = []

      for (const f of knowledgeRootFiles) {
        const relPath = path.relative(knowledgeBase, f.path)
        const { data: fm, body } = parseFrontmatter(f.content)
        if (fm.rag_only === true) {
          ragOnlyEntries.push({ relPath, meta: fm })
        } else {
          stuffEntries.push({ relPath, body })
        }
      }

      const totalStuffChars = stuffEntries.reduce((sum, e) => sum + e.body.length, 0)
      if (totalStuffChars > 100_000) {
        console.warn(`[SoulLoader] 知识库 stuff 部分总字符数 ${totalStuffChars} 超过 100K，system prompt 可能过长，建议为大文档加 rag_only: true frontmatter`)
      }

      if (stuffEntries.length > 0) {
        parts.push('\n\n---\n\n# 知识库\n\n')
        stuffEntries.forEach(e => {
          parts.push(`<!-- 文件: knowledge/${e.relPath} -->\n${e.body}\n\n`)
        })
      }

      // RAG-only 文件索引（只告诉 LLM 有哪些文件可通过 search_knowledge 检索）
      if (ragOnlyEntries.length > 0) {
        parts.push('\n\n---\n\n# 可检索知识（不在 system prompt 中，通过工具按需访问）\n\n')
        ragOnlyEntries.forEach(e => {
          const source = typeof e.meta.source === 'string' ? e.meta.source : 'document'
          parts.push(`- \`knowledge/${e.relPath}\`（${source}）\n`)
        })
      }

      // Excel 结构化数据源 schema 摘要（供 query_excel 工具调用）
      const excelSchemas = this.loadExcelSchemas(path.join(avatarPath, 'knowledge', '_excel'))
      if (excelSchemas.length > 0) {
        parts.push('\n\n---\n\n# 可查询 Excel 数据源\n\n')
        parts.push('以下 Excel 已导入并建立索引，请使用 `query_excel({file, sheet, filter, columns, limit})` 按条件精确过滤行，**不要**用 search_knowledge 去查 Excel 数据。\n\n')
        parts.push('## Excel 查询纪律（严格执行，不依赖技能加载）\n\n')
        parts.push('1. **schema 相关问题**（"有没有 X 列"、"X 列是什么类型"、"是否包含月份/日期"、"这张表有哪些字段"、"数据范围"）→ **直接从下方 Schema 摘要回答，不要调 query_excel**。Schema 摘要已包含列名、类型、唯一值数量、数值范围、样例值，足以回答绝大多数 meta 问题。\n')
        parts.push('2. **具体数据问题**（如"2026 年 3 月 215 机型的效率"）→ 调 `query_excel`，**必须带 filter**（MongoDB 风格 `$eq`/`$gte`/`$in` 等）。\n')
        parts.push('3. **单次回答最多 3 次 `query_excel` 调用**。超过说明过滤条件太散，应回退到 Schema 确认字段，而不是继续试探。\n')
        parts.push('4. **禁止"探索式试探"**（不带 filter 的 `limit: 5` 这种）—— Schema 里已有列名、样例、范围，试探只浪费工具调用轮数。\n')
        parts.push('5. **画图/图表需求的工具顺序（关键）**：当用户要求生成图表（折线图/柱状图/饼图/趋势对比等），**必须先** `load_skill(\'draw-chart\')` **再** `query_excel`，**不要反过来**。draw-chart 技能内部会告诉你图表 JSON 格式、数据过滤策略、"最多 2 次 query_excel"的纪律。先加载技能再查数据可以让你在技能约束下高效完成，避免烧完轮数才想起要加载技能。\n')
        parts.push('   - ❌ 错误顺序：`query_excel` × 多次 → 想起要加载 draw-chart 技能 → 轮数已耗尽\n')
        parts.push('   - ✅ 正确顺序：`load_skill(\'draw-chart\')` → `query_excel` × 1-2 次（带精确 filter）→ 输出 ` ```chart ` 代码块\n')
        parts.push('6. 违反以上纪律可能导致工具调用轮数耗尽（`MAX_TOOL_ROUNDS = 10`），用户得不到答案。\n\n')
        parts.push('## Schema 摘要\n')
        excelSchemas.forEach(schema => {
          parts.push(this.formatExcelSchema(schema))
          parts.push('\n')
        })
      }
    }

    // GAP2: 长期记忆（始终注入，用于对话一致性）
    if (memoryContent.trim()) {
      parts.push('\n\n---\n\n# 长期记忆\n\n')
      parts.push(memoryContent)
    }

    // Feature 3: 用户画像（沟通风格、偏好等）
    if (userProfileContent.trim()) {
      parts.push('\n\n---\n\n# 用户画像\n\n')
      parts.push(userProfileContent)
    }

    // 回答质量规则（确保 LLM 充分利用知识库并保持回答完整性）
    parts.push('\n\n---\n\n')
    parts.push([
      '## 回答规则（强制执行）',
      '',
      '1. **来源标注**：每个关键数据必须标注来源，格式为 `[来源: knowledge/文件路径 - 章节/表格名]`',
      '2. **禁止编造**：禁止使用"根据我的经验"等措辞，所有数据必须来自知识库文件，知识库没有就说"知识库中未收录"',
      '3. **数值准确**：引用数值时必须与知识库原文完全一致，禁止对原始数值做近似或四舍五入',
      '4. **原文复述校验**：回答中每个关键数值必须执行"引用-复述-校对"三步：',
      '   - 引用：从知识库中定位原文所在行',
      '   - 复述：将该数值逐字符抄写到回答中',
      '   - 校对：将回答中的数值与知识库原文逐位比对，发现不一致必须修正后再输出',
      '   - 示例：知识库写"2470.5"，回答中必须写"2470.5"，不可写"2478.5"或"约2471"',
      '5. **计算校验**：涉及面积/体积等计算时，列出完整计算公式和每一步的数值，公式中的每个数值必须标注来源，计算结果必须附验算过程',
      '6. **完整检索**：涉及设备/组件时，检索知识库中该组件出现的所有位置，合并分散信息后再回答',
      '7. **缺失声明**：只有知识库中确实不存在的数据，才标注为"知识库中未收录"',
      '8. **空间布局**：涉及空间布局、位置关系的问题，用 ASCII 图直观展示组件相对位置',
    ].join('\n'))

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

  /** 安全读取文件，文件不存在时返回空字符串，其他错误打日志 */
  private readFileSafe(filePath: string): string {
    try {
      return fs.readFileSync(filePath, 'utf-8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn(`[SoulLoader] 读取文件失败 (${filePath}):`, error instanceof Error ? error.message : String(error))
      }
      return ''
    }
  }

  /** 知识目录最大递归深度（使用共享常量，与其他模块保持一致） */
  private static readonly MAX_DIR_DEPTH = DEFAULT_MAX_DIR_DEPTH

  /** 递归读取目录下所有 .md 文件 */
  private readDirectory(dirPath: string, depth = 0): Array<{ path: string; content: string }> {
    if (depth > SoulLoader.MAX_DIR_DEPTH) {
      console.warn(`[SoulLoader] 目录递归深度超过上限(${SoulLoader.MAX_DIR_DEPTH})，停止: ${dirPath}`)
      return []
    }
    const files: Array<{ path: string; content: string }> = []
    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true })
      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name)
        if (entry.isDirectory()) {
          files.push(...this.readDirectory(fullPath, depth + 1))
        } else if (entry.isFile() && entry.name.endsWith('.md')) {
          files.push({ path: fullPath, content: this.readFileSafe(fullPath) })
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn(`[SoulLoader] 读取目录失败 (${dirPath}):`, error instanceof Error ? error.message : String(error))
      }
    }
    return files
  }

  private extractAvatarName(claudeMd: string): string {
    const match = claudeMd.match(/^#\s+(.+)$/m)
    return match ? match[1] : '未命名分身'
  }

  /**
   * 读 knowledge/_excel/*.json 里每个 Excel 的 schema（不加载 rows）。
   * 返回用于 system prompt 拼接的 ExcelFileSchema 列表。
   */
  private loadExcelSchemas(excelDir: string): ExcelFileSchema[] {
    if (!fs.existsSync(excelDir) || !fs.statSync(excelDir).isDirectory()) {
      return []
    }
    const schemas: ExcelFileSchema[] = []
    try {
      const entries = fs.readdirSync(excelDir, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue
        try {
          const raw = fs.readFileSync(path.join(excelDir, entry.name), 'utf-8')
          const parsed = JSON.parse(raw) as {
            fileName?: string
            sheets?: Array<{
              name: string
              rowCount: number
              columns: ExcelColumnSchema[]
            }>
          }
          if (!parsed.sheets) continue
          schemas.push({
            fileName: parsed.fileName || entry.name,
            basename: entry.name.replace(/\.json$/, ''),
            sheets: parsed.sheets.map(s => ({
              name: s.name,
              rowCount: s.rowCount,
              columns: s.columns,
            })),
          })
        } catch (err) {
          console.warn(`[SoulLoader] Excel schema 解析失败 ${entry.name}:`, err instanceof Error ? err.message : String(err))
        }
      }
    } catch (err) {
      console.warn(`[SoulLoader] 读取 _excel 目录失败:`, err instanceof Error ? err.message : String(err))
    }
    return schemas
  }

  /** 把单个 Excel 的 schema 格式化为 LLM 可读的 markdown 段。 */
  private formatExcelSchema(schema: ExcelFileSchema): string {
    const lines: string[] = []
    lines.push(`## ${schema.fileName}`)
    lines.push(`- **file** (query_excel 参数): \`${schema.basename}\``)
    for (const sheet of schema.sheets) {
      lines.push(``)
      lines.push(`### sheet \`${sheet.name}\` — ${sheet.rowCount} 行`)
      for (const col of sheet.columns) {
        const parts: string[] = [`  - \`${col.name}\` (${col.dtype}, ${col.uniqueCount} 唯一值)`]
        if (col.min !== undefined && col.max !== undefined) {
          parts.push(`范围 ${JSON.stringify(col.min)} ~ ${JSON.stringify(col.max)}`)
        }
        if (col.samples.length > 0) {
          const sample = col.samples.slice(0, 5).map(s => JSON.stringify(s)).join(', ')
          parts.push(`样例 ${sample}`)
        }
        lines.push(parts.join(' · '))
      }
    }
    return lines.join('\n')
  }
}
