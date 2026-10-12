/**
 * `SoulLoader` Phase 5 注入逻辑单元测试。
 *
 * 覆盖：
 *   - 有 `life/consolidated.md` → systemPrompt 含「# 我的人生（出厂记忆）」+ 「人生使用守则」
 *   - 没有 `life/consolidated.md` → 不报错且不出现章节标题（兜底安全）
 *   - 工具说明清单含 `read_life_episode`（保证 Phase 5 工具被告知给 LLM）
 *   - `life/manifest.json` 内容变化时 `captureFileSnapshot` 返回不同的 (mtime,size)
 *     —— 证明 main.ts:buildChartCacheEntry 把 manifest.json 加入快照后，
 *     manifest 变更会导致依赖快照的缓存失效（cron 推进/reconsolidate 时安全）
 *
 * 运行方式（与 core.test.ts 一致）：
 *   cd packages/core && npm run build && node --test dist/tests/soul-loader.test.js
 *
 * @author zhi.qu
 * @date 2026-05-09
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { SoulLoader } from '../soul-loader'
import { STRUCTURED_MEMORY_FILENAME } from '../structured-memory'
import { captureFileSnapshot } from '../utils/chart-cache'

// ─── 测试夹具（共享 tmp avatars/ 根） ──────────────────────────────────────────

const AVATAR_ID = 'test-life-avatar'

let tmpRoot = ''
let avatarsRoot = ''
let avatarPath = ''

/**
 * 准备一个最小可用的分身目录：
 *   <tmp>/avatars/test-life-avatar/{CLAUDE.md, soul.md, memory/MEMORY.md}
 *
 * 调用方按需在此基础上写入 life/consolidated.md / life/manifest.json。
 */
function setupAvatarSkeleton(): void {
  fs.mkdirSync(avatarPath, { recursive: true })
  fs.writeFileSync(
    path.join(avatarPath, 'CLAUDE.md'),
    '# 测试分身\n\n这是用于 SoulLoader Phase 5 测试的最小分身。\n',
    'utf-8',
  )
  fs.writeFileSync(
    path.join(avatarPath, 'soul.md'),
    '# soul\n\n测试用人格定义。\n',
    'utf-8',
  )
  fs.mkdirSync(path.join(avatarPath, 'memory'), { recursive: true })
  fs.writeFileSync(
    path.join(avatarPath, 'memory', 'MEMORY.md'),
    '',
    'utf-8',
  )
}

/** 写入 life/consolidated.md（生成「我的人生」章节的真实数据源） */
function writeLifeConsolidated(content: string): void {
  const lifeDir = path.join(avatarPath, 'life')
  fs.mkdirSync(lifeDir, { recursive: true })
  fs.writeFileSync(path.join(lifeDir, 'consolidated.md'), content, 'utf-8')
}

/** 删除 life/consolidated.md（如果存在），用于切换"无人生"用例 */
function removeLifeConsolidated(): void {
  const filePath = path.join(avatarPath, 'life', 'consolidated.md')
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath)
  }
}

/** 写入 life/manifest.json，返回该文件绝对路径（供 captureFileSnapshot 读取） */
function writeLifeManifest(payload: Record<string, unknown>): string {
  const lifeDir = path.join(avatarPath, 'life')
  fs.mkdirSync(lifeDir, { recursive: true })
  const filePath = path.join(lifeDir, 'manifest.json')
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf-8')
  return filePath
}

before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-loader-test-'))
  avatarsRoot = path.join(tmpRoot, 'avatars')
  avatarPath = path.join(avatarsRoot, AVATAR_ID)
  fs.mkdirSync(avatarsRoot, { recursive: true })
  setupAvatarSkeleton()
})

after(() => {
  if (tmpRoot && fs.existsSync(tmpRoot)) {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  }
})

// ─── case 1: 有 consolidated.md → 章节注入成功 ───────────────────────────────

