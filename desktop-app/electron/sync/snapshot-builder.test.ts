/**
 * Tests for snapshot-builder (#16 WebDAV cross-device sync · 子任务 6) — round-trip build + extract validation.
 *
 * 验证点（共 8 条用例）：
 *   1. build → extract round-trip：fake avatars + shared + conversations + DB 占位 → 解压后所有文件存在 + manifest sha 校验通过
 *   2. EXCLUDED_DIR_NAMES 排除：avatarsRoot 含 _cache / _index / .verifier → zip 内不存在；_excel 必须保留
 *   3. SnapshotTooLargeError：maxBytes=1024 + 写 2048 字节文件 → 抛 SnapshotTooLargeError，含 actualBytes / maxBytes
 *   4. manifest entries 排序稳定：按 path 升序
 *   5. extractSnapshot sha256 不匹配抛错（zip 篡改后）
 *   6. extractSnapshot zip slip 防御：手工造含 ../ 路径的 zip → 拒绝解压（manifest 缺失等价分支）
 *   7. runDbBackup 失败传播：runDbBackup 抛错 → buildSnapshot 抛同样错
 *   8. deviceName 默认行为：不传 deviceName，manifest.deviceName 不出现
 *
 * 设计：
 *   - 与 db-embeds.test.ts 同款 ABI 探测：archiver / adm-zip 加载失败时优雅 skip 整个 suite
 *   - 注入 fakeLogger（info/warn 静默累积），不依赖单例 Logger
 *   - runDbBackup mock 写一段小占位字节，避免依赖 better-sqlite3
 *
 * @author zhi.qu
 * @date 2026-05-09
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

// ─── archiver / adm-zip 加载探测 ──────────────────────────────────────────────

type SnapshotBuilderModule = typeof import('./snapshot-builder')

interface AdmZipLike {
  addFile(name: string, data: Buffer): void
  writeZip(target: string): void
  getEntry(name: string): { getData(): Buffer; entryName: string; isDirectory: boolean } | null
  getEntries(): Array<{ getData(): Buffer; entryName: string; isDirectory: boolean }>
  updateFile(name: string, data: Buffer): void
}

let snapshotBuilderMod: SnapshotBuilderModule | null = null
let admZipCtor: (new (zipPath?: string) => AdmZipLike) | null = null
let loadError: string | null = null
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('archiver')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  admZipCtor = require('adm-zip') as new (zipPath?: string) => AdmZipLike
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  snapshotBuilderMod = require('./snapshot-builder') as SnapshotBuilderModule
} catch (err) {
  loadError = err instanceof Error ? err.message : String(err)
}
const skipReason = loadError
  ? `跳过：本测试需要 archiver / adm-zip 依赖到位（${loadError.split('\n')[0]}）`
  : null

// ─── 测试夹具 ────────────────────────────────────────────────────────────────

interface CapturedLog {
  info: string[]
  warn: string[]
}

function makeLogger(): { logger: import('./snapshot-builder').SnapshotLogger; captured: CapturedLog } {
  const captured: CapturedLog = { info: [], warn: [] }
  const logger = {
    info: (msg: string) => captured.info.push(msg),
    warn: (msg: string) => captured.warn.push(msg),
  }
  return { logger, captured }
}

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `soul-snapshot-test-${prefix}-`))
}

/**
 * 在 root 下创建一组 fake 文件，便于 buildSnapshot 收集。
 * relPath 用 POSIX 形式；自动 mkdir -p。
 */
function writeFile(root: string, relPath: string, data: Buffer | string): void {
  const abs = path.join(root, ...relPath.split('/'))
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, data)
}

/** 模拟 DatabaseManager.backup(destPath)：写一个固定大小的占位字节流。 */
function makeFakeRunDbBackup(bytes: number): (dest: string) => Promise<void> {
  return async (dest: string) => {
    await fs.promises.writeFile(dest, Buffer.alloc(bytes, 0x44))
  }
}

// ─── 用例 ────────────────────────────────────────────────────────────────────

