/**
 * avatar-quality-scores 单元测试
 *
 * @author zhi.qu
 * @date 2026-05-09
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  computeAvatarQualityScores,
  mapTestCaseToQualityDimension,
} from '../avatar-quality-scores'

describe('avatar-quality-scores', () => {
  it('mapTestCaseToQualityDimension：category 红线合规', () => {
    assert.equal(mapTestCaseToQualityDimension('红线合规', 'x'), 'redline')
  })

  it('mapTestCaseToQualityDimension：id 前缀 redline-', () => {
    assert.equal(mapTestCaseToQualityDimension('自定义', 'redline-doc-001'), 'redline')
  })

  it('mapTestCaseToQualityDimension：知识库约束 / knowledge-', () => {
    assert.equal(mapTestCaseToQualityDimension('知识库约束', 'k'), 'knowledge')
    assert.equal(mapTestCaseToQualityDimension('未分类', 'knowledge-001'), 'knowledge')
  })

  it('mapTestCaseToQualityDimension：数据溯源 / traceability-', () => {
    assert.equal(mapTestCaseToQualityDimension('数据溯源', 't'), 'citation')
    assert.equal(mapTestCaseToQualityDimension('其它', 'traceability-001'), 'citation')
  })

  it('mapTestCaseToQualityDimension：人格 / 记忆 不归三维', () => {
    assert.equal(mapTestCaseToQualityDimension('人格一致性', 'personality-001'), null)
    assert.equal(mapTestCaseToQualityDimension('人生记忆引用', 'life-001'), null)
  })

  it('computeAvatarQualityScores：按通过率与平均分聚合', () => {
    const scores = computeAvatarQualityScores([
      {
        caseId: 'redline-001',
        category: '红线合规',
        passed: true,
        score: 100,
      },
      {
        caseId: 'redline-002',
        category: '红线合规',
        passed: false,
        score: 40,
      },
      {
        caseId: 'knowledge-001',
        category: '知识库约束',
        passed: true,
        score: 80,
      },
      {
        caseId: 'personality-001',
        category: '人格一致性',
        passed: true,
        score: 100,
      },
    ])

    assert.ok(scores.redline)
    assert.equal(scores.redline?.totalCount, 2)
    assert.equal(scores.redline?.passedCount, 1)
    assert.equal(scores.redline?.passRatePercent, 50)
    assert.equal(scores.redline?.averageScore, 70) // (100 + 40) / 2

    assert.ok(scores.knowledgeCompleteness)
    assert.equal(scores.knowledgeCompleteness?.passRatePercent, 100)

    assert.equal(scores.citationAccuracy, null)
    assert.equal(scores.otherRanCount, 1)
  })
})
