/**
 * Salience 评分引擎单测（v17 Phase 2c）。
 *
 * 覆盖：
 *   1. importance/emotion 加权求和正确
 *   2. forgotten → 0
 *   3. blurred 乘以 penalty
 *   4. 越界数值（NaN/负数）→ 0，不抛
 *   5. recencyFactor > 1 被 clamp 到 1
 *   6. wallClock：当前时间命中 1.0；半衰期后 0.5；多个半衰期后递减
 *   7. ageGap：窗口内 1.0；窗口外线性衰减，最低 0.1
 *   8. 排序不变量：importance 高的稳定高分；同 importance 下 recency 高的更高
 *
 * @author zhi.qu
 * @date 2026-05-17
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  computeSalience,
  computeWallClockRecencyFactor,
  computeAgeGapRecencyFactor,
  DEFAULT_SALIENCE_WEIGHTS,
  type SalienceInput,
} from '../memory/salience'

const baseInput: SalienceInput = {
  importance: 5,
  emotionMagnitude: 5,
  recencyFactor: 1,
  status: 'remembered',
}

describe('computeSalience', () => {
  test('基础加权：importance*1 + emotion*0.3 = 5 + 1.5 = 6.5', () => {
    const s = computeSalience(baseInput)
    assert.equal(s, 6.5)
  })

  test('forgotten 永远 0，无论其他字段多高', () => {
    const s = computeSalience({ ...baseInput, importance: 10, emotionMagnitude: 10, status: 'forgotten' })
    assert.equal(s, 0)
  })

  test('blurred 乘以 penalty', () => {
    const s = computeSalience({ ...baseInput, status: 'blurred' })
    assert.equal(s, 6.5 * DEFAULT_SALIENCE_WEIGHTS.blurredPenalty)
  })

  test('recencyFactor=0：整体归零', () => {
    const s = computeSalience({ ...baseInput, recencyFactor: 0 })
    assert.equal(s, 0)
  })

  test('NaN/负数 importance/emotion 视为 0，不抛', () => {
    const s1 = computeSalience({ ...baseInput, importance: NaN })
    const s2 = computeSalience({ ...baseInput, emotionMagnitude: -3 })
    // importance=0：剩 emotion*0.3*recency*1 = 5*0.3 = 1.5
    assert.equal(s1, 1.5)
    // emotion=0：剩 importance*1*recency*1 = 5
    assert.equal(s2, 5)
  })

  test('recencyFactor > 1 被 clamp 到 1', () => {
    const s = computeSalience({ ...baseInput, recencyFactor: 2 })
    assert.equal(s, 6.5)
  })

  test('排序不变量：importance=8 > importance=5（其他相同）', () => {
    const a = computeSalience({ ...baseInput, importance: 8 })
    const b = computeSalience({ ...baseInput, importance: 5 })
    assert.ok(a > b, `${a} should > ${b}`)
  })

  test('排序不变量：同 importance，recencyFactor 高的分数更高', () => {
    const fresh = computeSalience({ ...baseInput, recencyFactor: 1.0 })
    const stale = computeSalience({ ...baseInput, recencyFactor: 0.3 })
    assert.ok(fresh > stale)
  })
})

describe('computeWallClockRecencyFactor', () => {
  test('当前时间：factor = 1', () => {
    const now = 10_000_000
    const r = computeWallClockRecencyFactor(now, 30, now)
    assert.equal(r, 1)
  })

  test('正好 1 个半衰期前：factor = 0.5', () => {
    const halfLifeMs = 30 * 86400 * 1000
    const now = 1_000_000_000_000
    const r = computeWallClockRecencyFactor(now - halfLifeMs, 30, now)
    assert.ok(Math.abs(r - 0.5) < 1e-9)
  })

  test('2 个半衰期前：factor = 0.25', () => {
    const halfLifeMs = 30 * 86400 * 1000
    const now = 1_000_000_000_000
    const r = computeWallClockRecencyFactor(now - 2 * halfLifeMs, 30, now)
    assert.ok(Math.abs(r - 0.25) < 1e-9)
  })

  test('未来时间戳：clamp 到不超过 1（age = 0）', () => {
    const now = 1_000_000_000_000
    const r = computeWallClockRecencyFactor(now + 86400_000, 30, now)
    assert.equal(r, 1)
  })

  test('非法时间戳：返回 0', () => {
    assert.equal(computeWallClockRecencyFactor(0), 0)
    assert.equal(computeWallClockRecencyFactor(-1), 0)
    assert.equal(computeWallClockRecencyFactor(NaN), 0)
  })
})

describe('computeAgeGapRecencyFactor', () => {
  test('窗口内（ageGap < 5）：factor = 1', () => {
    assert.equal(computeAgeGapRecencyFactor(0), 1)
    assert.equal(computeAgeGapRecencyFactor(3), 1)
    assert.equal(computeAgeGapRecencyFactor(5), 1)
  })

  test('窗口外线性衰减：ageGap=10 → 1 - 0.05*5 = 0.75', () => {
    const r = computeAgeGapRecencyFactor(10)
    assert.ok(Math.abs(r - 0.75) < 1e-9)
  })

  test('窗口外远端：保底 0.1，不会归零', () => {
    const r = computeAgeGapRecencyFactor(100)
    assert.equal(r, 0.1)
  })

  test('负 ageGap：视为同期，factor = 1', () => {
    assert.equal(computeAgeGapRecencyFactor(-5), 1)
  })
})
