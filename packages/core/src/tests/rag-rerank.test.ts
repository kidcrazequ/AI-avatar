import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { computeJaccardSimilarity, rerankChunksWithDiversity } from '../rag-rerank'

describe('rag-rerank', () => {
  it('应去掉高度重复片段', () => {
    const results = rerankChunksWithDiversity([
      { file: 'a.md', heading: 'A1', content: '储能系统 215 机型 2026年1月效率 90.1%', score: 0.99 },
      { file: 'a.md', heading: 'A2', content: '储能系统 215 机型 2026年1月效率 90.1%，来源于月报', score: 0.98 },
      { file: 'b.md', heading: 'B1', content: '项目背景与客户画像', score: 0.6 },
    ], { maxChunks: 3, similarityThreshold: 0.75 })
    assert.equal(results.length, 2)
  })

  it('在有足够来源时应尽量覆盖多个文件', () => {
    const results = rerankChunksWithDiversity([
      { file: 'a.md', heading: 'A1', content: 'A 片段 1', score: 0.99 },
      { file: 'a.md', heading: 'A2', content: 'A 片段 2', score: 0.95 },
      { file: 'a.md', heading: 'A3', content: 'A 片段 3', score: 0.93 },
      { file: 'b.md', heading: 'B1', content: 'B 片段 1', score: 0.88 },
      { file: 'c.md', heading: 'C1', content: 'C 片段 1', score: 0.84 },
    ], { maxChunks: 4, maxPerFile: 2, minDistinctFiles: 3 })
    assert.ok(new Set(results.map((r) => r.file)).size >= 3)
  })

  it('jaccard 相似度对明显相似文本应大于 0', () => {
    const sim = computeJaccardSimilarity('储能系统 215 机型 2026年1月效率 90.1%', '215 机型 2026年1月效率 90.1% 来源于储能系统月报')
    assert.ok(sim > 0)
  })
})
