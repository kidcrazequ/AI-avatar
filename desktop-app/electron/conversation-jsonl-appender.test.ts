/**
 * ConversationJsonlAppender 单测
 *
 * 验证点：
 *   1. 正常 append 后文件存在，内容为合法 JSONL，回读 deepEqual 原 record
 *   2. conversations/ 目录不存在时被自动创建
 *   3. mkdir/appendFile 失败时仅触发 logger.warn，不抛
 *   4. conversationId 路径穿越/含分隔符/空字符串触发 assertSafeSegment 抛错
 *   5. 多条消息按时间序追加，时间戳严格递增
 *   6. 离线重建：3 条 record 写入 → 按行 split + JSON.parse → deepEqual 原数组
 *
 * 设计：
 *   - 使用 node:test + node:assert/strict（项目测试栈）
 *   - 临时目录 mkdtempSync(os.tmpdir()/'soul-jsonl-test-')，after 钩子统一兜底清理
 *   - 单例污染：beforeEach 调用 ConversationJsonlAppender.__resetForTesting()
 *   - FakeLogger 实现 JsonlAppenderLogger 接口，断言 warn 调用次数
 *
 * @author zhi.qu
 * @date 2026-05-09
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test, describe, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'

import {
  ConversationJsonlAppender,
  type ConversationJsonlRecord,
  type JsonlAppenderLogger,
  type MemoryUpdateJsonlEvent,
  type ModelSwitchJsonlEvent,
  type ModeSwitchJsonlEvent,
  type ConversationStartedJsonlEvent,
} from './conversation-jsonl-appender'

/**
 * 最小可用的 fake logger，仅记录 warn 调用便于断言。
 */
class FakeLogger implements JsonlAppenderLogger {
  warnCalls: Array<{ msg: string; err?: unknown }> = []
  warn(msg: string, err?: unknown): void {
    this.warnCalls.push({ msg, err })
  }
}

function makeRecord(overrides: Partial<ConversationJsonlRecord> = {}): ConversationJsonlRecord {
  return {
    id: overrides.id ?? `m_${Math.random().toString(36).slice(2, 10)}`,
    conversationId: overrides.conversationId ?? 'conv-1',
    role: overrides.role ?? 'user',
    content: overrides.content ?? 'hello',
    toolCallId: overrides.toolCallId ?? null,
    imageUrls: overrides.imageUrls ?? null,
    ts: overrides.ts ?? Date.now(),
  }
}

