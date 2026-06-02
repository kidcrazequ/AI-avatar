import fs from 'fs'
import path from 'path'
import { SkillManager } from './skill-manager'
import { DEFAULT_TOOL_POLICY, buildToolPolicyPromptHints } from './tool-budget'
import { combineSystemPromptSections } from './prompt-sections'
import { assertSafeSegment } from './utils/path-security'
import { DEFAULT_MAX_DIR_DEPTH } from './utils/common'
import { DEFAULT_AVATAR_PROJECT_ID } from './avatar-project'
import {
  STRUCTURED_MEMORY_FILENAME,
  parseStructuredMemoryDocumentJson,
  formatStructuredMemoryEntriesForPrompt,
  buildLongTermMemoryInjectionBody,
} from './structured-memory'
import {
  computeSalience,
  computeWallClockRecencyFactor,
} from './memory/salience'
import { readStandingOrders } from './memory/standing-orders'

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
  private projectRoot: string
  private skillManager: SkillManager

  constructor(avatarsPath: string) {
    this.avatarsPath = avatarsPath
    this.sharedPath = path.join(avatarsPath, '..', 'shared')
    this.projectRoot = path.join(avatarsPath, '..')
    this.skillManager = new SkillManager(avatarsPath)
  }

  /**
   * 抽取 markdown 文件里 `<!-- INHERIT_BEGIN: <tag> -->` 与 `<!-- INHERIT_END -->`
   * 之间的内容。文件不存在 / 没找到标记时返回空字符串（无害跳过）。
   *
   * 设计动机：avatars/<id>/CLAUDE.md 通过 inheritance 拼接来自项目级 CLAUDE.md
   * 和 templates/agent-template.md 的稳定规则段。模板文件里还有
   * 任务拆分规则、frontmatter 占位符、{{STEP_2_TITLE}} 这类对桌面端分身
   * 无用甚至有害的内容，所以不能整体塞，只取 INHERIT 块。
   */
  private extractInheritBlock(filePath: string, tag: string): string {
    const content = this.readFileSafe(filePath)
    if (!content) return ''
    const re = new RegExp(`<!--\\s*INHERIT_BEGIN:\\s*${tag}\\s*-->([\\s\\S]*?)<!--\\s*INHERIT_END\\s*-->`)
    const m = content.match(re)
    if (!m) return ''
    return m[1].trim()
  }

  /**
   * 读取所有需要继承的稳定规则段，按"通用 → 模板 → 分身"层次拼成一段 markdown。
   *
   * 拼接顺序（最通用在前）：
   * 1. 项目级 CLAUDE.md 的 `project-level-core-rules` 块（核心约束、数据溯源粒度强制）
   * 2. agent-template.md 的 `universal-anti-hallucination` 块（G1-G4 反幻觉强制工作流）
   *
   * 任一文件不存在或没有 INHERIT 标记时跳过该段，不报错。返回值放在分身
   * CLAUDE.md 之前，让分身专属规则覆盖更通用规则。
   */
  private loadInheritedRules(): string {
    const segments: string[] = []
    const projectLevel = this.extractInheritBlock(
      path.join(this.projectRoot, 'CLAUDE.md'),
      'project-level-core-rules',
    )
    if (projectLevel) {
      segments.push('<!-- 继承自 ~/AI/soul/CLAUDE.md：项目级核心约束 -->\n' + projectLevel)
    }
    const agentTemplate = this.extractInheritBlock(
      path.join(this.projectRoot, 'templates', 'agent-template.md'),
      'universal-anti-hallucination',
    )
    if (agentTemplate) {
      segments.push('<!-- 继承自 templates/agent-template.md：通用反幻觉强制工作流 -->\n' + agentTemplate)
    }
    return segments.join('\n\n---\n\n')
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

  /**
   * @param webEnabled 是否开启「联网功能」。来自设置 `web_search_enabled`。
   *   - true：在 toolsNote 中列出 web_search / web_fetch，并注入「新方案 / 实时信息融合答复指引」（3 维度判断触发）
   *   - false（默认）：不列联网工具；改注入「答复事实根基（联网未启用）」段，明确事实必须来自知识库 / Excel / 附件
   *   未传时按 false 处理。调用方（main.ts）从 settings 读 `web_search_enabled === 'true'` 传入。
   */
  loadAvatar(avatarId: string, projectId?: string, webEnabled: boolean = false): AvatarConfig {
    assertSafeSegment(avatarId, '分身ID')
    const resolvedProject =
      projectId && projectId.trim().length > 0 ? projectId.trim() : DEFAULT_AVATAR_PROJECT_ID
    if (resolvedProject !== DEFAULT_AVATAR_PROJECT_ID) {
      assertSafeSegment(resolvedProject, 'projectId')
    }
    const avatarPath = path.join(this.avatarsPath, avatarId)

    // 读取 CLAUDE.md（入口文件）
    const claudeMd = this.readFileSafe(path.join(avatarPath, 'CLAUDE.md'))

    // 读取 soul.md（人格定义）
    const soulMd = this.readFileSafe(path.join(avatarPath, 'soul.md'))

    // GAP2: 读取 memory/MEMORY.md（长期记忆）+ 可选结构化条目（MEMORY.entries.json）
    const memoryContent = this.readFileSafe(path.join(avatarPath, 'memory', 'MEMORY.md'))
    const structuredRaw = this.readFileSafe(path.join(avatarPath, 'memory', STRUCTURED_MEMORY_FILENAME))
    const structuredDoc = structuredRaw.trim() ? parseStructuredMemoryDocumentJson(structuredRaw) : null
    const structuredMarkdown =
      structuredDoc && structuredDoc.entries.length > 0
        ? formatStructuredMemoryEntriesForPrompt(structuredDoc.entries)
        : ''
    const longTermMemoryBody = buildLongTermMemoryInjectionBody(structuredMarkdown, memoryContent)

    // Feature 3: 读取 memory/USER.md（用户画像）
    const userProfileContent = this.readFileSafe(path.join(avatarPath, 'memory', 'USER.md'))

    // GAP10: 读取 shared/knowledge/ 目录（共享知识库）
    const sharedKnowledgeFiles = this.readDirectory(path.join(this.sharedPath, 'knowledge'))

    // Phase 5: 读取 life/consolidated.md（出厂人生记忆）
    // 文件不存在返回空字符串，loadAvatar 拼装时按空跳过——
    // 不论是分身没启用人生还是后台尚未生成完，都不应阻塞 system prompt 拼装。
    const lifeConsolidated = this.readFileSafe(path.join(avatarPath, 'life', 'consolidated.md'))

    // v17 Phase 2b: 读取对话情景记忆（"我和你的过去"）。
    // 同步读避免拼装链路异步化——每个分身 episode 数量预期 <50（被遗忘的不进 episodes/），
    // 单文件 <5KB，全部读完不阻塞。Phase 2c/2d 会引入 salience 排序 + 二段式注入控制 token。
    const conversationEpisodes = this.readConversationEpisodesSafe(avatarPath)

    // 递归读取 knowledge/ 目录下所有知识文件（含子目录如 imports/）注入 system prompt
    // 排除 projects/——历史版本 projects:create 曾把 README/notes 写到
    // knowledge/projects/<name>/ 下，会让 A 项目的 README 被所有会话当全局
    // 知识加载。projects/<name>/knowledge/ 才是 canonical 项目知识目录，由
    // mergeProjectKnowledgeMarkdown 按 conversation.project_id 精确叠加。
    const knowledgeRootFiles = this.readDirectory(path.join(avatarPath, 'knowledge'), 0, ['projects'])

    // GAP3: 通过 SkillManager 获取已启用技能内容（而非读取全部 skills/ 文件）
    // Feature 5: 渐进式披露——默认只注入摘要，AI 通过 load_skill 工具按需加载完整内容
    const skillsContent = this.skillManager.getSkillsSummary(avatarId)

    // GAP11: 工具调用能力说明（帮助 DeepSeek 等模型更好地使用 function calling）
    const toolsNote = [
      '## 可用工具',
      '',
      '你可以调用以下工具来辅助回答，请在需要查询具体数据时主动调用：',
      '',
      '- **search_knowledge(query)**: 在知识库中检索相关内容片段（BM25 + 向量混合召回），用于查找政策、电价、产品参数、项目案例、PDF/Word/Markdown/手写笔记等非结构化资料。结果会附 `[来源: knowledge/...#Lx-Ly]` 锚点，最终回答应尽量沿用。',
      '- **knowledge_grep(pattern, scope?, max_per_file?, max_total?)**: 在知识库 .md/.txt 文件里按正则**精确**搜索，返回 file+line+text。与 search_knowledge 互补——后者是模糊召回，grep 适合精确关键词（型号编号、政策条款号、专有名词）。**search_knowledge 召回不全时优先用 grep 兜底**，避免漏关键证据。',
      '- **knowledge_glob(pattern)**: 按 glob 模式（`**` / `*` / `?`）列出文件路径，如 `**/*电价*.md`。比 list_knowledge_files + LLM 过滤更精准。',
      '- **list_wiki_concepts(query?, top_n?)**: 列出 LLM 自动编译的**实体概念页**（wiki/concepts/）。**实体类查询必须传 query**（如 `query="ENS-L262"`）扫正文模糊匹配——某些分身概念页 name 字段是高频通用词（"明确"/"数值"/"图片"），不传 query 拿到的 name 列表无法识别实体；传 query 会扫正文返回 top_n 匹配项 + 200 字符预览。',
      '- **read_wiki_concept(name)**: 读取指定实体概念页全文，name 从 list_wiki_concepts 返回的 matches[i].name 里取。',
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
      // 联网工具仅在"联网功能"开启时才进入工具描述（同时 chatStore 也会过滤 tools 数组，双层保护）
      ...(webEnabled ? [
        '- **web_search(query, max_results?, search_depth?, topic?, include_answer?)**: 通过 Tavily 搜索外网（专为 LLM 设计，content 字段已去 HTML）。用于实时信息、最新政策 / 价格 / 新闻、知识库未覆盖的行业资料 / 竞品。需要用户在「设置 → 工具集成」配置 Tavily API Key；未配置时会返回明确错误，可提示用户去填。',
        '- **web_fetch(url, format?, max_chars?)**: 抓取指定 URL 的全文（HTML→Markdown / 文本 / JSON）。与 web_search 互补：先用 web_search 找到候选 URL，再用 web_fetch 抓全文细读；用户直接给出 URL 时也走此工具。若启用了 lazy-store（默认关，env `SOUL_TOOL_LAZY_RETRIEVAL=on`），长输出（≥ 4000 字符）的 body 会被替换为 `body_lazy_ref`，正文用 `read_tool_ref` 取。',
        '- **read_tool_ref(call_id, offset?, limit?)**: 当 web_fetch 返回里出现 `body_lazy_ref: { call_id, char_count, ... }` 时调此工具取真正的 body 正文。单次最多 8000 字符，需要更多用 offset 分页。元数据（url/status/char_count）已在 prompt 可见，仅需正文时才调用。',
      ] : []),
      '- **calculate_roi(...)**: 计算储能项目的峰谷套利收益、IRR 和回收期',
      '- **load_skill(skill_id)**: 按需加载指定技能的完整执行步骤。通常相关技能已由系统自动注入，只有在系统未注入、且确实需要完整流程时再调用。',
      '- **read_user_file(path, offset?, limit?)**: 读用户授权根目录下任意 absolute path 的文件（2026-05-22 Marvis File Agent 借鉴）。与 `read_file` 区别：后者只能读 avatar workspace 内，本工具能读用户在「设置 → 用户文件根」显式授权的更广目录（如 `~/Documents/项目报告`）。默认关闭——未授权时直接返错，需用户在设置里添加根路径才生效。',
      '- **list_user_folder(path)**: 列出用户授权根目录下任意 absolute path 的目录内容。权限模型同 `read_user_file`。',
      '- **delegate_task(task, expected_output?, target_avatar?, agent_type?)**: 将独立子任务委派给子代理并行执行，子代理使用相同的知识库但独立对话上下文。`agent_type` 可选 `\'verifier\'`——派一个复核子代理检查另一个子代理（通常是 worker）刚给出的数字 / 来源 / 引用是否真的能在原始 sheet / knowledge 文件里找到（2026-05-22 MiniMax Mavis Leader/Worker/Verifier 借鉴）。',
      '',
      '  **何时主动派 verifier（自动 fan-out）**：以下任一条件命中，且你即将或刚刚产出涉及具体数字 / 跨源数据 / 关键来源标注的答复时，应在主答复之后主动调一次 `delegate_task({ task: \'复核刚刚答复中的数字与来源\', agent_type: \'verifier\' })`：',
      '  - 用户问的是「多少 / 几个 / 占比 / 通过率 / 不良率 / 出货量 / 具体数字 / 准确数据」',
      '  - 用户要求「标到原始 sheet」「来源 / 出处 / 引用」「按文件路径列引用」',
      '  - 跨多个 Excel / knowledge 文件做对比、汇总',
      '  - 你已经动用了 `query_excel` 或 `web_search` 拿到数字数据',
      '  Verifier 自己读原始 sheet / knowledge 文件比对你给的数字、检查 markdown 二手总结有没有冒充 sheet。它返回 ✅ 通过 / ❌ 不通过+缺口清单。**verifier 不通过时，必须在你的主答复后补一段更正与诚实声明，不要硬撑原答复。**',
      '',
      '**调用原则**：当用户询问具体项目数据、特定省份政策、产品规格对比、收益计算时，应主动调用工具获取准确信息。涉及 Excel 表格数据必须用 `query_excel`，不要用 `search_knowledge` 模糊匹配表格。涉及技能时优先使用系统已注入的技能内容，不要把 `load_skill` 当成默认第一步。',
      '',
      // 联网开 / 关 两套指引互斥注入：开则给"3 维度融合答复"，关则给"知识库优先 + 禁联网"
      ...(webEnabled ? [
        '**新方案 / 实时信息融合答复指引（联网功能已开启）**：满足以下任一条件时可调 `web_search` 联网补全；不要靠关键词匹配，按意图判断：',
        '- (a) **时效性**：问题涉及"当前 / 最新 / 最近 / 今年 / 近期"或具体年月，知识库的内容可能已过时',
        '- (b) **知识库缺位**：`search_knowledge` 已调过但返回为空 / 证据弱 / 不覆盖问题核心',
        '- (c) **外部参照**：用户明确要"业界做法 / 竞品 / 行业标准 / 同类项目 / 行业里大家怎么做"',
        '',
        '执行顺序：',
        '1. **先查内**：调 `search_knowledge`（必要时配 `read_knowledge_file`）确认知识库里有没有现成方案 / 历史案例；涉及表格数值同时调 `query_excel`。',
        '2. **再查外（按需）**：满足上面 (a)(b)(c) 任一条件时调 `web_search` 拿候选；想深读某个来源用 `web_fetch` 抓全文。无 Tavily Key 时直接告知用户去「设置 → 工具集成」配置，不要硬编。',
        '3. **统一答复**：把多源融合后用**你自己的视角**写完整答复，禁止堆贴搜索结果——',
        '   - 事实根基：以**知识库 / `query_excel`** 返回内容为权威，外网信息只在知识库缺位或需要时效补全时引用；冲突时以知识库为准并显式说明分歧。',
        '   - 语气与判断角度：从 **soul.md（人格）+ 我的人生（出厂记忆）** 长出来，沿用你一贯的隐喻、价值偏好、专业取舍，而不是中性百科口吻。',
        '   - 缺口诚实：四源都查不到的部分明说"目前没有可靠依据，建议下一步…"，禁止凑数。',
        '',
        '**联网引用铁律（强制 · 违反任一条 = 严重失败）**：',
        '',
        '凡是来自 `web_search` / `web_fetch` 的事实（数字、价格、政策、日期、案例、统计），来源标注必须挂**可点击的具体 URL + 访问日期**。允许的格式：',
        '- ✅ `[来源: https://fgw.sh.gov.cn/xxx/policy.html · 访问 2026-05-18 · web_search]`',
        '- ✅ `[来源: https://www.sheitc.sh.gov.cn/cmsres/.../99422....pdf · 访问 2026-05-18 · web_fetch]`',
        '',
        '一律视为**伪造**的错误格式（哪怕事实是真的也算违规）：',
        '- ❌ `[来源: 国网上海电力公司电价表]` —— 描述性机构，用户无法核实',
        '- ❌ `[来源: 上海发改委公告]` / `[来源: 国家发改委 2024 年文件]` —— 同上',
        '- ❌ `[来源: 一般工商业用户电价表（执行时间 2024年6月）]` —— 像引用却没 URL，最具迷惑性',
        '- ❌ 完全不标来源直接给数字 —— 等同于编造',
        '',
        'URL 从哪里取：',
        '- `web_search` 返回的 JSON 里 `results[]` 数组每条都有 `url` 字段，直接复制',
        '- `web_fetch` 返回的 JSON 里 `url` 字段就是你刚抓的 URL',
        '- 访问日期 = 今天（system 已在上下文里注入 currentDate）',
        '',
        '**输出每条联网事实前必须默念的自检**：',
        '> "我刚写的这个数字 / 这句话，是哪一次 web_search 或 web_fetch 返回的？对应的 url 字符串完整粘贴出来了吗？如果我没法在本轮工具响应里找到这个 url，这条事实就是我自己编的——必须立刻删掉，或显式标注「未经联网核实」。"',
        '',
        '知识库 / Excel 引用规则不变：`[来源: knowledge/文件路径#Lx-Ly]` / `source_anchor`。',
        '',
        '**联网搜索摘要（强制 · 当本轮调用了 web_search 或 web_fetch 时）**：',
        '',
        '回答正文必须以 `## 联网搜索摘要` 子章节开头（在结论 / 分析之前），列出：',
        '- **本次 query**：实际调用的搜索关键词，每条一行（让用户验证你搜了什么）',
        '- **主要命中**：每条带 URL + 1 句话总结 web_search 返回的核心内容；想深读哪条用了 web_fetch 单独列出',
        '- **明确未命中**：用一句话写"以下方面搜索未返回具体数据：...，下面的判断为基于知识库 / 行业框架的推断"',
        '',
        '示例：',
        '```',
        '## 联网搜索摘要',
        '- query: "上海 分时电价 峰谷 2025 2026 最新调整" → 命中: https://fgw.sh.gov.cn/... (2024 年 6 月一般工商业用户电价表) · https://www.sheitc.sh.gov.cn/... (2024 年代理购电 PDF)',
        '- query: "上海 尖峰电价 时段 2025 2026" → 命中: https://... (峰平段电价 0.83 元/kWh)',
        '- **未命中**：2025 年下半年 - 2026 年上海新版分时电价文件未抓到，下面 2025/2026 段的判断为基于 2024 年文件 + 行业趋势的推断（已标注为"推断"）',
        '```',
        '',
        '不写 query 列表 = 用户无法验证你是否真的搜过、搜了什么；这是分身专家的可信度根基，**禁止省略**。',
        '',
        '**关于"预测 / 推断 / 分析"的特别约束（堵漏）**：',
        '',
        '出现 "我预期 / 预计 / 推测 / 估计 / 趋势是 / 大概会 / 预计将" 等推断性语句配具体数字（如"2026 年 0.58 元/Wh"）时，**必须在同句标注推断基础**：',
        '- ✅ 正确：「基于 ENS-L262 评审材料指出的"原方案套利空间已缩水至 0.65 元"[来源: knowledge/ENS-L262评审决策.pptx#L42] + 上海发改委 2024 文件指示的峰谷比收窄 [来源: https://fgw.sh.gov.cn/... · 访问 2026-05-18 · web_search]，我预计 2027 年订单价 ≈ 0.53 元/Wh」',
        '- ❌ 错误：「2025 年 0.65 → 2026 年 0.58 → 2027 年 0.53 元/Wh」—— 推断链断了，等同编造',
        '- ❌ 错误：「行业趋势是 X」「整个行业都在压缩成本」「多省份在拉平峰谷时段」—— 无任何引用 = 编造',
        '',
        '**核心原则**：分身的判断必须**长在引用之上**。"作为专家的我认为"不是引用——专家的认为也得有依据。无依据的推断 = 编造，违反知识库铁律。',
      ] : [
        '**答复事实根基（联网功能未开启，强制约束）**：当前用户未在「设置 → 工具集成」开启联网功能，因此你**没有 web_search / web_fetch 工具可用**。所有事实、数据、政策、案例、行业动向必须仅来自：',
        '1. **知识库**：`search_knowledge` / `read_knowledge_file` / `query_excel`（结构化表格走 query_excel）',
        '2. **soul.md 人格 + 我的人生（出厂记忆）**：塑造语气、价值判断、隐喻和专业取舍角度',
        '3. **当前会话上下文**：用户消息、附件、引用片段、对话历史里 `[来源: ...]` 锚点',
        '',
        '**禁止行为**（违反任一条 = 严重失败）：',
        '- 禁止编造任何"行业惯例 / 业界通常 / 最新政策 / 据报道"等无知识库出处的事实陈述',
        '- 禁止从训练数据里推断时效性内容（"截至 2024 年..."、"目前主流厂家..."）——你不知道现在是哪年',
        '- 禁止假装做过外网检索（不许出现"经查询..."、"搜了一下..."这类幻觉描述）',
        '',
        '**遇到下列场景时的应对**：',
        '- 用户问"新方案 / 最新 X / 行业里大家怎么做" → 先 `search_knowledge` 看知识库有没有相关方案；若没有，**诚实说明**："知识库里目前没有这方面的资料。如需补充行业最新动向，可在「设置 → 工具集成」开启联网功能并配置 Tavily API Key，我就能联网检索。"',
        '- 用户问时效性强的事实（具体年月数据、最新政策） → 同上，引导用户开启联网或上传最新资料到知识库',
        '- 用户上传了附件 / 截图 → 优先用 `read_attachment` / `search_attachment` 读取，把附件视为本轮的临时知识源',
      ]),
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
    // 继承的通用规则放在分身 CLAUDE.md 之前——通用 baseline 先建立，分身专属规则在后做 specialization。
    // 不存在 INHERIT 标记时 inheritedRules 返回空，不污染 prompt。
    const inheritedRules = this.loadInheritedRules()
    if (inheritedRules) {
      stableParts.push(inheritedRules, '\n\n---\n\n')
    }
    stableParts.push(claudeMd, '\n\n---\n\n', soulMd)

    // v18 Standing Orders（OpenClaw 借鉴）：紧挨 soul.md 注入「永久规则」段。
    // 由 LLM 在对话中通过 [STANDING_ORDER] tag 或 add_standing_order 工具写入；
    // 优先级介于 HARD_RULES（红线）与 MEMORY.md（偏好）之间。
    const standingOrdersContent = readStandingOrders(this.avatarsPath, avatarId)
    if (standingOrdersContent.trim()) {
      stableParts.push('\n\n---\n\n')
      stableParts.push(standingOrdersContent.trim())
      stableParts.push('\n\n> 上述 standing orders 是用户在过往对话中明确表达的长期工作流约定，必须始终遵守。如认为某条规则与当前任务冲突，先按规则执行 + 用 [UNCERTAIN] 提示用户，而不是自行忽略。')
    }

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
    //   - 显式标记 prompt_excluded: true（旧名 rag_only，仍兼容）的文件 → 同上，不塞 prompt
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
        // 批量导入产物带 source / source_type 字段（摄取脚本写的是 source_type +
        // source_path + ingested），运行时当 prompt_excluded 处理，不塞 system prompt，
        // 保留通过工具按需检索的能力。prompt_excluded 是新规范字段，rag_only 是旧别名（向后兼容）。
        if (fm.prompt_excluded === true || fm.rag_only === true || fm.source || fm.source_type) {
          ragOnlyEntries.push({ relPath, meta: fm })
        } else {
          stuffEntries.push({ relPath, body })
        }
      }

      // 硬预算：预算内的文件全文塞进 prompt，超预算的降级为「可检索」索引项。
      // 这是防止「批量导入漏盖 rag_only/source frontmatter → 全文灌进 system
      // prompt（曾达 4 亿字符）→ 主进程拼接巨型字符串阻塞事件循环」的安全下限。
      // 按 body 升序优先塞小文件（通常是手写索引），最大化预算内的文件覆盖数。
      const totalStuffChars = stuffEntries.reduce((sum, e) => sum + e.body.length, 0)
      const sortedStuff = [...stuffEntries].sort((a, b) => a.body.length - b.body.length)
      const promptStuff: typeof stuffEntries = []
      const demotedStuff: typeof stuffEntries = []
      let usedChars = 0
      for (const e of sortedStuff) {
        if (usedChars + e.body.length <= SoulLoader.STUFF_PROMPT_BUDGET_CHARS) {
          promptStuff.push(e)
          usedChars += e.body.length
        } else {
          demotedStuff.push(e)
        }
      }
      if (demotedStuff.length > 0) {
        console.warn(`[SoulLoader] 知识库 stuff 总字符数 ${totalStuffChars} 超过预算 ${SoulLoader.STUFF_PROMPT_BUDGET_CHARS}，已将 ${demotedStuff.length} 个文件降级为「可检索」（不进 system prompt，仍可被 search_knowledge / read_knowledge_file 按需访问）。建议为批量导入文档补 prompt_excluded: true 或 source frontmatter。`)
      }

      if (promptStuff.length > 0) {
        stableParts.push('\n\n---\n\n# 知识库\n\n')
        promptStuff.forEach(e => {
          stableParts.push(`<!-- 文件: knowledge/${e.relPath} -->\n${e.body}\n\n`)
        })
      }

      // RAG-only 文件索引：小库逐个列路径；大库（如小凯 1885 文件）只按顶层领域归并，
      // 避免上千路径整块灌进 system prompt（曾占 ~5.5 万 token，拖慢每次请求的首 token）。
      // agentic 方向：分身知道覆盖哪些领域 + 用工具下钻即可，不需要预先看到全部文件名。
      if (ragOnlyEntries.length > 0 || demotedStuff.length > 0) {
        const indexEntries = [
          ...ragOnlyEntries.map(e => ({
            relPath: e.relPath,
            source: typeof e.meta.source === 'string' ? e.meta.source
              : typeof e.meta.source_type === 'string' ? e.meta.source_type
              : 'document',
          })),
          ...demotedStuff.map(e => ({ relPath: e.relPath, source: '超预算降级' })),
        ]
        const { lines, summarized } = this.buildKnowledgeIndexLines(indexEntries, 'knowledge/')
        if (summarized) {
          stableParts.push('\n\n---\n\n# 知识库（用工具按需检索，不在 system prompt 正文中）\n\n')
          stableParts.push(`覆盖领域（共 ${indexEntries.length} 个可检索文件）：\n`)
          lines.forEach(l => stableParts.push(l))
          stableParts.push('\n专业问题先检索再作答（不要凭空回答）：`search_knowledge`（语义召回）/ `knowledge_grep`（按关键词搜路径或内容，可加 scope 限定目录）/ `knowledge_glob`（按文件名模式）/ `list_knowledge_files` / `read_knowledge_file`（读全文）。\n')
        } else {
          stableParts.push('\n\n---\n\n# 可检索知识（不在 system prompt 中，通过工具按需访问）\n\n')
          lines.forEach(l => stableParts.push(l))
        }
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

    // 可选：projects/<projectId>/knowledge（与分身全局知识合并注入，不写 Excel schema）
    if (resolvedProject !== DEFAULT_AVATAR_PROJECT_ID) {
      this.mergeProjectKnowledgeMarkdown(stableParts, avatarPath, resolvedProject)
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

    // v17 Phase 2b/2d：注入「我和你的过去」（对话情景记忆，salience 排序）。
    //
    // 默认模式（flat）：取 salience > 0 的前 5 条，每条 title + theme 一行。
    // SOUL_TWO_TIER_INJECTION=true 时切到二段式：
    //   - 当前焦点（top 3，渲染 title + theme + summary 截断）
    //   - 长期仓库（剩余条目压缩到 1 行只剩 title，给 LLM 知道还有什么可 recall）
    //
    // 设计原则：完整 summary / keyQuotes 永远不进 system prompt，由 recall_conversation 工具按需取。
    // forgotten 状态在 readConversationEpisodesSafe 已剔除，到这里都是 remembered/blurred。
    const twoTierEnabled = (process.env.SOUL_TWO_TIER_INJECTION ?? '').toLowerCase() === 'true'
    const significantEpisodes = conversationEpisodes.filter((e) => e.salience > 0)
    if (significantEpisodes.length > 0) {
      stableParts.push('\n\n---\n\n# 我和你的过去\n\n')
      stableParts.push('以下是你和当前用户过去对话里值得记得的内容（按 salience = 重要性 × 情感 × 时间近因 排序）。被问起"上次/之前/那次聊过"时，调用 `recall_conversation({query})` 取该条完整 summary + key_quotes。\n\n')
      if (twoTierEnabled) {
        const focusN = 3
        const focus = significantEpisodes.slice(0, focusN)
        const storage = significantEpisodes.slice(focusN)
        stableParts.push('## 当前焦点（高 salience，可直接引用）\n\n')
        for (const ep of focus) {
          const themeFragment = ep.theme.trim() ? ` — ${ep.theme.trim()}` : ''
          const summaryClip = ep.summary.length > 200 ? ep.summary.slice(0, 200) + '…' : ep.summary
          stableParts.push(`- **${ep.title}**${themeFragment}（importance=${ep.importance}, valence=${ep.valence}, salience=${ep.salience.toFixed(2)}）\n`)
          stableParts.push(`  - ${summaryClip}\n`)
        }
        if (storage.length > 0) {
          stableParts.push('\n## 长期仓库（次级 salience，按需用 recall_conversation 取细节）\n\n')
          for (const ep of storage) {
            stableParts.push(`- ${ep.title}（salience=${ep.salience.toFixed(2)}）\n`)
          }
        }
      } else {
        // 旧 flat 注入：保留为默认，等到 SOUL_TWO_TIER_INJECTION 验证稳定后翻默认
        const top = significantEpisodes.slice(0, 5)
        for (const ep of top) {
          const themeFragment = ep.theme.trim() ? ` — ${ep.theme.trim()}` : ''
          stableParts.push(`- **${ep.title}**${themeFragment}（importance=${ep.importance}, valence=${ep.valence}, salience=${ep.salience.toFixed(2)}）\n`)
        }
      }
      stableParts.push('\n## 对话回忆使用守则\n\n')
      stableParts.push([
        '1. **不主动展开过去对话**：除非用户问起"之前我们聊过什么 / 上次说的 X"，否则不要在日常回答里主动引用过去会话——避免"上次我说过..."这种喧宾夺主。',
        '2. **被问起时调工具**：调 `recall_conversation({query: "用户提到的关键词"})` 取最匹配的 1-3 条 episode 的 summary + key_quotes 再展开。',
        '3. **承认遗忘**：如果工具没返回相关 episode，直接说"这个我记不太清了"——不要编造从未发生的对话。',
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
    if (longTermMemoryBody.trim()) {
      dynamicParts.push('\n\n---\n\n# 长期记忆\n\n')
      dynamicParts.push(longTermMemoryBody)
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
      '5. **段落标题与排版**：用 markdown heading（`##` / `###`）或 `**加粗**` 作为段落前缀，不要用装饰性 emoji 当章节标题（如 `📊 十五五规划` / `🎯 对你意味着什么`）。状态对照、严重程度、增减趋势确实需要时可用 ⚠️✅❌ 或 🔴🟢🔵🟡 这类**有语义**的标记，桌面端会自动渲染为项目风格 inline icon；但**不要堆叠**装饰 emoji（🌟🚀🎯📊 等连用）让回答显得花哨。',
      '6. **文件类型与引用优先级**（PAP 借鉴，2026-05-18 加入；wiki 路径 2026-05-18 加强）：',
      '   - **实体类查询**（"X 是什么 / X 的参数 / X 出现在哪些文件"，X 是设备型号 / 标准 / 概念名）→ **优先**调 `list_wiki_concepts(query="X")` 用关键词模糊匹配（**必须传 query**，否则无法识别实体）→ 拿 matches[].name → `read_wiki_concept(name)` 读完整聚合页。比 search_knowledge 拼多个 chunk **省 token 且更准**。匹配为空时再降级 search_knowledge。',
      '   - **数字 / 规则 / 政策 / 参数 / 标准条款** → 从 `knowledge/*.md` 原文 + `query_excel` 表取（事实根基，必须有可点击 `[来源: ...]` 锚点）。wiki 概念页里的数字仅作导航，**精确数值必须回查原文 / Excel**。',
      '   - **图像识别 / Vision-caption 文字**（OCR 段落、图片字幕）→ **只看意图，禁止取作精确数字**——OCR 的"5%"可能是"5.0%"或"50%"；精确数字回查 `query_excel` 表或重新读原图工具。',
      '   - **跨章节关系 / 背景 / 决策语境 / 历史方案对比** → `wiki/concepts/`（实体聚合）+ `memory/MEMORY.md` 长期记忆 + 对话情景（recall_conversation）。这些是"为什么这样设计 / 这个概念怎么关联其他"，不是"具体数字是多少"。',
      '7. **search_knowledge 召回不全的兜底**：当用户问题涉及精确关键词（型号编号 / 政策条款号 / 专有名词，如 `262KWh` / `ENS-L262` / `第 8.3 条`），且 `search_knowledge` 返回的证据感觉**不全 / 弱 / 偏离重点**时，**主动改用 `knowledge_grep(pattern=关键词)` 精确搜索**作为兜底——不要直接说"知识库未收录"。grep 比模糊召回精度高得多。',
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

  /**
   * 叠加 `avatars/<id>/projects/<projectId>/knowledge` 下的 .md（与分身 knowledge 同策略）。
   * 不包含 _excel schema 清单（仍以分身根 knowledge 为准）。
   */
  private mergeProjectKnowledgeMarkdown(stableParts: string[], avatarPath: string, projectId: string): void {
    const knowledgeBase = path.join(avatarPath, 'projects', projectId, 'knowledge')
    if (!fs.existsSync(knowledgeBase)) return

    const knowledgeRootFiles = this.readDirectory(knowledgeBase)
    if (knowledgeRootFiles.length === 0) return

    const stuffEntries: Array<{ relPath: string; body: string }> = []
    const ragOnlyEntries: Array<{ relPath: string; meta: Record<string, unknown> }> = []

    for (const f of knowledgeRootFiles) {
      const relPath = path.relative(knowledgeBase, f.path)
      const { data: fm, body } = parseFrontmatter(f.content)
      if (fm.prompt_excluded === true || fm.rag_only === true || fm.source || fm.source_type) {
        ragOnlyEntries.push({ relPath, meta: fm })
      } else {
        stuffEntries.push({ relPath, body })
      }
    }

    if (stuffEntries.length > 0) {
      stableParts.push(`\n\n---\n\n# 项目知识（${projectId}）\n\n`)
      stuffEntries.forEach(e => {
        stableParts.push(`<!-- 文件: projects/${projectId}/knowledge/${e.relPath} -->\n${e.body}\n\n`)
      })
    }
    if (ragOnlyEntries.length > 0) {
      const indexEntries = ragOnlyEntries.map(e => ({
        relPath: e.relPath,
        source: typeof e.meta.source === 'string' ? e.meta.source
          : typeof e.meta.source_type === 'string' ? e.meta.source_type
          : 'document',
      }))
      const { lines, summarized } = this.buildKnowledgeIndexLines(indexEntries, `projects/${projectId}/knowledge/`)
      stableParts.push(`\n\n---\n\n# 项目可检索文档（${projectId}）\n\n`)
      if (summarized) stableParts.push(`覆盖领域（共 ${indexEntries.length} 个文件，用 search_knowledge / knowledge_grep 按需检索）：\n`)
      lines.forEach(l => stableParts.push(l))
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

  /**
   * v17 Phase 2b：同步读取 avatars/<id>/memory/episodes/*.json。
   * v17 Phase 2c/2d：用 salience 评分排序（importance + |valence| 加权 + wall-clock 半衰期衰减），
   *                  把"新且重要"的 episode 排在前面——比纯 importance 排序更像人脑的"想到什么"。
   *
   * 同步而非异步——soul-loader 整条拼装链路是同步的，引入 async 会污染所有调用点。
   * 单分身 episode 数预期 <50、单文件 <5KB，全部 readSync 完全可接受。
   * 损坏 / 不是合法 JSON 的文件被跳过（仅 console.warn），不阻塞整体注入。
   *
   * 返回的数组按 salience desc 排序，附带 score 便于注入侧调试 / 阈值过滤。
   * Forgotten 状态在此就被剔除（salience=0），不进列表。
   */
  private readConversationEpisodesSafe(avatarPath: string): Array<{
    title: string
    theme: string
    summary: string
    keyQuotes: string[]
    valence: number
    importance: number
    conversationLastMessageAt: number
    consolidationStatus: 'remembered' | 'blurred'
    /** v17 Phase 2c：salience 综合得分，调用方直接拿来排序/阈值过滤 */
    salience: number
  }> {
    const dir = path.join(avatarPath, 'memory', 'episodes')
    let entries: string[]
    try {
      entries = fs.readdirSync(dir)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn(`[SoulLoader] readConversationEpisodesSafe readdir 失败 (${dir}):`, err instanceof Error ? err.message : String(err))
      }
      return []
    }
    const out: ReturnType<typeof this.readConversationEpisodesSafe> = []
    for (const name of entries) {
      if (!name.endsWith('.json')) continue
      try {
        const raw = fs.readFileSync(path.join(dir, name), 'utf-8')
        const obj = JSON.parse(raw)
        if (
          !obj || typeof obj !== 'object'
          || typeof obj.title !== 'string'
          || typeof obj.summary !== 'string'
        ) continue
        const importance = typeof obj.importance === 'number' ? obj.importance : 3
        const valence = typeof obj.valence === 'number' ? obj.valence : 0
        const lastMessageAt = typeof obj.conversationLastMessageAt === 'number' ? obj.conversationLastMessageAt : 0
        const rawStatus = obj.consolidationStatus
        const status: 'remembered' | 'blurred' | 'forgotten' =
          rawStatus === 'forgotten' || rawStatus === 'blurred' ? rawStatus : 'remembered'
        if (status === 'forgotten') continue // 直接跳过，不进列表

        const score = computeSalience({
          importance,
          emotionMagnitude: Math.abs(valence),
          recencyFactor: computeWallClockRecencyFactor(lastMessageAt),
          status,
        })
        out.push({
          title: obj.title,
          theme: typeof obj.theme === 'string' ? obj.theme : '',
          summary: obj.summary,
          keyQuotes: Array.isArray(obj.keyQuotes) ? obj.keyQuotes.filter((x: unknown) => typeof x === 'string') : [],
          valence,
          importance,
          conversationLastMessageAt: lastMessageAt,
          consolidationStatus: status,
          salience: score,
        })
      } catch (err) {
        console.warn(`[SoulLoader] 解析 episode 失败 (${name}):`, err instanceof Error ? err.message : String(err))
      }
    }
    out.sort((a, b) => b.salience - a.salience)
    return out
  }

  /** 知识目录最大递归深度（使用共享常量，与其他模块保持一致） */
  private static readonly MAX_DIR_DEPTH = DEFAULT_MAX_DIR_DEPTH

  /**
   * 单个 stuff 文件（无 rag_only/source frontmatter）允许读全文塞进 prompt 的字节上限。
   * 超过此值的文件几乎必是批量导入产物（OCR/转换文档），漏盖 frontmatter，
   * 不应读全文（数 MB body 会阻塞主进程），按可检索处理。手写知识文件不会这么大。
   */
  private static readonly MAX_STUFF_FILE_BYTES = 512 * 1024

  /** 知识库全文进 system prompt 的总字符预算（见 loadAvatar 的硬预算说明） */
  private static readonly STUFF_PROMPT_BUDGET_CHARS = 120_000

  /**
   * 「可检索知识」索引的逐文件列出上限：文件数 ≤ 此值时逐个列路径（小库精确文件名更有用）；
   * 超过则只按顶层目录归并成领域摘要，避免上千路径撑爆 system prompt。
   */
  private static readonly KNOWLEDGE_INDEX_PER_FILE_LIMIT = 40

  /**
   * 构建「可检索知识」段落的条目行。
   * - entries ≤ 阈值：逐个 `- \`<prefix><relPath>\`（source）`。
   * - entries > 阈值：只按 relPath 顶层目录归并 + 计数，返回 `- 领域（~N 个文件）`，
   *   不列文件路径（agentic：分身知道覆盖哪些领域，用工具按需下钻即可）。
   * summarized 标记供调用方决定段落抬头与工具指引文案。
   */
  private buildKnowledgeIndexLines(
    entries: Array<{ relPath: string; source: string }>,
    pathPrefix: string,
  ): { lines: string[]; summarized: boolean } {
    if (entries.length <= SoulLoader.KNOWLEDGE_INDEX_PER_FILE_LIMIT) {
      return {
        summarized: false,
        lines: entries.map(e => `- \`${pathPrefix}${e.relPath}\`（${e.source}）\n`),
      }
    }
    const counts = new Map<string, number>()
    for (const e of entries) {
      const top = e.relPath.split('/')[0] || '(根目录)'
      counts.set(top, (counts.get(top) || 0) + 1)
    }
    const lines = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([domain, count]) => `- ${domain}（~${count} 个文件）\n`)
    return { summarized: true, lines }
  }

  /**
   * 递归读取目录下所有 .md 文件。
   *
   * 优化：rag_only 文件（批量导入产物）只读取 frontmatter 头部（~512 字节），
   * 跳过可能数 MB 的 body。loadAvatar 不需要 rag_only 文件的 body——只用
   * frontmatter 里的 source 字段生成索引条目。500+ 文件场景下从读取全量内容
   * （10+ 秒阻塞）降到只读头部（< 1 秒）。
   */
  /**
   * @param skipTopLevelDirs 仅在 depth === 0 时排除的顶层目录名（按 entry.name 比对）。
   *   全局 knowledge/ 扫描时传 ['projects'] 把项目目录隔离开。
   */
  private readDirectory(
    dirPath: string,
    depth = 0,
    skipTopLevelDirs: readonly string[] = [],
  ): Array<{ path: string; content: string }> {
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
          if (depth === 0 && skipTopLevelDirs.includes(entry.name)) continue
          files.push(...this.readDirectory(fullPath, depth + 1))
        } else if (entry.isFile() && entry.name.endsWith('.md')) {
          // 先只读头部 512 字节探测 rag_only frontmatter
          const header = this.readFileHeader(fullPath, 512)
          if (header !== null && this.isRagOnly(header)) {
            // rag_only 文件：只保留 frontmatter，loadAvatar 不需要 body
            files.push({ path: fullPath, content: header })
          } else if (this.fileSizeSafe(fullPath) > SoulLoader.MAX_STUFF_FILE_BYTES) {
            // 防御：超大且无 rag_only frontmatter 的文件（批量导入漏盖 frontmatter）。
            // 不读全文（避免数 MB body 阻塞主进程），合成 rag_only 标记让 loadAvatar
            // 把它路由到「可检索」索引而非塞进 system prompt。
            console.warn(`[SoulLoader] 知识文件超过 ${SoulLoader.MAX_STUFF_FILE_BYTES} 字节且无 rag_only frontmatter，按可检索处理: ${fullPath}`)
            files.push({ path: fullPath, content: '---\nprompt_excluded: true\nsource: oversized\n---\n' })
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

  /** 安全获取文件字节大小，出错（不存在/权限）返回 0 */
  private fileSizeSafe(filePath: string): number {
    try {
      return fs.statSync(filePath).size
    } catch {
      return 0
    }
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

  /**
   * 快速判断文件头部 frontmatter 是否让此文件不进 system prompt 正文。
   *
   * 必须和 loadAvatar 的分流条件（`fm.rag_only === true || fm.source || fm.source_type`）
   * 严格对齐——否则 fast-path 会把"按 source/source_type 排除"的导入文件按非 rag_only
   * 当全文读取，浪费 IO 又把 body 透到下游再丢，违背 rag_only fast-path 的初衷。
   *
   * 同 loadAvatar 的注释：任何带 source / source_type 字段的知识文件（pdf/word/excel/
   * pptx/enhanced 等）运行时都按 rag_only 处理，不塞 system prompt，保留 search_knowledge
   * 按需检索能力。
   */
  private isRagOnly(header: string): boolean {
    if (!header.startsWith('---\n') && !header.startsWith('---\r\n')) return false
    const endIdx = header.indexOf('\n---\n')
    const endIdx2 = header.indexOf('\n---\r\n')
    const end = endIdx >= 0 ? endIdx : endIdx2
    if (end < 0) return false
    const fm = header.slice(0, end)
    if (/\b(?:prompt_excluded|rag_only)\s*:\s*true\b/.test(fm)) return true
    // source 或 source_type 字段存在（非空值）即按 rag_only 处理。
    // 批量摄取脚本写的是 source_type（+ source_path / ingested），早期只认 source
    // 导致这些导入产物被当全文塞进 prompt——两个字段都要识别。
    return /^\s*source(_type)?\s*:\s*\S/m.test(fm)
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
