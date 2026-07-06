/**
 * Workflow skill distillation — 把一段对话蒸馏成「一键工作流技能」草稿。
 *
 * 草稿区隔离原则（与 skill-draft.ts 同一设计红线）：蒸馏产物只落
 * avatars/<id>/drafts/skills/，绝不启用技能、绝不改 skill-index.yaml；
 * 晋升必须是用户显式动作，且先过 validateWorkflowSkillPromotion 校验
 * （规则与 scripts/validate-skills.py 对齐：kebab-case name、同名冲突、
 * description 非空且含触发短语、frontmatter 完整）。
 *
 * 记忆四分边界（红线，已写进蒸馏 prompt）：技能只沉淀「怎么做」的流程
 * 结构；专业事实 / 参数 / 数字归 knowledge/，禁止写入技能；蒸馏不到的
 * 信息用 `<待补充>` 占位并列入人工确认清单，禁止编造。
 *
 * 本模块只含纯函数（prompt 构造 / 响应解析 / 草稿组装 / 晋升校验），
 * 无 IO / 无 LLM 调用——编排在 desktop-app electron/main.ts 的
 * skill-draft:* handlers。
 */

import { extractFrontmatter } from '../utils/markdown-parser'

export const WORKFLOW_SKILL_DISTILL_PROTOCOL_VERSION = '2026-07-p1-workflow-distill'

/** 蒸馏 prompt 最多带最近多少条 user/assistant 消息（tool 消息由调用方过滤） */
export const WORKFLOW_DISTILL_MAX_MESSAGES = 40
/** 蒸馏 prompt 中单条消息正文截断长度 */
export const WORKFLOW_DISTILL_MSG_TRUNCATE = 1200

/** 工作流技能正文必须包含的五节（按 `## <节名>` 前缀匹配，允许附带括号说明） */
export const WORKFLOW_SKILL_REQUIRED_SECTIONS = [
  '触发场景',
  '输入清单',
  '工作流步骤',
  '交付前自检',
  '不适用范围',
] as const

/** kebab-case 技能 ID（与 scripts/validate-skills.py 的 RE_KEBAB 一致）；同时天然拦截 ../ 路径逃逸 */
const RE_KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/
/** 触发短语（与 scripts/validate-skills.py 的 RE_TRIGGER 一致） */
const RE_TRIGGER = /(当.{0,60}(时|后)|当用户|use\s+when|use\s+this\s+skill|must\s+use\s+when|适用|触发)/i
/** 蒸馏不到的信息占位符（禁止编造，人工确认清单里逐处列出） */
const PLACEHOLDER = '<待补充>'

/** 草稿协议专属 frontmatter 键——晋升时必须剥离 */
const DRAFT_ONLY_FRONTMATTER_KEYS = new Set([
  'protocol',
  'status',
  'suggested_id',
  'avatar_id',
  'conversation_id',
  'created_at',
  'source',
])

export interface WorkflowDistillTranscriptMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface BuildWorkflowDistillPromptOptions {
  /** 用户给的技能主题（可选，作为命名 / 触发场景的提示） */
  title?: string
  /** 覆盖默认消息条数上限（默认 WORKFLOW_DISTILL_MAX_MESSAGES） */
  maxMessages?: number
  /** 覆盖默认单条截断长度（默认 WORKFLOW_DISTILL_MSG_TRUNCATE） */
  msgTruncate?: number
}

