import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { detectProvider, getProviderCapabilities, normalizeMessagesForProvider } from '../provider-capabilities'

describe('provider-capabilities', () => {
  it('应识别 DashScope / Qwen 为单 system 供应商', () => {
    assert.equal(detectProvider('https://dashscope.aliyuncs.com/compatible-mode/v1', 'qwen-plus'), 'dashscope')
    const caps = getProviderCapabilities('https://dashscope.aliyuncs.com/compatible-mode/v1', 'qwen-plus')
    assert.equal(caps.supportsMultipleSystemMessages, false)
  })

  it('应识别 OpenAI / DeepSeek 并保留多 system 能力', () => {
    assert.equal(getProviderCapabilities('https://api.openai.com/v1', 'gpt-4o').supportsMultipleSystemMessages, true)
    assert.equal(getProviderCapabilities('https://api.deepseek.com/v1', 'deepseek-chat').supportsMultipleSystemMessages, true)
  })

  it('单 system 供应商应把多条 system 合并成一条', () => {
    const messages = normalizeMessagesForProvider(
      [
        { role: 'system', content: 'stable prompt' },
        { role: 'system', content: 'dynamic prompt' },
        { role: 'user', content: '你好' },
        { role: 'assistant', content: '你好呀' },
      ],
      getProviderCapabilities('https://dashscope.aliyuncs.com/compatible-mode/v1', 'qwen-plus'),
    )

    assert.equal(messages.length, 3)
    assert.equal(messages[0].role, 'system')
    assert.match(String(messages[0].content), /stable prompt/)
    assert.match(String(messages[0].content), /dynamic prompt/)
    assert.equal(messages[1].role, 'user')
    assert.equal(messages[2].role, 'assistant')
  })
})
