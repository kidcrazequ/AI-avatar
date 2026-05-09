/**
 * `life/density` 单元测试。
 *
 * 覆盖：
 *   - 默认权重三档（年轻 0.3 / 中年 0.15 / 老年 0.08）
 *   - 边界（年龄 0 / 24 / 25 / 54 / 55 / 100）
 *   - 异常输入（NaN / Infinity / 负数）
 *   - 自定义权重
 *   - monthsToYears 边界
 *
 * @author zhi.qu
 * @date 2026-05-09
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  eventDensityPerMonth,
  monthsToYears,
  DEFAULT_DENSITY_WEIGHTS,
  type DensityWeights,
} from '../life/density'

describe('life-density', () => {
  describe('eventDensityPerMonth - 默认权重', () => {
    it('年轻段（< 25 岁）= 0.30', () => {
      assert.equal(eventDensityPerMonth(0), 0.30)
      assert.equal(eventDensityPerMonth(10), 0.30)
      assert.equal(eventDensityPerMonth(24), 0.30)
      assert.equal(eventDensityPerMonth(24.99), 0.30)
    })

    it('中年段（[25, 55) 岁）= 0.15', () => {
      assert.equal(eventDensityPerMonth(25), 0.15)
      assert.equal(eventDensityPerMonth(40), 0.15)
      assert.equal(eventDensityPerMonth(54), 0.15)
      assert.equal(eventDensityPerMonth(54.5), 0.15)
    })

    it('老年段（>= 55 岁）= 0.08', () => {
      assert.equal(eventDensityPerMonth(55), 0.08)
      assert.equal(eventDensityPerMonth(70), 0.08)
      assert.equal(eventDensityPerMonth(100), 0.08)
    })

    it('负年龄按 0 岁处理（年轻段）', () => {
      assert.equal(eventDensityPerMonth(-5), 0.30)
      assert.equal(eventDensityPerMonth(-100), 0.30)
    })

    it('NaN / Infinity 兜底为老年段（最低概率，最保守）', () => {
      assert.equal(eventDensityPerMonth(NaN), 0.08)
      assert.equal(eventDensityPerMonth(Infinity), 0.08)
      assert.equal(eventDensityPerMonth(-Infinity), 0.08)
    })
  })

  describe('eventDensityPerMonth - 自定义权重', () => {
    it('可调整边界（把年轻段扩到 30 岁）', () => {
      const w: DensityWeights = { ...DEFAULT_DENSITY_WEIGHTS, youngBoundary: 30 }
      assert.equal(eventDensityPerMonth(28, w), 0.30, '28 岁仍属年轻段')
      assert.equal(eventDensityPerMonth(30, w), 0.15, '30 岁已进入中年段')
    })

    it('可调整概率（中年段提高到 0.20）', () => {
      const w: DensityWeights = { ...DEFAULT_DENSITY_WEIGHTS, middleProbability: 0.20 }
      assert.equal(eventDensityPerMonth(40, w), 0.20)
      assert.equal(eventDensityPerMonth(20, w), 0.30, '其他段不受影响')
    })

    it('youngBoundary === middleBoundary 时跳过中年段', () => {
      const w: DensityWeights = {
        ...DEFAULT_DENSITY_WEIGHTS,
        youngBoundary: 25,
        middleBoundary: 25,
      }
      assert.equal(eventDensityPerMonth(20, w), 0.30)
      // age=25 时 25 < 25 = false，进入第二判定 25 < 25 = false → 老年
      assert.equal(eventDensityPerMonth(25, w), 0.08)
    })
  })

  describe('monthsToYears', () => {
    it('整数月份正常向下取整', () => {
      assert.equal(monthsToYears(0), 0)
      assert.equal(monthsToYears(11), 0)
      assert.equal(monthsToYears(12), 1)
      assert.equal(monthsToYears(25), 2)
      assert.equal(monthsToYears(420), 35)
    })

    it('负数 / 非有限数兜底为 0', () => {
      assert.equal(monthsToYears(-1), 0)
      assert.equal(monthsToYears(-100), 0)
      assert.equal(monthsToYears(NaN), 0)
      assert.equal(monthsToYears(Infinity), 0)
    })
  })
})
