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
import { routeConversation, detectFanOutSignal } from '../conversation-router'

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

  /**
   * detectFanOutSignal（2026-05-22 Mavis 借鉴）：判断本轮是否建议派 verifier 子代理。
   * 不锁定具体关键词列表（实现可演化），只锁定 WHY——
   *   - 数据类问题（出货量 / 通过率）必须命中
   *   - 来源标注请求必须命中
   *   - 寒暄 / 普通讨论不能命中（避免每条都派 verifier，浪费 token）
   *   - 高风险关键词但内容很短（< 12 字符）不命中（短确认句无实质内容可复核）
   */
  describe('detectFanOutSignal', () => {
    it('问出货量 / 通过率 等数据类问题，应建议 verifier fan-out', () => {
      assert.notEqual(detectFanOutSignal('过去半年 262 柜体的通过率是多少？'), null)
      assert.notEqual(detectFanOutSignal('帮我看一下出货量数据，按月汇总'), null)
    })

    it('要求标到原始 sheet / 列出引用来源，应建议 verifier fan-out', () => {
      assert.notEqual(detectFanOutSignal('每个数字标到原始 sheet 里的位置'), null)
      assert.notEqual(detectFanOutSignal('给我列引用出处，按文件路径分组'), null)
    })

    it('寒暄 / 一般讨论不应建议 fan-out（避免误派浪费 token）', () => {
      assert.equal(detectFanOutSignal('你怎么看这件事'), null)
      assert.equal(detectFanOutSignal('帮我想想思路'), null)
      assert.equal(detectFanOutSignal('好的我知道了'), null)
    })

    it('短输入（< 12 字符）即使含高风险关键词也不建议 fan-out', () => {
      // 短确认句即使形式上含"来源"等词，也无实质数据可复核
      assert.equal(detectFanOutSignal('多少'), null)
      assert.equal(detectFanOutSignal('几个？'), null)
    })

    it('routeConversation 默认路径应附带 fanOut 字段（high-stakes 时为 signal）', () => {
      const d = routeConversation({
        content: '264 柜体过去 6 个月的通过率多少，每个数字标到原始 sheet',
        hasImages: false,
        chatModel,
        visionModel,
      })
      assert.equal(d.contextStrategy, 'auto')
      assert.notEqual(d.fanOut, null)
      assert.equal(d.fanOut?.kind, 'verifier')
    })

    it('routeConversation 非 high-stakes 时 fanOut 为 null', () => {
      const d = routeConversation({
        content: '帮我介绍一下你能做什么',
        hasImages: false,
        chatModel,
        visionModel,
      })
      assert.equal(d.fanOut, null)
    })
  })
})
