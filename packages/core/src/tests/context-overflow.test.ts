/**
 * 上下文溢出识别单测（借鉴 Pi 的压缩重试）。
 *
 * 为什么这些测试存在（Rule 9）：isContextOverflowError 决定是否触发"压缩 apiMessages 后
 * 重试一次"。误报会把普通 400（reasoning_content / thinking 参数）也拖去做无谓的压缩重试，
 * 漏报则长会话直接报错不自救。所以正负样本都用 Provider 真实映射后的 message 形态覆盖。
 *
 * @author zhi.qu
 * @date 2026-06-01
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { isContextOverflowError } from '../context-overflow'

describe('isContextOverflowError — 正样本（真实 Provider 映射后形态）', () => {
  for (const msg of [
    'Anthropic API 请求失败 (400): prompt is too long: 250000 tokens > 200000 maximum',
    "API 请求失败 (400): This model's maximum context length is 128000 tokens, however you requested 130000 tokens",
    'API 请求失败 (400): {"error":{"code":"context_length_exceeded","message":"..."}}',
    'Anthropic API 请求失败 (400): input length and max_tokens exceed context limit: 199000 + 4096 > 200000',
    'API 请求失败 (400): Please reduce the length of the messages.',
    'context window exceeded',
  ]) {
    test(`命中：${msg.slice(0, 48)}…`, () => {
      assert.equal(isContextOverflowError(new Error(msg)), true)
    })
  }

  test('显式 isContextOverflow 标记也识别', () => {
    const e = Object.assign(new Error('whatever'), { isContextOverflow: true })
    assert.equal(isContextOverflowError(e), true)
  })
})

describe('isContextOverflowError — 负样本（其它错误必须放行，不触发压缩重试）', () => {
  for (const msg of [
    'Anthropic API 密钥无效或已过期，请在设置中检查 (401)',
    '请求频率超限或额度用尽，请稍后重试 (429)',
    'Anthropic 服务端暂时不可用，请稍后重试 (500)',
    '网络连接失败，请检查网络和 API 地址',
    'reasoning_content 未在多轮 round-trip 中回传，请检查 client 是否在 assistant 消息中保留了 thinking 模型的 reasoning_content 字段 (400)',
    '该模型或服务商不支持 thinking 参数，请切换普通模型或关闭 reasoning 配置 (400): unknown parameter reasoning_effort',
    'LLM 响应超时，请重试',
  ]) {
    test(`放行：${msg.slice(0, 40)}…`, () => {
      assert.equal(isContextOverflowError(new Error(msg)), false)
    })
  }

  test('非错误输入安全返回 false', () => {
    assert.equal(isContextOverflowError(null), false)
    assert.equal(isContextOverflowError(undefined), false)
    assert.equal(isContextOverflowError(''), false)
    assert.equal(isContextOverflowError({}), false)
  })
})
