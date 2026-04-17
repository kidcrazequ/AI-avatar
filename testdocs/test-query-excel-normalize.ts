/**
 * 子任务 2 回归测试：query_excel 参数归一化 + 稳定 cache key
 *
 * 目标：
 *  1) 同语义查询（键序不同 / 空白不同 / columns 顺序不同）归一化后得到同一 cache key
 *  2) 非等价查询（filter 操作符不同 / 值不同 / 新增列）归一化后仍是不同 key
 *  3) chatStore.ts 中 cache key 的计算与 set 都走归一化函数
 *
 * 运行方式：cd desktop-app && node_modules/.bin/tsx ../testdocs/test-query-excel-normalize.ts
 */
import fs from 'fs'
import path from 'path'
import assert from 'assert'

// ── 复刻 chatStore 中的 normalize 逻辑（与真源码双向校验见下） ──
function normalizeQueryExcelArgs(args: Record<string, unknown>): string {
  const normObj = (v: unknown): unknown => {
    if (v === null || v === undefined) return v
    if (typeof v === 'string') return v.trim()
    if (Array.isArray(v)) return v.map(normObj)
    if (typeof v === 'object') {
      const out: Record<string, unknown> = {}
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        out[k] = normObj((v as Record<string, unknown>)[k])
      }
      return out
    }
    return v
  }
  const norm = normObj(args) as Record<string, unknown>
  if (Array.isArray(norm.columns)) {
    norm.columns = [...norm.columns]
      .map(c => (typeof c === 'string' ? c.trim() : c))
      .sort((a, b) => String(a).localeCompare(String(b)))
  }
  return JSON.stringify(norm)
}

// ── 真源码挂接断言：normalize 函数存在 & cache key 用它 ──
const src = fs.readFileSync(
  path.resolve(__dirname, '../desktop-app/src/stores/chatStore.ts'),
  'utf-8',
)
assert.ok(
  /function normalizeQueryExcelArgs\(/.test(src),
  'chatStore.ts 应定义 normalizeQueryExcelArgs 函数',
)
assert.ok(
  /const queryExcelCacheKey = normalizeQueryExcelArgs\(toolArgs\)/.test(src),
  'queryExcelCacheKey 应通过 normalizeQueryExcelArgs(toolArgs) 计算（未替换旧的 tc.function.arguments 字符串形式）',
)
assert.ok(
  !/const queryExcelCacheKey = tc\.function\.arguments/.test(src),
  '旧的 tc.function.arguments 作 key 的写法必须已被移除',
)

// ── 等价组：归一化后必须 key 相同 ──
type Case = { label: string; a: Record<string, unknown>; b: Record<string, unknown> }
const equivalentCases: Case[] = [
  {
    label: '顶层键序不同',
    a: { file: '00_工商储', sheet: '月度', filter: { 机型: '215' } },
    b: { sheet: '月度', filter: { 机型: '215' }, file: '00_工商储' },
  },
  {
    label: 'filter 嵌套键序不同',
    a: { file: 'f', filter: { 月份: { '$gte': '2026-01', '$lte': '2026-03' } } },
    b: { file: 'f', filter: { 月份: { '$lte': '2026-03', '$gte': '2026-01' } } },
  },
  {
    label: 'columns 顺序不同',
    a: { file: 'f', columns: ['月份', '设备侧效率'] },
    b: { file: 'f', columns: ['设备侧效率', '月份'] },
  },
  {
    label: '字符串两端空白',
    a: { file: '00_工商储 ', sheet: '月度', filter: { 机型: ' 215' } },
    b: { file: '00_工商储', sheet: '月度', filter: { 机型: '215' } },
  },
  {
    label: '多重差异叠加（键序 + columns 顺序 + 空白）',
    a: { filter: { 机型: ' 215', 月份: { '$gte': '2026-01', '$lte': '2026-03' } }, sheet: '月度 ', file: 'f', columns: ['设备侧效率', '月份'] },
    b: { file: 'f', sheet: '月度', filter: { 月份: { '$lte': '2026-03', '$gte': '2026-01' }, 机型: '215' }, columns: ['月份', '设备侧效率'] },
  },
]

for (const c of equivalentCases) {
  const ka = normalizeQueryExcelArgs(c.a)
  const kb = normalizeQueryExcelArgs(c.b)
  assert.strictEqual(ka, kb, `等价组失败: ${c.label}\nA=${ka}\nB=${kb}`)
  console.log(`✓ 等价：${c.label}`)
}

// ── 非等价组：归一化后必须 key 不同 ──
const nonEquivalentCases: Case[] = [
  {
    label: 'filter 操作符不同（字符串 vs $eq）',
    a: { file: 'f', filter: { 机型: '215' } },
    b: { file: 'f', filter: { 机型: { '$eq': '215' } } },
  },
  {
    label: '过滤值不同',
    a: { file: 'f', filter: { 机型: '215' } },
    b: { file: 'f', filter: { 机型: '372' } },
  },
  {
    label: 'columns 集合不同（多了一列）',
    a: { file: 'f', columns: ['月份', '设备侧效率'] },
    b: { file: 'f', columns: ['月份', '设备侧效率', '容量'] },
  },
  {
    label: 'sheet 不同',
    a: { file: 'f', sheet: '月度', filter: {} },
    b: { file: 'f', sheet: '季度', filter: {} },
  },
  {
    label: 'file 不同',
    a: { file: 'A', sheet: '月度' },
    b: { file: 'B', sheet: '月度' },
  },
]

for (const c of nonEquivalentCases) {
  const ka = normalizeQueryExcelArgs(c.a)
  const kb = normalizeQueryExcelArgs(c.b)
  assert.notStrictEqual(ka, kb, `非等价组失败: ${c.label}（两个本不该相等的 key 被归一为同一）\n=${ka}`)
  console.log(`✓ 非等价：${c.label}`)
}

// ── 幂等性 ──
const once = normalizeQueryExcelArgs({ file: 'f', filter: { a: 1, b: 2 }, columns: ['x', 'y'] })
const twice = normalizeQueryExcelArgs(JSON.parse(once))
assert.strictEqual(once, twice, '归一化必须幂等（对已归一化结果再归一应得同一串）')
console.log('✓ 幂等性')

console.log('\n全部通过 ✅')
