/**
 * soul-pack-zip 单测：自包含 .soulpack.zip 打包/解包 round-trip + 无损二进制。
 *
 * 覆盖：
 *   - isZipFile 按魔数判定 zip / json（扩展名无关）
 *   - writeSoulPackZip → readSoulPackZip → importSoulPack：二进制字节完整无损还原
 *   - blobsPresent / blobCount / manifest_sha256 正确
 *   - readBlob 纵深防御拒绝 .. / 绝对路径
 *   - readBlob 只按声明路径取，未知路径返回 null
 *   - 兼容「单顶层分身目录」普通 zip，并过滤 Mac / 运行期 / 备份杂项
 *   - 旧式 zip 路径穿越、多顶层目录和缺必备文件时拒绝
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
      assert.equal(r.pack.manifest_sha256.length, 64)
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

  it('readBlob 纵深防御：拒绝 .. / 绝对路径（返回 null），正常路径仍可取', async () => {
    const { avatarsRoot, avatarId, binaryBytes, cleanup } = setupAvatar()
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soulpack-zip-slip-'))
    try {
      const zipPath = path.join(outDir, 'a.soulpack.zip')
      await writeSoulPackZip(avatarsRoot, avatarId, {}, zipPath)
      const r = readSoulPackZip(zipPath)
      // 越界路径一律 null，不依赖 core preflight 的调用顺序
      assert.equal(r.readBlob('../evil'), null)
      assert.equal(r.readBlob('/etc/passwd'), null)
      assert.equal(r.readBlob('knowledge/../../escape'), null)
      assert.equal(r.readBlob(''), null)
      // 正常声明路径仍可取到原字节
      assert.deepEqual([...(r.readBlob('knowledge/data.xlsx') as Buffer)], [...binaryBytes])
    } finally {
      cleanup()
      fs.rmSync(outDir, { recursive: true, force: true })
    }
  })

  it('readSoulPackZip 对缺 pack.json 且不是分身目录的普通 zip 抛错', () => {
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

describe('soul-pack-zip / 旧式分身目录 zip 兼容', () => {
  it('单顶层分身目录可预览并无损导入，同时跳过杂项与备份', () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soulpack-legacy-out-'))
    const importRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'soulpack-legacy-import-'))
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const AdmZip = require('adm-zip')
      const zip = new AdmZip()
      const root = 'legacy-electrical-expert'
      const binaryBytes = Buffer.from(Array.from({ length: 2048 }, (_, i) => (i * 7) % 256))
      zip.addFile(`${root}/soul.md`, Buffer.from('# Legacy Electrical Expert\n', 'utf-8'))
      zip.addFile(`${root}/AGENTS.md`, Buffer.from('# Rules\n', 'utf-8'))
      zip.addFile(
        `${root}/expert-pack.json`,
        Buffer.from(JSON.stringify({
          id: root,
          name: '旧式电气工程师',
          description: '用于兼容导入测试',
          domain: '电气工程',
          version: '2.3.4',
          author: 'Kian',
        }), 'utf-8'),
      )
      zip.addFile(`${root}/knowledge/topic.md`, Buffer.from('# Topic\n', 'utf-8'))
      zip.addFile(`${root}/knowledge/drawing.pdf`, binaryBytes)
      zip.addFile(`${root}/memory/MEMORY.md`, Buffer.from('# Memory\nimportant\n', 'utf-8'))
      zip.addFile(`${root}/life/progress.json`, Buffer.from('{"level":2}', 'utf-8'))
      // 以下都应在旧式 zip 转换时被跳过。
      zip.addFile(`${root}/workspaces/default/private.txt`, Buffer.from('private', 'utf-8'))
      zip.addFile(`${root}/knowledge.backup-20260610/stale.md`, Buffer.from('stale', 'utf-8'))
      zip.addFile(`${root}/knowledge/_index/hashes.json`, Buffer.from('{}', 'utf-8'))
      zip.addFile(`${root}/.DS_Store`, Buffer.from('mac', 'utf-8'))
      zip.addFile(`__MACOSX/${root}/._soul.md`, Buffer.from('fork', 'utf-8'))
      const zipPath = path.join(outDir, 'legacy-avatar.zip')
      zip.writeZip(zipPath)

      const read = readSoulPackZip(zipPath)
      assert.equal(read.pack.name, root)
      assert.equal(read.pack.display_name, '旧式电气工程师')
      assert.equal(read.pack.description, '用于兼容导入测试')
      assert.equal(read.pack.domain, '电气工程')
      assert.equal(read.pack.pack_version, '2.3.4')
      assert.equal(read.pack.created_by, 'Kian')
      assert.equal(read.pack.memory_included, true)
      assert.equal(read.blobsPresent, 1)
      assert.ok(read.pack.binary_refs.some((ref) => ref.path === 'knowledge/drawing.pdf'))
      const packedPaths = [
        ...read.pack.files.map((file) => file.path),
        ...read.pack.binary_refs.map((ref) => ref.path),
      ]
      assert.ok(packedPaths.includes('soul.md'))
      assert.ok(packedPaths.includes('knowledge/topic.md'))
      assert.ok(packedPaths.includes('life/progress.json'))
      assert.equal(packedPaths.some((p) => p.startsWith('workspaces/')), false)
      assert.equal(packedPaths.some((p) => p.startsWith('knowledge.backup-')), false)
      assert.equal(packedPaths.some((p) => p.includes('/_index/')), false)
      assert.equal(packedPaths.some((p) => p.startsWith('.')), false)

      const result = importSoulPack(importRoot, read.pack, { readBlob: read.readBlob })
      assert.equal(result.avatarId, root)
      assert.equal(result.memoryRestored, true)
      assert.deepEqual(
        [...fs.readFileSync(path.join(importRoot, root, 'knowledge', 'drawing.pdf'))],
        [...binaryBytes],
      )
      assert.match(fs.readFileSync(path.join(importRoot, root, 'memory', 'MEMORY.md'), 'utf-8'), /important/)
      assert.equal(fs.existsSync(path.join(importRoot, root, 'life', 'progress.json')), true)
      assert.equal(fs.existsSync(path.join(importRoot, root, 'workspaces')), false)
      assert.equal(fs.existsSync(path.join(importRoot, root, 'knowledge.backup-20260610')), false)
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true })
      fs.rmSync(importRoot, { recursive: true, force: true })
    }
  })

  it('拒绝路径穿越 entry，即使它位于合法分身顶层目录中', () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soulpack-legacy-slip-'))
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const AdmZip = require('adm-zip')
      const zip = new AdmZip()
      zip.addFile('legacy-avatar/soul.md', Buffer.from('# Soul\n'))
      zip.addFile('legacy-avatar/AGENTS.md', Buffer.from('# Rules\n'))
      zip.addFile('safe.txt', Buffer.from('evil'))
      // adm-zip addFile 会主动归一化 ../，因此直接改 entryName 构造攻击样本。
      const malicious = zip.getEntries().find((entry: { entryName: string }) => entry.entryName === 'safe.txt')
      assert.ok(malicious)
      malicious.entryName = 'legacy-avatar/../escaped.txt'
      const zipPath = path.join(outDir, 'slip.zip')
      zip.writeZip(zipPath)
      assert.throws(() => readSoulPackZip(zipPath), /路径穿越|非法路径/)
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true })
    }
  })

  it('拒绝同时包含多个顶层分身目录的 zip', () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soulpack-legacy-multi-'))
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const AdmZip = require('adm-zip')
      const zip = new AdmZip()
      zip.addFile('avatar-a/soul.md', Buffer.from('# A\n'))
      zip.addFile('avatar-a/AGENTS.md', Buffer.from('# Rules A\n'))
      zip.addFile('avatar-b/soul.md', Buffer.from('# B\n'))
      zip.addFile('avatar-b/AGENTS.md', Buffer.from('# Rules B\n'))
      const zipPath = path.join(outDir, 'multi.zip')
      zip.writeZip(zipPath)
      assert.throws(() => readSoulPackZip(zipPath), /只有一个顶层分身目录/)
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true })
    }
  })
})
