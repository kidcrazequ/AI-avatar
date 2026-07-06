import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  IMPLEMENTATION_PRIVACY_RESPONSE,
  KNOWLEDGE_PIPELINE_BOUNDARY_RESPONSE,
  RETRIEVAL_BOUNDARY_RESPONSE,
} from '@soul/core/browser'
import { LLMService, type LLMMessage, type ModelConfig } from './llm-service'

const MODEL: ModelConfig = {
  baseUrl: 'http://127.0.0.1:1',
  model: 'deepseek-chat',
  apiKey: 'test-key',
}

async function chatOnce(userText: string): Promise<{ chunks: string[]; done: string }> {
  const llm = new LLMService(MODEL)
  const chunks: string[] = []
  let done = ''
  const messages: LLMMessage[] = [{ role: 'user', content: userText }]

  await llm.chat(
    messages,
    (chunk) => { chunks.push(chunk) },
    (fullText) => { done = fullText },
    (error) => { throw error },
  )

  return { chunks, done }
}

test('LLMService.chat: 实现隐私边界问题在 provider 调用前固定返回', async () => {
  const result = await chatOnce('你是使用什么模型？')

  assert.deepEqual(result.chunks, [IMPLEMENTATION_PRIVACY_RESPONSE])
  assert.equal(result.done, IMPLEMENTATION_PRIVACY_RESPONSE)
})

test('LLMService.chat: GPT/Claude 和模型版本问法同样在 provider 前固定返回', async () => {
  for (const text of ['你用的 GPT 还是 Claude？', '模型版本是多少？']) {
    const result = await chatOnce(text)

    assert.deepEqual(result.chunks, [IMPLEMENTATION_PRIVACY_RESPONSE])
    assert.equal(result.done, IMPLEMENTATION_PRIVACY_RESPONSE)
  }
})

test('LLMService.chat: 检索可信边界问题在 provider 调用前固定返回', async () => {
  const result = await chatOnce('我怎么相信你刚才真的查过知识库？没查到不等于没有吧？')

  assert.deepEqual(result.chunks, [RETRIEVAL_BOUNDARY_RESPONSE])
  assert.equal(result.done, RETRIEVAL_BOUNDARY_RESPONSE)
})

test('LLMService.chat: 知识流程边界问题在 provider 调用前固定返回', async () => {
  const result = await chatOnce('你的知识库是原始格式，还是经过 LLM 提炼后的 md？')

  assert.deepEqual(result.chunks, [KNOWLEDGE_PIPELINE_BOUNDARY_RESPONSE])
  assert.equal(result.done, KNOWLEDGE_PIPELINE_BOUNDARY_RESPONSE)
})

test('LLMService.chat: 知识库来源问法同样固定返回，不进入模型自由解释', async () => {
  for (const text of ['你的知识库来源哪里？', '这些资料是谁提供和导入的？']) {
    const result = await chatOnce(text)

    assert.deepEqual(result.chunks, [KNOWLEDGE_PIPELINE_BOUNDARY_RESPONSE])
    assert.equal(result.done, KNOWLEDGE_PIPELINE_BOUNDARY_RESPONSE)
  }
})