describe('SoulLoader Phase 5 — 人生记忆注入', () => {
  it('有 life/consolidated.md 时 systemPrompt 含「# 我的人生（出厂记忆）」章节', () => {
    writeLifeConsolidated('# 我还记得的人生（35 岁回望）\n\n那年夏天我趴在地板上，听爷爷的旧收音机...\n')

    const loader = new SoulLoader(avatarsRoot)
    const config = loader.loadAvatar(AVATAR_ID)

    assert.ok(config.systemPrompt.includes('# 我的人生（出厂记忆）'), '应包含章节标题')
    assert.ok(
      config.systemPrompt.includes('那年夏天我趴在地板上'),
      'systemPrompt 应包含 consolidated.md 正文片段',
    )
  })

  it('有 life/consolidated.md 时 systemPrompt 含「人生使用守则」段（避免主动卖惨）', () => {
    writeLifeConsolidated('# 我还记得的人生\n\n测试正文。\n')

    const loader = new SoulLoader(avatarsRoot)
    const config = loader.loadAvatar(AVATAR_ID)

    assert.ok(config.systemPrompt.includes('## 人生使用守则'), '应包含守则段标题')
    assert.ok(
      config.systemPrompt.includes('不主动展开往事'),
      '守则段应明确告知不主动讲往事',
    )
    assert.ok(
      config.systemPrompt.includes('read_life_episode'),
      '守则段应引导分身用 read_life_episode 工具翻日记',
    )
  })

  // ─── case 2: 没有 consolidated.md → 不报错且不注入章节 ───────────────────

  it('没有 life/consolidated.md 时不报错且 systemPrompt 不含章节标题', () => {
    removeLifeConsolidated()
    // 同时确保 life/ 目录可不存在（多数老分身的初始状态）
    const lifeDir = path.join(avatarPath, 'life')
    if (fs.existsSync(lifeDir)) {
      fs.rmSync(lifeDir, { recursive: true, force: true })
    }

    const loader = new SoulLoader(avatarsRoot)
    const loadFn = (): string => loader.loadAvatar(AVATAR_ID).systemPrompt
    assert.doesNotThrow(loadFn, '没有 life/consolidated.md 时不应抛错')
    const prompt = loadFn()
    assert.ok(!prompt.includes('# 我的人生（出厂记忆）'), '不应出现章节标题')
    assert.ok(!prompt.includes('## 人生使用守则'), '不应出现守则段')
  })

  it('consolidated.md 内容为空白时也不注入章节（避免出现孤立标题）', () => {
    writeLifeConsolidated('   \n\n  \n')

    const loader = new SoulLoader(avatarsRoot)
    const config = loader.loadAvatar(AVATAR_ID)

    assert.ok(
      !config.systemPrompt.includes('# 我的人生（出厂记忆）'),
      '空白内容不应触发章节注入',
    )
  })

  // ─── case 3: 工具清单含 read_life_episode ───────────────────────────────

  it('systemPrompt 工具说明清单含 read_life_episode', () => {
    // 不论是否有人生，工具说明都该出现（让分身知道有这个工具）
    removeLifeConsolidated()

    const loader = new SoulLoader(avatarsRoot)
    const config = loader.loadAvatar(AVATAR_ID)

    assert.ok(
      config.systemPrompt.includes('read_life_episode'),
      'systemPrompt 应包含 read_life_episode 工具说明',
    )
    assert.ok(
      config.systemPrompt.includes('ep-0007-first-snow') ||
        /ep-\d{4}/.test(config.systemPrompt),
      '工具说明应给出形如 ep-XXXX 的 id 示例',
    )
  })
})

// ─── case 4: life/manifest.json 变化导致快照失效 ─────────────────────────────

describe('SoulLoader Phase 5 — 缓存快照', () => {
  it('life/manifest.json 内容变化时 captureFileSnapshot 返回不同 (mtime, size)', async () => {
    const manifestPath = writeLifeManifest({
      schemaVersion: 1,
      personaName: '测试',
      birthYear: 1991,
      currentAgeMonths: 420,
      generationStatus: 'complete',
    })

    const snap1 = captureFileSnapshot(manifestPath)
    assert.ok(snap1.mtimeMs > 0, '初次写入后 snapshot.mtime 应 > 0')
    assert.ok(snap1.size > 0, '初次写入后 snapshot.size 应 > 0')

    // 等待至少 10ms 保证 mtime 实际推进（macOS HFS+ 也可分辨毫秒）
    await new Promise((resolve) => setTimeout(resolve, 15))

    // 触发变化：cron 推进 → currentAgeMonths +1, lastConsolidatedAt 刷新
    writeLifeManifest({
      schemaVersion: 1,
      personaName: '测试',
      birthYear: 1991,
      currentAgeMonths: 421,
      generationStatus: 'growing',
      lastConsolidatedAt: '2026-05-10T00:00:00Z',
    })

    const snap2 = captureFileSnapshot(manifestPath)
    const changed =
      snap2.mtimeMs !== snap1.mtimeMs || snap2.size !== snap1.size
    assert.ok(
      changed,
      `manifest.json 变化后 snapshot 应变化（mtime: ${snap1.mtimeMs} → ${snap2.mtimeMs}, size: ${snap1.size} → ${snap2.size}）`,
    )
  })

  it('life/manifest.json 不存在时 captureFileSnapshot 返回 (0, 0)', () => {
    const ghostPath = path.join(avatarsRoot, 'never-exist-avatar', 'life', 'manifest.json')
    const snap = captureFileSnapshot(ghostPath)
    assert.equal(snap.mtimeMs, 0, '文件不存在 mtime 应为 0')
    assert.equal(snap.size, 0, '文件不存在 size 应为 0')
  })
})

