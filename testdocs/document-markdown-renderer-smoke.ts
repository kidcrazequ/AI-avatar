/**
 * Smoke test: 文档 IR → Markdown 渲染器 + roundtrip 一致性
 *
 * 验证 renderMarkdown(ir) 的输出能被 parseIR() 还原回等价 IR。
 *
 * @author zhi.qu
 * @date 2026-05-08
 */

import assert from 'node:assert/strict'
import { renderMarkdown } from '../packages/core/src/document/renderers/markdown-renderer'
import { parseIR } from '../packages/core/src/document/ir-parser'
import { validateIR, type DocumentIR } from '../packages/core/src/document/ir-schema'

// ─── 样例 IR：覆盖全部 9 种块 ─────────────────────────────────────────────────
const sample: DocumentIR = {
  metadata: {
    title: '262kWh 工商柜收益测算报告',
    author: '小堵',
    date: '2026-05-08',
    template: 'solution-report',
    revision: '3', // 注：parseFrontmatterCore 不推断数字，需用字符串才能 roundtrip
    draft: false,
    tags: ['工商储', '262kWh', '收益测算'],
  },
  blocks: [
    { type: 'heading', level: 1, text: '项目概况' },
    { type: 'paragraph', text: '本项目位于江苏苏州工业园区。' },
    { type: 'list', ordered: false, items: ['容量 262kWh', 'PCS 125kW', '应用场景：峰谷套利'] },
    { type: 'heading', level: 2, text: '收益预估' },
    {
      type: 'table',
      headers: ['年份', '收益(万元)', 'IRR'],
      rows: [
        [1, 32.5, '8.2%'],
        [2, 31.8, '8.0%'],
        [3, 31.0, '7.8%'],
      ],
    },
    { type: 'callout', level: 'warning', text: '本测算基于现行电价政策，政策调整可能影响实际收益' },
    { type: 'cite', source: 'knowledge/2025年综能BESS质量数据.md', page: 12, text: '电芯循环寿命 ≥ 6000 次（80% 容量保持率）' },
    { type: 'code', language: 'json', code: '{"capacity": 262, "pcs": 125}' },
    { type: 'image', src: 'knowledge/收益曲线.png', alt: '年化收益曲线', caption: '图1：年化收益曲线' },
    { type: 'divider' },
    { type: 'heading', level: 3, text: '风险提示' },
    { type: 'list', ordered: true, items: ['电价波动风险', '设备故障风险'] },
  ],
}

// ─── 1. 渲染 → 解析 roundtrip ────────────────────────────────────────────────
const md = renderMarkdown(sample)
const { ir: parsed, warnings } = parseIR(md)

console.log('--- 渲染输出（前 500 字符）---')
console.log(md.slice(0, 500))
console.log('---')

assert.equal(warnings.length, 0, `roundtrip 不应产生 warnings，实际：${JSON.stringify(warnings)}`)

// 校验 metadata
assert.equal(parsed.metadata.title, sample.metadata.title, 'title 一致')
assert.equal(parsed.metadata.author, sample.metadata.author, 'author 一致')
assert.equal(parsed.metadata.date, sample.metadata.date, 'date 一致')
assert.equal(parsed.metadata.template, sample.metadata.template, 'template 一致')
assert.equal(parsed.metadata.revision, '3', 'revision 一致（已知数字会变字符串）')
assert.equal(parsed.metadata.draft, false, 'draft boolean 一致')
assert.deepEqual(parsed.metadata.tags, sample.metadata.tags, 'tags 数组一致')

// 校验 blocks 数量
assert.equal(parsed.blocks.length, sample.blocks.length, `blocks 数量应为 ${sample.blocks.length}，实际 ${parsed.blocks.length}`)

// 逐块校验
for (let i = 0; i < sample.blocks.length; i++) {
  assert.deepEqual(parsed.blocks[i], sample.blocks[i], `第 ${i} 个块应等价：${JSON.stringify(sample.blocks[i])}`)
}

console.log('✅ Smoke 1：完整 IR roundtrip 通过（12 个块全部等价）')

// ─── 2. validateIR 通过性 ────────────────────────────────────────────────────
const validation = validateIR(parsed)
assert.equal(validation.valid, true, `parsed IR 应通过 validateIR：${JSON.stringify(validation.errors)}`)
console.log('✅ Smoke 2：解析后 IR 通过 validateIR')

// ─── 3. 边界：仅含 title 的最小 IR ───────────────────────────────────────────
const minimal: DocumentIR = {
  metadata: { title: '空文档' },
  blocks: [],
}
const minMd = renderMarkdown(minimal)
assert.match(minMd, /^---\ntitle: 空文档\n---/, '最小 IR 应输出 frontmatter + 无块')
const { ir: minParsed } = parseIR(minMd)
assert.equal(minParsed.blocks.length, 0)
assert.equal(minParsed.metadata.title, '空文档')
console.log('✅ Smoke 3：最小 IR roundtrip 通过')

// ─── 4. 边界：title 含特殊字符必须加引号 ─────────────────────────────────────
const quoted: DocumentIR = {
  metadata: { title: 'A: B # C', tag: 'true' },
  blocks: [{ type: 'paragraph', text: 'hello' }],
}
const qMd = renderMarkdown(quoted)
assert.match(qMd, /title: "A: B # C"/, '含 : # 的 title 必须加引号')
assert.match(qMd, /tag: "true"/, '字面量 "true" 字符串必须加引号防误判为布尔')
const { ir: qParsed } = parseIR(qMd)
assert.equal(qParsed.metadata.title, 'A: B # C', 'roundtrip 后仍是字符串')
assert.equal(qParsed.metadata.tag, 'true', 'roundtrip 后仍是字符串"true"，不是布尔')
console.log('✅ Smoke 4：特殊字符与歧义字符串加引号正确')

// ─── 5. 边界：空 callout / 空表格 ────────────────────────────────────────────
const edgeIR: DocumentIR = {
  metadata: { title: '边界测试' },
  blocks: [
    { type: 'callout', level: 'info', text: '' },
    { type: 'table', headers: ['col'], rows: [] },
  ],
}
const eMd = renderMarkdown(edgeIR)
const { ir: eParsed, warnings: eWarn } = parseIR(eMd)
console.log('  空 callout/table 的 warnings:', eWarn)
console.log('  解析回的 blocks:', JSON.stringify(eParsed.blocks))
console.log('✅ Smoke 5：空内容容器不抛错（具体 roundtrip 行为见上）')

console.log('\n🎉 全部 smoke 通过')
