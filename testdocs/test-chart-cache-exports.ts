/**
 * 子任务 5.2 回归测试：
 *  1) @soul/core 顶层 re-export 能拿到所有 chart-cache 公共 API
 *  2) 模拟 main.ts 的 buildChartCacheEntry 逻辑：给分身目录下 soul.md + _excel/<basename>.json
 *     做快照，验证 entry 的 fileSnapshots 数量和路径正确
 *
 * 运行方式：cd desktop-app && node_modules/.bin/tsx ../testdocs/test-chart-cache-exports.ts
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import assert from 'assert'
import * as soulCore from '../packages/core/src/index'
import {
  loadChartCache,
  saveChartCache,
  findChartCacheHit,
  insertChartCacheEntry,
  captureFileSnapshot,
  verifySnapshots,
  normalizeQueryForHash,
  hashQueryContent,
  CHART_CACHE_REL_PATH,
  DEFAULT_MAX_CHART_CACHE_ENTRIES,
  type ChartCacheEntry,
  type ChartCache,
  type FileSnapshot,
} from '../packages/core/src/index'

// ── 1) 顶层 re-export 完整性 ──────────────────────────────
const expectedFunctions = [
  'loadChartCache', 'saveChartCache', 'findChartCacheHit', 'insertChartCacheEntry',
  'captureFileSnapshot', 'verifySnapshots', 'normalizeQueryForHash', 'hashQueryContent',
]
for (const name of expectedFunctions) {
  assert.strictEqual(
    typeof (soulCore as Record<string, unknown>)[name],
    'function',
    `@soul/core 应 re-export 函数 ${name}`,
  )
}
assert.strictEqual(soulCore.CHART_CACHE_REL_PATH, '_cache/charts.json')
assert.strictEqual(soulCore.DEFAULT_MAX_CHART_CACHE_ENTRIES, 100)
console.log(`✓ @soul/core re-export ${expectedFunctions.length} 个函数 + 2 个常量`)

// 类型 re-export 通过 TS 编译时的使用来校验（下面 ChartCacheEntry / ChartCache / FileSnapshot 均被用到）
const _sanityCheck: ChartCache = { version: 1, entries: [] as ChartCacheEntry[] }
const _sanitySnap: FileSnapshot = { path: '/x', mtimeMs: 0, size: 0 }
void _sanityCheck; void _sanitySnap
console.log('✓ ChartCacheEntry / ChartCache / FileSnapshot 类型 re-export 可用')

// ── 2) 模拟 main.ts buildChartCacheEntry ──────────────────
// 构造一个分身目录：<tmp>/avatar/ 下放 soul.md 和 knowledge/_excel/*.json
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'chart-cache-main-'))
const avatarRoot = path.join(tmpRoot, 'avatar-test')
fs.mkdirSync(path.join(avatarRoot, 'knowledge', '_excel'), { recursive: true })
fs.writeFileSync(path.join(avatarRoot, 'soul.md'), '# soul\n', 'utf-8')
fs.writeFileSync(
  path.join(avatarRoot, 'knowledge', '_excel', '00_工商储.json'),
  JSON.stringify({ sheets: [] }),
  'utf-8',
)
fs.writeFileSync(
  path.join(avatarRoot, 'knowledge', '_excel', 'another.json'),
  JSON.stringify({ sheets: [] }),
  'utf-8',
)
process.on('exit', () => {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch { /* ignore */ }
})

// 复刻 main.ts 里的 buildChartCacheEntry 行为
function buildChartCacheEntryReplica(
  avatarRootArg: string,
  payload: { queryHash: string; queryPreview: string; assistantContent: string; excelBasenames?: string[] },
): ChartCacheEntry {
  const fileSnapshots = [
    captureFileSnapshot(path.join(avatarRootArg, 'soul.md')),
  ]
  for (const basename of payload.excelBasenames ?? []) {
    fileSnapshots.push(
      captureFileSnapshot(path.join(avatarRootArg, 'knowledge', '_excel', `${basename}.json`)),
    )
  }
  return {
    queryHash: payload.queryHash,
    queryPreview: payload.queryPreview.slice(0, 200),
    assistantContent: payload.assistantContent,
    fileSnapshots,
    createdAt: Date.now(),
  }
}

