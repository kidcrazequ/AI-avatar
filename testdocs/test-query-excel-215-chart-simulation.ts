/**
 * 模拟：用户问「215 机型 2026 年 1～3 月 设备侧效率折线图」时，LLM 若用三种典型 query_excel 策略会得到什么结果。
 *
 * 目的：对比「无数据」类回答的根因（错列名 / 日期格式 / 表中确实无 2602·2603）。
 *
 * 运行：cd /Users/cnlm007398/AI/soul && npx tsx testdocs/test-query-excel-215-chart-simulation.ts
 */
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import { ToolRouter } from '../packages/core/src/tool-router'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..')
const avatarsPath = path.join(repoRoot, 'avatars')
const avatarId = '小堵-工商储专家'
const excelBase = '00_工商储-产品质量指标dashboard_260303'
const sheet = '总原始表'

const jsonPath = path.join(avatarsPath, avatarId, 'knowledge', '_excel', `${excelBase}.json`)
if (!fs.existsSync(jsonPath)) {
  console.error('跳过：缺少 fixture', jsonPath)
  process.exit(0)
}

const router = new ToolRouter(avatarsPath)

function parseToolJson(r: { content: string; error?: string }) {
  assert.ok(!r.error, r.error ?? '')
  return JSON.parse(r.content) as {
    count: number
    rows: Array<Record<string, unknown>>
    zero_match_hint?: string
    invalid_filter_keys?: string[]
  }
}

/** 策略 A：常见误用 — 杜撰「月份」列 + ISO 日期串（与真实 schema 不符） */
async function simulatedAnswerPathA() {
  const r = await router.execute(avatarId, {
    name: 'query_excel',
    arguments: {
      file: excelBase,
      sheet,
      filter: {
        机型: '215',
        月份: { $gte: '2026-01', $lte: '2026-03' },
      },
      columns: ['月份', '设备侧效率'],
      limit: 20,
    },
  })
  const p = parseToolJson(r)
  assert.equal(p.count, 0, '路径 A：错列名 + ISO 月 → 应为 0 行')
  return p
}

/** 策略 B：列名对，但把「统计周期」当 ISO 范围比（数字与 2026-01 比较永远失败） */
async function simulatedAnswerPathB() {
  const r = await router.execute(avatarId, {
    name: 'query_excel',
    arguments: {
      file: excelBase,
      sheet,
      filter: {
        机型: 215,
        统计周期: { $gte: '2026-01', $lte: '2026-03' },
      },
      columns: ['统计周期', '设备侧效率'],
      limit: 20,
    },
  })
  const p = parseToolJson(r)
  assert.equal(p.count, 0, '路径 B：统计周期用 ISO 范围 → 应为 0 行')
  return p
}

/** 策略 C：与表一致 — YYMM + 含 2/3 月（表中 215 机型可能仅有 2601） */
async function simulatedAnswerPathC() {
  const r = await router.execute(avatarId, {
    name: 'query_excel',
    arguments: {
      file: excelBase,
      sheet,
      filter: {
        机型: 215,
        统计周期: { $in: [2601, 2602, 2603] },
      },
      columns: ['统计周期', '项目', '设备侧效率'],
      limit: 30,
    },
  })
  const p = parseToolJson(r)
  assert.ok(p.count >= 1, '路径 C：正确 YYMM $in → 至少 1 行')
  const nonNullEff = p.rows.filter(row => row['设备侧效率'] != null && row['设备侧效率'] !== '')
  assert.ok(nonNullEff.length >= 1, '路径 C：应能拿到至少一条非空设备侧效率')
  return p
}

async function main() {
  console.log('── 模拟三次「工具回答」对比（query_excel 结果）──\n')
  const a = await simulatedAnswerPathA()
  console.log('路径 A（错列「月份」+ ISO）: count=', a.count, 'hint=', Boolean(a.zero_match_hint))
  const b = await simulatedAnswerPathB()
  console.log('路径 B（统计周期 + ISO 范围）: count=', b.count, 'hint=', Boolean(b.zero_match_hint))
  const c = await simulatedAnswerPathC()
  console.log('路径 C（YYMM $in）: count=', c.count)

  console.log('\n── 根因归纳 ──')
  console.log('1) 路径 A：filter 键不在表列中 → matchFilter 永远不匹配（LLM 易答「无数据」）。')
  console.log('2) 路径 B：统计周期存为数字 2601 等，与 "2026-01" 做 $gte 比较在 JS 中为假 → 0 行。')
  console.log('3) 路径 C：与数据一致；若仍只有 1 个月有值，是**源表尚未有 2602/2603 行**（非工具 bug）。')

  // 修复后：零行时应带诊断 hint，便于首轮自愈
  assert.ok(a.zero_match_hint && a.zero_match_hint.length > 20, '路径 A 应带 zero_match_hint')
  assert.ok(Array.isArray(a.invalid_filter_keys) && a.invalid_filter_keys.includes('月份'), '路径 A 应列出 invalid_filter_keys 含 月份')
  assert.ok(b.zero_match_hint && b.zero_match_hint.includes('YYMM'), '路径 B 的 hint 应提示 YYMM')
  assert.ok(!('zero_match_hint' in c) || !c.zero_match_hint, '路径 C 命中数据时不应强加 zero_match_hint')

  console.log('\n✓ 模拟测试 + 修复后断言全部通过')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
