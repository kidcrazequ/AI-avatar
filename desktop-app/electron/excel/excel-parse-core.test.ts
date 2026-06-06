/**
 * excel-parse-core 等价性 / 行为测试（#16 worker 化子任务 1）。
 *
 * 验证从 document-parser 抽出的纯逻辑核心：智能表头检测、列 schema 推断、
 * 行元数据角色、GFM markdown 输出，以及经 DocumentParser.parseFile 的整链路路由。
 *
 * 运行：NODE_PATH=./test-support/node_modules npx tsx --test electron/excel/excel-parse-core.test.ts
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { parseExcelCore, inferRowMetaRole } from './excel-parse-core'
import { DocumentParser } from '../document-parser'

// eslint-disable-next-line @typescript-eslint/no-require-imports
const XLSX = require('xlsx')

/** 把二维数组写成一个临时 .xlsx，返回路径（调用方负责清理目录）。 */
function writeXlsx(rows: unknown[][], sheetName = 'Sheet1'): { filePath: string; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'excel-core-test-'))
  const filePath = path.join(dir, 'fixture.xlsx')
  const sheet = XLSX.utils.aoa_to_sheet(rows)
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, sheet, sheetName)
  XLSX.writeFile(wb, filePath)
  return { filePath, dir }
}

const SAMPLE_ROWS: unknown[][] = [
  ['产品', '数量', '金额'],
  ['电池', 10, 100],
  ['逆变器', 5, 250],
  ['总计', 15, 350],
]

test('parseExcelCore: 表头检测 + 列 schema + 行角色 + markdown 表格', () => {
  const { filePath, dir } = writeXlsx(SAMPLE_ROWS)
  try {
    const parsed = parseExcelCore(filePath, 'fixture.xlsx')

    assert.equal(parsed.fileType, 'excel')
    assert.deepEqual(parsed.sheetNames, ['Sheet1'])

    const sheet = parsed.structuredData?.sheets[0]
    assert.ok(sheet, 'structuredData.sheets[0] 应存在')

    // 表头检测：第 0 行是表头 → 列名为 产品/数量/金额
    assert.deepEqual(sheet!.columns.map(c => c.name), ['产品', '数量', '金额'])
    // dtype 推断：数量/金额 为 number，产品 为 string
    const dtypeByName = Object.fromEntries(sheet!.columns.map(c => [c.name, c.dtype]))
    assert.equal(dtypeByName['产品'], 'string')
    assert.equal(dtypeByName['数量'], 'number')
    assert.equal(dtypeByName['金额'], 'number')

    // 行：3 条 body 行（电池/逆变器/总计）转为对象
    assert.equal(sheet!.rowCount, 3)
    assert.equal(sheet!.rows[0]['产品'], '电池')
    assert.equal(sheet!.rows[0]['数量'], 10)

    // 行角色：最后一行"总计"识别为 total
    assert.ok(sheet!.rowMetaRoles, 'rowMetaRoles 应存在')
    assert.equal(sheet!.rowMetaRoles![2], 'total')
    assert.equal(sheet!.rowMetaRoles![0], 'data')

    // markdown：含表头行（GFM 表格）
    assert.match(parsed.text, /\| 产品 \| 数量 \| 金额 \|/)
    assert.match(parsed.text, /## Sheet1/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('parseExcelCore: 空 sheet 抛错（不含任何 sheet 由 readFile 决定，这里测全空数据 sheet 的降级）', () => {
  const { filePath, dir } = writeXlsx([[]], 'Empty')
  try {
    const parsed = parseExcelCore(filePath, 'empty.xlsx')
    // 单个空 sheet：sheets[0] 退化为 0 行、无列，不抛错
    assert.equal(parsed.structuredData?.sheets[0]?.rowCount, 0)
    assert.deepEqual(parsed.structuredData?.sheets[0]?.columns, [])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('inferRowMetaRole: 总计/小计/subtitle/data 分类', () => {
  const columns = [
    { name: '名称', dtype: 'string' as const, uniqueCount: 3, samples: [] },
    { name: '值', dtype: 'number' as const, uniqueCount: 3, samples: [] },
  ]
  assert.equal(inferRowMetaRole({ 名称: '总计', 值: 100 }, columns), 'total')
  assert.equal(inferRowMetaRole({ 名称: 'Total', 值: 100 }, columns), 'total')
  assert.equal(inferRowMetaRole({ 名称: '小计', 值: 50 }, columns), 'subtotal')
  // col1 有值、其余列全空 → subtitle
  assert.equal(inferRowMetaRole({ 名称: '华东区', 值: null }, columns), 'subtitle')
  // 普通数据行
  assert.equal(inferRowMetaRole({ 名称: '电池', 值: 10 }, columns), 'data')
})

test('DocumentParser.parseFile: .xlsx 经 parseExcel 包装路由到 core（整链路一致）', async () => {
  const { filePath, dir } = writeXlsx(SAMPLE_ROWS)
  try {
    const parsed = await new DocumentParser().parseFile(filePath)
    assert.equal(parsed.fileType, 'excel')
    assert.equal(parsed.structuredData?.sheets[0]?.columns.length, 3)
    assert.match(parsed.text, /\| 产品 \| 数量 \| 金额 \|/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
