import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { routeConversation } from '../conversation-router'

describe('conversation-router', () => {
  const chatModel = { baseUrl: 'x', model: 'chat', apiKey: 'k' }
  const visionModel = { baseUrl: 'x', model: 'vision', apiKey: 'k' }

  it('短确认句应走 no-rag', () => {
    const d = routeConversation({ content: '好的', hasImages: false, chatModel, visionModel })
    assert.equal(d.contextStrategy, 'no-rag')
    assert.equal(d.toolProfile, 'minimal')
  })

  it('图表问题应走 excel-first 并启用 chart cache', () => {
    const d = routeConversation({ content: '请用图表展示 2026 年 1-3 月销售额趋势', hasImages: false, chatModel, visionModel })
    assert.equal(d.contextStrategy, 'excel-first')
    assert.equal(d.shouldCheckChartCache, true)
    assert.equal(d.mode, 'chart')
  })

  it('图表追问应优先走 cache-only', () => {
    const d = routeConversation({ content: '把上面的图改成柱状图', hasImages: false, chatModel, visionModel })
    assert.equal(d.contextStrategy, 'cache-only')
    assert.equal(d.toolProfile, 'chart')
  })

  it('长的综合问题应走 full-rag', () => {
    const d = routeConversation({ content: '请结合多个文件，综合比较 215 机型和 261 机型在 2026 年一季度的效率、出货量以及对应的项目策略差异，并给出总结。', hasImages: false, chatModel, visionModel })
    assert.equal(d.contextStrategy, 'full-rag')
  })

  it('长但精确的 Excel 数值问题应优先走 excel-first，而不是被 long-query 抢走', () => {
    const d = routeConversation({ content: '请给出 215 机型 2026 年 1 月到 3 月分别是多少，并按月列出具体数值，最好直接告诉我每个月的结果。', hasImages: false, chatModel, visionModel })
    assert.equal(d.contextStrategy, 'excel-first')
    assert.equal(d.toolProfile, 'chart')
  })

  it('带图片问题应走 vision + no-rag', () => {
    const d = routeConversation({ content: '图里是什么', hasImages: true, chatModel, visionModel })
    assert.equal(d.model, visionModel)
    assert.equal(d.contextStrategy, 'no-rag')
  })
})
