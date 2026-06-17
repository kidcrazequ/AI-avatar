/**
 * Palace 扩展能力测试：条件读 / 建议口径字段、路线卡合并、
 * 承诺/inbox 的可读 Markdown 镜像、按人物/项目/时间的索引、示例路线卡种入。
 *
 * 这些测试守的是“记忆宫殿复刻文章机制”的几条红线：
 * - 新的路由字段不能在落盘时被静默丢掉；
 * - 编辑路线卡某一字段不能顺手清空其它字段（数据丢失）；
 * - JSON 正本必须同步出可读 .md 镜像，且镜像要标注“勿手改”避免用户误改不回写；
 * - Index 必须真的按人物/项目/时间聚合，而不是空目录占位；
 * - 示例路线卡只在显式要求时种入，不能惊扰已建好的宫殿。
 */

import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  PALACE_SCHEMA_VERSION,
  buildExamplePalaceRooms,
  buildPalaceIndexMarkdown,
  ensurePalaceWorkspace,
  getPalaceCommitmentsMarkdownPath,
  getPalaceIndexPath,
  getPalaceInboxMarkdownPath,
  listPalaceRooms,
  makeDefaultPalaceRoom,
  mergePalaceRoom,
  parsePalaceRoomMarkdown,
  renderPalaceCommitmentsMarkdown,
  renderPalaceInboxMarkdown,
  serializePalaceRoom,
  upsertPalaceRoom,
  writePalaceCommitments,
  listPalaceDirectoryFiles,
  readPalaceDirectoryFile,
  writePalaceDirectoryFile,
  deletePalaceDirectoryFile,
  getPalaceDirectoryFilePath,
  type PalaceCommitmentDocument,
  type PalaceInboxDocument,
} from '../index'

const NOW = new Date('2026-06-17T00:00:00.000Z')
const AVATAR_ID = 'ext-avatar'

describe('palace-room conditionalReads / toneGuidance', () => {
  it('round-trip 保留 conditionalReads 与 toneGuidance', () => {
    const room = {
      ...makeDefaultPalaceRoom('conflict', '冲突沟通', NOW),
      conditionalReads: ['涉及职责边界 → 用具体事项做锚点', '需要升级 → 先确认直属领导支持'],
      toneGuidance: '中立、对事不对人；敏感处标 ⚠。',
    }
    const parsed = parsePalaceRoomMarkdown(serializePalaceRoom(room), 'fallback')
    assert.deepEqual(parsed.conditionalReads, room.conditionalReads)
    assert.equal(parsed.toneGuidance, room.toneGuidance)
  })

  it('老路线卡缺这两个字段时解析为安全默认', () => {
    const legacy = '---\nid: legacy\nname: 旧卡\n---\n\n# 旧卡\n'
    const parsed = parsePalaceRoomMarkdown(legacy, 'legacy')
    assert.deepEqual(parsed.conditionalReads, [])
    assert.equal(parsed.toneGuidance, '')
  })
})

describe('mergePalaceRoom', () => {
  it('只更新传入字段，其它字段沿用基线（不丢数据）', () => {
    const base = {
      ...makeDefaultPalaceRoom('daily', '今日驾驶舱', NOW),
      triggers: ['今天该干啥'],
      pitfalls: ['不超一屏'],
      toneGuidance: '简洁',
    }
    const merged = mergePalaceRoom(base, { id: 'daily', name: '今日驾驶舱', priority: 88 }, NOW)
    assert.equal(merged.priority, 88)
    assert.deepEqual(merged.triggers, ['今天该干啥'])
    assert.deepEqual(merged.pitfalls, ['不超一屏'])
    assert.equal(merged.toneGuidance, '简洁')
    assert.equal(merged.createdAt, base.createdAt)
  })

  it('显式传空数组可清空字段，并夹紧 priority、过滤非法沉淀目标', () => {
    const base = { ...makeDefaultPalaceRoom('x', 'X', NOW), triggers: ['a'] }
    const merged = mergePalaceRoom(
      base,
      { id: 'x', name: 'X', triggers: [], priority: 999, sedimentTargets: ['wiki', 'bogus' as never] },
      NOW,
    )
    assert.deepEqual(merged.triggers, [])
    assert.equal(merged.priority, 100)
    assert.deepEqual(merged.sedimentTargets, ['wiki'])
  })
})

