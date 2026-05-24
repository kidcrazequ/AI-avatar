/**
 * 文档生成 IR 与渲染器单元测试
 *
 * 覆盖 4 个核心模块：
 *   1. validateIR：宽进严出的 IR 校验器（错误聚合 + blockIndex 标定）
 *   2. parseIR：markdown → IR 解析器（行驱动状态机，永不抛错）
 *   3. renderMarkdown：IR → markdown 渲染器（roundtrip 一致性）
 *   4. renderHtml + escapeHtml：IR → HTML 渲染器（XSS 防护 + 块覆盖 + 模板加载）
 *
 * 测试设计原则：
 *   - 每个测试独立沙盒（os.tmpdir + crypto.randomUUID），互不污染
 *   - HTML 测试用 includes / regex 而非完整字符串匹配，
 *     避免渲染器内部空白格式微调时全表破坏
 *   - 不 mock fs：真实写入临时 CSS 文件触发 loadTemplateCss
 *
 * 运行方式：
 *   cd packages/core && npm run build
 *   node --test dist/tests/document-ir.test.js
 *
 * @author zhi.qu
 * @date 2026-05-08
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

import { validateIR, type DocumentIR } from '../document/ir-schema'
import { parseIR } from '../document/ir-parser'
import { renderMarkdown } from '../document/renderers/markdown-renderer'
import { renderHtml, escapeHtml } from '../document/renderers/html-renderer'
import { loadTemplateCss, resolveTemplatePath } from '../document/renderers/template-loader'

// ---------------------------------------------------------------------------
// 沙盒辅助
// ---------------------------------------------------------------------------

interface AvatarSandbox {
  avatarRoot: string
  cleanup: () => void
}

function createAvatarSandbox(): AvatarSandbox {
  const root = path.join(os.tmpdir(), `soul-doc-test-${crypto.randomUUID()}`)
  fs.mkdirSync(path.join(root, 'document-templates'), { recursive: true })
  return {
    avatarRoot: root,
    cleanup: () => {
      try { fs.rmSync(root, { recursive: true, force: true }) } catch { /* ignore */ }
    },
  }
}

// ===========================================================================
// 1. validateIR
// ===========================================================================