const WORKFLOW_DISTILL_SYSTEM_PROMPT = `你是 AI 分身的工作流沉淀助手。任务：从最近的对话转写中，把用户和分身实际走过的**可复用工作流程**蒸馏成一份技能 markdown 草稿。

输出契约（只输出一份 markdown 文档，不要任何解释文字）：

1. YAML frontmatter，只含两个字段：
   - name: 技能 ID 建议，kebab-case（小写字母 / 数字 + 连字符，≤64 字符）
   - description: 用 >- 折叠块写。第三人称；**以「当用户…时使用」开头**，只写触发场景，
     穷举用户可能说出的触发关键词（同义词 / 中英文 / 口语说法）；
     **禁止摘要技能流程**（一旦写了"先做 A 再做 B"，模型读完摘要就不再加载技能全文）。
2. 正文：一行 \`# 技能标题\`，然后**恰好**下列五节（二级标题，节名前缀必须一字不差）：
   - \`## 触发场景\` — 什么情况下应执行本工作流
   - \`## 输入清单（执行前需要用户提供什么）\` — 列表 / 表格，标明必须与可选
   - \`## 工作流步骤（每步做什么、产出什么）\` — 有序步骤，每步写清动作与产出物
   - \`## 交付前自检\` — 可机械判定的检查项（能打勾 / 打叉），不写空泛原则句
   - \`## 不适用范围\` — 本技能不做什么、被误触发时如何转介

【红线——违反任意一条即为废稿】
- 只沉淀「怎么做」的流程结构。**专业事实 / 参数 / 数字 / 结论一律不得写入技能**：
  这些属于 knowledge/ 知识库（须走溯源规范），写进技能等于制造无法溯源的二手事实。
  步骤里需要引用事实时，写"查询 knowledge/ 对应文件"这类动作，不要抄数值。
- 对话里蒸馏不到的信息（参数名、文件路径、阈值、审批人等）一律用 \`${PLACEHOLDER}\` 占位，
  **禁止编造**；宁可多留占位，不可虚构一个看起来合理的值。
- 只提炼对话中真实出现过的做法；不要为了"完整"补上对话里从未发生的步骤。
- description 只写触发场景；流程细节只出现在正文五节里。`

function truncateForPrompt(text: string, max: number): string {
  const normalized = (text ?? '').trim()
  if (normalized.length <= max) return normalized
  return `${normalized.slice(0, max)}…[截断]`
}

/**
 * 构造蒸馏 prompt（system + user）。
 * transcript 由调用方按窗口截取（只含 user/assistant，不含 tool），
 * 这里再按 maxMessages 取最近 N 条、逐条截断。
 */
export function buildWorkflowDistillPrompt(
  transcript: WorkflowDistillTranscriptMessage[],
  opts: BuildWorkflowDistillPromptOptions = {},
): { system: string; user: string } {
  const maxMessages = opts.maxMessages ?? WORKFLOW_DISTILL_MAX_MESSAGES
  const msgTruncate = opts.msgTruncate ?? WORKFLOW_DISTILL_MSG_TRUNCATE
  const msgs = transcript.slice(-maxMessages)
  const transcriptText = msgs
    .map((m) => `${m.role === 'user' ? '用户' : '分身'}: ${truncateForPrompt(m.content, msgTruncate)}`)
    .join('\n\n')
  const lines: string[] = []
  const title = opts.title?.trim()
  if (title) {
    lines.push(`## 用户指定的技能主题\n\n${title.slice(0, 120)}\n`)
  }
  lines.push('## 待蒸馏的对话转写', '', transcriptText, '', '请按 system 契约输出技能 markdown。')
  return { system: WORKFLOW_DISTILL_SYSTEM_PROMPT, user: lines.join('\n') }
}

export interface ParsedWorkflowSkill {
  /** frontmatter name（已通过 kebab-case 校验） */
  name: string
  description: string
  /** 正文第一个 `# ` 标题，缺省回退 name */
  title: string
  /** frontmatter 之后的正文（含 # 标题与五节） */
  body: string
  /** 正文中 `<待补充>` 占位数量 */
  placeholderCount: number
}

export interface WorkflowDistillParseResult {
  ok: boolean
  errors: string[]
  skill?: ParsedWorkflowSkill
}

/** 去掉整体 ``` 围栏（LLM 常把整份文档包在 ```markdown ... ``` 里） */
function stripOuterFence(raw: string): string {
  const fence = raw.match(/^```[a-zA-Z]*\s*\n([\s\S]*?)\n```\s*$/)
  return fence ? fence[1] : raw
}

/** 丢掉 frontmatter 起始 `---` 之前的杂文字（"好的，以下是…"之类） */
function sliceFromFrontmatter(raw: string): string {
  const idx = raw.search(/^---\s*$/m)
  return idx >= 0 ? raw.slice(idx) : raw
}

function findMissingSections(body: string): string[] {
  return WORKFLOW_SKILL_REQUIRED_SECTIONS.filter(
    (section) => !new RegExp(`^##\\s*${section}`, 'm').test(body),
  )
}

/**
 * 解析并校验蒸馏 LLM 输出。
 * 结构不合格（缺 frontmatter / name 非 kebab / 缺 description / 缺节）→ ok=false + 错误清单，
 * 由调用方拒绝落盘（fail-loud，不静默修补）。
 */
