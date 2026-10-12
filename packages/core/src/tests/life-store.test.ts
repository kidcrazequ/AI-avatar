/**
 * `life-store` 单元测试。
 *
 * 覆盖：
 * - 读：不存在文件返回 null / 空数组 / 空字符串
 * - 写：原子写后能正确读出
 * - 增量：appendLifeTimelineEntry 不丢条目、拒绝重复 id
 * - 删除：deleteLifeEpisode 同步清理 timeline；幂等
 * - 安全：非法 avatarId / episodeId / 路径穿越全部抛错
 *
 * 运行方式（与 core.test.ts 一致）：
 *   cd packages/core && npm run build && node --test dist/tests/life-store.test.js
 *
 * @author zhi.qu
 * @date 2026-05-09
 */

import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  appendLifeTimelineEntry,
  deleteLifeEpisode,
  ensureLifeDir,
  getLifeDir,
  getLifeEpisodePath,
  listLifeEpisodeIds,
  readLifeConsolidated,
  readLifeEpisode,
  readLifeManifest,
  readLifeProgress,
  readLifeTimeline,
  resetGeneratedLife,
  updateLifeManifest,
  writeLifeConsolidated,
  writeLifeEpisode,
  writeLifeManifest,
  writeLifeProgress,
  writeLifeTimeline,
} from '../life/store'
import type {
  LifeManifest,
  LifeProgress,
  LifeTimelineEntry,
} from '../life/types'

// ─── 测试夹具 ────────────────────────────────────────────────────────────────

const AVATAR_ID = 'test-avatar'

function makeManifest(overrides: Partial<LifeManifest> = {}): LifeManifest {
  return {
    schemaVersion: 1,
    displayName: '测试分身',
    personaName: '陈默',
    realNameConfirmed: true,
    nameSource: 'user',
    birthYear: 1991,
    birthMonth: 8,
    birthDay: 15,
    initialAge: 35,
    initialAgeBornAt: '2026-05-09T00:00:00Z',
    timeScale: 1.0,
    lastAdvancedAt: '2026-05-09T00:00:00Z',
    currentAgeMonths: 420,
    growthEnabled: true,
    gender: '男',
    birthplace: '湖北十堰',
    familyBackground: '父亲是机械厂工程师，母亲是中学教师。',
    personalityArc: [{ age: 7, shift: '从胆小转向好奇' }],
    professionalSpine: [{ age: 12, milestone: '第一次拆开收音机' }],
    majorRelationships: [
      { role: '祖父', name: '陈守诚', description: '退休铁路工人，沉默寡言' },
    ],
    createdAt: '2026-05-09',
    totalEpisodes: 0,
    totalChars: 0,
    generationStatus: 'pending',
    lastConsolidatedAt: '2026-05-09T00:00:00Z',
    consolidationCounter: 0,
    ...overrides,
  }
}

function makeTimelineEntry(id: string, overrides: Partial<LifeTimelineEntry> = {}): LifeTimelineEntry {
  return {
    id,
    age: 3,
    year: 1994,
    month: 7,
    title: '爷爷的旧收音机',
    summary: '第一次接触机械的好奇',
    category: 'formative',
    themes: ['好奇心', '机械'],
    importance: 9,
    emotion: 7,
    emotionType: 'wonder',
    wordCount: 2400,
    consolidationStatus: 'remembered',
    consolidationNote: '塑造了拆解复杂事物的习惯',
    ...overrides,
  }
}

function makeProgress(overrides: Partial<LifeProgress> = {}): LifeProgress {
  return {
    stage: 'idle',
    completedEpisodes: 0,
    totalEpisodes: 0,
    usedFallback: false,
    lastError: '',
    updatedAt: '2026-05-09T00:00:00Z',
    failedEpisodes: [],
    consolidationLastTotalEpisodes: 0,
    ...overrides,
  }
}

// ─── 测试主体 ────────────────────────────────────────────────────────────────

