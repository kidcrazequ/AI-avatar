/**
 * soul-pack-zip 单测：自包含 .soulpack.zip 打包/解包 round-trip + 无损二进制。
 *
 * 覆盖：
 *   - isZipFile 按魔数判定 zip / json（扩展名无关）
 *   - writeSoulPackZip → readSoulPackZip → importSoulPack：二进制字节完整无损还原
 *   - blobsPresent / blobCount / fileSha256 正确
 *   - readBlob 只按声明路径取，未知路径返回 null
 *   - readSoulPackZip 拒绝缺 pack.json 的普通 zip
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { importSoulPack } from '@soul/core'
import { writeSoulPackZip, readSoulPackZip, isZipFile } from './soul-pack-zip'

function setupAvatar(): { avatarsRoot: string; avatarId: string; binaryBytes: Buffer; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soulpack-zip-test-'))
  const avatarsRoot = path.join(root, 'avatars')
  const avatarId = 'zip-avatar'
  const a = path.join(avatarsRoot, avatarId)
  fs.mkdirSync(path.join(a, 'knowledge'), { recursive: true })
  fs.writeFileSync(path.join(a, 'soul.md'), '# Zip Avatar\n\nbody\n', 'utf-8')
  fs.writeFileSync(path.join(a, 'CLAUDE.md'), '# rules\n', 'utf-8')
  fs.writeFileSync(
    path.join(a, 'avatar.config.json'),
    JSON.stringify({ displayName: 'Zip', description: 'z', domain: 'test' }),
    'utf-8',
  )
  fs.writeFileSync(path.join(a, 'knowledge', 'topic.md'), '# Topic\n', 'utf-8')
  // 非 inline 扩展名 → 进 binary_refs；内容用可复现的字节序列，便于逐字节比对
  const binaryBytes = Buffer.from(Array.from({ length: 5000 }, (_, i) => i % 256))
  fs.writeFileSync(path.join(a, 'knowledge', 'data.xlsx'), binaryBytes)
  return {
    avatarsRoot,
    avatarId,
    binaryBytes,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  }
}

describe('soul-pack-zip / isZipFile', () => {
  it('对 zip 魔数返回 true，对 json 文本返回 false', async () => {
    const { avatarsRoot, avatarId, cleanup } = setupAvatar()
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soulpack-zip-out-'))
    try {
      const zipPath = path.join(outDir, 'a.soulpack.zip')
      await writeSoulPackZip(avatarsRoot, avatarId, {}, zipPath)
      assert.equal(isZipFile(zipPath), true)

      const jsonPath = path.join(outDir, 'a.json')
      fs.writeFileSync(jsonPath, '{"schema_version":1}', 'utf-8')
      assert.equal(isZipFile(jsonPath), false)
    } finally {
      cleanup()
      fs.rmSync(outDir, { recursive: true, force: true })
    }
  })
})

describe('soul-pack-zip / round-trip 无损', () => {
  it('write → read → import：二进制 blob 字节完整还原', async () => {
    const { avatarsRoot, avatarId, binaryBytes, cleanup } = setupAvatar()
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soulpack-zip-rt-'))
    const importRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'soulpack-zip-imp-'))
    try {
      const zipPath = path.join(outDir, 'a.soulpack.zip')
      const w = await writeSoulPackZip(avatarsRoot, avatarId, {}, zipPath)
      assert.equal(w.blobCount, 1)
      assert.deepEqual(w.blobsMissing, [])
      assert.ok(w.pack.binary_refs.some((r) => r.path === 'knowledge/data.xlsx'))

      const r = readSoulPackZip(zipPath)
      assert.equal(r.blobsPresent, 1)
      assert.equal(r.fileSha256.length, 64)
      assert.equal(r.pack.binary_refs.length, 1)
      // readBlob 取到与原文件一致的字节
      const blob = r.readBlob('knowledge/data.xlsx')
      assert.ok(blob)
      assert.deepEqual([...blob], [...binaryBytes])
      // 未声明的路径返回 null
      assert.equal(r.readBlob('knowledge/missing.xlsx'), null)

      const result = importSoulPack(importRoot, r.pack, { targetAvatarId: 'imported', readBlob: r.readBlob })
      assert.equal(result.binaryRefsWritten.length, 1)
      assert.equal(result.binaryRefsMissing.length, 0)
      const restored = fs.readFileSync(path.join(importRoot, 'imported', 'knowledge', 'data.xlsx'))
      assert.deepEqual([...restored], [...binaryBytes])
      // 文本文件也完整还原
      assert.match(fs.readFileSync(path.join(importRoot, 'imported', 'soul.md'), 'utf-8'), /Zip Avatar/)
    } finally {
      cleanup()
      fs.rmSync(outDir, { recursive: true, force: true })
      fs.rmSync(importRoot, { recursive: true, force: true })
    }
  })

  it('readSoulPackZip 对缺 pack.json 的普通 zip 抛错', () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soulpack-zip-bad-'))
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const AdmZip = require('adm-zip')
      const zip = new AdmZip()
      zip.addFile('random.txt', Buffer.from('hi'))
      const p = path.join(outDir, 'not-a-pack.zip')
      zip.writeZip(p)
      assert.throws(() => readSoulPackZip(p), /pack\.json|有效/)
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true })
    }
  })
})
