/**
 * tool-router export_excel 工具单元测试。
 *
 * 覆盖 export_excel 工具的 10 个核心 case：
 *   1. ✅ 单 sheet 正常导出 + xlsx 反向解析能读回
 *   2. ✅ 多 sheet（3 个）导出
 *   3. ❌ filename 含路径分隔符抛错
 *   4. ❌ sheets 为空数组返回 error
 *   5. ❌ 单 sheet 超 50_000 行返回 error 且不写盘
 *   6. ❌ sheet 数超 50 返回 error
 *   7. ❌ 同名文件存在且未传 overwrite=true 返回 error
 *   8. ✅ overwrite=true 允许覆盖
 *   9. ❌ 缺 conversationId 返回 error
 *  10. ✅ filename 含中文 sanitize 后落盘成功
 *
 * 设计原则：
 * - 不 mock xlsx：直接调真实 XLSX.readFile 反向解析，确保 export_excel 走完整的
 *   json_to_sheet → writeFile → readFile → sheet_to_json 序列化往返链路
 * - 每个 test 独占一个临时 avatars/<avatar>/workspaces/<conv>/ 沙盒
 *   （os.tmpdir() + crypto.randomUUID()），finally 中整体删除，互不影响
 *
 * 运行方式：
 *   cd packages/core && npm run build
 *   node --test dist/tests/tool-router.export-excel.test.js
 *
 * @author zhi.qu
 * @date 2026-05-08
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import * as XLSX from 'xlsx'
import { ToolRouter } from '../tool-router'

// ---------------------------------------------------------------------------
// 沙盒辅助：每个测试独立的临时 avatars/ 根
// ---------------------------------------------------------------------------

interface Sandbox {
  avatarsPath: string
  avatarId: string
  conversationId: string
  workspaceRoot: string
  exportsDir: string
  cleanup: () => void
}

/**
 * 准备一个临时 avatars/<avatar>/workspaces/<conv>/ 沙盒供 export_excel 落盘。
 * 每个测试独占一份，测试结束 finally 中整体删除，避免相互干扰。
 */
function setupSandbox(): Sandbox {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `soul-export-excel-${crypto.randomUUID()}-`))
  const avatarsPath = path.join(root, 'avatars')
  const avatarId = 'export-test-avatar'
  const conversationId = `conv-${crypto.randomUUID()}`
  const workspaceRoot = path.join(avatarsPath, avatarId, 'workspaces', conversationId)
  fs.mkdirSync(workspaceRoot, { recursive: true })
  const exportsDir = path.join(workspaceRoot, 'exports')

  return {
    avatarsPath,
    avatarId,
    conversationId,
    workspaceRoot,
    exportsDir,
    cleanup: () => {
      try {
        fs.rmSync(root, { recursive: true, force: true })
      } catch (e) {
        // 测试沙盒清理失败不应让 case 标红，但要打印出来方便排查泄漏
        // eslint-disable-next-line no-console
        console.warn(`[export-excel-test] 清理临时目录失败: ${root}: ${e instanceof Error ? e.message : String(e)}`)
      }
    },
  }
}

/**
 * 用 xlsx 反向解析校验落盘文件，返回 { sheetName: rows[] } 形式的快照。
 * 不 mock xlsx，确保走真实的 XLSX 序列化往返链路。
 */
function readBackXlsx(absolutePath: string): Record<string, Array<Record<string, unknown>>> {
  const workbook = XLSX.readFile(absolutePath)
  const out: Record<string, Array<Record<string, unknown>>> = {}
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName]
    out[sheetName] = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '' })
  }
  return out
}

// ---------------------------------------------------------------------------
// case 1：单 sheet 正常导出 + xlsx 反向解析
// ---------------------------------------------------------------------------