describe('validateIR', () => {
  it('非对象输入返回 valid=false', () => {
    const r = validateIR(null)
    assert.equal(r.valid, false)
    assert.ok(r.errors.length >= 1)
  })

  it('缺 metadata 返回错误', () => {
    const r = validateIR({ blocks: [] })
    assert.equal(r.valid, false)
    assert.ok(r.errors.some(e => e.message.includes('metadata')))
  })

  it('metadata.title 为空字符串返回错误', () => {
    const r = validateIR({ metadata: { title: '   ' }, blocks: [] })
    assert.equal(r.valid, false)
    assert.ok(r.errors.some(e => e.message.includes('title')))
  })

  it('blocks 不是数组返回错误并短路', () => {
    const r = validateIR({ metadata: { title: 't' }, blocks: 'oops' })
    assert.equal(r.valid, false)
    assert.ok(r.errors.some(e => e.message.includes('blocks')))
  })

  it('全部块类型有效时通过', () => {
    const ir = {
      metadata: { title: '测试', author: '小堵', date: '2026-05-08', template: 'default' },
      blocks: [
        { type: 'heading', level: 1, text: '一级标题' },
        { type: 'heading', level: 6, text: '六级' },
        { type: 'paragraph', text: '段落\n第二行' },
        { type: 'list', ordered: false, items: ['a', 'b'] },
        { type: 'list', ordered: true, items: ['1', '2'] },
        { type: 'table', headers: ['列1', '列2'], rows: [['a', 1], [null, 'b']] },
        { type: 'code', code: 'console.log(1)', language: 'ts' },
        { type: 'code', code: 'plain' },
        { type: 'callout', level: 'warning', text: '注意' },
        { type: 'callout', level: 'success', text: '已完成' },
        { type: 'cite', source: 'knowledge/a.md', page: 12, text: '引文' },
        { type: 'cite', source: 'knowledge/b.md', text: '无页码' },
        { type: 'image', src: 'foo.png', alt: 'a', caption: 'c' },
        { type: 'divider' },
      ],
    }
    const r = validateIR(ir)
    assert.equal(r.valid, true, r.errors.map(e => e.message).join('\n'))
    assert.equal(r.errors.length, 0)
  })

  it('heading.level 越界报错', () => {
    const r = validateIR({
      metadata: { title: 't' },
      blocks: [{ type: 'heading', level: 7, text: '' }],
    })
    assert.equal(r.valid, false)
    assert.ok(r.errors.some(e => e.blockIndex === 0 && e.message.includes('level')))
  })

  it('table 单元值类型非法报错', () => {
    const r = validateIR({
      metadata: { title: 't' },
      blocks: [{ type: 'table', headers: ['h'], rows: [[{ nested: true }]] }],
    })
    assert.equal(r.valid, false)
    assert.ok(r.errors.some(e => e.blockIndex === 0))
  })

  it('callout.level 非法报错', () => {
    const r = validateIR({
      metadata: { title: 't' },
      blocks: [{ type: 'callout', level: 'critical', text: 'x' }],
    })
    assert.equal(r.valid, false)
    assert.ok(r.errors.some(e => e.message.includes('level')))
  })

  it('未知 type 块报错', () => {
    const r = validateIR({
      metadata: { title: 't' },
      blocks: [{ type: 'magic', text: 'x' }],
    })
    assert.equal(r.valid, false)
  })

  it('多块错误聚合（不短路），blockIndex 准确', () => {
    const r = validateIR({
      metadata: { title: 't' },
      blocks: [
        { type: 'heading', level: 1, text: 'ok' },
        { type: 'heading', level: 9, text: 'bad' },
        { type: 'paragraph', text: 'ok' },
        { type: 'callout', level: 'BAD', text: 'x' },
      ],
    })
    assert.equal(r.valid, false)
    const idxs = r.errors.map(e => e.blockIndex).sort()
    assert.ok(idxs.includes(1) && idxs.includes(3), '应同时报告 block 1 和 block 3 错误')
  })
})

// ===========================================================================
// 2. parseIR
// ===========================================================================

