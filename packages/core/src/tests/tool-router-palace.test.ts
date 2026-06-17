/**
 * ToolRouter Palace P1 工具测试。
 */

import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  PALACE_SCHEMA_VERSION,
  ToolRouter,
  ensurePalaceWorkspace,
  makeDefaultPalaceRoom,
  writePalaceCommitments,
  writePalaceCompany,
  writePalaceInbox,
  writePalaceProfile,
  writePalaceRoom,
} from '../index'

const AVATAR_ID = 'test-avatar'

describe('tool-router palace tools', () => {
  let suiteRoot = ''
  let avatarsRoot = ''

  before(() => {
    suiteRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-tool-router-palace-test-'))
  })

  after(() => {
    fs.rmSync(suiteRoot, { recursive: true, force: true })
  })

  beforeEach(async () => {
    avatarsRoot = fs.mkdtempSync(path.join(suiteRoot, 'case-'))
    fs.mkdirSync(path.join(avatarsRoot, AVATAR_ID), { recursive: true })
    await ensurePalaceWorkspace(avatarsRoot, AVATAR_ID)
    await writePalaceProfile(avatarsRoot, AVATAR_ID, '# Profile\n\n当前负责储能项目周报。')
    await writePalaceCompany(avatarsRoot, AVATAR_ID, '# Company\n\n王总只看数字和风险。')
    await writePalaceCommitments(avatarsRoot, AVATAR_ID, {
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
    })
    await writePalaceInbox(avatarsRoot, AVATAR_ID, {
      schemaVersion: PALACE_SCHEMA_VERSION,
      items: [{
        id: 'inbox-1',
        kind: 'fact',
        title: '项目进入报价阶段',
        content: 'XX 项目进入报价阶段。',
        status: 'pending',
        target: 'projects',
        createdAt: '2026-06-17T00:00:00.000Z',
        updatedAt: '2026-06-17T00:00:00.000Z',
      }],
    })
    await writePalaceRoom(avatarsRoot, AVATAR_ID, {
      ...makeDefaultPalaceRoom('weekly-report', '周报路线'),
      description: '写周报前先整理进展、风险和承诺。',
      triggers: ['写周报', '本周总结'],
      priority: 90,
      requiredFiles: ['profile.md', 'company.md', 'commitments.json', 'reports/'],
      readOrder: ['profile.md', 'commitments.json', 'reports/'],
      pitfalls: ['不要写成流水账', '不要承诺未确认工期'],
      outputLocation: 'reports/',
      sedimentTargets: ['reports', 'commitments', 'inbox'],
    })
  })

  it('match_palace_rooms 返回路线卡匹配 JSON', async () => {
    const router = new ToolRouter(avatarsRoot)
    const result = await router.execute(AVATAR_ID, {
      name: 'match_palace_rooms',
      arguments: { task: '帮我写本周周报' },
    })

    assert.equal(result.error, undefined)
    const parsed = JSON.parse(result.content) as { matches: Array<{ id: string; score: number }> }
    assert.equal(parsed.matches[0]?.id, 'weekly-report')
    assert.ok(parsed.matches[0]!.score > 0)
  })

  it('build_palace_context_card 生成任务前上下文包', async () => {
    const router = new ToolRouter(avatarsRoot)
    const result = await router.execute(AVATAR_ID, {
      name: 'build_palace_context_card',
      arguments: { task: '帮我写本周周报' },
    })

    assert.equal(result.error, undefined)
    assert.match(result.content, /Palace 任务前上下文包/)
    assert.match(result.content, /周报路线/)
    assert.match(result.content, /周五前交测算/)
    assert.match(result.content, /项目进入报价阶段/)
    assert.match(result.content, /先把这张上下文包/)
  })

  it('Palace 承诺工具支持新增、查看和更新', async () => {
    const router = new ToolRouter(avatarsRoot)
    const added = await router.execute(AVATAR_ID, {
      name: 'add_palace_commitment',
      arguments: {
        title: '给客户 A 回封邮件',
        promise: '今天下班前回复客户 A 的报价口径',
        counterparty: '客户 A',
        direction: 'i_owe_them',
        due_at: '2099-01-02',
        tags: ['邮件', '报价'],
      },
    })

    assert.equal(added.error, undefined)
    const addedJson = JSON.parse(added.content) as { commitment: { id: string; status: string; tags: string[] } }
    assert.equal(addedJson.commitment.status, 'open')
    assert.deepEqual(addedJson.commitment.tags, ['邮件', '报价'])

    const listed = await router.execute(AVATAR_ID, {
      name: 'list_palace_commitments',
      arguments: { query: '客户 A' },
    })
    assert.equal(listed.error, undefined)
    const listedJson = JSON.parse(listed.content) as { count: number; commitments: Array<{ id: string }> }
    assert.equal(listedJson.count, 1)
    assert.equal(listedJson.commitments[0]?.id, addedJson.commitment.id)

    const updated = await router.execute(AVATAR_ID, {
      name: 'update_palace_commitment',
      arguments: {
        id: addedJson.commitment.id,
        status: 'done',
        append_note: '已发送邮件。',
      },
    })
    assert.equal(updated.error, undefined)
    const updatedJson = JSON.parse(updated.content) as { commitment: { status: string; notes: string[] } }
    assert.equal(updatedJson.commitment.status, 'done')
    assert.deepEqual(updatedJson.commitment.notes, ['已发送邮件。'])

    const hiddenByDefault = await router.execute(AVATAR_ID, {
      name: 'list_palace_commitments',
      arguments: { query: '客户 A' },
    })
    const hiddenJson = JSON.parse(hiddenByDefault.content) as { count: number }
    assert.equal(hiddenJson.count, 0)

    const closed = await router.execute(AVATAR_ID, {
      name: 'list_palace_commitments',
      arguments: { query: '客户 A', include_closed: true },
    })
    const closedJson = JSON.parse(closed.content) as { count: number; commitments: Array<{ status: string }> }
    assert.equal(closedJson.count, 1)
    assert.equal(closedJson.commitments[0]?.status, 'done')
  })

  it('Palace inbox 工具支持新增、查看和确认沉淀项', async () => {
    const router = new ToolRouter(avatarsRoot)
    const added = await router.execute(AVATAR_ID, {
      name: 'add_palace_inbox_item',
      arguments: {
        title: '王总周报口径',
        content: '写给王总的周报需要先列核心数字、风险和下一步。',
        kind: 'writing',
        target: 'reports',
        source: '本次周报任务',
        confidence: 0.9,
        tags: ['周报', '王总'],
      },
    })

    assert.equal(added.error, undefined)
    const addedJson = JSON.parse(added.content) as {
      item: { id: string; status: string; target: string; tags: string[] }
    }
    assert.equal(addedJson.item.status, 'pending')
    assert.equal(addedJson.item.target, 'reports')
    assert.deepEqual(addedJson.item.tags, ['周报', '王总'])

    const listed = await router.execute(AVATAR_ID, {
      name: 'list_palace_inbox',
      arguments: { query: '王总' },
    })
    assert.equal(listed.error, undefined)
    const listedJson = JSON.parse(listed.content) as { count: number; items: Array<{ id: string }> }
    assert.equal(listedJson.count, 1)
    assert.equal(listedJson.items[0]?.id, addedJson.item.id)

    const updated = await router.execute(AVATAR_ID, {
      name: 'update_palace_inbox_item',
      arguments: {
        id: addedJson.item.id,
        status: 'accepted',
        target: 'wiki',
      },
    })
    assert.equal(updated.error, undefined)
    const updatedJson = JSON.parse(updated.content) as { item: { status: string; target: string } }
    assert.equal(updatedJson.item.status, 'accepted')
    assert.equal(updatedJson.item.target, 'wiki')

    const hiddenByDefault = await router.execute(AVATAR_ID, {
      name: 'list_palace_inbox',
      arguments: { query: '王总' },
    })
    const hiddenJson = JSON.parse(hiddenByDefault.content) as { count: number }
    assert.equal(hiddenJson.count, 0)

    const resolved = await router.execute(AVATAR_ID, {
      name: 'list_palace_inbox',
      arguments: { query: '王总', include_resolved: true },
    })
    const resolvedJson = JSON.parse(resolved.content) as { count: number; items: Array<{ status: string }> }
    assert.equal(resolvedJson.count, 1)
    assert.equal(resolvedJson.items[0]?.status, 'accepted')
  })

  it('write_palace_room 创建路线卡、被 match 命中、再写同 id 为 updated', async () => {
    const router = new ToolRouter(avatarsRoot)
    const written = await router.execute(AVATAR_ID, {
      name: 'write_palace_room',
      arguments: {
        id: 'conflict-room',
        name: '冲突沟通',
        triggers: ['冲突', '扯皮', '职责边界'],
        conditional_reads: ['涉及职责边界 → 用具体事项做锚点'],
        tone_guidance: '中立、对事不对人',
        pitfalls: ['不要假设对方恶意'],
        sediment_targets: ['decisions', 'inbox'],
        priority: 60,
      },
    })
    assert.equal(written.error, undefined)
    const writtenJson = JSON.parse(written.content) as { ok: boolean; action: string }
    assert.equal(writtenJson.ok, true)
    assert.equal(writtenJson.action, 'created')

    const matched = await router.execute(AVATAR_ID, {
      name: 'match_palace_rooms',
      arguments: { task: '跟隔壁组职责边界扯皮怎么谈' },
    })
    const matchedJson = JSON.parse(matched.content) as { matches: Array<{ id: string }> }
    assert.ok(matchedJson.matches.some(m => m.id === 'conflict-room'))

    const again = await router.execute(AVATAR_ID, {
      name: 'write_palace_room',
      arguments: { id: 'conflict-room', name: '冲突沟通 v2' },
    })
    const againJson = JSON.parse(again.content) as { action: string }
    assert.equal(againJson.action, 'updated')
  })

  it('write_palace_room 缺 id 时报错', async () => {
    const router = new ToolRouter(avatarsRoot)
    const r = await router.execute(AVATAR_ID, { name: 'write_palace_room', arguments: { name: '只有名字' } })
    assert.match(r.error ?? '', /id/)
  })

  it('build_palace_context_card 含对方画像、建议口径与条件读', async () => {
    await writePalaceRoom(avatarsRoot, AVATAR_ID, {
      ...makeDefaultPalaceRoom('mail-room', '给老板写邮件'),
      triggers: ['给王总', '写邮件'],
      priority: 95,
      conditionalReads: ['涉及报价 → 看最新 reports/'],
      toneGuidance: '结论先行，只给数字和风险',
      requiredFiles: ['people/'],
    })
    fs.writeFileSync(
      path.join(avatarsRoot, AVATAR_ID, 'palace', 'people', '王总.md'),
      '# 王总\n\n只看数字和风险，不爱听过程。',
    )

    const router = new ToolRouter(avatarsRoot)
    const result = await router.execute(AVATAR_ID, {
      name: 'build_palace_context_card',
      arguments: { task: '帮我给王总写封邮件' },
    })

    assert.equal(result.error, undefined)
    assert.match(result.content, /## 对方画像/)
    assert.match(result.content, /王总/)
    assert.match(result.content, /## 建议口径/)
    assert.match(result.content, /结论先行/)
    assert.match(result.content, /## 条件读/)
  })
})