describe('life-store', () => {
  let tmpRoot: string

  before(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-life-store-test-'))
  })

  after(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  })

  beforeEach(() => {
    // 每个 case 独立子目录，避免互相污染
    const caseDir = fs.mkdtempSync(path.join(tmpRoot, 'case-'))
    fs.mkdirSync(path.join(caseDir, AVATAR_ID), { recursive: true })
    tmpRoot = caseDir
  })

  // ─── 读：空状态 ────────────────────────────────────────────────────────────

  describe('读取空状态', () => {
    it('readLifeManifest 不存在时返回 null', async () => {
      const result = await readLifeManifest(tmpRoot, AVATAR_ID)
      assert.equal(result, null)
    })

    it('readLifeTimeline 不存在时返回空数组', async () => {
      const result = await readLifeTimeline(tmpRoot, AVATAR_ID)
      assert.deepEqual(result, [])
    })

    it('readLifeEpisode 不存在时返回 null', async () => {
      const result = await readLifeEpisode(tmpRoot, AVATAR_ID, 'ep-9999-nonexistent')
      assert.equal(result, null)
    })

    it('readLifeConsolidated 不存在时返回空字符串', async () => {
      const result = await readLifeConsolidated(tmpRoot, AVATAR_ID)
      assert.equal(result, '')
    })

    it('readLifeProgress 不存在时返回 null', async () => {
      const result = await readLifeProgress(tmpRoot, AVATAR_ID)
      assert.equal(result, null)
    })

    it('listLifeEpisodeIds 目录不存在时返回空数组', async () => {
      const result = await listLifeEpisodeIds(tmpRoot, AVATAR_ID)
      assert.deepEqual(result, [])
    })
  })

  // ─── 写读 round-trip ───────────────────────────────────────────────────────

  describe('写读 round-trip', () => {
    it('writeLifeManifest → readLifeManifest 字段一致', async () => {
      const manifest = makeManifest({ personaName: '林芳' })
      await writeLifeManifest(tmpRoot, AVATAR_ID, manifest)

      const loaded = await readLifeManifest(tmpRoot, AVATAR_ID)
      assert.deepEqual(loaded, manifest)
    })

    it('writeLifeTimeline → readLifeTimeline 顺序保留', async () => {
      const timeline: LifeTimelineEntry[] = [
        makeTimelineEntry('ep-0001-start', { age: 1 }),
        makeTimelineEntry('ep-0003-radio', { age: 3 }),
        makeTimelineEntry('ep-0007-snow', { age: 7 }),
      ]
      await writeLifeTimeline(tmpRoot, AVATAR_ID, timeline)

      const loaded = await readLifeTimeline(tmpRoot, AVATAR_ID)
      assert.equal(loaded.length, 3)
      assert.equal(loaded[0]!.id, 'ep-0001-start')
      assert.equal(loaded[2]!.id, 'ep-0007-snow')
    })

    it('writeLifeEpisode → readLifeEpisode 完整保留正文', async () => {
      const content = '# 那个下午\n\n爷爷把收音机壳子拧开，里面是密密麻麻的电路板。\n'
      await writeLifeEpisode(tmpRoot, AVATAR_ID, { id: 'ep-0003-radio', content })

      const loaded = await readLifeEpisode(tmpRoot, AVATAR_ID, 'ep-0003-radio')
      assert.equal(loaded, content)
    })

    it('writeLifeConsolidated → readLifeConsolidated 完整保留', async () => {
      const text = '# 我还记得的人生（35 岁回望）\n\n那个下午...\n'
      await writeLifeConsolidated(tmpRoot, AVATAR_ID, text)

      const loaded = await readLifeConsolidated(tmpRoot, AVATAR_ID)
      assert.equal(loaded, text)
    })

    it('writeLifeProgress → readLifeProgress 字段一致', async () => {
      const progress = makeProgress({
        stage: 'episodes',
        completedEpisodes: 12,
        totalEpisodes: 80,
        usedFallback: true,
      })
      await writeLifeProgress(tmpRoot, AVATAR_ID, progress)

      const loaded = await readLifeProgress(tmpRoot, AVATAR_ID)
      assert.deepEqual(loaded, progress)
    })

    it('ensureLifeDir 创建 episodes/ 子目录', async () => {
      await ensureLifeDir(tmpRoot, AVATAR_ID)
      const lifeDir = getLifeDir(tmpRoot, AVATAR_ID)
      assert.ok(fs.existsSync(path.join(lifeDir, 'episodes')))
    })
  })

  describe('manifest 编辑与重置', () => {
    it('updateLifeManifest 只更新允许编辑的人生骨架字段', async () => {
      await writeLifeManifest(tmpRoot, AVATAR_ID, makeManifest())

      const updated = await updateLifeManifest(tmpRoot, AVATAR_ID, {
        personaName: '小堵',
        realNameConfirmed: false,
        nameSource: 'avatarName',
        birthplace: '江苏南京',
      })

      assert.equal(updated.personaName, '小堵')
      assert.equal(updated.realNameConfirmed, false)
      assert.equal(updated.nameSource, 'avatarName')
      assert.equal(updated.birthplace, '江苏南京')
      assert.equal(updated.totalEpisodes, 0)
    })

    it('resetGeneratedLife 清空派生文件并保留 manifest 设定', async () => {
      await writeLifeManifest(tmpRoot, AVATAR_ID, makeManifest({ totalEpisodes: 2, generationStatus: 'complete' }))
      await writeLifeTimeline(tmpRoot, AVATAR_ID, [
        makeTimelineEntry('ep-0001-a'),
        makeTimelineEntry('ep-0002-b'),
      ])
      await writeLifeEpisode(tmpRoot, AVATAR_ID, { id: 'ep-0001-a', content: 'a' })
      await writeLifeConsolidated(tmpRoot, AVATAR_ID, 'summary')
      await writeLifeProgress(tmpRoot, AVATAR_ID, makeProgress({ stage: 'complete', totalEpisodes: 2 }))

      const reset = await resetGeneratedLife(tmpRoot, AVATAR_ID, new Date('2026-05-10T00:00:00Z'))

      assert.ok(reset)
      assert.equal(reset.personaName, '陈默')
      assert.equal(reset.totalEpisodes, 0)
      assert.equal(reset.generationStatus, 'pending')
      assert.deepEqual(await readLifeTimeline(tmpRoot, AVATAR_ID), [])
      assert.deepEqual(await listLifeEpisodeIds(tmpRoot, AVATAR_ID), [])
      assert.equal(await readLifeConsolidated(tmpRoot, AVATAR_ID), '')
      assert.equal(await readLifeProgress(tmpRoot, AVATAR_ID), null)
    })

    it('resetGeneratedLife 可选择删除 manifest 以便从 soul.md 重新生成骨架', async () => {
      await writeLifeManifest(tmpRoot, AVATAR_ID, makeManifest({ totalEpisodes: 2, generationStatus: 'failed' }))
      await writeLifeProgress(tmpRoot, AVATAR_ID, makeProgress({ stage: 'failed', totalEpisodes: 0 }))

      const reset = await resetGeneratedLife(
        tmpRoot,
        AVATAR_ID,
        new Date('2026-05-10T00:00:00Z'),
        { preserveManifest: false },
      )

      assert.equal(reset, null)
      assert.equal(await readLifeManifest(tmpRoot, AVATAR_ID), null)
      assert.equal(await readLifeProgress(tmpRoot, AVATAR_ID), null)
    })
  })

  // ─── 增量 timeline ─────────────────────────────────────────────────────────

  describe('appendLifeTimelineEntry', () => {
    it('从空 timeline 追加成功', async () => {
      const entry = makeTimelineEntry('ep-0001-first')
      await appendLifeTimelineEntry(tmpRoot, AVATAR_ID, entry)

      const loaded = await readLifeTimeline(tmpRoot, AVATAR_ID)
      assert.equal(loaded.length, 1)
      assert.equal(loaded[0]!.id, 'ep-0001-first')
    })

    it('保留已有条目顺序，新条目追加到末尾', async () => {
      await writeLifeTimeline(tmpRoot, AVATAR_ID, [
        makeTimelineEntry('ep-0001-a'),
        makeTimelineEntry('ep-0002-b'),
      ])
      await appendLifeTimelineEntry(tmpRoot, AVATAR_ID, makeTimelineEntry('ep-0003-c'))

      const loaded = await readLifeTimeline(tmpRoot, AVATAR_ID)
      assert.deepEqual(
        loaded.map((e) => e.id),
        ['ep-0001-a', 'ep-0002-b', 'ep-0003-c'],
      )
    })

    it('拒绝重复 id', async () => {
      await appendLifeTimelineEntry(tmpRoot, AVATAR_ID, makeTimelineEntry('ep-0001-dup'))
      await assert.rejects(
        appendLifeTimelineEntry(tmpRoot, AVATAR_ID, makeTimelineEntry('ep-0001-dup')),
        /已存在事件/,
      )
    })
  })

  // ─── 删除 episode ───────────────────────────────────────────────────────────

  describe('deleteLifeEpisode', () => {
    it('同步删除 .md 文件 + timeline 条目', async () => {
      await writeLifeEpisode(tmpRoot, AVATAR_ID, { id: 'ep-0005-delete-me', content: 'hi' })
      await writeLifeTimeline(tmpRoot, AVATAR_ID, [
        makeTimelineEntry('ep-0005-delete-me'),
        makeTimelineEntry('ep-0006-keep'),
      ])

      const removed = await deleteLifeEpisode(tmpRoot, AVATAR_ID, 'ep-0005-delete-me')
      assert.equal(removed, true)

      const filePath = getLifeEpisodePath(tmpRoot, AVATAR_ID, 'ep-0005-delete-me')
      assert.equal(fs.existsSync(filePath), false)

      const timeline = await readLifeTimeline(tmpRoot, AVATAR_ID)
      assert.equal(timeline.length, 1)
      assert.equal(timeline[0]!.id, 'ep-0006-keep')
    })

    it('幂等：episode 不存在时返回 false 不抛错', async () => {
      const removed = await deleteLifeEpisode(tmpRoot, AVATAR_ID, 'ep-9999-ghost')
      assert.equal(removed, false)
    })
  })

  // ─── listLifeEpisodeIds ─────────────────────────────────────────────────────

  describe('listLifeEpisodeIds', () => {
    it('按文件名升序返回所有 .md', async () => {
      await writeLifeEpisode(tmpRoot, AVATAR_ID, { id: 'ep-0010-z', content: 'z' })
      await writeLifeEpisode(tmpRoot, AVATAR_ID, { id: 'ep-0001-a', content: 'a' })
      await writeLifeEpisode(tmpRoot, AVATAR_ID, { id: 'ep-0005-m', content: 'm' })

      const ids = await listLifeEpisodeIds(tmpRoot, AVATAR_ID)
      assert.deepEqual(ids, ['ep-0001-a', 'ep-0005-m', 'ep-0010-z'])
    })

    it('忽略隐藏文件和非 .md 文件', async () => {
      await ensureLifeDir(tmpRoot, AVATAR_ID)
      const episodesDir = path.join(getLifeDir(tmpRoot, AVATAR_ID), 'episodes')
      // 写入合法和非法文件
      await writeLifeEpisode(tmpRoot, AVATAR_ID, { id: 'ep-0001-a', content: 'a' })
      fs.writeFileSync(path.join(episodesDir, '.hidden.md'), 'x')
      fs.writeFileSync(path.join(episodesDir, 'note.txt'), 'x')

      const ids = await listLifeEpisodeIds(tmpRoot, AVATAR_ID)
      assert.deepEqual(ids, ['ep-0001-a'])
    })
  })

  // ─── 路径安全防御 ───────────────────────────────────────────────────────────

  describe('路径安全', () => {
    it('avatarId 含 / 抛错', () => {
      assert.throws(() => getLifeDir(tmpRoot, 'evil/avatar'), /非法分身ID/)
    })

    it('avatarId 含 .. 抛错', () => {
      assert.throws(() => getLifeDir(tmpRoot, '..'), /非法分身ID/)
    })

    it('avatarId 为空抛错', () => {
      assert.throws(() => getLifeDir(tmpRoot, ''), /分身ID不能为空/)
    })

    it('episodeId 含 / 抛错', () => {
      assert.throws(
        () => getLifeEpisodePath(tmpRoot, AVATAR_ID, 'evil/path'),
        /非法事件ID/,
      )
    })

    it('episodeId 含 .. 抛错', () => {
      assert.throws(
        () => getLifeEpisodePath(tmpRoot, AVATAR_ID, '..'),
        /非法事件ID/,
      )
    })

    it('episodeId 以 . 开头抛错', () => {
      assert.throws(
        () => getLifeEpisodePath(tmpRoot, AVATAR_ID, '.tmp_secret'),
        /不能以 \. 开头/,
      )
    })

    it('episodeId 含 .md 后缀抛错', () => {
      assert.throws(
        () => getLifeEpisodePath(tmpRoot, AVATAR_ID, 'ep-0001-x.md'),
        /不能包含扩展名/,
      )
    })

    it('readLifeEpisode 对非法 episodeId 抛错', async () => {
      await assert.rejects(
        () => readLifeEpisode(tmpRoot, AVATAR_ID, '../../etc/passwd'),
        /非法事件ID/,
      )
    })

    it('writeLifeEpisode 对非法 episodeId 抛错', async () => {
      await assert.rejects(
        () =>
          writeLifeEpisode(tmpRoot, AVATAR_ID, {
            id: '../escape',
            content: 'x',
          }),
        /非法事件ID/,
      )
    })

    it('appendLifeTimelineEntry 对非法 entry.id 抛错', async () => {
      await assert.rejects(
        () =>
          appendLifeTimelineEntry(tmpRoot, AVATAR_ID, makeTimelineEntry('../bad')),
        /非法事件ID/,
      )
    })
  })

  // ─── JSON 损坏防御 ─────────────────────────────────────────────────────────

  describe('JSON 损坏防御', () => {
    it('manifest.json 不是合法 JSON 时抛带文件名的错误', async () => {
      await ensureLifeDir(tmpRoot, AVATAR_ID)
      const manifestPath = path.join(getLifeDir(tmpRoot, AVATAR_ID), 'manifest.json')
      fs.writeFileSync(manifestPath, '{ broken json', 'utf-8')

      await assert.rejects(
        () => readLifeManifest(tmpRoot, AVATAR_ID),
        /life-store: 解析 JSON 失败/,
      )
    })
  })
})
