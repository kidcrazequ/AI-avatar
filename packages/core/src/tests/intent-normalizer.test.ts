/**
 * intent-normalizer 澄清闸门（问题2·A）单测
 *
 * 验证「欠定义 × 高代价」双轴评分卡的意图，而非单纯行为：
 *   - 高代价 且 欠定义 → 才反问（避免整轮返工/误导，这是闸门存在的理由）
 *   - 定义清晰（有具体指标 / 有产物）→ 不反问（问了只会打扰）
 *   - 低代价（无主体 / 非评估类）→ 不反问
 *   - 反问时必须回显主体做教学回声（clarificationQuestion 含 entity）
 *   - 边界护栏优先于澄清（guardrail 命中时 needsClarification 恒为 false）
 *
 * @author kian
 * @date 2026-07-22
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeIntentLocal } from '../intent-normalizer'

test('欠定义×高代价：笼统评估某主体表现 → 触发澄清', () => {
  const frame = normalizeIntentLocal('帮我看下 262 柜体最近表现怎么样')
  assert.equal(frame.needsClarification, true, '有主体+笼统评估+无具体指标+无产物 应触发')
  assert.ok(frame.clarificationOptions.length > 0, '触发时必须给出可点选项')
  // 教学回声：问句必须回显主体，让用户看到"一个聚焦的问题长什么样"
  assert.ok(
    frame.clarificationQuestion && frame.clarificationQuestion.includes('262'),
    'clarificationQuestion 应回显主体 262',
  )
})

test('定义清晰（有具体指标）→ 不反问：问了只会打扰', () => {
  const frame = normalizeIntentLocal('262 柜体的故障率是多少')
  assert.equal(frame.needsClarification, false, '已给出具体指标(故障率)，无需澄清')
  assert.equal(frame.clarificationQuestion, undefined)
})

test('定义清晰（有产物）→ 不反问：画架构图目标明确', () => {
  const frame = normalizeIntentLocal('画个 262 柜体的架构图')
  assert.equal(frame.needsClarification, false, '已指明产物(架构图)，无需澄清')
})

test('无明确主体的笼统评估 → 仍反问，但问句不回显填充词', () => {
  const frame = normalizeIntentLocal('分析一下最近表现怎么样')
  assert.equal(frame.needsClarification, true, '无明确主体的笼统评估，最该反问')
  assert.ok(frame.clarificationQuestion, '应给出澄清问句')
  assert.ok(!frame.clarificationQuestion!.includes('一下'), '不应把填充词当主体回显')
  assert.ok(!frame.clarificationQuestion!.includes('最近'), '不应把填充词当主体回显')
})

test('寒暄类 → 不反问', () => {
  const frame = normalizeIntentLocal('你好')
  assert.equal(frame.needsClarification, false)
})

test('边界护栏优先于澄清：问模型实现 → guardrail 命中且不澄清', () => {
  const frame = normalizeIntentLocal('你用的是什么模型')
  assert.ok(frame.guardrail, '应命中 implementation_privacy 护栏')
  assert.equal(frame.needsClarification, false, 'guardrail 命中时不应再要求澄清')
})