test('case 1: 单 sheet 正常导出 + xlsx 反向解析能读回原始数据', async () => {
  const sandbox = setupSandbox()
  try {
    const router = new ToolRouter(sandbox.avatarsPath)
    const sheets = [
      {
        name: 'Sheet1',
        rows: Array.from({ length: 10 }, (_, i) => ({
          id: i + 1,
          name: `item-${i + 1}`,
          score: (i + 1) * 10,
        })),
      },
    ]

    const result = await router.execute(
      sandbox.avatarId,
      { name: 'export_excel', arguments: { filename: 'single-sheet', sheets } },
      undefined,
      sandbox.conversationId,
    )

    assert.equal(result.error, undefined, `不应返回错误，实际: ${result.error}`)
    assert.ok(result.content, '应返回非空 content')

    const payload = JSON.parse(result.content) as Record<string, unknown>
    assert.equal(payload.success, true, 'success 应为 true')
    assert.equal(payload.format, 'xlsx', 'format 应为 xlsx（决策 B3 与 generate_document 对齐）')
    assert.equal(payload.sheet_count, 1)
    assert.equal(payload.total_rows, 10)
    assert.equal(payload.file_path, 'exports/single-sheet.xlsx')
    assert.ok(typeof payload.file_size_bytes === 'number' && (payload.file_size_bytes as number) > 0,
      `file_size_bytes 应为正整数，实际: ${String(payload.file_size_bytes)}`)

    const absolutePath = path.join(sandbox.exportsDir, 'single-sheet.xlsx')
    assert.ok(fs.existsSync(absolutePath), '落盘文件应存在')

    const readBack = readBackXlsx(absolutePath)
    assert.deepEqual(Object.keys(readBack), ['Sheet1'], 'sheet 名应为 Sheet1')
    assert.equal(readBack.Sheet1.length, 10, '读回应有 10 行')
    assert.equal(readBack.Sheet1[0].id, 1)
    assert.equal(readBack.Sheet1[0].name, 'item-1')
    assert.equal(readBack.Sheet1[0].score, 10)
    assert.equal(readBack.Sheet1[9].id, 10)
    assert.equal(readBack.Sheet1[9].score, 100)
  } finally {
    sandbox.cleanup()
  }
})

// ---------------------------------------------------------------------------
// case 2：多 sheet（3 个）按顺序导出
// ---------------------------------------------------------------------------

test('case 2: 3 个 sheet 各 5 条数据应按顺序写入并可全部读回', async () => {
  const sandbox = setupSandbox()
  try {
    const router = new ToolRouter(sandbox.avatarsPath)
    const sheetNames = ['SheetA', 'SheetB', 'SheetC']
    const sheets = sheetNames.map((name) => ({
      name,
      rows: Array.from({ length: 5 }, (_, i) => ({
        sheet: name,
        index: i,
        value: `${name}-${i}`,
      })),
    }))

    const result = await router.execute(
      sandbox.avatarId,
      { name: 'export_excel', arguments: { filename: 'multi-sheets', sheets } },
      undefined,
      sandbox.conversationId,
    )

    assert.equal(result.error, undefined, `不应返回错误，实际: ${result.error}`)
    const payload = JSON.parse(result.content) as Record<string, unknown>
    assert.equal(payload.sheet_count, 3)
    assert.equal(payload.total_rows, 15)
    assert.equal(payload.file_path, 'exports/multi-sheets.xlsx')

    const readBack = readBackXlsx(path.join(sandbox.exportsDir, 'multi-sheets.xlsx'))
    assert.deepEqual(Object.keys(readBack), sheetNames, 'sheet 顺序应保持入参顺序')
    for (const name of sheetNames) {
      assert.equal(readBack[name].length, 5, `${name} 应有 5 行`)
      assert.equal(readBack[name][0].value, `${name}-0`)
      assert.equal(readBack[name][4].value, `${name}-4`)
    }
  } finally {
    sandbox.cleanup()
  }
})

// ---------------------------------------------------------------------------
// case 3：filename 含路径分隔符
// ---------------------------------------------------------------------------

test('case 3: filename 含路径分隔符应被 assertSafeSegment 拦截', async () => {
  const sandbox = setupSandbox()
  try {
    const router = new ToolRouter(sandbox.avatarsPath)
    const result = await router.execute(
      sandbox.avatarId,
      {
        name: 'export_excel',
        arguments: {
          filename: '../etc/passwd',
          sheets: [{ name: 'Sheet1', rows: [{ a: 1 }] }],
        },
      },
      undefined,
      sandbox.conversationId,
    )

    assert.ok(result.error, '应返回 error')
    assert.match(
      result.error!,
      /非法filename|路径分隔符/,
      `error 应来自 assertSafeSegment，实际: ${result.error}`,
    )
    assert.equal(result.content, '', '失败时 content 应为空')
    // 校验未副作用创建 exports 目录（在校验阶段被拦截，没机会 mkdir）
    assert.ok(!fs.existsSync(sandbox.exportsDir), '拦截路径穿越后不应创建 exports 目录')
  } finally {
    sandbox.cleanup()
  }
})

// ---------------------------------------------------------------------------
// case 4：sheets 为空数组
// ---------------------------------------------------------------------------

test('case 4: sheets 为空数组应返回 error', async () => {
  const sandbox = setupSandbox()
  try {
    const router = new ToolRouter(sandbox.avatarsPath)
    const result = await router.execute(
      sandbox.avatarId,
      { name: 'export_excel', arguments: { filename: 'empty', sheets: [] } },
      undefined,
      sandbox.conversationId,
    )

    assert.ok(result.error, '应返回 error')
    assert.match(result.error!, /sheets 必须为非空数组/, `error 文案不符: ${result.error}`)
    assert.equal(result.content, '')
  } finally {
    sandbox.cleanup()
  }
})

