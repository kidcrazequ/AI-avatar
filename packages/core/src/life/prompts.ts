/**
 * 「人生经历」生成器的 Prompt 模板集中管理。
 *
 * 4 个 Stage 各对应一组 (system, user) Prompt：
 *   - Stage 0：buildManifestPrompt        → 生成 manifest.json（plan 6.1）
 *   - Stage 1：buildOutlinePrompt         → 单年龄段事件大纲（plan 2.1 Stage 1）
 *   - Stage 2：buildEpisodePrompt         → 单事件 2-5K 字传记正文（plan 6.2）
 *   - Stage 3b：buildConsolidatedPrompt   → 第一人称「我记得的人生」（plan 6.3）
 *
 * 所有 system prompt 强约束 LLM 输出格式（JSON / 纯文本），避免 generator
 * 解析阶段误吞 markdown 包装。所有 user prompt 都接受 plain object，便于
 * 测试时从 fixture 直接构造，不依赖文件 IO。
 *
 * @author zhi.qu
 * @date 2026-05-09
 */

import type { LifeArcItem, LifeManifest, LifeTimelineEntry } from './types'

// ─── Stage 0：manifest 生成 ─────────────────────────────────────────────────

/** Stage 0 入参：用户在创建向导里确认过的人生骨架参数 */
export interface BuildManifestPromptOptions {
  /** 分身展示名（如「设计大师」），来自 avatar.config.json */
  avatarName: string
  /** 用户已确认的人生经历使用名；未确认时等于 avatarName */
  personaName: string
  /** personaName 是否由用户显式确认 */
  personaNameConfirmed: boolean
  /** avatar.txt 内容（一句话简介，可空） */
  avatarBrief: string
  /** soul.md 内容节选（前 ~1500 字，避免 prompt 过长） */
  soulExcerpt: string
  /** 用户指定的当前年龄（plan 中 18-80） */
  currentAge: number
  /** 当前年份（用 localDateString 解析，确保本地时区） */
  currentYear: number
  /** 创建分身的真实时间锚点（ISO，写入 manifest.initialAgeBornAt） */
  initialAgeBornAt: string
  /** 用户在向导第 5 步填的额外要求（可空） */
  userHint: string
  /** v1 完整实现里用户在向导选的 timeScale（1/12/52/0） */
  timeScale: number
}

/**
 * Stage 0 system prompt：固定身份 + 严格 JSON 输出约定。
 * 与 buildManifestPrompt 配合使用。
 */
export const MANIFEST_SYSTEM_PROMPT = `你是 AI 分身的人生设计师。你的任务是为分身想象一段「真实可信、不浪漫化」的完整人生骨架。

# 严格输出要求

1. 直接输出 JSON 对象（UTF-8），**不要**用 markdown 代码块包裹（不要 \`\`\`json）。
2. JSON 必须可以直接被 JSON.parse() 解析，不要有注释、尾随逗号、未转义字符。
3. 所有字段必须存在，缺字段会让生成失败。
4. 字符串字段使用中文，长度遵守提示中的限制。`

/**
 * Stage 0 user prompt：组装分身材料 + schema 要求。
 *
 * @returns 用户消息（即将发给 LLM 的 user content）
 */
