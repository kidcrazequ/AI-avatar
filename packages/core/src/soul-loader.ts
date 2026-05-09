import fs from 'fs'
import path from 'path'
import { SkillManager } from './skill-manager'
import { DEFAULT_TOOL_POLICY, buildToolPolicyPromptHints } from './tool-budget'
import { combineSystemPromptSections } from './prompt-sections'
import { assertSafeSegment } from './utils/path-security'
import { DEFAULT_MAX_DIR_DEPTH } from './utils/common'

export interface AvatarConfig {
  id: string
  name: string
  systemPrompt: string
  stableSystemPrompt: string
  dynamicSystemPrompt: string
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

  private loadBasePrompt(avatarId: string): string {
    const configPath = path.join(this.avatarsPath, avatarId, 'avatar.config.json')
    try {
      const raw = fs.readFileSync(configPath, 'utf-8')
      const parsed = JSON.parse(raw) as { basePromptId?: string }
      if (!parsed.basePromptId) return ''
      const promptPath = path.join(this.avatarsPath, '..', 'templates', 'prompts', `${parsed.basePromptId}.md`)
      return this.readFileSafe(promptPath)
    } catch {
      return ''
    }
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

    // Phase 5: 读取 life/consolidated.md（出厂人生记忆）
    // 文件不存在返回空字符串，loadAvatar 拼装时按空跳过——
    // 不论是分身没启用人生还是后台尚未生成完，都不应阻塞 system prompt 拼装。
    const lifeConsolidated = this.readFileSafe(path.join(avatarPath, 'life', 'consolidated.md'))

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
      '- **search_knowledge(query)**: 在知识库中检索相关内容片段，用于查找政策、电价、产品参数、项目案例、PDF/Word/Markdown/手写笔记等非结构化资料。结果会附 `[来源: knowledge/...#Lx-Ly]` 锚点，最终回答应尽量沿用。',
      '- **read_knowledge_file(file_path)**: 读取知识库指定文件的完整内容',
      '- **list_knowledge_files()**: 列出知识库中所有可用文件',
      '- **read_life_episode(id)**: 读取自己人生时间轴中某个具体事件的完整正文（id 形如 `ep-0007-first-snow`）。仅在用户问起具体往事、需要还原细节时调用；日常对话不要主动调用。',
      '- **list_design_systems(category?)**: 列出共享设计系统语料（`shared/design-systems/design-md`）中的品牌与分类，便于先选品牌再读取。',
      '- **read_design_system(slug, category?)**: 读取指定品牌 DESIGN.md。若 slug 在多个分类重复，需补 category 精确定位。',
      '- **search_design_systems(query, top_n?)**: 在共享设计系统语料中做关键词检索，返回候选品牌、分类和片段。',
      '- **read_file(path, offset?, limit?)**: 读取当前会话工作区文件内容（支持 `/projects/<convId>/...` 跨会话只读路径）。',
      '- **write_file(path, content, asset?, subtitle?)**: 写入当前会话工作区文件；传 asset 会自动进入资产清单。',
      '- **list_files(path?, depth?, filter?, offset?)**: 列出工作区目录结构。',
      '- **grep(pattern, path?)**: 在工作区文件里按正则检索文本。',
      '- **copy_files(files[]) / str_replace_edit(...) / delete_file(paths[])**: 对工作区文件执行复制、替换编辑、删除。',
      '- **register_assets(items[]) / unregister_assets(items[])**: 维护工作区资产审阅清单。',
      '- **show_to_user(path) / show_html(path)**: 在用户或隐藏预览窗口打开 HTML。',
      '- **eval_js(code) / eval_js_user_view(code)**: 在预览页面执行 JS 读取状态。',
      '- **save_screenshot / multi_screenshot / screenshot_user_view / get_webview_logs**: 预览截图与日志采集。',
      '- **save_as_html / save_as_pdf / export_pptx / gen_pptx / super_inline_html**: 导出设计制品。',
      '- **done(path) / fork_verifier_agent(task?)**: 交付与后台校验。',
      '- **present_fs_item_for_download / open_for_print / get_public_file_url**: 下载与打印交付。',
      '- **questions_v2 / copy_starter_component / connect_github / github_* / snip**: 表单、starter、连接器与上下文管理。',
      '- **query_excel(file, sheet, filter?, columns?, limit?, mode?)**: **精确**查询已导入的 Excel / CSV 数据。涉及表格行级数值、统计周期、筛选、排行、图表时，必须优先用此工具。若不确定字段，先传 `mode:"schema"` 获取列定义，再做精确查询。返回 JSON 会带 `source_anchor` 与 `_source_row`，引用数字时尽量沿用。',
      '- **calculate_roi(...)**: 计算储能项目的峰谷套利收益、IRR 和回收期',
      '- **load_skill(skill_id)**: 按需加载指定技能的完整执行步骤。通常相关技能已由系统自动注入，只有在系统未注入、且确实需要完整流程时再调用。',
      '- **delegate_task(task)**: 将独立子任务委派给子代理并行执行，子代理使用相同的知识库但独立对话上下文',
      '',
      '**调用原则**：当用户询问具体项目数据、特定省份政策、产品规格对比、收益计算时，应主动调用工具获取准确信息。涉及 Excel 表格数据必须用 `query_excel`，不要用 `search_knowledge` 模糊匹配表格。涉及技能时优先使用系统已注入的技能内容，不要把 `load_skill` 当成默认第一步。',
      '',
      // ────────────────────────────────────────────────────────────────
      // 工具调用诚信铁律（C 层：所有分身一处生效；与工具列表声明在同一处）
      // 这是回归测试中反复出现的失败模式（伪造 query_excel 调用过程、用 schema sample 推数字、
      // 编"配额已用尽"借口）的根因防御。任何分身都必须遵守。
      // ────────────────────────────────────────────────────────────────
      '**工具调用诚信铁律**（违反任意一条 = 严重失败）：',
      '',
      '1. **禁止伪造工具调用过程**：在没有真实发起 `query_excel` 调用的情况下，禁止写出"经查询 ... 返回 ..."、"过滤条件 col1=... 返回 N"、"返回结果如下" 等描述工具响应的话。回答中若出现具体数字，必须能在你本轮的真实工具调用记录里对应到一次 `query_excel` 返回值。',
      '2. **禁止从 schema sample 推数字（行级答案只能从 rows[] 取）**：`mode:"schema"` 返回的 `samples` 字段是该列独立去重抽样的代表值，**跨列不按行对齐**——`col1.samples[i]` 和 `故障次数.samples[i]` 绝不构成同一行的数据，把它们配对当成"X 行的 Y 列值"是严重错误。回答任何"X 在 Y 列的值是多少"类问题时，必须执行：(a) 调用 query_excel 时**不传 mode**，传 `filter: {对应列: "X"}`；(b) 仅从返回的 `rows[].Y` 字段取值；(c) 若 rows 为空才允许说"未查到"。任何引用 schema 的 samples / sample_values / sample 字段作为答案的回答都直接判失败。',
      '3. **禁止编不存在的限制借口**：未达本轮上限时，不得以"配额已用尽 / 无法查询 / 系统不允许"等不存在的理由拒绝调用 `query_excel`。真实达到上限时，按系统提示直接基于已查到的数据回答，不得编造未发生的查询过程。',
      '4. **禁止用模板答案套话**：每次提问都是独立的，上一轮的答案"1"不能套用到下一轮。每个具体数字都要走当前轮的真实查询。',
      '',
      '**自检（输出包含数字的回答前必须默念）**：',
      '> "我即将写出的这个数字，是 `query_excel` 工具刚刚返回的吗？如果不是，立刻删掉数字，先发起 `query_excel` 调用。"',
      '',
      buildToolPolicyPromptHints(DEFAULT_TOOL_POLICY),
    ].join('\n')