export function parseWorkflowDistillResponse(text: string): WorkflowDistillParseResult {
  const errors: string[] = []
  const raw = sliceFromFrontmatter(stripOuterFence((text ?? '').trim()))
  if (!raw) {
    return { ok: false, errors: ['LLM 输出为空'] }
  }

  const fmMatch = raw.match(/^---\n[\s\S]*?\n---\n?/)
  if (!fmMatch) {
    return { ok: false, errors: ['缺少 YAML frontmatter（--- 块）'] }
  }
  const fm = extractFrontmatter(raw)
  const name = (fm.name ?? '').trim()
  const description = (fm.description ?? '').replace(/\s+/g, ' ').trim()

  if (!name) {
    errors.push('frontmatter 缺 name 字段')
  } else if (!RE_KEBAB.test(name)) {
    errors.push(`name 不是 kebab-case（小写字母/数字 + 连字符）: ${name}`)
  } else if (name.length > 64) {
    errors.push(`name 过长（${name.length} > 64 字符）`)
  }
  if (!description) {
    errors.push('frontmatter 缺 description 字段')
  }

  const body = raw.slice(fmMatch[0].length).trim()
  const missing = findMissingSections(body)
  if (missing.length > 0) {
    errors.push(`正文缺少必需小节: ${missing.join('、')}`)
  }

  if (errors.length > 0) {
    return { ok: false, errors }
  }

  const titleMatch = body.match(/^#\s+(.+)$/m)
  return {
    ok: true,
    errors: [],
    skill: {
      name,
      description,
      title: titleMatch ? titleMatch[1].trim() : name,
      body,
      placeholderCount: body.split(PLACEHOLDER).length - 1,
    },
  }
}

export interface BuildWorkflowSkillDraftFileInput {
  avatarId: string
  conversationId: string
  skill: ParsedWorkflowSkill
  now?: Date
}

export interface WorkflowSkillDraftFile {
  protocolVersion: typeof WORKFLOW_SKILL_DISTILL_PROTOCOL_VERSION
  suggestedId: string
  filename: string
  title: string
  content: string
}

function makeStamp(now: Date): string {
  return now.toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)
}

/** AI 草案标注行（晋升时剥离） */
const DRAFT_BANNER = '> ⚠️ AI 草案：由对话蒸馏自动生成，未经人工确认；本草稿不会启用任何技能、不会改动 skill-index.yaml。'

/**
 * 组装草稿文件（沿用 skill-draft.ts 落盘协议：status: draft / source: conversation +
 * AI 草案标注 + 人工确认清单节）。调用方负责写入 drafts/skills/。
 */
export function buildWorkflowSkillDraftFile(input: BuildWorkflowSkillDraftFileInput): WorkflowSkillDraftFile {
  const now = input.now ?? new Date()
  const { skill } = input
  const suggestedId = skill.name
  const filename = `${makeStamp(now)}-${suggestedId}.md`
  const body = /^#\s+/m.test(skill.body) ? skill.body : `# ${skill.title}\n\n${skill.body}`
  const placeholderLine = skill.placeholderCount > 0
    ? `- [ ] \`${PLACEHOLDER}\` 占位已全部补齐（当前 ${skill.placeholderCount} 处，蒸馏不到的信息不编造）`
    : `- [ ] 正文没有遗漏需要 \`${PLACEHOLDER}\` 占位的缺口`
  const content = [
    '---',
    `protocol: ${WORKFLOW_SKILL_DISTILL_PROTOCOL_VERSION}`,
    'status: draft',
    `suggested_id: ${suggestedId}`,
    `avatar_id: ${input.avatarId}`,
    `conversation_id: ${input.conversationId}`,
    `created_at: ${now.toISOString()}`,
    'source: conversation',
    `name: ${suggestedId}`,
    'description: >-',
    `  ${skill.description}`,
    '---',
    '',
    DRAFT_BANNER,
    '',
    body,
    '',
    '## 人工确认清单',
    '',
    '- [ ] 工作流步骤与实际做法一致，没有编造的步骤',
    '- [ ] 专业事实 / 参数 / 数字已剥离（此类内容归 knowledge/，技能只管流程）',
    placeholderLine,
    '- [ ] description 以触发场景开头，未摘要技能流程',
    '- [ ] 不会覆盖现有同名技能（晋升时会再次强制校验）',
    '- [ ] 确认后通过「晋升」动作写入 skills/ 并更新 skill-index.yaml',
    '',
  ].join('\n')

  return {
    protocolVersion: WORKFLOW_SKILL_DISTILL_PROTOCOL_VERSION,
    suggestedId,
    filename,
    title: skill.title,
    content,
  }
}

