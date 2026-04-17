/**
 * 子任务 5.1 回归测试：chart-cache.ts 纯函数层
 *
 * 运行方式：cd desktop-app && node_modules/.bin/tsx ../testdocs/test-chart-cache.ts
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import assert from 'assert'
import {
  normalizeQueryForHash,
  hashQueryContent,
  captureFileSnapshot,
  verifySnapshots,
  loadChartCache,
  saveChartCache,
  findChartCacheHit,
  insertChartCacheEntry,
  DEFAULT_MAX_CHART_CACHE_ENTRIES,
  CHART_CACHE_REL_PATH,
  type ChartCacheEntry,
  type ChartCache,
} from '../packages/core/src/utils/chart-cache'

// ── tmp dir ────────────────────────────────────────────────
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'chart-cache-test-'))
const cachePath = path.join(tmpRoot, '_cache', 'charts.json')
process.on('exit', () => {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch { /* ignore */ }
})

// helper：强制 mutate 文件内容且让 size/mtime 至少有一个改变
function mutateFile(p: string, content: string): void {
  fs.writeFileSync(p, content, 'utf-8')
}

// ── 常量 ───────────────────────────────────────────────────
assert.strictEqual(CHART_CACHE_REL_PATH, '_cache/charts.json')
assert.strictEqual(DEFAULT_MAX_CHART_CACHE_ENTRIES, 100)
console.log('✓ 常量')

// ── normalizeQueryForHash ─────────────────────────────────
assert.strictEqual(normalizeQueryForHash('  hello   WORLD  '), 'hello world')
assert.strictEqual(normalizeQueryForHash('A\tB\n C'), 'a b c')
assert.strictEqual(
  normalizeQueryForHash('帮我生成 215 机型 2026年1～3月 折线图'),
  '帮我生成 215 机型 2026年1～3月 折线图',
)
assert.notStrictEqual(normalizeQueryForHash('215机型'), normalizeQueryForHash('215 机型'))
console.log('✓ normalizeQueryForHash')

// ── hashQueryContent ──────────────────────────────────────
const h1 = hashQueryContent('hello world')
const h2 = hashQueryContent('HELLO  WORLD ')
assert.strictEqual(h1, h2, '等价归一后应产同一 hash')
assert.notStrictEqual(h1, hashQueryContent('hello worlds'))
assert.ok(/^[0-9a-f]{8}$/.test(h1), 'hash 应为 8 位十六进制')
console.log('✓ hashQueryContent')

// ── captureFileSnapshot ────────────────────────────────────
const dataFile = path.join(tmpRoot, 'data.json')
mutateFile(dataFile, '{"a":1}')
const snap1 = captureFileSnapshot(dataFile)
assert.ok(snap1.mtimeMs > 0 && snap1.size > 0)

const missingPath = path.join(tmpRoot, 'does-not-exist.json')
const snapMissing = captureFileSnapshot(missingPath)
assert.strictEqual(snapMissing.mtimeMs, 0)
assert.strictEqual(snapMissing.size, 0)
assert.strictEqual(snapMissing.path, missingPath)
console.log('✓ captureFileSnapshot')

// ── verifySnapshots ───────────────────────────────────────
assert.strictEqual(verifySnapshots([snap1]), true, '新快照应立即验证通过')
mutateFile(dataFile, '{"a":1,"b":2,"c":3}')  // size 变 → verify 必失败
assert.strictEqual(verifySnapshots([snap1]), false, '文件 size 变后应验证失败')
// 曾不存在现存在
mutateFile(missingPath, 'now exists')
assert.strictEqual(verifySnapshots([snapMissing]), false, '原不存在现存在 → 失效')
// 复合：一个 match + 一个 mismatch
const freshData = captureFileSnapshot(dataFile)
const freshMissing = captureFileSnapshot(missingPath)
assert.strictEqual(verifySnapshots([freshData, freshMissing]), true)
mutateFile(missingPath, 'changed')
assert.strictEqual(verifySnapshots([freshData, freshMissing]), false, '第二个文件变 → false')
console.log('✓ verifySnapshots')

// ── loadChartCache 缺失 / 损坏 / 合法 ─────────────────────
assert.deepStrictEqual(
  loadChartCache(cachePath),
  { version: 1, entries: [] },
  '缺失文件 → 空 cache',
)
fs.mkdirSync(path.dirname(cachePath), { recursive: true })
fs.writeFileSync(cachePath, 'not-a-json{', 'utf-8')
assert.deepStrictEqual(
  loadChartCache(cachePath),
  { version: 1, entries: [] },
  '损坏 JSON → 空 cache（不抛）',
)
fs.rmSync(cachePath)
console.log('✓ loadChartCache（缺失 / 损坏）')

