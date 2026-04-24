import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ToolBudget, buildToolPolicyPromptHints, normalizeQueryExcelArgs } from '../tool-budget'

describe('tool-budget', () => {
  it('query_excel 超预算后应被拒绝', () => {
    const budget = new ToolBudget({ maxQueryExcelCallsPerRequest: 1 })
    assert.equal(budget.tryConsume('query_excel').allowed, true)
    const blocked = budget.tryConsume('query_excel')
    assert.equal(blocked.allowed, false)
    assert.equal(blocked.reason, 'query_excel-max-calls')
    assert.equal(budget.shouldConverge(blocked.reason), true)
  })

  it('normalizeQueryExcelArgs 应稳定排序 columns 与对象键', () => {
    const a = normalizeQueryExcelArgs({ sheet: 'S1', file: 'sales', columns: ['b', 'a'], filter: { z: '1', a: '2' } })
    const b = normalizeQueryExcelArgs({ file: 'sales', filter: { a: '2', z: '1' }, columns: ['a', 'b'], sheet: 'S1' })
    assert.equal(a, b)
  })


  it('截断工具结果时应保留精简来源锚点', () => {
    const budget = new ToolBudget({ maxToolResultContextChars: 40 })
    const result = budget.truncate(
      'search_knowledge',
      '前置说明内容很长，需要被裁剪。\n\n[来源: knowledge/a.md#L10-L16]\n更多说明 [来源: knowledge/_excel/demo.json#sheet=总表&rows=2-6]'
    )
    assert.equal(result.truncated, true)
    assert.match(result.content, /截断后仍可直接复用的来源锚点/)
    assert.match(result.content, /knowledge\/a\.md#L10-L16/)
    assert.match(result.content, /knowledge\/_excel\/demo\.json#sheet=总表&rows=2-6/)
  })

  it('压缩旧工具结果时应保留来源锚点摘要', () => {
    const budget = new ToolBudget({ toolResultCompressThreshold: 20 })
    const messages = [
      { role: 'assistant' as const, content: '第 1 轮回答' },
      { role: 'tool' as const, content: '这是非常长的工具结果，包含来源。 [来源: knowledge/a.md#L10-L16]' },
      { role: 'assistant' as const, content: '第 2 轮回答' },
      { role: 'tool' as const, content: '最近一轮工具结果，不应压缩' },
      { role: 'assistant' as const, content: '第 3 轮回答' },
    ]

    budget.compress(messages)
    assert.match(String(messages[1]?.content), /压缩后仍可直接复用的来源锚点/)
    assert.match(String(messages[1]?.content), /knowledge\/a\.md#L10-L16/)
  })

  it('应生成 prompt/runtime 对齐提示', () => {
    const hint = buildToolPolicyPromptHints()
    assert.ok(hint.includes('query_excel'))
    assert.ok(hint.includes('load_skill'))
  })
})
