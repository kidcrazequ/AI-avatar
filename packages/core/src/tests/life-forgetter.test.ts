/**
 * `life/forgetter` 单元测试。
 *
 * 覆盖：
 *   - sigmoid 单点
 *   - 算法层 status 阈值（forgotten / blurred / remembered）
 *   - 近期 boost：相同 importance/emotion 时近期事件更易 remembered
 *   - 高重要性事件即使年龄差大也保留
 *   - generateConsolidated mock LLM：截断超长输出 + 自动补主标题
 *
 * @author zhi.qu
 * @date 2026-05-09
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  applyAlgorithmicForgetting,
  CONSOLIDATED_MAX_CHARS,
  computeForgetProbability,
  DEFAULT_FORGETTING_WEIGHTS,
  generateConsolidated,
  probabilityToStatus,
  sigmoid,
} from '../life/forgetter'
import type { LifeManifest, LifeTimelineEntry } from '../life/types'

function makeEntry(overrides: Partial<LifeTimelineEntry> = {}): LifeTimelineEntry {
  return {
    id: 'ep-0001-test',
    age: 10,
    year: 2001,
    month: 6,
    title: '测试事件',
    summary: '一句话',
    category: 'daily',
    themes: [],
    importance: 5,
    emotion: 5,
    emotionType: 'wonder',
    wordCount: 3000,
    consolidationStatus: 'remembered',
    consolidationNote: '',
    ...overrides,
  }
}

function makeManifest(overrides: Partial<LifeManifest> = {}): LifeManifest {
  return {
    schemaVersion: 1,
    displayName: '测试分身',
    personaName: '陈默',
    realNameConfirmed: true,
    nameSource: 'user',
    birthYear: 1991,
    birthMonth: 8,
    birthDay: 15,
    initialAge: 35,
    initialAgeBornAt: '2026-05-09T00:00:00Z',
    timeScale: 1,
    lastAdvancedAt: '2026-05-09T00:00:00Z',
    currentAgeMonths: 420,
    growthEnabled: true,
    gender: '男',
    birthplace: '湖北十堰',
    familyBackground: '父亲是机械厂工程师。',
    personalityArc: [],
    professionalSpine: [],
    majorRelationships: [],
    createdAt: '2026-05-09',
    totalEpisodes: 0,
    totalChars: 0,
    generationStatus: 'generating',
    lastConsolidatedAt: '2026-05-09T00:00:00Z',
    consolidationCounter: 0,
    ...overrides,
  }
}

describe('life-forgetter', () => {
  describe('sigmoid 基础', () => {
    it('sigmoid(0) ≈ 0.5', () => {
      assert.ok(Math.abs(sigmoid(0) - 0.5) < 1e-9)
    })

    it('sigmoid(+10) 接近 1', () => {
      assert.ok(sigmoid(10) > 0.999)
    })

    it('sigmoid(-10) 接近 0', () => {
      assert.ok(sigmoid(-10) < 0.001)
    })
  })

  describe('computeForgetProbability', () => {
    it('低重要性 + 远古事件 → 高遗忘概率', () => {
      const entry = makeEntry({ age: 5, importance: 1, emotion: 1 })
      const p = computeForgetProbability(entry, 50)
      assert.ok(p > 0.5, `期望 p > 0.5, 实际 ${p}`)
    })

    it('高重要性 + 高情感 → 即使年龄差大也低遗忘概率', () => {
      const entry = makeEntry({ age: 5, importance: 10, emotion: 10 })
      const p = computeForgetProbability(entry, 50)
      assert.ok(p < 0.1, `期望 p < 0.1, 实际 ${p}`)
    })

    it('近期事件（年龄差 ≤ 5）有 recency boost', () => {
      const recent = makeEntry({ age: 32, importance: 3, emotion: 3 })
      const old = makeEntry({ age: 27, importance: 3, emotion: 3 })
      const pRecent = computeForgetProbability(recent, 35)
      const pOld = computeForgetProbability(old, 35)
      assert.ok(pRecent < pOld, `近期事件应该更低遗忘概率: recent=${pRecent} old=${pOld}`)
    })
  })

  describe('probabilityToStatus 阈值', () => {
    it('p > 0.7 → forgotten', () => {
      assert.equal(probabilityToStatus(0.8), 'forgotten')
    })

    it('0.4 < p <= 0.7 → blurred', () => {
      assert.equal(probabilityToStatus(0.5), 'blurred')
    })

    it('p <= 0.4 → remembered', () => {
      assert.equal(probabilityToStatus(0.3), 'remembered')
    })

    it('阈值边界：p=0.4 → remembered（不严格大于）', () => {
      assert.equal(probabilityToStatus(0.4), 'remembered')
    })
  })

  describe('applyAlgorithmicForgetting', () => {
    it('保持入参不变（纯函数）', () => {
      const timeline = [makeEntry({ id: 'a' }), makeEntry({ id: 'b', age: 30 })]
      const original = JSON.parse(JSON.stringify(timeline))
      applyAlgorithmicForgetting(timeline, 35)
      assert.deepEqual(timeline, original, '入参 timeline 不能被修改')
    })

    it('返回新数组并标注 status', () => {
      const timeline = [
        makeEntry({ id: 'low', age: 5, importance: 1, emotion: 1 }),
        makeEntry({ id: 'high', age: 5, importance: 10, emotion: 10 }),
      ]
      const result = applyAlgorithmicForgetting(timeline, 50)
      const low = result.find(e => e.id === 'low')
      const high = result.find(e => e.id === 'high')
      assert.ok(low)
      assert.ok(high)
      assert.equal(low.consolidationStatus, 'forgotten')
      assert.equal(high.consolidationStatus, 'remembered')
    })

    it('权重可覆盖：把 forgottenThreshold 调到 0.99 → 没有 forgotten', () => {
      const timeline = Array.from({ length: 20 }, (_, i) =>
        makeEntry({ id: `ep-${i}`, age: i, importance: 0, emotion: 0 }),
      )
      const result = applyAlgorithmicForgetting(timeline, 80, {
        ...DEFAULT_FORGETTING_WEIGHTS,
        forgottenThreshold: 0.99,
      })
      assert.equal(result.filter(e => e.consolidationStatus === 'forgotten').length, 0)
    })
  })

  describe('generateConsolidated mock LLM', () => {
    it('调用 LLM 后包装主标题', async () => {
      const calls: Array<{ system: string; user: string; max: number }> = []
      const mockLLM = async (system: string, user: string, max = 200) => {
        calls.push({ system, user, max })
        return '我的童年是从一台收音机开始的。\n\n## 机械的味道\n那是一种铁锈和电流混合的气味……'
      }

      const result = await generateConsolidated({
        manifest: makeManifest(),
        timeline: [makeEntry({ consolidationStatus: 'remembered' })],
        callLLM: mockLLM,
      })

      assert.equal(calls.length, 1, '应该恰好调用一次 LLM')
      assert.ok(result.startsWith('# 我还记得的人生'), 'LLM 输出无 # 时自动补主标题')
      assert.ok(result.includes('收音机'))
    })

    it('LLM 已带主标题时不重复添加', async () => {
      const mockLLM = async () => '# 三十五岁回望\n\n## 第一段\n正文'
      const result = await generateConsolidated({
        manifest: makeManifest(),
        timeline: [makeEntry()],
        callLLM: mockLLM,
      })
      const headingCount = (result.match(/^# /gm) ?? []).length
      assert.equal(headingCount, 1, '只能有一个主标题')
    })

    it('超长输出截断到 8000 字以内', async () => {
      const oversized = '## 段落\n' + '一'.repeat(20000)
      const mockLLM = async () => oversized
      const result = await generateConsolidated({
        manifest: makeManifest(),
        timeline: [makeEntry()],
        callLLM: mockLLM,
      })
      // 含主标题的 padding 后总长应不超过 CONSOLIDATED_MAX_CHARS + 主标题 ~30 字
      assert.ok(
        result.length <= CONSOLIDATED_MAX_CHARS + 200,
        `超长输出未截断：实际 ${result.length}`,
      )
    })

    it('只把 remembered + blurred 喂给 LLM（forgotten 不出现在 prompt）', async () => {
      let capturedUser = ''
      const mockLLM = async (_s: string, u: string) => {
        capturedUser = u
        return '回忆正文'
      }
      await generateConsolidated({
        manifest: makeManifest(),
        timeline: [
          makeEntry({ id: 'a', title: '记得的事', consolidationStatus: 'remembered' }),
          makeEntry({ id: 'b', title: '模糊的事', consolidationStatus: 'blurred' }),
          makeEntry({ id: 'c', title: '忘掉的事', consolidationStatus: 'forgotten' }),
        ],
        callLLM: mockLLM,
      })
      assert.ok(capturedUser.includes('记得的事'), 'remembered 应在 prompt 中')
      assert.ok(capturedUser.includes('模糊的事'), 'blurred 应在 prompt 中')
      assert.ok(!capturedUser.includes('忘掉的事'), 'forgotten 不应出现在 prompt 中')
    })
  })
})