const entry = buildChartCacheEntryReplica(avatarRoot, {
  queryHash: hashQueryContent('测试问题'),
  queryPreview: '测试问题',
  assistantContent: '```chart\n{"series":[]}\n```',
  excelBasenames: ['00_工商储', 'another'],
})

assert.strictEqual(entry.fileSnapshots.length, 3, 'snapshots 应含 soul.md + 2 个 excel = 3 条')
assert.ok(entry.fileSnapshots[0].path.endsWith('soul.md'), '第 1 条应是 soul.md')
assert.ok(entry.fileSnapshots[0].mtimeMs > 0, 'soul.md 存在 → mtime > 0')
assert.ok(entry.fileSnapshots[1].path.endsWith('00_工商储.json'))
assert.ok(entry.fileSnapshots[2].path.endsWith('another.json'))
assert.ok(entry.fileSnapshots[1].size > 0 && entry.fileSnapshots[2].size > 0)
console.log('✓ buildChartCacheEntry 行为：soul.md + N 个 excel → N+1 条 snapshot')

// queryPreview 超过 200 字截断
const longPreview = 'x'.repeat(300)
const longEntry = buildChartCacheEntryReplica(avatarRoot, {
  queryHash: '12345678',
  queryPreview: longPreview,
  assistantContent: '',
})
assert.strictEqual(longEntry.queryPreview.length, 200, 'queryPreview 超长应截断到 200 字')
console.log('✓ queryPreview 截断 200 字')

// ── 3) 写入 → 读出 → verify → miss after mutate 全链路 ─────
const cachePath = path.join(avatarRoot, CHART_CACHE_REL_PATH)
const initial = loadChartCache(cachePath)
assert.deepStrictEqual(initial.entries, [], '初始 cache 应空')

const withEntry = insertChartCacheEntry(initial, entry)
saveChartCache(cachePath, withEntry)

const reloaded = loadChartCache(cachePath)
assert.strictEqual(reloaded.entries.length, 1)

// 命中：所有 snapshot 文件未变
const hit = findChartCacheHit(reloaded, entry.queryHash)
assert.ok(hit, '所有文件未变时应命中')
assert.strictEqual(hit!.assistantContent, entry.assistantContent)
console.log('✓ 全链路：save → load → findChartCacheHit 命中')

// 模拟 Excel 重新导入（重写 _excel/00_工商储.json）→ 应失效
fs.writeFileSync(
  path.join(avatarRoot, 'knowledge', '_excel', '00_工商储.json'),
  JSON.stringify({ sheets: [{ name: 'new-sheet' }] }),
  'utf-8',
)
const afterMutate = loadChartCache(cachePath)
assert.strictEqual(
  findChartCacheHit(afterMutate, entry.queryHash),
  null,
  '_excel 文件变更后应失效',
)
console.log('✓ _excel 重写 → 快照失效，cache miss')

// 模拟 soul.md 变更 → 也应失效
fs.writeFileSync(path.join(avatarRoot, 'knowledge', '_excel', '00_工商储.json'), JSON.stringify({ sheets: [] }), 'utf-8')
// 把 soul.md 改动
fs.writeFileSync(path.join(avatarRoot, 'soul.md'), '# soul v2\n修改过\n', 'utf-8')
const afterSoul = loadChartCache(cachePath)
assert.strictEqual(
  findChartCacheHit(afterSoul, entry.queryHash),
  null,
  'soul.md 变更后也应失效',
)
console.log('✓ soul.md 改 → 快照失效，cache miss')

console.log('\n全部通过 ✅')