describe('parseIR', () => {
  it('解析 frontmatter title', () => {
    const { ir, warnings } = parseIR('---\ntitle: 测试\n---\n')
    assert.equal(ir.metadata.title, '测试')
    assert.equal(warnings.length, 0)
  })

  it('缺失 title 抛 warning 但不抛错', () => {
    const { ir, warnings } = parseIR('---\nauthor: zhi\n---\nbody')
    assert.equal(ir.metadata.title, '')
    assert.ok(warnings.some(w => w.message.includes('title')))
  })

  it('解析 6 级标题', () => {
    const { ir } = parseIR('---\ntitle: t\n---\n# H1\n\n## H2\n\n### H3\n\n#### H4\n\n##### H5\n\n###### H6\n')
    const headings = ir.blocks.filter(b => b.type === 'heading')
    assert.equal(headings.length, 6)
    assert.deepEqual(
      headings.map(h => h.type === 'heading' ? h.level : -1),
      [1, 2, 3, 4, 5, 6],
    )
  })

  it('解析无序与有序列表', () => {
    const { ir } = parseIR('---\ntitle: t\n---\n- a\n- b\n\n1. x\n2. y\n')
    const lists = ir.blocks.filter(b => b.type === 'list')
    assert.equal(lists.length, 2)
    assert.equal(lists[0].type === 'list' && lists[0].ordered, false)
    assert.equal(lists[1].type === 'list' && lists[1].ordered, true)
  })

  it('解析 GFM 表格 + 数字单元格强制转 number', () => {
    const md = '---\ntitle: t\n---\n| 名称 | 数量 |\n|---|---|\n| A | 42 |\n| B | 3.14 |\n'
    const { ir } = parseIR(md)
    const table = ir.blocks.find(b => b.type === 'table')
    assert.ok(table && table.type === 'table')
    if (table.type === 'table') {
      assert.deepEqual(table.headers, ['名称', '数量'])
      assert.equal(table.rows[0][0], 'A')
      assert.equal(table.rows[0][1], 42)
      assert.equal(table.rows[1][1], 3.14)
    }
  })

  it('解析围栏代码块（含语言）', () => {
    const md = '---\ntitle: t\n---\n```ts\nconst x = 1\n```\n'
    const { ir } = parseIR(md)
    const code = ir.blocks.find(b => b.type === 'code')
    assert.ok(code && code.type === 'code')
    if (code.type === 'code') {
      assert.equal(code.language, 'ts')
      assert.equal(code.code, 'const x = 1')
    }
  })

  it('解析 callout 容器', () => {
    const md = '---\ntitle: t\n---\n:::callout warning\n注意事项\n多行\n:::\n'
    const { ir } = parseIR(md)
    const callout = ir.blocks.find(b => b.type === 'callout')
    assert.ok(callout && callout.type === 'callout')
    if (callout.type === 'callout') {
      assert.equal(callout.level, 'warning')
      assert.ok(callout.text.includes('注意事项'))
    }
  })

  it('兼容模型误输出的 blockquote 包裹 callout 容器', () => {
    const md = '---\ntitle: t\n---\n> :::callout warning\n> **注意**：缺少电价参数\n> :::\n'
    const { ir } = parseIR(md)
    const callout = ir.blocks.find(b => b.type === 'callout')
    assert.ok(callout && callout.type === 'callout')
    if (callout.type === 'callout') {
      assert.equal(callout.level, 'warning')
      assert.equal(callout.text, '**注意**：缺少电价参数')
    }
  })

  it('解析 cite 容器（含 source + page）', () => {
    const md = '---\ntitle: t\n---\n:::cite source="knowledge/a.md" page=12\n引文内容\n:::\n'
    const { ir } = parseIR(md)
    const cite = ir.blocks.find(b => b.type === 'cite')
    assert.ok(cite && cite.type === 'cite')
    if (cite.type === 'cite') {
      assert.equal(cite.source, 'knowledge/a.md')
      assert.equal(cite.page, 12)
      assert.equal(cite.text, '引文内容')
    }
  })

  it('解析图片块', () => {
    const md = '---\ntitle: t\n---\n![alt](foo.png "标题")\n'
    const { ir } = parseIR(md)
    const image = ir.blocks.find(b => b.type === 'image')
    assert.ok(image && image.type === 'image')
    if (image.type === 'image') {
      assert.equal(image.src, 'foo.png')
      assert.equal(image.alt, 'alt')
      assert.equal(image.caption, '标题')
    }
  })

  it('解析水平分割线', () => {
    const { ir } = parseIR('---\ntitle: t\n---\n段落 1\n\n---\n\n段落 2\n')
    const dividers = ir.blocks.filter(b => b.type === 'divider')
    assert.equal(dividers.length, 1)
  })

  it('未识别行回退为 paragraph，永不抛错', () => {
    const { ir } = parseIR('---\ntitle: t\n---\n这是普通段落\n含点 ASCII : 没破坏\n')
    const paragraphs = ir.blocks.filter(b => b.type === 'paragraph')
    assert.ok(paragraphs.length >= 1)
  })
})

// ===========================================================================
// 3. renderMarkdown roundtrip
// ===========================================================================

