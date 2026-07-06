/**
 * tool-result-compressor.test.ts — A3-2 / A3-1 / A3-4
 *
 * 运行：
 *   NODE_PATH=./test-support/node_modules npx tsx --test src/services/tool-result-compressor.test.ts
 *
 * 核心不变量（对应 A3 溯源红线）：
 *   1. 错误行永不丢——压缩是为了省 token，不是为了掩盖失败信号
 *   2. `[来源: ...]` 锚点字符串逐字保留——A1 溯源闭集校验按原文匹配锚点
 *   3. 数字原样、零改写——统计压缩与 LLM 摘要的本质区别
 *   4. CCR marker 里只写真实存在的取回路径（spool 落盘文件），不编造取回方式
 */

import { test } from 'node:test'
import assert from 'node:assert'
import type { LLMMessage } from './llm-service'
import {
  compressToolResult,
  markSupersededToolResults,
  COMPRESSED_MARKER_PREFIX,
  SUPERSEDED_MARKER_PREFIX,
} from './tool-result-compressor'

// ─── 夹具 ─────────────────────────────────────────────────────────────────

/** 40 行质检记录（非均匀键集：仅失败行带 异常码/来源 字段 → 不可 CSV，走 stats） */
function makeQcRows(): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = []
  for (let i = 1; i <= 40; i++) {
    const row: Record<string, unknown> = {
      序号: i,
      月份: `2026-0${(i % 6) + 1}`,
      产线: i === 22 || i === 28 ? 'B线' : 'A线',
      状态: i === 17 ? '失败' : i === 31 ? '复测通过' : '通过',
      良率: Number((90 + i * 0.07).toFixed(2)),
      标记: `ROW-${String(i).padStart(2, '0')}`,
    }
    if (i === 17) {
      row.异常码 = 'E-812'
      row.来源 = '[来源: knowledge/_excel/262-copq.json#sheet=测试记录&rows=18]'
    }
    rows.push(row)
  }
  return rows
}
const QC_JSON = JSON.stringify(makeQcRows())

/** 60 行纯文本（知识摘录风格）：第 8 行锚点、第 35 行错误 */
function makeTextLines(): string {
  const lines: string[] = []
  for (let i = 1; i <= 60; i++) lines.push(`第${i}行 说明文本 权重 ${i * 3} 千瓦时`)
  lines[7] = '政策补贴上限 0.3 元/千瓦时 [来源: knowledge/energy-policy.md#L120-L133]'
  lines[34] = '解析失败：第 35 行编码异常 数值 0.008'
  return lines.join('\n')
}
const TEXT_60 = makeTextLines()

/** 断言：原文里的每个 [来源: ...] 锚点都逐字出现在压缩产物里 */
function assertAnchorsPreserved(original: string, compressed: string): void {
  const anchors = original.match(/\[来源:\s*[^\]]+\]/g) ?? []
  for (const anchor of anchors) {
    assert.ok(compressed.includes(anchor), `锚点丢失：${anchor}`)
  }
}

// ─── 基本行为 ─────────────────────────────────────────────────────────────

test('不超预算 → 原样不压缩', () => {
  const r = compressToolResult('短内容 123', { maxChars: 1600 })
  assert.strictEqual(r.compressed, false)
  assert.strictEqual(r.content, '短内容 123')
})

test('幂等：压缩产物再压 → 不二次压缩（保 marker 里的取回路径）', () => {
  const r1 = compressToolResult(TEXT_60, { maxChars: 800 })
  assert.strictEqual(r1.compressed, true)
  const r2 = compressToolResult(r1.content, { maxChars: 400 })
  assert.strictEqual(r2.compressed, false)
  assert.strictEqual(r2.content, r1.content)
})

// ─── 保留规则 ─────────────────────────────────────────────────────────────

test('错误行永不丢：错误码与该行数字原样保留', () => {
  const r = compressToolResult(QC_JSON, { maxChars: 1600 })
  assert.strictEqual(r.compressed, true)
  assert.strictEqual(r.method, 'stats')
  assert.ok(r.content.includes('E-812'), '错误行异常码丢失')
  assert.ok(r.content.includes('91.19'), '错误行数字（良率 90+17*0.07）被改写或丢失')
})

test('[来源: ...] 锚点逐字保留（含 JSON 字符串内的锚点）', () => {
  const r = compressToolResult(QC_JSON, { maxChars: 1600 })
  assertAnchorsPreserved(QC_JSON, r.content)
  const r2 = compressToolResult(TEXT_60, { maxChars: 800 })
  assertAnchorsPreserved(TEXT_60, r2.content)
})

test('Pareto 罕见值保留：罕见状态/产线行保住，常见值中间行被丢', () => {
  const r = compressToolResult(QC_JSON, { maxChars: 1600 })
  assert.ok(r.content.includes('复测通过'), '罕见状态值行丢失')
  assert.ok(r.content.includes('92.17'), '罕见值行数字（90+31*0.07）丢失')
  assert.ok(r.content.includes('B线'), '罕见产线值行丢失')
  // 序号 20：非首/尾、非罕见、非错误 → 应被聚合掉（证明确实发生了丢弃）
  assert.ok(!r.content.includes('ROW-20'), '常见值中间行应被丢弃')
  assert.ok((r.droppedRows ?? 0) > 0)
})