test('snapshot-builder: build → extract round-trip 全文件存在 + sha 校验通过', { skip: skipReason ?? false }, async () => {
  if (!snapshotBuilderMod) return
  const { buildSnapshot, extractSnapshot } = snapshotBuilderMod

  const work = makeTempDir('roundtrip')
  try {
    const avatarsRoot = path.join(work, 'avatars')
    const sharedRoot = path.join(work, 'shared')
    const conversationsRoot = path.join(work, 'conversations')
    writeFile(avatarsRoot, 'a/avatar.txt', Buffer.alloc(100, 0x01))
    writeFile(avatarsRoot, 'a/knowledge/note.md', Buffer.alloc(100, 0x02))
    writeFile(sharedRoot, 'shared.txt', Buffer.alloc(50, 0x03))
    writeFile(conversationsRoot, 'c1.jsonl', Buffer.from('{"role":"user"}\n', 'utf-8'))

    const zipPath = path.join(work, 'out.zip')
    const { logger } = makeLogger()
    const result = await buildSnapshot({
      outputZipPath: zipPath,
      avatarsRoot,
      sharedRoot,
      conversationsRoot,
      deviceId: 'dev-001',
      deviceName: 'macbook',
      appVersion: '0.1.0',
      dbSchemaVersion: 12,
      runDbBackup: makeFakeRunDbBackup(100),
      logger,
    })

    assert.ok(result.zipBytes > 0, 'zipBytes 应为正数')
    assert.equal(result.manifest.deviceId, 'dev-001')
    assert.equal(result.manifest.appVersion, '0.1.0')
    assert.equal(result.manifest.dbSchemaVersion, 12)
    // 至少包含 4 条：DB 快照 + 2 avatars + 1 shared + 1 conversations
    assert.ok(result.manifest.entries.length >= 4)

    // 解压到新目录
    const outDir = path.join(work, 'extracted')
    const extracted = await extractSnapshot({
      zipPath,
      outputDir: outDir,
      logger,
    })
    assert.equal(extracted.manifest.deviceId, 'dev-001')

    // 关键文件应都存在
    assert.ok(fs.existsSync(path.join(outDir, 'snapshot/xiaodu-snapshot.db')))
    assert.ok(fs.existsSync(path.join(outDir, 'snapshot/avatars/a/avatar.txt')))
    assert.ok(fs.existsSync(path.join(outDir, 'snapshot/avatars/a/knowledge/note.md')))
    assert.ok(fs.existsSync(path.join(outDir, 'snapshot/shared/shared.txt')))
    assert.ok(fs.existsSync(path.join(outDir, 'snapshot/conversations/c1.jsonl')))
  } finally {
    fs.rmSync(work, { recursive: true, force: true })
  }
})

