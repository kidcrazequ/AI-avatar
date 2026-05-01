/**
 * conversation-router 测试（PR1·P0-1 重构后）。
 *
 * 重构后路由器只做两件事：
 *   1) 图片 → 走 vision 模型 + no-rag
 *   2) 极短/确认句 → no-rag（避免空检索）
 *
 * 业务路由（chart/excel/cross-file/long-query 等）已下放给 LLM 通过工具调用决定。
 *
 * @author zhi.qu
 * @date 2026-05-01
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { routeConversation } from '../conversation-router'

describe('conversation-router', () => {
  const chatModel = { baseUrl: 'x', model: 'chat', apiKey: 'k' }
  const visionModel = { baseUrl: 'x', model: 'vision', apiKey: 'k' }

  it('短确认句应走 no-rag（避免空检索浪费 token）', () => {
    const d = routeConversation({ content: '好的', hasImages: false, chatModel, visionModel })
    assert.equal(d.contextStrategy, 'no-rag')
    assert.equal(d.modelKind, 'chat')
    assert.equal(d.reason, 'ack')
  })

  it('空输入应走 no-rag', () => {
    const d = routeConversation({ content: '   ', hasImages: false, chatModel, visionModel })
    assert.equal(d.contextStrategy, 'no-rag')
    assert.equal(d.reason, 'empty')
  })

  it('超短输入（< minRagQueryLength）应走 no-rag', () => {
    const d = routeConversation({ content: 'hi', hasImages: false, chatModel, visionModel })
    assert.equal(d.contextStrategy, 'no-rag')
    assert.equal(d.reason, 'too-short')
  })

  it('带图片问题应走 vision 模型 + no-rag', () => {
    const d = routeConversation({ content: '图里是什么', hasImages: true, chatModel, visionModel })
    assert.equal(d.model, visionModel)
    assert.equal(d.modelKind, 'vision')
    assert.equal(d.contextStrategy, 'no-rag')
    assert.equal(d.reason, 'images')
  })

  it('图表问题应走 auto（让 LLM 自主决定调 query_excel/load_skill 等工具）', () => {
    const d = routeConversation({ content: '请用图表展示 2026 年 1-3 月销售额趋势', hasImages: false, chatModel, visionModel })
    assert.equal(d.contextStrategy, 'auto')
    assert.equal(d.modelKind, 'chat')
    // chart 一致性 policy 仍由 consistency-policy 处理（独立关注点）
    assert.equal(d.policy.mode, 'chart')
  })

  it('图表追问应走 auto（让 LLM 决定是否调 chart cache 工具）', () => {
    const d = routeConversation({ content: '把上面的图改成柱状图', hasImages: false, chatModel, visionModel })
    assert.equal(d.contextStrategy, 'auto')
  })

  it('长综合问题应走 auto（让 LLM 自主调 search_knowledge / query_excel）', () => {
    const d = routeConversation({
      content: '请结合多个文件，综合比较 215 机型和 261 机型在 2026 年一季度的效率、出货量以及对应的项目策略差异，并给出总结。',
      hasImages: false,
      chatModel,
      visionModel,
    })
    assert.equal(d.contextStrategy, 'auto')
  })

  it('精确数值问题应走 auto（让 LLM 自主调 query_excel）', () => {
    const d = routeConversation({
      content: '请给出 215 机型 2026 年 1 月到 3 月分别是多少，并按月列出具体数值。',
      hasImages: false,
      chatModel,
      visionModel,
    })
    assert.equal(d.contextStrategy, 'auto')
  })

  it('带图片但未配置 vision 模型时，应回退到 chat 模型（auto 策略）', () => {
    const d = routeConversation({ content: '图里是什么', hasImages: true, chatModel })
    assert.equal(d.model, chatModel)
    assert.equal(d.modelKind, 'chat')
    // 此时不命中 vision 路由，按其余规则继续判断；因为 trimmed.length >= minRagQueryLength 走 auto
    assert.equal(d.contextStrategy, 'auto')
  })
})
