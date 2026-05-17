/**
 * conversation-event-reader 单测（v17 引入，2026-05-17）。
 *
 * 覆盖：
 *   1. 文件不存在 → events=[], parseErrors=0（不抛、不 warn）
 *   2. 旧 message 行（无 type）自动归一化为 type='message'
 *   3. 已有 type 的新事件按 type 原样保留
 *   4. 损坏 JSON 行被跳过，parseErrors 累计正确
 *   5. 未知 type 字段被拒，进 parseErrors
 *   6. conversationId 路径穿越触发 assertSafeSegment 抛错（防御）
 *
 * @author zhi.qu
 * @date 2026-05-17
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'

import {
  readConversationEvents,
  type EventReaderLogger,
} from './conversation-event-reader'

class FakeLogger implements EventReaderLogger {
  warnCalls: Array<{ msg: string; err?: unknown }> = []
  warn(msg: string, err?: unknown): void {
    this.warnCalls.push({ msg, err })
  }
}

const tmpDirs: string[] = []
function makeUserData(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-reader-test-'))
  tmpDirs.push(dir)
  return dir
}
function writeJsonl(userData: string, conversationId: string, lines: string[]): void {
  const dir = path.join(userData, 'conversations')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `${conversationId}.jsonl`), lines.join('\n') + '\n', 'utf-8')
}

after(() => {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* noop */ }
  }
})

describe('conversation-event-reader', () => {
  test('文件不存在：返回空结果，不 warn', async () => {
    const userData = makeUserData()
    const logger = new FakeLogger()
    const r = await readConversationEvents(userData, 'no-such-conv', logger)
    assert.deepEqual(r, { events: [], parseErrors: 0 })
    assert.equal(logger.warnCalls.length, 0, 'ENOENT 不应 warn')
  })

  test('旧 message 行（无 type）→ 归一化为 type=message', async () => {
    const userData = makeUserData()
    writeJsonl(userData, 'legacy', [
      JSON.stringify({
        id: 'm-1', conversationId: 'legacy', role: 'user', content: '你好',
        toolCallId: null, imageUrls: null, ts: 1,
      }),
      JSON.stringify({
        id: 'm-2', conversationId: 'legacy', role: 'assistant', content: '回声',
        toolCallId: null, imageUrls: null, ts: 2,
      }),
    ])
    const logger = new FakeLogger()
    const r = await readConversationEvents(userData, 'legacy', logger)
    assert.equal(r.parseErrors, 0)
    assert.equal(r.events.length, 2)
    assert.equal(r.events[0].type, 'message')
    if (r.events[0].type === 'message') {
      assert.equal(r.events[0].id, 'm-1')
      assert.equal(r.events[0].role, 'user')
      assert.equal(r.events[0].content, '你好')
    }
  })

  test('混合：typed events 与 legacy message 同文件，type 字段正确', async () => {
    const userData = makeUserData()
    writeJsonl(userData, 'mix', [
      JSON.stringify({ type: 'conversation_started', conversationId: 'mix', avatarId: 'a', projectId: 'default', title: 't', ts: 0 }),
      JSON.stringify({ id: 'm-1', conversationId: 'mix', role: 'user', content: 'hi', toolCallId: null, imageUrls: null, ts: 1 }),
      JSON.stringify({ type: 'memory_update', conversationId: 'mix', avatarId: 'a', updateCount: 1, summaryPreview: 'x', totalByteSize: 10, consolidated: false, ts: 2 }),
      JSON.stringify({ type: 'model_switch', conversationId: 'mix', fromModel: null, toModel: 'opus', ts: 3 }),
      JSON.stringify({ type: 'mode_switch', conversationId: 'mix', fromMode: 'agent', toMode: 'plan', ts: 4 }),
      JSON.stringify({ type: 'sub_agent_task', taskId: 'sub-1', conversationId: 'mix', status: 'done', parentAvatarId: 'a', targetAvatar: null, taskPreview: 't', error: null, agentType: null, ts: 5 }),
    ])
    const r = await readConversationEvents(userData, 'mix')
    assert.equal(r.parseErrors, 0)
    const types = r.events.map((e) => e.type)
    assert.deepEqual(types, [
      'conversation_started', 'message', 'memory_update',
      'model_switch', 'mode_switch', 'sub_agent_task',
    ])
  })

  test('损坏 JSON 行被跳过，parseErrors 累计', async () => {
    const userData = makeUserData()
    writeJsonl(userData, 'broken', [
      JSON.stringify({ type: 'conversation_started', conversationId: 'broken', avatarId: 'a', projectId: 'default', title: 't', ts: 0 }),
      '{this is not json',                                              // 完全坏
      JSON.stringify({ type: 'model_switch', conversationId: 'broken', fromModel: null, toModel: 'x', ts: 1 }),
      '"only a string"',                                                // 合法 JSON 但不是对象
    ])
    const logger = new FakeLogger()
    const r = await readConversationEvents(userData, 'broken', logger)
    assert.equal(r.events.length, 2, '两条合法事件应保留')
    assert.equal(r.parseErrors, 2, '两条损坏行计入')
    assert.ok(logger.warnCalls.length >= 1, '应至少 warn 一次汇总信息')
  })

  test('未知 type 字段被拒，进 parseErrors', async () => {
    const userData = makeUserData()
    writeJsonl(userData, 'unknown', [
      JSON.stringify({ type: 'message', id: 'm-1', conversationId: 'unknown', role: 'user', content: 'hi', toolCallId: null, imageUrls: null, ts: 1 }),
      JSON.stringify({ type: 'future_event_type', conversationId: 'unknown', ts: 2 }),
    ])
    const r = await readConversationEvents(userData, 'unknown')
    assert.equal(r.events.length, 1)
    assert.equal(r.parseErrors, 1, '未来未知 type 暂时计为错误，提示开发者升级 KNOWN_TYPED_EVENTS')
  })

  test('conversationId 路径穿越触发 assertSafeSegment 抛错', async () => {
    const userData = makeUserData()
    await assert.rejects(() => readConversationEvents(userData, '../etc/passwd'))
  })
})