test('snapshot-builder: EXCLUDED_DIR_NAMES 排除 _cache / _index / .verifier，但保留 _excel', { skip: skipReason ?? false }, async () => {
  if (!snapshotBuilderMod || !admZipCtor) return
  const { buildSnapshot } = snapshotBuilderMod

  const work = makeTempDir('excluded')
  try {
    const avatarsRoot = path.join(work, 'avatars')
    writeFile(avatarsRoot, 'a/_cache/cache-1.dat', Buffer.from('CACHE'))
    writeFile(avatarsRoot, 'a/_index/idx.bin', Buffer.from('INDEX'))
    writeFile(avatarsRoot, 'a/.verifier/v.txt', Buffer.from('VERIFIER'))
    // _excel 必须保留（与 §4.14 决策一致）
    writeFile(avatarsRoot, 'a/_excel/sheet.xlsx', Buffer.from('EXCEL_DATA'))
    // 普通文件
    writeFile(avatarsRoot, 'a/keep.txt', Buffer.from('KEEP'))

    const sharedRoot = path.join(work, 'shared')
    const conversationsRoot = path.join(work, 'conversations')

    const zipPath = path.join(work, 'out.zip')
    const { logger } = makeLogger()
    const result = await buildSnapshot({
      outputZipPath: zipPath,
      avatarsRoot,
      sharedRoot,
      conversationsRoot,
      deviceId: 'dev-002',
      appVersion: '0.1.0',
      dbSchemaVersion: 12,
      runDbBackup: makeFakeRunDbBackup(10),
      logger,
    })

    const allPaths = result.manifest.entries.map((e) => e.path)
    assert.ok(!allPaths.some((p) => p.includes('_cache')), `不应包含 _cache：${allPaths.join(',')}`)
    assert.ok(!allPaths.some((p) => p.includes('_index')), `不应包含 _index：${allPaths.join(',')}`)
    assert.ok(!allPaths.some((p) => p.includes('.verifier')), `不应包含 .verifier：${allPaths.join(',')}`)
    assert.ok(allPaths.some((p) => p.includes('_excel')), `应包含 _excel：${allPaths.join(',')}`)
    assert.ok(allPaths.some((p) => p.endsWith('keep.txt')), `应包含 keep.txt：${allPaths.join(',')}`)

    // 进一步交叉校验：直接打开 zip 看 entries
    const zip = new admZipCtor(zipPath)
    const zipEntryNames = zip.getEntries().map((e) => e.entryName)
    assert.ok(!zipEntryNames.some((n) => n.includes('_cache')))
    assert.ok(!zipEntryNames.some((n) => n.includes('_index')))
    assert.ok(!zipEntryNames.some((n) => n.includes('.verifier')))
    assert.ok(zipEntryNames.some((n) => n.includes('_excel')))
  } finally {
    fs.rmSync(work, { recursive: true, force: true })
  }
})

test('snapshot-builder: maxBytes 超限抛 SnapshotTooLargeError', { skip: skipReason ?? false }, async () => {
  if (!snapshotBuilderMod) return
  const { buildSnapshot, SnapshotTooLargeError } = snapshotBuilderMod

  const work = makeTempDir('toolarge')
  try {
    const avatarsRoot = path.join(work, 'avatars')
    // 单文件 2048 字节，远超 1024 上限
    writeFile(avatarsRoot, 'a/big.bin', Buffer.alloc(2048, 0xff))

    const zipPath = path.join(work, 'out.zip')
    const { logger } = makeLogger()
    let caught: unknown = null
    try {
      await buildSnapshot({
        outputZipPath: zipPath,
        avatarsRoot,
        sharedRoot: path.join(work, 'shared'),
        conversationsRoot: path.join(work, 'conversations'),
        deviceId: 'dev-003',
        appVersion: '0.1.0',
        dbSchemaVersion: 12,
        runDbBackup: makeFakeRunDbBackup(10),
        maxBytes: 1024,
        logger,
      })
    } catch (e) {
      caught = e
    }
    assert.ok(
      caught instanceof SnapshotTooLargeError,
      `应抛 SnapshotTooLargeError，实际：${String(caught)}`,
    )
    const err = caught as InstanceType<typeof SnapshotTooLargeError>
    assert.ok(err.actualBytes > 1024, `actualBytes=${err.actualBytes}`)
    assert.equal(err.maxBytes, 1024)
  } finally {
    fs.rmSync(work, { recursive: true, force: true })
  }
})

test('snapshot-builder: manifest entries 按 path 升序排序', { skip: skipReason ?? false }, async () => {
  if (!snapshotBuilderMod) return
  const { buildSnapshot } = snapshotBuilderMod

  const work = makeTempDir('sorted')
  try {
    const avatarsRoot = path.join(work, 'avatars')
    // 故意按反字母序写入
    writeFile(avatarsRoot, 'zzz.txt', Buffer.from('Z'))
    writeFile(avatarsRoot, 'aaa.txt', Buffer.from('A'))
    writeFile(avatarsRoot, 'mmm.txt', Buffer.from('M'))

    const zipPath = path.join(work, 'out.zip')
    const { logger } = makeLogger()
    const result = await buildSnapshot({
      outputZipPath: zipPath,
      avatarsRoot,
      sharedRoot: path.join(work, 'shared'),
      conversationsRoot: path.join(work, 'conversations'),
      deviceId: 'dev-004',
      appVersion: '0.1.0',
      dbSchemaVersion: 12,
      runDbBackup: makeFakeRunDbBackup(10),
      logger,
    })

    const paths = result.manifest.entries.map((e) => e.path)
    const sorted = [...paths].sort()
    assert.deepEqual(paths, sorted, `entries 应按 path 升序：实际 ${paths.join(',')}`)
  } finally {
    fs.rmSync(work, { recursive: true, force: true })
  }
})

