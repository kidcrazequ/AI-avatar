/**
 * palace-panel-logic.test.ts — 职场面板纯逻辑单测
 *
 * 关键场景（每条对应 UED 审计的一个可用性承诺）：
 *   - 智能默认 tab：待确认 > 承诺 > 路线（首跑落路线，能看到种子卡）
 *   - 首跑判定：只有「完全没用过」才算首跑，任何真实数据都关掉引导
 *   - 空骨架判定：初始模板算骨架，用户写过一行正文就不算
 *   - 承诺一句话拆分：标题取首句 ≤30 字，整句保留为正文
 *
 * 运行：
 *   NODE_PATH=./test-support/node_modules npx tsx --test src/components/palace-panel-logic.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  pickDefaultPalaceTab,
  isPalaceProfileSkeleton,
  isPalaceFirstRun,
  deriveCommitmentDraft,
} from './palace-panel-logic'

// —— 与 packages/core/src/palace/store.ts buildDefaultPalaceProfile() 一致的空模板 ——
const SKELETON_PROFILE = [
  '# Profile',
  '',
  '> 记录用户当前职业画像、角色目标、沟通偏好和长期边界。',
  '',
  '## 当前角色',
  '',
  '## 风格偏好',
  '',
  '## 长期目标',
  '',
].join('\n')

test('默认 tab：有待确认项时先落待确认——用户欠一个「接受/拒绝」的决定', () => {
  assert.equal(pickDefaultPalaceTab(3, 5), 'inbox')
  assert.equal(pickDefaultPalaceTab(1, 0), 'inbox')
})

test('默认 tab：无待确认但有未关闭承诺时落承诺——正在追踪的事优先', () => {
  assert.equal(pickDefaultPalaceTab(0, 2), 'commitments')
})

test('默认 tab：首跑（两者皆 0）落路线，让用户第一眼看到三张种子路线卡', () => {
  assert.equal(pickDefaultPalaceTab(0, 0), 'rooms')
})

test('空骨架判定：初始模板（只有标题/引用/空行）算骨架', () => {
  assert.equal(isPalaceProfileSkeleton(SKELETON_PROFILE), true)
  assert.equal(isPalaceProfileSkeleton(''), true)
})

test('空骨架判定：用户在任意小节下写过一行正文就不再算骨架', () => {
  const filled = SKELETON_PROFILE.replace('## 当前角色\n', '## 当前角色\n储能产品线负责人\n')
  assert.equal(isPalaceProfileSkeleton(filled), false)
})

test('首跑判定：四个条件全空才算首跑（决定引导卡是否出现）', () => {
  assert.equal(
    isPalaceFirstRun({ commitmentCount: 0, pendingInboxCount: 0, profile: SKELETON_PROFILE, company: '' }),
    true,
  )
})

test('首跑判定：任何一处有真实数据（承诺/待确认/底稿正文）都不算首跑，不再打扰', () => {
  const base = { commitmentCount: 0, pendingInboxCount: 0, profile: SKELETON_PROFILE, company: SKELETON_PROFILE }
  assert.equal(isPalaceFirstRun({ ...base, commitmentCount: 1 }), false)
  assert.equal(isPalaceFirstRun({ ...base, pendingInboxCount: 1 }), false)
  assert.equal(isPalaceFirstRun({ ...base, profile: '# Profile\n我是产品经理' }), false)
})

test('承诺拆分：标题取首句，整句保留为正文——用户只写一句话就能提交', () => {
  const draft = deriveCommitmentDraft('我周五前给王总交测算。验收口径按上次会议纪要。')
  assert.ok(draft)
  assert.equal(draft.title, '我周五前给王总交测算')
  assert.equal(draft.promise, '我周五前给王总交测算。验收口径按上次会议纪要。')
})

test('承诺拆分：首句超 30 字时截到 30 字以内（含省略号），标题必须一眼读完', () => {
  const long = '这是一个非常非常非常非常非常非常非常非常非常非常长的承诺内容需要被截断处理'
  const draft = deriveCommitmentDraft(long)
  assert.ok(draft)
  assert.ok(draft.title.length <= 30)
  assert.ok(draft.title.endsWith('…'))
  assert.equal(draft.promise, long)
})

test('承诺拆分：空输入返回 null，由表单负责提示而不是提交空承诺', () => {
  assert.equal(deriveCommitmentDraft('   '), null)
})
