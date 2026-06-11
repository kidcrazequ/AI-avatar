/**
 * soul-pack 单元测试（v18 Letta .af 借鉴）
 *
 * 覆盖：
 *   - manifest: serialize → parse roundtrip + sha256 校验 + 篡改拒绝
 *   - export: 必备文件 / 跳过 memory life wiki 默认 / 二进制 ref / external_skills 解析
 *   - import: 不覆盖 / force / path 穿越拒绝 / memory restore / binary ref 报告
 *   - 端到端：export → serialize → parse → import 在另一目录还原
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  exportSoulPack,
  importSoulPack,
  serializeSoulPack,
  parseSoulPack,
  computeManifestSha256,
  sha256Hex,
  SOUL_PACK_SCHEMA_VERSION,
  type SoulPack,
} from '../soul-pack'

/** 在一个临时 avatars 根目录下创建一个最小可工作的 avatar */
function setupAvatar(opts?: {
  withMemory?: boolean
  withLife?: boolean
  withWiki?: boolean
  withBinary?: boolean
  skillsIndex?: string
}): { avatarsRoot: string; avatarId: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-pack-test-'))
  const avatarsRoot = path.join(root, 'avatars')
  const avatarId = 'test-avatar'
  const a = path.join(avatarsRoot, avatarId)
  fs.mkdirSync(a, { recursive: true })

  // 必备：soul.md
  fs.writeFileSync(path.join(a, 'soul.md'), '# Test Avatar\n\nI am a test avatar.\n', 'utf-8')
  // CLAUDE.md
  fs.writeFileSync(path.join(a, 'CLAUDE.md'), '# rules\n', 'utf-8')
  // avatar.config.json
  fs.writeFileSync(path.join(a, 'avatar.config.json'), JSON.stringify({
    displayName: 'Test Display',
    description: 'A test avatar for unit tests',
    domain: 'test',
    defaultModel: { provider: 'deepseek', model: 'deepseek-chat', temperature: 0.7 },
  }), 'utf-8')
  // knowledge
  const knowDir = path.join(a, 'knowledge')
  fs.mkdirSync(knowDir, { recursive: true })
  fs.writeFileSync(path.join(knowDir, 'topic.md'), '# Topic\n\nSome knowledge.\n', 'utf-8')
  // skills + index
  const skillsDir = path.join(a, 'skills')
  fs.mkdirSync(skillsDir, { recursive: true })
  fs.writeFileSync(path.join(skillsDir, 'my-skill.md'), '# my-skill\n\nLocal skill body.\n', 'utf-8')
  fs.writeFileSync(
    path.join(skillsDir, 'skill-index.yaml'),
    opts?.skillsIndex ?? `shared_skills:\n  - name: draw-chart\n    path: shared/skills/draw-chart.md\n    source: shared\ncommunity_skills:\n  - name: data-pack\n    repo: https://github.com/example/data-pack.git\n    ref: v1.0.0\n    skills: [pandas]\n`,
    'utf-8',
  )

  if (opts?.withMemory) {
    const memDir = path.join(a, 'memory')
    fs.mkdirSync(memDir, { recursive: true })
    fs.writeFileSync(path.join(memDir, 'MEMORY.md'), '# Memory\n- pref 1\n', 'utf-8')
    fs.writeFileSync(path.join(memDir, 'standing-orders.md'), '# Standing Orders\n- order 1\n', 'utf-8')
    // 一个 episode
    const epDir = path.join(memDir, 'episodes')
    fs.mkdirSync(epDir, { recursive: true })
    fs.writeFileSync(path.join(epDir, 'conv-1.json'), JSON.stringify({
      schemaVersion: 1, conversationId: 'conv-1', avatarId, title: 't', theme: '', summary: 's',
      keyQuotes: [], themes: [], valence: 0, emotionType: 'joy', importance: 5,
      consolidationStatus: 'remembered', consolidationNote: '',
      conversationStartedAt: 1, conversationLastMessageAt: 2, extractedAt: 3, messageCount: 5,
    }), 'utf-8')
    // daily summary
    const dsDir = path.join(memDir, 'daily-summaries')
    fs.mkdirSync(dsDir, { recursive: true })
    fs.writeFileSync(path.join(dsDir, '2026-05-18.md'), '# 2026-05-18\n\nbody\n', 'utf-8')
  }

  if (opts?.withLife) {
    const lifeDir = path.join(a, 'life')
    fs.mkdirSync(lifeDir, { recursive: true })
    fs.writeFileSync(path.join(lifeDir, 'manifest.json'), '{}', 'utf-8')
  }

  if (opts?.withWiki) {
    const wikiDir = path.join(a, 'wiki', 'concepts')
    fs.mkdirSync(wikiDir, { recursive: true })
    fs.writeFileSync(path.join(wikiDir, 'topic.md'), '# concept\n', 'utf-8')
  }

  if (opts?.withBinary) {
    fs.writeFileSync(path.join(knowDir, 'data.xlsx'), Buffer.from([0x50, 0x4b, 0x03, 0x04])) // tiny "zip" header
  }

  // _index 目录（应被跳过）
  const idxDir = path.join(a, '_index')
  fs.mkdirSync(idxDir, { recursive: true })
  fs.writeFileSync(path.join(idxDir, 'tokens.json'), '{}', 'utf-8')

  // workspaces 目录（应被跳过）
  const wsDir = path.join(a, 'workspaces')
  fs.mkdirSync(wsDir, { recursive: true })
  fs.writeFileSync(path.join(wsDir, 'tmp.txt'), 'leak', 'utf-8')

  return {
    avatarsRoot,
    avatarId,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  }
}