// ─── case 5: 结构化白盒 Memory（#8） ──────────────────────────────────────────

describe('SoulLoader — MEMORY.entries.json（渐进升级）', () => {
  const structuredPath = () => path.join(avatarPath, 'memory', STRUCTURED_MEMORY_FILENAME)

  it('仅有结构化条目时注入「结构化记忆」段落', () => {
    fs.writeFileSync(path.join(avatarPath, 'memory', 'MEMORY.md'), '', 'utf-8')
    fs.writeFileSync(
      structuredPath(),
      JSON.stringify({
        schemaVersion: 1,
        entries: [{
          id: 't_struct_1',
          createdAt: '2026-05-09T00:00:00.000Z',
          updatedAt: '2026-05-09T00:00:00.000Z',
          category: 'preference',
          content: '只使用公制单位',
        }],
      }),
      'utf-8',
    )

    const loader = new SoulLoader(avatarsRoot)
    const config = loader.loadAvatar(AVATAR_ID)

    assert.ok(config.systemPrompt.includes('# 长期记忆'), '应有长期记忆章节')
    assert.ok(config.systemPrompt.includes('结构化记忆'), '应含结构化小节')
    assert.ok(config.systemPrompt.includes('只使用公制单位'), '应含条目正文')
    assert.ok(!config.systemPrompt.includes('MEMORY.md（兼容）'), '无 legacy 时不应有兼容分隔')
  })

  it('结构化 + MEMORY.md 同时存在时合并注入', () => {
    fs.writeFileSync(path.join(avatarPath, 'memory', 'MEMORY.md'), '# Legacy\n\nhello-md\n', 'utf-8')
    fs.writeFileSync(
      structuredPath(),
      JSON.stringify({
        schemaVersion: 1,
        entries: [{
          id: 't_struct_2',
          createdAt: '2026-05-09T00:00:00.000Z',
          updatedAt: '2026-05-09T00:00:00.000Z',
          category: 'decision',
          content: '条目 A',
        }],
      }),
      'utf-8',
    )

    const loader = new SoulLoader(avatarsRoot)
    const config = loader.loadAvatar(AVATAR_ID)

    assert.ok(config.systemPrompt.includes('条目 A'))
    assert.ok(config.systemPrompt.includes('MEMORY.md（兼容）'))
    assert.ok(config.systemPrompt.includes('hello-md'))

    if (fs.existsSync(structuredPath())) {
      fs.unlinkSync(structuredPath())
    }
  })

  it('无 MEMORY.entries.json 时仅 MEMORY.md 仍是长期记忆来源（兼容旧分身）', () => {
    if (fs.existsSync(structuredPath())) {
      fs.unlinkSync(structuredPath())
    }
    fs.writeFileSync(path.join(avatarPath, 'memory', 'MEMORY.md'), '# 仅有 MD\n\nlegacy-only\n', 'utf-8')

    const loader = new SoulLoader(avatarsRoot)
    const config = loader.loadAvatar(AVATAR_ID)

    assert.ok(config.systemPrompt.includes('# 长期记忆'))
    assert.ok(config.systemPrompt.includes('legacy-only'))
    assert.ok(!config.systemPrompt.includes('结构化记忆（白盒）'), '无 JSON 时不应凭空出现结构化小节标题')
  })
})

// ─── case: 项目知识隔离 —— A 项目资料不会进入 B/default 系统提示 ──────────────