describe('markdown 镜像', () => {
  const commitments: PalaceCommitmentDocument = {
    schemaVersion: PALACE_SCHEMA_VERSION,
    commitments: [{
      id: 'cmt-1', direction: 'i_owe_them', title: '周五前交测算', counterparty: '王总',
      promise: '周五前给储能测算', status: 'open', dueAt: '2026-06-19',
      createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
    }],
  }

  it('承诺镜像含内容、对方、id 和“勿手改”警告', () => {
    const md = renderPalaceCommitmentsMarkdown(commitments, NOW)
    assert.match(md, /勿手改/)
    assert.match(md, /王总/)
    assert.match(md, /周五前给储能测算/)
    assert.match(md, /cmt-1/)
    assert.match(md, /我答应别人的/)
  })

  it('inbox 镜像按状态分组并含警告', () => {
    const inbox: PalaceInboxDocument = {
      schemaVersion: PALACE_SCHEMA_VERSION,
      items: [{
        id: 'inbox-1', kind: 'fact', title: '项目进入报价阶段', content: 'XX 进入报价',
        status: 'pending', target: 'projects', createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
      }],
    }
    const md = renderPalaceInboxMarkdown(inbox, NOW)
    assert.match(md, /勿手改/)
    assert.match(md, /待确认/)
    assert.match(md, /项目进入报价阶段/)
    assert.match(md, /\[fact → projects\]/)
  })
})