    // 构建 system prompt：stable 在前，dynamic（记忆/用户画像）放在尾部，利好前缀缓存。
    const basePrompt = this.loadBasePrompt(avatarId)
    const stableParts: string[] = []
    if (basePrompt.trim()) {
      stableParts.push(basePrompt, '\n\n---\n\n')
    }
    stableParts.push(claudeMd, '\n\n---\n\n', soulMd)
    const dynamicParts: string[] = []

    // 共享知识（所有分身通用）
    if (sharedKnowledgeFiles.length > 0) {
      stableParts.push('\n\n---\n\n# 共享知识库\n\n')
      sharedKnowledgeFiles.forEach(f => stableParts.push(f.content + '\n\n'))
    }

    // 知识库文件（递归读取所有 knowledge/ 子目录文件）
    // 知识文件注入策略：
    //   - 批量导入产物（有 source: pdf/word/pptx/... frontmatter）→ 运行时 rag_only，
    //     通过 search_knowledge / query_excel / read_knowledge_file 按需检索（Channel B+C）
    //   - 用户手写文件（无 source 字段）→ 塞进 system prompt（Channel A 全量注入）
    //   - 显式标记 rag_only: true 的文件 → 同上，不塞 prompt
    //
    // 为什么不全塞？237 文件 × 大多 < 50KB = 184K tokens，超 DeepSeek 131K 窗口。
    // 即使不超窗口，128K+ 长上下文的 LLM 注意力退化严重（"lost in the middle"），
    // 全量注入的实际完整性远低于理论值。Channel B（RAG top-12）+ Channel C（10 轮
    // search_knowledge / read_knowledge_file）完全可以兜底。
    if (knowledgeRootFiles.length > 0) {
      const knowledgeBase = path.join(avatarPath, 'knowledge')
      const stuffEntries: Array<{ relPath: string; body: string }> = []
      const ragOnlyEntries: Array<{ relPath: string; meta: Record<string, unknown> }> = []

      for (const f of knowledgeRootFiles) {
        const relPath = path.relative(knowledgeBase, f.path)
        const { data: fm, body } = parseFrontmatter(f.content)
        // 批量导入产物带 source 字段（source: pdf / word / pptx / excel / image），
        // 运行时当 rag_only 处理，不塞 system prompt。保留通过工具按需检索的能力。
        if (fm.rag_only === true || fm.source) {
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
        stableParts.push('\n\n---\n\n# 知识库\n\n')
        stuffEntries.forEach(e => {
          stableParts.push(`<!-- 文件: knowledge/${e.relPath} -->\n${e.body}\n\n`)
        })
      }

      // RAG-only 文件索引（只告诉 LLM 有哪些文件可通过 search_knowledge 检索）
      if (ragOnlyEntries.length > 0) {
        stableParts.push('\n\n---\n\n# 可检索知识（不在 system prompt 中，通过工具按需访问）\n\n')
        ragOnlyEntries.forEach(e => {
          const source = typeof e.meta.source === 'string' ? e.meta.source : 'document'
          stableParts.push(`- \`knowledge/${e.relPath}\`（${source}）\n`)
        })
      }

      // Excel 结构化数据源清单（F1 按需 schema：只列 sheet 名，不注入完整列 schema，
      // LLM 需要列详情时调 query_excel({mode:'schema', file, sheet}) 按需获取）
      const excelSchemas = this.loadExcelSchemas(path.join(avatarPath, 'knowledge', '_excel'))
      if (excelSchemas.length > 0) {
        stableParts.push('\n\n---\n\n# 可查询 Excel 数据源\n\n')
        stableParts.push('以下 Excel 已导入并建立索引，请使用 `query_excel` 工具按条件精确过滤行，**不要**用 search_knowledge 去查 Excel 数据。\n\n')
        stableParts.push('## Excel 查询纪律（严格执行，不依赖技能加载）\n\n')
        stableParts.push('1. **schema 相关问题**（"有没有 X 列"、"X 列是什么类型"、"这张表有哪些字段"、"数据范围"）→ 调 `query_excel({mode:"schema", file, sheet})` 获取列详情，再回答；**不要编造字段名**。\n')
        stableParts.push('2. **具体数据问题**（如"2026 年 3 月 215 机型的效率"）→ 调 `query_excel`，**必须带 filter**（MongoDB 风格 `$eq`/`$gte`/`$in` 等）。\n')
        stableParts.push(`3. **单次回答最多 ${DEFAULT_TOOL_POLICY.maxQueryExcelCallsPerRequest} 次 \`query_excel\` 调用**（以运行时预算为准）。超过说明过滤条件太散，应先调 \`{mode:"schema"}\` 确认字段，而不是继续试探。\n`)
        stableParts.push('4. **禁止“探索式试探”**（不带 filter 的 `limit:5` 这种）—— 先用 `{mode:"schema"}` 看列名。\n')
        stableParts.push('5. **画图/图表需求的工具顺序（关键）**：必须先调用 `load_skill(\'chart-from-knowledge\')` 或 `load_skill(\'draw-chart\')`，再用 `query_excel` 获取表格数值并输出 ` ```chart`；若目标列无有效数值，必须说明无可画数据并标注来源，禁止编造图表。\n')
        stableParts.push(`6. 违反以上纪律可能导致工具调用轮数耗尽（当前运行时上限 \`${DEFAULT_TOOL_POLICY.maxRounds}\` 轮），用户得不到答案。\n`)
        stableParts.push('7. **禁止仅凭 `search_knowledge` / `read_knowledge_file` 命中 Excel 对应 .md 的片段推断行级数值**。**表格数值以 `query_excel` 返回的 JSON 为准**。\n\n')
        stableParts.push('## 可用 Excel 清单\n\n')
        excelSchemas.forEach(schema => {
          stableParts.push(this.formatExcelSchemaBrief(schema))
          stableParts.push('\n')
        })

        stableParts.push('\n## Excel 输出工作流\n\n')
        stableParts.push('当任务包含「对比 / 差异 / diff / 输出 Excel / 导出 Excel / 生成 Excel 报告」时，按此流程执行：\n')
        stableParts.push('1. 先用 `query_excel({mode:"schema", file, sheet})` 拿到所有相关 sheet 的列结构（schema 不计入 24 次精确查询预算的"试探"，但仍占预算 1 次）\n')
        stableParts.push('2. 用 `query_excel`（不带 mode）做精确查询，把要对比的行拉下来（注意预算 24 次/轮）\n')
        stableParts.push('3. 在主回答中先用 markdown 表格展示对比结论，让用户先看到答案\n')
        stableParts.push('4. 调 `export_excel({filename, sheets:[{name, rows}, ...]})` 把结构化结果落盘\n')
        stableParts.push('5. 在回答末尾告知用户："已输出到 workspaces/<conversationId>/exports/<filename>.xlsx，可在桌面端「设置 → 打开工作区目录」查看"\n\n')
        stableParts.push('严禁：跳过 export_excel 直接说"我已生成 Excel 文件"——没调工具就是没生成，属于幻觉。\n')
      }
    }

    // Phase 5: 注入「我的人生（出厂记忆）」+ 人生使用守则
    // 位置：知识库之后、工具说明之前。consolidated.md 由 forgetter.ts 负责
    // 8K 字硬上限（CONSOLIDATED_MAX_CHARS），此处直接整段塞入即可。
    if (lifeConsolidated.trim()) {
      stableParts.push('\n\n---\n\n# 我的人生（出厂记忆）\n\n')
      stableParts.push(lifeConsolidated)
      stableParts.push('\n\n## 人生使用守则\n\n')
      stableParts.push([
        '1. **不主动展开往事**：除非用户明确问起你的过去/经历/某段时间的事，否则不要在日常回答中主动讲人生故事，避免"卖惨"或"老干部回忆录"语气。',
        '2. **被问起时再翻日记**：用户问到具体年龄/时间/事件时，可调用 `read_life_episode(id)` 取该事件的完整正文（id 见上文「我的人生」章节里出现过的事件标识，形如 `ep-0007-first-snow`），引用具体细节而不是泛泛而谈。',
        '3. **风格沉淀，不直接背诵**：日常回答里的判断、隐喻、价值偏好可以从这些经历里"长"出来，但不必复述事件本身——读者关心的是观点。',
        '4. **不剧透未来**：你的视角停在当前年龄；不要谈论"未来某年我会..."这种超出当前的展望。',
      ].join('\n'))
    }

    // 文档输出工作流（PDF / Word / Markdown）— 不依赖 Excel/知识库，所有分身通用
    // @date 2026-05-08
    stableParts.push('\n\n---\n\n## 文档输出工作流（PDF / Word / Markdown）\n\n')
    stableParts.push('当用户明确要求生成文档文件（"出一份方案 PDF"、"做成 Word 报告"、"生成 markdown 纪要"等）时：\n\n')
    stableParts.push('1. **先在主回答中给出文档摘要**（让用户看到内容，再产出文件）\n')
    stableParts.push('2. **构造 IR**：用 markdown + frontmatter 表达内容，扩展语法包括：\n')
    stableParts.push('   - frontmatter 必须 `title`，可选 `author/date/template`\n')
    stableParts.push('   - `:::callout warning ... :::` 提示框（level: info/warning/success/danger）\n')
    stableParts.push('   - `:::cite source="knowledge/xxx.md" page=N ... :::` 带溯源的引用\n')
    stableParts.push('3. **调用 `generate_document({format, ir, filename, templateName?})`** 落盘\n')
    stableParts.push('   - format 选 md/pdf/docx 之一\n')
    stableParts.push('   - filename 自起，不含扩展名\n')
    stableParts.push('   - templateName 不传走 default；如分身有专属模板（如小堵的 `solution-report`、`income-calculation`）按需指定\n')
    stableParts.push('4. **回答末尾告知**：「已生成 <filename>.<ext>，可在下方文件卡片点击打开」\n\n')
    stableParts.push('严禁：跳过 generate_document 工具直接说"我已生成文档"——没调工具就是没生成，属于幻觉。\n')
    stableParts.push('严禁：把整段 markdown 答案抄进 IR 而不构造结构化块（要让 IR 用 frontmatter 和扩展语法表达层次）。\n')

    // GAP2: 长期记忆 / 用户画像改为 dynamic 段，放在 system prompt 尾部，利好前缀缓存。
    if (memoryContent.trim()) {
      dynamicParts.push('\n\n---\n\n# 长期记忆\n\n')
      dynamicParts.push(memoryContent)
    }

    if (userProfileContent.trim()) {
      dynamicParts.push('\n\n---\n\n# 用户画像\n\n')
      dynamicParts.push(userProfileContent)
    }

    // 回答质量规则（确保 LLM 充分利用知识库并保持回答完整性）
    stableParts.push('\n\n---\n\n')
    stableParts.push([
      '## 回答规则（强制执行）',
      '',
      '1. **来源标注**：每个关键数据必须优先复用上下文或工具结果里已有的 `[来源: ...]` 锚点。知识片段优先使用 `[来源: knowledge/文件路径#Lx-Ly]`，Excel 数据优先使用 `query_excel` 返回的 `source_anchor`。',
      '2. **禁止编造**：所有结论必须来自知识库、工具返回或用户提供信息；资料不足时明确说“知识库中未收录”或“当前上下文不足”。',
      '3. **数值准确**：引用数值时必须与原文或工具结果一致，禁止擅自近似、改写或补全缺失数字。',
      '4. **缺失声明与计算透明**：需要计算时列出公式与关键输入；知识缺失时不要硬答。',
    ].join('\n'))

    // GAP11: 工具调用说明（始终注入，告知 LLM 其工具能力）
    stableParts.push('\n\n---\n\n')
    stableParts.push(toolsNote)

    // GAP3: 已启用的技能（通过 SkillManager 过滤）
    if (skillsContent) {
      stableParts.push('\n\n---\n\n')
      stableParts.push(skillsContent)
    }

    const stableSystemPrompt = stableParts.join('')
    const dynamicSystemPrompt = dynamicParts.join('')
    const systemPrompt = combineSystemPromptSections(stableSystemPrompt, dynamicSystemPrompt)

    return {
      id: avatarId,
      name: this.extractAvatarName(claudeMd),
      systemPrompt,
      stableSystemPrompt,
      dynamicSystemPrompt,
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

  /**
   * 递归读取目录下所有 .md 文件。
   *
   * 优化：rag_only 文件（批量导入产物）只读取 frontmatter 头部（~512 字节），
   * 跳过可能数 MB 的 body。loadAvatar 不需要 rag_only 文件的 body——只用
   * frontmatter 里的 source 字段生成索引条目。500+ 文件场景下从读取全量内容
   * （10+ 秒阻塞）降到只读头部（< 1 秒）。
   */
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
          // 先只读头部 512 字节探测 rag_only frontmatter
          const header = this.readFileHeader(fullPath, 512)
          if (header !== null && this.isRagOnly(header)) {
            // rag_only 文件：只保留 frontmatter，loadAvatar 不需要 body
            files.push({ path: fullPath, content: header })
          } else {
            // 非 rag_only 或无 frontmatter：读取完整内容拼入 system prompt
            files.push({ path: fullPath, content: this.readFileSafe(fullPath) })
          }
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn(`[SoulLoader] 读取目录失败 (${dirPath}):`, error instanceof Error ? error.message : String(error))
      }
    }
    return files
  }

  /** 读取文件前 N 字节（用于 frontmatter 探测），文件不存在返回 null */
  private readFileHeader(filePath: string, bytes: number): string | null {
    let fd: number | null = null
    try {
      fd = fs.openSync(filePath, 'r')
      const buf = Buffer.alloc(bytes)
      const bytesRead = fs.readSync(fd, buf, 0, bytes, 0)
      return buf.toString('utf-8', 0, bytesRead)
    } catch {
      return null
    } finally {
      if (fd !== null) fs.closeSync(fd)
    }
  }

  /** 快速判断文件头部是否含 rag_only: true frontmatter */
  private isRagOnly(header: string): boolean {
    if (!header.startsWith('---\n') && !header.startsWith('---\r\n')) return false
    const endIdx = header.indexOf('\n---\n')
    const endIdx2 = header.indexOf('\n---\r\n')
    const end = endIdx >= 0 ? endIdx : endIdx2
    if (end < 0) return false
    const fm = header.slice(0, end)
    return /\brag_only\s*:\s*true\b/.test(fm)
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

  /**
   * 把单个 Excel 的 schema 格式化为 LLM 可读的 markdown 段。
   *
   * 优化策略（降低 system prompt 体积 ~50%，减少 TTFT）：
   *   1. 每列 samples 从 5 个降至 2 个
   *   2. 超过 MAX_COLS_FULL_DETAIL 列的 sheet，只完整列出前 MAX_COLS_FULL_DETAIL 列；
   *      剩余列仅列出名称（数值枚举型扩展到 MAX_ENUM_COLS 列）
   *   3. 字符串样例截断至 MAX_SAMPLE_STR_LEN 字符，避免超长值撑大 prompt
   *   4. 连续数值列（uniqueCount >= NUM_UNIQUE_THRESHOLD）仅保留 min/max，省略样例
   */
  private formatExcelSchema(schema: ExcelFileSchema): string {
    const MAX_COLS_FULL_DETAIL = 20
    const MAX_SAMPLES = 2
    const MAX_SAMPLE_STR_LEN = 30
    const NUM_UNIQUE_THRESHOLD = 20

    const lines: string[] = []
    lines.push(`## ${schema.fileName}`)
    lines.push(`- **file** (query_excel 参数): \`${schema.basename}\``)

    for (const sheet of schema.sheets) {
      lines.push(``)
      lines.push(`### sheet \`${sheet.name}\` — ${sheet.rowCount} 行`)

      const fullCols = sheet.columns.slice(0, MAX_COLS_FULL_DETAIL)
      const remainCols = sheet.columns.slice(MAX_COLS_FULL_DETAIL)

      for (const col of fullCols) {
        const parts: string[] = [`  - \`${col.name}\` (${col.dtype}, ${col.uniqueCount} 唯一值)`]
        if (col.min !== undefined && col.max !== undefined) {
          parts.push(`范围 ${JSON.stringify(col.min)} ~ ${JSON.stringify(col.max)}`)
        }
        // 连续数值列（唯一值多）仅保留范围，不附 samples
        if (col.samples.length > 0 && col.uniqueCount < NUM_UNIQUE_THRESHOLD) {
          const sample = col.samples.slice(0, MAX_SAMPLES).map(s => {
            const raw = JSON.stringify(s)
            return raw.length > MAX_SAMPLE_STR_LEN ? raw.slice(0, MAX_SAMPLE_STR_LEN) + '…"' : raw
          }).join(', ')
          parts.push(`样例 ${sample}`)
        }
        lines.push(parts.join(' · '))
      }

      if (remainCols.length > 0) {
        const names = remainCols.map(c => `\`${c.name}\``).join(', ')
        lines.push(`  - （另有 ${remainCols.length} 列，调 query_excel 时自动可用：${names}）`)
      }
    }
    return lines.join('\n')
  }

  /**
   * 列名级 Excel 清单（方案 A）：
   * 输出文件名、file 参数、各 sheet 名 + 行数 + 所有列名（无 dtype/samples/range）。
   * 列名让 LLM 能准确路由到正确 sheet，详细 dtype/range/samples 通过
   * query_excel({mode:'schema'}) 按需获取。
   * 体积约 8-12KB（vs 原始含 samples 的 25-30KB，vs 仅 sheet 名的 0.3KB）。
   */
  private formatExcelSchemaBrief(schema: ExcelFileSchema): string {
    const lines: string[] = []
    lines.push(`- **${schema.fileName}** (file 参数: \`${schema.basename}\`)`)
    for (const sheet of schema.sheets) {
      const colNames = sheet.columns.map(c => c.name).join(', ')
      lines.push(`  - sheet \`${sheet.name}\` (${sheet.rowCount} 行, ${sheet.columns.length} 列)：${colNames}`)
    }
    return lines.join('\n')
  }
}
