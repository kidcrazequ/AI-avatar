/**
 * Palace P0 文件协议测试。
 */

import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  PALACE_DIRECTORIES,
  PALACE_PROFILE_MAX_CHARS,
  PALACE_SCHEMA_VERSION,
  buildDefaultPalaceManifest,
  countPalacePendingInboxItems,
  deletePalaceRoom,
  ensurePalaceWorkspace,
  getPalaceCommitmentsPath,
  getPalaceCompanyPath,
  getPalaceDirectoryPath,
  getPalaceInboxPath,
  getPalaceManifestPath,
  getPalaceProfilePath,
  makeDefaultPalaceRoom,
  parsePalaceRoomMarkdown,
  readPalaceCommitments,
  readPalaceCompany,
  readPalaceInbox,
  readPalaceManifest,
  readPalaceProfile,
  readPalaceRoom,
  serializePalaceRoom,
  listPalaceRooms,
  writePalaceCommitments,
  writePalaceCompany,
  writePalaceInbox,
  writePalaceProfile,
  writePalaceRoom,
  type PalaceCommitmentDocument,
  type PalaceInboxDocument,
  type PalaceRoom,
} from '../index'

const AVATAR_ID = 'test-avatar'

describe('palace-store', () => {
  let suiteRoot = ''
  let avatarsRoot = ''

  before(() => {
    suiteRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-palace-store-test-'))
  })

  after(() => {
    fs.rmSync(suiteRoot, { recursive: true, force: true })
  })

  beforeEach(() => {
    avatarsRoot = fs.mkdtempSync(path.join(suiteRoot, 'case-'))
    fs.mkdirSync(path.join(avatarsRoot, AVATAR_ID), { recursive: true })
  })

  it('ensurePalaceWorkspace 创建 P0 文件树和默认文档', async () => {
    const manifest = await ensurePalaceWorkspace(
      avatarsRoot,
      AVATAR_ID,
      new Date('2026-06-17T00:00:00.000Z'),
    )

    assert.equal(manifest.schemaVersion, PALACE_SCHEMA_VERSION)
    assert.equal(manifest.avatarId, AVATAR_ID)
    assert.ok(fs.existsSync(getPalaceManifestPath(avatarsRoot, AVATAR_ID)))
    assert.ok(fs.existsSync(getPalaceProfilePath(avatarsRoot, AVATAR_ID)))
    assert.ok(fs.existsSync(getPalaceCompanyPath(avatarsRoot, AVATAR_ID)))
    assert.ok(fs.existsSync(getPalaceCommitmentsPath(avatarsRoot, AVATAR_ID)))
    assert.ok(fs.existsSync(getPalaceInboxPath(avatarsRoot, AVATAR_ID)))

    for (const dir of PALACE_DIRECTORIES) {
      assert.ok(fs.statSync(getPalaceDirectoryPath(avatarsRoot, AVATAR_ID, dir)).isDirectory())
    }

    assert.match(await readPalaceProfile(avatarsRoot, AVATAR_ID), /# Profile/)
    assert.match(await readPalaceCompany(avatarsRoot, AVATAR_ID), /# Company/)
    assert.deepEqual(await readPalaceCommitments(avatarsRoot, AVATAR_ID), {
      schemaVersion: PALACE_SCHEMA_VERSION,
      commitments: [],
    })
    assert.deepEqual(await readPalaceInbox(avatarsRoot, AVATAR_ID), {
      schemaVersion: PALACE_SCHEMA_VERSION,
      items: [],
    })
  })

  it('ensurePalaceWorkspace 幂等，不覆盖已有 profile/company', async () => {
    await ensurePalaceWorkspace(avatarsRoot, AVATAR_ID)
    await writePalaceProfile(avatarsRoot, AVATAR_ID, '# 自定义 Profile\n')
    await writePalaceCompany(avatarsRoot, AVATAR_ID, '# 自定义 Company\n')

    await ensurePalaceWorkspace(avatarsRoot, AVATAR_ID)

    assert.equal(await readPalaceProfile(avatarsRoot, AVATAR_ID), '# 自定义 Profile\n')
    assert.equal(await readPalaceCompany(avatarsRoot, AVATAR_ID), '# 自定义 Company\n')
  })

  it('writePalaceProfile/Company 超过字符上限拒绝写入（闸口在 core 而非只在 IPC 层）', async () => {
    // WHY: 这两个函数是 @soul/core 公开导出，绕开 electron IPC 的调用方也必须受限，
    // 否则 profile 无界增长（注入侧 600 字截断只救 prompt，救不了磁盘）
    const oversized = 'a'.repeat(PALACE_PROFILE_MAX_CHARS + 1)
    await assert.rejects(() => writePalaceProfile(avatarsRoot, AVATAR_ID, oversized), /上限/)
    await assert.rejects(() => writePalaceCompany(avatarsRoot, AVATAR_ID, oversized), /上限/)
    // 恰好等于上限可写
    await writePalaceProfile(avatarsRoot, AVATAR_ID, 'a'.repeat(PALACE_PROFILE_MAX_CHARS))
  })

  it('manifest 可写可读', async () => {
    const manifest = buildDefaultPalaceManifest(AVATAR_ID, new Date('2026-06-17T01:00:00.000Z'))
    await ensurePalaceWorkspace(avatarsRoot, AVATAR_ID)
    const loaded = await readPalaceManifest(avatarsRoot, AVATAR_ID)
    assert.ok(loaded)
    assert.equal(loaded?.schemaVersion, PALACE_SCHEMA_VERSION)
    assert.equal(manifest.files.inbox, 'inbox/items.json')
  })

  it('PalaceRoom Markdown round-trip 保留路线字段', () => {
    const room: PalaceRoom = {
      ...makeDefaultPalaceRoom('weekly-report', '周报路线', new Date('2026-06-17T00:00:00.000Z')),
      description: '写周报前先整理进展、风险和承诺。',
      triggers: ['写周报', '本周总结'],
      priority: 90,
      requiredFiles: ['profile.md', 'reports/'],
      readOrder: ['profile.md', 'commitments.json', 'reports/'],
      pitfalls: ['不要写成流水账', '不要承诺未确认工期'],
      outputLocation: 'reports/',
      sedimentTargets: ['reports', 'commitments', 'inbox'],
    }

    const parsed = parsePalaceRoomMarkdown(serializePalaceRoom(room), 'fallback')

    assert.equal(parsed.id, 'weekly-report')
    assert.equal(parsed.name, '周报路线')
    assert.equal(parsed.priority, 90)
    assert.deepEqual(parsed.triggers, ['写周报', '本周总结'])
    assert.deepEqual(parsed.requiredFiles, ['profile.md', 'reports/'])
    assert.deepEqual(parsed.sedimentTargets, ['reports', 'commitments', 'inbox'])
    assert.match(parsed.body, /# 周报路线/)
  })

  it('write/read/list/delete PalaceRoom', async () => {
    const low = makeDefaultPalaceRoom('daily-room', '今日驾驶舱')
    const high = { ...makeDefaultPalaceRoom('weekly-room', '周报路线'), priority: 80 }
    await writePalaceRoom(avatarsRoot, AVATAR_ID, low)
    await writePalaceRoom(avatarsRoot, AVATAR_ID, high)

    const loaded = await readPalaceRoom(avatarsRoot, AVATAR_ID, 'weekly-room')
    assert.equal(loaded?.name, '周报路线')

    const rooms = await listPalaceRooms(avatarsRoot, AVATAR_ID)
    assert.deepEqual(rooms.map(r => r.id), ['weekly-room', 'daily-room'])

    await deletePalaceRoom(avatarsRoot, AVATAR_ID, 'weekly-room')
    assert.equal(await readPalaceRoom(avatarsRoot, AVATAR_ID, 'weekly-room'), null)
  })

  it('commitments 与 inbox 文档可写可读', async () => {
    const commitments: PalaceCommitmentDocument = {
      schemaVersion: PALACE_SCHEMA_VERSION,
      commitments: [{
        id: 'cmt-1',
        direction: 'i_owe_them',
        title: '周五前交测算',
        counterparty: '王总',
        promise: '周五前给出储能测算版本',
        status: 'open',
        dueAt: '2026-06-19',
        createdAt: '2026-06-17T00:00:00.000Z',
        updatedAt: '2026-06-17T00:00:00.000Z',
      }],
    }
    const inbox: PalaceInboxDocument = {
      schemaVersion: PALACE_SCHEMA_VERSION,
      items: [{
        id: 'inbox-1',
        kind: 'fact',
        title: '项目进入报价阶段',
        content: 'XX 项目进入报价阶段，后续周报应跟踪。',
        status: 'pending',
        target: 'projects',
        createdAt: '2026-06-17T00:00:00.000Z',
        updatedAt: '2026-06-17T00:00:00.000Z',
      }],
    }

    await writePalaceCommitments(avatarsRoot, AVATAR_ID, commitments)
    await writePalaceInbox(avatarsRoot, AVATAR_ID, inbox)

    assert.deepEqual(await readPalaceCommitments(avatarsRoot, AVATAR_ID), commitments)
    assert.deepEqual(await readPalaceInbox(avatarsRoot, AVATAR_ID), inbox)
  })

  it('拒绝路径穿越 avatarId / roomId', async () => {
    await assert.rejects(
      () => ensurePalaceWorkspace(avatarsRoot, '../bad'),
      /非法分身ID/,
    )
    await assert.rejects(
      () => writePalaceRoom(avatarsRoot, AVATAR_ID, makeDefaultPalaceRoom('../bad', 'bad')),
      /非法路线卡ID/,
    )
  })

  // 导航角标依赖这个计数保持轻量且准确：未启用 palace 的分身必须得 0（而非报错），
  // 已解决（accepted/rejected）的沉淀不得再顶角标。
  it('countPalacePendingInboxItems: 缺文件得 0，只数 pending', async () => {
    assert.equal(await countPalacePendingInboxItems(avatarsRoot, AVATAR_ID), 0)

    const mk = (id: string, status: 'pending' | 'accepted' | 'rejected') => ({
      id,
      kind: 'fact' as const,
      title: `条目 ${id}`,
      content: '内容',
      status,
      createdAt: '2026-06-17T00:00:00.000Z',
      updatedAt: '2026-06-17T00:00:00.000Z',
    })
    await writePalaceInbox(avatarsRoot, AVATAR_ID, {
      schemaVersion: PALACE_SCHEMA_VERSION,
      items: [mk('i1', 'pending'), mk('i2', 'accepted'), mk('i3', 'pending'), mk('i4', 'rejected')],
    })
    assert.equal(await countPalacePendingInboxItems(avatarsRoot, AVATAR_ID), 2)
  })
})
