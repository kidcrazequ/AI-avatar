import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildKnowledgeLinkGraph, expandLinkedFiles, extractExplicitLinks, selectRelevantSnippet } from '../link-graph'

describe('link-graph', () => {
  const knownFiles = [
    'a/overview.md',
    'a/specs.md',
    'b/policy.md',
    'b/ens-l262.md',
  ]

  it('应解析 markdown link、wikilink 和 @file 引用', () => {
    const links = extractExplicitLinks(
      'a/overview.md',
      [
        '参见 [规格](./specs.md)',
        '另见 [[policy]]',
        '补充 @file:knowledge/b/ens-l262.md',
      ].join('\n'),
      knownFiles,
    )

    assert.deepEqual(links, ['a/specs.md', 'b/ens-l262.md', 'b/policy.md'])
  })

  it('应基于显式引用构建图并做双向扩展', () => {
    const graph = buildKnowledgeLinkGraph([
      { file: 'a/overview.md', content: '参见 [规格](./specs.md)\n另见 [[policy]]' },
      { file: 'a/specs.md', content: '规格正文' },
      { file: 'b/policy.md', content: '补充 @file:knowledge/b/ens-l262.md' },
      { file: 'b/ens-l262.md', content: '型号说明' },
    ])

    const expanded = expandLinkedFiles(graph, ['a/overview.md'], { maxDepth: 2, maxFiles: 4 })
    assert.deepEqual(expanded.map((item) => item.file), ['a/specs.md', 'b/policy.md', 'b/ens-l262.md'])
    assert.equal(expanded[0]?.depth, 1)
    assert.equal(expanded[2]?.depth, 2)
  })

  it('应优先挑选与问题更相关的段落', () => {
    const markdown = [
      '# 背景',
      '这里主要描述项目背景和客户画像。',
      '',
      '# 2026年1月效率',
      '215 机型 2026 年 1 月效率为 90.1%，261 机型效率为 91.4%。',
      '',
      '# 其他',
      '这里是别的内容。',
    ].join('\n')

    const snippet = selectRelevantSnippet(markdown, '请告诉我 215 机型 2026 年 1 月效率')
    assert.equal(snippet.heading, '2026年1月效率')
    assert.match(snippet.content, /90\.1%/)
  })
})