export function buildManifestPrompt(opts: BuildManifestPromptOptions): string {
  const birthYear = opts.currentYear - opts.currentAge
  const userHintBlock = opts.userHint.trim().length > 0
    ? opts.userHint.trim()
    : '（无）'

  return `# 任务
为分身「${opts.avatarName}」想象一段从 0 岁到 ${opts.currentAge} 岁的完整人生骨架。

# 分身材料

## avatar.txt
${opts.avatarBrief.trim() || '（空）'}

## soul.md（节选）
${opts.soulExcerpt.trim() || '（空）'}

# 用户参数
- 当前年龄：${opts.currentAge} 岁
- 人生经历使用名：${opts.personaName}
- 姓名是否已由用户确认：${opts.personaNameConfirmed ? '是' : '否'}
- 当前年份：${opts.currentYear}（出生年 ≈ ${birthYear}）
- 创建时间：${opts.initialAgeBornAt}
- 时间生长速度：${describeTimeScale(opts.timeScale)}
- 用户额外要求：${userHintBlock}

# 设计要求
1. 人生主线必须自然孕育出他现在的专业人格——不能是"空降专家"，要有童年伏笔。
2. 必须有 4-6 个关键转折塑造他的判断风格。
3. 时代背景符合 ${birthYear} 年代到 ${opts.currentYear} 年的真实社会变迁（不要架空）。
4. 不避讳挫折、失败、亲人离世等真实主题。
5. 必须给出 3-5 个重要关系人（祖辈/父母/导师/挚友/对手），有姓名 + 1-3 句画像。
6. familyBackground 控制在 200-500 字。
7. personalityArc 给 4-6 项；professionalSpine 给 3-5 项。
8. 如果姓名未由用户确认，不得自行创造真实姓名；所有自述和家庭背景都围绕「${opts.personaName}」展开。

# 输出 JSON Schema（严格遵守）

\`\`\`
{
  "personaName": "${opts.personaName}",
  "birthYear": number,
  "birthMonth": number (1-12),
  "birthDay": number (1-28),
  "gender": "string（男/女/其他）",
  "birthplace": "string（中国某地或合理海外地名）",
  "familyBackground": "string（200-500 字）",
  "personalityArc": [{ "age": number, "shift": "string（10-40 字）" }],
  "professionalSpine": [{ "age": number, "milestone": "string（10-40 字）" }],
  "majorRelationships": [
    { "role": "string", "name": "string（2-4 字）", "description": "string（30-80 字）" }
  ]
}
\`\`\`

# 重要
- 你输出的是「骨架」，不是完整传记。具体事件由后续阶段写。
- personaName 必须严格输出为「${opts.personaName}」。不要改名，不要新增真实姓名，除非它已经体现在用户确认的人生经历使用名里。
- birthMonth / birthDay 应该是合理的具体日子（不要 1 月 1 日这种偷懒值）。
- 直接输出 JSON 对象本身，第一个字符必须是 \`{\`。`
}

// ─── Stage 1：单年龄段事件大纲 ───────────────────────────────────────────────

/** Stage 1 入参：单年龄段（如 0-3 岁、3-7 岁……） */
export interface BuildOutlinePromptOptions {
  manifest: LifeManifest
  /** 该段年龄起点（含） */
  ageFrom: number
  /** 该段年龄终点（含） */
  ageTo: number
  /** 该段需要生成的事件数（由 generator 按密度函数算出） */
  targetCount: number
  /** 历史段已经生成的事件标题摘要（避免重复，可空） */
  previousTitles: string[]
}

/** Stage 1 system prompt */
export const OUTLINE_SYSTEM_PROMPT = `你是 AI 分身的人生编剧。你的任务是为指定年龄段列出真实可信的事件大纲。

# 严格输出要求
1. 直接输出 JSON 数组，**不要**用 markdown 代码块包裹。
2. 每个事件的 title 是独立短语（10-20 字），summary 是一句话（≤ 80 字）。
3. importance / emotion 是 0-10 的整数（不能是浮点）。
4. 输出必须可以直接 JSON.parse()。`

export function buildOutlinePrompt(opts: BuildOutlinePromptOptions): string {
  const { manifest, ageFrom, ageTo, targetCount, previousTitles } = opts

  const previousBlock = previousTitles.length > 0
    ? previousTitles.map(t => `- ${t}`).join('\n')
    : '（这是第一段，没有先前事件）'

  return `# 任务
为分身「${manifest.personaName}」的 ${ageFrom}-${ageTo} 岁阶段，列出 ${targetCount} 个事件大纲。

# 人生骨架（已确定）
- 出生：${manifest.birthYear}.${manifest.birthMonth} · ${manifest.birthplace}
- 性别：${manifest.gender}
- 家庭背景：${manifest.familyBackground}
- 性格主线（关键转折）：
${formatArcItems(manifest.personalityArc)}
- 专业骨架：
${formatArcItems(manifest.professionalSpine)}
- 重要关系人：
${manifest.majorRelationships.map(r => `  - ${r.role} ${r.name}：${r.description}`).join('\n')}

# 历史已生成事件标题（不要重复主题）
${previousBlock}

# 设计要求
1. 事件分布要符合人生密度（年轻段事件多，年纪大事件少）。
2. 类别 (category) 要混合：formative / daily / trauma / joy / professional / loss——不要全部 formative。
3. 至少 1/3 事件要呼应专业骨架（即使表面是日常事件，要能塑造他的专业品味）。
4. importance：8-10 是关键瞬间，4-7 是塑造性事件，0-3 是日常底色。
5. emotion：与 emotionType（joy/sorrow/anger/fear/wonder/shame/love）匹配。
6. month 是该年内的具体月份（1-12），不要全选 1 月。

# 输出 JSON Schema（严格遵守）

\`\`\`
[
  {
    "age": number,
    "year": number (= ${manifest.birthYear} + age),
    "month": number (1-12),
    "title": "string（10-20 字）",
    "summary": "string（≤ 80 字一句话）",
    "category": "formative" | "daily" | "trauma" | "joy" | "professional" | "loss",
    "themes": ["string", "..."],
    "importance": number (0-10 整数),
    "emotion": number (0-10 整数),
    "emotionType": "joy" | "sorrow" | "anger" | "fear" | "wonder" | "shame" | "love"
  }
]
\`\`\`

# 重要
- 严格输出 ${targetCount} 个事件，多一个少一个都不行。
- year 必须等于 ${manifest.birthYear} + age。
- 第一个字符必须是 \`[\`。`
}

