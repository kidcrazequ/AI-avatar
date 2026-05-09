/**
 * Tests for snapshot-manifest pure functions (#16 WebDAV cross-device sync · 子任务 6).
 *
 * 验证点（共 11 条用例）：
 *   1. buildSnapshotManifest 基本字段：所有字段透传 + totalBytes 等于 entries.size 累加
 *   2. buildSnapshotManifest 自动按 path 升序排序 entries
 *   3. buildSnapshotManifest 空 entries 抛错
 *   4. computeTotalBytes：3 条 entries 累加正确
 *   5. serializeSnapshotManifest 字节稳定：相同输入两次 serialize 完全相等（防漂移）
 *   6. parseSnapshotManifest 完整往返：build → serialize → JSON.parse → parse 字段一致
 *   7. parseSnapshotManifest schemaVersion 不匹配抛 TypeError
 *   8. parseSnapshotManifest 缺字段（entries）抛错
 *   9. parseSnapshotManifest entries 类型错（size: 'abc'）抛错
 *  10. generateBackupFilename / parseBackupFilename 往返：deviceId / 时间戳一致
 *  11. parseBackupFilename 无效输入返回 null
 *
 * 设计：纯函数模块，无 fs / sqlite / network 依赖；本测试 100% 应在所有平台 pass。
 *
 * @author zhi.qu
 * @date 2026-05-09
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  SNAPSHOT_MANIFEST_VERSION,
  buildSnapshotManifest,
  computeTotalBytes,
  generateBackupFilename,
  parseBackupFilename,
  parseSnapshotManifest,
  serializeSnapshotManifest,
  type BuildSnapshotManifestInput,
  type SnapshotManifest,
  type SnapshotManifestEntry,
} from '../sync/snapshot-manifest'

/**
 * 构造一组测试用 entries。size 用 64 位 hex 占位（满足正则 /^[0-9a-f]{64}$/）。
 */
function fakeEntries(): SnapshotManifestEntry[] {
  const fakeSha = (seed: string): string => seed.padEnd(64, '0').slice(0, 64)
  return [
    { path: 'snapshot/avatars/a.txt', size: 100, sha256: fakeSha('a') },
    { path: 'snapshot/avatars/b.txt', size: 200, sha256: fakeSha('b') },
    { path: 'snapshot/xiaodu-snapshot.db', size: 300, sha256: fakeSha('c') },
  ]
}

function fakeBuildInput(overrides?: Partial<BuildSnapshotManifestInput>): BuildSnapshotManifestInput {
  return {
    appVersion: '0.1.0',
    dbSchemaVersion: 12,
    deviceId: 'device-uuid-001',
    deviceName: 'macbook-pro',
    createdAt: '2026-05-09T08:00:00.000Z',
    entries: fakeEntries(),
    ...overrides,
  }
}

test('snapshot-manifest: buildSnapshotManifest 透传字段并自动计算 totalBytes', () => {
  const input = fakeBuildInput()
  const m = buildSnapshotManifest(input)

  assert.equal(m.schemaVersion, SNAPSHOT_MANIFEST_VERSION)
  assert.equal(m.appVersion, '0.1.0')
  assert.equal(m.dbSchemaVersion, 12)
  assert.equal(m.deviceId, 'device-uuid-001')
  assert.equal(m.deviceName, 'macbook-pro')
  assert.equal(m.createdAt, '2026-05-09T08:00:00.000Z')
  // 100 + 200 + 300
  assert.equal(m.totalBytes, 600)
  assert.equal(m.entries.length, 3)
})

test('snapshot-manifest: buildSnapshotManifest 自动按 path 升序排序 entries', () => {
  // 故意倒序输入，期望输出按字典序升序
  const fakeSha = (s: string) => s.padEnd(64, '0').slice(0, 64)
  const m = buildSnapshotManifest(
    fakeBuildInput({
      entries: [
        { path: 'zzz.txt', size: 1, sha256: fakeSha('1') },
        { path: 'aaa.txt', size: 2, sha256: fakeSha('2') },
        { path: 'mmm.txt', size: 3, sha256: fakeSha('3') },
      ],
    }),
  )
  assert.deepEqual(
    m.entries.map((e) => e.path),
    ['aaa.txt', 'mmm.txt', 'zzz.txt'],
  )
})

test('snapshot-manifest: buildSnapshotManifest 空 entries 抛错', () => {
  assert.throws(
    () => buildSnapshotManifest(fakeBuildInput({ entries: [] })),
    /entr(y|ies)/i,
  )
})

test('snapshot-manifest: computeTotalBytes 累加正确', () => {
  const fakeSha = (s: string) => s.padEnd(64, '0').slice(0, 64)
  const total = computeTotalBytes([
    { path: 'a', size: 100, sha256: fakeSha('1') },
    { path: 'b', size: 200, sha256: fakeSha('2') },
    { path: 'c', size: 300, sha256: fakeSha('3') },
  ])
  assert.equal(total, 600)
  assert.equal(computeTotalBytes([]), 0)
})

