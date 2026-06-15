/**
 * `knowledge-frontmatter` 解析器单元测试。
 *
 * 核心意图（WHY）：deep-read 精读管线会在知识文件**顶部**写一行
 * `<!-- 来源相对路径: ...; 精读日期: YYYY-MM-DD -->` 注释，把 YAML frontmatter
 * 的 `---` 挤到第 3 行。历史上「frontmatter 必须是文件第一行」的检测因此整体失效，
 * 导致带 `source`/`source_type` 的批量导入产物被误当手写知识全文塞进 system prompt
 * （并触发 stuff 预算降级警告、绕过 rag_only fast-path）。
 *
 * 这些测试钉死「前导注释不得破坏 frontmatter 识别」这一行为——一旦解析器回退到
 * 严格 `startsWith('---')`，用例必须失败。
 *
 * 运行：
 *   NODE_PATH=./test-support/node_modules npx tsx --test \
 *     ../packages/core/src/tests/knowledge-frontmatter.test.ts
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { leadingFrontmatterOffset, parseFrontmatterCore, hasDeepReadProvenanceComment } from '../utils/knowledge-frontmatter'

// deep-read 写入的真实文件形态：注释 + 空行 + frontmatter + 正文
const DEEP_READ_DOC =
  '<!-- 来源相对路径: 工商业储能/交接文档.md; 精读日期: 2026-06-05 -->\n' +
  '\n' +
  '---\n' +
  'source_path: /Users/kian/Downloads/工商业储能/交接文档.xlsx\n' +
  'source_type: xlsx\n' +
  'prompt_excluded: true\n' +
  '---\n' +
  '# 正文标题\n正文内容'

describe('leadingFrontmatterOffset', () => {
  it('无前导注释的文件返回 0（行为与原来完全一致）', () => {
    assert.equal(leadingFrontmatterOffset('---\nsource: excel\n---\nbody'), 0)
    assert.equal(leadingFrontmatterOffset('# 纯 markdown\n没有注释'), 0)
    assert.equal(leadingFrontmatterOffset(''), 0)
  })

  it('跳过开头的 <!-- ... --> 注释 + 其后空白，定位到 frontmatter 的 ---', () => {
    const off = leadingFrontmatterOffset(DEEP_READ_DOC)
    assert.ok(off > 0, 'offset 应大于 0')
    assert.ok(DEEP_READ_DOC.slice(off).startsWith('---\n'), 'offset 处应正好是 frontmatter 起始')
  })

  it('未闭合的注释返回 0（不冒险跳过，安全回退到原行为）', () => {
    assert.equal(leadingFrontmatterOffset('<!-- 未闭合注释\n---\nsource: x\n---\nbody'), 0)
  })

  it('连续多段注释也能跳过', () => {
    const src = '<!-- a -->\n<!-- b -->\n\n---\nsource: pdf\n---\nbody'
    const off = leadingFrontmatterOffset(src)
    assert.ok(src.slice(off).startsWith('---\n'))
  })
})

describe('parseFrontmatterCore — deep-read 前导注释容忍', () => {
  it('注释 + 空行 + frontmatter：正确提取 meta，body 从正文起（注释剥离）', () => {
    const { meta, body } = parseFrontmatterCore(DEEP_READ_DOC)
    assert.equal(meta.source_type, 'xlsx')
    assert.equal(meta.prompt_excluded, true)
    assert.equal(meta.source_path, '/Users/kian/Downloads/工商业储能/交接文档.xlsx')
    assert.ok(body.startsWith('# 正文标题'), 'body 应从正文开始，不含注释与 frontmatter')
  })

  it('有注释但其后没有 frontmatter：meta 为空且 body 保留原文（含注释，向后兼容）', () => {
    const src = '<!-- 来源相对路径: x.md; 精读日期: 2026-06-05 -->\n\n# 只有正文\nhi'
    const { meta, body } = parseFrontmatterCore(src)
    assert.deepEqual(meta, {})
    assert.equal(body, src, '非 frontmatter 文件 body 必须原样返回（不丢注释）')
  })

  it('无注释的普通 frontmatter：回归不变', () => {
    const { meta, body } = parseFrontmatterCore('---\nsource: excel\n---\nHello')
    assert.equal(meta.source, 'excel')
    assert.equal(body, 'Hello')
  })

  it('纯正文无 frontmatter：body === 原文', () => {
    const src = '# 纯 markdown\nno frontmatter'
    const { meta, body } = parseFrontmatterCore(src)
    assert.deepEqual(meta, {})
    assert.equal(body, src)
  })
})

describe('hasDeepReadProvenanceComment — deep-read 来源注释识别', () => {
  it('识别 deep-read 顶部来源注释（含「精读日期」/「来源相对路径」）', () => {
    assert.equal(hasDeepReadProvenanceComment(DEEP_READ_DOC), true)
    // 无 frontmatter、只有注释 + 正文的 deep-read 产物（D 类，本次方案核心目标）
    const commentOnly = '<!-- 来源相对路径: 国标/x.md; 精读日期: 2026-06-05 -->\n\n# 全文转换内容\n...'
    assert.equal(hasDeepReadProvenanceComment(commentOnly), true)
  })

  it('不误伤恰好以普通 HTML 注释开头的手写文件', () => {
    assert.equal(hasDeepReadProvenanceComment('<!-- TODO: 补充符号表 -->\n# 手写知识'), false)
    assert.equal(hasDeepReadProvenanceComment('# 没有注释的手写文件'), false)
    assert.equal(hasDeepReadProvenanceComment(''), false)
  })

  it('只看开头第一段注释——正文里出现「精读日期」字样不算', () => {
    assert.equal(hasDeepReadProvenanceComment('# 标题\n正文提到精读日期但不在注释里'), false)
  })
})