describe('soul-pack / manifest serialize-parse roundtrip', () => {
  it('serialize 后 parse 出来等价 + sha256 校验通过', () => {
    const { avatarsRoot, avatarId, cleanup } = setupAvatar()
    try {
      const pack = exportSoulPack(avatarsRoot, avatarId)
      const json = serializeSoulPack(pack)
      const parsed = parseSoulPack(json)
      assert.equal(parsed.name, avatarId)
      assert.equal(parsed.display_name, 'Test Display')
      assert.equal(parsed.description, 'A test avatar for unit tests')
      assert.equal(parsed.schema_version, SOUL_PACK_SCHEMA_VERSION)
      assert.ok(parsed.files.length >= 4) // soul.md / CLAUDE.md / config / knowledge/topic.md / skills/*
      assert.ok(parsed.files.find(f => f.path === 'soul.md'))
    } finally {
      cleanup()
    }
  })

  it('篡改 file content 后 parse 拒绝（sha256 mismatch）', () => {
    const { avatarsRoot, avatarId, cleanup } = setupAvatar()
    try {
      const pack = exportSoulPack(avatarsRoot, avatarId)
      const json = serializeSoulPack(pack)
      const parsed = JSON.parse(json) as SoulPack
      // 篡改第一个 file 的 content
      parsed.files[0].content = parsed.files[0].content + 'INJECT'
      // 不更新 manifest_sha256 也不更新 file.sha256
      const tampered = JSON.stringify(parsed)
      assert.throws(() => parseSoulPack(tampered), /sha256/)
    } finally {
      cleanup()
    }
  })

  it('schema_version 不匹配时拒绝', () => {
    const { avatarsRoot, avatarId, cleanup } = setupAvatar()
    try {
      const pack = exportSoulPack(avatarsRoot, avatarId)
      const wrongVersionPack = { ...pack, schema_version: 99 }
      const sha = computeManifestSha256(wrongVersionPack)
      const json = JSON.stringify({ ...wrongVersionPack, manifest_sha256: sha })
      assert.throws(() => parseSoulPack(json), /schema 版本/)
    } finally {
      cleanup()
    }
  })

  it('manifest JSON 损坏时抛错', () => {
    assert.throws(() => parseSoulPack('{not valid'), /JSON 解析失败/)
  })

  it('缺必填字段时抛错', () => {
    // 凑一个手工的不完整 pack
    const bad = JSON.stringify({ schema_version: 1 })
    assert.throws(() => parseSoulPack(bad), /缺 name/)
  })
})

