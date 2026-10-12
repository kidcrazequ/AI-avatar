import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildApiMessages } from '../prompt-builder'

describe('prompt-builder', () => {
  it('应把 stable + dynamic prompt 放在最前面', () => {
    const apiMessages = buildApiMessages({
      stableSystemPrompt: 'stable',
      dynamicSystemPrompts: ['dynamic'],
      history: [{ role: 'user', content: 'hi' }],
      userContent: 'question',
    })
    assert.equal(apiMessages[0].role, 'system')
    assert.equal(apiMessages[0].content, 'stable')
    assert.equal(apiMessages[1].content, 'dynamic')
    assert.equal(apiMessages.at(-1)?.role, 'user')
  })


  it('应在超出预算时优先裁剪更早历史消息', () => {
    const history = Array.from({ length: 12 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' as const : 'assistant' as const,
      content: `message-${index}-` + 'x'.repeat(120),
    }))

    const messages = buildApiMessages({
      stableSystemPrompt: 'stable prompt',
      dynamicSystemPrompts: ['dynamic prompt'],
      history,
      userContent: 'latest question',
      maxEstimatedChars: 900,
      minHistoryMessages: 4,
    })

    const contents = messages.map((message) => String(message.content))
    assert.ok(contents.some((content) => content.includes('message-8-')), '应保留较新的历史消息')
    assert.ok(contents.some((content) => content.includes('message-11-')), '应保留最新历史消息')
    assert.ok(!contents.some((content) => content.includes('message-0-')), '应裁掉更早的历史消息')
  })

  it('应压缩过早且过长的 assistant 消息', () => {
    const long = 'x'.repeat(4000)
    const apiMessages = buildApiMessages({
      stableSystemPrompt: 'stable',
      history: [
        { role: 'assistant', content: long },
        { role: 'user', content: 'u1' },
        { role: 'assistant', content: 'short' },
        { role: 'user', content: 'u2' },
        { role: 'assistant', content: 'latest' },
      ],
      userContent: 'question',
      recentFullAssistantCount: 2,
    })
    const compressed = apiMessages.find(m => m.role === 'assistant' && typeof m.content === 'string' && String(m.content).includes('早期回答已压缩'))
    assert.ok(compressed)
  })
})
