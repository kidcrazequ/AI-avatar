import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  compactIfNeeded,
  defaultTokenEstimate,
  HookRegistry,
  HookPoint,
  type CompactionMessage,
} from '../agent-runtime'

function mkMsg(role: CompactionMessage['role'], content: string, tokens?: number): CompactionMessage {
  return { role, content, tokens }
}

describe('Phase 9 — compactIfNeeded', () => {
  it('未到阈值时不压缩', async () => {
    const msgs: CompactionMessage[] = [mkMsg('system', 's', 10), mkMsg('user', 'u', 10)]
    const r = await compactIfNeeded(msgs, {
      triggerTokens: 1000,
      targetTokens: 800,
      retainHead: 1,
      retainTail: 1,
      summarize: async () => 'summary',
    })
    assert.equal(r.compacted, false)
    assert.equal(r.messages.length, 2)
  })

  it('超阈值时压缩中间段为单条摘要', async () => {
    const msgs: CompactionMessage[] = [
      mkMsg('system', 's', 50),
      mkMsg('user', 'u1', 200),
      mkMsg('assistant', 'a1', 200),
      mkMsg('user', 'u2', 200),
      mkMsg('assistant', 'a2', 200),
      mkMsg('user', 'u3', 100),
    ]
    let summarizeCalled = 0
    const r = await compactIfNeeded(msgs, {
      triggerTokens: 500,
      targetTokens: 300,
      retainHead: 1,
      retainTail: 2,
      summarize: async () => {
        summarizeCalled++
        return '中间 3 条已摘要'
      },
    })
    assert.equal(r.compacted, true)
    assert.equal(summarizeCalled, 1)
    assert.equal(r.messages.length, 4) // head(1) + summary(1) + tail(2)
    assert.equal(r.summarizedCount, 3)
    assert.ok(r.tokensSaved > 0)
    assert.match(r.messages[1].content, /中间 3 条已摘要/)
    assert.match(r.messages[1].content, /已压缩历史摘要/)
  })

  it('touch ON_COMPACTION hook', async () => {
    const msgs: CompactionMessage[] = [
      mkMsg('system', 's', 50),
      mkMsg('user', 'u1', 500),
      mkMsg('assistant', 'a1', 500),
      mkMsg('user', 'u2', 50),
    ]
    const reg = new HookRegistry()
    let fired: { original?: number; compacted?: number; saved?: number } = {}
    reg.register(HookPoint.ON_COMPACTION, async (p) => {
      const payload = p as {
        originalMessageCount: number
        compactedMessageCount: number
        tokensSaved?: number
      }
      fired = {
        original: payload.originalMessageCount,
        compacted: payload.compactedMessageCount,
        saved: payload.tokensSaved,
      }
    })

    await compactIfNeeded(msgs, {
      triggerTokens: 500,
      targetTokens: 300,
      retainHead: 1,
      retainTail: 1,
      summarize: async () => 's',
      hooks: reg,
    })
    assert.equal(fired.original, 4)
    assert.equal(fired.compacted, 3)
  })

  it('head + tail 已覆盖全部消息时不压缩', async () => {
    const msgs: CompactionMessage[] = [
      mkMsg('system', 's', 1000),
      mkMsg('user', 'u', 1000),
    ]
    const r = await compactIfNeeded(msgs, {
      triggerTokens: 100,
      targetTokens: 50,
      retainHead: 1,
      retainTail: 1,
      summarize: async () => 's',
    })
    assert.equal(r.compacted, false)
  })

  it('defaultTokenEstimate：未提供 tokens 时按字符 /4', () => {
    assert.equal(defaultTokenEstimate({ role: 'user', content: 'a'.repeat(40) }), 10)
    assert.equal(defaultTokenEstimate({ role: 'user', content: 'x', tokens: 99 }), 99)
  })
})