describe('ConversationJsonlAppender', () => {
  const tmpDirs: string[] = []

  function makeTmp(prefix = 'soul-jsonl-test-'): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
    tmpDirs.push(dir)
    return dir
  }

  before(() => {
    ConversationJsonlAppender.__resetForTesting()
  })

  beforeEach(() => {
    ConversationJsonlAppender.__resetForTesting()
  })

  after(() => {
    for (const d of tmpDirs) {
      try {
        fs.rmSync(d, { recursive: true, force: true })
      } catch {
        // 测试结束兜底清理，忽略已被清理或权限错误
      }
    }
  })

  test('正常 append：写入合法 JSONL 行且能回读', async () => {
    const root = makeTmp()
    const logger = new FakeLogger()
    const appender = ConversationJsonlAppender.getInstance(root, logger)
    const rec = makeRecord({
      id: 'm-roundtrip-1',
      conversationId: 'conv-A',
      role: 'assistant',
      content: '回声内容',
      ts: 1700000000000,
    })

    await appender.append('conv-A', rec)

    const file = path.join(root, 'conversations', 'conv-A.jsonl')
    assert.equal(fs.existsSync(file), true, '目标文件应被创建')
    const text = fs.readFileSync(file, 'utf-8')
    assert.equal(text.endsWith('\n'), true, '每行应以 \\n 结尾')
    const parsed = JSON.parse(text.trimEnd()) as ConversationJsonlRecord
    assert.deepEqual(parsed, rec, '回读 record 与原始一致')
    assert.equal(logger.warnCalls.length, 0, '正常路径不应触发 warn')
  })

  test('目录不存在时自动创建 conversations/', async () => {
    const root = makeTmp()
    // 给 root 加一层 nested 让 conversations/ 一定不存在
    const nested = path.join(root, 'profile-x')
    fs.mkdirSync(nested, { recursive: true })
    const logger = new FakeLogger()
    const appender = ConversationJsonlAppender.getInstance(nested, logger)
    const rec = makeRecord({ id: 'm-mkdir', conversationId: 'conv-mk' })

    const dir = path.join(nested, 'conversations')
    assert.equal(fs.existsSync(dir), false, '前置：conversations 目录不存在')

    await appender.append('conv-mk', rec)

    const file = path.join(dir, 'conv-mk.jsonl')
    assert.equal(fs.existsSync(dir), true, 'conversations 目录应被自动创建')
    assert.equal(fs.existsSync(file), true, 'jsonl 文件应被创建')
    assert.equal(logger.warnCalls.length, 0)
  })

  test('mkdir 失败时仅 warn，不抛', async () => {
    const root = makeTmp()
    // 把 userDataDir 指向一个普通文件：mkdir <file>/conversations 会因为父级是文件而失败（ENOTDIR）
    const filePath = path.join(root, 'is-a-file.txt')
    fs.writeFileSync(filePath, 'not a dir', 'utf-8')

    const logger = new FakeLogger()
    const appender = ConversationJsonlAppender.getInstance(filePath, logger)
    const rec = makeRecord({ id: 'm-fail', conversationId: 'conv-fail' })

    let thrown: unknown = null
    try {
      await appender.append('conv-fail', rec)
    } catch (e) {
      thrown = e
    }

    assert.equal(thrown, null, 'append 不应向上抛异常')
    assert.ok(logger.warnCalls.length >= 1, 'warn 至少被调用 1 次')
    assert.match(logger.warnCalls[0].msg, /append 失败/, 'warn 消息含 "append 失败"')
    assert.notEqual(logger.warnCalls[0].err, undefined, '应携带原始 error')
  })

  test('conversationId 不安全段被 assertSafeSegment 拦截', async () => {
    const root = makeTmp()
    const logger = new FakeLogger()
    const appender = ConversationJsonlAppender.getInstance(root, logger)
    const rec = makeRecord({ id: 'm-bad' })

    // path-security 错误消息格式：「非法conversationId，不能包含路径分隔符或 ..: ../escape」 / 「conversationId不能为空」
    await assert.rejects(
      () => appender.append('../escape', rec),
      /conversationId/,
      '路径穿越段必须抛出',
    )
    await assert.rejects(
      () => appender.append('a/b', rec),
      /conversationId/,
      '含 / 必须抛出',
    )
    await assert.rejects(
      () => appender.append('a\\b', rec),
      /conversationId/,
      '含 \\ 必须抛出',
    )
    await assert.rejects(
      () => appender.append('', rec),
      /conversationId/,
      '空字符串必须抛出',
    )

    // 安全失败由 assertSafeSegment 抛出，绝不能走 warn 通道
    assert.equal(logger.warnCalls.length, 0, 'assertSafeSegment 抛错不应触发 warn')
  })

  test('多消息按时间序追加，时间戳严格递增', async () => {
    const root = makeTmp()
    const logger = new FakeLogger()
    const appender = ConversationJsonlAppender.getInstance(root, logger)
    const baseTs = Date.now()

    const records: ConversationJsonlRecord[] = []
    for (let i = 0; i < 5; i++) {
      const r = makeRecord({
        id: `m-seq-${i}`,
        conversationId: 'conv-seq',
        ts: baseTs + i, // 显式让 ts 严格递增，避免 Date.now() 同毫秒并列
        content: `msg-${i}`,
      })
      records.push(r)
      await appender.append('conv-seq', r)
    }

    const file = path.join(root, 'conversations', 'conv-seq.jsonl')
    const lines = fs.readFileSync(file, 'utf-8').trimEnd().split('\n')
    assert.equal(lines.length, 5, '应有 5 行')

    const parsedTs = lines.map((line) => (JSON.parse(line) as ConversationJsonlRecord).ts)
    for (let i = 1; i < parsedTs.length; i++) {
      assert.ok(parsedTs[i] > parsedTs[i - 1], `第 ${i} 行 ts 应大于第 ${i - 1} 行`)
    }
    assert.equal(logger.warnCalls.length, 0)
  })

  test('从 JSONL 重建对话历史：split + JSON.parse 与原始数组等价', async () => {
    const root = makeTmp()
    const logger = new FakeLogger()
    const appender = ConversationJsonlAppender.getInstance(root, logger)

    const records: ConversationJsonlRecord[] = [
      makeRecord({
        id: 'r1',
        conversationId: 'conv-rb',
        role: 'user',
        content: '问题 A 包含中文与"引号"',
        ts: 1700000000001,
      }),
      makeRecord({
        id: 'r2',
        conversationId: 'conv-rb',
        role: 'assistant',
        content: '回答 A',
        ts: 1700000000002,
      }),
      makeRecord({
        id: 'r3',
        conversationId: 'conv-rb',
        role: 'tool',
        content: '工具结果 payload',
        toolCallId: 'tc-1',
        imageUrls: ['https://example.com/a.png'],
        ts: 1700000000003,
      }),
    ]

    for (const r of records) {
      await appender.append('conv-rb', r)
    }

    const file = path.join(root, 'conversations', 'conv-rb.jsonl')
    const text = fs.readFileSync(file, 'utf-8')
    const parsed = text
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as ConversationJsonlRecord)

    assert.deepEqual(parsed, records, '从 JSONL 重建的数组应与原始等价')
    assert.equal(logger.warnCalls.length, 0)
  })

  // v17 事件日志（JSONL 升 event 日志方案 B）：memory_update + model_switch

  test('appendMemoryUpdateEvent：写入合法 JSONL 行且能回读', async () => {
    const root = makeTmp()
    const logger = new FakeLogger()
    const appender = ConversationJsonlAppender.getInstance(root, logger)
    const ev: MemoryUpdateJsonlEvent = {
      type: 'memory_update',
      conversationId: 'conv-mem',
      avatarId: 'avatar-x',
      updateCount: 2,
      summaryPreview: '记住 A · 记住 B',
      totalByteSize: 1234,
      consolidated: false,
      ts: 1700000000010,
    }

    await appender.appendMemoryUpdateEvent('conv-mem', ev)

    const file = path.join(root, 'conversations', 'conv-mem.jsonl')
    assert.equal(fs.existsSync(file), true)
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8').trimEnd()) as MemoryUpdateJsonlEvent
    assert.deepEqual(parsed, ev)
    assert.equal(logger.warnCalls.length, 0)
  })

  test('appendModelSwitchEvent：写入合法 JSONL 行且能回读 null 边界', async () => {
    const root = makeTmp()
    const logger = new FakeLogger()
    const appender = ConversationJsonlAppender.getInstance(root, logger)
    const ev: ModelSwitchJsonlEvent = {
      type: 'model_switch',
      conversationId: 'conv-ms',
      fromModel: null,
      toModel: 'claude-opus-4-7',
      ts: 1700000000020,
    }

    await appender.appendModelSwitchEvent('conv-ms', ev)

    const file = path.join(root, 'conversations', 'conv-ms.jsonl')
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8').trimEnd()) as ModelSwitchJsonlEvent
    assert.deepEqual(parsed, ev, 'null fromModel 应原样保留')
    assert.equal(logger.warnCalls.length, 0)
  })

  test('appendModeSwitchEvent：写入合法 JSONL 行且能回读', async () => {
    const root = makeTmp()
    const logger = new FakeLogger()
    const appender = ConversationJsonlAppender.getInstance(root, logger)
    const ev: ModeSwitchJsonlEvent = {
      type: 'mode_switch',
      conversationId: 'conv-mode',
      fromMode: 'agent',
      toMode: 'ask',
      ts: 1700000000030,
    }

    await appender.appendModeSwitchEvent('conv-mode', ev)

    const file = path.join(root, 'conversations', 'conv-mode.jsonl')
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8').trimEnd()) as ModeSwitchJsonlEvent
    assert.deepEqual(parsed, ev)
    assert.equal(logger.warnCalls.length, 0)
  })

  test('appendConversationStartedEvent：写入合法 JSONL 行且能回读', async () => {
    const root = makeTmp()
    const logger = new FakeLogger()
    const appender = ConversationJsonlAppender.getInstance(root, logger)
    const ev: ConversationStartedJsonlEvent = {
      type: 'conversation_started',
      conversationId: 'conv-new',
      avatarId: 'avatar-x',
      projectId: 'default',
      title: '新会话',
      ts: 1700000000040,
    }

    await appender.appendConversationStartedEvent('conv-new', ev)

    const file = path.join(root, 'conversations', 'conv-new.jsonl')
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8').trimEnd()) as ConversationStartedJsonlEvent
    assert.deepEqual(parsed, ev)
    assert.equal(logger.warnCalls.length, 0)
  })

  test('混合事件流：5 类事件写到同一文件，按 type 可分流', async () => {
    const root = makeTmp()
    const logger = new FakeLogger()
    const appender = ConversationJsonlAppender.getInstance(root, logger)

    await appender.appendConversationStartedEvent('conv-mix', {
      type: 'conversation_started', conversationId: 'conv-mix', avatarId: 'a',
      projectId: 'default', title: 't', ts: 0,
    })
    await appender.append('conv-mix', makeRecord({ id: 'm-1', conversationId: 'conv-mix', ts: 1 }))
    await appender.appendMemoryUpdateEvent('conv-mix', {
      type: 'memory_update', conversationId: 'conv-mix', avatarId: 'a',
      updateCount: 1, summaryPreview: 'x', totalByteSize: 10, consolidated: false, ts: 2,
    })
    await appender.appendModelSwitchEvent('conv-mix', {
      type: 'model_switch', conversationId: 'conv-mix', fromModel: 'a', toModel: 'b', ts: 3,
    })
    await appender.appendModeSwitchEvent('conv-mix', {
      type: 'mode_switch', conversationId: 'conv-mix', fromMode: 'agent', toMode: 'plan', ts: 4,
    })

    const text = fs.readFileSync(path.join(root, 'conversations', 'conv-mix.jsonl'), 'utf-8')
    const lines = text.split('\n').filter((l) => l.length > 0).map((l) => JSON.parse(l) as Record<string, unknown>)
    assert.equal(lines.length, 5, '五条事件各占一行')
    assert.equal(lines[0].type, 'conversation_started')
    assert.equal(lines[1].type, undefined, 'message 行无 type（向后兼容）')
    assert.equal(lines[2].type, 'memory_update')
    assert.equal(lines[3].type, 'model_switch')
    assert.equal(lines[4].type, 'mode_switch')
  })
})
