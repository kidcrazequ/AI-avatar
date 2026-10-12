/**
 * Phase 5 验证：分段 prompt + cache_control 标记
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  AgentBlueprintSchema,
  makeSegment,
  toAnthropicSystemBlocks,
  totalLength,
  buildSegmentedSystemPrompt,
  fingerprint,
} from '../agent-runtime'

describe('Phase 5 — PromptRegistry', () => {
  it('fingerprint 稳定且短', () => {
    const a = fingerprint('hello')
    const b = fingerprint('hello')
    const c = fingerprint('world')
    assert.equal(a, b)
    assert.notEqual(a, c)
    assert.equal(a.length, 16)
  })

  it('makeSegment 自动生成版本指纹', () => {
    const s = makeSegment('id1', 'body1', true)
    assert.equal(s.id, 'id1')
    assert.equal(s.body, 'body1')
    assert.equal(s.cacheable, true)
    assert.equal(s.version, fingerprint('body1'))
  })

  it('toAnthropicSystemBlocks：连续 cacheable 段合并到一个 block', () => {
    const segs = [
      makeSegment('a', 'A', true),
      makeSegment('b', 'B', true),
      makeSegment('c', 'C', false),
    ]
    const blocks = toAnthropicSystemBlocks(segs)
    assert.equal(blocks.length, 2)
    assert.match(blocks[0].text, /A/)
    assert.match(blocks[0].text, /B/)
    assert.deepEqual(blocks[0].cache_control, { type: 'ephemeral' })
    assert.equal(blocks[1].text, 'C')
    assert.equal(blocks[1].cache_control, undefined)
  })

  it('cache_control 只挂在最后一个 cacheable 组', () => {
    const segs = [
      makeSegment('a', 'A', true),  // cacheable group 1
      makeSegment('b', 'B', false), // non-cacheable
      makeSegment('c', 'C', true),  // cacheable group 2 — 这里挂 cache_control
      makeSegment('d', 'D', false), // non-cacheable
    ]
    const blocks = toAnthropicSystemBlocks(segs)
    assert.equal(blocks.length, 4)
    assert.equal(blocks[0].cache_control, undefined)
    assert.equal(blocks[1].cache_control, undefined)
    assert.deepEqual(blocks[2].cache_control, { type: 'ephemeral' })
    assert.equal(blocks[3].cache_control, undefined)
  })

  it('全 cacheable 时最后一段挂 cache_control', () => {
    const segs = [makeSegment('a', 'A', true), makeSegment('b', 'B', true)]
    const blocks = toAnthropicSystemBlocks(segs)
    assert.equal(blocks.length, 1)
    assert.deepEqual(blocks[0].cache_control, { type: 'ephemeral' })
  })

  it('全不 cacheable 时无 cache_control', () => {
    const segs = [makeSegment('a', 'A', false), makeSegment('b', 'B', false)]
    const blocks = toAnthropicSystemBlocks(segs)
    assert.equal(blocks.length, 1)
    assert.equal(blocks[0].cache_control, undefined)
  })

  it('totalLength：cacheable 比例可计算', () => {
    const segs = [
      makeSegment('a', 'AAAA', true),  // 4
      makeSegment('b', 'BB', false),   // 2
    ]
    const r = totalLength(segs)
    assert.equal(r.total, 6)
    assert.equal(r.cacheable, 4)
  })
})

describe('Phase 5 — buildSegmentedSystemPrompt', () => {
  it('段 1=persona cacheable，段 2=skill-index cacheable，段 3=knowledge 不 cache', () => {
    const bp = AgentBlueprintSchema.parse({
      identity: { id: 'a', name: '测试分身', persona: '我是测试人格' },
      skills: [
        {
          id: 'skill-a',
          source: 'local',
          path: 'skills/a.md',
          keywords: ['k1', 'k2'],
          when: '场景 X',
        },
      ],
    })
    const segs = buildSegmentedSystemPrompt({
      blueprint: bp,
      knowledgeHits: ['hit-1', 'hit-2'],
    })
    assert.equal(segs.length, 3)
    assert.equal(segs[0].id, 'soul.persona')
    assert.equal(segs[0].cacheable, true)
    assert.match(segs[0].body, /我是测试人格/)
    assert.equal(segs[1].id, 'skill.index')
    assert.equal(segs[1].cacheable, true)
    assert.match(segs[1].body, /skill-a/)
    assert.equal(segs[2].id, 'knowledge.hits')
    assert.equal(segs[2].cacheable, false)
    assert.match(segs[2].body, /hit-1/)
  })

  it('redline 注入到 persona 段', () => {
    const bp = AgentBlueprintSchema.parse({
      identity: {
        id: 'a',
        name: 'n',
        persona: 'p',
        redline: '不替代审计意见',
      },
    })
    const segs = buildSegmentedSystemPrompt({ blueprint: bp })
    assert.match(segs[0].body, /不替代审计意见/)
  })

  it('转 Anthropic system blocks：persona+skill-index 共享 cache breakpoint', () => {
    const bp = AgentBlueprintSchema.parse({
      identity: { id: 'a', name: 'n', persona: 'persona-text' },
      skills: [{ id: 's', source: 'local', path: 'p', keywords: [] }],
    })
    const segs = buildSegmentedSystemPrompt({
      blueprint: bp,
      knowledgeHits: ['hit'],
    })
    const blocks = toAnthropicSystemBlocks(segs)
    assert.equal(blocks.length, 2) // [persona+skill (cached), knowledge (uncached)]
    assert.deepEqual(blocks[0].cache_control, { type: 'ephemeral' })
    assert.equal(blocks[1].cache_control, undefined)
  })
})
