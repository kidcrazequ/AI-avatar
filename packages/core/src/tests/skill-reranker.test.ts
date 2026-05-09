/**
 * ISS SkillReranker 与 embedding 缓存序列化单测（node:test）。
 *
 * @author zhi.qu
 * @date 2026-05-09
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SkillReranker } from '../skill-reranker'
import type { ToolForRerank } from '../skill-reranker-types'
import {
  parseSkillEmbeddingCacheJson,
  serializeSkillEmbeddingCacheJson,
  stableToolDocHash,
  trimSkillEmbeddingCache,
} from '../utils/skill-embedding-store'

function makeTool(name: string, description: string): ToolForRerank {
  return {
    type: 'function',
    function: { name, description, parameters: {} },
  }
}

test('SkillReranker: skips embed when tools.length <= topN', async () => {
  let called = 0
  const embed = async (_texts: string[]) => {
    called++
    return []
  }
  const cache = new Map<string, number[]>()
  const r = new SkillReranker(embed, cache, { topN: 20 })
  const tools = Array.from({ length: 8 }, (_, i) => makeTool(`t_${i}`, `d${i}`))
  const out = await r.rerank('你好', tools)
  assert.equal(called, 0)
  assert.equal(out.length, 8)
})

test('SkillReranker: pinned MCP tools survive rerank topN squeeze', async () => {
  const embed = async (texts: string[]) =>
    texts.map((t) => {
      if (t === 'query') return [1, 0, 0]
      if (t.includes('zzz')) return [1, 0, 0]
      if (t.includes('gamma')) return [0.2, 0.9, 0]
      return [0, 1, 0]
    })
  const cache = new Map<string, number[]>()
  const topN = 4
  const r = new SkillReranker(embed, cache, { topN, embedBatchSize: 32 })
  const tools: ToolForRerank[] = [
    makeTool('list_mcp_tools', 'list'),
    makeTool('call_mcp_tool', 'call'),
    makeTool('a', 'alpha'),
    makeTool('b', 'beta zzz'),
    makeTool('c', 'gamma'),
  ]
  const out = await r.rerank('query', tools)
  assert.equal(out.length, topN)
  assert.equal(out[0].function.name, 'list_mcp_tools')
  assert.equal(out[1].function.name, 'call_mcp_tool')
  assert.ok(out.some(t => t.function.name === 'b'))
  assert.ok(!out.some(t => t.function.name === 'a'))
})

test('skill-embedding-store: stable hash + json round-trip + trim', () => {
  assert.equal(stableToolDocHash('n', 'd'), stableToolDocHash('n', 'd'))
  assert.notEqual(stableToolDocHash('n', 'd1'), stableToolDocHash('n', 'd2'))

  const m = new Map<string, number[]>()
  for (let i = 0; i < 5; i++) m.set(`k${i}`, [i, i + 1])
  const json = serializeSkillEmbeddingCacheJson(m)
  const back = parseSkillEmbeddingCacheJson(json)
  assert.equal(back.size, 5)
  assert.deepEqual(back.get('k0'), [0, 1])

  const big = new Map<string, number[]>()
  for (let i = 0; i < 10; i++) big.set(`x${i}`, [1])
  trimSkillEmbeddingCache(big, 4)
  assert.equal(big.size, 4)
})

test('SkillReranker: performance mock 100 tools under 1s', async () => {
  const embed = async (texts: string[]) => texts.map(() => [1, 0, 0, 0.5])
  const cache = new Map<string, number[]>()
  const r = new SkillReranker(embed, cache, { topN: 15, embedBatchSize: 25 })
  const tools = Array.from({ length: 100 }, (_, i) => makeTool(`tool_${i}`, `技能说明 ${i}`))
  const t0 = Date.now()
  await r.rerank('用户想算储能收益率', tools)
  const ms = Date.now() - t0
  assert.ok(ms < 1000, `rerank mock 耗时 ${ms}ms，预期 < 1000ms`)
})
