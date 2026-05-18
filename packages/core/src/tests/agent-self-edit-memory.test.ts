/**
 * Agent self-edit memory 单测（v18 Letta-style）
 *
 * 覆盖：
 *   - pinConversationEpisode：基础 pin / 幂等 / 不存在 / 数量上限 / reason 截断
 *   - appendConversationEpisodeNote：追加 / 数量上限 / 空内容 / 过长 / 不存在
 *   - computeSalience：pinned 时跳过 forgotten 归零 / pinned 总分排在非 pinned 之前
 *   - applyEpisodeAlgorithmicForgetting：pinned 跳过遗忘
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  writeConversationEpisode,
  readConversationEpisode,
  pinConversationEpisode,
  appendConversationEpisodeNote,
  MAX_PINNED_EPISODES_PER_AVATAR,
  MAX_NOTES_PER_EPISODE,
  MAX_NOTE_LENGTH,
} from '../memory/episode-store'
import type { ConversationEpisode } from '../memory/episode-types'
import { computeSalience, PINNED_SALIENCE_BONUS } from '../memory/salience'
import { applyEpisodeAlgorithmicForgetting } from '../memory/episode-forgetter'

function withTempDir(body: (dir: string) => Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'self-edit-test-'))
  return body(dir).finally(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })
}

function makeEpisode(overrides: Partial<ConversationEpisode> = {}): ConversationEpisode {
  return {
    schemaVersion: 1,
    conversationId: 'conv-1',
    avatarId: 'a1',
    title: 'test',
    theme: 'test',
    summary: 'test summary',
    keyQuotes: [],
    themes: [],
    valence: 0,
    emotionType: 'joy',
    importance: 5,
    consolidationStatus: 'remembered',
    consolidationNote: '',
    conversationStartedAt: Date.now() - 1000,
    conversationLastMessageAt: Date.now(),
    extractedAt: Date.now(),
    messageCount: 10,
    ...overrides,
  }
}

describe('pinConversationEpisode', () => {
  it('基础 pin 成功并写盘 + 元数据', async () => {
    await withTempDir(async (dir) => {
      const ep = makeEpisode()
      await writeConversationEpisode(dir, ep)
      const res = await pinConversationEpisode(dir, 'a1', 'conv-1', '这是关键合同决策')
      assert.ok(res.ok)
      assert.equal(res.alreadyPinned, false)
      assert.equal(res.totalPinned, 1)
      const read = await readConversationEpisode(dir, 'a1', 'conv-1')
      assert.ok(read)
      assert.equal(read.pinned, true)
      assert.equal(read.pinReason, '这是关键合同决策')
      assert.ok(typeof read.pinnedAt === 'number' && read.pinnedAt > 0)
    })
  })

  it('重复 pin 幂等返回 alreadyPinned + 不刷新 pinnedAt', async () => {
    await withTempDir(async (dir) => {
      await writeConversationEpisode(dir, makeEpisode())
      const first = await pinConversationEpisode(dir, 'a1', 'conv-1', 'first')
      assert.ok(first.ok && !first.alreadyPinned)
      const beforePinnedAt = (await readConversationEpisode(dir, 'a1', 'conv-1'))!.pinnedAt
      const second = await pinConversationEpisode(dir, 'a1', 'conv-1', 'second')
      assert.ok(second.ok)
      assert.equal(second.alreadyPinned, true)
      const after = await readConversationEpisode(dir, 'a1', 'conv-1')
      assert.equal(after!.pinnedAt, beforePinnedAt) // 没刷新
      assert.equal(after!.pinReason, 'first') // 没覆盖
    })
  })

  it('不存在的 episode 返回 ok: false', async () => {
    await withTempDir(async (dir) => {
      const res = await pinConversationEpisode(dir, 'a1', 'missing', 'reason')
      assert.equal(res.ok, false)
      if (!res.ok) assert.match(res.error, /不存在/)
    })
  })

  it('达到数量上限后拒绝 pin', async () => {
    await withTempDir(async (dir) => {
      // 写 MAX_PINNED_EPISODES_PER_AVATAR 条 pinned + 1 条未 pinned
      for (let i = 0; i < MAX_PINNED_EPISODES_PER_AVATAR; i++) {
        await writeConversationEpisode(dir, makeEpisode({
          conversationId: `pinned-${i}`,
          pinned: true,
          pinReason: 'preset',
          pinnedAt: Date.now(),
        }))
      }
      await writeConversationEpisode(dir, makeEpisode({ conversationId: 'unpinned' }))

      const res = await pinConversationEpisode(dir, 'a1', 'unpinned', 'should fail')
      assert.equal(res.ok, false)
      if (!res.ok) assert.match(res.error, /pin 上限/)
    })
  })

  it('reason 超长截断到 300 字符', async () => {
    await withTempDir(async (dir) => {
      await writeConversationEpisode(dir, makeEpisode())
      const longReason = 'X'.repeat(1000)
      const res = await pinConversationEpisode(dir, 'a1', 'conv-1', longReason)
      assert.ok(res.ok)
      const read = await readConversationEpisode(dir, 'a1', 'conv-1')
      assert.equal(read!.pinReason!.length, 300)
    })
  })
})

describe('appendConversationEpisodeNote', () => {
  it('追加成功并写盘', async () => {
    await withTempDir(async (dir) => {
      await writeConversationEpisode(dir, makeEpisode())
      const res = await appendConversationEpisodeNote(dir, 'a1', 'conv-1', '后来用户补充：合同金额是 50 万')
      assert.ok(res.ok)
      assert.equal(res.totalNotes, 1)
      const read = await readConversationEpisode(dir, 'a1', 'conv-1')
      assert.equal(read!.notes!.length, 1)
      assert.equal(read!.notes![0].text, '后来用户补充：合同金额是 50 万')
      assert.ok(typeof read!.notes![0].ts === 'number')
    })
  })

  it('多次追加按时间序累加', async () => {
    await withTempDir(async (dir) => {
      await writeConversationEpisode(dir, makeEpisode())
      await appendConversationEpisodeNote(dir, 'a1', 'conv-1', 'note 1')
      await appendConversationEpisodeNote(dir, 'a1', 'conv-1', 'note 2')
      const res = await appendConversationEpisodeNote(dir, 'a1', 'conv-1', 'note 3')
      assert.ok(res.ok)
      assert.equal(res.totalNotes, 3)
      const read = await readConversationEpisode(dir, 'a1', 'conv-1')
      assert.deepEqual(read!.notes!.map(n => n.text), ['note 1', 'note 2', 'note 3'])
    })
  })

  it('达到上限后拒绝追加', async () => {
    await withTempDir(async (dir) => {
      await writeConversationEpisode(dir, makeEpisode())
      for (let i = 0; i < MAX_NOTES_PER_EPISODE; i++) {
        const r = await appendConversationEpisodeNote(dir, 'a1', 'conv-1', `note ${i}`)
        assert.ok(r.ok)
      }
      const overflow = await appendConversationEpisodeNote(dir, 'a1', 'conv-1', 'one too many')
      assert.equal(overflow.ok, false)
      if (!overflow.ok) assert.match(overflow.error, /上限/)
    })
  })

  it('空白笔记拒绝', async () => {
    await withTempDir(async (dir) => {
      await writeConversationEpisode(dir, makeEpisode())
      const res = await appendConversationEpisodeNote(dir, 'a1', 'conv-1', '   \n\t  ')
      assert.equal(res.ok, false)
    })
  })

  it('过长笔记拒绝（≥ MAX_NOTE_LENGTH 字符 + 1）', async () => {
    await withTempDir(async (dir) => {
      await writeConversationEpisode(dir, makeEpisode())
      const res = await appendConversationEpisodeNote(dir, 'a1', 'conv-1', 'X'.repeat(MAX_NOTE_LENGTH + 1))
      assert.equal(res.ok, false)
    })
  })

  it('不存在的 episode 返回 ok: false', async () => {
    await withTempDir(async (dir) => {
      const res = await appendConversationEpisodeNote(dir, 'a1', 'missing', 'whatever')
      assert.equal(res.ok, false)
    })
  })
})

describe('computeSalience / pinned', () => {
  it('pinned + forgotten 仍参与排序（不归零）', () => {
    const score = computeSalience({
      importance: 5,
      emotionMagnitude: 3,
      recencyFactor: 0,
      status: 'forgotten',
      pinned: true,
    })
    assert.ok(score >= PINNED_SALIENCE_BONUS, `pinned forgotten 应至少 ${PINNED_SALIENCE_BONUS}，实际 ${score}`)
  })

  it('非 pinned forgotten 仍归零', () => {
    const score = computeSalience({
      importance: 10,
      emotionMagnitude: 10,
      recencyFactor: 1,
      status: 'forgotten',
    })
    assert.equal(score, 0)
  })

  it('pinned 之间按 importance 排序，且都高于任何非 pinned', () => {
    const lowPinned = computeSalience({
      importance: 1, emotionMagnitude: 0, recencyFactor: 0, status: 'blurred', pinned: true,
    })
    const highNonPinned = computeSalience({
      importance: 10, emotionMagnitude: 10, recencyFactor: 1, status: 'remembered',
    })
    assert.ok(lowPinned > highNonPinned, `lowPinned (${lowPinned}) > highNonPinned (${highNonPinned})`)
  })

  it('pinned 跳过 blurredPenalty', () => {
    const pinnedBlurred = computeSalience({
      importance: 10, emotionMagnitude: 0, recencyFactor: 1, status: 'blurred', pinned: true,
    })
    const pinnedRemembered = computeSalience({
      importance: 10, emotionMagnitude: 0, recencyFactor: 1, status: 'remembered', pinned: true,
    })
    assert.equal(pinnedBlurred, pinnedRemembered) // pinned 时 status 不影响
  })

  it('pinned 强制 recency 为 1.0（古老 pinned 跟新鲜 pinned 同 importance 同分）', () => {
    const oldPinned = computeSalience({
      importance: 5, emotionMagnitude: 0, recencyFactor: 0.01, status: 'remembered', pinned: true,
    })
    const newPinned = computeSalience({
      importance: 5, emotionMagnitude: 0, recencyFactor: 1, status: 'remembered', pinned: true,
    })
    assert.equal(oldPinned, newPinned)
  })
})

describe('applyEpisodeAlgorithmicForgetting / pinned', () => {
  it('pinned episode 不被衰减为 blurred / forgotten', () => {
    const now = Date.now()
    const veryOld = now - 365 * 86400 * 1000 // 一年前
    const episodes: ConversationEpisode[] = [
      makeEpisode({
        conversationId: 'pinned-old',
        conversationLastMessageAt: veryOld,
        consolidationStatus: 'remembered',
        importance: 3,
        pinned: true,
        pinReason: 'manual',
        pinnedAt: now,
      }),
      makeEpisode({
        conversationId: 'unpinned-old',
        conversationLastMessageAt: veryOld,
        consolidationStatus: 'remembered',
        importance: 3,
      }),
    ]
    const { episodes: updated, changedIds } = applyEpisodeAlgorithmicForgetting(episodes, now)
    const pinnedRes = updated.find(e => e.conversationId === 'pinned-old')!
    const unpinnedRes = updated.find(e => e.conversationId === 'unpinned-old')!
    assert.equal(pinnedRes.consolidationStatus, 'remembered') // pinned 保留
    assert.notEqual(unpinnedRes.consolidationStatus, 'remembered') // unpinned 一年后应已衰减
    assert.ok(!changedIds.includes('pinned-old'))
  })
})
