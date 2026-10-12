/**
 * 知识检索策略决策单测（借鉴 Pi 渐进式披露）。
 *
 * 为什么这些测试存在（Rule 9）：决策错误会导致大库被错误整库塞进 stable prompt（撑爆缓存）
 * 或 flag 关着却改了行为（破坏 agentic-only 现状）。核心不变量：flag 关 → 永远 'agentic'。
 *
 * @author zhi.qu
 * @date 2026-06-01
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  decideKnowledgeStrategy,
  DEFAULT_SMALL_LIBRARY_CHAR_THRESHOLD,
} from '../knowledge-strategy'

describe('decideKnowledgeStrategy', () => {
  test('flag 关闭：无论体量一律 agentic（维持 2026-05-13 现状，零行为变化）', () => {
    assert.equal(decideKnowledgeStrategy(1000), 'agentic')
    assert.equal(decideKnowledgeStrategy(10_000_000), 'agentic')
    assert.equal(decideKnowledgeStrategy(1000, { enabled: false }), 'agentic')
  })

  test('flag 开 + 小库（≤阈值）：stable-full', () => {
    assert.equal(decideKnowledgeStrategy(50_000, { enabled: true }), 'stable-full')
    assert.equal(
      decideKnowledgeStrategy(DEFAULT_SMALL_LIBRARY_CHAR_THRESHOLD, { enabled: true }),
      'stable-full',
    )
  })

  test('flag 开 + 大库（>阈值）：agentic（避免撑爆 cacheable 前缀）', () => {
    assert.equal(
      decideKnowledgeStrategy(DEFAULT_SMALL_LIBRARY_CHAR_THRESHOLD + 1, { enabled: true }),
      'agentic',
    )
  })

  test('自定义阈值生效', () => {
    assert.equal(decideKnowledgeStrategy(5000, { enabled: true, thresholdChars: 4000 }), 'agentic')
    assert.equal(decideKnowledgeStrategy(3000, { enabled: true, thresholdChars: 4000 }), 'stable-full')
  })

  test('非正/非法体量按 agentic（无内容可注入）', () => {
    assert.equal(decideKnowledgeStrategy(0, { enabled: true }), 'agentic')
    assert.equal(decideKnowledgeStrategy(-1, { enabled: true }), 'agentic')
    assert.equal(decideKnowledgeStrategy(NaN, { enabled: true }), 'agentic')
  })
})
