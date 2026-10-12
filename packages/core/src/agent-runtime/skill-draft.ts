/**
 * Skill sediment draft protocol.
 *
 * Drafts are intentionally separate from skills/: creating one must not enable
 * a new skill or change skill-index.yaml. The user can review and promote the
 * draft through an explicit later action.
 */

export const SKILL_DRAFT_PROTOCOL_VERSION = '2026-06-p1-draft'

export interface BuildSkillDraftInput {
  avatarId: string
  conversationId: string
  userText: string
  assistantText: string
  title?: string
  now?: Date
}

export interface SkillDraft {
  protocolVersion: typeof SKILL_DRAFT_PROTOCOL_VERSION
  suggestedId: string
  filename: string
  title: string
  content: string
  rationale: string
}

function slugifySkillId(value: string): string {
  const ascii = value
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  return ascii || 'conversation-skill-draft'
}

function makeStamp(now: Date): string {
  return now.toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)
}

function firstUsefulLine(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/[#>*`-]/g, '').trim())
    .find((line) => line.length >= 4)
    ?.slice(0, 40) ?? '对话沉淀技能草稿'
}

function clip(text: string, max = 900): string {
  const normalized = text.trim()
  if (normalized.length <= max) return normalized
  return `${normalized.slice(0, max)}...`
}

export function buildSkillDraftFromConversation(input: BuildSkillDraftInput): SkillDraft {
  const now = input.now ?? new Date()
  const title = (input.title?.trim() || firstUsefulLine(input.userText)).slice(0, 60)
  const suggestedId = slugifySkillId(title)
  const filename = `${makeStamp(now)}-${suggestedId}.md`
  const rationale = 'conversation_sediment_pending_review'
  const content = [
    '---',
    `protocol: ${SKILL_DRAFT_PROTOCOL_VERSION}`,
    'status: draft',
    `suggested_id: ${suggestedId}`,
    `avatar_id: ${input.avatarId}`,
    `conversation_id: ${input.conversationId}`,
    `created_at: ${now.toISOString()}`,
    'source: conversation',
    '---',
    '',
    `# ${title}`,
    '',
    '## 触发场景',
    '',
    clip(input.userText, 500),
    '',
    '## 可复用做法',
    '',
    clip(input.assistantText, 1200),
    '',
    '## 人工确认清单',
    '',
    '- [ ] 这确实是可复用流程，而不是一次性回答',
    '- [ ] 关键事实已有来源或不依赖专业事实',
    '- [ ] 不会覆盖现有同名技能',
    '- [ ] 确认后再复制到 skills/ 并更新 skill-index.yaml',
    '',
  ].join('\n')

  return {
    protocolVersion: SKILL_DRAFT_PROTOCOL_VERSION,
    suggestedId,
    filename,
    title,
    content,
    rationale,
  }
}