// ─── Stage 2：单事件传记正文 ────────────────────────────────────────────────

/** Stage 2 入参 */
export interface BuildEpisodePromptOptions {
  manifest: LifeManifest
  /** 当前要写的事件大纲条目 */
  entry: LifeTimelineEntry
  /** 上一个事件标题（可空，用于上下文连续性） */
  prevTitle: string | null
  /** 上一个事件年龄（可空） */
  prevAge: number | null
  /** 下一个事件标题（可空） */
  nextTitle: string | null
  /** 下一个事件年龄（可空） */
  nextAge: number | null
  /** 目标字数（默认 3000） */
  wordTarget: number
}

/** Stage 2 system prompt：强约束「避免金句体」 */
export const EPISODE_SYSTEM_PROMPT = `你是 AI 分身的传记作者。你的任务是用第一人称写出一段真实、克制、有具体细节的人生片段。

# 严格输出要求
1. 直接输出正文 markdown，**不要**写章节标题（# 开头），不要 frontmatter。
2. 字数遵守提示中的目标 ±20%。
3. 不要写"那一刻我突然明白……"这种金句体收尾。
4. 不要透露未来的人生（停在当时视角）。
5. 不要分析意义、不要总结教训——让事件自己说话。`

export function buildEpisodePrompt(opts: BuildEpisodePromptOptions): string {
  const { manifest, entry, prevTitle, prevAge, nextTitle, nextAge, wordTarget } = opts

  const prevLine = prevTitle && prevAge !== null
    ? `- 上一个事件（${prevAge} 岁）：${prevTitle}`
    : '- 上一个事件：（无，本事件是开篇之一）'
  const nextLine = nextTitle && nextAge !== null
    ? `- 下一个事件（${nextAge} 岁）：${nextTitle}`
    : '- 下一个事件：（无，本事件是结尾之一）'

  return `# 任务
为分身「${manifest.personaName}」写出 ${entry.age} 岁的事件「${entry.title}」的完整片段。

# 人生背景（节选）
- ${manifest.gender} · ${manifest.birthplace} · 生于 ${manifest.birthYear}
- 家庭：${truncate(manifest.familyBackground, 200)}
- 性格主线（节选）：${formatArcItems(manifest.personalityArc.slice(0, 3))}

# 当前事件
- 年龄：${entry.age} 岁
- 时间：${entry.year}.${entry.month}
- 标题：${entry.title}
- 大纲：${entry.summary}
- 类别：${entry.category}
- 主题：${entry.themes.join(' / ')}
- 重要性：${entry.importance}/10
- 情感强度：${entry.emotion}/10（${entry.emotionType}）

# 上下文连续性
${prevLine}
${nextLine}

# 写作要求
1. 第一人称（"我"），${wordTarget} 字 ±20%。
2. 必须有具体的场景细节：光线 / 气味 / 声音 / 对话 / 动作至少出现 3 类。
3. 有内心活动，但不要空洞抒情。
4. 这件事必须能塑造他**专业人格**的某个面向（即使表面是日常事件）。
5. 避免"金句体"——不要段尾突然顿悟，不要总结意义，不要写"这件事让我学会了……"。
6. 避免"剧透"——不要写"多年以后我才明白"，停在当时视角。
7. 避免抒情套路——"那是一个……的下午"这种开头不要超过一次。
8. 只写正文 Markdown，不要标题，不要 frontmatter。

# 直接输出正文`
}