// ── saveChartCache 原子写 + 回读 ──────────────────────────
mutateFile(dataFile, '{"a":1}')  // 复位 dataFile，重新做个干净快照
const stableSnap = captureFileSnapshot(dataFile)
const sampleEntry: ChartCacheEntry = {
  queryHash: hashQueryContent('hello'),
  queryPreview: 'hello',
  assistantContent: '```chart\n{"series":[]}\n```',
  fileSnapshots: [stableSnap],
  createdAt: Date.now(),
}
saveChartCache(cachePath, { version: 1, entries: [sampleEntry] })
assert.ok(fs.existsSync(cachePath))
assert.strictEqual(
  fs.readdirSync(path.dirname(cachePath)).filter(f => f.endsWith('.tmp')).length,
  0,
  'atomic write 后无 tmp 残留',
)
const loaded = loadChartCache(cachePath)
assert.strictEqual(loaded.entries.length, 1)
assert.strictEqual(loaded.entries[0].queryHash, sampleEntry.queryHash)
assert.strictEqual(loaded.entries[0].assistantContent, sampleEntry.assistantContent)
console.log('✓ saveChartCache 原子写 + 回读')

// ── saveChartCache 自动建目录 ─────────────────────────────
const deepCachePath = path.join(tmpRoot, 'a', 'b', 'c', 'charts.json')
saveChartCache(deepCachePath, { version: 1, entries: [] })
assert.ok(fs.existsSync(deepCachePath))
console.log('✓ saveChartCache 自动建目录')

// ── findChartCacheHit ─────────────────────────────────────
const cache: ChartCache = { version: 1, entries: [sampleEntry] }
// 1) 新鲜快照 → 命中
const hit = findChartCacheHit(cache, sampleEntry.queryHash)
assert.ok(hit, '新快照应命中')
assert.strictEqual(hit!.queryHash, sampleEntry.queryHash)
// 2) 未知 hash → null
assert.strictEqual(findChartCacheHit(cache, 'deadbeef'), null)
// 3) 自定义 verifier 永假 → null
assert.strictEqual(findChartCacheHit(cache, sampleEntry.queryHash, () => false), null)
// 4) 修改底层文件后默认 verifier 应判失效 → null
mutateFile(dataFile, 'something completely different now')
assert.strictEqual(
  findChartCacheHit(cache, sampleEntry.queryHash),
  null,
  '底层文件变后默认 verifier 应判失效',
)
console.log('✓ findChartCacheHit（命中 / miss / verifier 永假 / 文件已变）')

// ── insertChartCacheEntry ─────────────────────────────────
const base: ChartCache = { version: 1, entries: [] }
const e1: ChartCacheEntry = { ...sampleEntry, queryHash: 'aaaaaaaa', createdAt: 1000 }
const e2: ChartCacheEntry = { ...sampleEntry, queryHash: 'bbbbbbbb', createdAt: 2000 }
const e3: ChartCacheEntry = { ...sampleEntry, queryHash: 'cccccccc', createdAt: 3000 }

const afterInsert1 = insertChartCacheEntry(base, e1)
assert.strictEqual(afterInsert1.entries.length, 1)
assert.strictEqual(base.entries.length, 0, 'immutable：原 cache 不变')

// 同 hash 替换
const replaceE1: ChartCacheEntry = { ...e1, assistantContent: '```chart\n{"updated":true}\n```', createdAt: 1500 }
const afterReplace = insertChartCacheEntry(afterInsert1, replaceE1)
assert.strictEqual(afterReplace.entries.length, 1, '同 hash 应替换')
assert.strictEqual(afterReplace.entries[0].assistantContent, replaceE1.assistantContent)

// LRU 淘汰
let lruCache: ChartCache = { version: 1, entries: [] }
lruCache = insertChartCacheEntry(lruCache, e1, 2)
lruCache = insertChartCacheEntry(lruCache, e2, 2)
lruCache = insertChartCacheEntry(lruCache, e3, 2)
assert.strictEqual(lruCache.entries.length, 2)
assert.ok(!lruCache.entries.some(e => e.queryHash === 'aaaaaaaa'), 'e1 应被淘汰（最老）')
assert.ok(lruCache.entries.some(e => e.queryHash === 'bbbbbbbb'))
assert.ok(lruCache.entries.some(e => e.queryHash === 'cccccccc'))
console.log('✓ insertChartCacheEntry（插入 / 替换 / immutable / LRU）')

// ── 加载时过滤非法 entry ──────────────────────────────────
const partialPath = path.join(tmpRoot, 'partial.json')
fs.writeFileSync(
  partialPath,
  JSON.stringify({
    version: 1,
    entries: [
      sampleEntry,
      { queryHash: 'oops' },
      'not-an-object',
      null,
    ],
  }),
  'utf-8',
)
const partialLoaded = loadChartCache(partialPath)
assert.strictEqual(partialLoaded.entries.length, 1, '只保留结构合法 entry')
assert.strictEqual(partialLoaded.entries[0].queryHash, sampleEntry.queryHash)
console.log('✓ 加载时过滤非法 entry')

console.log('\n全部通过 ✅')
