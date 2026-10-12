/**
 * 对话情景记忆遗忘机制单测（v17 Phase 2c+）。
 *
 * 覆盖：
 *   1. 新鲜 episode（1 月内）→ remembered，无论重要性
 *   2. 普通重要性，时间拉长 → blurred → forgotten
 *   3. 高重要性 + 高情感 → 即使老也能 remembered
 *   4. valence=-10 强负面情感 → 用 |valence|，等同 +10 情感强度
 *   5. applyEpisodeAlgorithmicForgetting：返回 changedIds 准确
 *   6. consolidationStatus 没变的 episode 不进 changedIds（增量写盘）
 *   7. 默认权重稳定点：表内参考点重新跑应保持同结果
 *
 * @author zhi.qu
 * @date 2026-05-17
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  computeEpisodeForgetProbability,
  probabilityToEpisodeStatus,
  applyEpisodeAlgorithmicForgetting,
  DEFAULT_EPISODE_FORGETTING_WEIGHTS,
} from '../memory/episode-forgetter'
import {
  CONVERSATION_EPISODE_SCHEMA_VERSION,
  type ConversationEpisode,
} from '../memory/episode-types'

const MS_PER_MONTH = 30 * 86400 * 1000
const NOW = 1_700_000_000_000 // 固定锚点便于断言

function makeEpisode(overrides: Partial<ConversationEpisode> = {}): ConversationEpisode {
  return {
    schemaVersion: CONVERSATION_EPISODE_SCHEMA_VERSION,
    conversationId: 'conv-1',
    avatarId: 'a1',
    title: 't',
    theme: '',
    summary: 's',
    keyQuotes: [],
    themes: [],
    valence: 0,
    emotionType: 'wonder',
    importance: 5,
    consolidationStatus: 'remembered',
    consolidationNote: '',
    conversationStartedAt: NOW - MS_PER_MONTH,
    conversationLastMessageAt: NOW - MS_PER_MONTH, // 默认 1 月前
    extractedAt: NOW - MS_PER_MONTH,
    messageCount: 5,
    ...overrides,
  }
}

describe('computeEpisodeForgetProbability', () => {
  test('当下刚结束：recency=1 月内，prob 远低于阈值 → remembered', () => {
    const ep = makeEpisode({
      conversationLastMessageAt: NOW - 86400 * 1000, // 1 天前
      importance: 2,
      valence: 0,
    })
    const prob = computeEpisodeForgetProbability(ep, NOW)
    const status = probabilityToEpisodeStatus(prob)
    assert.ok(prob < 0.4, `prob=${prob} 应低于 blurred 阈值`)
    assert.equal(status, 'remembered')
  })

  test('12 月前 + 普通重要性 → blurred', () => {
    const ep = makeEpisode({
      conversationLastMessageAt: NOW - 12 * MS_PER_MONTH,
      importance: 2,
      valence: 0,
    })
    const prob = computeEpisodeForgetProbability(ep, NOW)
    const status = probabilityToEpisodeStatus(prob)
    assert.ok(prob > 0.4 && prob <= 0.7, `prob=${prob} 应在 (0.4, 0.7] 区间`)
    assert.equal(status, 'blurred')
  })

  test('24 月前 + 普通重要性 → forgotten', () => {
    const ep = makeEpisode({
      conversationLastMessageAt: NOW - 24 * MS_PER_MONTH,
      importance: 2,
      valence: 0,
    })
    const prob = computeEpisodeForgetProbability(ep, NOW)
    const status = probabilityToEpisodeStatus(prob)
    assert.ok(prob > 0.7, `prob=${prob} 应高于 forgotten 阈值`)
    assert.equal(status, 'forgotten')
  })

  test('12 月前 + 高重要性高情感 → 仍然 remembered', () => {
    const ep = makeEpisode({
      conversationLastMessageAt: NOW - 12 * MS_PER_MONTH,
      importance: 8,
      valence: 6,
    })
    const prob = computeEpisodeForgetProbability(ep, NOW)
    const status = probabilityToEpisodeStatus(prob)
    assert.equal(status, 'remembered', `prob=${prob} 重要 + 情感强应被记住`)
  })

  test('valence=-10（强负面情感）和 +10（强正面）效果一致——用 |valence|', () => {
    const epPos = makeEpisode({
      conversationLastMessageAt: NOW - 24 * MS_PER_MONTH,
      importance: 5,
      valence: 10,
    })
    const epNeg = makeEpisode({
      conversationLastMessageAt: NOW - 24 * MS_PER_MONTH,
      importance: 5,
      valence: -10,
    })
    const probPos = computeEpisodeForgetProbability(epPos, NOW)
    const probNeg = computeEpisodeForgetProbability(epNeg, NOW)
    assert.equal(probPos, probNeg, '|valence| 决定衰减强度，符号无关')
  })

  test('未来时间戳（异常输入）：age clamp 到 0，按当下处理', () => {
    const ep = makeEpisode({
      conversationLastMessageAt: NOW + 86400 * 1000, // 1 天后
      importance: 5,
      valence: 0,
    })
    const prob = computeEpisodeForgetProbability(ep, NOW)
    assert.ok(prob < 0.4, `prob=${prob} 异常未来时间不应触发衰减`)
  })
})

describe('applyEpisodeAlgorithmicForgetting', () => {
  test('changedIds：仅记录 status 实际变化的 episode', () => {
    const fresh = makeEpisode({
      conversationId: 'fresh',
      conversationLastMessageAt: NOW - 86400 * 1000,
      importance: 5,
      consolidationStatus: 'remembered',
    })
    const old = makeEpisode({
      conversationId: 'old',
      conversationLastMessageAt: NOW - 30 * MS_PER_MONTH, // 30 月前
      importance: 2,
      valence: 0,
      consolidationStatus: 'remembered', // 即将变 forgotten
    })
    const { episodes, changedIds } = applyEpisodeAlgorithmicForgetting([fresh, old], NOW)
    assert.deepEqual(changedIds, ['old'], '只有 old 应变')
    const oldUpdated = episodes.find(e => e.conversationId === 'old')!
    assert.equal(oldUpdated.consolidationStatus, 'forgotten')
    const freshUpdated = episodes.find(e => e.conversationId === 'fresh')!
    assert.equal(freshUpdated.consolidationStatus, 'remembered')
  })

  test('幂等：再次跑同样输入，changedIds 为空', () => {
    const old = makeEpisode({
      conversationLastMessageAt: NOW - 30 * MS_PER_MONTH,
      importance: 2,
      valence: 0,
      consolidationStatus: 'remembered',
    })
    const r1 = applyEpisodeAlgorithmicForgetting([old], NOW)
    assert.equal(r1.changedIds.length, 1)
    // r1.episodes[0].consolidationStatus 已变成 forgotten；用它再跑
    const r2 = applyEpisodeAlgorithmicForgetting(r1.episodes, NOW)
    assert.deepEqual(r2.changedIds, [], '幂等：第二次跑无变化')
  })

  test('保留所有其他字段：纯函数，不修改入参引用', () => {
    const ep = makeEpisode({
      conversationLastMessageAt: NOW - 30 * MS_PER_MONTH,
      importance: 2,
      title: '保留我的标题',
      summary: '保留我的 summary',
      keyQuotes: ['quote1'],
    })
    const { episodes } = applyEpisodeAlgorithmicForgetting([ep], NOW)
    assert.equal(episodes[0].title, '保留我的标题')
    assert.equal(episodes[0].summary, '保留我的 summary')
    assert.deepEqual(episodes[0].keyQuotes, ['quote1'])
    // 入参不应被修改
    assert.equal(ep.consolidationStatus, 'remembered', '原对象保持原状态（纯函数）')
  })
})

describe('权重稳定性回归', () => {
  test('默认权重边界点：12 月 + importance=2 + valence=2 → blurred 区间', () => {
    const ep = makeEpisode({
      conversationLastMessageAt: NOW - 12 * MS_PER_MONTH,
      importance: 2,
      valence: 2,
    })
    const prob = computeEpisodeForgetProbability(ep, NOW, DEFAULT_EPISODE_FORGETTING_WEIGHTS)
    // 文档承诺：约 0.55-0.62 范围，落在 blurred(0.4, 0.7]
    assert.ok(prob > 0.4 && prob <= 0.7, `prob=${prob} 应在 blurred 区间内`)
  })
})