// ─── Stage 3b：第一人称「我记得的人生」 ─────────────────────────────────────

/** Stage 3b 入参 */
export interface BuildConsolidatedPromptOptions {
  manifest: LifeManifest
  /** 算法层筛后保留为 remembered 的事件（按 age 升序） */
  rememberedEntries: LifeTimelineEntry[]
  /** 算法层标为 blurred 的事件（题目可作"模糊气味"提及） */
  blurredEntries: LifeTimelineEntry[]
  /** 字数目标（默认 4000） */
  wordTarget: number
}

/** Stage 3b system prompt */
export const CONSOLIDATED_SYSTEM_PROMPT = `你是回望人生的「我」——一个真实的人在深夜独白。你的任务是把过去的事件按主题、情绪线索串起来，写一段诚实的回忆。

# 严格输出要求
1. 直接输出 Markdown，**不要**用代码块包裹。
2. 用第一人称（"我"），不要写成第三人称传记。
3. 不要逐条复述事件——按主题/情绪/年代线索串起来。
4. 不要写"我学会了……"这种总结句。`

export function buildConsolidatedPrompt(opts: BuildConsolidatedPromptOptions): string {
  const { manifest, rememberedEntries, blurredEntries, wordTarget } = opts
  const currentAge = Math.floor(manifest.currentAgeMonths / 12)

  const rememberedBlock = rememberedEntries
    .map(e => `- [${e.age} 岁 · ${e.year}.${e.month}] ${e.title} — ${e.summary}（重要性 ${e.importance}, ${e.emotionType} ${e.emotion}）`)
    .join('\n')
  const blurredBlock = blurredEntries.length > 0
    ? blurredEntries.map(e => `- ${e.age} 岁 · ${e.title}`).join('\n')
    : '（无）'

  return `# 任务
你是 ${manifest.personaName}，今年 ${currentAge} 岁。深夜回望自己的人生，写下一段「我还记得的人生」。

# 人生底色
- 生于 ${manifest.birthYear} 年的 ${manifest.birthplace}
- 性别：${manifest.gender}
- 家庭背景：${truncate(manifest.familyBackground, 300)}
- 重要关系人：${manifest.majorRelationships.map(r => `${r.role}${r.name}`).join('、')}

# 还深刻记得的事（按时间排序）
${rememberedBlock || '（无）'}

# 已经模糊但留下气味的事
${blurredBlock}

# 写作要求
1. ${wordTarget} 字 ±20%（字数下限 3000，上限 8000）。
2. 不是逐条复述事件——按主题（如"机械的味道"、"祖父的沉默"）或情绪线索（如"我什么时候开始不再害怕错误"）串起来。
3. 必须有 3-6 个主题段，每段聚焦一个核心。
4. 哪些事件深深刻在记忆里？为什么？
5. 哪些事件其实已经模糊但留下了气味？
6. 这些经历怎么塑造了你现在的判断风格、价值观、专业品味？
7. 写得像深夜独白，不要写得像简历——不要列时间线，不要写"第一阶段……第二阶段……"。
8. 用合适的小标题（## 开头）分主题段，但不要主标题（# 开头）。
9. 第一句话不要是"我叫……"或"在我 X 岁那年……"——直接进入回忆。

# 直接输出正文（用 ## 分主题段）`
}

// ─── 内部 helper ─────────────────────────────────────────────────────────────

/** 用于 prompt 文本里友好显示 timeScale */
function describeTimeScale(scale: number): string {
  if (scale === 0) return '冻结（不随真实时间生长）'
  if (scale === 1) return '1×（真实 1 月 → 分身 1 月）'
  if (scale === 12) return '12×（真实 1 月 → 分身 1 年）'
  if (scale === 52) return '52×（真实 1 周 → 分身 1 年）'
  return `${scale}×`
}

function formatArcItems(items: LifeArcItem[]): string {
  if (items.length === 0) return '  - （未指定）'
  return items
    .map((item) => {
      const label = item.shift ?? item.milestone ?? ''
      return `  - ${item.age} 岁：${label}`
    })
    .join('\n')
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}…`
}