test('snapshot-manifest: serializeSnapshotManifest 字节级稳定（防漂移）', () => {
  const m = buildSnapshotManifest(fakeBuildInput())
  const a = serializeSnapshotManifest(m)
  const b = serializeSnapshotManifest(m)
  assert.equal(a, b, '同一份 manifest 两次序列化必须完全相等')

  // entries 顺序不同的两个等价 manifest，serialize 后也应字节相等（serialize 内部排序）
  const fakeSha = (s: string) => s.padEnd(64, '0').slice(0, 64)
  const e1: SnapshotManifestEntry[] = [
    { path: 'a', size: 1, sha256: fakeSha('1') },
    { path: 'b', size: 2, sha256: fakeSha('2') },
  ]
  const e2: SnapshotManifestEntry[] = [...e1].reverse()
  const m1: SnapshotManifest = {
    schemaVersion: SNAPSHOT_MANIFEST_VERSION,
    appVersion: '0.1.0',
    dbSchemaVersion: 12,
    deviceId: 'd',
    createdAt: '2026-05-09T00:00:00.000Z',
    totalBytes: 3,
    entries: e1,
  }
  const m2: SnapshotManifest = { ...m1, entries: e2 }
  assert.equal(serializeSnapshotManifest(m1), serializeSnapshotManifest(m2))
})

test('snapshot-manifest: parseSnapshotManifest 完整往返字段一致', () => {
  const original = buildSnapshotManifest(fakeBuildInput())
  const json = serializeSnapshotManifest(original)
  const parsedJson = JSON.parse(json) as unknown
  const parsed = parseSnapshotManifest(parsedJson)

  assert.equal(parsed.schemaVersion, original.schemaVersion)
  assert.equal(parsed.appVersion, original.appVersion)
  assert.equal(parsed.dbSchemaVersion, original.dbSchemaVersion)
  assert.equal(parsed.deviceId, original.deviceId)
  assert.equal(parsed.deviceName, original.deviceName)
  assert.equal(parsed.createdAt, original.createdAt)
  assert.equal(parsed.totalBytes, original.totalBytes)
  assert.deepEqual(parsed.entries, original.entries)
})

test('snapshot-manifest: parseSnapshotManifest schemaVersion 不匹配抛 TypeError', () => {
  const original = buildSnapshotManifest(fakeBuildInput())
  const broken: Record<string, unknown> = JSON.parse(serializeSnapshotManifest(original)) as Record<
    string,
    unknown
  >
  broken.schemaVersion = 99
  assert.throws(
    () => parseSnapshotManifest(broken),
    (err: unknown) => err instanceof TypeError && /incompatible/i.test(err.message),
  )
})

test('snapshot-manifest: parseSnapshotManifest 缺字段（entries）抛错', () => {
  const original = buildSnapshotManifest(fakeBuildInput())
  const broken: Record<string, unknown> = JSON.parse(serializeSnapshotManifest(original)) as Record<
    string,
    unknown
  >
  delete broken.entries
  assert.throws(() => parseSnapshotManifest(broken), TypeError)
})

test('snapshot-manifest: parseSnapshotManifest entries 类型错抛错', () => {
  const original = buildSnapshotManifest(fakeBuildInput())
  const broken = JSON.parse(serializeSnapshotManifest(original)) as {
    entries: Array<{ path: string; size: unknown; sha256: string }>
  }
  // size 用字符串模拟外部脏数据
  broken.entries[0].size = 'abc'
  assert.throws(() => parseSnapshotManifest(broken), TypeError)

  // 也覆盖 sha256 非 hex / 非 64 位的情况
  const broken2 = JSON.parse(serializeSnapshotManifest(original)) as {
    entries: Array<{ path: string; size: number; sha256: string }>
  }
  broken2.entries[1].sha256 = 'short-hash'
  assert.throws(() => parseSnapshotManifest(broken2), TypeError)
})

test('snapshot-manifest: parseSnapshotManifest 顶层非对象 / deviceId 空抛错', () => {
  assert.throws(() => parseSnapshotManifest(null), TypeError)
  assert.throws(() => parseSnapshotManifest('a string'), TypeError)
  assert.throws(() => parseSnapshotManifest([]), TypeError)

  const original = buildSnapshotManifest(fakeBuildInput())
  const broken = JSON.parse(serializeSnapshotManifest(original)) as Record<string, unknown>
  broken.deviceId = ''
  assert.throws(() => parseSnapshotManifest(broken), TypeError)
})

test('snapshot-manifest: generateBackupFilename / parseBackupFilename 完整往返', () => {
  const deviceId = 'abc-123-deadbeef'
  // 固定 UTC 时间，便于断言字符串
  const date = new Date(Date.UTC(2026, 4, 9, 8, 30, 15)) // 2026-05-09T08:30:15Z
  const filename = generateBackupFilename(deviceId, date)
  assert.equal(filename, `soul-backup-${deviceId}-2026-05-09-08-30-15.zip`)

  const parsed = parseBackupFilename(filename)
  assert.ok(parsed !== null, 'parseBackupFilename 应返回非 null')
  assert.equal(parsed!.deviceId, deviceId)
  assert.equal(parsed!.timestamp.getTime(), date.getTime())

  // generateBackupFilename 边界：空 deviceId / 非法 Date 抛错
  assert.throws(() => generateBackupFilename('', date), /deviceId/i)
  assert.throws(() => generateBackupFilename(deviceId, new Date(NaN)), /date/i)
})

test('snapshot-manifest: parseBackupFilename 无效输入返回 null', () => {
  assert.equal(parseBackupFilename('foo.zip'), null)
  assert.equal(parseBackupFilename('soul-backup-only-deviceid.zip'), null)
  assert.equal(parseBackupFilename(''), null)
  // 时间戳格式错误
  assert.equal(parseBackupFilename('soul-backup-dev-2026-05-09.zip'), null)
  // 后缀错误
  assert.equal(parseBackupFilename('soul-backup-dev-2026-05-09-08-30-15.tar'), null)
})