test('罕见字段（<20% 出现率）所在行保留', () => {
  // 仅 2/30 行带「备注」字段；这两行既非错误也非首尾也非罕见值
  const rows: Array<Record<string, unknown>> = []
  for (let i = 1; i <= 30; i++) {
    const row: Record<string, unknown> = { 序号: i, 值: 1000 + i, 组: '常规' }
    if (i === 14 || i === 15) row.备注 = `特批-${i}`
    rows.push(row)
  }
  const content = JSON.stringify(rows)
  const r = compressToolResult(content, { maxChars: Math.floor(content.length * 0.7) })
  assert.strictEqual(r.compressed, true)
  assert.ok(r.content.includes('特批-14'), '罕见字段行 14 丢失')
  assert.ok(r.content.includes('特批-15'), '罕见字段行 15 丢失')
})

test('query 关键词命中行保留；命中面过宽时规则失效但仍能压缩', () => {
  const lines: string[] = []
  for (let i = 1; i <= 30; i++) lines.push(`设备巡检记录 编号 ${7000 + i} 正常`)
  lines[13] = '设备巡检记录 柜体X268 电压 748.35 正常'
  lines[14] = '设备巡检记录 柜体X268 电流 120.4 正常'
  const content = lines.join('\n')
  const r = compressToolResult(content, { maxChars: 500, query: '柜体X268 的电压电流' })
  assert.strictEqual(r.compressed, true)
  assert.ok(r.content.includes('748.35'), 'query 命中行（电压）丢失')
  assert.ok(r.content.includes('120.4'), 'query 命中行（电流）丢失')

  // 命中面过宽：每行都含"设备"，规则应失效 → 依然产生丢弃而不是全量保留
  const broad = compressToolResult(content, { maxChars: 500, query: '设备' })
  assert.strictEqual(broad.compressed, true)
  assert.ok((broad.droppedRows ?? 0) > 0, '过宽 query 不应导致全量保留')
})

test('首 30% / 尾 15% 位置锚点：首行末行必在，中段普通行被聚合', () => {
  const r = compressToolResult(TEXT_60, { maxChars: 800 })
  assert.ok(r.content.includes('第1行'), '首行丢失')
  assert.ok(r.content.includes('第60行'), '末行丢失')
  assert.ok(!r.content.includes('第25行'), '中段普通行应被聚合')
  assert.ok(r.content.includes('略'), '缺少间隙聚合行')
})

test('丢弃行统计聚合：共略 N 行 + 字段取值分布（计数原样）', () => {
  const r = compressToolResult(QC_JSON, { maxChars: 1600 })
  assert.ok(r.content.includes('共略'), '缺少统计聚合行')
  assert.ok(r.content.includes('取值分布'), '缺少字段取值分布')
  assert.ok(/×\d+/.test(r.content), '取值分布缺少计数')
})

// ─── 无损重排（规则 0） ───────────────────────────────────────────────────

test('均匀 JSON 数组 → CSV 无损重排：全部数值逐字保留、省 ≥15%', () => {
  const rows: Array<Record<string, unknown>> = []
  for (let i = 1; i <= 30; i++) {
    rows.push({
      月份: `2026-${String(i).padStart(2, '0')}`,
      良率: Number((91 + i * 0.013).toFixed(3)),
      出货量: 1200 + i * 7,
    })
  }
  const content = JSON.stringify(rows)
  const r = compressToolResult(content, { maxChars: 1000 })
  assert.strictEqual(r.compressed, true)
  assert.strictEqual(r.method, 'csv')
  assert.strictEqual(r.droppedRows, 0)
  assert.ok(r.content.includes('无损重排'), 'marker 应说明无损重排')
  assert.ok(r.content.includes('月份,良率,出货量'), 'CSV header 缺失')
  for (const row of rows) {
    assert.ok(r.content.includes(String(row.良率)), `数值 ${row.良率} 未逐字保留`)
    assert.ok(r.content.includes(String(row.出货量)), `数值 ${row.出货量} 未逐字保留`)
  }
  assert.ok(r.content.length <= content.length * 0.85, 'CSV 重排应至少节省 15%')
})

// ─── A3-1 CCR marker ─────────────────────────────────────────────────────

test('CCR marker：原文含 spool 提示（路径带空格）→ marker 写真实取回调用', () => {
  const spoolPath = '/Users/x/Library/Application Support/soul-desktop/tool-results/conv-1/query_excel-1751700000000.txt'
  const content = `${TEXT_60}\n\n[系统提示] 工具 query_excel 返回过长，完整内容已落盘到：\n  ${spoolPath}\n\n如需查看中段或完整结构，调用 \`read_tool_result\` 工具：\n  read_tool_result(path="${spoolPath}")`
  const r = compressToolResult(content, { maxChars: 900 })
  assert.strictEqual(r.compressed, true)
  assert.ok(r.content.startsWith(COMPRESSED_MARKER_PREFIX), 'marker 前缀缺失')
  const firstLine = r.content.split('\n')[0]
  assert.ok(firstLine.includes(`read_tool_result(path="${spoolPath}")`), 'marker 应含真实 spool 取回路径')
  assert.ok(/已压缩 \d+→\d+ 字符/.test(firstLine), 'marker 应含 N→M 字符')
})