test('snapshot-builder: extractSnapshot sha256 不匹配抛错（zip 篡改后）', { skip: skipReason ?? false }, async () => {
  if (!snapshotBuilderMod || !admZipCtor) return
  const { buildSnapshot, extractSnapshot } = snapshotBuilderMod

  const work = makeTempDir('tamper')
  try {
    const avatarsRoot = path.join(work, 'avatars')
    writeFile(avatarsRoot, 'a/file.txt', Buffer.from('original-content'))

    const zipPath = path.join(work, 'out.zip')
    const { logger } = makeLogger()
    await buildSnapshot({
      outputZipPath: zipPath,
      avatarsRoot,
      sharedRoot: path.join(work, 'shared'),
      conversationsRoot: path.join(work, 'conversations'),
      deviceId: 'dev-005',
      appVersion: '0.1.0',
      dbSchemaVersion: 12,
      runDbBackup: makeFakeRunDbBackup(10),
      logger,
    })

    // 篡改策略：用 adm-zip 解压全部 entries，挑一条篡改字节后重新写入新 zip
    // （直接 updateFile + writeZip 会破坏 central directory，extractSnapshot 在 zip 解析阶段就报错；
    //   这里要测的是 sha256 校验链路，所以重建一个完整合法但内容不一致的 zip）
    const oldZip = new admZipCtor(zipPath)
    const allEntries = oldZip.getEntries()
    const target = 'snapshot/avatars/a/file.txt'
    const newZip = new admZipCtor()
    let found = false
    for (const e of allEntries) {
      if (e.entryName === target) {
        // 同长度但不同字节，绕过 size 校验进入 sha256 校验
        const tampered = Buffer.from('TAMPERED-content')
        assert.equal(tampered.length, 'original-content'.length)
        newZip.addFile(e.entryName, tampered)
        found = true
      } else {
        newZip.addFile(e.entryName, e.getData())
      }
    }
    assert.ok(found, `zip 应包含 ${target}`)
    newZip.writeZip(zipPath)

    // extract 时应 sha256 不匹配抛错
    const outDir = path.join(work, 'extracted')
    let caught: unknown = null
    try {
      await extractSnapshot({ zipPath, outputDir: outDir, logger })
    } catch (e) {
      caught = e
    }
    assert.ok(caught instanceof Error, `应抛错，实际：${String(caught)}`)
    assert.match((caught as Error).message, /sha256/i)
  } finally {
    fs.rmSync(work, { recursive: true, force: true })
  }
})