// ---------------------------------------------------------------------------
// case 5：单 sheet 超 50_000 行
// ---------------------------------------------------------------------------

test('case 5: 单 sheet 超 50_000 行应返回 error 且不写盘', async () => {
  const sandbox = setupSandbox()
  try {
    const router = new ToolRouter(sandbox.avatarsPath)
    // 50_001 行：刚好超出 EXPORT_EXCEL_MAX_ROWS_PER_SHEET 上限
    const tooManyRows = Array.from({ length: 50_001 }, (_, i) => ({ id: i, x: 'x' }))
    const result = await router.execute(
      sandbox.avatarId,
      {
        name: 'export_excel',
        arguments: { filename: 'too-many-rows', sheets: [{ name: 'BigSheet', rows: tooManyRows }] },
      },
      undefined,
      sandbox.conversationId,
    )

    assert.ok(result.error, '应返回 error')
    assert.match(
      result.error!,
      /行数 50001 超过上限 50000/,
      `error 文案不符: ${result.error}`,
    )
    assert.equal(result.content, '', '失败时 content 应为空')

    const targetPath = path.join(sandbox.exportsDir, 'too-many-rows.xlsx')
    assert.ok(!fs.existsSync(targetPath), '行数超限时绝对不应落盘任何文件')
  } finally {
    sandbox.cleanup()
  }
})

// ---------------------------------------------------------------------------
// case 6：sheet 数超 50
// ---------------------------------------------------------------------------

test('case 6: sheet 数超 50 应返回 error', async () => {
  const sandbox = setupSandbox()
  try {
    const router = new ToolRouter(sandbox.avatarsPath)
    // 51 个 sheet：刚好超出 EXPORT_EXCEL_MAX_SHEETS 上限
    const tooManySheets = Array.from({ length: 51 }, (_, i) => ({
      name: `S${i}`,
      rows: [{ a: i }],
    }))
    const result = await router.execute(
      sandbox.avatarId,
      { name: 'export_excel', arguments: { filename: 'too-many-sheets', sheets: tooManySheets } },
      undefined,
      sandbox.conversationId,
    )

    assert.ok(result.error, '应返回 error')
    assert.match(
      result.error!,
      /sheets 数量 51 超过上限 50/,
      `error 文案不符: ${result.error}`,
    )
    assert.equal(result.content, '')

    const targetPath = path.join(sandbox.exportsDir, 'too-many-sheets.xlsx')
    assert.ok(!fs.existsSync(targetPath), 'sheet 数超限时不应落盘')
  } finally {
    sandbox.cleanup()
  }
})

// ---------------------------------------------------------------------------
// case 7：同名文件存在且未传 overwrite=true
// ---------------------------------------------------------------------------

test('case 7: 同名文件存在且未传 overwrite=true 应返回 error', async () => {
  const sandbox = setupSandbox()
  try {
    const router = new ToolRouter(sandbox.avatarsPath)
    const sheets = [{ name: 'S1', rows: [{ a: 1 }] }]

    const first = await router.execute(
      sandbox.avatarId,
      { name: 'export_excel', arguments: { filename: 'dup-test', sheets } },
      undefined,
      sandbox.conversationId,
    )
    assert.equal(first.error, undefined, `第一次写入应成功，实际: ${first.error}`)

    const targetPath = path.join(sandbox.exportsDir, 'dup-test.xlsx')
    assert.ok(fs.existsSync(targetPath), '第一次写入后文件应存在')
    const firstSize = fs.statSync(targetPath).size
    const firstMtime = fs.statSync(targetPath).mtimeMs

    // 第二次写入：未传 overwrite，应被拒绝
    const second = await router.execute(
      sandbox.avatarId,
      { name: 'export_excel', arguments: { filename: 'dup-test', sheets } },
      undefined,
      sandbox.conversationId,
    )
    assert.ok(second.error, '第二次写入应失败')
    assert.match(
      second.error!,
      /目标文件已存在.*overwrite/,
      `error 文案不符: ${second.error}`,
    )
    assert.equal(second.content, '')

    // 原文件未被破坏
    const stat2 = fs.statSync(targetPath)
    assert.equal(stat2.size, firstSize, '原文件大小不应被改动')
    assert.equal(stat2.mtimeMs, firstMtime, '原文件 mtime 不应被改动')
  } finally {
    sandbox.cleanup()
  }
})

