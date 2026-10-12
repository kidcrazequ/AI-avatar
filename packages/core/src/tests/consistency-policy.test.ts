import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { deriveSeedFromContent, resolvePolicy, shouldEnableChartConsistencyMode } from '../consistency-policy'

describe('consistency-policy', () => {
  it('图表 + 时间范围问题应命中 chart mode', () => {
    assert.equal(shouldEnableChartConsistencyMode('请用图表展示 2026 年 1-3 月销量趋势', false), true)
    const policy = resolvePolicy({ content: '请用图表展示 2026 年 1-3 月销量趋势', hasImages: false })
    assert.equal(policy.mode, 'chart')
    assert.equal(policy.skipRag, true)
    assert.equal(policy.skipNudge, true)
    assert.ok(policy.hintToInject?.includes('图表一致性模式'))
  })

  it('同样内容应派生稳定 seed', () => {
    const a = deriveSeedFromContent('测试问题')
    const b = deriveSeedFromContent('测试问题')
    assert.equal(a, b)
  })
})
