import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { AgentBlueprintSchema, toA2AAgentCard } from '../agent-runtime'

describe('Phase 8 — A2A AgentCard', () => {
  it('从 Blueprint 序列化必需字段', () => {
    const bp = AgentBlueprintSchema.parse({
      identity: {
        id: 'finance-expert',
        name: '财研',
        persona: '我是财务分析专家',
        scope: '财务分析',
        description: '报表阅读与经营分析',
        redline: '不替代审计意见',
        version: '1.0.0',
      },
      skills: [
        {
          id: 'read-statement',
          source: 'local',
          path: 'skills/read-statement.md',
          keywords: ['报表', '财报'],
          when: '解读三大报表',
        },
      ],
    })
    const card = toA2AAgentCard(bp, { url: 'http://localhost:8123/agent' })
    assert.equal(card.name, '财研')
    assert.equal(card.url, 'http://localhost:8123/agent')
    assert.equal(card.version, '1.0.0')
    assert.equal(card.skills.length, 1)
    assert.equal(card.skills[0].id, 'read-statement')
    assert.deepEqual(card.skills[0].tags, ['报表', '财报'])
    assert.equal(card['x-soul-redline'], '不替代审计意见')
    assert.equal(card['x-soul-scope'], '财务分析')
  })

  it('capabilities 默认为 false', () => {
    const bp = AgentBlueprintSchema.parse({
      identity: { id: 'a', name: 'n', persona: 'p' },
    })
    const card = toA2AAgentCard(bp, { url: 'http://x' })
    assert.equal(card.capabilities.streaming, false)
    assert.equal(card.capabilities.pushNotifications, false)
  })

  it('capabilities 覆盖', () => {
    const bp = AgentBlueprintSchema.parse({
      identity: { id: 'a', name: 'n', persona: 'p' },
    })
    const card = toA2AAgentCard(bp, {
      url: 'http://x',
      capabilities: { streaming: true },
    })
    assert.equal(card.capabilities.streaming, true)
    assert.equal(card.capabilities.pushNotifications, false)
  })

  it('description 缺失时 fallback 用 persona 前 200 字', () => {
    const bp = AgentBlueprintSchema.parse({
      identity: {
        id: 'a',
        name: 'n',
        persona: '我是一段很长的人格描述，'.repeat(20),
      },
    })
    const card = toA2AAgentCard(bp, { url: 'http://x' })
    assert.ok(card.description.length > 0)
    assert.ok(card.description.length <= 200)
  })

  it('卡片可 JSON 序列化（A2A 协议要求）', () => {
    const bp = AgentBlueprintSchema.parse({
      identity: { id: 'a', name: 'n', persona: 'p' },
    })
    const card = toA2AAgentCard(bp, { url: 'http://x' })
    assert.doesNotThrow(() => JSON.stringify(card))
  })
})