describe('buildPalaceIndexMarkdown', () => {
  it('按人物（含承诺对方）、项目、时间、路线卡聚合', () => {
    const md = buildPalaceIndexMarkdown({
      now: NOW,
      rooms: [makeDefaultPalaceRoom('daily-room', '今日驾驶舱', NOW)],
      commitments: [{
        id: 'c1', direction: 'i_owe_them', title: 't', counterparty: '王总', promise: 'p',
        status: 'open', createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
      }],
      dirs: {
        people: ['王总.md'],
        projects: ['A2UI.md'],
        meetings: ['2026-06-17-周会.md', 'config-1234-99.md'],
        reports: ['2026-05-w20.md'],
      },
    })
    assert.match(md, /## 按人物/)
    assert.match(md, /王总.*1 条未关闭承诺/s)
    assert.match(md, /## 按项目/)
    assert.match(md, /A2UI/)
    assert.match(md, /### 2026-06/)
    assert.match(md, /### 2026-05/)
    assert.match(md, /今日驾驶舱/)
    // 非法年月（1234-99）不能被当作时间桶
    assert.doesNotMatch(md, /1234-99/)
  })
})

describe('palace workspace seeding + 派生文件', () => {
  let suiteRoot = ''
  let avatarsRoot = ''
  before(() => { suiteRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-palace-ext-')) })
  after(() => { fs.rmSync(suiteRoot, { recursive: true, force: true }) })
  beforeEach(() => {
    avatarsRoot = fs.mkdtempSync(path.join(suiteRoot, 'case-'))
    fs.mkdirSync(path.join(avatarsRoot, AVATAR_ID), { recursive: true })
  })

  it('默认不种示例路线卡（不惊扰）', async () => {
    await ensurePalaceWorkspace(avatarsRoot, AVATAR_ID, NOW)
    assert.equal((await listPalaceRooms(avatarsRoot, AVATAR_ID)).length, 0)
  })

  it('seedExamples=true 时种入示例卡，且示例含条件读与建议口径', async () => {
    await ensurePalaceWorkspace(avatarsRoot, AVATAR_ID, NOW, true)
    const rooms = await listPalaceRooms(avatarsRoot, AVATAR_ID)
    const ids = rooms.map(r => r.id).sort()
    assert.deepEqual(ids, ['conflict-room', 'daily-room', 'report-room'])
    const daily = rooms.find(r => r.id === 'daily-room')!
    assert.ok(daily.conditionalReads.length > 0)
    assert.ok(daily.toneGuidance.length > 0)
    // 派生文件就位
    assert.ok(fs.existsSync(getPalaceIndexPath(avatarsRoot, AVATAR_ID)))
    assert.ok(fs.existsSync(getPalaceCommitmentsMarkdownPath(avatarsRoot, AVATAR_ID)))
    assert.ok(fs.existsSync(getPalaceInboxMarkdownPath(avatarsRoot, AVATAR_ID)))
  })

  it('buildExamplePalaceRooms 返回 3 张带 schemaVersion 的卡', () => {
    const rooms = buildExamplePalaceRooms(NOW)
    assert.equal(rooms.length, 3)
    for (const r of rooms) assert.equal(r.schemaVersion, PALACE_SCHEMA_VERSION)
  })

  it('写承诺会同步生成 commitments.md 镜像并刷新 index.md', async () => {
    await writePalaceCommitments(avatarsRoot, AVATAR_ID, {
      schemaVersion: PALACE_SCHEMA_VERSION,
      commitments: [{
        id: 'cmt-9', direction: 'they_owe_me', title: '回标', counterparty: '李雷', promise: '下周回标',
        status: 'open', createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
      }],
    })
    const mirror = fs.readFileSync(getPalaceCommitmentsMarkdownPath(avatarsRoot, AVATAR_ID), 'utf-8')
    assert.match(mirror, /李雷/)
    const index = fs.readFileSync(getPalaceIndexPath(avatarsRoot, AVATAR_ID), 'utf-8')
    assert.match(index, /李雷/)
  })

  it('upsertPalaceRoom 先创建后更新，created 标志正确', async () => {
    const first = await upsertPalaceRoom(avatarsRoot, AVATAR_ID, { id: 'r1', name: '路线一' }, NOW)
    assert.equal(first.created, true)
    const second = await upsertPalaceRoom(avatarsRoot, AVATAR_ID, { id: 'r1', name: '路线一改名' }, NOW)
    assert.equal(second.created, false)
    assert.equal(second.room.name, '路线一改名')
    const index = fs.readFileSync(getPalaceIndexPath(avatarsRoot, AVATAR_ID), 'utf-8')
    assert.match(index, /路线一改名/)
  })

  it('目录文件 写/读/列/删 全链路 + 写人物刷新索引', async () => {
    await writePalaceDirectoryFile(avatarsRoot, AVATAR_ID, 'people', '王总.md', '# 王总\n\n只看数字。')
    assert.deepEqual(await listPalaceDirectoryFiles(avatarsRoot, AVATAR_ID, 'people'), ['王总.md'])
    assert.match(await readPalaceDirectoryFile(avatarsRoot, AVATAR_ID, 'people', '王总.md'), /只看数字/)
    // 写人物会刷新索引，index.md 应出现该人物
    assert.match(fs.readFileSync(getPalaceIndexPath(avatarsRoot, AVATAR_ID), 'utf-8'), /王总/)

    await deletePalaceDirectoryFile(avatarsRoot, AVATAR_ID, 'people', '王总.md')
    assert.deepEqual(await listPalaceDirectoryFiles(avatarsRoot, AVATAR_ID, 'people'), [])
    assert.equal(await readPalaceDirectoryFile(avatarsRoot, AVATAR_ID, 'people', '王总.md'), '')
  })

  it('目录文件路径拒绝非 .md、路径穿越、隐藏文件', () => {
    assert.throws(() => getPalaceDirectoryFilePath(avatarsRoot, AVATAR_ID, 'people', '王总.txt'), /\.md/)
    assert.throws(() => getPalaceDirectoryFilePath(avatarsRoot, AVATAR_ID, 'people', '../escape.md'), /文件名|路径/)
    assert.throws(() => getPalaceDirectoryFilePath(avatarsRoot, AVATAR_ID, 'people', '.hidden.md'), /\./)
  })
})