// ---------------------------------------------------------------------------
// case 8：overwrite=true 允许覆盖
// ---------------------------------------------------------------------------

test('case 8: overwrite=true 时应允许覆盖已有文件', async () => {
  const sandbox = setupSandbox()
  try {
    const router = new ToolRouter(sandbox.avatarsPath)

    const first = await router.execute(
      sandbox.avatarId,
      {
        name: 'export_excel',
        arguments: { filename: 'overwrite-test', sheets: [{ name: 'S1', rows: [{ ver: 'v1' }] }] },
      },
      undefined,
      sandbox.conversationId,
    )
    assert.equal(first.error, undefined, `第一次写入应成功，实际: ${first.error}`)

    const second = await router.execute(
      sandbox.avatarId,
      {
        name: 'export_excel',
        arguments: {
          filename: 'overwrite-test',
          sheets: [
            {
              name: 'S1',
              rows: Array.from({ length: 5 }, (_, i) => ({ ver: 'v2', i })),
            },
          ],
          overwrite: true,
        },
      },
      undefined,
      sandbox.conversationId,
    )
    assert.equal(second.error, undefined, `传 overwrite=true 时应成功覆盖，实际: ${second.error}`)
    const payload = JSON.parse(second.content) as Record<string, unknown>
    assert.equal(payload.total_rows, 5, '覆盖后行数应为新内容的 5 行')

    // 反向解析：内容应为 v2（第一次的 v1 已被覆盖）
    const targetPath = path.join(sandbox.exportsDir, 'overwrite-test.xlsx')
    const readBack = readBackXlsx(targetPath)
    assert.equal(readBack.S1.length, 5, '覆盖后应有 5 行')
    assert.equal(readBack.S1[0].ver, 'v2', '内容应为 v2')
    assert.equal(readBack.S1[4].i, 4)
  } finally {
    sandbox.cleanup()
  }
})

// ---------------------------------------------------------------------------
// case 9：缺 conversationId
// ---------------------------------------------------------------------------

test('case 9: 缺 conversationId 应返回 error', async () => {
  const sandbox = setupSandbox()
  try {
    const router = new ToolRouter(sandbox.avatarsPath)
    const result = await router.execute(
      sandbox.avatarId,
      {
        name: 'export_excel',
        arguments: {
          filename: 'no-conv',
          sheets: [{ name: 'S1', rows: [{ a: 1 }] }],
        },
      },
      undefined,
      undefined, // 故意不传 conversationId
    )

    assert.ok(result.error, '应返回 error')
    assert.match(
      result.error!,
      /缺少 conversationId/,
      `error 文案不符: ${result.error}`,
    )
    assert.equal(result.content, '')
  } finally {
    sandbox.cleanup()
  }
})

// ---------------------------------------------------------------------------
// case 10：filename 含中文 + 特殊字符 sanitize 后落盘成功
// ---------------------------------------------------------------------------

test('case 10: filename 含中文 + 特殊字符应 sanitize 后落盘成功', async () => {
  const sandbox = setupSandbox()
  try {
    const router = new ToolRouter(sandbox.avatarsPath)
    // 入参 "对比结果(2026)"：中文/数字/-/_ 保留；() 不在允许集合 → 替换为 _
    // 期望落盘文件名：对比结果_2026_.xlsx
    const filename = '对比结果(2026)'
    const expected = '对比结果_2026_.xlsx'

    const result = await router.execute(
      sandbox.avatarId,
      {
        name: 'export_excel',
        arguments: {
          filename,
          sheets: [
            {
              name: '对比表',
              rows: [
                { 项目: 'A', 值: 1 },
                { 项目: 'B', 值: 2 },
              ],
            },
          ],
        },
      },
      undefined,
      sandbox.conversationId,
    )

    assert.equal(result.error, undefined, `不应报错，实际: ${result.error}`)
    const payload = JSON.parse(result.content) as Record<string, unknown>
    assert.equal(payload.file_path, `exports/${expected}`, 'file_path 应为 sanitize 后的中文文件名')

    const targetPath = path.join(sandbox.exportsDir, expected)
    assert.ok(fs.existsSync(targetPath), `应落盘到 ${targetPath}`)

    const readBack = readBackXlsx(targetPath)
    assert.deepEqual(Object.keys(readBack), ['对比表'], 'sheet 名（中文）应保留')
    assert.equal(readBack.对比表.length, 2)
    assert.equal(readBack.对比表[0].项目, 'A')
    assert.equal(readBack.对比表[0].值, 1)
    assert.equal(readBack.对比表[1].项目, 'B')
    assert.equal(readBack.对比表[1].值, 2)
  } finally {
    sandbox.cleanup()
  }
})