export interface WorkflowSkillPromotionInput {
  /** 显式指定的目标技能 ID；缺省用草稿 frontmatter 的 suggested_id / name */
  skillId?: string
  /** drafts/skills/ 里的草稿全文 */
  draftContent: string
  /** 现有技能 ID（local + shared 都查），用于同名冲突拦截 */
  existingSkillIds: string[]
}

export interface WorkflowSkillPromotionResult {
  /** 非空 = 校验失败，不得落盘 */
  errors: string[]
  skillId?: string
  description?: string
  /** errors 为空时给出：剥离草稿 frontmatter / AI 草案标注 / 人工确认清单后的最终技能 markdown */
  skillMarkdown?: string
}

/** 从草稿正文剥离 AI 草案标注行与「人工确认清单」节 */
function stripDraftScaffolding(body: string): string {
  const lines = body.split('\n')
  const out: string[] = []
  let skippingChecklist = false
  for (const line of lines) {
    if (skippingChecklist) {
      if (/^##\s/.test(line) && !/^##\s*人工确认清单/.test(line)) {
        skippingChecklist = false
        out.push(line)
      }
      continue
    }
    if (/^##\s*人工确认清单/.test(line)) {
      skippingChecklist = true
      continue
    }
    if (line.startsWith('> ⚠️ AI 草案')) continue
    out.push(line)
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

/**
 * 晋升前校验 + 生成最终技能 markdown（规则与 scripts/validate-skills.py 一致）。
 *
 * 拦截项（任一命中 → errors 非空，调用方不得落盘）：
 *   1. skillId 非 kebab-case（同时天然拦截 `../` 路径逃逸注入）
 *   2. 与现有技能同名（local / shared，大小写不敏感）
 *   3. description 为空或不含触发短语（「当…时」/「Use when」类）
 *   4. frontmatter 不完整（缺失 / 缺 description）
 */
export function validateWorkflowSkillPromotion(input: WorkflowSkillPromotionInput): WorkflowSkillPromotionResult {
  const errors: string[] = []
  const draft = (input.draftContent ?? '').trim()
  const fmMatch = draft.match(/^---\n[\s\S]*?\n---\n?/)
  if (!fmMatch) {
    return { errors: ['草稿缺少 YAML frontmatter，无法晋升'] }
  }
  const fm = extractFrontmatter(draft)

  const skillId = (input.skillId ?? '').trim() || (fm.suggested_id ?? '').trim() || (fm.name ?? '').trim()
  if (!skillId) {
    errors.push('缺少技能 ID（未显式指定，草稿 frontmatter 也没有 suggested_id / name）')
  } else if (!RE_KEBAB.test(skillId)) {
    errors.push(`技能 ID 不是 kebab-case（小写字母/数字 + 连字符）: ${skillId}`)
  } else if (skillId.length > 64) {
    errors.push(`技能 ID 过长（${skillId.length} > 64 字符）: ${skillId}`)
  } else {
    const lower = skillId.toLowerCase()
    if (input.existingSkillIds.some((id) => id.trim().toLowerCase() === lower)) {
      errors.push(`与现有技能同名（local/shared 已存在），拒绝覆盖: ${skillId}`)
    }
  }

  const description = (fm.description ?? '').replace(/\s+/g, ' ').trim()
  if (!description) {
    errors.push('frontmatter 缺 description（非空是晋升硬条件）')
  } else if (!RE_TRIGGER.test(description)) {
    errors.push('description 不含触发短语（如「当…时」/「Use when」），弱模型会漏触发，拒绝晋升')
  }

  if (errors.length > 0) {
    return { errors }
  }

  // 剥离草稿专属 frontmatter，保留使用者手动补充的其它键（domain 等）
  const extraKeys = Object.entries(fm)
    .filter(([key]) => !DRAFT_ONLY_FRONTMATTER_KEYS.has(key) && key !== 'name' && key !== 'description')
    .map(([key, value]) => `${key}: ${String(value).replace(/\s+/g, ' ').trim()}`)

  const body = stripDraftScaffolding(draft.slice(fmMatch[0].length))
  const skillMarkdown = [
    '---',
    `name: ${skillId}`,
    'description: >-',
    `  ${description}`,
    ...extraKeys,
    '---',
    '',
    body,
    '',
  ].join('\n')

  return { errors: [], skillId, description, skillMarkdown }
}
