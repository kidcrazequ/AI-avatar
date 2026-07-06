/**
 * workflow-skill-distill 纯函数单测：
 *
 * 这些测试编码的是「对话沉淀技能」的业务红线，而不只是函数行为——
 *   1. 蒸馏 prompt 必须携带记忆四分边界红线（专业事实不进技能、缺口用占位不编造）；
 *      丢了红线，LLM 会把参数 / 数字沉进技能，制造无法溯源的二手事实。
 *   2. 解析必须结构化拒绝不合格输出（缺节 / 非 kebab name），拒绝落盘劣质草稿。
 *   3. 草稿必须携带 status: draft 隔离协议——草稿绝不等于启用。
 *   4. 晋升校验必须拦下路径逃逸注入、同名覆盖、无触发短语的 description
 *      （与 scripts/validate-skills.py 的规则一致），不过关不落盘。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  WORKFLOW_DISTILL_MAX_MESSAGES,
  WORKFLOW_SKILL_DISTILL_PROTOCOL_VERSION,
  buildWorkflowDistillPrompt,
  buildWorkflowSkillDraftFile,
  parseWorkflowDistillResponse,
  validateWorkflowSkillPromotion,
} from '../agent-runtime'

const VALID_RESPONSE = `---
name: weekly-report-workflow
description: >-
  当用户要求生成周报、汇总本周进展、说"写周报 / weekly report / 项目周总结"时使用。
---

# 周报生成工作流

## 触发场景

用户要求汇总一段时间内的项目进展。

## 输入清单（执行前需要用户提供什么）

- 必须：汇报周期
- 可选：重点项目列表 <待补充>

## 工作流步骤（每步做什么、产出什么）

1. 查询 knowledge/ 里的项目记录，产出事实清单
2. 按模板组织，产出周报草稿 <待补充>

## 交付前自检

- ☐ 每条进展都有来源
- ☐ 没有编造数字

## 不适用范围

- 不做绩效评价：转介 HR 分身
`

function makeTranscript(n: number): Array<{ role: 'user' | 'assistant'; content: string }> {
  return Array.from({ length: n }, (_, i) => ({
    role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
    content: `msg-${i}`,
  }))
}

describe('buildWorkflowDistillPrompt', () => {
  it('system prompt 携带红线：专业事实不进技能 + 缺口用 <待补充> 占位禁止编造', () => {
    // WHY: 红线丢失 = LLM 会把参数/数字沉进技能，破坏「事实归 knowledge/、技能只管流程」的四分边界
    const { system } = buildWorkflowDistillPrompt(makeTranscript(2))
    assert.match(system, /专业事实 \/ 参数 \/ 数字 \/ 结论一律不得写入技能/)
    assert.match(system, /knowledge\//)
    assert.match(system, /<待补充>/)
    assert.match(system, /禁止编造/)
  })

  it('system prompt 要求五节结构 + B2 触发式 description（禁止流程摘要）', () => {
    const { system } = buildWorkflowDistillPrompt(makeTranscript(2))
    for (const section of ['触发场景', '输入清单（执行前需要用户提供什么）', '工作流步骤（每步做什么、产出什么）', '交付前自检', '不适用范围']) {
      assert.ok(system.includes(section), `system prompt 缺少小节要求: ${section}`)
    }
    assert.match(system, /当用户…时使用/)
    assert.match(system, /禁止摘要技能流程/)
  })

  it('user prompt 只带最近 N 条消息（默认 40 上限），并做逐条截断', () => {
    // WHY: 蒸馏跑在用户显式触发的异步路径上，但 prompt 无界会放大成本与超时风险
    const { user } = buildWorkflowDistillPrompt(makeTranscript(50))
    assert.ok(!user.includes('msg-9\n'), '第 10 条（超窗）不应出现')
    assert.ok(user.includes(`msg-${50 - WORKFLOW_DISTILL_MAX_MESSAGES}`), '窗口内第一条应保留')
    const long = buildWorkflowDistillPrompt([{ role: 'user', content: 'a'.repeat(2000) }], { msgTruncate: 10 })
    assert.match(long.user, /a{10}…\[截断\]/)
    assert.ok(!long.user.includes('a'.repeat(11)), '超长消息必须截断')
  })

  it('title 选项进入 user prompt 作为主题提示', () => {
    const { user } = buildWorkflowDistillPrompt(makeTranscript(2), { title: '周报流程' })
    assert.match(user, /用户指定的技能主题/)
    assert.match(user, /周报流程/)
  })
})

describe('parseWorkflowDistillResponse', () => {
  it('合格输出：提取 name / description / title / 占位计数', () => {
    const res = parseWorkflowDistillResponse(VALID_RESPONSE)
    assert.equal(res.ok, true)
    assert.equal(res.skill?.name, 'weekly-report-workflow')
    assert.match(res.skill?.description ?? '', /当用户要求生成周报/)
    assert.equal(res.skill?.title, '周报生成工作流')
    assert.equal(res.skill?.placeholderCount, 2)
  })

  it('容忍整体 ```markdown 围栏与 frontmatter 前的杂文字', () => {
    const res = parseWorkflowDistillResponse('前置说明\n' + VALID_RESPONSE)
    assert.equal(res.ok, true, `前置杂文字应被容忍: ${res.errors.join(';')}`)
    const res2 = parseWorkflowDistillResponse('```markdown\n' + VALID_RESPONSE + '\n```')
    assert.equal(res2.ok, true, `整体围栏应被容忍: ${res2.errors.join(';')}`)
  })

  it('缺少必需小节 → ok=false 并点名缺哪节（拒绝落盘半成品）', () => {
    const broken = VALID_RESPONSE.replace(/## 交付前自检[\s\S]*?(?=## 不适用范围)/, '')
    const res = parseWorkflowDistillResponse(broken)
    assert.equal(res.ok, false)
    assert.ok(res.errors.some((e) => e.includes('交付前自检')), `应点名缺失小节: ${res.errors.join(';')}`)
  })

  it('注入防护：name 含 ../ 路径逃逸或非 kebab-case → ok=false', () => {
    // WHY: name 直接进入草稿文件名，放过 ../ 等于让 LLM 输出控制落盘路径
    const evil = VALID_RESPONSE.replace('name: weekly-report-workflow', 'name: ../../etc/passwd')
    const res = parseWorkflowDistillResponse(evil)
    assert.equal(res.ok, false)
    assert.ok(res.errors.some((e) => e.includes('kebab-case')))

    const upper = VALID_RESPONSE.replace('name: weekly-report-workflow', 'name: Weekly_Report')
    assert.equal(parseWorkflowDistillResponse(upper).ok, false)
  })

  it('缺 frontmatter / 缺 description / 空输出 → ok=false', () => {
    assert.equal(parseWorkflowDistillResponse('').ok, false)
    assert.equal(parseWorkflowDistillResponse('# 只有正文没有 frontmatter').ok, false)
    const noDesc = VALID_RESPONSE.replace(/description: >-\n {2}.*\n/, '')
    const res = parseWorkflowDistillResponse(noDesc)
    assert.equal(res.ok, false)
    assert.ok(res.errors.some((e) => e.includes('description')))
  })
})

describe('buildWorkflowSkillDraftFile', () => {
  it('草稿协议隔离：frontmatter 带 status: draft / source: conversation / protocol，正文带 AI 草案标注 + 人工确认清单', () => {
    // WHY: 草稿绝不启用技能（skill-draft.ts 头注释的设计红线）；这些标记是隔离协议的载体
    const parsed = parseWorkflowDistillResponse(VALID_RESPONSE)
    assert.ok(parsed.skill)
    const draft = buildWorkflowSkillDraftFile({
      avatarId: 'finance-expert',
      conversationId: 'conv-1',
      skill: parsed.skill,
      now: new Date('2026-07-06T08:00:00Z'),
    })
    assert.equal(draft.suggestedId, 'weekly-report-workflow')
    assert.equal(draft.filename, '20260706080000-weekly-report-workflow.md')
    assert.match(draft.content, /^status: draft$/m)
    assert.match(draft.content, /^source: conversation$/m)
    assert.match(draft.content, new RegExp(`^protocol: ${WORKFLOW_SKILL_DISTILL_PROTOCOL_VERSION}$`, 'm'))
    assert.match(draft.content, /^conversation_id: conv-1$/m)
    assert.match(draft.content, /AI 草案/)
    assert.match(draft.content, /## 人工确认清单/)
    assert.match(draft.content, /当前 2 处/)
  })
})

describe('validateWorkflowSkillPromotion', () => {
  const fixtureSkill = parseWorkflowDistillResponse(VALID_RESPONSE).skill
  if (!fixtureSkill) throw new Error('测试夹具解析失败：VALID_RESPONSE 不合法')
  const draft = buildWorkflowSkillDraftFile({
    avatarId: 'finance-expert',
    conversationId: 'conv-1',
    skill: fixtureSkill,
    now: new Date('2026-07-06T08:00:00Z'),
  })

  it('通过校验时：剥离草稿专属 frontmatter 与草案脚手架，name 强制等于 skillId', () => {
    const res = validateWorkflowSkillPromotion({
      draftContent: draft.content,
      existingSkillIds: ['other-skill'],
    })
    assert.deepEqual(res.errors, [])
    assert.equal(res.skillId, 'weekly-report-workflow')
    const md = res.skillMarkdown ?? ''
    assert.match(md, /^name: weekly-report-workflow$/m)
    for (const key of ['status:', 'protocol:', 'conversation_id:', 'avatar_id:', 'suggested_id:', 'created_at:', 'source:']) {
      assert.ok(!md.includes(key), `晋升产物不应残留草稿键 ${key}`)
    }
    assert.ok(!md.includes('人工确认清单'), '人工确认清单是草稿脚手架，晋升时应剥离')
    assert.ok(!md.includes('AI 草案'), 'AI 草案标注应剥离')
    assert.match(md, /## 工作流步骤/)
  })

  it('注入防护：skillId 含 ../ 路径逃逸 → errors 非空，不产出 markdown', () => {
    const res = validateWorkflowSkillPromotion({
      skillId: '../escape',
      draftContent: draft.content,
      existingSkillIds: [],
    })
    assert.ok(res.errors.some((e) => e.includes('kebab-case')))
    assert.equal(res.skillMarkdown, undefined)
  })

  it('同名冲突（local/shared，大小写不敏感）→ 拒绝晋升', () => {
    // WHY: 同名覆盖会静默顶掉现有技能（local > shared 优先级），必须显式拦截
    const res = validateWorkflowSkillPromotion({
      draftContent: draft.content,
      existingSkillIds: ['Weekly-Report-Workflow'],
    })
    assert.ok(res.errors.some((e) => e.includes('同名')), res.errors.join(';'))
  })

  it('description 缺触发短语 → 拒绝晋升（与 validate-skills.py RE_TRIGGER 一致）', () => {
    const noTrigger = draft.content.replace(
      /description: >-\n {2}.*/,
      'description: >-\n  一个用来生成周报的技能。',
    )
    const res = validateWorkflowSkillPromotion({ draftContent: noTrigger, existingSkillIds: [] })
    assert.ok(res.errors.some((e) => e.includes('触发短语')), res.errors.join(';'))

    const useWhen = draft.content.replace(
      /description: >-\n {2}.*/,
      'description: >-\n  Use when the user asks for a weekly report.',
    )
    assert.deepEqual(validateWorkflowSkillPromotion({ draftContent: useWhen, existingSkillIds: [] }).errors, [])
  })

  it('frontmatter 不完整（无 frontmatter / 空 description / 无可用 skillId）→ 拒绝晋升', () => {
    assert.ok(validateWorkflowSkillPromotion({ draftContent: '# 无 frontmatter', existingSkillIds: [] }).errors.length > 0)

    const noDesc = draft.content
      .replace(/description: >-\n {2}.*\n/, '')
    const res = validateWorkflowSkillPromotion({ draftContent: noDesc, existingSkillIds: [] })
    assert.ok(res.errors.some((e) => e.includes('description')), res.errors.join(';'))

    const noId = '---\nfoo: bar\n---\n\n# 正文'
    const res2 = validateWorkflowSkillPromotion({ draftContent: noId, existingSkillIds: [] })
    assert.ok(res2.errors.some((e) => e.includes('技能 ID')), res2.errors.join(';'))
  })

  it('显式 skillId 覆盖草稿 suggested_id', () => {
    const res = validateWorkflowSkillPromotion({
      skillId: 'renamed-workflow',
      draftContent: draft.content,
      existingSkillIds: ['weekly-report-workflow'],
    })
    assert.deepEqual(res.errors, [])
    assert.equal(res.skillId, 'renamed-workflow')
    assert.match(res.skillMarkdown ?? '', /^name: renamed-workflow$/m)
  })
})