test('snapshot-builder: extractSnapshot zip slip 防御（含 ../ 路径的 zip 拒绝解压）', { skip: skipReason ?? false }, async () => {
  if (!snapshotBuilderMod || !admZipCtor) return
  const { extractSnapshot } = snapshotBuilderMod

  const work = makeTempDir('zipslip')
  try {
    // 手工构造一个含 ../ 的 zip：manifest.json 声明该恶意路径，extract 时应被拒绝
    const evilName = '../../evil-escape.txt'
    const evilData = Buffer.from('PWNED')
    // sha256("PWNED") = 计算固定值；用 node crypto 现算
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const crypto = require('node:crypto') as typeof import('node:crypto')
    const evilSha = crypto.createHash('sha256').update(evilData).digest('hex')
    const manifest = {
      schemaVersion: 1,
      appVersion: '0.1.0',
      dbSchemaVersion: 12,
      deviceId: 'evil-dev',
      createdAt: '2026-05-09T00:00:00.000Z',
      totalBytes: evilData.length,
      entries: [{ path: evilName, size: evilData.length, sha256: evilSha }],
    }

    const zipPath = path.join(work, 'evil.zip')
    const zip = new admZipCtor()
    zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest), 'utf-8'))
    zip.addFile(evilName, evilData)
    zip.writeZip(zipPath)

    const outDir = path.join(work, 'extracted')
    const { logger } = makeLogger()
    let caught: unknown = null
    try {
      await extractSnapshot({ zipPath, outputDir: outDir, logger })
    } catch (e) {
      caught = e
    }
    assert.ok(caught instanceof Error, `应抛错，实际：${String(caught)}`)
    // 错误信息应含「escape」/「illegal」/「slip」之一，或路径校验关键词
    const msg = (caught as Error).message
    assert.match(msg, /escape|illegal|slip|evil-escape/i, `错误信息应指向越界路径：${msg}`)

    // 关键安全断言：恶意文件不应落到 outDir 之外
    assert.ok(
      !fs.existsSync(path.resolve(outDir, '../evil-escape.txt')),
      '恶意文件不应落到 outDir 之外',
    )
  } finally {
    fs.rmSync(work, { recursive: true, force: true })
  }
})

test('snapshot-builder: runDbBackup 失败时 buildSnapshot 抛同样错', { skip: skipReason ?? false }, async () => {
  if (!snapshotBuilderMod) return
  const { buildSnapshot } = snapshotBuilderMod

  const work = makeTempDir('dbfail')
  try {
    const avatarsRoot = path.join(work, 'avatars')
    writeFile(avatarsRoot, 'a/file.txt', Buffer.from('x'))

    const zipPath = path.join(work, 'out.zip')
    const { logger } = makeLogger()
    const failingDb = async (): Promise<void> => {
      throw new Error('DB_BACKUP_FAILED_TEST')
    }

    let caught: unknown = null
    try {
      await buildSnapshot({
        outputZipPath: zipPath,
        avatarsRoot,
        sharedRoot: path.join(work, 'shared'),
        conversationsRoot: path.join(work, 'conversations'),
        deviceId: 'dev-006',
        appVersion: '0.1.0',
        dbSchemaVersion: 12,
        runDbBackup: failingDb,
        logger,
      })
    } catch (e) {
      caught = e
    }
    assert.ok(caught instanceof Error)
    assert.match((caught as Error).message, /DB_BACKUP_FAILED_TEST/)

    // 失败兜底：zip 不应留下半成品（buildSnapshot 内部会 unlink）
    assert.ok(!fs.existsSync(zipPath), '失败时不应残留半成品 zip')
  } finally {
    fs.rmSync(work, { recursive: true, force: true })
  }
})

test('snapshot-builder: 不传 deviceName 时 manifest.deviceName 不出现', { skip: skipReason ?? false }, async () => {
  if (!snapshotBuilderMod) return
  const { buildSnapshot } = snapshotBuilderMod

  const work = makeTempDir('noname')
  try {
    const avatarsRoot = path.join(work, 'avatars')
    writeFile(avatarsRoot, 'a/k.txt', Buffer.from('k'))

    const zipPath = path.join(work, 'out.zip')
    const { logger } = makeLogger()
    const result = await buildSnapshot({
      outputZipPath: zipPath,
      avatarsRoot,
      sharedRoot: path.join(work, 'shared'),
      conversationsRoot: path.join(work, 'conversations'),
      deviceId: 'dev-007',
      // 故意不传 deviceName
      appVersion: '0.1.0',
      dbSchemaVersion: 12,
      runDbBackup: makeFakeRunDbBackup(10),
      logger,
    })

    assert.equal(result.manifest.deviceName, undefined)
  } finally {
    fs.rmSync(work, { recursive: true, force: true })
  }
})