describe('SoulLoader — 项目知识隔离', () => {
  /** 写一个 canonical project knowledge 文件：avatars/<aid>/projects/<pid>/knowledge/<rel> */
  function writeProjectKnowledge(projectId: string, relativePath: string, content: string): void {
    const fullPath = path.join(avatarPath, 'projects', projectId, 'knowledge', relativePath)
    fs.mkdirSync(path.dirname(fullPath), { recursive: true })
    fs.writeFileSync(fullPath, content, 'utf-8')
  }

  /** 写一个 legacy 路径文件（早期版本 projects:create 写到 knowledge/projects/<pid>/） */
  function writeLegacyProjectFile(projectId: string, fileName: string, content: string): void {
    const fullPath = path.join(avatarPath, 'knowledge', 'projects', projectId, fileName)
    fs.mkdirSync(path.dirname(fullPath), { recursive: true })
    fs.writeFileSync(fullPath, content, 'utf-8')
  }

  it('A 项目的 projects/A/knowledge/ 不会出现在 default 会话的 system prompt', () => {
    writeProjectKnowledge('proj-a', 'secret.md', '# A 的秘密\n\nA-PROJECT-SECRET-MARKER\n')
    writeProjectKnowledge('proj-b', 'b-data.md', '# B 数据\n\nB-PROJECT-MARKER\n')

    const loader = new SoulLoader(avatarsRoot)
    const defaultConfig = loader.loadAvatar(AVATAR_ID) // 不传 projectId → default

    assert.ok(
      !defaultConfig.systemPrompt.includes('A-PROJECT-SECRET-MARKER'),
      'default 会话不应看到 A 项目的私有知识',
    )
    assert.ok(
      !defaultConfig.systemPrompt.includes('B-PROJECT-MARKER'),
      'default 会话不应看到 B 项目的私有知识',
    )
  })

  it('B 项目的 system prompt 只含 B 自己的项目知识，不含 A 的', () => {
    writeProjectKnowledge('proj-a', 'a-data.md', '# A 数据\n\nA-EXCLUSIVE-CONTENT\n')
    writeProjectKnowledge('proj-b', 'b-data.md', '# B 数据\n\nB-EXCLUSIVE-CONTENT\n')

    const loader = new SoulLoader(avatarsRoot)
    const configB = loader.loadAvatar(AVATAR_ID, 'proj-b')

    assert.ok(configB.systemPrompt.includes('B-EXCLUSIVE-CONTENT'), 'B 会话应注入 B 自己的项目知识')
    assert.ok(
      !configB.systemPrompt.includes('A-EXCLUSIVE-CONTENT'),
      'B 会话不应看到 A 项目的私有知识（防跨项目泄漏）',
    )
  })

  it('legacy knowledge/projects/<pid>/ 数据不会泄漏到 default 全局知识', () => {
    // 模拟早期版本：projects:create 写到 knowledge/projects/legacy-proj/README.md
    writeLegacyProjectFile('legacy-proj', 'README.md', '# 老 project 模板\n\nLEGACY-LEAK-CANARY\n')

    const loader = new SoulLoader(avatarsRoot)
    const defaultConfig = loader.loadAvatar(AVATAR_ID)

    assert.ok(
      !defaultConfig.systemPrompt.includes('LEGACY-LEAK-CANARY'),
      '老数据 knowledge/projects/ 不应被 readDirectory 顶层 skip 拦截后再泄漏',
    )
  })
})

// ─── case 7: deep-read 顶部注释 ⇒ prompt_excluded（grep-first 方案 B） ──────────

describe('SoulLoader — deep-read 注释文件默认不进 system prompt', () => {
  function writeKnowledge(relPath: string, content: string): void {
    const full = path.join(avatarPath, 'knowledge', relPath)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, content, 'utf-8')
  }

  it('只有 deep-read 来源注释、无 frontmatter 的文件：正文不进 prompt，但列入可检索索引', () => {
    // D 类：deep-read 全文转换产物，仅顶部注释 + 正文，无 YAML frontmatter
    writeKnowledge(
      'deepread-doc.md',
      '<!-- 来源相对路径: 储能/手册.md; 精读日期: 2026-06-05 -->\n\n# 储能手册\nDEEPREAD_BODY_CANARY 这段正文不应进 system prompt\n',
    )
    // 对照组：普通手写小文件（无注释）应照常塞进 prompt
    writeKnowledge('handwritten.md', '# 手写索引\nHANDWRITTEN_BODY_CANARY 这段应进 system prompt\n')

    const loader = new SoulLoader(avatarsRoot)
    const { systemPrompt } = loader.loadAvatar(AVATAR_ID)

    assert.ok(
      !systemPrompt.includes('DEEPREAD_BODY_CANARY'),
      'deep-read 注释文件正文不应被全文塞进 system prompt',
    )
    assert.ok(
      systemPrompt.includes('HANDWRITTEN_BODY_CANARY'),
      '无注释的手写文件应照常进 system prompt（行为不变）',
    )
    assert.ok(
      systemPrompt.includes('deepread-doc.md'),
      'deep-read 文件应出现在「可检索知识」索引中（供 grep 工具按需检索）',
    )
  })
})