describe('renderMarkdown roundtrip', () => {
  it('简单 IR 通过 render→parse 后基础 block 字段一致（不含 callout/cite，见单独用例）', () => {
    // 注意：自 2026-05-22 起 renderMarkdown 把 callout/cite 渲染成标准 GFM blockquote
    // (`>` 前缀 + `[!WARNING]` Alert)，**不保 IR roundtrip**——这是产品决策：用户保存的 .md
    // 文件优先兼容 GitHub / VS Code / 桌面端预览，不能让 `:::cite` directive 在标准渲染器
    // 里显示成裸文本。所以这里去掉 callout，单独用例改为断言"渲染成 blockquote 格式"。
    const ir: DocumentIR = {
      metadata: { title: '我的文档', author: '小堵', date: '2026-05-08' },
      blocks: [
        { type: 'heading', level: 1, text: '总览' },
        { type: 'paragraph', text: '这是一段文字。' },
        { type: 'list', ordered: false, items: ['项 1', '项 2'] },
        { type: 'divider' },
      ],
    }
    const md = renderMarkdown(ir)
    const { ir: ir2 } = parseIR(md)
    assert.equal(ir2.metadata.title, ir.metadata.title)
    assert.equal(ir2.metadata.author, ir.metadata.author)
    assert.equal(ir2.blocks.length, ir.blocks.length)
    for (let i = 0; i < ir.blocks.length; i++) {
      assert.equal(ir2.blocks[i].type, ir.blocks[i].type, `块 ${i} 类型一致`)
    }
  })

  it('表格 roundtrip：数字单元保留 number 类型', () => {
    const ir: DocumentIR = {
      metadata: { title: '表格' },
      blocks: [{ type: 'table', headers: ['名', '数'], rows: [['A', 1], ['B', 2.5]] }],
    }
    const md = renderMarkdown(ir)
    const { ir: ir2 } = parseIR(md)
    const t = ir2.blocks[0]
    assert.ok(t.type === 'table')
    if (t.type === 'table') {
      assert.equal(t.rows[0][1], 1)
      assert.equal(t.rows[1][1], 2.5)
    }
  })

  it('cite 块渲染成标准 GFM blockquote（含 source、页码、原文）', () => {
    // 2026-05-22 改动：cite 不再用 `:::cite source="..." page=N` directive，因为标准 markdown
    // 渲染器（GitHub / VS Code / 桌面端预览）不认识 `:::`，会显示成裸文本。改用 blockquote：
    // > **来源**：`knowledge/a.md` (p.7)
    // >
    // > 原文片段
    // 这里断言关键字符串都出现，而不是 IR roundtrip（renderer 已不保 roundtrip，by design）。
    const ir: DocumentIR = {
      metadata: { title: '引用测试' },
      blocks: [
        { type: 'cite', source: 'knowledge/a.md', page: 7, text: '原文片段' },
      ],
    }
    const md = renderMarkdown(ir)
    // 关键内容都在；且不再出现 `:::cite` directive 文本
    assert.match(md, /> \*\*来源\*\*：`knowledge\/a\.md` \(p\.7\)/, '来源行使用 blockquote + 反引号包裹路径')
    assert.match(md, /> 原文片段/, '原文每行加 `> ` 前缀')
    assert.ok(!md.includes(':::cite'), '不再输出 :::cite directive（标准渲染器不识别）')
  })

  it('callout 块渲染成 GFM Alert（GitHub 原生支持，标准渲染器回退为 blockquote）', () => {
    // 2026-05-22 改动：与 cite 同理，`:::callout warning` directive 改成 `> [!WARNING]` GFM Alert
    const ir: DocumentIR = {
      metadata: { title: 'callout 测试' },
      blocks: [
        { type: 'callout', level: 'warning', text: '注意事项' },
        { type: 'callout', level: 'danger', text: '高危操作' },
      ],
    }
    const md = renderMarkdown(ir)
    assert.match(md, /> \[!WARNING\]\n> 注意事项/, 'warning → GFM Alert WARNING')
    assert.match(md, /> \[!CAUTION\]\n> 高危操作/, 'danger → GFM Alert CAUTION')
    assert.ok(!md.includes(':::callout'), '不再输出 :::callout directive')
  })

  it('frontmatter title 含冒号能正确 roundtrip（依赖渲染器加引号）', () => {
    // 已知 limitation：parseFrontmatterCore 仅做"剥离外层引号"，不解 \" 转义；
    // 因此本用例避开内嵌双引号场景，只覆盖最常见的冒号场景。
    const ir: DocumentIR = {
      metadata: { title: 'A: Hard Case' },
      blocks: [{ type: 'paragraph', text: 'hi' }],
    }
    const md = renderMarkdown(ir)
    const { ir: ir2 } = parseIR(md)
    assert.equal(ir2.metadata.title, 'A: Hard Case')
  })
})

