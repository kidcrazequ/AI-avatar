import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildExcelSourceAnchor,
  buildKnowledgeSourceAnchor,
  buildWholeFileKnowledgeAnchor,
  buildSourceAnchorReferenceBlock,
  ensureAnswerSourceCoverage,
  filterSourceAnchorsByAvailableContext,
  filterSourceAnchorsInText,
  isSourceAnchorCoveredByAvailable,
  extractParsedSourceAnchors,
  extractSourceAnchors,
  extractSourceAnchorsFromContent,
  extractSourceAnchorsFromMessages,
  formatSourceAnchor,
  normalizeSourceAnchorsInText,
  parseSourceAnchor,
  splitTextBySourceAnchors,
} from '../source-anchor'

describe('source-anchor', () => {
  it('能为知识片段估算文件行号范围', () => {
    const markdown = [
      '# 总览',
      '',
      '这是摘要。',
      '',
      '## 市场规模',
      '2025 年市场规模超过 500 亿元。',
      '预计 2026 年继续增长。',
      '',
      '## 结论',
      '峰谷套利是主要驱动。',
    ].join('\n')

    const anchor = buildKnowledgeSourceAnchor(
      'overview.md',
      markdown,
      '2025 年市场规模超过 500 亿元。\n预计 2026 年继续增长。',
      '市场规模',
    )

    assert.equal(anchor.kind, 'knowledge')
    assert.equal(anchor.file, 'overview.md')
    assert.equal(anchor.lineStart, 5)
    assert.equal(anchor.lineEnd, 7)
    assert.equal(formatSourceAnchor(anchor), '[来源: knowledge/overview.md#L5-L7]')
  })

  it('整文件锚点应覆盖首尾行', () => {
    const markdown = ['# 标题', '', '正文 A', '正文 B'].join('\n')
    const anchor = buildWholeFileKnowledgeAnchor('guide.md', markdown)
    assert.equal(formatSourceAnchor(anchor), '[来源: knowledge/guide.md#L1-L4]')
  })

  it('Excel 锚点应包含 sheet 和 rows', () => {
    const anchor = buildExcelSourceAnchor('dashboard', '总表', 12, 18)
    assert.equal(formatSourceAnchor(anchor), '[来源: knowledge/_excel/dashboard.json#sheet=总表&rows=12-18]')
  })

  it('应能提取文本中的来源锚点', () => {
    const text = [
      '结论 A [来源: knowledge/a.md#L10-L16]',
      '结论 B [来源: knowledge/_excel/demo.json#sheet=总表&rows=2-6]',
    ].join('\n')

    assert.deepEqual(extractSourceAnchors(text), [
      '[来源: knowledge/a.md#L10-L16]',
      '[来源: knowledge/_excel/demo.json#sheet=总表&rows=2-6]',
    ])
  })

  it('应能解析知识与 Excel 锚点', () => {
    assert.deepEqual(parseSourceAnchor('[来源: knowledge/a.md#L10-L16]'), {
      kind: 'knowledge',
      file: 'a.md',
      lineStart: 10,
      lineEnd: 16,
    })

    assert.deepEqual(parseSourceAnchor('[来源: knowledge/_excel/demo.json#sheet=总表&rows=2-6]'), {
      kind: 'excel',
      file: 'demo',
      sheet: '总表',
      rowStart: 2,
      rowEnd: 6,
    })
  })

  it('应能输出带结构化信息的锚点列表', () => {
    const text = '见这里 [来源: knowledge/a.md#L10-L16]，再看 [来源: knowledge/_excel/demo.json#sheet=总表&rows=2-6]'
    const parsed = extractParsedSourceAnchors(text)
    assert.equal(parsed.length, 2)
    assert.equal(parsed[0]?.anchor.kind, 'knowledge')
    assert.equal(parsed[1]?.anchor.kind, 'excel')
  })

  it('应能把普通文本和来源锚点切成可渲染片段', () => {
    const segments = splitTextBySourceAnchors('结论 A [来源: knowledge/a.md#L10-L16] 结论 B')
    assert.equal(segments.length, 3)
    assert.deepEqual(segments[0], { type: 'text', text: '结论 A ' })
    assert.equal(segments[1]?.type, 'anchor')
    assert.deepEqual(segments[2], { type: 'text', text: ' 结论 B' })
  })


  it('应能按谓词移除无效来源锚点', () => {
    const result = filterSourceAnchorsInText(
      '结论 A [来源: knowledge/a.md#L10-L16]，结论 B [来源: knowledge/b.md#L3-L8]。',
      (anchor) => anchor.kind === 'knowledge' && anchor.file === 'a.md'
    )

    assert.equal(result.text, '结论 A [来源: knowledge/a.md#L10-L16]，结论 B。')
    assert.deepEqual(result.keptAnchors, ['[来源: knowledge/a.md#L10-L16]'])
    assert.deepEqual(result.removedAnchors, ['[来源: knowledge/b.md#L3-L8]'])
    assert.equal(result.removedCount, 1)
  })

  it('移除来源锚点后应清理多余空白', () => {
    const result = filterSourceAnchorsInText(
      '结论 A [来源: knowledge/a.md#L10-L16]\n\n[来源: knowledge/b.md#L3-L8]\n下一句',
      (anchor) => anchor.kind === 'knowledge' && anchor.file === 'a.md'
    )

    assert.equal(result.text, '结论 A [来源: knowledge/a.md#L10-L16]\n\n下一句')
  })


  it('应规范化并去重连续重复来源锚点', () => {
    const result = normalizeSourceAnchorsInText(
      '结论 A [来源: knowledge/a.md#L10-L16]， [来源: knowledge/a.md#L10-L16]；[来源: knowledge/a.md#L10-L16]'
    )
    assert.equal(result.text, '结论 A [来源: knowledge/a.md#L10-L16]')
    assert.deepEqual(result.anchors, ['[来源: knowledge/a.md#L10-L16]'])
    assert.equal(result.dedupedCount, 2)
  })

  it('应能从复杂 content / messages 中提取来源锚点', () => {
    const content = [
      { type: 'text', text: '来自知识库 [来源: knowledge/a.md#L10-L16]' },
      { type: 'text', text: '再看表格 [来源: knowledge/_excel/demo.json#sheet=总表&rows=2-6]' },
    ]
    assert.deepEqual(extractSourceAnchorsFromContent(content), [
      '[来源: knowledge/a.md#L10-L16]',
      '[来源: knowledge/_excel/demo.json#sheet=总表&rows=2-6]',
    ])
    assert.deepEqual(extractSourceAnchorsFromMessages([{ content }]), [
      '[来源: knowledge/a.md#L10-L16]',
      '[来源: knowledge/_excel/demo.json#sheet=总表&rows=2-6]',
    ])
  })


  it('应能把可用来源锚点压成精简参考块', () => {
    const block = buildSourceAnchorReferenceBlock([
      '[来源: knowledge/a.md#L10-L16]',
      '[来源: knowledge/a.md#L10-L16]',
      '[来源: knowledge/_excel/demo.json#sheet=总表&rows=2-6]',
    ], {
      title: '参考来源',
      compact: true,
      maxAnchors: 2,
    })

    assert.equal(
      block,
      '参考来源：[来源: knowledge/a.md#L10-L16]；[来源: knowledge/_excel/demo.json#sheet=总表&rows=2-6]'
    )
  })

  it('应仅保留被当前上下文覆盖的知识锚点', () => {
    const result = filterSourceAnchorsByAvailableContext(
      '结论 A [来源: knowledge/a.md#L12-L14]；结论 B [来源: knowledge/b.md#L3-L8]。',
      ['[来源: knowledge/a.md#L10-L16]']
    )

    assert.equal(result.text, '结论 A [来源: knowledge/a.md#L12-L14]；结论 B。')
    assert.deepEqual(result.keptAnchors, ['[来源: knowledge/a.md#L12-L14]'])
    assert.deepEqual(result.removedAnchors, ['[来源: knowledge/b.md#L3-L8]'])
    assert.equal(result.removedUnsupportedCount, 1)
  })

  it('应仅保留被当前上下文覆盖的 Excel 锚点', () => {
    const result = filterSourceAnchorsByAvailableContext(
      '总表结论 [来源: knowledge/_excel/demo.json#sheet=总表&rows=3-4]；分表结论 [来源: knowledge/_excel/demo.json#sheet=分表&rows=3-4]。',
      ['[来源: knowledge/_excel/demo.json#sheet=总表&rows=2-6]']
    )

    assert.equal(result.text, '总表结论 [来源: knowledge/_excel/demo.json#sheet=总表&rows=3-4]；分表结论。')
    assert.deepEqual(result.keptAnchors, ['[来源: knowledge/_excel/demo.json#sheet=总表&rows=3-4]'])
    assert.deepEqual(result.removedAnchors, ['[来源: knowledge/_excel/demo.json#sheet=分表&rows=3-4]'])
  })

  it('范围覆盖判断应允许更窄的答案锚点复用更宽的上下文锚点', () => {
    assert.equal(
      isSourceAnchorCoveredByAvailable(
        { kind: 'knowledge', file: 'a.md', lineStart: 12, lineEnd: 14 },
        { kind: 'knowledge', file: 'a.md', lineStart: 10, lineEnd: 20 },
      ),
      true,
    )

    assert.equal(
      isSourceAnchorCoveredByAvailable(
        { kind: 'excel', file: 'demo', sheet: '总表', rowStart: 3, rowEnd: 4 },
        { kind: 'excel', file: 'demo', sheet: '总表', rowStart: 2, rowEnd: 6 },
      ),
      true,
    )

    assert.equal(
      isSourceAnchorCoveredByAvailable(
        { kind: 'knowledge', file: 'a.md', lineStart: 1, lineEnd: 30 },
        { kind: 'knowledge', file: 'a.md', lineStart: 10, lineEnd: 20 },
      ),
      false,
    )
  })

  it('当上下文有来源但答案未引用时，应追加兜底提示', () => {
    const result = ensureAnswerSourceCoverage(
      '2026 年效率提升到 93%，同比提升 4 个百分点。',
      ['[来源: knowledge/a.md#L10-L16]']
    )
    assert.match(result.text, /参考来源：\[来源: knowledge\/a\.md#L10-L16\]/)
    assert.match(result.text, /未直接标注来源/)
    assert.equal(result.addedFallback, true)
    assert.deepEqual(result.availableAnchors, ['[来源: knowledge/a.md#L10-L16]'])
  })

  it('当答案已带来源时，不应追加兜底提示', () => {
    const result = ensureAnswerSourceCoverage(
      '2026 年效率提升到 93%。[来源: knowledge/a.md#L10-L16]',
      ['[来源: knowledge/a.md#L10-L16]']
    )
    assert.equal(result.addedFallback, false)
    assert.doesNotMatch(result.text, /未直接标注来源/)
  })

})