describe('soul-pack / export 行为', () => {
  it('默认跳过 memory / life / wiki / _index / workspaces 目录', () => {
    const { avatarsRoot, avatarId, cleanup } = setupAvatar({ withMemory: true, withLife: true, withWiki: true })
    try {
      const pack = exportSoulPack(avatarsRoot, avatarId)
      assert.equal(pack.files.find(f => f.path.startsWith('memory/')), undefined)
      assert.equal(pack.files.find(f => f.path.startsWith('life/')), undefined)
      assert.equal(pack.files.find(f => f.path.startsWith('wiki/')), undefined)
      assert.equal(pack.files.find(f => f.path.startsWith('_index/')), undefined)
      assert.equal(pack.files.find(f => f.path.startsWith('workspaces/')), undefined)
      assert.equal(pack.memory_included, false)
      assert.equal(pack.memory, undefined)
    } finally {
      cleanup()
    }
  })

  it('嵌套层级的 _index（如 knowledge/_index）也不入包', () => {
    const { avatarsRoot, avatarId, cleanup } = setupAvatar()
    try {
      const idxDir = path.join(avatarsRoot, avatarId, 'knowledge', '_index')
      fs.mkdirSync(idxDir, { recursive: true })
      fs.writeFileSync(path.join(idxDir, 'contexts.json'), '{}', 'utf-8')
      const pack = exportSoulPack(avatarsRoot, avatarId)
      assert.equal(pack.files.find(f => f.path.includes('_index')), undefined)
    } finally {
      cleanup()
    }
  })

  it('includeMemory=true 时打包 MEMORY/USER/standing-orders/episodes/daily-summaries', () => {
    const { avatarsRoot, avatarId, cleanup } = setupAvatar({ withMemory: true })
    try {
      const pack = exportSoulPack(avatarsRoot, avatarId, { includeMemory: true })
      assert.equal(pack.memory_included, true)
      assert.ok(pack.memory)
      assert.match(pack.memory.structuredMemoryMd ?? '', /pref 1/)
      assert.match(pack.memory.standingOrdersMd ?? '', /order 1/)
      assert.equal(pack.memory.episodes?.length, 1)
      assert.equal(pack.memory.dailySummaries?.length, 1)
    } finally {
      cleanup()
    }
  })

  it('二进制文件不 inline，只列 binary_refs（含 sha256 + size + mime）', () => {
    const { avatarsRoot, avatarId, cleanup } = setupAvatar({ withBinary: true })
    try {
      const pack = exportSoulPack(avatarsRoot, avatarId)
      const ref = pack.binary_refs.find(r => r.path.endsWith('data.xlsx'))
      assert.ok(ref, 'binary ref 应包含 data.xlsx')
      assert.equal(ref.size, 4)
      assert.ok(ref.sha256.length === 64)
      assert.equal(ref.mime, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      // 文本 inline 不该出现 .xlsx
      assert.equal(pack.files.find(f => f.path.endsWith('.xlsx')), undefined)
    } finally {
      cleanup()
    }
  })

  it('skill-index.yaml 中 shared + community 引用被正确提取到 external_skills', () => {
    const { avatarsRoot, avatarId, cleanup } = setupAvatar()
    try {
      const pack = exportSoulPack(avatarsRoot, avatarId)
      assert.deepEqual(pack.external_skills.shared, ['draw-chart'])
      assert.equal(pack.external_skills.community.length, 1)
      assert.equal(pack.external_skills.community[0].name, 'data-pack')
      assert.equal(pack.external_skills.community[0].ref, 'v1.0.0')
      assert.deepEqual(pack.external_skills.community[0].skills, ['pandas'])
    } finally {
      cleanup()
    }
  })

  it('avatar 不存在时抛错', () => {
    const { avatarsRoot, cleanup } = setupAvatar()
    try {
      assert.throws(() => exportSoulPack(avatarsRoot, 'nonexistent'), /分身不存在/)
    } finally {
      cleanup()
    }
  })

  it('avatarId 非法（路径穿越）时抛错', () => {
    const { avatarsRoot, cleanup } = setupAvatar()
    try {
      assert.throws(() => exportSoulPack(avatarsRoot, '../escape'))
    } finally {
      cleanup()
    }
  })

  it('files 按 path 升序，便于 git diff 稳定', () => {
    const { avatarsRoot, avatarId, cleanup } = setupAvatar()
    try {
      const pack = exportSoulPack(avatarsRoot, avatarId)
      const paths = pack.files.map(f => f.path)
      const sorted = [...paths].sort()
      assert.deepEqual(paths, sorted)
    } finally {
      cleanup()
    }
  })
})

describe('soul-pack / import 行为', () => {
  it('端到端 export → serialize → parse → import：files 完整还原 + sha256 OK', () => {
    const { avatarsRoot, avatarId, cleanup } = setupAvatar()
    try {
      const pack = exportSoulPack(avatarsRoot, avatarId)
      const json = serializeSoulPack(pack)
      const parsed = parseSoulPack(json)

      // 在另一个临时目录 import
      const importRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-pack-import-'))
      try {
        const result = importSoulPack(importRoot, parsed, { targetAvatarId: 'imported' })
        assert.equal(result.avatarId, 'imported')
        assert.ok(result.filesWritten.includes('soul.md'))
        assert.ok(result.filesWritten.includes('knowledge/topic.md'))
        // 还原的 soul.md content 应跟原来一致
        const soulMd = fs.readFileSync(path.join(importRoot, 'imported', 'soul.md'), 'utf-8')
        assert.match(soulMd, /Test Avatar/)
      } finally {
        fs.rmSync(importRoot, { recursive: true, force: true })
      }
    } finally {
      cleanup()
    }
  })

  it('目标 id 已存在且 force=false 时抛错', () => {
    const { avatarsRoot, avatarId, cleanup } = setupAvatar()
    try {
      const pack = exportSoulPack(avatarsRoot, avatarId)
      const json = serializeSoulPack(pack)
      const parsed = parseSoulPack(json)
      // 在同一 avatarsRoot 用同 id 导入
      assert.throws(
        () => importSoulPack(avatarsRoot, parsed),
        /已存在/,
      )
    } finally {
      cleanup()
    }
  })

  it('force=true 时覆盖（先清原目录）', () => {
    const { avatarsRoot, avatarId, cleanup } = setupAvatar()
    try {
      const pack = exportSoulPack(avatarsRoot, avatarId)
      const json = serializeSoulPack(pack)
      const parsed = parseSoulPack(json)
      // 在原目录加个 stray 文件
      fs.writeFileSync(path.join(avatarsRoot, avatarId, 'stray.md'), 'should be gone', 'utf-8')
      const result = importSoulPack(avatarsRoot, parsed, { force: true })
      assert.equal(result.avatarId, avatarId)
      // stray 应被清掉
      assert.equal(fs.existsSync(path.join(avatarsRoot, avatarId, 'stray.md')), false)
    } finally {
      cleanup()
    }
  })

  it('file path 含 .. 时拒绝（防路径穿越）', () => {
    const { avatarsRoot, cleanup } = setupAvatar()
    try {
      // 手工构造一个带恶意 path 的 pack
      const malicious = {
        schema_version: SOUL_PACK_SCHEMA_VERSION,
        name: 'evil',
        display_name: 'evil',
        description: '',
        created_at: new Date().toISOString(),
        pack_version: '1.0.0',
        files: [{
          path: '../escape.md',
          content: 'pwn',
          sha256: sha256Hex('pwn'),
          size: 3,
        }],
        binary_refs: [],
        external_skills: { shared: [], community: [] },
        memory_included: false,
      }
      const sha = computeManifestSha256(malicious)
      const pack = { ...malicious, manifest_sha256: sha } as SoulPack
      assert.throws(
        () => importSoulPack(avatarsRoot, pack),
        /路径穿越/,
      )
    } finally {
      cleanup()
    }
  })

  it('force=true 覆盖时，非法 file path 不删原分身（preflight 先于 rmSync）', () => {
    const { avatarsRoot, avatarId, cleanup } = setupAvatar()
    try {
      // 目标 id = 已存在的原分身；包 manifest/hash 合法但 file path 含 ../
      const malicious = {
        schema_version: SOUL_PACK_SCHEMA_VERSION,
        name: avatarId,
        display_name: avatarId,
        description: '',
        created_at: new Date().toISOString(),
        pack_version: '1.0.0',
        files: [{ path: '../escape.md', content: 'pwn', sha256: sha256Hex('pwn'), size: 3 }],
        binary_refs: [],
        external_skills: { shared: [], community: [] },
        memory_included: false,
      }
      const pack = { ...malicious, manifest_sha256: computeManifestSha256(malicious) } as SoulPack
      const survivorFile = path.join(avatarsRoot, avatarId, 'skills', 'my-skill.md')
      assert.ok(fs.existsSync(survivorFile), '前置：原分身文件应存在')
      assert.throws(() => importSoulPack(avatarsRoot, pack, { force: true }), /路径穿越/)
      // 关键：preflight 在 rmSync 之前拦下，原分身目录与文件未被删除
      assert.ok(fs.existsSync(survivorFile), '原分身应保留，未被覆盖删除')
    } finally {
      cleanup()
    }
  })

  it('memory_included=true 时 restoreMemory 默认开启，写回 memory/', () => {
    const { avatarsRoot, avatarId, cleanup } = setupAvatar({ withMemory: true })
    try {
      const pack = exportSoulPack(avatarsRoot, avatarId, { includeMemory: true })
      const json = serializeSoulPack(pack)
      const parsed = parseSoulPack(json)

      const importRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-pack-mem-'))
      try {
        const result = importSoulPack(importRoot, parsed, { targetAvatarId: 'imported' })
        assert.equal(result.memoryRestored, true)
        assert.ok(fs.existsSync(path.join(importRoot, 'imported', 'memory', 'MEMORY.md')))
        assert.ok(fs.existsSync(path.join(importRoot, 'imported', 'memory', 'standing-orders.md')))
        assert.ok(fs.existsSync(path.join(importRoot, 'imported', 'memory', 'episodes', 'conv-1.json')))
        assert.ok(fs.existsSync(path.join(importRoot, 'imported', 'memory', 'daily-summaries', '2026-05-18.md')))
      } finally {
        fs.rmSync(importRoot, { recursive: true, force: true })
      }
    } finally {
      cleanup()
    }
  })

  it('memory_included=true 但 restoreMemory=false 时跳过 memory', () => {
    const { avatarsRoot, avatarId, cleanup } = setupAvatar({ withMemory: true })
    try {
      const pack = exportSoulPack(avatarsRoot, avatarId, { includeMemory: true })
      const json = serializeSoulPack(pack)
      const parsed = parseSoulPack(json)

      const importRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-pack-mem2-'))
      try {
        const result = importSoulPack(importRoot, parsed, { targetAvatarId: 'imported', restoreMemory: false })
        assert.equal(result.memoryRestored, false)
        assert.equal(fs.existsSync(path.join(importRoot, 'imported', 'memory', 'MEMORY.md')), false)
        assert.ok(result.warnings.some(w => w.includes('跳过')))
      } finally {
        fs.rmSync(importRoot, { recursive: true, force: true })
      }
    } finally {
      cleanup()
    }
  })

  it('binary_refs / external_skills 在 result 上原样返回 + 写入 warnings 提示', () => {
    const { avatarsRoot, avatarId, cleanup } = setupAvatar({ withBinary: true })
    try {
      const pack = exportSoulPack(avatarsRoot, avatarId)
      const json = serializeSoulPack(pack)
      const parsed = parseSoulPack(json)

      const importRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-pack-bin-'))
      try {
        const result = importSoulPack(importRoot, parsed, { targetAvatarId: 'imported' })
        assert.equal(result.binaryRefsMissing.length, 1)
        assert.equal(result.binaryRefsMissing[0].path, 'knowledge/data.xlsx')
        assert.ok(result.warnings.some(w => w.includes('二进制文件 ref')))
        assert.ok(result.warnings.some(w => w.includes('外部技能')))
      } finally {
        fs.rmSync(importRoot, { recursive: true, force: true })
      }
    } finally {
      cleanup()
    }
  })

  it('targetAvatarId 非法时拒绝（防路径穿越）', () => {
    const { avatarsRoot, avatarId, cleanup } = setupAvatar()
    try {
      const pack = exportSoulPack(avatarsRoot, avatarId)
      const json = serializeSoulPack(pack)
      const parsed = parseSoulPack(json)
      assert.throws(() => importSoulPack(avatarsRoot, parsed, { targetAvatarId: '../escape' }))
    } finally {
      cleanup()
    }
  })
})

describe('soul-pack / update 模式（覆盖更新）', () => {
  /**
   * 模拟真实更新场景：packA 装到独立 root 后，本机产生运行期数据
   * （记忆改动、本地新增知识、本机 LLM 配置、_raw 原始文件），
   * 之后作者改源分身再导出 packB 做 update。
   */
  function setupInstalled() {
    const src = setupAvatar({ withMemory: true })
    const srcDir = path.join(src.avatarsRoot, src.avatarId)
    fs.writeFileSync(path.join(srcDir, 'knowledge', 'old.md'), '# Old\n\n初版包含、后续被作者移除的知识。\n', 'utf-8')

    const importRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-pack-update-'))
    const packA = parseSoulPack(serializeSoulPack(exportSoulPack(src.avatarsRoot, src.avatarId, { includeMemory: true })))
    importSoulPack(importRoot, packA, { targetAvatarId: 'imported' })

    const installed = path.join(importRoot, 'imported')
    fs.writeFileSync(path.join(installed, 'memory', 'MEMORY.md'), '# 本机记忆\n- 导入后新增\n', 'utf-8')
    fs.writeFileSync(path.join(installed, 'knowledge', 'local-extra.md'), '# 本地新增知识\n', 'utf-8')
    fs.writeFileSync(path.join(installed, 'avatar.config.json'), JSON.stringify({ displayName: '本机改名' }), 'utf-8')
    const rawDir = path.join(installed, 'knowledge', '_raw')
    fs.mkdirSync(rawDir, { recursive: true })
    fs.writeFileSync(path.join(rawDir, 'origin.xlsx'), Buffer.from([1, 2, 3]))

    return {
      src,
      srcDir,
      importRoot,
      installed,
      exportPackB: (opts?: Parameters<typeof exportSoulPack>[2]) =>
        parseSoulPack(serializeSoulPack(exportSoulPack(src.avatarsRoot, src.avatarId, opts))),
      cleanup: () => {
        src.cleanup()
        fs.rmSync(importRoot, { recursive: true, force: true })
      },
    }
  }

  it('update：写入包内新知识，保留本机 memory / avatar.config.json / 本地新增 / _raw', () => {
    const env = setupInstalled()
    try {
      fs.writeFileSync(path.join(env.srcDir, 'knowledge', 'topic.md'), '# Topic v2\n\n更新后的知识。\n', 'utf-8')
      const result = importSoulPack(env.importRoot, env.exportPackB(), { targetAvatarId: 'imported', mode: 'update' })
      assert.equal(result.mode, 'update')
      assert.match(fs.readFileSync(path.join(env.installed, 'knowledge', 'topic.md'), 'utf-8'), /Topic v2/)
      // 本机运行期数据全部健在
      assert.match(fs.readFileSync(path.join(env.installed, 'memory', 'MEMORY.md'), 'utf-8'), /本机记忆/)
      assert.match(fs.readFileSync(path.join(env.installed, 'avatar.config.json'), 'utf-8'), /本机改名/)
      assert.ok(fs.existsSync(path.join(env.installed, 'knowledge', 'local-extra.md')))
      assert.ok(fs.existsSync(path.join(env.installed, 'knowledge', '_raw', 'origin.xlsx')))
    } finally {
      env.cleanup()
    }
  })

  it('update：按上次包清单清理新版包已移除的文件，本地新增不受影响', () => {
    const env = setupInstalled()
    try {
      assert.ok(fs.existsSync(path.join(env.installed, 'knowledge', 'old.md')))
      fs.rmSync(path.join(env.srcDir, 'knowledge', 'old.md'))
      const result = importSoulPack(env.importRoot, env.exportPackB(), { targetAvatarId: 'imported', mode: 'update' })
      assert.ok(result.filesRemoved.includes('knowledge/old.md'))
      assert.equal(fs.existsSync(path.join(env.installed, 'knowledge', 'old.md')), false)
      assert.ok(fs.existsSync(path.join(env.installed, 'knowledge', 'local-extra.md')))
    } finally {
      env.cleanup()
    }
  })

  it('update：无上次包清单时不删除任何文件，给出残留警告', () => {
    const env = setupInstalled()
    try {
      fs.rmSync(path.join(env.installed, '.soul-pack-state.json'))
      fs.rmSync(path.join(env.srcDir, 'knowledge', 'old.md'))
      const result = importSoulPack(env.importRoot, env.exportPackB(), { targetAvatarId: 'imported', mode: 'update' })
      assert.equal(result.filesRemoved.length, 0)
      assert.ok(fs.existsSync(path.join(env.installed, 'knowledge', 'old.md')))
      assert.ok(result.warnings.some(w => w.includes('包清单')))
    } finally {
      env.cleanup()
    }
  })

  it('update：restoreMemory 默认不恢复包内记忆；显式 true 才覆盖', () => {
    const env = setupInstalled()
    try {
      const r1 = importSoulPack(env.importRoot, env.exportPackB({ includeMemory: true }), { targetAvatarId: 'imported', mode: 'update' })
      assert.equal(r1.memoryRestored, false)
      assert.match(fs.readFileSync(path.join(env.installed, 'memory', 'MEMORY.md'), 'utf-8'), /本机记忆/)

      const r2 = importSoulPack(env.importRoot, env.exportPackB({ includeMemory: true }), { targetAvatarId: 'imported', mode: 'update', restoreMemory: true })
      assert.equal(r2.memoryRestored, true)
      assert.match(fs.readFileSync(path.join(env.installed, 'memory', 'MEMORY.md'), 'utf-8'), /pref 1/)
    } finally {
      env.cleanup()
    }
  })

  it('update：包内 memory/ / _index / _raw 路径被保护跳过（filesSkipped）', () => {
    const env = setupInstalled()
    try {
      const packB = env.exportPackB()
      // importSoulPack 不重验 per-file sha256（parse 阶段才验），可直接注入异常 entry
      packB.files.push({ path: 'memory/MEMORY.md', content: '# 包内插入', sha256: 'x', size: 8 })
      packB.files.push({ path: 'knowledge/_index/contexts.json', content: '{}', sha256: 'x', size: 2 })
      packB.files.push({ path: 'knowledge/_raw/origin.md', content: '# 包内 raw 文本', sha256: 'x', size: 8 })
      const result = importSoulPack(env.importRoot, packB, { targetAvatarId: 'imported', mode: 'update' })
      assert.ok(result.filesSkipped.includes('memory/MEMORY.md'))
      assert.ok(result.filesSkipped.includes('knowledge/_index/contexts.json'))
      assert.ok(result.filesSkipped.includes('knowledge/_raw/origin.md'))
      assert.match(fs.readFileSync(path.join(env.installed, 'memory', 'MEMORY.md'), 'utf-8'), /本机记忆/)
      assert.equal(fs.existsSync(path.join(env.installed, 'knowledge', '_index', 'contexts.json')), false)
      assert.equal(fs.existsSync(path.join(env.installed, 'knowledge', '_raw', 'origin.md')), false)
      // 本机已有的 _raw 正本不受影响
      assert.ok(fs.existsSync(path.join(env.installed, 'knowledge', '_raw', 'origin.xlsx')))
    } finally {
      env.cleanup()
    }
  })

  it('update：目标不存在时退化为全新导入，不报错也无清单警告', () => {
    const env = setupInstalled()
    try {
      const result = importSoulPack(env.importRoot, env.exportPackB(), { targetAvatarId: 'fresh-target', mode: 'update' })
      assert.equal(result.avatarId, 'fresh-target')
      assert.ok(fs.existsSync(path.join(env.importRoot, 'fresh-target', 'soul.md')))
      assert.equal(result.warnings.some(w => w.includes('包清单')), false)
    } finally {
      env.cleanup()
    }
  })
})
