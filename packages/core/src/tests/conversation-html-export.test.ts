/**
 * 会话 HTML 导出单测（借鉴 Pi export-to-HTML）。
 *
 * 为什么这些测试存在（Rule 9）：导出的 HTML 用户会直接在浏览器打开/转发，所以
 *   1) 必须 XSS 安全——LLM 输出里的 <script> 不能在导出文件里执行；
 *   2) 行内码占位不能与正常文本（如"第 0 个"）冲突；
 *   3) 不安全协议链接（javascript:）必须被丢弃；
 *   4) 常见块（标题/列表/表格/代码/引用）要正确渲染，否则不如直接导 markdown。
 *
 * @author zhi.qu
 * @date 2026-06-01
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  escapeHtml,
  markdownToSafeHtml,
  buildConversationHtml,
  extractRenderableBlocks,
} from '../conversation-html-export'

describe('escapeHtml / XSS', () => {
  test('转义 < > & " 单引号', () => {
    assert.equal(escapeHtml(`<a href="x">&'`), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;')
  })
  test('正文里的 <script> 被转义、不可执行', () => {
    const out = markdownToSafeHtml('前 <script>alert(1)</script> 后')
    assert.ok(!out.includes('<script>'))
    assert.ok(out.includes('&lt;script&gt;'))
  })
})

describe('markdownToSafeHtml — 块级', () => {
  test('标题', () => {
    assert.match(markdownToSafeHtml('## 小标题'), /<h2>小标题<\/h2>/)
  })
  test('粗体 / 斜体', () => {
    assert.match(markdownToSafeHtml('**粗** 和 *斜*'), /<strong>粗<\/strong>/)
    assert.match(markdownToSafeHtml('**粗** 和 *斜*'), /<em>斜<\/em>/)
  })
  test('行内码不与正常数字文本冲突（第 0 个）', () => {
    const out = markdownToSafeHtml('这是 `code` 的第 0 个例子')
    assert.match(out, /<code>code<\/code>/)
    assert.match(out, /第 0 个例子/) // "0" 原样保留，未被错当占位符
  })
  test('围栏代码块转义内容、含语言标签', () => {
    const out = markdownToSafeHtml('```js\nconst x = 1 < 2\n```')
    assert.match(out, /<pre><code>const x = 1 &lt; 2<\/code><\/pre>/)
    assert.match(out, /code-lang">js</)
  })
  test('安全链接渲染、不安全协议丢弃保留文字', () => {
    assert.match(markdownToSafeHtml('[百度](https://baidu.com)'), /<a href="https:\/\/baidu\.com"/)
    const evil = markdownToSafeHtml('[x](javascript:alert(1))')
    assert.ok(!evil.includes('href'))
    assert.match(evil, /x/)
  })
  test('链接 URL 含双引号也无法闭合 href 属性（转义在前，防属性注入）', () => {
    const out = markdownToSafeHtml('[x](https://a.com/"onmouseover=alert(1))')
    // 原始 " 已被 escapeHtml 成 &quot;，不会出现裸 " 提前闭合 href
    assert.ok(!/href="https:\/\/a\.com\/"[^>]*onmouseover/.test(out))
    assert.ok(out.includes('&quot;') || !out.includes('onmouseover='))
  })

  test('无序 / 有序列表', () => {
    assert.match(markdownToSafeHtml('- a\n- b'), /<ul><li>a<\/li><li>b<\/li><\/ul>/)
    assert.match(markdownToSafeHtml('1. a\n2. b'), /<ol><li>a<\/li><li>b<\/li><\/ol>/)
  })
  test('GFM 表格', () => {
    const out = markdownToSafeHtml('| 型号 | 循环 |\n| --- | --- |\n| A | 3000 |')
    assert.match(out, /<table>/)
    assert.match(out, /<th>型号<\/th>/)
    assert.match(out, /<td>3000<\/td>/)
  })
  test('引用 / 分隔线 / 段落 <br>', () => {
    assert.match(markdownToSafeHtml('> 引用'), /<blockquote>引用<\/blockquote>/)
    assert.match(markdownToSafeHtml('---'), /<hr>/)
    assert.match(markdownToSafeHtml('第一行\n第二行'), /<p>第一行<br>第二行<\/p>/)
  })
})

describe('extractRenderableBlocks + 资源替换（F8 进阶）', () => {
  const MD = '前言\n\n```chart\n{"series":[]}\n```\n\n中间\n\n```mermaid\ngraph TD; A-->B\n```\n\n```js\nconst x=1\n```'

  test('抽取所有 chart/mermaid 块（跳过普通代码块）', () => {
    const blocks = extractRenderableBlocks(MD)
    assert.equal(blocks.length, 2)
    assert.equal(blocks[0].kind, 'chart')
    assert.equal(blocks[0].code, '{"series":[]}')
    assert.equal(blocks[1].kind, 'mermaid')
    assert.match(blocks[1].code, /graph TD/)
  })

  test('resolveAsset 命中：chart/mermaid 嵌成 <figure> SVG', () => {
    const out = markdownToSafeHtml(MD, (kind) => `<svg data-${kind}></svg>`)
    assert.match(out, /<figure class="rendered-asset" data-kind="chart"><svg data-chart>/)
    assert.match(out, /<figure class="rendered-asset" data-kind="mermaid"><svg data-mermaid>/)
    assert.match(out, /<pre><code>const x=1<\/code><\/pre>/) // 普通代码块不受影响
  })

  test('resolveAsset 未命中（返回 undefined）：回退带标签代码块', () => {
    const out = markdownToSafeHtml(MD, () => undefined)
    assert.match(out, /code-lang">chart</)
    assert.doesNotMatch(out, /rendered-asset/)
  })

  test('不传 resolveAsset：chart/mermaid 仍按代码块渲染（向后兼容）', () => {
    const out = markdownToSafeHtml(MD)
    assert.match(out, /code-lang">mermaid</)
    assert.doesNotMatch(out, /rendered-asset/)
  })
})

describe('buildConversationHtml', () => {
  const input = {
    title: '储能方案讨论',
    exportedAt: '2026-06-01 12:00',
    messages: [
      { role: 'user' as const, content: '帮我对比 280Ah 和 315Ah' },
      { role: 'assistant' as const, content: '## 对比\n- 能量密度更高' },
      { role: 'assistant' as const, content: 'tool noise' }, // 仍是 assistant，保留
    ],
  }

  test('自包含 HTML：含 DOCTYPE、标题、内联样式、双角色', () => {
    const out = buildConversationHtml(input)
    assert.match(out, /^<!DOCTYPE html>/)
    assert.match(out, /<style>/)
    assert.match(out, /储能方案讨论/)
    assert.match(out, /class="msg user"/)
    assert.match(out, /class="msg assistant"/)
    assert.match(out, /2026-06-01 12:00/)
    assert.ok(!out.includes('http://') && !out.includes('https://cdn')) // 无外部资源依赖
  })

  test('标题被转义（XSS 安全）', () => {
    const out = buildConversationHtml({ ...input, title: '<img src=x onerror=alert(1)>' })
    assert.ok(!out.includes('<img src=x'))
    assert.match(out, /&lt;img/)
  })
})