// ===========================================================================
// 4. renderHtml + escapeHtml
// ===========================================================================

describe('escapeHtml', () => {
  it('转义 5 类 HTML 危险字符', () => {
    assert.equal(escapeHtml('<script>'), '&lt;script&gt;')
    assert.equal(escapeHtml('a & b'), 'a &amp; b')
    assert.equal(escapeHtml('"quoted"'), '&quot;quoted&quot;')
    assert.equal(escapeHtml("it's"), 'it&#39;s')
  })

  it('& 不会重复转义（先转 &，再转 < > 等）', () => {
    assert.equal(escapeHtml('&amp;'), '&amp;amp;')
  })
})

describe('renderHtml', () => {
  it('返回完整 HTML 文档（含 DOCTYPE / head / body）', () => {
    const html = renderHtml({
      metadata: { title: '测试' },
      blocks: [{ type: 'paragraph', text: 'hi' }],
    })
    assert.match(html, /<!DOCTYPE html>/)
    assert.match(html, /<html lang="zh-CN">/)
    assert.match(html, /<head>/)
    assert.match(html, /<body>/)
    assert.match(html, /<title>测试<\/title>/)
  })

  it('XSS 防护：标题与段落含 < script > 必被转义', () => {
    const html = renderHtml({
      metadata: { title: '<script>alert(1)</script>' },
      blocks: [
        { type: 'paragraph', text: '<img onerror="x">' },
        { type: 'heading', level: 2, text: '<b>fake</b>' },
      ],
    })
    assert.ok(!html.includes('<script>alert(1)'), '原始 script 标签必被转义')
    assert.ok(html.includes('&lt;script&gt;alert(1)'), 'title 转义后应出现实体')
    assert.ok(!html.includes('<img onerror'), '段落里的 img 必被转义')
    assert.ok(html.includes('&lt;img onerror='))
  })

  it('行内 Markdown：段落、列表、表格和 callout 中的加粗与代码被渲染，HTML 仍转义', () => {
    const html = renderHtml({
      metadata: { title: 't' },
      blocks: [
        { type: 'paragraph', text: '**电价政策风险**：使用 `IRR` 指标，禁止 <script>' },
        { type: 'list', ordered: true, items: ['**平台电价不准确**：需客户确认'] },
        { type: 'table', headers: ['**参数**'], rows: [['`262kWh`']] },
        { type: 'callout', level: 'warning', text: '**注意**：缺少峰谷价差' },
      ],
    })

    assert.match(html, /<strong>电价政策风险<\/strong>/)
    assert.match(html, /<code>IRR<\/code>/)
    assert.match(html, /<li><strong>平台电价不准确<\/strong>：需客户确认<\/li>/)
    assert.match(html, /<th><strong>参数<\/strong><\/th>/)
    assert.match(html, /<td><code>262kWh<\/code><\/td>/)
    assert.match(html, /<aside class="callout callout-warning"><strong>注意<\/strong>：缺少峰谷价差<\/aside>/)
    assert.ok(!html.includes('<script>'), '行内 Markdown 渲染不能放开原始 HTML')
    assert.ok(html.includes('&lt;script&gt;'))
  })

  it('XSS 防护：image src 含双引号被转义为属性安全', () => {
    const html = renderHtml({
      metadata: { title: 't' },
      blocks: [{ type: 'image', src: 'a"onerror="x', alt: 'safe' }],
    })
    assert.ok(!html.includes('a"onerror="x'))
    assert.ok(html.includes('a&quot;onerror=&quot;x'))
  })

  it('表格渲染：含 thead/tbody，单元转义', () => {
    const html = renderHtml({
      metadata: { title: 't' },
      blocks: [{ type: 'table', headers: ['<h>'], rows: [['<v>', 1, null]] }],
    })
    assert.match(html, /<table>/)
    assert.match(html, /<thead>/)
    assert.match(html, /<th>&lt;h&gt;<\/th>/)
    assert.match(html, /<td>&lt;v&gt;<\/td>/)
    assert.match(html, /<td>1<\/td>/)
    assert.match(html, /<td><\/td>/) // null → 空
  })

  it('callout 4 级 class 全覆盖', () => {
    const levels = ['info', 'warning', 'success', 'danger'] as const
    for (const level of levels) {
      const html = renderHtml({
        metadata: { title: 't' },
        blocks: [{ type: 'callout', level, text: 'x' }],
      })
      assert.match(html, new RegExp(`<aside class="callout callout-${level}">`))
    }
  })

  it('cite 块渲染含 data-source / data-page 与可见来源行', () => {
    const html = renderHtml({
      metadata: { title: 't' },
      blocks: [{ type: 'cite', source: 'knowledge/a.md', page: 9, text: '原文' }],
    })
    assert.match(html, /data-source="knowledge\/a\.md"/)
    assert.match(html, /data-page="9"/)
    assert.match(html, /来源：knowledge\/a\.md/)
    assert.match(html, /第 9 页/)
  })

  it('list 渲染：ul 与 ol 区分', () => {
    const html = renderHtml({
      metadata: { title: 't' },
      blocks: [
        { type: 'list', ordered: false, items: ['a', 'b'] },
        { type: 'list', ordered: true, items: ['x'] },
      ],
    })
    assert.match(html, /<ul>[\s\S]*<li>a<\/li>[\s\S]*<\/ul>/)
    assert.match(html, /<ol>[\s\S]*<li>x<\/li>[\s\S]*<\/ol>/)
  })

  it('divider 渲染为 <hr />', () => {
    const html = renderHtml({
      metadata: { title: 't' },
      blocks: [{ type: 'divider' }],
    })
    assert.match(html, /<hr \/>/)
  })

  it('inlineCss 注入到 <style> 段', () => {
    const html = renderHtml(
      { metadata: { title: 't' }, blocks: [] },
      { inlineCss: '.custom-marker-xyz123 { color: red; }' },
    )
    assert.ok(html.includes('.custom-marker-xyz123'))
  })

  it('avatarRoot + 已存在的模板 → CSS 被注入', () => {
    const sandbox = createAvatarSandbox()
    try {
      const cssMarker = '.avatar-template-marker-abc { color: blue; }'
      fs.writeFileSync(
        path.join(sandbox.avatarRoot, 'document-templates', 'default.css'),
        cssMarker,
        'utf-8',
      )
      const html = renderHtml(
        { metadata: { title: 't' }, blocks: [] },
        { avatarRoot: sandbox.avatarRoot, templateName: 'default' },
      )
      assert.ok(html.includes('.avatar-template-marker-abc'), '模板 CSS 必须被注入')
    } finally {
      sandbox.cleanup()
    }
  })

  it('avatarRoot + 模板缺失 → 不抛错且不影响渲染', () => {
    const sandbox = createAvatarSandbox()
    try {
      const html = renderHtml(
        { metadata: { title: 't' }, blocks: [{ type: 'paragraph', text: 'x' }] },
        { avatarRoot: sandbox.avatarRoot, templateName: 'nonexistent' },
      )
      assert.match(html, /<title>t<\/title>/)
    } finally {
      sandbox.cleanup()
    }
  })

  // ===========================================================================
  // 屏幕预览页眉 / 页脚（v1 增强：Phase B）
  // ===========================================================================

  it('metadata.headerText / footerText 同时存在 → 输出 preview-page-header / footer 元素，文本经 escapeHtml', () => {
    const html = renderHtml({
      metadata: {
        title: 't',
        headerText: '远景能源 · 工商业储能 <演示>',
        footerText: '机密 © 2026',
      },
      blocks: [],
    })
    // 元素正确出现
    assert.match(html, /<div class="preview-page-header"[^>]*>/)
    assert.match(html, /<div class="preview-page-footer"[^>]*>/)
    // 用户文本被转义（不留生 < / > 给浏览器解析为标签）
    assert.ok(!html.includes('远景能源 · 工商业储能 <演示>'), 'header 原始 < 不应裸露')
    assert.ok(html.includes('远景能源 · 工商业储能 &lt;演示&gt;'), 'header 应转义')
    assert.ok(html.includes('机密 © 2026'))
    // CSS 同时包含 @media screen / @media print 切换
    assert.match(html, /@media screen\s*\{[\s\S]*\.preview-page-header/)
    assert.match(html, /@media print\s*\{[\s\S]*display:\s*none\s*!important/)
  })

  it('metadata 仅 organization、无 headerText → fallback 用 organization 作为页眉文本', () => {
    const html = renderHtml({
      metadata: {
        title: 't',
        organization: '远景能源',
      },
      blocks: [],
    })
    assert.match(html, /<div class="preview-page-header"[^>]*>远景能源<\/div>/)
    // 没有 footerText → body 中不输出 <div class="preview-page-footer"> 元素
    // （CSS 中的 .preview-page-footer 选择器始终存在，故只断言 <div> 元素本身）
    assert.ok(
      !/<div class="preview-page-footer"/.test(html),
      '无 footerText 时不出现 footer <div> 元素',
    )
  })

  it('metadata 既无 headerText / footerText / organization → HTML 不含 preview chrome 元素', () => {
    const html = renderHtml({
      metadata: { title: '纯净文档' },
      blocks: [{ type: 'paragraph', text: '正文' }],
    })
    // 注意：CSS 中始终存在 .preview-page-header / .preview-page-footer 选择器，
    // 故只断言 body 中没有 <div class="..."> 元素
    assert.ok(
      !/<div class="preview-page-header"/.test(html),
      '不应输出空的 preview-page-header <div>',
    )
    assert.ok(
      !/<div class="preview-page-footer"/.test(html),
      '不应输出空的 preview-page-footer <div>',
    )
    // 但 @media 规则仍内联（无开销，缺失元素时无视觉副作用）
    assert.match(html, /@media screen/)
  })
})

// ===========================================================================
// 5. template-loader 路径安全
// ===========================================================================

describe('loadTemplateCss / resolveTemplatePath', () => {
  it('路径穿越的 templateName 返回空串而非抛错', () => {
    const sandbox = createAvatarSandbox()
    try {
      const css = loadTemplateCss(sandbox.avatarRoot, '../../etc/passwd')
      assert.equal(css, '')
    } finally {
      sandbox.cleanup()
    }
  })

  it('resolveTemplatePath 对穿越名抛错', () => {
    const sandbox = createAvatarSandbox()
    try {
      assert.throws(() => resolveTemplatePath(sandbox.avatarRoot, '../foo'))
    } finally {
      sandbox.cleanup()
    }
  })

  it('avatarRoot 为空字符串返回空串', () => {
    assert.equal(loadTemplateCss('', 'default'), '')
  })

  it('正常模板名命中文件返回内容', () => {
    const sandbox = createAvatarSandbox()
    try {
      const cssBody = '/* hello world */'
      fs.writeFileSync(
        path.join(sandbox.avatarRoot, 'document-templates', 'solution-report.css'),
        cssBody,
        'utf-8',
      )
      const css = loadTemplateCss(sandbox.avatarRoot, 'solution-report')
      assert.equal(css, cssBody)
    } finally {
      sandbox.cleanup()
    }
  })
})