test('CCR marker：原文未落盘 → 如实写不可取回，不编造取回方式', () => {
  const r = compressToolResult(TEXT_60, { maxChars: 800 })
  const firstLine = r.content.split('\n')[0]
  assert.ok(firstLine.includes('未落盘'), '未落盘时应如实说明')
  assert.ok(!firstLine.includes('read_tool_result(path='), '不得编造取回路径')
})

// ─── 保守失败与兜底 ───────────────────────────────────────────────────────

test('全是硬保留行（错误行）→ standard 宁可不压；force 退化为盲截断保生存', () => {
  const lines: string[] = []
  for (let i = 1; i <= 8; i++) lines.push(`第 ${i} 批次测试失败 错误码 E-${100 + i} ${'详情'.repeat(30)}`)
  const content = lines.join('\n')
  const standard = compressToolResult(content, { maxChars: 400 })
  assert.strictEqual(standard.compressed, false, '错误项永不丢：standard 模式应放弃压缩')
  const force = compressToolResult(content, { maxChars: 400, mode: 'force' })
  assert.strictEqual(force.compressed, true, 'force（溢出自救）应保生存')
  assert.strictEqual(force.method, 'blind')
})

test('单巨行（无行结构）→ 盲截断兜底，中段锚点回填保留', () => {
  const anchor = '[来源: knowledge/a.md#L1-L2]'
  const content = 'x'.repeat(2500) + anchor + 'y'.repeat(400)
  const r = compressToolResult(content, { maxChars: 800 })
  assert.strictEqual(r.compressed, true)
  assert.strictEqual(r.method, 'blind')
  assert.ok(r.content.startsWith(COMPRESSED_MARKER_PREFIX))
  assert.ok(r.content.includes(anchor), '中段锚点应通过回填行保留')
  assert.ok(r.content.length < content.length)
})

// ─── A3-4 SUPERSEDED ─────────────────────────────────────────────────────

function toolCall(id: string, name: string, args: string) {
  return { id, type: 'function' as const, function: { name, arguments: args } }
}

function makeSupersededMessages(): LLMMessage[] {
  const spool = '/tmp/x/tool-results/c/query_excel-1.txt'
  const oldResult = `旧数据 ${'行内容。'.repeat(60)}[来源: knowledge/_excel/a.json#sheet=S1&rows=2-9]\nread_tool_result(path="${spool}")`
  return [
    { role: 'user', content: 'Q1' },
    { role: 'assistant', content: '', tool_calls: [toolCall('t1', 'query_excel', '{"file":"a.xlsx","sheet":"S1"}')] },
    { role: 'tool', tool_call_id: 't1', content: oldResult },
    { role: 'assistant', content: '答1' },
    { role: 'user', content: 'Q2' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        // 键序 + 空白不同但语义相同 → 应判定为同参数
        toolCall('t2', 'query_excel', '{ "sheet" : "S1", "file" : "a.xlsx" }'),
        // 不同参数 → 不受影响
        toolCall('t3', 'query_excel', '{"file":"b.xlsx","sheet":"S1"}'),
      ],
    },
    { role: 'tool', tool_call_id: 't2', content: '最新结果' },
    { role: 'tool', tool_call_id: 't3', content: '另一文件结果' },
  ]
}

test('SUPERSEDED：同参重调（键序/空白归一）→ 旧结果替换为 marker，最新与异参保留', () => {
  const messages = makeSupersededMessages()
  const r = markSupersededToolResults(messages)
  assert.strictEqual(r.replacedCount, 1)
  assert.ok(r.savedChars > 0)
  const replaced = messages[2].content as string
  assert.ok(replaced.startsWith(SUPERSEDED_MARKER_PREFIX))
  assert.ok(replaced.includes('[来源: knowledge/_excel/a.json#sheet=S1&rows=2-9]'), '旧结果锚点应并入 marker')
  assert.ok(replaced.includes('read_tool_result(path="/tmp/x/tool-results/c/query_excel-1.txt")'), 'spool 取回路径应并入 marker')
  assert.strictEqual(messages[6].content, '最新结果', '最新一次结果不得被替换')
  assert.strictEqual(messages[7].content, '另一文件结果', '不同参数结果不得被替换')
})

test('SUPERSEDED：幂等 + endIndex 保护近轮窗口', () => {
  const messages = makeSupersededMessages()
  markSupersededToolResults(messages)
  const second = markSupersededToolResults(messages)
  assert.strictEqual(second.replacedCount, 0, '重复执行不应再替换')

  const fresh = makeSupersededMessages()
  const protectedRun = markSupersededToolResults(fresh, { endIndex: 2 })
  assert.strictEqual(protectedRun.replacedCount, 0, 'endIndex 之后的旧结果应受保护')
  assert.ok((fresh[2].content as string).startsWith('旧数据'), '受保护的内容不得被改写')
})
